import {
  createCodexAccountPool,
  getCodexParentAccountDiagnostic,
} from "@omniroute/open-sse/services/codexAccount/index.ts";
import type { ModelLockoutInfo } from "@omniroute/open-sse/services/accountFallback.ts";
import type { AdaptiveAdmissionPublicSnapshot } from "@omniroute/open-sse/services/admission/runtime.ts";
import {
  getResourcePressureObservation,
  type ResourcePressureObservation,
} from "@omniroute/open-sse/utils/resourcePressure.ts";
import { HEAP_PRESSURE_THRESHOLD_MB } from "@omniroute/open-sse/utils/heapPressure.ts";
import type { PerConnectionAdmissionController } from "@/shared/middleware/chatBodyAdmission";
import type { WalMaintenanceState } from "@/lib/db/walMaintenance";
import type { CallLogArtifactWriterSnapshot } from "@/lib/usage/callLogArtifactWriter";

type JsonRecord = Record<string, unknown>;

/** Process-wide structural chat-admission snapshot type (chatBodyAdmission.ts). */
export type ChatAdmissionSnapshot = ReturnType<PerConnectionAdmissionController["snapshot"]>;

/**
 * Low-card structural chat-admission health summary (#11244) — the bounded
 * heavyweight-lease gate from chatBodyAdmission.ts (#10110/#10437), NOT the
 * adaptive shadow-mode layer above. Lane keys are opaque HMAC fairness
 * fingerprints (resolveSessionId), never raw credentials.
 */
export type ChatAdmissionHealthSummary = {
  activeHeavy: number;
  activeHealthyHeadroom: number;
  /** Structural-gate waiters only; byte-budget waiters are reported separately. */
  waiting: number;
  /** Aggregate queued-byte charge shared by structural and ingest-byte queues. */
  queuedBytes: number;
  shedTotal: number;
  shedsByReason: Record<string, number>;
  lanes: Array<{ key: string; waiting: number }>;
  /** #503-fanout: live ingest bytes reserved through the byte-budget gate. */
  inflightBytes: number;
  /** #503-fanout: bytes and requests parked specifically on the ingest-byte gate. */
  byteBudgetQueuedBytes: number;
  byteBudgetWaiting: number;
  /** #503-fanout: the auto-derived (or overridden) budget ceiling. */
  maxInflightBytes: number;
  /** #503-fanout: which signal the budget was derived from. */
  budgetSource: string;
  /** #503-fanout: live multi-signal resource-pressure severity. */
  pressureSeverity: string;
  /** #503-fanout: false on a default deployment — proves the byte-budget
   * gate, not the legacy request-count cap, is what is actually binding. */
  countCapEnabled: boolean;
};

/**
 * WAL maintenance health summary (#12853) — the periodic TRUNCATE lifecycle
 * from walMaintenance.ts. Fixed low-cardinality shape, never raw-spread.
 */
export type WalMaintenanceSnapshot = Pick<
  WalMaintenanceState,
  "ticks" | "busyStreak" | "busyTotal" | "lastBusyAt" | "lastOkAt"
>;

/** Bounded call-log writer gauges/counters; never includes queued artifact data. */
export type CallLogArtifactWriterHealthSummary = CallLogArtifactWriterSnapshot;

/** Explicit allowlisted projection; never spreads the writer's internal state. */
export function projectCallLogArtifactWriterSummary(
  snapshot: CallLogArtifactWriterSnapshot | null | undefined
): CallLogArtifactWriterHealthSummary | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const count = (value: unknown): number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const workerState = ["not_started", "idle", "active", "closing"].includes(
    String(snapshot.workerState)
  )
    ? snapshot.workerState
    : "not_started";
  return {
    activeJobs: count(snapshot.activeJobs),
    queuedArtifacts: count(snapshot.queuedArtifacts),
    queuedDiagnosticStubs: count(snapshot.queuedDiagnosticStubs),
    reservedArtifactBytes: count(snapshot.reservedArtifactBytes),
    artifactFootprintLimitBytes: count(snapshot.artifactFootprintLimitBytes),
    reservedDiagnosticStubBytes: count(snapshot.reservedDiagnosticStubBytes),
    diagnosticStubFootprintLimitBytes: count(snapshot.diagnosticStubFootprintLimitBytes),
    activeJobsHighWater: count(snapshot.activeJobsHighWater),
    queuedArtifactsHighWater: count(snapshot.queuedArtifactsHighWater),
    queuedDiagnosticStubsHighWater: count(snapshot.queuedDiagnosticStubsHighWater),
    reservedArtifactBytesHighWater: count(snapshot.reservedArtifactBytesHighWater),
    reservedDiagnosticStubBytesHighWater: count(snapshot.reservedDiagnosticStubBytesHighWater),
    workerState,
    preparationRefusalsTotal: count(snapshot.preparationRefusalsTotal),
    preparationRefusalsInvalidEstimateTotal: count(
      snapshot.preparationRefusalsInvalidEstimateTotal
    ),
    preparationRefusalsSingleArtifactBudgetTotal: count(
      snapshot.preparationRefusalsSingleArtifactBudgetTotal
    ),
    preparationRefusalsAggregateReservationBudgetTotal: count(
      snapshot.preparationRefusalsAggregateReservationBudgetTotal
    ),
    detailOmissionsTotal: count(snapshot.detailOmissionsTotal),
    workerFailuresTotal: count(snapshot.workerFailuresTotal),
    pointerFallbacksTotal: count(snapshot.pointerFallbacksTotal),
    pointerFallbackFailuresTotal: count(snapshot.pointerFallbackFailuresTotal),
    diagnosticStubRefusalsTotal: count(snapshot.diagnosticStubRefusalsTotal),
  };
}

