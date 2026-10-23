/**
 * @file sseHeartbeat.ts
 * @description Mid-stream SSE heartbeat transform (comment / Anthropic ping / OpenAI chunk).
 *
 * @changes
 * - [2026-07-28] [Cursor Grok 4.5] - Brand-neutral default OpenAI keepalive id/model
 */
const HEARTBEAT_ENCODER = new TextEncoder();
let syntheticResponsesIdCounter = 0;

export function createSyntheticResponsesId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `resp_${uuid.replace(/-/g, "")}`;
  syntheticResponsesIdCounter += 1;
  return `resp_${Date.now().toString(36)}_${syntheticResponsesIdCounter.toString(36)}_${Math.random().toString(36).slice(2)}`;
}

const syntheticResponsesIdsByCorrelation = new Map<string, { id: string; createdAt: number }>();
const syntheticResponsesIdsBySignal = new WeakMap<AbortSignal, string>();
const SYNTHETIC_RESPONSES_ID_TTL_MS = 10 * 60 * 1000;

export function getOrCreateStreamSyntheticResponsesId(
  correlationId?: string | null,
  signal?: AbortSignal | null,
  preferredId?: string
): string {
  const now = Date.now();
  for (const [key, entry] of syntheticResponsesIdsByCorrelation) {
    if (entry.createdAt < now - SYNTHETIC_RESPONSES_ID_TTL_MS) {
      syntheticResponsesIdsByCorrelation.delete(key);
    }
  }
  const id =
    preferredId ??
    (signal ? syntheticResponsesIdsBySignal.get(signal) : undefined) ??
    (!signal && correlationId
      ? syntheticResponsesIdsByCorrelation.get(correlationId)?.id
      : undefined) ??
    createSyntheticResponsesId();
  if (signal) syntheticResponsesIdsBySignal.set(signal, id);
  if (correlationId) {
    syntheticResponsesIdsByCorrelation.set(correlationId, { id, createdAt: now });
  }
  return id;
}

export function associateSyntheticResponsesIdWithSignal(signal: AbortSignal, id: string): void {
  syntheticResponsesIdsBySignal.set(signal, id);
}

export function getSyntheticResponsesIdForSignal(signal?: AbortSignal | null): string | undefined {
  return signal ? syntheticResponsesIdsBySignal.get(signal) : undefined;
}

export function buildOpenAIResponsesInProgressFrame(responsesId: string): Uint8Array {
  return HEARTBEAT_ENCODER.encode(
    `data: ${JSON.stringify({ type: "response.in_progress", response: { id: responsesId, status: "in_progress" } })}\n\n`
  );
}

export const OPENAI_RESPONSES_IN_PROGRESS_FRAME =
  buildOpenAIResponsesInProgressFrame("resp_template");

export const DEFAULT_SSE_HEARTBEAT_INTERVAL_MS = 15_000;

export const HEARTBEAT_SHAPES = {
  COMMENT: "comment",
  ANTHROPIC_PING: "anthropic-ping",
  OPENAI_CHUNK: "openai-chunk",
  OPENAI_RESPONSES_IN_PROGRESS: "openai-responses-in-progress",
} as const;

export type HeartbeatShape = (typeof HEARTBEAT_SHAPES)[keyof typeof HEARTBEAT_SHAPES];

export const DEFAULT_SSE_HEARTBEAT_SHAPE: HeartbeatShape = HEARTBEAT_SHAPES.COMMENT;

export function shapeForClientFormat(
  clientResponseFormat: string | undefined | null
): HeartbeatShape {
  switch (clientResponseFormat) {
    case "claude":
      return HEARTBEAT_SHAPES.ANTHROPIC_PING;
    case "openai":
      return HEARTBEAT_SHAPES.OPENAI_CHUNK;
    case "openai-responses":
      return HEARTBEAT_SHAPES.OPENAI_RESPONSES_IN_PROGRESS;
    default:
      return HEARTBEAT_SHAPES.COMMENT;
  }
}

