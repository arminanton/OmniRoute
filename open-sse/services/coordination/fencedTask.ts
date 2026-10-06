import { AsyncLocalStorage } from "node:async_hooks";
import { acquireSharedSemaphore } from "./sharedSemaphore.ts";

const taskContext = new AsyncLocalStorage<FencedTaskContext>();
export const getFencedTaskContext = () => taskContext.getStore();

export interface FencedTaskContext {
  key: string;
  signal: AbortSignal;
  assertOwner(): void;
}
/** For refresh/jobs: perform CAS persistence inside operation, before ownership releases. */
export async function runFencedTask<T>(
  key: string,
  operation: (context: FencedTaskContext) => Promise<T>,
  options: { signal?: AbortSignal | null; timeoutMs?: number } = {}
): Promise<T> {
  const lost = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, lost.signal]) : lost.signal;
  const release = await acquireSharedSemaphore([{ key: `task:${key}`, maxConcurrency: 1 }], {
    timeoutMs: options.timeoutMs ?? 30000,
    signal,
    onLeaseLost: (error) => lost.abort(error),
  });
  const assertOwner = () => {
    if (signal.aborted) throw signal.reason ?? new Error("Task owner lost");
  };
  try {
    assertOwner();
    const result = await taskContext.run({ key, signal, assertOwner }, () =>
      operation({ key, signal, assertOwner })
    );
    assertOwner();
    return result;
  } finally {
    release();
  }
}

/** Rotating refresh and persistence must occur under the same shared ownership interval. */
export async function runSharedRefresh<T>(
  provider: string,
  connectionId: string,
  operation: () => Promise<T>
): Promise<T> {
  if (process.env.OMNI_SHARED_ADMISSION !== "true") return operation();
  if (!connectionId) throw new Error("Shared refresh requires a persisted connection identity");
  const key = `refresh:${provider}:${connectionId}`;
  if (getFencedTaskContext()?.key === key) return operation();
  return runFencedTask(key, () => operation());
}
