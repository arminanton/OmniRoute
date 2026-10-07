import {
  createDiagnosticOverflowTrace,
  type DiagnosticOverflowTrace,
  type DiagnosticOverflowReference,
  projectDiagnosticOverflowReference,
} from "@/lib/usage/diagnosticOverflow";
import { registerDiagnosticTrace } from "./diagnosticCaptureContext.ts";
import { getRequestTransportTelemetry } from "./transportTelemetry.ts";
import { classifyUpstreamPolicyRejection } from "../services/upstreamPolicyRejection.ts";
import { getPendingById } from "@/lib/usage/usageHistory";
import {
  getChatLogMaxDepth,
  getChatLogArrayTailItems,
  getChatLogTextLimit,
  getChatLogClientTextLimit,
  getChatLogMaxObjectKeys,
} from "@/lib/logEnv";
import { sanitizeErrorMessage } from "./error.ts";

type JsonRecord = Record<string, unknown>;

type HeaderInput =
  | Headers
  | Record<string, unknown>
  | { entries?: () => IterableIterator<[string, string]> }
  | null
  | undefined;

export type RequestPipelinePayloads = {
  diagnosticOverflow?: DiagnosticOverflowReference;
  transportTelemetry?: JsonRecord;
  routeDecision?: JsonRecord;
  clientRawRequest?: JsonRecord;
  openaiRequest?: JsonRecord;
  providerRequest?: JsonRecord;
  providerResponse?: JsonRecord;
  clientResponse?: JsonRecord;
  error?: JsonRecord;
  toolLoop?: { legs: JsonRecord[] };
  streamChunks?: {
    provider?: string[];
    openai?: string[];
    client?: string[];
  };
};

type RequestLogger = {
  getDiagnosticOverflowTrace: () => DiagnosticOverflowTrace | null;
  sessionPath: null;
  logClientRawRequest: (
    endpoint: unknown,
    body: unknown,
    headers?: HeaderInput,
    effectiveInput?: unknown
  ) => void;
  logRouteDecision: (decision: unknown) => void;
  logOpenAIRequest: (body: unknown) => void;
  logTargetRequest: (url: unknown, headers: HeaderInput, body: unknown) => void;
  logProviderResponse: (
    status: unknown,
    statusText: unknown,
    headers: HeaderInput,
    body: unknown
  ) => void;
  appendProviderChunk: (chunk: string) => void;
  appendOpenAIChunk: (chunk: string) => void;
  logConvertedResponse: (body: unknown) => void;
  appendConvertedChunk: (chunk: string) => void;
  logError: (error: unknown, requestBody?: unknown) => void;
  logToolLoopReceipt: (receipt: unknown) => void;
  getPipelinePayloads: () => RequestPipelinePayloads | null;
};

type RequestLoggerOptions = {
  diagnosticOverflowEligible?: boolean;
  diagnosticClientJson?: () => string | undefined;
  releaseDiagnosticClientJson?: () => void;
  diagnosticSignal?: AbortSignal | null;
  enabled?: boolean;
  captureStreamChunks?: boolean;
  maxStreamChunkBytes?: number;
  maxStreamChunkItems?: number;
  requestId?: string | null;
  model?: string;
  provider?: string;
  connectionId?: string | null;
};

const DEFAULT_MAX_STREAM_CHUNK_BYTES = 512 * 1024;
const MAX_MAX_STREAM_CHUNK_BYTES = 1024 * 1024;
const MIN_MAX_STREAM_CHUNK_BYTES = 256;
const DEFAULT_MAX_STREAM_CHUNK_ITEMS = 1024;
const MAX_STREAM_CHUNK_ITEM_BYTES = 64;
const STREAM_CHUNK_TRUNCATION_MARKER =
  "[stream chunk log truncated: aggregate capture budget reached]";
// Was its own separate hardcoded 24, independent of the sibling
// cloneBoundedChatLogPayload (chatCore/logTruncation.ts) implementation's
// configurable cap — the two duplicated the same "bound an array for
// logging" policy with different, drifting limits. Sharing
// getChatLogArrayTailItems() keeps both bounding passes over the same
// artifact data consistent. Read once at module load, matching this file's
// existing plain-constant shape; CHAT_LOG_ARRAY_TAIL_ITEMS still overrides it.
export const MAX_LOG_ARRAY_ITEMS = getChatLogArrayTailItems();
const MAX_TOOL_LOOP_LEGS = 4;

