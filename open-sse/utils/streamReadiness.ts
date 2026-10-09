import { HTTP_STATUS } from "../config/constants.ts";
import { buildErrorBody, sanitizeErrorMessage } from "./error.ts";

type StreamReadinessLogger = {
  debug?: (tag: string, message: string) => void;
  warn?: (tag: string, message: string) => void;
};

export type StreamReadinessResult =
  | { ok: true; response: Response }
  | {
      ok: false;
      response: Response;
      /** Sanitized operator-facing context for logs and persisted diagnostics. */
      reason: string;
      /** Stable internal text for retry, quota, and account-health classification. */
      classificationReason: string;
      /** First non-empty sanitized message from an error-only SSE payload. */
      upstreamDiagnostic?: string;
      code: string;
      type: string;
      /** True only for the original client request signal, not per-target cancellation. */
      callerAborted?: true;
    };

/** Aggregate retained raw+decoded pre-readiness budget per request. */
export const MAX_STREAM_READINESS_BUFFER_BYTES = 1024 * 1024;
const MAX_STREAM_READINESS_BUFFER_CHUNKS = 1024;
const MAX_STREAM_READINESS_DATA_LINES = 1024;
const MAX_STREAM_READINESS_EVENTS = 2048;
const READINESS_BUFFER_CHUNK_OVERHEAD_BYTES = 64;
const READINESS_BUFFER_DATA_LINE_OVERHEAD_BYTES = 64;
const READINESS_BUFFER_PARSER_OVERHEAD_BYTES = 64;
const STREAM_READINESS_BUFFER_LIMIT_CODE = "STREAM_READINESS_BUFFER_LIMIT";
const STREAM_READ_ERROR_CODE = "STREAM_READ_ERROR";

type ReadinessReadOutcome =
  | { kind: "read"; value: ReadableStreamReadResult<Uint8Array> }
  | { kind: "timeout" }
  | { kind: "aborted" }
  | { kind: "read_error"; error: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

function hasUsefulValue(value: unknown): boolean {
  if (hasNonEmptyString(value)) return true;
  if (Array.isArray(value)) return value.some(hasUsefulValue);
  if (!isRecord(value)) return false;

  // A Responses compaction item IS the turn's output: remote compaction
  // completes with output = [{type:"compaction", encrypted_content}] and no
  // assistant text. Deliberately NOT a blanket encrypted_content key — an
  // encrypted reasoning item alone is not user-visible output and must keep
  // tripping the #8649 empty-content guard.
  // This shape is specific to Responses streams; chat-completion frames do not produce it.
  if (value.type === "compaction" && hasNonEmptyString(value.encrypted_content)) return true;

  for (const key of [
    "content",
    "text",
    "delta",
    "reasoning_content",
    "reasoning",
    // Mistral/Magistral thinking arrays and StepFun/OpenRouter reasoning_details are
    // valid model output — without these a reasoning-only stream was misclassified as
    // "no useful content" and turned into a spurious 502 (#2520).
    "thinking",
    "reasoning_details",
    "partial_json",
    "arguments",
    "name",
    "thought",
    "error",
    "executableCode",
    "codeExecutionResult",
  ]) {
    const candidate = value[key];
    if (hasNonEmptyString(candidate)) return true;
    if ((Array.isArray(candidate) || isRecord(candidate)) && hasUsefulValue(candidate)) return true;
  }

  for (const key of [
    "tool_calls",
    "tool_use",
    "function",
    "functionCall",
    "function_call",
    "function_call_output",
    "output",
    "content_block",
    "response",
    "choices",
    "candidates",
    "parts",
  ]) {
    if (hasUsefulValue(value[key])) return true;
  }

  return false;
}

function hasUsefulJsonPayload(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  return hasUsefulValue(payload);
}

function isPingEventType(type: string): boolean {
  return /^(?:ping|keepalive|heartbeat)$/i.test(type);
}

function getPayloadType(payload: unknown, eventType = ""): string {
  if (!isRecord(payload)) return eventType;
  const type = payload.type ?? payload.event ?? payload.object;
  return typeof type === "string" ? type : eventType;
}

// Keys that indicate a frame carries (or is starting to carry) actual model
// output — as opposed to a bare `{error:{...}}` frame with no output signal
// at all. A stream that only ever emits error-only frames (e.g. a CLI
// passthrough executor's mid-stream spawn failure, #7503) must NOT be
// classified as "ready" — treating it as ready lets the malformed frame
// reach the client as a fake 200 success and blocks combo fallback to the
// next candidate.
const CONTENT_BEARING_KEYS = [
  "choices",
  "candidates",
  "content_block",
  "delta",
  "output",
  "response",
  "parts",
  "tool_calls",
  "tool_use",
  "function_call",
  "function_call_output",
];

function isErrorOnlyStructuredPayload(payload: Record<string, unknown>): boolean {
  if (!("error" in payload)) return false;
  return !CONTENT_BEARING_KEYS.some((key) => key in payload);
}

function hasNonPingStructuredPayload(payload: unknown, eventType = ""): boolean {
  const type = getPayloadType(payload, eventType);
  if (isPingEventType(eventType) || isPingEventType(type)) return false;
  if (Array.isArray(payload)) return payload.length > 0;
  if (isRecord(payload)) {
    if (Object.keys(payload).length === 0) return false;
    return !isErrorOnlyStructuredPayload(payload);
  }
  return payload !== null && payload !== undefined;
}

export function hasUsefulStreamContent(text: string): boolean {
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(":")) continue;
    if (/^event:\s*(?:ping|keepalive)$/i.test(trimmed)) continue;
    if (!trimmed.startsWith("data:")) continue;

    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") continue;

    try {
      if (hasUsefulJsonPayload(JSON.parse(data))) return true;
    } catch {
      if (data.length > 0) return true;
    }
  }

  return false;
}

