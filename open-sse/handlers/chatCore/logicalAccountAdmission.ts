import {
  acquireMany,
  type AcquireManyOptions,
  type SemaphoreRequirement,
} from "../../services/accountSemaphore.ts";
import {
  withLogicalPreOutputDeadline,
  getLogicalRetryBudget,
  LogicalRetryBudgetError,
} from "../../services/logicalRetryBudget.ts";

/** A queued permit is pre-output work; late acquisition must never leak a durable reservation. */
export async function acquireLogicalConcurrencyGates(
  requirements: SemaphoreRequirement[],
  options: AcquireManyOptions,
  acquire: typeof acquireMany = acquireMany
): Promise<() => void> {
  const unowned: { release: (() => void) | null } = { release: null };
  let settled = false;
  try {
    const release = await withLogicalPreOutputDeadline(options.signal, async (signal) => {
      const acquired = await acquire(requirements, { ...options, signal });
      if (settled || signal?.aborted) {
        acquired();
        throw signal?.reason ?? new Error("Admission ownership ended");
      }
      unowned.release = acquired;
      return acquired;
    });
    options.signal?.throwIfAborted();
    const budget = getLogicalRetryBudget();
    if (budget && budget.remainingTimeMs() <= 0)
      throw new LogicalRetryBudgetError("Logical account admission deadline exhausted");
    settled = true;
    unowned.release = null;
    return release;
  } catch (error) {
    settled = true;
    unowned.release?.();
    unowned.release = null;
    throw error;
  }
}
