import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import {
  compactCallLogStreamChunkText,
  writeCallArtifact,
  type CallLogArtifact,
  type CallLogArtifactWriteResult,
} from "./callLogArtifacts.ts";
import { projectDiagnosticOverflowReference } from "./diagnosticOverflowTypes";

// Keep a high count ceiling for small artifacts emitted by large concurrent
// request bursts. The weighted footprint budget below is the memory bound.
const MAX_QUEUED_JOBS = 1024;
const MAX_QUEUED_DIAGNOSTIC_STUBS = 1024;
const MAX_QUEUED_DIAGNOSTIC_STUB_BYTES = 16 * 1024 * 1024;
// The estimate reserves for the retained source value, its worker clone, and
// worst-case JSON escaping while the active artifact is serialized. It is a
// peak-footprint budget for the active write plus all waiting writes.
const MAX_QUEUED_ARTIFACT_FOOTPRINT_BYTES = 128 * 1024 * 1024;
const MAX_ESTIMATED_VALUES = 100_000;
const MAX_ESTIMATED_OBJECTS = 50_000;
const MAX_ESTIMATOR_DEPTH = 64;
const IDLE_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 2_000;
const WARNING_INTERVAL_MS = 30_000;

type WorkerReply = {
  id: number;
  result: CallLogArtifactWriteResult | null;
  failureReason?: string;
};

type QueueItem = {
  id: number;
  artifact: CallLogArtifact | null;
  estimatedFootprintBytes: number;
  reservationClass: "normal" | "diagnostic_stub";
  preparationReservation?: CallLogArtifactReservation;
  reservationReleased: boolean;
  environment: {
    pipelineMaxSizeKb?: string;
    chatDebugFile?: string;
    appLogLevel?: string;
  };
  resolve: (result: CallLogArtifactWriteResult | null) => void;
};

let worker: Worker | null = null;
let active: QueueItem | null = null;
const queue: QueueItem[] = [];
const diagnosticStubQueue: QueueItem[] = [];
let nextId = 1;
let idleTimer: NodeJS.Timeout | null = null;
let closing = false;
let closeWaiters: Array<() => void> = [];
const lastWarningAt = new Map<string, number>();
let reservedArtifactFootprintBytes = 0;
let reservedDiagnosticStubBytes = 0;
let activeJobsHighWater = 0;
let queuedArtifactsHighWater = 0;
let queuedDiagnosticStubsHighWater = 0;
let reservedArtifactBytesHighWater = 0;
let reservedDiagnosticStubBytesHighWater = 0;
let preparationRefusalsTotal = 0;
let preparationRefusalsInvalidEstimateTotal = 0;
let preparationRefusalsSingleArtifactBudgetTotal = 0;
let preparationRefusalsAggregateReservationBudgetTotal = 0;
let detailOmissionsTotal = 0;
let workerFailuresTotal = 0;
let pointerFallbacksTotal = 0;
let pointerFallbackFailuresTotal = 0;
let diagnosticStubRefusalsTotal = 0;

function incrementCounter(value: number, amount = 1): number {
  if (!Number.isSafeInteger(amount) || amount <= 0) return value;
  return Math.min(Number.MAX_SAFE_INTEGER, value + amount);
}

function updateWriterHighWaterMarks(): void {
  activeJobsHighWater = Math.max(activeJobsHighWater, active ? 1 : 0);
  queuedArtifactsHighWater = Math.max(queuedArtifactsHighWater, queue.length);
  queuedDiagnosticStubsHighWater = Math.max(
    queuedDiagnosticStubsHighWater,
    diagnosticStubQueue.length
  );
  reservedArtifactBytesHighWater = Math.max(
    reservedArtifactBytesHighWater,
    reservedArtifactFootprintBytes
  );
  reservedDiagnosticStubBytesHighWater = Math.max(
    reservedDiagnosticStubBytesHighWater,
    reservedDiagnosticStubBytes
  );
}

type PreparationRefusalReason =
  "invalid_estimate" | "single_artifact_budget" | "aggregate_reservation_budget";

function notePreparationRefusal(reason: PreparationRefusalReason): void {
  preparationRefusalsTotal = incrementCounter(preparationRefusalsTotal);
  detailOmissionsTotal = incrementCounter(detailOmissionsTotal);
  if (reason === "invalid_estimate") {
    preparationRefusalsInvalidEstimateTotal = incrementCounter(
      preparationRefusalsInvalidEstimateTotal
    );
  } else if (reason === "single_artifact_budget") {
    preparationRefusalsSingleArtifactBudgetTotal = incrementCounter(
      preparationRefusalsSingleArtifactBudgetTotal
    );
  } else {
    preparationRefusalsAggregateReservationBudgetTotal = incrementCounter(
      preparationRefusalsAggregateReservationBudgetTotal
    );
  }
}

function notePointerFallbackFailure(refused = false): void {
  pointerFallbackFailuresTotal = incrementCounter(pointerFallbackFailuresTotal);
  if (refused) diagnosticStubRefusalsTotal = incrementCounter(diagnosticStubRefusalsTotal);
}