// Terminal states where a completion legitimately carries no content, kept in
// step with errorClassifier.ts's LEGIT_EMPTY_OPENAI_FINISH / LEGIT_EMPTY_CLAUDE_STOP
// so the streaming and non-streaming empty-content checks agree.
const LEGIT_EMPTY_TERMINAL_REASONS = new Set([
  "length",
  "tool_calls",
  "content_filter",
  "max_tokens",
  "tool_use",
]);

const TERMINAL_REASON_PATTERN = /"(?:finish_reason|stop_reason)"\s*:\s*"([^"]+)"/g;

const SSE_FIELD_LINE = /(?:^|\r?\n)\s*(?:data|event):/;

/** Same spirit as combo `isSubstantiveError` — non-empty string or non-empty object. */
function isSubstantiveErrorValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (hasNonEmptyString(record.message)) return true;
    return Object.keys(record).length > 0;
  }
  return value === true;
}

/**
 * True when an SSE frame already carries a structured upstream/client error
 * (OpenAI `error`, Claude `event:error` / `type:error`, Responses `response.failed`).
 * Used by #8649 so we do not invent "Provider returned empty content" after an
 * executor already emitted an actionable error (Claude #3685 / readiness #8972 parity).
 */
export function frameHasStructuredStreamError(frame: string): boolean {
  const lines = frame.split(/\r?\n/);
  let eventType = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(":")) continue;
    if (trimmed.startsWith("event:")) {
      eventType = trimmed.slice(6).trim();
      if (/^error$/i.test(eventType)) return true;
      continue;
    }
    if (!trimmed.startsWith("data:")) continue;

    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") continue;

    try {
      const parsed: unknown = JSON.parse(data);
      if (!isRecord(parsed)) continue;
      const type = getPayloadType(parsed, eventType);
      if (type === "error" || type === "response.failed" || eventType === "response.failed") {
        return true;
      }
      if (isSubstantiveErrorValue(parsed.error)) return true;
      const nestedResponse = isRecord(parsed.response) ? parsed.response : null;
      if (nestedResponse?.status === "failed" && nestedResponse.error != null) return true;
    } catch {
      // non-JSON data lines are not structured errors
    }
  }

  return false;
}

export type StreamContentWatcher = {
  /** Feed a decoded slice of the client-facing stream. Safe to call with partial frames. */
  note: (text: string) => void;
  /** Flush any buffered trailing frame; call once the stream is done. */
  finish: () => void;
  /** True once any frame carried real model output (text, reasoning, or a tool call). */
  sawContent: () => boolean;
  /** True once a terminal state was seen where emitting no content is valid. */
  sawLegitEmptyTerminal: () => boolean;
  /**
   * True once the stream looked like SSE at all. Not every body reaching the
   * client wrapper is event-stream — a plain JSON completion is forwarded
   * through the same path — and a non-SSE body has no `data:` frames to judge,
   * so callers must not read emptiness into it.
   */
  sawSseFrame: () => boolean;
  /**
   * True once a substantive SSE error frame was seen. Separate from sawContent
   * so #8649 can stand down without treating errors as model output.
   */
  sawError: () => boolean;
};

