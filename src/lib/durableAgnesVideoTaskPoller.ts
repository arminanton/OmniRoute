import { getFencedTaskContext } from "@omniroute/open-sse/services/coordination/fencedTask.ts";
import { combineAbortSignals } from "@omniroute/open-sse/utils/combineAbortSignals.ts";
import { periodicServicesAllowed } from "@/lib/periodicServices";

const POLL_INTERVAL_MS = 10_000;
const MAX_TASKS_PER_TICK = 4;
type PollDueTasks = (limit: number, signal: AbortSignal) => Promise<unknown>;

type PollerState = {
  timer: ReturnType<typeof setInterval> | null;
  controller: AbortController | null;
  removeParentAbortListener: (() => void) | null;
  inFlight: Promise<void> | null;
  stopped: boolean;
};

declare global {
  var __omniDurableAgnesVideoTaskPoller: PollerState | undefined;
}

function getState(): PollerState {
  return (globalThis.__omniDurableAgnesVideoTaskPoller ??= {
    timer: null,
    controller: null,
    removeParentAbortListener: null,
    inFlight: null,
    stopped: true,
  });
}

/** Start only inside the dedicated maintenance runtime, with a delayed first tick. */
export function startDurableAgnesVideoTaskPoller(
  options: {
    intervalMs?: number;
    processDue?: PollDueTasks;
  } = {}
): boolean {
  if (
    process.env.OMNI_COORDINATION_PROCESS_ROLE !== "maintenance" ||
    process.env.OMNI_SHARED_ADMISSION !== "true" ||
    !process.env.OMNI_COORDINATION_DB ||
    process.env.OMNI_COORDINATION_UNHEALTHY === "true"
  ) {
    return false;
  }
  const parentOwner = getFencedTaskContext();
  if (parentOwner?.key !== "maintenance") return false;
  try {
    parentOwner.assertOwner();
  } catch {
    return false;
  }
  const state = getState();
  if (state.timer) return true;
  const intervalMs = Number.isSafeInteger(options.intervalMs)
    ? Math.max(1, Math.min(60_000, options.intervalMs as number))
    : POLL_INTERVAL_MS;
  state.stopped = false;
  state.controller = new AbortController();
  const abortFromParent = () => state.controller?.abort(parentOwner.signal.reason);
  parentOwner.signal.addEventListener("abort", abortFromParent, { once: true });
  state.removeParentAbortListener = () =>
    parentOwner.signal.removeEventListener("abort", abortFromParent);
  state.timer = setInterval(() => {
    if (state.stopped || state.inFlight) return;
    const controller = state.controller;
    if (!controller || controller.signal.aborted) return;
    const operation = Promise.resolve()
      .then(async () => {
        if (!periodicServicesAllowed("durable-agnes-video-tasks")) return;
        parentOwner.assertOwner();
        const signal = combineAbortSignals([parentOwner.signal, controller.signal]);
        if (options.processDue) {
          await options.processDue(MAX_TASKS_PER_TICK, signal);
        } else {
          const { pollDueDurableAgnesVideoTasks } =
            await import("@/app/api/v1/_shared/durableAgnesVideoTasks");
          await pollDueDurableAgnesVideoTasks(MAX_TASKS_PER_TICK, signal);
        }
        if (controller.signal.aborted) return;
        parentOwner.assertOwner();
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : "unknown error";
        console.warn(`[VIDEO_TASK_WORKER] Fenced maintenance poll skipped: ${message}`);
      })
      .finally(() => {
        state.inFlight = null;
      });
    state.inFlight = operation;
  }, intervalMs);
  state.timer.unref?.();
  return true;
}

/** Stop the timer, abort current I/O, wait for the fenced owner to release, then close its store. */
export async function stopDurableAgnesVideoTaskPoller(): Promise<void> {
  const state = getState();
  state.stopped = true;
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.controller?.abort(new Error("Durable video task poller shutting down"));
  state.removeParentAbortListener?.();
  state.removeParentAbortListener = null;
  const inFlight = state.inFlight;
  if (inFlight) await inFlight.catch(() => {});
  state.inFlight = null;
  state.controller = null;
  const ownerIsOpen = Boolean(
    (globalThis as typeof globalThis & { __omniDurableAgnesTaskOwner?: unknown })
      .__omniDurableAgnesTaskOwner
  );
  if (!ownerIsOpen) return;
  try {
    const { closeDurableAgnesTaskOwner } =
      await import("@/app/api/v1/_shared/durableAgnesVideoTasks");
    closeDurableAgnesTaskOwner();
  } catch {
    // The service may not have initialized in this process.
  }
}
