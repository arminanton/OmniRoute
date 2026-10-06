import { getObservedResponseStartTimeoutMs } from "./fetchDispatchObserver.ts";
import { getLogicalRetryBudget, LogicalRetryBudgetError } from "../services/logicalRetryBudget.ts";
import { noteGenerationDispatchPhase } from "../services/generationReplay.ts";
import type { Dispatcher } from "undici";

type DirectFetchOptions = RequestInit & { dispatcher?: unknown };
type DirectFetch = (input: RequestInfo | URL, options: DirectFetchOptions) => Promise<Response>;

const DEFAULT_DIRECT_HEADERS_TIMEOUT_MS = 30_000;
const DIRECT_RESPONSE_START_TIMEOUT_CODE = "DIRECT_RESPONSE_START_TIMEOUT";

export function resolveDirectHeadersTimeoutMs(
  env: Record<string, string | undefined> = process.env
): number {
  const raw = env.OMNIROUTE_DIRECT_HEADERS_TIMEOUT_MS;
  if (raw == null || raw.trim() === "")
    return getObservedResponseStartTimeoutMs() ?? DEFAULT_DIRECT_HEADERS_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function createDirectResponseStartTimeout(timeoutMs: number): Error & { code: string } {
  const err = new Error(
    `Direct response did not start within ${timeoutMs}ms while awaiting provider headers`
  ) as Error & { code: string };
  err.name = "TimeoutError";
  err.code = DIRECT_RESPONSE_START_TIMEOUT_CODE;
  return err;
}

export function isDirectResponseStartTimeout(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    "code" in err &&
    err.code === DIRECT_RESPONSE_START_TIMEOUT_CODE
  );
}

function mergeAbortSignals(
  primary: AbortSignal | null | undefined,
  secondary: AbortSignal
): AbortSignal {
  if (!primary) return secondary;
  if (primary.aborted) return primary;
  const controller = new AbortController();
  const onPrimaryAbort = () => controller.abort(primary.reason);
  const onSecondaryAbort = () => controller.abort(secondary.reason);
  const cleanup = () => {
    primary.removeEventListener("abort", onPrimaryAbort);
    secondary.removeEventListener("abort", onSecondaryAbort);
  };
  primary.addEventListener("abort", onPrimaryAbort, { once: true });
  secondary.addEventListener("abort", onSecondaryAbort, { once: true });
  controller.signal.addEventListener("abort", cleanup, { once: true });
  return controller.signal;
}

export async function directFetchWithBoundedResponseStart(
  input: RequestInfo | URL,
  options: DirectFetchOptions,
  fetchImpl: DirectFetch,
  timeoutMs: number,
  trackDispatchStart = false,
  queueTimeoutMs = 90_000
): Promise<Response> {
  const budget = getLogicalRetryBudget();
  const remaining = budget ? Math.max(0, budget.snapshot().deadline - Date.now()) : Infinity;
  if (remaining <= 0)
    throw new LogicalRetryBudgetError("Logical request deadline expired before dispatch");
  const effectiveHeadersMs = Math.min(timeoutMs > 0 ? timeoutMs : Infinity, remaining);
  const effectiveQueueMs = Math.min(queueTimeoutMs, remaining);
  if (!Number.isFinite(effectiveHeadersMs)) return fetchImpl(input, options);
  let phase = "unknown",
    requestStarted: boolean | null = null;
  const attemptController = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const startHeadersTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () => attemptController.abort(createDirectResponseStartTimeout(effectiveHeadersMs)),
      effectiveHeadersMs
    );
    timer.unref?.();
  };
  startHeadersTimer();
  let dispatcher = options.dispatcher;
  if (
    trackDispatchStart &&
    dispatcher &&
    typeof dispatcher === "object" &&
    "dispatch" in dispatcher
  ) {
    const original = dispatcher as Dispatcher;
    dispatcher = new Proxy(original, {
      get(target, property) {
        if (property === "dispatch") {
          return (
            dispatchOptions: Dispatcher.DispatchOptions,
            handler: Dispatcher.DispatchHandler
          ) => {
            clearTimeout(timer);
            phase = "transport_queue";
            requestStarted = false;
            // Bound local queue/connect wait independently. The caller's signal
            // remains authoritative when its remaining deadline is shorter.
            timer = setTimeout(() => {
              const error = new Error(
                "Direct request waited too long for a transport slot"
              ) as Error & { code: string };
              // Reuse local admission classification: queue exhaustion must not
              // penalize an upstream account as an upstream 504 outage.
              error.code = "SEMAPHORE_TIMEOUT";
              attemptController.abort(error);
            }, effectiveQueueMs);
            timer.unref?.();
            const tracked = new Proxy(handler, {
              get(receiver, name) {
                const value = Reflect.get(receiver, name, receiver);
                if (name === "onRequestStart") {
                  return (...args: unknown[]) => {
                    phase = "headers";
                    requestStarted = true;
                    startHeadersTimer();
                    if (typeof value === "function") return Reflect.apply(value, receiver, args);
                  };
                }
                return typeof value === "function" ? value.bind(receiver) : value;
              },
            });
            return target.dispatch(dispatchOptions, tracked);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  try {
    return await fetchImpl(input, {
      ...options,
      dispatcher,
      signal: mergeAbortSignals(options.signal, attemptController.signal),
    });
  } catch (error) {
    noteGenerationDispatchPhase(error, phase, requestStarted);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