function maskSensitiveHeaders(headers: HeaderInput): Record<string, unknown> {
  if (!headers) return {};

  const headerEntries =
    typeof (headers as Headers).entries === "function"
      ? Object.fromEntries((headers as Headers).entries())
      : { ...(headers as Record<string, unknown>) };

  const masked = { ...headerEntries };
  const sensitiveKeys = [
    "authorization",
    "x-api-key",
    "cookie",
    "token",
    "runtimekey",
    "storage-state",
    "storagestate",
    "capability",
    "x-omniroute-lease-owner",
  ];

  for (const key of Object.keys(masked)) {
    const lowerKey = key.toLowerCase();
    // Whitelist x-ratelimit- headers from redaction
    if (lowerKey.startsWith("x-ratelimit-")) {
      continue;
    }
    if (lowerKey === "x-omniroute-lease-owner" || lowerKey === "x-omniroute-self-hop") {
      masked[key] = "[REDACTED]";
      continue;
    }
    if (!sensitiveKeys.some((candidate) => lowerKey.includes(candidate))) {
      continue;
    }

    const value = masked[key];
    if (typeof value === "string" && value.length > 20) {
      masked[key] = `${value.slice(0, 10)}...${value.slice(-5)}`;
    } else if (value) {
      masked[key] = "[REDACTED]";
    }
  }

  return masked;
}

function createEmptyStreamChunks() {
  return {
    provider: [] as string[],
    openai: [] as string[],
    client: [] as string[],
  };
}

const TRUNCATED_ARRAY_MARKER = "_omniroute_truncated_array";
const TRUNCATED_KEYS_MARKER = "_omniroute_truncated_keys";

function isTruncatedArrayMarker(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as JsonRecord)[TRUNCATED_ARRAY_MARKER] === true
  );
}

function truncateLogString(value: string, maxLength = getChatLogTextLimit()): string {
  if (value.length <= maxLength) return value;
  // The marker has to fit INSIDE the budget (#7847): keeping maxLength characters and then
  // adding the marker produced a result longer than maxLength, so re-bounding an already
  // bounded string truncated it a second time and the function was not idempotent.
  const marker = `\n[...truncated ${value.length - maxLength} chars...]\n`;
  if (marker.length >= maxLength) return marker.slice(0, maxLength);
  const keep = Math.max(0, maxLength - marker.length);
  const preview = `${value.slice(0, Math.floor(keep / 2))}${marker}${value.slice(-Math.ceil(keep / 2))}`;
  // Detach the preview: V8 slice/cons strings can otherwise keep the large
  // original request string alive while this bounded artifact is queued.
  return Buffer.from(preview, "utf16le").toString("utf16le");
}

/**
 * Recursively clone `value` for logging, with size bounds applied:
 * - Arrays longer than MAX_LOG_ARRAY_ITEMS are truncated to the tail with a
 *   sentinel marker prepended.
 * - The `tools` field is exempt from array truncation: the full tool inventory
 *   is debug-critical for understanding which tools the model had access to,
 *   and individual tool descriptions are independently bounded by
 *   truncateLogString, so the total size remains naturally capped.
 *
 * The optional `key` parameter carries the parent object's field name when
 * recursing into an object's values, enabling the per-field exemption above.
 * Top-level arrays (no key context) remain subject to truncation.
 */