/**
 * Watch a client-facing SSE stream for whether it ever produced actual model
 * output, so a stream that terminates cleanly while carrying nothing can be
 * reported instead of closing as a silent empty turn (#8649).
 *
 * Frames are buffered until a blank-line boundary so a delta split across two
 * network chunks is still scanned as one payload. The buffer is bounded — a
 * single frame larger than the cap is scanned in pieces, which can only ever
 * lose content-detection precision in the direction of "saw content", never
 * toward a false empty.
 *
 * Also tracks `sawError` so an already-emitted structured error is not rewritten
 * as empty content (parity with Claude #3685 `lifecycle.hasError` and readiness #8972).
 */
export function createStreamContentWatcher(): StreamContentWatcher {
  const MAX_BUFFERED = 64 * 1024;
  let pending = "";
  let content = false;
  let legitEmpty = false;
  let sse = false;
  let error = false;

  const inspect = (frame: string): void => {
    if (!frame) return;
    if (!sse && SSE_FIELD_LINE.test(frame)) sse = true;
    if (!error && frameHasStructuredStreamError(frame)) error = true;
    if (!content && hasUsefulStreamContent(frame)) content = true;
    if (legitEmpty) return;
    for (const match of frame.matchAll(TERMINAL_REASON_PATTERN)) {
      if (LEGIT_EMPTY_TERMINAL_REASONS.has(match[1])) {
        legitEmpty = true;
        return;
      }
    }
  };

  return {
    note(text: string): void {
      if (!text) return;
      pending += text;
      for (;;) {
        const boundary = pending.search(/\r?\n\r?\n/);
        if (boundary === -1) break;
        inspect(pending.slice(0, boundary));
        pending = pending.slice(boundary).replace(/^\r?\n\r?\n/, "");
      }
      if (pending.length > MAX_BUFFERED) {
        inspect(pending);
        pending = "";
      }
    },
    finish(): void {
      inspect(pending);
      pending = "";
    },
    sawContent: () => content,
    sawLegitEmptyTerminal: () => legitEmpty,
    sawSseFrame: () => sse,
    sawError: () => error,
  };
}

type StreamReadinessSignalState = {
  currentEvent: string;
  dataLines: string[];
  eventsProcessed: number;
  pendingLine: string;
  upstreamDiagnostic: string | null;
  bufferLimitExceeded: boolean;
};

function resetCurrentEvent(state: StreamReadinessSignalState): void {
  state.currentEvent = "";
  state.dataLines = [];
}

/**
 * Make parser-owned strings independent from the large combined chunk string.
 * V8 may represent substring/slice results as views that keep their source string
 * alive; copying each retained field prevents a short pending line from pinning
 * an entire large decoded chunk.
 */
function copyParserString(value: string): string {
  if (!value) return "";
  return Buffer.from(value, "utf16le").toString("utf16le");
}

function estimateParserStringBytes(value: string | null | undefined): number {
  if (!value) return 0;
  // UTF-16 code units are a conservative upper bound for V8's one-byte/two-byte
  // string storage; the UTF-8 check also covers surrogate-pair representations.
  return Math.max(value.length * 2, Buffer.byteLength(value, "utf8"));
}

function estimateReadinessParserBytes(state: StreamReadinessSignalState): number {
  let bytes = READINESS_BUFFER_PARSER_OVERHEAD_BYTES;
  for (const line of state.dataLines) {
    bytes += estimateParserStringBytes(line) + READINESS_BUFFER_DATA_LINE_OVERHEAD_BYTES;
  }
  bytes += estimateParserStringBytes(state.currentEvent) + READINESS_BUFFER_PARSER_OVERHEAD_BYTES;
  bytes += estimateParserStringBytes(state.pendingLine) + READINESS_BUFFER_PARSER_OVERHEAD_BYTES;
  bytes +=
    estimateParserStringBytes(state.upstreamDiagnostic) + READINESS_BUFFER_PARSER_OVERHEAD_BYTES;
  return bytes;
}