/**
 * Explicit allowlisted projection of the WAL maintenance state.
 * Copies only the documented scalar fields — no timers, no internals.
 */
export function projectWalMaintenanceSummary(
  state: WalMaintenanceState | null | undefined
): WalMaintenanceSnapshot | null {
  if (!state || typeof state !== "object") return null;
  return {
    ticks: state.ticks,
    busyStreak: state.busyStreak,
    busyTotal: state.busyTotal,
    lastBusyAt: state.lastBusyAt,
    lastOkAt: state.lastOkAt,
  };
}

/**
 * Explicit allowlisted projection of the structural admission snapshot.
 * Never spreads the snapshot — only the documented low-cardinality fields pass.
 */
export function projectChatAdmissionSummary(
  snapshot: ChatAdmissionSnapshot | null | undefined
): ChatAdmissionHealthSummary | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  return {
    activeHeavy: snapshot.activeHeavy,
    activeHealthyHeadroom: snapshot.activeHealthyHeadroom,
    waiting: snapshot.waiting,
    queuedBytes: snapshot.queuedBytes,
    shedTotal: snapshot.shedTotal,
    shedsByReason: { ...(snapshot.shedsByReason ?? {}) },
    lanes: (snapshot.lanes ?? []).map((lane) => ({ key: lane.key, waiting: lane.waiting })),
    inflightBytes: snapshot.inflightBytes,
    byteBudgetQueuedBytes: snapshot.byteBudgetQueuedBytes,
    byteBudgetWaiting: snapshot.byteBudgetWaiting,
    maxInflightBytes: snapshot.maxInflightBytes,
    budgetSource: snapshot.budgetSource,
    pressureSeverity: snapshot.pressureSeverity,
    countCapEnabled: snapshot.countCapEnabled,
  };
}

/**
 * Management health projection of the latest pressure sample. It contains only
 * numeric process/cgroup/PSI signals and the guard state; request or credential
 * content never enters the health payload.
 */
export function projectResourcePressureObservation(
  observation: ResourcePressureObservation | null | undefined,
  nowMs = Date.now()
): JsonRecord | null {
  if (!observation || typeof observation !== "object") return null;
  const signals = observation.signals;
  return {
    heapPressureThresholdMb: HEAP_PRESSURE_THRESHOLD_MB,
    psiSource: "host_proc_pressure_memory",
    state: {
      severity: observation.state.severity,
      reason: observation.state.reason,
      elevatedStreak: observation.state.elevatedStreak,
      recoveryStreak: observation.state.recoveryStreak,
      lastTransitionAtMs: observation.state.lastTransitionAtMs,
      observedAtMs: observation.state.observedAtMs,
    },
    sampleAgeMs:
      signals && Number.isFinite(signals.observedAtMs)
        ? Math.max(0, Math.round(nowMs - signals.observedAtMs))
        : null,
    signals: signals
      ? {
          observedAtMs: signals.observedAtMs,
          v8: {
            heapUsedBytes: signals.v8.heapUsedBytes,
            heapLimitBytes: signals.v8.heapLimitBytes,
          },
          process: {
            rssBytes: signals.process.rssBytes,
            externalBytes: signals.process.externalBytes,
            arrayBuffersBytes: signals.process.arrayBuffersBytes,
            availableBytes: signals.process.availableBytes,
            constrainedBytes: signals.process.constrainedBytes,
          },
          cgroup: {
            currentBytes: signals.cgroup.currentBytes,
            maxBytes: signals.cgroup.maxBytes,
            highBytes: signals.cgroup.highBytes,
            fileBytes: signals.cgroup.fileBytes,
            events: signals.cgroup.events
              ? {
                  low: signals.cgroup.events.low,
                  high: signals.cgroup.events.high,
                  max: signals.cgroup.events.max,
                  oom: signals.cgroup.events.oom,
                  oom_kill: signals.cgroup.events.oom_kill,
                }
              : null,
          },
          psi: signals.psi
            ? {
                someAvg10: signals.psi.someAvg10,
                someAvg60: signals.psi.someAvg60,
                someAvg300: signals.psi.someAvg300,
                fullAvg10: signals.psi.fullAvg10,
                fullAvg60: signals.psi.fullAvg60,
                fullAvg300: signals.psi.fullAvg300,
              }
            : null,
        }
      : null,
  };
}

