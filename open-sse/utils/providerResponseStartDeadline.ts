import { getLogicalRetryBudget, LogicalRetryBudgetError } from "../services/logicalRetryBudget.ts";
import { withFetchDispatchObserver } from "./fetchDispatchObserver.ts";

/** Preserve an executor's headers budget through inner dispatchers; queue time is a separate phase. */
export async function withProviderResponseStartDeadline<T>(
  timeoutMs: number,
  signal: AbortSignal | null | undefined,
  invoke: (signal: AbortSignal | null | undefined) => Promise<T>,
  timeoutError: () => Error,
  queueTimeoutMs = 90_000
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return invoke(signal);
  const controller = new AbortController();
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const setTimer = (duration: number, makeError: () => Error) => {
    if (!active) return;
    clearTimeout(timer);
    const remaining = getLogicalRetryBudget()?.remainingTimeMs();
    const logicalWins = remaining !== undefined && remaining <= duration;
    timer = setTimeout(
      () =>
        controller.abort(
          logicalWins
            ? new LogicalRetryBudgetError("Logical pre-output deadline exhausted", true)
            : makeError()
        ),
      Math.max(1, Math.min(duration, remaining ?? duration))
    );
  };
  const started = () => setTimer(timeoutMs, timeoutError);
  const queued = () =>
    setTimer(queueTimeoutMs, () => {
      const error = new Error("Request waited too long for a transport slot") as Error & {
        code: string;
      };
      error.code = "SEMAPHORE_TIMEOUT";
      return error;
    });
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  started();
  try {
    return await withFetchDispatchObserver(
      { queued, started, responseStartTimeoutMs: timeoutMs },
      () => invoke(combined)
    );
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    active = false;
    clearTimeout(timer);
  }
}