export function cloneBoundedForLog(
  value: unknown,
  depth = 0,
  key: string | null = null,
  maxTextLength = getChatLogTextLimit()
): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return truncateLogString(value, maxTextLength);
  if (typeof value !== "object") return value;
  // Binary/opaque byte views (Uint8Array, Buffer, DataView, ...) are not
  // "real" arrays to Array.isArray(); without this guard they fall through
  // to the generic-object branch below and get expanded into one JS key per
  // decoded byte instead of being treated as an opaque buffer (see #7297).
  if (ArrayBuffer.isView(value)) {
    return `[binary ${(value as ArrayBufferView).byteLength} bytes]`;
  }
  if (depth >= getChatLogMaxDepth()) return "[MaxDepth]";

  if (Array.isArray(value)) {
    // Idempotence (#7847): an already-bounded array is [marker, ...tail] — MAX_LOG_ARRAY_ITEMS + 1
    // entries, which is over the limit. Re-truncating it would drop the marker plus one real
    // item and rewrite originalLength with the truncated length (25 instead of the true 800), so
    // the log would misreport how much was cut. Keep the original marker, re-bound only the tail.
    if (isTruncatedArrayMarker(value[0])) {
      return [
        value[0],
        ...value.slice(1).map((item) => cloneBoundedForLog(item, depth + 1, null, maxTextLength)),
      ];
    }
    const exempt = key === "tools";
    const shouldTruncate = !exempt && value.length > MAX_LOG_ARRAY_ITEMS;
    const source = shouldTruncate ? value.slice(-MAX_LOG_ARRAY_ITEMS) : value;
    const mapped = source.map((item) => cloneBoundedForLog(item, depth + 1, null, maxTextLength));
    if (shouldTruncate) {
      return [
        {
          [TRUNCATED_ARRAY_MARKER]: true,
          originalLength: value.length,
          retainedTailItems: MAX_LOG_ARRAY_ITEMS,
        },
        ...mapped,
      ];
    }
    return mapped;
  }

  const result: JsonRecord = {};
  // Idempotence (#7847): our own marker key must not be counted as payload, or a re-bounded
  // object would push a real key out to make room for it and report `1` dropped instead of 20.
  const carriedDropped = (value as JsonRecord)[TRUNCATED_KEYS_MARKER];
  const carried = typeof carriedDropped === "number" ? carriedDropped : 0;
  const entries = Object.entries(value as JsonRecord).filter(
    ([k]) => !(carried > 0 && k === TRUNCATED_KEYS_MARKER)
  );
  const maxKeys = getChatLogMaxObjectKeys();
  for (const [k, item] of maxKeys > 0 ? entries.slice(0, maxKeys) : entries) {
    result[k] = cloneBoundedForLog(item, depth + 1, k, maxTextLength);
  }
  const dropped = (maxKeys > 0 ? Math.max(0, entries.length - maxKeys) : 0) + carried;
  if (dropped > 0) {
    result[TRUNCATED_KEYS_MARKER] = dropped;
  }
  return result;
}

type AggregateStreamChunkBudget = {
  value: number;
  itemCount: number;
  truncated: boolean;
};

/**
 * Bound retained text by the larger of its UTF-16 backing store and UTF-8
 * serialized form. Counting only JS characters undercounts non-ASCII JSON;
 * counting only UTF-8 undercounts V8's two-byte string representation for
 * ASCII. The fixed allowance covers the string object and array slot.
 */
function estimateRetainedChunkBytes(value: string): number {
  return Math.max(value.length * 2, Buffer.byteLength(value, "utf8")) + MAX_STREAM_CHUNK_ITEM_BYTES;
}

function safePrefixLength(value: string, maxCodeUnits: number): number {
  let length = Math.min(value.length, Math.max(0, maxCodeUnits));
  // Keep a UTF-16 surrogate pair together so the captured excerpt remains valid.
  if (
    length > 0 &&
    length < value.length &&
    value.charCodeAt(length - 1) >= 0xd800 &&
    value.charCodeAt(length - 1) <= 0xdbff &&
    value.charCodeAt(length) >= 0xdc00 &&
    value.charCodeAt(length) <= 0xdfff
  ) {
    length--;
  }
  return length;
}

function copyUtf16(value: string): string {
  // A substring may keep a much larger upstream chunk alive in V8. Round-trip
  // through UTF-16LE to retain an owned, bounded copy and preserve lone surrogates.
  return Buffer.from(value, "utf16le").toString("utf16le");
}