function buildHeartbeatPayload(
  shape: HeartbeatShape,
  opts: { chunkId?: string; chunkModel?: string; responsesId?: string } = {}
): string {
  switch (shape) {
    case HEARTBEAT_SHAPES.ANTHROPIC_PING:
      return 'event: ping\ndata: {"type":"ping"}\n\n';
    case HEARTBEAT_SHAPES.OPENAI_RESPONSES_IN_PROGRESS:
      return `data: ${JSON.stringify({ type: "response.in_progress", response: { id: opts.responsesId, status: "in_progress" } })}\n\n`;
    case HEARTBEAT_SHAPES.OPENAI_CHUNK: {
      const payload = {
        id: opts.chunkId ?? "chatcmpl-keepalive",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: opts.chunkModel ?? "keepalive",
        choices: [{ index: 0, delta: {}, finish_reason: null }],
      };
      return `data: ${JSON.stringify(payload)}\n\n`;
    }
    case HEARTBEAT_SHAPES.COMMENT:
    default:
      return `: keepalive ${new Date().toISOString()}\n\n`;
  }
}

type SseHeartbeatTransformOptions = {
  intervalMs?: number;
  signal?: AbortSignal;
  shape?: HeartbeatShape;
  chunkId?: string;
  chunkModel?: string;
  responsesId?: string;
};

/**
 * Whether OmniRoute may emit SSE `:` comment lines (e.g. the `: keepalive` heartbeat).
 * Some strict OpenAI-compatible clients parse every SSE line as JSON and crash on `:` comments.
 * Set OMNIROUTE_SSE_COMMENTS=on to enable comment-shaped heartbeats and telemetry trailers.
 * #10524: defaults to disabled — strict SSE clients (WorkBuddy, etc.) break on `: x-omniroute-*`
 * comment lines. Operators who want the telemetry can opt in with OMNIROUTE_SSE_COMMENTS=on.
 */
export function sseCommentsEnabled(): boolean {
  // SSR/edge safety: `process` is not defined in Workers/Deno/edge runtimes.
  if (typeof process === "undefined") return false;
  const v = process.env.OMNIROUTE_SSE_COMMENTS;
  if (v === undefined || v === "") return false;
  const normalized = v.trim().toLowerCase();
  return normalized === "on" || normalized === "true" || normalized === "1" || normalized === "yes";
}

export function createSseHeartbeatTransform({
  intervalMs = DEFAULT_SSE_HEARTBEAT_INTERVAL_MS,
  signal,
  shape = DEFAULT_SSE_HEARTBEAT_SHAPE,
  chunkId,
  chunkModel,
  responsesId,
}: SseHeartbeatTransformOptions = {}): ReadableWritablePair<Uint8Array, Uint8Array> {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return new TransformStream<Uint8Array, Uint8Array>();
  }

  // Opt-out for strict OpenAI-compatible clients that JSON.parse every SSE line and
  // crash on `:` comment heartbeats. OMNIROUTE_SSE_COMMENTS=off disables comment-shaped
  // heartbeats (they become a no-op); valid `data:` heartbeats are unaffected.
  if (!sseCommentsEnabled() && shape === HEARTBEAT_SHAPES.COMMENT) {
    return new TransformStream<Uint8Array, Uint8Array>();
  }

  const streamResponsesId =
    responsesId ??
    (shape === HEARTBEAT_SHAPES.OPENAI_RESPONSES_IN_PROGRESS
      ? (getSyntheticResponsesIdForSignal(signal) ?? createSyntheticResponsesId())
      : undefined);
  let intervalId: ReturnType<typeof setInterval> | undefined;

  const stop = () => {
    if (!intervalId) return;
    globalThis.clearInterval(intervalId);
    intervalId = undefined;
  };

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      intervalId = globalThis.setInterval(() => {
        if (signal?.aborted) {
          stop();
          return;
        }

        try {
          controller.enqueue(
            HEARTBEAT_ENCODER.encode(
              buildHeartbeatPayload(shape, { chunkId, chunkModel, responsesId: streamResponsesId })
            )
          );
        } catch {
          stop();
        }
      }, intervalMs);

      if (intervalId && typeof intervalId === "object" && "unref" in intervalId) {
        intervalId.unref?.();
      }

      signal?.addEventListener("abort", stop, { once: true });
    },

    transform(chunk, controller) {
      controller.enqueue(chunk);
    },

    flush() {
      stop();
    },
  });
  const reader = transform.readable.getReader();
  void reader.closed.then(stop, stop);
  let canceled = false;

  return {
    readable: new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { value, done } = await reader.read();
          if (canceled) return;
          if (done) {
            stop();
            controller.close();
          } else {
            controller.enqueue(value);
          }
        } catch (error) {
          stop();
          if (!canceled) controller.error(error);
        }
      },

      async cancel(reason) {
        canceled = true;
        stop();
        await reader.cancel(reason);
      },
    }),
    writable: transform.writable,
  };
}
