import { randomUUID } from "node:crypto";
import v8 from "node:v8";

import { checkHeapPressureGuard, HEAP_PRESSURE_THRESHOLD_MB } from "./heapPressure.ts";
import { buildErrorBody } from "./error.ts";
import {
  createResourcePressureTracker,
  resolveResourcePressureThresholds,
  type PressureReason,
  type ResourcePressureState,
  type ResourcePressureThresholds,
  type ResourceSignals,
} from "./resourcePressurePolicy.ts";
import {
  sampleResourceSignals,
  type SampleResourceSignalsDeps,
} from "./resourcePressureSampler.ts";

const MB = 1024 * 1024;
const RETRY_AFTER_SECONDS = "5";
const PRESSURE_MESSAGE = "Service temporarily unavailable due to resource pressure. Retry shortly.";

export type ResourcePressureGuardResult = {
  success: false;
  status: 503;
  error: string;
  response: Response;
};

export type ResourcePressureObservation = {
  signals: ResourceSignals | null;
  state: ResourcePressureState;
};

export type ResourcePressureRequestContext = {
  correlationId?: string | null;
  endpoint?: string | null;
  provider?: string | null;
  model?: string | null;
};

export type ResourcePressureRuntimeOptions = {
  thresholds?: Partial<ResourcePressureThresholds>;
  heapThresholdMb?: number | null;
  immediateHeapUsedMb?: () => number;
  immediateMemoryUsage?: () => NodeJS.MemoryUsage;
  sample?: () => Promise<ResourceSignals>;
  nowMs?: () => number;
  schedule?: (refresh: () => void) => void;
  staleAfterMs?: number;
  maxStaleMs?: number;
  retryAfterMs?: number;
  samplerDeps?: SampleResourceSignalsDeps;
};

export type ResourcePressureRuntime = {
  check: (context?: ResourcePressureRequestContext) => ResourcePressureGuardResult | null;
  getObservation: () => ResourcePressureObservation;
  whenRefreshSettled: () => Promise<void>;
  dispose: () => void;
};

function emptyState(): ResourcePressureState {
  return {
    severity: "normal",
    reason: "none",
    elevatedStreak: 0,
    recoveryStreak: 0,
    lastTransitionAtMs: 0,
    observedAtMs: 0,
  };
}

function requireDuration(name: string, value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value > 3_600_000) {
    throw new RangeError(`${name} must be an integer between 0 and 3600000`);
  }
  return value;
}

/**
 * Human-readable key=value detail appended to the rejection log line. Every
 * rejection (immediate heap trip AND cached-critical-state reuse) goes
 * through here, so this is the one place that needs the actual numbers —
 * the bare reason code alone ("psi_some") gives an operator nothing to act
 * on when deciding whether the guard is mistuned vs. genuinely saturated.
 */
