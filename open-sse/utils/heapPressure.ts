import os from "node:os";
import v8 from "node:v8";

/**
 * Compute the runtime memory-pressure shed threshold (MB).
 *
 * The chat pipeline rejects new requests with a 503 once `heapUsed` exceeds this
 * value, to avoid hard "JavaScript heap out of memory" crashes under concurrent
 * large-context load. The threshold is derived from the process's *actual* V8
 * heap ceiling (`heap_size_limit`, which reflects `--max-old-space-size` when set,
 * otherwise Node's RAM-derived default) so it auto-adapts across 1 GB / 2 GB /
 * large VPS instead of using a fixed number. Under Bun, JavaScriptCore's Node
 * compatibility heap limit can change after module load, so the resolved value
 * is bounded by Bun's constrained-memory ceiling instead.
 *
 * A fixed default was the bug: 200 MB sat *below* the app's ~260 MB working set,
 * so the guard rejected every request once the heap warmed up (the v3.8.8
 * "resource pressure" outage). We shed at 85% of the ceiling — leaving headroom
 * for in-flight requests + GC — with a floor that always clears the runtime
 * baseline so a small/undersized heap never rejects all traffic.
 *
 * @param heapSizeLimitMb          `v8.getHeapStatistics().heap_size_limit` in MB
 * @param override                 `HEAP_PRESSURE_THRESHOLD_MB` env value; positive values win
 * @param constrainedMemoryLimitMb Optional process/cgroup memory ceiling in MB. Bun supplies
 *                                 this because its JavaScriptCore heap ceiling changes at runtime.
 */
export function computeHeapPressureThresholdMb(
  heapSizeLimitMb: number,
  override?: string | number | null,
  constrainedMemoryLimitMb?: number | null
): number {
  const explicit = Number(override);
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
  // Shed at 85% of the heap ceiling, but never below a floor that clears the
  // runtime's own ~260 MB baseline (+ margin) so an undersized heap degrades to
  // "guard never fires" rather than "guard rejects everything".
  const SHED_RATIO = 0.85;
  const FLOOR_MB = 400;
  const constrainedLimit = Number(constrainedMemoryLimitMb);
  const ceilingMb =
    Number.isFinite(constrainedLimit) && constrainedLimit > 0 ? constrainedLimit : heapSizeLimitMb;
  return Math.max(Math.round(ceilingMb * SHED_RATIO), FLOOR_MB);
}

/**
 * Bun's `node:v8` compatibility layer reports JavaScriptCore statistics. Its
 * `heap_size_limit` can start near 1 GiB and later expand, leaving a cached
 * threshold below a healthy process's live heap. Use Bun's constrained-memory
 * ceiling (a cgroup limit when available), then host RAM as the no-cgroup fallback.
 */
function bunMemoryCeilingMb(): number | null {
  try {
    const proc = process as NodeJS.Process & { constrainedMemory?: () => number };
    if (typeof proc.constrainedMemory === "function") {
      const constrained = proc.constrainedMemory();
      if (Number.isFinite(constrained) && constrained > 0) return constrained / (1024 * 1024);
    }
  } catch {
    // Fall through to host memory when Bun does not expose a usable constraint.
  }
  try {
    const total = os.totalmem();
    return Number.isFinite(total) && total > 0 ? total / (1024 * 1024) : null;
  } catch {
    return null;
  }
}

const BUN_MEMORY_CEILING_MB =
  typeof process.versions.bun === "string" ? bunMemoryCeilingMb() : null;

/**
 * Pressure threshold (MB) resolved once at module load from the Node V8 heap
 * ceiling, or from Bun's constrained-memory ceiling. Read by the chat-core guard.
 */
export const HEAP_PRESSURE_THRESHOLD_MB = computeHeapPressureThresholdMb(
  v8.getHeapStatistics().heap_size_limit / (1024 * 1024),
  process.env.HEAP_PRESSURE_THRESHOLD_MB,
  BUN_MEMORY_CEILING_MB
);

const HEAP_PRESSURE_MESSAGE =
  "Service temporarily unavailable due to resource pressure. Retry shortly.";

export type HeapPressureGuardResult = {
  success: false;
  status: 503;
  error: string;
  response: Response;
};

/**
 * Memory-pressure shed guard for the chat pipeline (extracted from chatCore's handleChatCore).
 * Returns a ready-to-return 503 result when live heap usage exceeds the shed threshold, else null
 * to proceed. The heap figure is logged for INTERNAL telemetry only and is NEVER placed in the
 * client-facing response (Hard Rule #12). Behaviour is byte-identical to the previous inline guard.
 */
export function checkHeapPressureGuard(
  heapUsedMb: number,
  thresholdMb: number = HEAP_PRESSURE_THRESHOLD_MB,
  emitWarning = true
): HeapPressureGuardResult | null {
  if (heapUsedMb <= thresholdMb) return null;
  if (emitWarning) {
    console.warn(
      `[chatCore] heap pressure guard tripped: ${Math.round(heapUsedMb)}MB > ${thresholdMb}MB; returning 503`
    );
  }
  return {
    success: false,
    status: 503,
    error: HEAP_PRESSURE_MESSAGE,
    response: new Response(
      JSON.stringify({
        error: { message: HEAP_PRESSURE_MESSAGE, type: "server_error", code: "heap_pressure" },
      }),
      { status: 503, headers: { "Content-Type": "application/json", "Retry-After": "5" } }
    ),
  };
}