function processStreamReadinessEvent(state: StreamReadinessSignalState): boolean {
  const eventType = state.currentEvent;
  const data = state.dataLines.join("\n").trim();
  resetCurrentEvent(state);
  if (++state.eventsProcessed > MAX_STREAM_READINESS_EVENTS) {
    state.bufferLimitExceeded = true;
    return false;
  }

  if (isPingEventType(eventType) || !data || data === "[DONE]") return false;

  try {
    const payload: unknown = JSON.parse(data);
    if (!state.upstreamDiagnostic && isRecord(payload) && isErrorOnlyStructuredPayload(payload)) {
      const error = payload.error;
      const rawMessage =
        typeof error === "string"
          ? error
          : isRecord(error) && typeof error.message === "string"
            ? error.message
            : "";
      const diagnostic = sanitizeErrorMessage(rawMessage).trim();
      if (diagnostic) state.upstreamDiagnostic = diagnostic;
    }
    return hasNonPingStructuredPayload(payload, eventType);
  } catch {
    return data.length > 0;
  }
}

function processStreamReadinessLine(state: StreamReadinessSignalState, line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(":")) {
    if (!trimmed) return processStreamReadinessEvent(state);
    return false;
  }

  if (trimmed.startsWith("event:")) {
    state.currentEvent = copyParserString(trimmed.slice(6).trim());
    return false;
  }

  if (trimmed.startsWith("data:")) {
    if (state.dataLines.length >= MAX_STREAM_READINESS_DATA_LINES) {
      state.bufferLimitExceeded = true;
      return false;
    }
    state.dataLines.push(copyParserString(trimmed.slice(5).trimStart()));
  }
  return false;
}

function appendStreamReadinessSignal(state: StreamReadinessSignalState, chunk: string): boolean {
  const text = `${state.pendingLine}${chunk}`;
  state.pendingLine = "";
  let start = 0;
  for (;;) {
    const newline = text.indexOf("\n", start);
    if (newline < 0) break;
    const line = text.slice(start, newline);
    if (processStreamReadinessLine(state, line)) return true;
    if (state.bufferLimitExceeded) return false;
    start = newline + 1;
  }

  state.pendingLine = copyParserString(text.slice(start));
  return false;
}

function finishStreamReadinessSignal(state: StreamReadinessSignalState): boolean {
  if (state.pendingLine && processStreamReadinessLine(state, state.pendingLine)) return true;
  state.pendingLine = "";
  return processStreamReadinessEvent(state);
}

export function hasStreamReadinessSignal(text: string): boolean {
  const state: StreamReadinessSignalState = {
    currentEvent: "",
    dataLines: [],
    eventsProcessed: 0,
    pendingLine: "",
    upstreamDiagnostic: null,
    bufferLimitExceeded: false,
  };
  if (appendStreamReadinessSignal(state, text)) return true;
  if (state.bufferLimitExceeded) return false;
  const finished = finishStreamReadinessSignal(state);
  return !state.bufferLimitExceeded && finished;
}