export type CallLogArtifactWriterSnapshot = Readonly<{
  /** The worker is serial, so this is always zero or one. */
  activeJobs: number;
  queuedArtifacts: number;
  queuedDiagnosticStubs: number;
  /** Includes pre-clone preparation reservations and active/queued writes. */
  reservedArtifactBytes: number;
  artifactFootprintLimitBytes: number;
  /** Separate bounded budget for pointer-only diagnostic artifacts. */
  reservedDiagnosticStubBytes: number;
  diagnosticStubFootprintLimitBytes: number;
  /** Process-lifetime maxima; payload contents and identifiers are never retained. */
  activeJobsHighWater: number;
  queuedArtifactsHighWater: number;
  queuedDiagnosticStubsHighWater: number;
  reservedArtifactBytesHighWater: number;
  reservedDiagnosticStubBytesHighWater: number;
  workerState: "not_started" | "idle" | "active" | "closing";
  preparationRefusalsTotal: number;
  preparationRefusalsInvalidEstimateTotal: number;
  preparationRefusalsSingleArtifactBudgetTotal: number;
  preparationRefusalsAggregateReservationBudgetTotal: number;
  detailOmissionsTotal: number;
  workerFailuresTotal: number;
  pointerFallbacksTotal: number;
  pointerFallbackFailuresTotal: number;
  diagnosticStubRefusalsTotal: number;
}>;

/**
 * Fixed-shape process-local counters for the authenticated health projection.
 * This reads only scalar queue state; it never traverses queued artifacts or
 * exposes request/provider identifiers, payloads, paths, or error strings.
 */
export function getCallLogArtifactWriterSnapshot(): CallLogArtifactWriterSnapshot {
  updateWriterHighWaterMarks();
  return {
    activeJobs: active ? 1 : 0,
    queuedArtifacts: queue.length,
    queuedDiagnosticStubs: diagnosticStubQueue.length,
    reservedArtifactBytes: reservedArtifactFootprintBytes,
    artifactFootprintLimitBytes: MAX_QUEUED_ARTIFACT_FOOTPRINT_BYTES,
    reservedDiagnosticStubBytes,
    diagnosticStubFootprintLimitBytes: MAX_QUEUED_DIAGNOSTIC_STUB_BYTES,
    activeJobsHighWater,
    queuedArtifactsHighWater,
    queuedDiagnosticStubsHighWater,
    reservedArtifactBytesHighWater,
    reservedDiagnosticStubBytesHighWater,
    workerState: closing ? "closing" : active ? "active" : worker ? "idle" : "not_started",
    preparationRefusalsTotal,
    preparationRefusalsInvalidEstimateTotal,
    preparationRefusalsSingleArtifactBudgetTotal,
    preparationRefusalsAggregateReservationBudgetTotal,
    detailOmissionsTotal,
    workerFailuresTotal,
    pointerFallbacksTotal,
    pointerFallbackFailuresTotal,
    diagnosticStubRefusalsTotal,
  };
}

function compactArtifactForFootprint(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  if (!source.pipeline || typeof source.pipeline !== "object" || Array.isArray(source.pipeline)) {
    return value;
  }
  const canCompactDuplicateBodies =
    typeof source.schemaVersion !== "number" || source.schemaVersion >= 6;

  const pipeline = { ...(source.pipeline as Record<string, unknown>) };
  let compacted = false;
  const canonicalBody = (names: readonly string[]) => {
    let canonicalName: string | null = null;
    let canonicalValue: unknown;
    for (const name of names) {
      const entry = pipeline[name];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      if (!Object.hasOwn(record, "body") || record.body === undefined) continue;
      if (canonicalName === null) {
        canonicalName = name;
        canonicalValue = record.body;
      } else if (record.body === canonicalValue) {
        pipeline[name] = {
          ...record,
          body: undefined,
          bodyRef: `pipeline.${canonicalName}.body`,
        };
        compacted = true;
      }
    }
    return canonicalName === null ? null : { name: canonicalName, value: canonicalValue };
  };

  const request = canCompactDuplicateBodies
    ? canonicalBody(["clientRawRequest", "openaiRequest", "providerRequest"])
    : null;
  const response = canCompactDuplicateBodies
    ? canonicalBody(["clientResponse", "providerResponse"])
    : null;
  const estimate: Record<string, unknown> = { ...source, pipeline };
  if (request && source.requestBody !== null && source.requestBody !== undefined) {
    if (source.requestBody === request.value) {
      estimate.requestBody = undefined;
      estimate.requestBodyRef = `pipeline.${request.name}.body`;
      compacted = true;
    }
  }
  if (response && source.responseBody !== null && source.responseBody !== undefined) {
    if (source.responseBody === response.value) {
      estimate.responseBody = undefined;
      estimate.responseBodyRef = `pipeline.${response.name}.body`;
      compacted = true;
    }
  }
  return compactCallLogStreamChunkText((compacted ? estimate : value) as CallLogArtifact);
}

export type CallLogArtifactReservation = { readonly estimatedBytes: number };
type ReservationState = {
  estimatedBytes: number;
  state: "reserved" | "transferred" | "released";
};
const reservationStates = new WeakMap<CallLogArtifactReservation, ReservationState>();

export type CallLogArtifactFootprintEstimate = {
  estimatedBytes: number;
  reason?:
    "budget_exceeded" | "value_limit" | "object_limit" | "depth_limit" | "cycle" | "unsupported";
};

