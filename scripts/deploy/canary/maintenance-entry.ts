import { runFencedTask } from "../../../open-sse/services/coordination/fencedTask.ts";

/** Start the real application inside the durable maintenance owner context. */
export async function runMaintenanceRuntime(
  startRuntime: () => Promise<unknown>,
  stopSignal: AbortSignal
): Promise<void> {
  if (
    process.env.OMNI_SHARED_ADMISSION !== "true" ||
    process.env.OMNI_COORDINATION_PROCESS_ROLE !== "maintenance"
  ) {
    throw new Error("Maintenance requires the fixed shared coordination role");
  }
  if (stopSignal.aborted) throw stopSignal.reason;
  await runFencedTask(
    "maintenance",
    async (owner) => {
      owner.assertOwner();
      let end: (() => void) | undefined;
      const stopped = new Promise<void>((resolve) => {
        end = resolve;
      });
      const stop = () => end?.();
      owner.signal.addEventListener("abort", stop, { once: true });
      try {
        await startRuntime();
        owner.assertOwner();
        if (!owner.signal.aborted) await stopped;
      } finally {
        owner.signal.removeEventListener("abort", stop);
      }
    },
    { signal: stopSignal, timeoutMs: 30_000 }
  );
}

async function main(): Promise<void> {
  if (process.env.OMNI_COORDINATION_DB !== "/app/data/coordination.sqlite")
    throw new Error("Unexpected maintenance coordination path");
  const stop = new AbortController();
  const onStop = () => stop.abort(new Error("Maintenance stopping"));
  process.once("SIGINT", onStop);
  process.once("SIGTERM", onStop);
  try {
    await runMaintenanceRuntime(() => import("/app/server-ws.mjs"), stop.signal);
  } catch (error) {
    if (!stop.signal.aborted) {
      console.error("Maintenance owner or runtime failed");
      process.exitCode = 1;
      // Fail closed on owner loss; never keep periodic work alive without its lease.
      process.kill(process.pid, "SIGTERM");
      throw error;
    }
  }
}

if (process.argv[1]?.endsWith("/maintenance-entry.cjs")) {
  void main().catch(() => {
    process.exitCode = 1;
  });
}