function appendAggregateBoundedChunk(
  chunks: string[],
  budget: AggregateStreamChunkBudget,
  chunk: string,
  timestampPrefix: string,
  maxBytes: number,
  maxItems: number
) {
  if (typeof chunk !== "string" || chunk.length === 0 || budget.truncated) return;

  const markerBytes = estimateRetainedChunkBytes(STREAM_CHUNK_TRUNCATION_MARKER);
  const dataItemsLimit = Math.max(0, maxItems - 1); // reserve a single loss marker
  const availableBytes = Math.max(0, maxBytes - budget.value - markerBytes);
  const availableItems = dataItemsLimit - budget.itemCount;
  const candidateCost = (payloadLength: number, payloadBytes: number) =>
    Math.max(
      2 * (timestampPrefix.length + payloadLength),
      Buffer.byteLength(timestampPrefix, "utf8") + payloadBytes
    ) + MAX_STREAM_CHUNK_ITEM_BYTES;

  const payloadBytes = Buffer.byteLength(chunk, "utf8");
  const fullCost = candidateCost(chunk.length, payloadBytes);
  if (availableItems > 0 && fullCost <= availableBytes) {
    // The full input chunk is already an owned decoded string, so retain it
    // directly under the aggregate budget and avoid allocating a second copy.
    chunks.push(timestampPrefix + chunk);
    budget.value += fullCost;
    budget.itemCount++;
    return;
  }

  // Add the largest code-point-safe prefix that fits the remaining aggregate
  // budget. Binary search avoids a per-code-point walk for large stream frames.
  let retainedLength = 0;
  if (availableItems > 0) {
    let low = 0;
    let high = safePrefixLength(chunk, Math.floor(availableBytes / 2));
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const safeLength = safePrefixLength(chunk, middle);
      const prefixBytes = Buffer.byteLength(chunk.slice(0, safeLength), "utf8");
      if (safeLength > 0 && candidateCost(safeLength, prefixBytes) <= availableBytes) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    retainedLength = safePrefixLength(chunk, low);
  }

  if (retainedLength > 0) {
    const retained = chunk.slice(0, retainedLength);
    const retainedCost = candidateCost(retainedLength, Buffer.byteLength(retained, "utf8"));
    chunks.push(copyUtf16(timestampPrefix + retained));
    budget.value += retainedCost;
    budget.itemCount++;
  }

  // One marker is shared across all three tracks; reserve its memory and item
  // slot before retaining any stream data so the limit is never exceeded.
  chunks.push(STREAM_CHUNK_TRUNCATION_MARKER);
  budget.value += markerBytes;
  budget.itemCount++;
  budget.truncated = true;
}

function hasOwnValues(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && Object.keys(value as JsonRecord).length > 0);
}

