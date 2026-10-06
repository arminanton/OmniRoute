import {
  RequestTransportTelemetry,
  getRequestTransportTelemetry,
  runWithRequestTransportTelemetry,
  runWithTransportAttempt,
  tapTelemetryBody,
} from "../utils/transportTelemetry.ts";
import {
  beginGenerationLifetime,
  bindGenerationResponse,
  isGenerationFetchResponse,
} from "./generationLifetime.ts";
declare global {
  var __omniLogicalBudgetFailures: WeakSet<object> | undefined;
}
const budgetFailures = (globalThis.__omniLogicalBudgetFailures ??= new WeakSet<object>());
export class LogicalRetryBudgetError extends Error {
  constructor(message: string) {
    super(message);
    budgetFailures.add(this);
  }
  readonly code = "RETRY_BUDGET_EXHAUSTED";
  readonly status = 503;
}
export const isLogicalRetryBudgetError = (error: unknown): error is LogicalRetryBudgetError =>
  !!error && typeof error === "object" && budgetFailures.has(error);

/** Request-owned object: share this instance across host/model/account/transport retries. */
export class LogicalRetryBudget {
  private attempts = 0;
  private replayForbidden = false;
  private terminalDecision: Error | null = null;
  constructor(
    readonly maxAttempts: number,
    readonly deadline: number,
    private now = Date.now
  ) {
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || !Number.isFinite(deadline))
      throw new Error("Invalid logical retry budget");
  }
  markOutputOrToolDelivered(): void {
    this.forbidReplay();
  }
  /** Sending a non-idempotent request may make replay unsafe before any output arrives. */
  forbidReplay(): void {
    this.replayForbidden = true;
  }
  denyFurtherAttempts(error: Error): void {
    this.terminalDecision ??= error;
  }
  consumeAttempt(): void {
    if (this.terminalDecision) throw this.terminalDecision;
    if (this.replayForbidden || this.attempts >= this.maxAttempts || this.now() >= this.deadline)
      throw new LogicalRetryBudgetError("Logical retry budget exhausted");
    this.attempts++;
  }
  remainingTimeMs(): number {
    return Math.max(0, this.deadline - this.now());
  }
  snapshot() {
    return {
      attempts: this.attempts,
      remaining: Math.max(0, this.maxAttempts - this.attempts),
      replayForbidden: this.replayForbidden,
      deadline: this.deadline,
    };
  }
  async backoff(
    minimumMs: number,
    signal?: AbortSignal | null,
    random = Math.random
  ): Promise<void> {
    if (this.terminalDecision) throw this.terminalDecision;
    if (signal?.aborted) throw signal.reason ?? new Error("Request aborted");
    const draw = random();
    const jitter = Number.isFinite(draw) ? Math.min(1, Math.max(0, draw)) : 0;
    const delay = Math.max(0, minimumMs) + Math.floor(250 * jitter);
    if (
      this.replayForbidden ||
      this.now() + delay >= this.deadline ||
      this.attempts >= this.maxAttempts
    )
      throw new LogicalRetryBudgetError("Retry cannot fit request deadline");
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(signal?.reason ?? new Error("Request aborted"));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, delay);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }
}

import { AsyncLocalStorage } from "node:async_hooks";
declare global {
  var __omniLogicalRetryContext: AsyncLocalStorage<LogicalRetryBudget> | undefined;
  var __omniGenerationDispatchContext:
    | AsyncLocalStorage<
        boolean | { withPermitReleased: (wait: () => Promise<void>) => Promise<void> }
      >
    | undefined;
}
const retryContext = (globalThis.__omniLogicalRetryContext ??=
  new AsyncLocalStorage<LogicalRetryBudget>());
const generationContext = (globalThis.__omniGenerationDispatchContext ??= new AsyncLocalStorage<
  boolean | { withPermitReleased: (wait: () => Promise<void>) => Promise<void> }
>());
export const getLogicalRetryBudget = () => retryContext.getStore();
/** Pre-output only: the timer is detached when headers/acceptance resolve, never during body streaming. */
export async function withLogicalPreOutputDeadline<T>(
  signal: AbortSignal | null | undefined,
  invoke: (signal: AbortSignal | null | undefined) => Promise<T>
): Promise<T> {
  signal?.throwIfAborted();
  const budget = getLogicalRetryBudget();
  if (!budget) return invoke(signal);
  const remaining = budget.remainingTimeMs();
  if (remaining <= 0) throw new LogicalRetryBudgetError("Logical pre-output deadline exhausted");
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const timer = setTimeout(
    () => controller.abort(new LogicalRetryBudgetError("Logical pre-output deadline exhausted")),
    remaining
  );
  let abort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal?.aborted ? signal.reason : combined.reason);
    combined.addEventListener("abort", abort, { once: true });
  });
  try {
    const pending = invoke(combined).then((result) => {
      if (combined.aborted) {
        if (isGenerationFetchResponse(result) && result.ok)
          void result.body?.cancel(combined.reason).catch(() => {});
        throw combined.reason;
      }
      return result;
    });
    return await Promise.race([pending, aborted]);
  } finally {
    clearTimeout(timer);
    combined.removeEventListener("abort", abort);
  }
}
export function runWithLogicalRetryBudget<T>(budget: LogicalRetryBudget, fn: () => T): T {
  return retryContext.run(budget, fn);
}
export function runGenerationDispatch<T>(
  fn: () => T,
  hooks?: { withPermitReleased: (wait: () => Promise<void>) => Promise<void> }
): T {
  return generationContext.run(hooks ?? true, fn);
}
export function isGenerationHttpDispatch(input?: unknown, options?: { method?: string }): boolean {
  if (!generationContext.getStore()) return false;
  const target =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input instanceof Request
          ? input.url
          : "";
  const method = options?.method ?? (input instanceof Request ? input.method : "GET");
  // Control-plane calls can inherit executor context: count only known generation RPCs.
  if (
    method.toUpperCase() !== "POST" ||
    !/(?:\/responses(?:\?|$)|\/chat\/completions(?:\?|$)|\/messages(?:\?|$)|\/(?:streamGenerateContent|generateContent)(?:\?|$)|:(?:streamGenerateContent|generateContent)(?:\?|$))/.test(
      target
    )
  )
    return false;
  return true;
}
export function consumeGenerationAttempt(input?: unknown, options?: { method?: string }): void {
  if (isGenerationHttpDispatch(input, options)) retryContext.getStore()?.consumeAttempt();
}