function hasDynamicToJSON(value: object, prototype: object | null): boolean {
  const descriptors = [
    Object.getOwnPropertyDescriptor(value, "toJSON"),
    prototype ? Object.getOwnPropertyDescriptor(prototype, "toJSON") : undefined,
  ];
  return descriptors.some(
    (descriptor) =>
      descriptor !== undefined &&
      (!Object.prototype.hasOwnProperty.call(descriptor, "value") ||
        typeof descriptor.value === "function")
  );
}

/**
 * Estimate the temporary footprint of an artifact without serializing it.
 * String accounting allows ten bytes per UTF-16 code unit: source storage,
 * structured-clone storage, and up to six JSON bytes for escaped output.
 * Object/array overhead is deliberately rounded up. Cycles, accessors, and
 * unsupported values fail closed for detail capture; inference stays fail-open.
 */
export function estimateCallLogArtifactFootprint(value: unknown): CallLogArtifactFootprintEstimate {
  let estimatedBytes = 0;
  let valuesVisited = 0;
  let objectsVisited = 0;
  const ancestors = new WeakSet<object>();

  const add = (bytes: number): boolean => {
    if (!Number.isFinite(bytes) || bytes < 0) return false;
    estimatedBytes += bytes;
    return estimatedBytes <= MAX_QUEUED_ARTIFACT_FOOTPRINT_BYTES;
  };

  const visit = (current: unknown, depth: number): CallLogArtifactFootprintEstimate | null => {
    valuesVisited++;
    if (valuesVisited > MAX_ESTIMATED_VALUES) return { estimatedBytes, reason: "value_limit" };
    if (depth > MAX_ESTIMATOR_DEPTH) return { estimatedBytes, reason: "depth_limit" };

    if (current === null) return add(32) ? null : { estimatedBytes, reason: "budget_exceeded" };
    switch (typeof current) {
      case "string":
        return add(64 + current.length * 10) ? null : { estimatedBytes, reason: "budget_exceeded" };
      case "number":
      case "boolean":
        return add(64) ? null : { estimatedBytes, reason: "budget_exceeded" };
      case "undefined":
        return add(32) ? null : { estimatedBytes, reason: "budget_exceeded" };
      case "bigint":
      case "function":
      case "symbol":
        return { estimatedBytes, reason: "unsupported" };
      case "object":
        break;
      default:
        return { estimatedBytes, reason: "unsupported" };
    }

    const objectValue = current as object;
    if (ancestors.has(objectValue)) return { estimatedBytes, reason: "cycle" };
    objectsVisited++;
    if (objectsVisited > MAX_ESTIMATED_OBJECTS) return { estimatedBytes, reason: "object_limit" };

    try {
      if (Array.isArray(objectValue)) {
        const array = objectValue as unknown[];
        if (hasDynamicToJSON(objectValue, Array.prototype))
          return { estimatedBytes, reason: "unsupported" };
        if (!add(128 + array.length * 32)) return { estimatedBytes, reason: "budget_exceeded" };
        if (array.length > MAX_ESTIMATED_VALUES - valuesVisited)
          return { estimatedBytes, reason: "value_limit" };

        ancestors.add(objectValue);
        for (let index = 0; index < array.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(array, String(index));
          if (!descriptor) continue; // Sparse slots are covered by the array base estimate.
          if (!("value" in descriptor)) return { estimatedBytes, reason: "unsupported" };
          const nested = visit(descriptor.value, depth + 1);
          if (nested) return nested;
        }
        ancestors.delete(objectValue);
        return null;
      }

      const prototype = Object.getPrototypeOf(objectValue);
      if (prototype !== Object.prototype && prototype !== null)
        return { estimatedBytes, reason: "unsupported" };
      if (hasDynamicToJSON(objectValue, prototype))
        return { estimatedBytes, reason: "unsupported" };
      if (!add(128)) return { estimatedBytes, reason: "budget_exceeded" };

      ancestors.add(objectValue);
      for (const key in objectValue as Record<string, unknown>) {
        if (!Object.prototype.hasOwnProperty.call(objectValue, key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(objectValue, key);
        if (!descriptor?.enumerable) continue;
        if (!("value" in descriptor)) return { estimatedBytes, reason: "unsupported" };
        if (!add(64 + key.length * 10)) return { estimatedBytes, reason: "budget_exceeded" };
        const nested = visit(descriptor.value, depth + 1);
        if (nested) return nested;
      }
      ancestors.delete(objectValue);
      return null;
    } catch {
      return { estimatedBytes, reason: "unsupported" };
    }
  };

  const failure = visit(value, 0);
  if (failure) {
    return {
      estimatedBytes: Math.min(
        MAX_QUEUED_ARTIFACT_FOOTPRINT_BYTES + 1,
        Math.max(0, failure.estimatedBytes)
      ),
      reason: failure.reason,
    };
  }
  return { estimatedBytes };
}

/** Reserve before call-log payload protection clones the request/response. */
export function reserveCallLogArtifactPreparation(
  rawPayloads: unknown
): CallLogArtifactReservation | null {
  const estimate = estimateCallLogArtifactFootprint(compactArtifactForFootprint(rawPayloads));
  if (estimate.reason) {
    notePreparationRefusal("invalid_estimate");
    warnRateLimited(
      `[callLogs] Call-log detail preparation refused (reason=${estimate.reason}, estimateMiB=${(estimate.estimatedBytes / (1024 * 1024)).toFixed(1)}, reservedMiB=${(reservedArtifactFootprintBytes / (1024 * 1024)).toFixed(1)}).`,
      `preparation_refused:${estimate.reason}`
    );
    return null;
  }

  // The base estimate covers source, a worker clone, and JSON output. Double it
  // to cover the protection projection made before the artifact reaches worker
  // admission, plus a fixed envelope allowance for summary/pipeline metadata.
  const estimatedBytes = estimate.estimatedBytes * 2 + 64 * 1024;
  if (
    !Number.isSafeInteger(estimatedBytes) ||
    estimatedBytes > MAX_QUEUED_ARTIFACT_FOOTPRINT_BYTES ||
    reservedArtifactFootprintBytes + estimatedBytes > MAX_QUEUED_ARTIFACT_FOOTPRINT_BYTES
  ) {
    const reason =
      !Number.isSafeInteger(estimatedBytes) || estimatedBytes > MAX_QUEUED_ARTIFACT_FOOTPRINT_BYTES
        ? "single_artifact_budget"
        : "aggregate_reservation_budget";
    notePreparationRefusal(reason);
    warnRateLimited(
      `[callLogs] Call-log detail preparation refused (reason=${reason}, estimateMiB=${(estimatedBytes / (1024 * 1024)).toFixed(1)}, reservedMiB=${(reservedArtifactFootprintBytes / (1024 * 1024)).toFixed(1)}, capMiB=${(MAX_QUEUED_ARTIFACT_FOOTPRINT_BYTES / (1024 * 1024)).toFixed(0)}).`,
      `preparation_refused:${reason}`
    );
    return null;
  }

  const reservation: CallLogArtifactReservation = { estimatedBytes };
  reservationStates.set(reservation, { estimatedBytes, state: "reserved" });
  reservedArtifactFootprintBytes += estimatedBytes;
  updateWriterHighWaterMarks();
  return reservation;
}

export function releaseCallLogArtifactPreparation(
  reservation: CallLogArtifactReservation | null | undefined
): void {
  if (!reservation) return;
  const state = reservationStates.get(reservation);
  if (!state || state.state !== "reserved") return;
  state.state = "released";
  reservedArtifactFootprintBytes = Math.max(
    0,
    reservedArtifactFootprintBytes - state.estimatedBytes
  );
}

function releaseReservation(item: QueueItem): void {
  if (item.reservationReleased) return;
  item.reservationReleased = true;
  if (item.preparationReservation) {
    const state = reservationStates.get(item.preparationReservation);
    if (state && state.state !== "released") {
      state.state = "released";
      reservedArtifactFootprintBytes = Math.max(
        0,
        reservedArtifactFootprintBytes - state.estimatedBytes
      );
    }
    return;
  }
  if (item.reservationClass === "diagnostic_stub") {
    reservedDiagnosticStubBytes = Math.max(
      0,
      reservedDiagnosticStubBytes - item.estimatedFootprintBytes
    );
  } else {
    reservedArtifactFootprintBytes = Math.max(
      0,
      reservedArtifactFootprintBytes - item.estimatedFootprintBytes
    );
  }
}

function safeSummaryLabel(value: string | null, fallback = "-", maxLength = 256): string {
  if (typeof value !== "string") return fallback;
  const safe = value
    .slice(0, maxLength)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim();
  return safe || fallback;
}

function safeRequestPath(value: string): string {
  const bounded = value.slice(0, 513);
  const delimiter = bounded.search(/[?#]/);
  const pathOnly = (delimiter < 0 ? bounded.slice(0, 512) : bounded.slice(0, delimiter)).trim();
  if (!pathOnly.startsWith("/") || /[\u0000-\u001f\u007f]/.test(pathOnly)) return "/[redacted]";
  return pathOnly.slice(0, 512);
}

function safeCorrelationId(value: string | null | undefined): string | null {
  return typeof value === "string" && value.length <= 256 && /^[A-Za-z0-9._:-]+$/.test(value)
    ? value
    : null;
}

function buildDiagnosticOverflowStub(
  summary: CallLogArtifact["summary"],
  rawReference: unknown,
  reason:
    | "call_log_artifact_queue_memory_budget_exceeded"
    | "call_log_artifact_worker_missing"
    | "call_log_artifact_worker_failure" = "call_log_artifact_queue_memory_budget_exceeded"
): CallLogArtifact | null {
  const reference = projectDiagnosticOverflowReference(rawReference);
  if (!reference || reference.persisted === false) return null;
  const omissionMarker =
    reason === "call_log_artifact_queue_memory_budget_exceeded"
      ? "[omitted: artifact queue memory budget exceeded]"
      : reason === "call_log_artifact_worker_missing"
        ? "[omitted: call log artifact worker unavailable]"
        : "[omitted: call log artifact worker failed]";

  return {
    schemaVersion: 5,
    summary: {
      id: safeSummaryLabel(summary.id, "unknown", 128),
      timestamp: safeSummaryLabel(summary.timestamp, "unknown", 64),
      method: safeSummaryLabel(summary.method, "POST", 16).toUpperCase(),
      path: safeRequestPath(summary.path),
      model: safeSummaryLabel(summary.model),
      requestedModel:
        summary.requestedModel === null ? null : safeSummaryLabel(summary.requestedModel),
      provider: safeSummaryLabel(summary.provider),
      status: Number.isSafeInteger(summary.status) ? summary.status : 0,
      duration: Number.isFinite(summary.duration) && summary.duration >= 0 ? summary.duration : 0,
      requestType:
        summary.requestType === null ? null : safeSummaryLabel(summary.requestType, "unknown", 64),
      sourceFormat:
        summary.sourceFormat === null
          ? null
          : safeSummaryLabel(summary.sourceFormat, "unknown", 64),
      targetFormat:
        summary.targetFormat === null
          ? null
          : safeSummaryLabel(summary.targetFormat, "unknown", 64),
      account: "-",
      connectionId: null,
      apiKeyId: null,
      apiKeyName: null,
      correlationId: safeCorrelationId(summary.correlationId),
      tokens: {
        in: Number.isFinite(summary.tokens.in) && summary.tokens.in >= 0 ? summary.tokens.in : 0,
        out:
          Number.isFinite(summary.tokens.out) && summary.tokens.out >= 0 ? summary.tokens.out : 0,
        cacheRead:
          summary.tokens.cacheRead === null ||
          (Number.isFinite(summary.tokens.cacheRead) && summary.tokens.cacheRead >= 0)
            ? summary.tokens.cacheRead
            : null,
        cacheWrite:
          summary.tokens.cacheWrite === null ||
          (Number.isFinite(summary.tokens.cacheWrite) && summary.tokens.cacheWrite >= 0)
            ? summary.tokens.cacheWrite
            : null,
        reasoning:
          summary.tokens.reasoning === null ||
          (Number.isFinite(summary.tokens.reasoning) && summary.tokens.reasoning >= 0)
            ? summary.tokens.reasoning
            : null,
        compressed:
          summary.tokens.compressed === null ||
          (Number.isFinite(summary.tokens.compressed) && summary.tokens.compressed >= 0)
            ? summary.tokens.compressed
            : null,
      },
      comboName: null,
      comboStepId: null,
      comboExecutionKey: null,
    },
    requestBody: omissionMarker,
    responseBody: omissionMarker,
    error: "Detailed call-log payload omitted; private diagnostic capture is available.",
    pipeline: {
      error: {
        _omniroute_truncated: true,
        reason,
      },
      diagnosticOverflow: reference,
    },
  };
}

function enqueueArtifact(
  artifact: CallLogArtifact,
  estimatedFootprintBytes: number,
  reservationClass: QueueItem["reservationClass"],
  preparationReservation?: CallLogArtifactReservation
): Promise<CallLogArtifactWriteResult | null> {
  const state = preparationReservation ? reservationStates.get(preparationReservation) : undefined;
  if (preparationReservation && (!state || state.state !== "reserved"))
    return Promise.resolve(null);

  const reservedBytes = state?.estimatedBytes ?? estimatedFootprintBytes;
  if (state) state.state = "transferred";

  return new Promise((resolve) => {
    const item: QueueItem = {
      id: nextId++,
      artifact,
      estimatedFootprintBytes: reservedBytes,
      reservationClass,
      ...(preparationReservation ? { preparationReservation } : {}),
      reservationReleased: false,
      environment: {
        pipelineMaxSizeKb: process.env.CALL_LOG_PIPELINE_MAX_SIZE_KB,
        chatDebugFile: process.env.CHAT_DEBUG_FILE,
        appLogLevel: process.env.APP_LOG_LEVEL,
      },
      resolve,
    };

    if (reservationClass === "diagnostic_stub") {
      reservedDiagnosticStubBytes += reservedBytes;
      diagnosticStubQueue.push(item);
    } else if (!preparationReservation) {
      reservedArtifactFootprintBytes += reservedBytes;
      queue.push(item);
    } else {
      queue.push(item);
    }
    updateWriterHighWaterMarks();
    pump();
  });
}

function enqueueDiagnosticOverflowStub(
  summary: CallLogArtifact["summary"],
  reference: unknown
): Promise<CallLogArtifactWriteResult | null> | null {
  const stub = buildDiagnosticOverflowStub(summary, reference);
  if (!stub) {
    notePointerFallbackFailure(true);
    return null;
  }

  const estimate = estimateCallLogArtifactFootprint(stub);
  if (
    estimate.reason ||
    diagnosticStubQueue.length >= MAX_QUEUED_DIAGNOSTIC_STUBS ||
    reservedDiagnosticStubBytes + estimate.estimatedBytes > MAX_QUEUED_DIAGNOSTIC_STUB_BYTES
  ) {
    notePointerFallbackFailure(true);
    return null;
  }

  warnRateLimited(
    "[callLogs] Full call-log artifact omitted; preserving private diagnostic reference only."
  );
  return enqueueArtifact(stub, estimate.estimatedBytes, "diagnostic_stub").then((result) => {
    if (result) pointerFallbacksTotal = incrementCounter(pointerFallbacksTotal);
    else pointerFallbackFailuresTotal = incrementCounter(pointerFallbackFailuresTotal);
    return result;
  });
}

export function writeDiagnosticOverflowStubAsync(
  summary: CallLogArtifact["summary"],
  reference: unknown
): Promise<CallLogArtifactWriteResult | null> {
  if (closing) {
    notePointerFallbackFailure(true);
    return Promise.resolve(null);
  }
  const queued = enqueueDiagnosticOverflowStub(summary, reference);
  return queued ?? Promise.resolve(null);
}

/**
 * A missing worker means the normal detail artifact cannot be written, but a
 * persisted private-overflow reference is still valuable. Write only its tiny,
 * sanitized pointer artifact synchronously; never traverse or serialize the
 * large request/response payload that the worker would have handled.
 */
function writeDiagnosticOverflowStubSyncInternal(
  summary: CallLogArtifact["summary"],
  reference: unknown,
  reason: "call_log_artifact_worker_missing" | "call_log_artifact_worker_failure",
  countFallbackMetrics: boolean
): CallLogArtifactWriteResult | null {
  const stub = buildDiagnosticOverflowStub(summary, reference, reason);
  if (!stub) {
    if (countFallbackMetrics) notePointerFallbackFailure(true);
    return null;
  }

  const estimate = estimateCallLogArtifactFootprint(stub);
  const activeStubCount = active?.reservationClass === "diagnostic_stub" ? 1 : 0;
  if (
    estimate.reason ||
    diagnosticStubQueue.length + activeStubCount >= MAX_QUEUED_DIAGNOSTIC_STUBS ||
    reservedDiagnosticStubBytes + estimate.estimatedBytes > MAX_QUEUED_DIAGNOSTIC_STUB_BYTES
  ) {
    if (countFallbackMetrics) notePointerFallbackFailure(true);
    warnRateLimited(
      `[callLogs] Private diagnostic pointer stub refused (reason=stub_budget, source=${reason}).`,
      `sync_diagnostic_stub_refused:${reason}`
    );
    return null;
  }

  reservedDiagnosticStubBytes += estimate.estimatedBytes;
  try {
    const result = writeCallArtifact(stub);
    if (!result) {
      if (countFallbackMetrics) notePointerFallbackFailure();
      warnRateLimited(
        `[callLogs] Private diagnostic pointer stub was not persisted (reason=write_failed, source=${reason}).`,
        `sync_diagnostic_stub_write_failed:${reason}`
      );
      return null;
    }
    if (countFallbackMetrics) pointerFallbacksTotal = incrementCounter(pointerFallbacksTotal);
    warnRateLimited(
      reason === "call_log_artifact_worker_missing"
        ? "[callLogs] Artifact worker is missing; synchronously preserved the private diagnostic reference."
        : "[callLogs] Artifact worker write failed; synchronously preserved the private diagnostic reference.",
      `sync_diagnostic_stub:${reason}`
    );
    return { ...result, diagnosticOverflowStub: true };
  } finally {
    reservedDiagnosticStubBytes = Math.max(
      0,
      reservedDiagnosticStubBytes - estimate.estimatedBytes
    );
  }
}

export function writeDiagnosticOverflowStubSync(
  summary: CallLogArtifact["summary"],
  reference: unknown,
  reason:
    | "call_log_artifact_worker_missing"
    | "call_log_artifact_worker_failure" = "call_log_artifact_worker_missing"
): CallLogArtifactWriteResult | null {
  return writeDiagnosticOverflowStubSyncInternal(summary, reference, reason, true);
}

function fileExistsAtRuntime(candidate: string): boolean {
  // The worker is copied explicitly by the standalone/npm packaging policies.
  // Keep this runtime probe opaque to Next's build tracer so it does not expand
  // a variable filesystem expression into a repository-wide glob.
  return Reflect.apply(fs.existsSync, fs, [candidate]) as boolean;
}

export type WorkerResolutionContext = {
  moduleDir?: string;
  cwd?: string;
  entryFile?: string | null;
  fileExists?: (candidate: string) => boolean;
};

type ResolvedArtifactWorker = { workerFile: string; execArgv: string[] };
let defaultArtifactWorkerResolution: ResolvedArtifactWorker | null = null;

function resolveDefaultArtifactWorker(): ResolvedArtifactWorker {
  if (!defaultArtifactWorkerResolution) {
    defaultArtifactWorkerResolution = resolveCallLogArtifactWorker();
  }
  return defaultArtifactWorkerResolution;
}

export function resolveCallLogArtifactWorker(context: WorkerResolutionContext = {}): {
  workerFile: string;
  execArgv: string[];
} {
  const moduleDir = context.moduleDir ?? path.dirname(fileURLToPath(import.meta.url));
  const cwd = context.cwd ?? process.cwd();
  const entryFile = context.entryFile === undefined ? process.argv[1] : context.entryFile;
  const exists = context.fileExists ?? fileExistsAtRuntime;

  const moduleJs = path.join(moduleDir, "callLogArtifactWorker.js");
  if (exists(moduleJs)) return { workerFile: moduleJs, execArgv: [] };

  const entryJs = entryFile
    ? path.join(path.dirname(path.resolve(entryFile)), "src/lib/usage/callLogArtifactWorker.js")
    : null;
  if (entryJs && exists(entryJs)) return { workerFile: entryJs, execArgv: [] };

  const cwdJs = path.resolve(cwd, "src/lib/usage/callLogArtifactWorker.js");
  if (exists(cwdJs)) return { workerFile: cwdJs, execArgv: [] };

  const moduleTs = path.join(moduleDir, "callLogArtifactWorker.ts");
  if (exists(moduleTs)) {
    return { workerFile: moduleTs, execArgv: ["--import", "tsx/esm"] };
  }

  const cwdTs = path.resolve(cwd, "src/lib/usage/callLogArtifactWorker.ts");
  if (exists(cwdTs)) {
    return { workerFile: cwdTs, execArgv: ["--import", "tsx/esm"] };
  }

  return { workerFile: entryJs ?? cwdJs, execArgv: [] };
}

/**
 * Probe the selected worker path before retaining/protecting large request bodies.
 * When an image omitted this runtime-resolved file, detail capture cannot succeed;
 * callers can still persist the small summary row without spending memory on a
 * payload that the worker cannot write.
 */
export function isCallLogArtifactWorkerAvailable(context?: WorkerResolutionContext): boolean {
  const resolution = context
    ? resolveCallLogArtifactWorker(context)
    : resolveDefaultArtifactWorker();
  const exists = context?.fileExists ?? fileExistsAtRuntime;
  const available = exists(resolution.workerFile);
  if (!context && !available) {
    detailOmissionsTotal = incrementCounter(detailOmissionsTotal);
    warnRateLimited(
      "[callLogs] Call-log artifact worker is missing; detail payload capture will be skipped.",
      "worker_file_missing"
    );
  }
  return available;
}

function clearIdleTimer(): void {
  if (!idleTimer) return;
  clearTimeout(idleTimer);
  idleTimer = null;
}

function terminateWorker(): void {
  const current = worker;
  worker = null;
  clearIdleTimer();
  if (current) void current.terminate().catch(() => {});
}

function notifyCloseWaiters(): void {
  if (active || queue.length > 0 || diagnosticStubQueue.length > 0) return;
  const waiters = closeWaiters;
  closeWaiters = [];
  for (const resolve of waiters) resolve();
}

function scheduleIdleTermination(): void {
  clearIdleTimer();
  if (!worker || active || queue.length > 0 || diagnosticStubQueue.length > 0) return;
  idleTimer = setTimeout(terminateWorker, IDLE_TIMEOUT_MS);
  idleTimer.unref?.();
}

function warnRateLimited(message: string, key = message): void {
  const now = Date.now();
  if (now - (lastWarningAt.get(key) ?? 0) < WARNING_INTERVAL_MS) return;
  lastWarningAt.set(key, now);
  console.warn(message);
}

function safeWorkerFailureReason(error: unknown): string {
  if (!error || typeof error !== "object") return "worker_error";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Z0-9_]{2,64}$/.test(code) ? code : "worker_error";
}

function takeDiagnosticStubInputs(item: QueueItem): {
  summary: CallLogArtifact["summary"];
  reference: unknown;
} | null {
  const artifact = item.artifact;
  if (!artifact) return null;
  const inputs = {
    summary: artifact.summary,
    reference: artifact.pipeline?.diagnosticOverflow,
  };
  item.artifact = null;
  return inputs;
}

function failOpen(warn = false, reason = "worker_error"): void {
  const failedNormalJobs = (active?.reservationClass === "normal" ? 1 : 0) + queue.length;
  const failedJobs = (active ? 1 : 0) + queue.length + diagnosticStubQueue.length;
  if (warn) {
    workerFailuresTotal = incrementCounter(workerFailuresTotal, failedJobs);
    warnRateLimited(
      `[callLogs] Call-log artifact worker failed (reason=${reason}); detail omitted.`,
      `worker_failure:${reason}`
    );
  }
  const failed = active
    ? [active, ...queue, ...diagnosticStubQueue]
    : [...queue, ...diagnosticStubQueue];
  detailOmissionsTotal = incrementCounter(detailOmissionsTotal, failedNormalJobs);
  active = null;
  queue.length = 0;
  diagnosticStubQueue.length = 0;
  for (const item of failed) releaseReservation(item);
  terminateWorker();
  for (const item of failed) item.resolve(null);
  notifyCloseWaiters();
}

function ensureWorker(): Worker {
  if (worker) return worker;

  const { workerFile, execArgv } = resolveDefaultArtifactWorker();
  // Reflect.construct keeps Next/Turbopack from interpreting the runtime-selected
  // worker path as a build-time glob and tracing tens of thousands of unrelated files.
  const created = Reflect.construct(Worker, [pathToFileURL(workerFile), { execArgv }]) as Worker;
  worker = created;
  created.on("message", (reply: WorkerReply) => {
    if (!active || reply.id !== active.id) return;
    const completed = active;
    active = null;
    releaseReservation(completed);
    let result = reply.result;
    if (!reply.result) {
      const reason = reply.failureReason ?? "no_result";
      if (reason !== "build_phase" && reason !== "storage_unavailable") {
        workerFailuresTotal = incrementCounter(workerFailuresTotal);
      }
      if (completed.reservationClass === "normal") {
        detailOmissionsTotal = incrementCounter(detailOmissionsTotal);
      }
      warnRateLimited(
        `[callLogs] Call-log artifact worker returned no stored artifact (reason=${reason}).`,
        `write_no_result:${reason}`
      );
      const stubInputs = takeDiagnosticStubInputs(completed);
      if (stubInputs && (reason === "write_failed" || reason === "worker_exception")) {
        try {
          result = writeDiagnosticOverflowStubSyncInternal(
            stubInputs.summary,
            stubInputs.reference,
            "call_log_artifact_worker_failure",
            false
          );
          if (completed.reservationClass === "normal") {
            if (result) pointerFallbacksTotal = incrementCounter(pointerFallbacksTotal);
            else pointerFallbackFailuresTotal = incrementCounter(pointerFallbackFailuresTotal);
          }
        } catch {
          result = null;
          if (completed.reservationClass === "normal") {
            pointerFallbackFailuresTotal = incrementCounter(pointerFallbackFailuresTotal);
          }
          warnRateLimited(
            "[callLogs] Private diagnostic pointer fallback threw (reason=stub_write_exception).",
            "sync_diagnostic_stub_write_exception"
          );
        }
      }
    }
    completed.resolve(
      result && completed.reservationClass === "diagnostic_stub" && !result.diagnosticOverflowStub
        ? { ...result, diagnosticOverflowStub: true }
        : result
    );
    pump();
  });
  created.on("error", (error) => failOpen(true, safeWorkerFailureReason(error)));
  created.on("messageerror", () => failOpen(true, "worker_message_error"));
  created.on("exit", (code) => {
    if (worker !== created) return;
    worker = null;
    if (code !== 0 || active) failOpen(true, code === 0 ? "worker_unexpected_exit" : "worker_exit");
  });
  return created;
}

function pump(): void {
  if (active) return;
  const next = diagnosticStubQueue.shift() ?? queue.shift();
  if (!next) {
    notifyCloseWaiters();
    scheduleIdleTermination();
    return;
  }

  active = next;
  updateWriterHighWaterMarks();
  clearIdleTimer();
  if (!next.artifact) {
    failOpen(true, "queued_artifact_missing");
    return;
  }
  try {
    ensureWorker().postMessage({
      id: next.id,
      artifact: next.artifact,
      environment: next.environment,
    });
  } catch (error) {
    failOpen(true, safeWorkerFailureReason(error));
  }
}

export function writeCallArtifactAsync(
  artifact: CallLogArtifact,
  preparationReservation?: CallLogArtifactReservation | null
): Promise<CallLogArtifactWriteResult | null> {
  if (closing) {
    detailOmissionsTotal = incrementCounter(detailOmissionsTotal);
    releaseCallLogArtifactPreparation(preparationReservation);
    warnRateLimited("[callLogs] Call-log artifact queue unavailable; detail omitted.");
    return Promise.resolve(null);
  }

  if (queue.length >= MAX_QUEUED_JOBS) {
    detailOmissionsTotal = incrementCounter(detailOmissionsTotal);
    releaseCallLogArtifactPreparation(preparationReservation);
    const stub = enqueueDiagnosticOverflowStub(
      artifact.summary,
      artifact.pipeline?.diagnosticOverflow
    );
    if (stub) return stub;
    warnRateLimited("[callLogs] Call-log artifact queue unavailable; detail omitted.");
    return Promise.resolve(null);
  }

  const estimate = estimateCallLogArtifactFootprint(compactArtifactForFootprint(artifact));
  const reservationState = preparationReservation
    ? reservationStates.get(preparationReservation)
    : undefined;
  if (preparationReservation && (!reservationState || reservationState.state !== "reserved")) {
    detailOmissionsTotal = incrementCounter(detailOmissionsTotal);
    warnRateLimited(
      "[callLogs] Call-log artifact preparation reservation is unavailable; detail omitted."
    );
    return Promise.resolve(null);
  }
  if (
    estimate.reason ||
    estimate.estimatedBytes > MAX_QUEUED_ARTIFACT_FOOTPRINT_BYTES ||
    (preparationReservation
      ? estimate.estimatedBytes > (reservationState?.estimatedBytes ?? 0)
      : reservedArtifactFootprintBytes + estimate.estimatedBytes >
        MAX_QUEUED_ARTIFACT_FOOTPRINT_BYTES)
  ) {
    detailOmissionsTotal = incrementCounter(detailOmissionsTotal);
    releaseCallLogArtifactPreparation(preparationReservation);
    const stub = enqueueDiagnosticOverflowStub(
      artifact.summary,
      artifact.pipeline?.diagnosticOverflow
    );
    if (stub) return stub;
    warnRateLimited("[callLogs] Call-log artifact memory budget exceeded; detail omitted.");
    return Promise.resolve(null);
  }

  return enqueueArtifact(
    artifact,
    reservationState?.estimatedBytes ?? estimate.estimatedBytes,
    "normal",
    preparationReservation ?? undefined
  );
}

export async function closeCallLogArtifactWriter(timeoutMs = CLOSE_TIMEOUT_MS): Promise<void> {
  closing = true;
  if (!active && queue.length === 0 && diagnosticStubQueue.length === 0) {
    terminateWorker();
    return;
  }

  if (timeoutMs <= 0) {
    failOpen();
    terminateWorker();
    return;
  }

  let timeout: NodeJS.Timeout | undefined;
  await Promise.race([
    new Promise<void>((resolve) => closeWaiters.push(resolve)),
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, timeoutMs);
      timeout.unref?.();
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  if (active || queue.length > 0 || diagnosticStubQueue.length > 0) failOpen();
  terminateWorker();
}