function compactPipelinePayloads(
  payloads: RequestPipelinePayloads
): RequestPipelinePayloads | null {
  const result: RequestPipelinePayloads = {};

  for (const [key, value] of Object.entries(payloads)) {
    if (value === null || value === undefined) {
      continue;
    }

    if (key === "streamChunks" && value && typeof value === "object") {
      const chunkRecord = value as Record<string, unknown>;
      const compactedChunks = Object.fromEntries(
        Object.entries(chunkRecord).filter(
          ([, chunkValue]) => Array.isArray(chunkValue) && chunkValue.length > 0
        )
      );
      if (Object.keys(compactedChunks).length > 0) {
        result.streamChunks = compactedChunks;
      }
      continue;
    }

    if (key === "toolLoop" && value && typeof value === "object") {
      const legs = (value as { legs?: unknown }).legs;
      if (Array.isArray(legs) && legs.length > 0) {
        result.toolLoop = { legs: legs as JsonRecord[] };
      }
      continue;
    }

    if (key === "diagnosticOverflow") {
      const reference = projectDiagnosticOverflowReference(value);
      if (reference) result.diagnosticOverflow = reference;
      continue;
    }
    const payloadKey = key as Exclude<
      keyof RequestPipelinePayloads,
      "streamChunks" | "toolLoop" | "diagnosticOverflow"
    >;
    result[payloadKey] = value as JsonRecord;
  }

  return hasOwnValues(result) ? result : null;
}
function makeStreamChunkMethods(options: RequestLoggerOptions, captureChunks: boolean) {
  const streamChunks = createEmptyStreamChunks();
  const streamChunkBudget: AggregateStreamChunkBudget = {
    value: 0,
    itemCount: 0,
    truncated: false,
  };
  const requestedMaxBytes =
    Number.isInteger(options.maxStreamChunkBytes) && Number(options.maxStreamChunkBytes) > 0
      ? Number(options.maxStreamChunkBytes)
      : DEFAULT_MAX_STREAM_CHUNK_BYTES;
  const maxBytes = Math.max(
    MIN_MAX_STREAM_CHUNK_BYTES,
    Math.min(requestedMaxBytes, MAX_MAX_STREAM_CHUNK_BYTES)
  );
  const maxItems =
    Number.isInteger(options.maxStreamChunkItems) && Number(options.maxStreamChunkItems) > 0
      ? Math.min(Number(options.maxStreamChunkItems), DEFAULT_MAX_STREAM_CHUNK_ITEMS)
      : DEFAULT_MAX_STREAM_CHUNK_ITEMS;
  let pendingPushed = false;

  const push = () => {
    if (pendingPushed) return;
    if (!options.requestId && (!options.connectionId || !options.model)) return;
    pendingPushed = true;
    try {
      const pending = getPendingById();
      const exactEntry = options.requestId ? pending.get(options.requestId) : null;
      if (exactEntry) {
        exactEntry.streamChunks = { ...streamChunks };
        return;
      }

      for (const entry of pending.values()) {
        if (
          entry?.connectionId === options.connectionId &&
          entry?.model === options.model &&
          entry?.provider === (options.provider || "")
        ) {
          entry.streamChunks = { ...streamChunks };
          return;
        }
      }
    } catch (e) {
      // Do not allow logging failures to disrupt request handling
      try {
        console.warn("[requestLogger] updatePendingRequestStreamChunks failed:", e);
      } catch {}
    }
  };

  const append = (arr: string[], chunk: string) => {
    if (!captureChunks) return;
    if (streamChunkBudget.truncated) return;
    push();
    const ts = new Date().toISOString().slice(11, 23);
    appendAggregateBoundedChunk(arr, streamChunkBudget, chunk, `[${ts}] `, maxBytes, maxItems);
  };

  return {
    streamChunks,
    appendProviderChunk(chunk: string) {
      append(streamChunks.provider, chunk);
    },
    appendOpenAIChunk(chunk: string) {
      append(streamChunks.openai, chunk);
    },
    appendConvertedChunk(chunk: string) {
      append(streamChunks.client, chunk);
    },
  };
}

