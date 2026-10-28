/**
 * Proactive idle garbage collection scheduler.
 *
 * During long-running uptime (days/weeks), V8 naturally delays full mark-sweep
 * compactions while headroom exists under --max-old-space-size. When traffic goes
 * idle after large agentic sessions, transient arrays and buffers linger in the heap,
 * which the Linux kernel eventually pushes into swap.
 *
 * This scheduler runs periodically (every 10 minutes). When the server is completely
 * IDLE (0 in-flight requests) and heap usage exceeds the elevated floor (2 GB), it
 * triggers global.gc() to compact heap and release anonymous memory pages back to
 * the OS/glibc, preventing progressive swap accumulation.
 */
import { getActiveRequestCount } from "@/lib/gracefulShutdown";
import { periodicServicesAllowed } from "@/lib/periodicServices";

export const IDLE_GC_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
export const IDLE_GC_HEAP_THRESHOLD_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

let _idleGcTimer: NodeJS.Timeout | null = null;

export function runIdleGcIfEligible(): { ran: boolean; reclaimedBytes: number } {
  if (typeof (globalThis as { gc?: () => void }).gc !== "function") {
    return { ran: false, reclaimedBytes: 0 };
  }

  const activeRequests = getActiveRequestCount();
  if (activeRequests > 0) {
    return { ran: false, reclaimedBytes: 0 };
  }

  const memBefore = process.memoryUsage();
  const totalOccupied = memBefore.heapUsed + (memBefore.arrayBuffers ?? 0);

  if (totalOccupied < IDLE_GC_HEAP_THRESHOLD_BYTES) {
    return { ran: false, reclaimedBytes: 0 };
  }

  try {
    const gc = (globalThis as { gc?: () => void }).gc!;
    gc();
    const memAfter = process.memoryUsage();
    const reclaimedBytes = Math.max(0, memBefore.heapUsed - memAfter.heapUsed);
    const reclaimedMb = reclaimedBytes / (1024 * 1024);
    const beforeMb = (memBefore.heapUsed / (1024 * 1024)).toFixed(0);
    const afterMb = (memAfter.heapUsed / (1024 * 1024)).toFixed(0);

    console.log(
      `[Memory] Proactive idle GC reclaimed ${reclaimedMb.toFixed(1)} MB (heap: ${beforeMb} MB -> ${afterMb} MB)`
    );
    return { ran: true, reclaimedBytes };
  } catch (err) {
    console.warn("[Memory] Proactive idle GC encountered an error:", err);
    return { ran: false, reclaimedBytes: 0 };
  }
}

export function startIdleGcScheduler(intervalMs = IDLE_GC_INTERVAL_MS): void {
  if (!periodicServicesAllowed("idle-gc")) return;
  if (_idleGcTimer) return;

  _idleGcTimer = setInterval(() => {
    runIdleGcIfEligible();
  }, intervalMs);

  if (_idleGcTimer && typeof _idleGcTimer.unref === "function") {
    _idleGcTimer.unref();
  }

  console.log("[Memory] Proactive idle GC scheduler started (every 10m).");
}

export function stopIdleGcScheduler(): void {
  if (_idleGcTimer) {
    clearInterval(_idleGcTimer);
    _idleGcTimer = null;
  }
}
