import { backoffGenerationRetry } from "../../services/logicalRetryBudget.ts";
/** Ownership and cancellation helpers shared by all Antigravity attempts. */
const errorBodies = new WeakMap<Response, Promise<string>>();
const MAX_ERROR_BODY_BYTES = 256 * 1024;

export async function readWithCancellation<T>(
  reader: ReadableStreamDefaultReader<T>,
  signal?: AbortSignal | null
): Promise<ReadableStreamReadResult<T>> {
  signal?.throwIfAborted();
  if (!signal) return reader.read();
  let abort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    const result = await Promise.race([reader.read(), aborted]);
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export async function disposeAntigravityResponse(response: Response): Promise<void> {
  if (response.body && !response.bodyUsed) await response.body.cancel().catch(() => {});
}

async function consumeErrorBody(response: Response, signal?: AbortSignal | null): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const bounded = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
  const decoder = new TextDecoder();
  let text = "",
    bytes = 0;
  try {
    while (true) {
      const { done, value } = await readWithCancellation(reader, bounded);
      if (done) return text + decoder.decode();
      const remaining = MAX_ERROR_BODY_BYTES - bytes;
      text += decoder.decode(value.subarray(0, remaining), { stream: true });
      bytes += value.byteLength;
      if (bytes >= MAX_ERROR_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        return text + decoder.decode();
      }
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** Read once, without teeing an unconsumed branch that retains the socket. */
export function readAntigravityErrorBody(
  response: Response,
  signal?: AbortSignal | null
): Promise<string> {
  let pending = errorBodies.get(response);
  if (!pending) {
    pending = consumeErrorBody(response, signal);
    errorBodies.set(response, pending);
  }
  return pending;
}

/** Server delay is a minimum; jitter only adds time, never retries early. */
export function waitForAntigravityRetry(
  delayMs: number,
  signal?: AbortSignal | null
): Promise<void> {
  signal?.throwIfAborted();
  const jitter = Math.floor(Math.random() * Math.min(1000, Math.max(0, delayMs) * 0.2));
  return backoffGenerationRetry(Math.max(0, delayMs) + jitter, signal);
}

export function combineAbortSignals(signals: AbortSignal[]): AbortSignal {
  return AbortSignal.any(signals);
}