function formatPressureDetail(detail: Record<string, number | string | null | undefined>): string {
  return Object.entries(detail)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value ?? "null"}`)
    .join(" ");
}

function megabytes(bytes: number | null | undefined): number | null {
  return typeof bytes === "number" && Number.isFinite(bytes) && bytes >= 0
    ? Math.round(bytes / MB)
    : null;
}

export function sanitizeResourcePressureCorrelationId(
  value: string | null | undefined
): string | null {
  if (typeof value !== "string") return null;
  const uuidPattern =
    /^(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|[a-f0-9]{32})$/i;
  return uuidPattern.test(value) ? value : null;
}

function sanitizePressureLabel(value: string | null | undefined, maxLength = 128): string | null {
  if (typeof value !== "string") return null;
  const bounded = value.trim();
  return bounded.length > 0 && bounded.length <= maxLength && /^[A-Za-z0-9._:+/-]+$/.test(bounded)
    ? bounded
    : null;
}

function pressureRequestDetail(
  context: ResourcePressureRequestContext | undefined
): Record<string, string> {
  if (!context) return {};
  const endpoint = typeof context.endpoint === "string" ? context.endpoint.split(/[?#]/, 1)[0] : "";
  const normalized = endpoint.toLowerCase();
  const route = normalized.endsWith("/v1/chat/completions")
    ? "chat_completions"
    : normalized.endsWith("/v1/completions")
      ? "completions"
      : normalized.endsWith("/v1/responses")
        ? "responses"
        : normalized.endsWith("/v1/messages")
          ? "messages"
          : normalized.endsWith("/api/chat") || normalized.endsWith("/v1/api/chat")
            ? "ollama_chat"
            : "other_chat_route";
  const provider = sanitizePressureLabel(context.provider, 64);
  const model = sanitizePressureLabel(context.model);
  return {
    route,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
  };
}

function pressureSampleDetail(
  signals: ResourceSignals | null,
  sampleAgeMs: number
): Record<string, number | string | null> {
  const psi = signals?.psi;
  const events = signals?.cgroup.events;
  return {
    sampleAgeMs: Number.isFinite(sampleAgeMs) ? Math.max(0, Math.round(sampleAgeMs)) : null,
    sampleObservedAtMs: signals?.observedAtMs ?? null,
    sampleHeapUsedMb: megabytes(signals?.v8.heapUsedBytes),
    sampleHeapLimitMb: megabytes(signals?.v8.heapLimitBytes),
    sampleRssMb: megabytes(signals?.process.rssBytes),
    sampleExternalMb: megabytes(signals?.process.externalBytes),
    sampleArrayBuffersMb: megabytes(signals?.process.arrayBuffersBytes),
    sampleAvailableMb: megabytes(signals?.process.availableBytes),
    sampleConstrainedMb: megabytes(signals?.process.constrainedBytes),
    cgroupCurrentMb: megabytes(signals?.cgroup.currentBytes),
    cgroupMaxMb: megabytes(signals?.cgroup.maxBytes),
    cgroupHighMb: megabytes(signals?.cgroup.highBytes),
    cgroupFileMb: megabytes(signals?.cgroup.fileBytes),
    cgroupHighEvents: events?.high ?? null,
    cgroupMaxEvents: events?.max ?? null,
    cgroupOomEvents: events?.oom ?? null,
    cgroupOomKillEvents: events?.oom_kill ?? null,
    psiSomeAvg10: psi?.someAvg10 ?? null,
    psiFullAvg10: psi?.fullAvg10 ?? null,
  };
}

/** Builds buildCriticalGuard's detail object for the cached-critical-state
 * reuse path in check() -- pulled out of check() itself so that function's
 * own cyclomatic complexity stays under the ratchet, not because this needs
 * to be reused anywhere else. */
function describeCachedPressure(params: {
  signals: ResourceSignals | null;
  recoveryStreak: number;
  cacheAgeMs: number;
  requestContext?: ResourcePressureRequestContext;
}): Record<string, number | string | null> {
  return {
    ...pressureSampleDetail(params.signals, params.cacheAgeMs),
    recoveryStreak: params.recoveryStreak,
    ...pressureRequestDetail(params.requestContext),
    ...(params.requestContext?.correlationId
      ? { correlationId: params.requestContext.correlationId }
      : {}),
  };
}

function buildCriticalGuard(
  reason: PressureReason,
  detail: Record<string, number | string | null | undefined> = {}
): ResourcePressureGuardResult {
  const correlationId =
    sanitizeResourcePressureCorrelationId(
      typeof detail.correlationId === "string" ? detail.correlationId : null
    ) ?? randomUUID();
  const detailText = formatPressureDetail({ ...detail, correlationId });
  console.warn(
    `[resourcePressure] critical pressure guard tripped (reason=${reason} pid=${process.pid} loggedAt=${new Date().toISOString()}${detailText ? " " + detailText : ""}); returning 503`
  );
  return {
    success: false,
    status: 503,
    error: PRESSURE_MESSAGE,
    response: new Response(
      JSON.stringify(
        buildErrorBody(503, PRESSURE_MESSAGE, undefined, {
          type: "server_error",
          code: "resource_pressure",
        })
      ),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": RETRY_AFTER_SECONDS,
          "x-request-id": correlationId,
        },
      }
    ),
  };
}

function immediateHeapGuard(
  heapUsedMb: number,
  thresholdMb: number | null,
  signals: ResourceSignals | null,
  sampleAgeMs: number,
  context?: ResourcePressureRequestContext,
  immediateMemory?: NodeJS.MemoryUsage | null
): ResourcePressureGuardResult | null {
  if (thresholdMb == null) return null;
  // The detailed correlated resource-pressure warning below is the single log
  // record for this rejection; avoid the generic duplicate from the heap helper.
  const guard = checkHeapPressureGuard(heapUsedMb, thresholdMb, false);
  if (!guard) return null;
  const correlationId = sanitizeResourcePressureCorrelationId(context?.correlationId);
  let heapStatistics: ReturnType<typeof v8.getHeapStatistics> | null = null;
  try {
    heapStatistics = v8.getHeapStatistics();
  } catch {
    // The 503 still needs to be returned if a diagnostic snapshot is unavailable.
  }
  return buildCriticalGuard("v8_heap_absolute", {
    immediateHeapUsedMb: Math.round(heapUsedMb),
    thresholdMb: Math.round(thresholdMb),
    eventHeapTotalMb: megabytes(immediateMemory?.heapTotal),
    eventRssMb: megabytes(immediateMemory?.rss),
    eventExternalMb: megabytes(immediateMemory?.external),
    eventArrayBuffersMb: megabytes(immediateMemory?.arrayBuffers),
    eventV8HeapUsedMb: megabytes(heapStatistics?.used_heap_size),
    eventV8HeapLimitMb: megabytes(heapStatistics?.heap_size_limit),
    ...pressureSampleDetail(signals, sampleAgeMs),
    ...pressureRequestDetail(context),
    ...(correlationId ? { correlationId } : {}),
  });
}

export function createResourcePressureRuntime(
  options: ResourcePressureRuntimeOptions = {}
): ResourcePressureRuntime {
  const heapThresholdMb =
    options.heapThresholdMb === undefined ? HEAP_PRESSURE_THRESHOLD_MB : options.heapThresholdMb;
  if (heapThresholdMb !== null && (!Number.isFinite(heapThresholdMb) || heapThresholdMb <= 0)) {
    throw new RangeError("heapThresholdMb must be positive and finite or null");
  }
  const thresholds = resolveResourcePressureThresholds({
    ...options.thresholds,
    heapAbsoluteThresholdMb:
      options.thresholds?.heapAbsoluteThresholdMb === undefined
        ? null
        : options.thresholds.heapAbsoluteThresholdMb,
  });
  const staleAfterMs = requireDuration("staleAfterMs", options.staleAfterMs ?? 1_000);
  const maxStaleMs = requireDuration("maxStaleMs", options.maxStaleMs ?? 30_000);
  const retryAfterMs = requireDuration("retryAfterMs", options.retryAfterMs ?? 1_000);
  if (maxStaleMs < staleAfterMs) {
    throw new RangeError("maxStaleMs must be greater than or equal to staleAfterMs");
  }

  const nowMs = options.nowMs ?? Date.now;
  const immediateMemoryUsage = options.immediateMemoryUsage ?? (() => process.memoryUsage());
  const sample = options.sample ?? (() => sampleResourceSignals(options.samplerDeps));
  const schedule =
    options.schedule ??
    ((refresh) => {
      const handle = setImmediate(refresh);
      handle.unref();
    });
  const tracker = createResourcePressureTracker(thresholds);

  let lastSignals: ResourceSignals | null = null;
  let state = emptyState();
  let lastRefreshAtMs = Number.NEGATIVE_INFINITY;
  let nextRefreshAtMs = Number.NEGATIVE_INFINITY;
  let scheduled = false;
  let inFlight: Promise<void> | null = null;
  let disposed = false;

  const refresh = (): void => {
    if (disposed || inFlight) return;
    scheduled = false;
    inFlight = Promise.resolve()
      .then(sample)
      .then((signals) => {
        if (disposed) return;
        const settledAtMs = nowMs();
        lastSignals = signals;
        state = tracker.observe(signals);
        lastRefreshAtMs = settledAtMs;
        nextRefreshAtMs = settledAtMs + staleAfterMs;
      })
      .catch(() => {
        if (!disposed) nextRefreshAtMs = nowMs() + retryAfterMs;
      })
      .finally(() => {
        inFlight = null;
      });
  };

  const scheduleRefresh = (): void => {
    if (disposed || scheduled || inFlight) return;
    scheduled = true;
    schedule(refresh);
  };

  return {
    check(context) {
      let immediateMemory: NodeJS.MemoryUsage | null = null;
      try {
        immediateMemory = immediateMemoryUsage();
      } catch {
        // The fast process snapshot is diagnostic and must not block the request path.
      }
      let heapUsedMb = immediateMemory ? immediateMemory.heapUsed / MB : 0;
      if (options.immediateHeapUsedMb) {
        try {
          heapUsedMb = options.immediateHeapUsedMb();
        } catch {
          heapUsedMb = 0;
        }
      }
      const now = nowMs();
      const cacheAge = lastSignals ? Math.max(0, now - lastRefreshAtMs) : Number.POSITIVE_INFINITY;
      const immediate = immediateHeapGuard(
        heapUsedMb,
        heapThresholdMb,
        lastSignals,
        cacheAge,
        context,
        immediateMemory
      );
      if (now >= nextRefreshAtMs) scheduleRefresh();
      if (immediate) {
        state = {
          severity: "critical",
          reason: "v8_heap_absolute",
          elevatedStreak: 0,
          recoveryStreak: 0,
          lastTransitionAtMs: now,
          observedAtMs: now,
        };
        return immediate;
      }
      if (cacheAge > maxStaleMs || state.severity !== "critical") {
        return null;
      }
      return buildCriticalGuard(
        state.reason,
        describeCachedPressure({
          signals: lastSignals,
          recoveryStreak: state.recoveryStreak,
          cacheAgeMs: cacheAge,
          requestContext: {
            ...context,
            correlationId: sanitizeResourcePressureCorrelationId(context?.correlationId),
          },
        })
      );
    },
    getObservation: () => ({ signals: lastSignals, state }),
    whenRefreshSettled: async () => {
      if (scheduled) await new Promise<void>((resolve) => setImmediate(resolve));
      if (inFlight) await inFlight;
    },
    dispose() {
      disposed = true;
      scheduled = false;
    },
  };
}

let defaultRuntime = createResourcePressureRuntime();

export function checkResourcePressureGuard(
  context?: ResourcePressureRequestContext
): ResourcePressureGuardResult | null {
  return defaultRuntime.check(context);
}

export function getResourcePressureObservation(): ResourcePressureObservation {
  return defaultRuntime.getObservation();
}

/** Replaces and disposes the process singleton when configuration is reloaded. */
export function reloadResourcePressureRuntime(
  options: ResourcePressureRuntimeOptions = {}
): ResourcePressureRuntime {
  defaultRuntime.dispose();
  defaultRuntime = createResourcePressureRuntime(options);
  return defaultRuntime;
}

export type {
  PressureReason,
  PressureSeverity,
  ResourceMetricBytes,
  ResourcePressureState,
  ResourcePressureThresholds,
  ResourcePressureTracker,
  ResourceSignals,
} from "./resourcePressurePolicy.ts";
export {
  classifyAdaptiveResourcePressure as classifyResourcePressure,
  createResourcePressureTracker,
  resolveResourcePressureThresholds,
} from "./resourcePressurePolicy.ts";
export {
  sampleResourceSignals,
  sanitizeMemoryBytes,
  type ResourcePressureFs,
  type SampleResourceSignalsDeps,
} from "./resourcePressureSampler.ts";
