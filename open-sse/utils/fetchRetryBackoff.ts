import {
  backoffGenerationRetry,
  isGenerationHttpDispatch,
} from "../services/logicalRetryBudget.ts";

/** Control-plane transport retries must never borrow the caller's generation reservation or budget. */
export async function waitForFetchRetry(
  input: unknown,
  options: { method?: string } | undefined,
  minimumMs: number,
  signal?: AbortSignal | null
): Promise<void> {
  if (isGenerationHttpDispatch(input, options)) return backoffGenerationRetry(minimumMs, signal);
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason);
    };
    const timer = setTimeout(
      () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      },
      Math.max(0, minimumMs)
    );
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
