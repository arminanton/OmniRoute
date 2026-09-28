/** UC polling limits apply even when a client supplies a larger timeout. */
export const UC_MAX_POLL_ATTEMPTS = 128;

export function boundedUcPollMs(value: unknown, fallback: number, max: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : fallback;
}

/** Wait for an injected sleep or caller abort, whichever happens first. */
export async function waitForUcPoll(
  ms: number,
  sleep: (ms: number) => Promise<void>,
  signal?: AbortSignal | null
): Promise<boolean> {
  if (signal?.aborted) return false;
  if (!signal) {
    await sleep(ms);
    return true;
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<false>((resolve) => {
    onAbort = () => resolve(false);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([sleep(ms).then(() => true as const), aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** Bound each polling request, including transports that ignore AbortSignal. */
export class UcPollTimeoutError extends Error {
  constructor() {
    super("UC polling request timed out");
  }
}

export async function withUcPollTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal | null
): Promise<T> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  let rejectStopped: (error: Error) => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => {
    rejectStopped = reject;
  });
  const onAbort = () => {
    controller.abort(signal?.reason);
    rejectStopped(new Error("UC polling request aborted"));
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(
    () => {
      rejectStopped(new UcPollTimeoutError());
      controller.abort();
    },
    Math.max(1, timeoutMs)
  );
  try {
    if (signal?.aborted) onAbort();
    const work = controller.signal.aborted ? stopped : operation(controller.signal);
    return await Promise.race([work, stopped]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