/** Low-card adaptive-admission health summary — no tenant/request/body/queue details. */
export type AdaptiveAdmissionHealthSummary = {
  mode: AdaptiveAdmissionPublicSnapshot["mode"];
  currentLimit: number;
  minLimit: number;
  maxLimit: number;
  activeCost: number;
  activeCount: number;
  queuedCost: number;
  queuedCount: number;
  admittedCount: number;
  rejectedCount: number;
  wouldAdmitCount: number;
  wouldQueueCount: number;
  wouldRejectCount: number;
  utilization: number;
  pressure: AdaptiveAdmissionPublicSnapshot["pressure"];
  resourceSeverity: AdaptiveAdmissionPublicSnapshot["resourceSeverity"];
  resourceReason: AdaptiveAdmissionPublicSnapshot["resourceReason"];
  resourceObservedAtMs: number;
  pressureGuardRejectCount: number;
  shutdown: boolean;
};

/**
 * Explicit allowlisted projection of the public adaptive-admission snapshot.
 * Never spreads the snapshot — extra keys (tenant, body, queue items, paths) are dropped.
 */
export function projectAdaptiveAdmissionSummary(
  snapshot: AdaptiveAdmissionPublicSnapshot | null | undefined
): AdaptiveAdmissionHealthSummary | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  return {
    mode: snapshot.mode,
    currentLimit: snapshot.currentLimit,
    minLimit: snapshot.minLimit,
    maxLimit: snapshot.maxLimit,
    activeCost: snapshot.activeCost,
    activeCount: snapshot.activeCount,
    queuedCost: snapshot.queuedCost,
    queuedCount: snapshot.queuedCount,
    admittedCount: snapshot.admittedCount,
    rejectedCount: snapshot.rejectedCount,
    wouldAdmitCount: snapshot.wouldAdmitCount,
    wouldQueueCount: snapshot.wouldQueueCount,
    wouldRejectCount: snapshot.wouldRejectCount,
    utilization: snapshot.utilization,
    pressure: snapshot.pressure,
    resourceSeverity: snapshot.resourceSeverity,
    resourceReason: snapshot.resourceReason,
    resourceObservedAtMs: snapshot.resourceObservedAtMs,
    pressureGuardRejectCount: snapshot.pressureGuardRejectCount,
    shutdown: snapshot.shutdown,
  };
}

interface CircuitBreakerStatus {
  name: string;
  state: string;
  failureCount?: number;
  lastFailureTime?: number | string | null;
  retryAfterMs?: number;
}

interface SessionSnapshot {
  sessionId: string;
  createdAt: number;
  lastActive: number;
  requestCount: number;
  connectionId: string | null;
  ageMs: number;
}

interface QuotaMonitorSnapshot {
  sessionId: string;
  provider: string;
  accountId: string;
  status: "starting" | "idle" | "healthy" | "warning" | "exhausted" | "error";
  startedAt: string;
  lastPolledAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  lastQuotaPercent: number | null;
  lastQuotaUsed: number | null;
  lastQuotaTotal: number | null;
  lastResetAt: string | null;
  lastAlertAt: string | null;
  nextPollDelayMs: number | null;
  nextPollAt: string | null;
  totalPolls: number;
  totalAlerts: number;
  consecutiveFailures: number;
}

interface QuotaMonitorSummary {
  active: number;
  alerting: number;
  exhausted: number;
  errors: number;
  statusCounts: Record<QuotaMonitorSnapshot["status"], number>;
  byProvider: Record<string, number>;
}

