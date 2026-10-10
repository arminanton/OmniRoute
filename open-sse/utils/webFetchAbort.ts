/** Cancellation and deadline helpers shared by the web-fetch provider executors. */

export const WEB_FETCH_CALLER_ABORT_CODE = "WEB_FETCH_CALLER_ABORT";

export interface WebFetchAbortScope {
  /** Signal passed to the upstream request; it includes caller and local timeout. */
  signal: AbortSignal;
  /** True only when this executor's own deadline fired. */
  readonly timedOut: boolean;
  /** Throw a recognizable caller-abort error or this executor's timeout error. */
  throwIfAborted(): void;
  /** Clear the deadline and detach the caller listener. */
  dispose(): void;
}

/**
 * Caller cancellation must survive provider-executor catch blocks as an abort,
 * rather than being normalized into a provider 502/504 that fallback may retry.
 */
export function createWebFetchCallerAbortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  const message =
    reason instanceof Error
      ? reason.message || "Web fetch request was cancelled"
      : typeof reason === "string" && reason.length > 0
        ? reason
        : "Web fetch request was cancelled";
  const error = new Error(message, reason instanceof Error ? { cause: reason } : undefined);
  error.name = "AbortError";
  Object.assign(error, { code: WEB_FETCH_CALLER_ABORT_CODE });
  return error;
}

export function throwIfWebFetchCallerAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createWebFetchCallerAbortError(signal);
}

export function createWebFetchTimeoutError(provider: string, timeoutMs: number): Error {
  const error = new Error(`${provider} web fetch timed out after ${timeoutMs}ms`);
  error.name = "TimeoutError";
  return error;
}

/**
 * Compose a caller-owned AbortSignal with an executor-owned deadline without
 * conflating their causes. The caller signal wins classification even if both
 * happen to fire close together.
 */
export function createWebFetchAbortScope(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
  provider: string
): WebFetchAbortScope {
  throwIfWebFetchCallerAborted(callerSignal);

  const controller = new AbortController();
  const timeoutError = createWebFetchTimeoutError(provider, timeoutMs);
  let didTimeout = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const onCallerAbort = () => {
    if (!controller.signal.aborted && callerSignal) {
      controller.abort(createWebFetchCallerAbortError(callerSignal));
    }
  };

  if (callerSignal) callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  // Close the race between the initial check and listener installation.
  if (callerSignal?.aborted) onCallerAbort();
  if (timeoutMs > 0) {
    timeout = setTimeout(() => {
      didTimeout = true;
      if (!controller.signal.aborted) controller.abort(timeoutError);
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    get timedOut() {
      return didTimeout;
    },
    throwIfAborted() {
      throwIfWebFetchCallerAborted(callerSignal);
      if (didTimeout) throw timeoutError;
    },
    dispose() {
      if (timeout) clearTimeout(timeout);
      if (callerSignal) callerSignal.removeEventListener("abort", onCallerAbort);
    },
  };
}
