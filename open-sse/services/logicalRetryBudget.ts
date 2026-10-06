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
  constructor(
    readonly maxAttempts: number,
    readonly deadline: number,
    private now = Date.now
  ) {
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || !Number.isFinite(deadline))
      throw new Error("Invalid logical retry budget");
  }
  markOutputOrToolDelivered(): void {
    this.replayForbidden = true;
  }
  consumeAttempt(): void {
    if (this.replayForbidden || this.attempts >= this.maxAttempts || this.now() >= this.deadline)
      throw new LogicalRetryBudgetError("Logical retry budget exhausted");
    this.attempts++;
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
    return runWithLogicalRetryBudget(budget, async () => {
      const response = await fn(...args);
      if (!(response instanceof Response) || !response.body) return response;
      // Capture the request budget: downstream pulls run outside ingress ALS.
      const body = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>(
          {
            transform(chunk, controller) {
              budget.markOutputOrToolDelivered();
              controller.enqueue(chunk);
            },
          },
          new ByteLengthQueuingStrategy({ highWaterMark: 16384 }),
          new ByteLengthQueuingStrategy({ highWaterMark: 16384 })
        )
      );
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }) as Result;
    });
  };
}
export function budgetedGenerationFetch<Args extends unknown[], Result>(
  fn: (...args: Args) => Promise<Result>
): (...args: Args) => Promise<Result> {
  return async (...args: Args) => {
    const options = args[1] as { method?: string } | undefined;
    const generation = isGenerationHttpDispatch(args[0], options);
    consumeGenerationAttempt(args[0], options);
    const finish = generation ? beginGenerationLifetime("http") : () => {};
    try {
      const response = await fn(...args);
      return generation && isGenerationFetchResponse(response)
        ? (bindGenerationResponse(response, finish) as Result)
        : (finish(), response);
    } catch (error) {
      finish();
      throw error;
    }
  };
}

/** Transport retries release admission during sleep, then reserve before dispatch. */
export async function backoffGenerationRetry(
  minimumMs: number,
  signal?: AbortSignal | null
): Promise<void> {
  const budget = getLogicalRetryBudget();
  const sleep = async () => {
    if (budget) return budget.backoff(minimumMs, signal);
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