interface BuildSessionsSummaryOptions {
  activeSessions: SessionSnapshot[];
  activeSessionsByKey?: Record<string, number>;
}

interface BuildTelemetryPayloadOptions {
  summary: {
    count: number;
    avg?: number;
    p50: number;
    p95: number;
    p99: number;
    phaseBreakdown: JsonRecord;
  };
  quotaMonitorSummary: QuotaMonitorSummary;
  activeSessions: SessionSnapshot[];
}

interface BuildHealthPayloadOptions {
  appVersion: string;
  /** #10427: git SHA the running artifact was built from, so a deploy is auditable over HTTP. */
  buildSha?: string | null;
  catalogCount?: number;
  settings: { setupComplete?: boolean } | null | undefined;
  connections: Array<{
    id?: string;
    provider?: string;
    isActive?: boolean | null;
    rateLimitedUntil?: unknown;
    providerSpecificData?: Readonly<Record<string, unknown>> | null;
  }>;
  circuitBreakers: CircuitBreakerStatus[];
  rateLimitStatus: JsonRecord;
  learnedLimits: JsonRecord;
  lockouts: ModelLockoutInfo[];
  localProviders: JsonRecord;
  inflightRequests: number;
  quotaMonitorSummary: QuotaMonitorSummary;
  quotaMonitorMonitors: QuotaMonitorSnapshot[];
  activeSessions: SessionSnapshot[];
  activeSessionsByKey?: Record<string, number>;
  credentialHealth?: {
    total: number;
    healthy: number;
    failed: number;
    unknown: number;
    stale: number;
  };
  /** Optional injected public adaptive-admission snapshot; projected, never raw-spread. */
  adaptiveAdmission?: AdaptiveAdmissionPublicSnapshot | null;
  /** #11244: optional structural chat-admission snapshot; projected, never raw-spread. */
  chatAdmission?: ChatAdmissionSnapshot | null;
  /** #12853: optional WAL maintenance snapshot; projected, never raw-spread. */
  walMaintenance?: WalMaintenanceSnapshot | null;
  /** Bounded call-log writer gauges/counters; projected, never raw-spread. */
  callLogArtifacts?: CallLogArtifactWriterSnapshot | null;
}

function limitMonitors(monitors: QuotaMonitorSnapshot[], maxItems = 8): QuotaMonitorSnapshot[] {
  return monitors.slice(0, maxItems);
}

export function buildSessionsSummary({
  activeSessions,
  activeSessionsByKey = {},
}: BuildSessionsSummaryOptions) {
  const ordered = [...activeSessions].sort((left, right) => right.lastActive - left.lastActive);
  const stickyBoundCount = ordered.filter((entry) => entry.connectionId).length;

  return {
    activeCount: ordered.length,
    stickyBoundCount,
    byApiKey: activeSessionsByKey,
    top: ordered.slice(0, 8).map((entry) => ({
      sessionId: entry.sessionId,
      requestCount: entry.requestCount,
      connectionId: entry.connectionId,
      ageMs: entry.ageMs,
      idleMs: Math.max(0, Date.now() - entry.lastActive),
      createdAt: new Date(entry.createdAt).toISOString(),
      lastActiveAt: new Date(entry.lastActive).toISOString(),
    })),
  };
}

export function buildTelemetryPayload({
  summary,
  quotaMonitorSummary,
  activeSessions,
}: BuildTelemetryPayloadOptions) {
  const sessions = buildSessionsSummary({ activeSessions });
  return {
    ...summary,
    totalRequests: summary.count,
    avgLatencyMs: summary.avg ?? summary.p50,
    sessions: {
      activeCount: sessions.activeCount,
      stickyBoundCount: sessions.stickyBoundCount,
    },
    quotaMonitor: {
      active: quotaMonitorSummary.active,
      alerting: quotaMonitorSummary.alerting,
      exhausted: quotaMonitorSummary.exhausted,
      errors: quotaMonitorSummary.errors,
      statusCounts: quotaMonitorSummary.statusCounts,
    },
  };
}

/** Per-provider connection-cooldown summary, exposed as `connectionHealth[provider]`. */
export interface ConnectionCooldownSummary {
  /** Connections currently in cooldown (future `rateLimitedUntil`). Always > 0 when present. */
  coolingDown: number;
  /** Total connections configured for the provider. */
  total: number;
  /** Relative ms until the first cooling connection recovers (the soonest). */
  soonestRetryAfterMs: number;
}