export function withLogicalRetryBudget<Args extends unknown[], Result>(
  fn: (...args: Args) => Promise<Result>
): (...args: Args) => Promise<Result> {
  return (...args: Args) => {
    if (retryContext.getStore()) return fn(...args);
    const max = Number(process.env.OMNI_LOGICAL_RETRY_MAX_ATTEMPTS ?? 12);
    const duration = Number(process.env.OMNI_LOGICAL_RETRY_DEADLINE_MS ?? 900000);
    if (!Number.isSafeInteger(max) || max < 1 || !Number.isSafeInteger(duration) || duration < 1)
      throw new Error("Invalid logical retry policy");
    const budget = new LogicalRetryBudget(max, Date.now() + duration);
    const telemetry = new RequestTransportTelemetry();
    return runWithRequestTransportTelemetry(telemetry, () =>
      runWithLogicalRetryBudget(budget, async () => {
        try {
          const response = await fn(...args);
          if (
            !isGenerationFetchResponse(response) ||
            (!response.ok && !(response instanceof Response)) ||
            !response.body
          ) {
            telemetry.finish("no_body");
            return response;
          }
          // Capture the request budget: downstream pulls run outside ingress ALS.
          const body = tapTelemetryBody(
            response.body,
            (chunk) => {
              budget.markOutputOrToolDelivered();
              telemetry.forward(chunk.byteLength);
            },
            (reason) => telemetry.finish(reason)
          );
          const wrapped = new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
          for (const property of ["url", "redirected", "type"] as const)
            Object.defineProperty(wrapped, property, { value: response[property] });
          return wrapped as Result;
        } catch (error) {
          telemetry.finish("error");
          throw error;
        }
      })
    );
  };
}
export function budgetedGenerationFetch<Args extends unknown[], Result>(
  fn: (...args: Args) => Promise<Result>
): (...args: Args) => Promise<Result> {
  return async (...args: Args) => {
    const options = args[1] as { method?: string; signal?: AbortSignal | null } | undefined;
    const generation = isGenerationHttpDispatch(args[0], options);
    consumeGenerationAttempt(args[0], options);
    const attempt = generation ? getRequestTransportTelemetry()?.attempt("http") : undefined;
    const finish = generation ? beginGenerationLifetime("http") : () => {};
    return runWithTransportAttempt(attempt, async () => {
      let pending: Promise<Result> | undefined;
      let settled = false;
      try {
        const response = generation
          ? await withLogicalPreOutputDeadline(
              options?.signal ?? (args[0] instanceof Request ? args[0].signal : undefined),
              (signal) => {
                const dispatchArgs = [...args] as Args;
                dispatchArgs[1] = { ...options, signal } as Args[number];
                pending = fn(...dispatchArgs).then(
                  (value) => {
                    settled = true;
                    return value;
                  },
                  (error) => {
                    settled = true;
                    throw error;
                  }
                );
                return pending;
              }
            )
          : await fn(...args);
        if (!generation || !isGenerationFetchResponse(response)) {
          finish();
          return response;
        }
        attempt?.headers(response.status);
        if (!response.ok) {
          attempt?.close("no_body");
          finish();
          return response;
        }
        const sse = response.headers.get("content-type")?.includes("text/event-stream") === true;
        return bindGenerationResponse(response, finish, {
          chunk: (bytes) => attempt?.chunk(bytes, sse),
          close: (reason) => attempt?.close(reason),
        }) as Result;
      } catch (error) {
        attempt?.close("error");
        // An uncooperative transport may settle after cancellation. Do not report it drained early.
        if (pending && !settled) void pending.then(finish, finish);
        else finish();
        throw error;
      }
    });
  };
}

/** Transport retries release admission during sleep, then reserve before dispatch. */
export async function backoffGenerationRetry(
  minimumMs: number,
  signal?: AbortSignal | null
): Promise<void> {
  const budget = getLogicalRetryBudget();
  const sleep = async () => {
    const endWait = getRequestTransportTelemetry()?.wait("backoff");
    try {
      if (budget) return await budget.backoff(minimumMs, signal);
      if (signal?.aborted) throw signal.reason ?? new Error("Request aborted");
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          reject(signal?.reason ?? new Error("Request aborted"));
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", abort);
          resolve();
        }, minimumMs);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
    } finally {
      endWait?.();
    }
  };
  const hooks = generationContext.getStore();
  if (hooks && typeof hooks === "object" && hooks.withPermitReleased)
    return hooks.withPermitReleased(sleep);
  return sleep();
}

/** Explicit non-HTTP generation send (for response.create on native WebSocket lanes). */
export function consumeCurrentGenerationAttempt(): void {
  getLogicalRetryBudget()?.consumeAttempt();
}