function createErrorResponse(
  status: number,
  message: string,
  code: string,
  type: string,
  upstreamDiagnostic?: string
): Response {
  return new Response(
    JSON.stringify(
      buildErrorBody(
        status,
        message,
        upstreamDiagnostic ? { error: { message: upstreamDiagnostic } } : undefined,
        { code, type }
      )
    ),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

export function prependBufferedChunks(
  chunks: Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>
): ReadableStream<Uint8Array> {
  let bufferedIndex = 0;
  let readInFlight = false;
  let cancelRequested = false;
  let readerReleased = false;

  const releaseReader = () => {
    if (readerReleased) return;
    readerReleased = true;
    reader.releaseLock();
  };

  const cancelReader = (reason: unknown) => {
    if (cancelRequested) return;
    cancelRequested = true;
    // Drop any readiness-prefix bytes that downstream will never request.
    chunks.length = 0;

    try {
      // The provider controls this promise and may never settle. Cancellation
      // of the replay stream must remain bounded, so cleanup is deliberately
      // fire-and-forget while the in-flight read releases the lock in `pull`.
      void reader.cancel(reason).catch(() => {});
    } catch {
      // A synchronous cancellation failure is cleanup-only; the downstream
      // stream has already been cancelled by its consumer.
    }

    if (!readInFlight) releaseReader();
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (cancelRequested) return;

      // Replay exactly one readiness chunk per demand. Reading the source
      // eagerly here would let a subsequent source error clear this queue
      // before the consumer has observed the buffered prefix.
      if (bufferedIndex < chunks.length) {
        const chunk = chunks[bufferedIndex];
        chunks[bufferedIndex] = new Uint8Array(0);
        bufferedIndex += 1;
        controller.enqueue(chunk);
        return;
      }

      readInFlight = true;
      try {
        const { done, value } = await reader.read();
        if (cancelRequested) return;
        if (done) {
          releaseReader();
          controller.close();
        } else if (value) {
          controller.enqueue(value);
        }
      } catch (error) {
        releaseReader();
        if (!cancelRequested) controller.error(error);
      } finally {
        readInFlight = false;
        if (cancelRequested) releaseReader();
      }
    },
    cancel(reason) {
      cancelReader(reason);
    },
  });
}

function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  dispatchSignal?: AbortSignal | null,
  callerSignal?: AbortSignal | null
): Promise<ReadinessReadOutcome> {
  const signals = [
    ...new Set(
      [dispatchSignal, callerSignal].filter((signal): signal is AbortSignal => signal != null)
    ),
  ];
  if (signals.some((signal) => signal.aborted)) {
    return Promise.resolve({ kind: "aborted" });
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const timeoutPromise = new Promise<ReadinessReadOutcome>((resolve) => {
    timeout = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
  });
  const abortPromise =
    signals.length > 0
      ? new Promise<ReadinessReadOutcome>((resolve) => {
          const onAbort = () => resolve({ kind: "aborted" });
          abort = onAbort;
          for (const signal of signals) {
            if (signal.aborted) {
              onAbort();
              return;
            }
            signal.addEventListener("abort", onAbort, { once: true });
          }
        })
      : new Promise<ReadinessReadOutcome>(() => {});
  const readPromise: Promise<ReadinessReadOutcome> = reader.read().then(
    (value) => ({ kind: "read", value }),
    (error) => ({ kind: "read_error", error })
  );

  return Promise.race([readPromise, timeoutPromise, abortPromise]).finally(() => {
    clearTimeout(timeout);
    if (abort) for (const signal of signals) signal.removeEventListener("abort", abort);
  });
}

function createCallerAbortedResult(): StreamReadinessResult {
  const reason = "Request aborted";
  return {
    ok: false,
    callerAborted: true,
    reason,
    classificationReason: reason,
    code: "CLIENT_ABORTED",
    type: "client_disconnected",
    response: createErrorResponse(499, reason, "CLIENT_ABORTED", "client_disconnected"),
  };
}

function readinessTimeoutResult(
  options: {
    provider?: string | null;
    model?: string | null;
    log?: StreamReadinessLogger | null;
  },
  reason: string
): StreamReadinessResult {
  options.log?.warn?.(
    "STREAM",
    `${reason} (${options.provider || "provider"}/${options.model || "unknown"})`
  );
  return {
    ok: false,
    reason,
    classificationReason: reason,
    code: "STREAM_READINESS_TIMEOUT",
    // The provider has already returned HTTP 200, so it may still be generating.
    // Preserve the timeout code while making the result terminal to combo replay.
    type: "upstream_acceptance_uncertain",
    response: createErrorResponse(
      HTTP_STATUS.GATEWAY_TIMEOUT,
      reason,
      "STREAM_READINESS_TIMEOUT",
      "upstream_acceptance_uncertain"
    ),
  };
}

function readinessBufferLimitResult(
  options: {
    provider?: string | null;
    model?: string | null;
    log?: StreamReadinessLogger | null;
  },
  reason: string
): StreamReadinessResult {
  options.log?.warn?.(
    "STREAM",
    `${reason} (${options.provider || "provider"}/${options.model || "unknown"})`
  );
  return {
    ok: false,
    reason,
    classificationReason: reason,
    code: STREAM_READINESS_BUFFER_LIMIT_CODE,
    type: "local_stream_buffer_limit",
    response: createErrorResponse(
      HTTP_STATUS.BAD_GATEWAY,
      reason,
      STREAM_READINESS_BUFFER_LIMIT_CODE,
      "local_stream_buffer_limit"
    ),
  };
}

function upstreamStreamReadErrorResult(options: {
  provider?: string | null;
  model?: string | null;
  log?: StreamReadinessLogger | null;
}): StreamReadinessResult {
  const reason = "Upstream stream failed before response readiness";
  options.log?.warn?.(
    "STREAM",
    `${reason} (${options.provider || "provider"}/${options.model || "unknown"})`
  );
  return {
    ok: false,
    reason,
    classificationReason: reason,
    code: STREAM_READ_ERROR_CODE,
    // Read failure after HTTP 200 does not prove the provider stopped processing.
    type: "upstream_acceptance_uncertain",
    response: createErrorResponse(
      HTTP_STATUS.BAD_GATEWAY,
      reason,
      STREAM_READ_ERROR_CODE,
      "upstream_acceptance_uncertain"
    ),
  };
}

function cancelReadinessReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: unknown,
  dispatchSignal?: AbortSignal | null,
  callerSignal?: AbortSignal | null,
  cancelUpstream?: ((reason: unknown) => void) | null
): void {
  if (!dispatchSignal?.aborted && !callerSignal?.aborted) {
    try {
      cancelUpstream?.(reason);
    } catch {
      // Upstream cancellation is best-effort cleanup; preserve the readiness outcome.
    }
  }
  try {
    // Readiness must settle at its own deadline even when a source's cancel hook
    // never resolves. Calling cancel still propagates cleanup; do not await it.
    void reader.cancel(reason).catch(() => {});
  } catch {
    // The stream may already be errored/closed.
  }
}