/**
 * Parse a connection's `rateLimitedUntil` to an absolute epoch (ms). Mirrors the
 * canonical `cooldownUntilMs` (open-sse/services/accountFallback.ts, #3954) — kept
 * inline so this monitoring util stays decoupled from the heavy executor module.
 * Accepts ISO strings, Date objects, and numeric-epoch strings (the SQLite
 * TEXT-affinity case where `new Date(...)` would yield NaN).
 */
function parseCooldownUntilMs(value: unknown): number {
  if (value === null || value === undefined || value === "") return NaN;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value !== "string") return NaN;
  const raw = value.trim();
  if (/^\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return new Date(raw).getTime();
}

/**
 * Aggregate per-connection cooldown state into a per-provider summary. Only providers
 * with at least one connection still cooling down (future `rateLimitedUntil`) appear in
 * the result — mirroring `providerHealth`, which only carries non-healthy breakers — so
 * the cascade overlay attaches a badge only when there is something to show.
 *
 * `nowMs` is injected (not read from the clock here) to keep the function pure/testable.
 */
export function summarizeConnectionCooldown(
  connections: Array<{ provider?: string; rateLimitedUntil?: unknown }>,
  nowMs: number
): Record<string, ConnectionCooldownSummary> {
  const byProvider: Record<string, { total: number; coolingDown: number; soonestUntil: number }> =
    {};
  for (const connection of connections) {
    const provider = connection?.provider;
    if (!provider) continue;
    const bucket = (byProvider[provider] ??= {
      total: 0,
      coolingDown: 0,
      soonestUntil: Infinity,
    });
    bucket.total += 1;
    const until = parseCooldownUntilMs(connection.rateLimitedUntil);
    if (Number.isFinite(until) && until > nowMs) {
      bucket.coolingDown += 1;
      if (until < bucket.soonestUntil) bucket.soonestUntil = until;
    }
  }

  const summary: Record<string, ConnectionCooldownSummary> = {};
  for (const [provider, bucket] of Object.entries(byProvider)) {
    if (bucket.coolingDown <= 0) continue;
    summary[provider] = {
      coolingDown: bucket.coolingDown,
      total: bucket.total,
      soonestRetryAfterMs:
        bucket.soonestUntil === Infinity ? 0 : Math.max(0, bucket.soonestUntil - nowMs),
    };
  }
  return summary;
}

export interface CodexAccountPoolsSummary {
  total: number;
  available: number;
  partiallyLimited: number;
  fullyLimited: number;
  quotaObserved: number;
  soonestRetryAfterMs: number;
}

export function summarizeCodexAccountPools(
  connections: BuildHealthPayloadOptions["connections"],
  nowMs: number
): CodexAccountPoolsSummary {
  const summary: CodexAccountPoolsSummary = {
    total: 0,
    available: 0,
    partiallyLimited: 0,
    fullyLimited: 0,
    quotaObserved: 0,
    soonestRetryAfterMs: 0,
  };
  for (const connection of connections) {
    if (connection.provider !== "codex" || !connection.id) continue;
    const diagnostic = getCodexParentAccountDiagnostic(
      createCodexAccountPool({
        id: connection.id,
        provider: connection.provider,
        providerSpecificData: connection.providerSpecificData ?? {},
      }),
      nowMs
    );
    summary.total += 1;
    if (diagnostic.status === "available") summary.available += 1;
    else if (diagnostic.status === "partially_limited") summary.partiallyLimited += 1;
    else summary.fullyLimited += 1;
    if (diagnostic.quota.observedScopeCount > 0) summary.quotaObserved += 1;
    if (
      diagnostic.cooldown.soonestRetryAfterMs > 0 &&
      (summary.soonestRetryAfterMs === 0 ||
        diagnostic.cooldown.soonestRetryAfterMs < summary.soonestRetryAfterMs)
    ) {
      summary.soonestRetryAfterMs = diagnostic.cooldown.soonestRetryAfterMs;
    }
  }
  return summary;
}