export async function createRequestLogger(
  _sourceFormat?: string,
  _targetFormat?: string,
  _model?: string,
  options: RequestLoggerOptions = {}
): Promise<RequestLogger> {
  const diagnosticTrace = await createDiagnosticOverflowTrace({
    eligible:
      options.enabled !== false &&
      options.diagnosticOverflowEligible === true &&
      ["antigravity", "agy"].includes(options.provider || ""),
    provider: options.provider || "unknown",
    requestId: options.requestId || undefined,
  });
  registerDiagnosticTrace(diagnosticTrace);
  if (diagnosticTrace) {
    const json = options.diagnosticClientJson?.();
    try {
      if (json !== undefined) await diagnosticTrace.writeClientRequest(json);
      else diagnosticTrace.markIncomplete("client_unavailable");
    } finally {
      options.releaseDiagnosticClientJson?.();
    }
    if (options.diagnosticSignal) {
      const abort = () => {
        void diagnosticTrace.abort("abort");
      };
      options.diagnosticSignal.addEventListener("abort", abort, { once: true });
      if (options.diagnosticSignal.aborted) abort();
    }
  } else {
    // Non-Antigravity providers never create overflow traces. Drop the raw
    // snapshot without serializing another copy of every client request.
    options.releaseDiagnosticClientJson?.();
  }
  const telemetry = getRequestTransportTelemetry();
  const captureStreamChunks = options.captureStreamChunks !== false;
  // Stream chunk capture is always set up — even when the logger is disabled,
  // so that active requests always have real-time stream data available via
  // the /api/logs/active endpoint.
  const chunkMethods = makeStreamChunkMethods(options, captureStreamChunks);

  if (options.enabled === false) {
    let routeDecision: JsonRecord | null = null;
    return {
      getDiagnosticOverflowTrace: () => null,
      sessionPath: null,
      logClientRawRequest() {},
      logRouteDecision(decision) {
        routeDecision = cloneBoundedForLog(decision) as JsonRecord;
      },
      logOpenAIRequest() {},
      logTargetRequest() {},
      logProviderResponse() {},
      appendProviderChunk: chunkMethods.appendProviderChunk,
      appendOpenAIChunk: chunkMethods.appendOpenAIChunk,
      logConvertedResponse() {},
      appendConvertedChunk: chunkMethods.appendConvertedChunk,
      logError() {},
      logToolLoopReceipt() {},
      getPipelinePayloads() {
        return routeDecision ? { routeDecision } : null;
      },
    };
  }

  const payloads: RequestPipelinePayloads = {
    ...(captureStreamChunks ? { streamChunks: chunkMethods.streamChunks } : {}),
  };

  return {
    getDiagnosticOverflowTrace: () => diagnosticTrace,
    sessionPath: null,

    logClientRawRequest(endpoint, body, headers = {}, effectiveInput) {
      payloads.clientRawRequest = {
        timestamp: new Date().toISOString(),
        endpoint,
        headers: maskSensitiveHeaders(headers),
        body: cloneBoundedForLog(body, 0, null, getChatLogClientTextLimit()),
        // The actual `input` this request dispatched with, captured AFTER
        // OmniRoute's own previous_response_id reconstruction (see
        // src/sse/handlers/chat.ts) -- `body` above is deliberately the
        // pre-reconstruction raw client bytes (captureDeferredClientRawBody's
        // whole point) and is NOT what got sent for a continued turn.
        // resolvePreviousResponseState must chain off this field, not
        // `body.input`: reading the raw pre-reconstruction input for a
        // request that was itself a continuation compounds into progressively
        // truncated history a few hops deep (live incident 2026-09-03,
        // manifested as a malformed request with no leading system/user
        // message rejected by the upstream provider).
        ...(effectiveInput !== undefined
          ? { effectiveInput: cloneBoundedForLog(effectiveInput) }
          : {}),
      };
    },

    logRouteDecision(decision) {
      payloads.routeDecision = cloneBoundedForLog(decision) as JsonRecord;
    },

    logOpenAIRequest(body) {
      payloads.openaiRequest = {
        timestamp: new Date().toISOString(),
        body: cloneBoundedForLog(body),
      };
    },

    logTargetRequest(url, headers, body) {
      payloads.providerRequest = {
        timestamp: new Date().toISOString(),
        url,
        headers: maskSensitiveHeaders(headers),
        body: cloneBoundedForLog(body),
      };
    },

    logProviderResponse(status, statusText, headers, body) {
      payloads.providerResponse = {
        timestamp: new Date().toISOString(),
        status,
        statusText,
        headers: maskSensitiveHeaders(headers),
        body: cloneBoundedForLog(body),
      };
    },

    appendProviderChunk: chunkMethods.appendProviderChunk,
    appendOpenAIChunk: chunkMethods.appendOpenAIChunk,
    logConvertedResponse(body) {
      payloads.clientResponse = {
        timestamp: new Date().toISOString(),
        body: cloneBoundedForLog(body),
      };
    },
    appendConvertedChunk: chunkMethods.appendConvertedChunk,

    logError(error, requestBody = null) {
      const nativeError =
        error && typeof error === "object" && "nativeError" in error
          ? (error as { nativeError: unknown }).nativeError
          : classifyUpstreamPolicyRejection(error);
      payloads.error = {
        ...(nativeError ? { nativeError: cloneBoundedForLog(nativeError) } : {}),
        timestamp: new Date().toISOString(),
        error: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
        requestBody: cloneBoundedForLog(requestBody),
      };
    },

    logToolLoopReceipt(receipt) {
      const legs = payloads.toolLoop?.legs ?? [];
      if (legs.length >= MAX_TOOL_LOOP_LEGS) return;
      const cloned = cloneBoundedForLog(receipt);
      if (!cloned || typeof cloned !== "object" || Array.isArray(cloned)) return;
      payloads.toolLoop = { legs: [...legs, cloned as JsonRecord] };
    },

    getPipelinePayloads() {
      return compactPipelinePayloads({
        ...payloads,
        ...(diagnosticTrace ? { diagnosticOverflow: diagnosticTrace.snapshot() } : {}),
        ...(telemetry ? { transportTelemetry: telemetry.snapshot() } : {}),
      });
    },
  };
}