export async function ensureStreamReadiness(
  response: Response,
  options: {
    timeoutMs: number;
    /** Hard ceiling for liveness-extended deadlines. When omitted, no hard ceiling
     *  is applied beyond `timeoutMs`. */
    maxTimeoutMs?: number;
    provider?: string | null;
    model?: string | null;
    log?: StreamReadinessLogger | null;
    /** Dispatch signal may include per-target cancellation; callerSignal is the original client. */
    signal?: AbortSignal | null;
    callerSignal?: AbortSignal | null;
    /** Abort the owning request attempt on a local readiness timeout/cap. */
    cancelUpstream?: (reason: unknown) => void;
    /** Test seam and bounded override; the effective limit is never above the 1 MiB default. */
    maxBufferedBytes?: number;
  }
): Promise<StreamReadinessResult> {
  if (options.callerSignal?.aborted) {
    try {
      void response.body?.cancel(options.callerSignal.reason).catch(() => {});
    } catch {}
    return createCallerAbortedResult();
  }
  if (options.signal?.aborted) {
    const reason = "Stream dispatch was cancelled before readiness";
    try {
      void response.body?.cancel(options.signal.reason).catch(() => {});
    } catch {}
    return readinessTimeoutResult(options, reason);
  }
  if (!response.body || options.timeoutMs <= 0) return { ok: true, response };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const decoder = new TextDecoder();
  const readinessState: StreamReadinessSignalState = {
    currentEvent: "",
    dataLines: [],
    eventsProcessed: 0,
    pendingLine: "",
    upstreamDiagnostic: null,
    bufferLimitExceeded: false,
  };
  const startedAt = Date.now();
  const effectiveTimeoutMs = Math.max(0, Math.floor(options.timeoutMs));
  const requestedBufferBytes =
    Number.isInteger(options.maxBufferedBytes) && Number(options.maxBufferedBytes) > 0
      ? Number(options.maxBufferedBytes)
      : MAX_STREAM_READINESS_BUFFER_BYTES;
  const maxBufferedBytes = Math.min(requestedBufferBytes, MAX_STREAM_READINESS_BUFFER_BYTES);
  let bufferedRawBytes = 0;
  let bufferedDecodedBytes = 0;
  // Hard ceiling: the deadline may extend on liveness signals (bytes arriving),
  // but never past this absolute maximum.  When maxTimeoutMs is omitted the
  // initial timeoutMs itself acts as the ceiling (no extension).
  const maxDeadline =
    options.maxTimeoutMs != null
      ? startedAt + Math.max(effectiveTimeoutMs, Math.floor(options.maxTimeoutMs))
      : startedAt + effectiveTimeoutMs;
  let deadline = startedAt + effectiveTimeoutMs;
  let handedOffReader = false;

  const buildReadyResponse = () =>
    new Response(prependBufferedChunks(chunks, reader), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });

  const timeoutReason = () =>
    `Stream produced no non-ping SSE event within ${deadline - startedAt}ms (max=${maxDeadline - startedAt}ms)`;

  const bufferLimitReason = () =>
    `Stream exceeded the ${maxBufferedBytes}-byte pre-readiness buffer limit before a non-ping SSE event`;

  const failForBufferLimit = (): StreamReadinessResult => {
    if (options.callerSignal?.aborted) {
      cancelReadinessReader(
        reader,
        options.callerSignal.reason,
        options.signal,
        options.callerSignal,
        options.cancelUpstream
      );
      return createCallerAbortedResult();
    }
    if (options.signal?.aborted) {
      cancelReadinessReader(
        reader,
        options.signal.reason,
        options.signal,
        options.callerSignal,
        options.cancelUpstream
      );
      return readinessTimeoutResult(options, bufferLimitReason());
    }
    const reason = bufferLimitReason();
    cancelReadinessReader(
      reader,
      reason,
      options.signal,
      options.callerSignal,
      options.cancelUpstream
    );
    return readinessBufferLimitResult(options, reason);
  };

  try {
    while (true) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        const reason = timeoutReason();
        cancelReadinessReader(
          reader,
          reason,
          options.signal,
          options.callerSignal,
          options.cancelUpstream
        );
        return readinessTimeoutResult(options, reason);
      }

      const readOutcome = await readWithTimeout(
        reader,
        remainingMs,
        options.signal,
        options.callerSignal
      );
      if (options.callerSignal?.aborted) {
        cancelReadinessReader(
          reader,
          options.callerSignal.reason,
          options.signal,
          options.callerSignal,
          options.cancelUpstream
        );
        return createCallerAbortedResult();
      }
      if (options.signal?.aborted) {
        cancelReadinessReader(
          reader,
          options.signal.reason,
          options.signal,
          options.callerSignal,
          options.cancelUpstream
        );
        return readinessTimeoutResult(options, timeoutReason());
      }
      if (readOutcome.kind === "aborted") {
        cancelReadinessReader(
          reader,
          options.callerSignal?.reason ?? options.signal?.reason,
          options.signal,
          options.callerSignal,
          options.cancelUpstream
        );
        if (options.callerSignal?.aborted) return createCallerAbortedResult();
        return readinessTimeoutResult(options, timeoutReason());
      }
      if (readOutcome.kind === "read_error") {
        if (options.callerSignal?.aborted) {
          cancelReadinessReader(
            reader,
            options.callerSignal.reason,
            options.signal,
            options.callerSignal,
            options.cancelUpstream
          );
          return createCallerAbortedResult();
        }
        if (options.signal?.aborted) {
          cancelReadinessReader(
            reader,
            options.signal.reason,
            options.signal,
            options.callerSignal,
            options.cancelUpstream
          );
          return readinessTimeoutResult(options, timeoutReason());
        }
        cancelReadinessReader(
          reader,
          "Upstream stream failed before response readiness",
          options.signal,
          options.callerSignal,
          options.cancelUpstream
        );
        return upstreamStreamReadErrorResult(options);
      }
      if (readOutcome.kind === "timeout") {
        const reason = timeoutReason();
        cancelReadinessReader(
          reader,
          reason,
          options.signal,
          options.callerSignal,
          options.cancelUpstream
        );
        return readinessTimeoutResult(options, reason);
      }

      const readResult = readOutcome.value;

      if (readResult.done) {
        const tail = decoder.decode(undefined, { stream: false });
        if (tail && appendStreamReadinessSignal(readinessState, tail)) {
          handedOffReader = true;
          return { ok: true, response: buildReadyResponse() };
        }
        if (readinessState.bufferLimitExceeded) return failForBufferLimit();
        const finishedWithReadiness = finishStreamReadinessSignal(readinessState);
        if (readinessState.bufferLimitExceeded) return failForBufferLimit();
        if (finishedWithReadiness) {
          handedOffReader = true;
          return { ok: true, response: buildReadyResponse() };
        }

        const classificationReason = "Stream ended before producing a non-ping SSE event";
        const upstreamDiagnostic = readinessState.upstreamDiagnostic || undefined;
        const reason = upstreamDiagnostic
          ? `${classificationReason}: ${upstreamDiagnostic}`
          : classificationReason;
        options.log?.warn?.(
          "STREAM",
          `${reason} (${options.provider || "provider"}/${options.model || "unknown"})`
        );
        return {
          ok: false,
          reason,
          classificationReason,
          ...(upstreamDiagnostic ? { upstreamDiagnostic } : {}),
          code: "STREAM_EARLY_EOF",
          type: "stream_early_eof",
          response: createErrorResponse(
            HTTP_STATUS.BAD_GATEWAY,
            classificationReason,
            "STREAM_EARLY_EOF",
            "stream_early_eof",
            upstreamDiagnostic
          ),
        };
      }

      if (!readResult.value) continue;
      if (chunks.length >= MAX_STREAM_READINESS_BUFFER_CHUNKS) return failForBufferLimit();
      // A Uint8Array view can pin a larger pooled ArrayBuffer, so account the
      // full backing store rather than only the visible byteLength.
      const rawBackingBytes = Math.max(
        readResult.value.byteLength,
        readResult.value.buffer.byteLength
      );
      const nextRawBytes = bufferedRawBytes + rawBackingBytes;
      // Check the raw-buffer ceiling before TextDecoder creates a parallel JS
      // string. The full raw+decoded estimate is checked immediately below.
      if (nextRawBytes >= maxBufferedBytes) return failForBufferLimit();
      // The raw replay chunk and its decoded UTF-16 view can both remain live
      // until readiness. Count both conservatively before retaining either.
      const decodedChunk = decoder.decode(readResult.value, { stream: true });
      const decodedStorageBytes = Math.max(
        decodedChunk.length * 2,
        Buffer.byteLength(decodedChunk, "utf8")
      );
      const nextBufferedBytes =
        nextRawBytes +
        bufferedDecodedBytes +
        decodedStorageBytes +
        READINESS_BUFFER_CHUNK_OVERHEAD_BYTES * (chunks.length + 1) +
        estimateReadinessParserBytes(readinessState) +
        256;
      if (nextBufferedBytes > maxBufferedBytes) return failForBufferLimit();
      chunks.push(readResult.value);
      bufferedRawBytes = nextRawBytes;
      bufferedDecodedBytes += decodedStorageBytes;

      // Liveness extension: bytes arrived → connection is alive, not dead.
      // Reset the deadline so slow-but-alive upstreams (reasoning warm-ups,
      // keepalive-only phases) are not aborted.  The hard ceiling (maxDeadline)
      // prevents unbounded waits and preserves the operator's fast-fail intent
      // for truly dead connections.
      const now = Date.now();
      if (deadline < maxDeadline) {
        deadline = Math.min(now + effectiveTimeoutMs, maxDeadline);
        if (now - startedAt > effectiveTimeoutMs) {
          options.log?.debug?.(
            "STREAM",
            `readiness deadline extended to ${deadline - startedAt}ms (liveness signal) (${options.provider || "provider"}/${options.model || "unknown"})`
          );
        }
      }

      if (appendStreamReadinessSignal(readinessState, decodedChunk)) {
        options.log?.debug?.(
          "STREAM",
          `Stream readiness confirmed in ${Date.now() - startedAt}ms (${options.provider || "provider"}/${options.model || "unknown"})`
        );
        handedOffReader = true;
        return {
          ok: true,
          response: buildReadyResponse(),
        };
      }
      if (
        readinessState.bufferLimitExceeded ||
        bufferedRawBytes +
          bufferedDecodedBytes +
          READINESS_BUFFER_CHUNK_OVERHEAD_BYTES * chunks.length +
          estimateReadinessParserBytes(readinessState) +
          256 >
          maxBufferedBytes
      ) {
        return failForBufferLimit();
      }
    }
  } finally {
    if (!handedOffReader) {
      try {
        reader.releaseLock();
      } catch {
        // A timed-out upstream read may remain in flight after fire-and-forget
        // cancellation. Do not turn cleanup into another unbounded wait.
      }
    }
  }
}