export function buildHealthPayload({
  appVersion,
  catalogCount = 0,
  settings,
  connections,
  circuitBreakers,
  rateLimitStatus,
  learnedLimits,
  lockouts,
  localProviders,
  inflightRequests,
  quotaMonitorSummary,
  quotaMonitorMonitors,
  activeSessions,
  activeSessionsByKey = {},
  credentialHealth,
  adaptiveAdmission = null,
  chatAdmission = null,
  walMaintenance = null,
  callLogArtifacts = null,
  buildSha = null,
}: BuildHealthPayloadOptions) {
  const timestamp = new Date().toISOString();
  const system = {
    version: appVersion,
    // #10427: identifying a bad deploy previously required SSH + grepping compiled chunks.
    // Absent/empty when unknown (dev runs) — never a fabricated value.
    ...(buildSha ? { buildSha } : {}),
    nodeVersion: process.version,
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    resourcePressure: projectResourcePressureObservation(getResourcePressureObservation()),
    pid: process.pid,
    platform: process.platform,
  };

  const providerBreakers = circuitBreakers
    .filter((cb) => !cb.name.startsWith("test-") && !cb.name.startsWith("test_"))
    .map((cb) => {
      const lastFailure =
        typeof cb.lastFailureTime === "number" && Number.isFinite(cb.lastFailureTime)
          ? new Date(cb.lastFailureTime).toISOString()
          : typeof cb.lastFailureTime === "string"
            ? cb.lastFailureTime
            : null;
      return {
        provider: cb.name,
        state: cb.state,
        failureCount: cb.failureCount || 0,
        lastFailure,
        retryAfterMs: cb.retryAfterMs || 0,
      };
    });

  const providerHealth: Record<string, JsonRecord> = {};
  for (const breaker of providerBreakers) {
    providerHealth[breaker.provider] = {
      state: breaker.state,
      failures: breaker.failureCount,
      lastFailure: breaker.lastFailure,
      retryAfterMs: breaker.retryAfterMs,
    };
  }

  const nowMs = Date.now();
  const connectionHealth = summarizeConnectionCooldown(connections, nowMs);
  const codexAccountPools = summarizeCodexAccountPools(connections, nowMs);

  const configuredProviders = new Set(
    connections.map((connection) => connection.provider).filter(Boolean)
  );
  const activeProviders = new Set(
    connections
      .filter((connection) => connection.isActive !== false)
      .map((connection) => connection.provider)
      .filter(Boolean)
  );
  const breakerCounts = circuitBreakers.reduce(
    (acc, cb) => {
      if (cb.name.startsWith("test-") || cb.name.startsWith("test_")) return acc;
      if (cb.state === "OPEN") acc.open += 1;
      else if (cb.state === "HALF_OPEN") acc.halfOpen += 1;
      else if (cb.state === "DEGRADED") acc.degraded += 1;
      else acc.closed += 1;
      return acc;
    },
    { open: 0, halfOpen: 0, degraded: 0, closed: 0 }
  );

  return {
    status: "healthy",
    timestamp,
    system,
    version: system.version,
    uptime: system.uptime,
    memoryUsage: system.memoryUsage,
    activeConnections: connections.length,
    circuitBreakers: {
      ...breakerCounts,
      total:
        breakerCounts.open + breakerCounts.halfOpen + breakerCounts.degraded + breakerCounts.closed,
    },
    providerBreakers,
    providerHealth,
    connectionHealth,
    codexAccountPools,
    providerSummary: {
      catalogCount,
      configuredCount: configuredProviders.size,
      activeCount: activeProviders.size,
      monitoredCount: Object.keys(providerHealth).length,
    },
    localProviders,
    rateLimitStatus,
    learnedLimits,
    lockouts,
    quotaMonitor: {
      ...quotaMonitorSummary,
      monitors: limitMonitors(quotaMonitorMonitors),
    },
    sessions: buildSessionsSummary({ activeSessions, activeSessionsByKey }),
    credentialHealth, // may be undefined if credentialHealth module not loaded
    adaptiveAdmission: projectAdaptiveAdmissionSummary(adaptiveAdmission),
    // #11244: the STRUCTURAL gate (chatBodyAdmission.ts) next to the adaptive one —
    // distinct key so clients reading `adaptiveAdmission` are untouched.
    chatAdmission: projectChatAdmissionSummary(chatAdmission),
    // #12853: WAL maintenance next to the admission gates — additive key,
    // nothing existing moves.
    walMaintenance: projectWalMaintenanceSummary(walMaintenance),
    callLogArtifacts: projectCallLogArtifactWriterSummary(callLogArtifacts),
    dedup: {
      inflightRequests,
    },
    cryptography: {
      status:
        process.env.STORAGE_ENCRYPTION_KEY && process.env.STORAGE_ENCRYPTION_KEY.length >= 32
          ? "healthy"
          : "missing_or_invalid",
      provider: "aes-256-gcm",
    },
    setupComplete: settings?.setupComplete || false,
  };
}
