/**
 * Vertex AI media generation client.
 *
 * Google's Vertex AI serves speech (Gemini TTS), transcription (Gemini), music
 * (Lyria) and video (Veo) — but through the same `aiplatform.googleapis.com`
 * surface that the chat executor authenticates against, NOT through the
 * third-party media registries (kie/suno/deepgram/…). This module reuses the
 * Vertex chat executor's auth (Service Account JSON → OAuth bearer, or Express
 * API key) and implements the verified per-model contracts:
 *
 * - Speech:        `{model}:generateContent` + responseModalities:["AUDIO"] → PCM L16 → WAV
 * - Transcription: `{model}:generateContent` with inline audio + text prompt → text
 * - Music (Lyria): `{model}:predict` → predictions[0].bytesBase64Encoded (WAV)
 * - Video (Veo):   `{model}:predictLongRunning` → poll `{model}:fetchPredictOperation`
 *                  → response.videos[0].bytesBase64Encoded (MP4)
 */

import { Buffer } from "node:buffer";
import {
  parseSAFromApiKey,
  getAccessToken,
  looksLikeServiceAccountJson,
  isExpressApiKey,
} from "./vertex.ts";

export interface VertexMediaCredentials {
  apiKey?: string | null;
  accessToken?: string | null;
  providerSpecificData?: Record<string, unknown> | null;
}

interface ResolvedVertexAuth {
  project: string;
  region: string;
  bearerToken: string | null;
  expressKey: string | null;
}

const DEFAULT_REGION = "us-central1";

function resolveRegion(credentials: VertexMediaCredentials | null | undefined): string {
  const psd = credentials?.providerSpecificData;
  if (psd && typeof psd === "object") {
    const region = (psd as Record<string, unknown>).region;
    if (typeof region === "string" && region.trim().length > 0) return region.trim();
  }
  return DEFAULT_REGION;
}

async function resolveVertexAuth(
  credentials: VertexMediaCredentials | null | undefined,
  signal?: AbortSignal
): Promise<ResolvedVertexAuth> {
  const apiKey = typeof credentials?.apiKey === "string" ? credentials.apiKey.trim() : "";
  const region = resolveRegion(credentials);
  let bearerToken =
    typeof credentials?.accessToken === "string" && credentials.accessToken.trim().length > 0
      ? credentials.accessToken.trim()
      : null;
  let project = "";
  let expressKey: string | null = null;

  if (looksLikeServiceAccountJson(apiKey)) {
    const sa = parseSAFromApiKey(apiKey);
    project = typeof sa.project_id === "string" ? sa.project_id : "";
    if (!bearerToken) bearerToken = await getAccessToken(sa, signal);
  } else if (isExpressApiKey(apiKey)) {
    expressKey = apiKey;
  }

  return { project, region, bearerToken, expressKey };
}

/**
 * Build the request URL + headers for a Vertex publisher-model action.
 * SA path → project-scoped regional endpoint + Bearer auth.
 * Express path (best-effort) → project-less global publisher endpoint + ?key=.
 */
function buildModelRequest(
  auth: ResolvedVertexAuth,
  model: string,
  action: string
): { url: string; headers: Record<string, string> } {
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  if (auth.bearerToken && auth.project) {
    headers["Authorization"] = `Bearer ${auth.bearerToken}`;
    return {
      url: `https://${auth.region}-aiplatform.googleapis.com/v1/projects/${auth.project}/locations/${auth.region}/publishers/google/models/${model}:${action}`,
      headers,
    };
  }

  if (auth.expressKey) {
    return {
      url: `https://aiplatform.googleapis.com/v1/publishers/google/models/${model}:${action}?key=${encodeURIComponent(
        auth.expressKey
      )}`,
      headers,
    };
  }

  throw new Error(
    "Vertex AI requires a Service Account JSON (with project_id) or a Vertex AI Express API key"
  );
}

interface VertexHttpError extends Error {
  status?: number;
  terminal?: true;
}

const VEO_DEFAULT_TASK_TIMEOUT_MS = 5 * 60 * 1000;
const VEO_MAX_TASK_TIMEOUT_MS = 15 * 60 * 1000;
const VEO_DEFAULT_POLL_INTERVAL_MS = 10_000;
const VEO_MAX_POLL_INTERVAL_MS = 60_000;
const VEO_MAX_TIMER_DELAY_MS = 2_147_483_647;

class VertexVeoDeadlineExceeded extends Error {
  constructor(readonly phase: string) {
    super(`Vertex Veo ${phase} exceeded the task deadline`);
    this.name = "VertexVeoDeadlineExceeded";
  }
}

class VertexVeoCallerCancelled extends Error {
  constructor(readonly afterSubmit: boolean) {
    super(
      afterSubmit
        ? "Vertex Veo request cancelled after submission began"
        : "Vertex Veo request cancelled before submission"
    );
    this.name = "VertexVeoCallerCancelled";
  }
}

function createVeoDeadline(timeoutMs: number) {
  const deadlineAt = Date.now() + timeoutMs;
  const controller = new AbortController();
  let activePhase = "task";
  let expired = false;
  const expire = (phase: string) => {
    if (expired) return;
    expired = true;
    activePhase = phase;
    controller.abort(new VertexVeoDeadlineExceeded(phase));
  };
  const timer = setTimeout(() => expire(activePhase), Math.min(timeoutMs, VEO_MAX_TIMER_DELAY_MS));

  return {
    signal: controller.signal,
    remainingMs: () => Math.max(0, deadlineAt - Date.now()),
    isExpired: () => expired || Date.now() >= deadlineAt,
    async run<T>(operation: () => Promise<T>, phase: string): Promise<T> {
      activePhase = phase;
      if (controller.signal.aborted || Date.now() >= deadlineAt) {
        expire(phase);
        throw controller.signal.reason ?? new VertexVeoDeadlineExceeded(phase);
      }

      let onAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(controller.signal.reason ?? new VertexVeoDeadlineExceeded(phase));
        controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        const value = await Promise.race([Promise.resolve().then(operation), aborted]);
        if (Date.now() >= deadlineAt) {
          expire(phase);
          throw controller.signal.reason ?? new VertexVeoDeadlineExceeded(phase);
        }
        return value;
      } finally {
        if (onAbort) controller.signal.removeEventListener("abort", onAbort);
      }
    },
    dispose() {
      clearTimeout(timer);
    },
  };
}

function veoFailureError(message: string, status: number, terminal = false): VertexHttpError {
  const error = new Error(message) as VertexHttpError;
  error.status = status;
  if (terminal) error.terminal = true;
  return error;
}

function sleepWithVeoSignal(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new VertexVeoDeadlineExceeded("poll wait"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new VertexVeoDeadlineExceeded("poll wait"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function resolveVeoTimeout(value: unknown): number {
  const requested = Number(value);
  return Number.isFinite(requested) && requested > 0
    ? Math.max(1, Math.min(Math.floor(requested), VEO_MAX_TASK_TIMEOUT_MS))
    : VEO_DEFAULT_TASK_TIMEOUT_MS;
}

function resolveVeoPollInterval(value: unknown): number {
  const requested = Number(value);
  return Number.isFinite(requested) && requested > 0
    ? Math.max(1, Math.min(Math.floor(requested), VEO_MAX_POLL_INTERVAL_MS))
    : VEO_DEFAULT_POLL_INTERVAL_MS;
}

function combineVeoSignals(signals: Array<AbortSignal | null | undefined>) {
  const controller = new AbortController();
  const activeSignals = signals.filter((signal): signal is AbortSignal => signal != null);
  const handlers = new Map<AbortSignal, () => void>();
  for (const signal of activeSignals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    const handler = () => controller.abort(signal.reason);
    handlers.set(signal, handler);
    signal.addEventListener("abort", handler, { once: true });
  }
  return {
    signal: controller.signal,
    dispose() {
      for (const [signal, handler] of handlers) signal.removeEventListener("abort", handler);
    },
  };
}

async function vertexError(res: Response): Promise<VertexHttpError> {
  let detail = "";
  try {
    detail = await res.text();
  } catch {
    /* ignore */
  }
  let message = `Vertex AI error (${res.status})`;
  if (detail) {
    try {
      const parsed = JSON.parse(detail);
      message = parsed?.error?.message || message;
    } catch {
      message = detail.slice(0, 300);
    }
  }
  const err = new Error(message) as VertexHttpError;
  err.status = res.status;
  return err;
}

/** Wrap raw little-endian 16-bit PCM mono samples in a minimal WAV container. */
export function pcmToWav(
  pcm: Buffer,
  sampleRate = 24000,
  channels = 1,
  bitsPerSample = 16
): Buffer<ArrayBuffer> {
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function parsePcmSampleRate(mimeType: string | undefined): number {
  if (!mimeType) return 24000;
  const match = /rate=(\d+)/i.exec(mimeType);
  return match ? parseInt(match[1], 10) : 24000;
}

export function extractInlineAudio(data: unknown): { base64: string; mimeType: string } | null {
  const parts = (data as { candidates?: Array<{ content?: { parts?: unknown[] } }> })
    ?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return null;
  for (const part of parts) {
    const inline = (part as { inlineData?: { data?: unknown; mimeType?: unknown } })?.inlineData;
    if (inline && typeof inline.data === "string" && inline.data.length > 0) {
      return {
        base64: inline.data,
        mimeType: typeof inline.mimeType === "string" ? inline.mimeType : "audio/L16;rate=24000",
      };
    }
  }
  return null;
}

function extractText(data: unknown): string {
  const parts = (data as { candidates?: Array<{ content?: { parts?: unknown[] } }> })
    ?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) => (part as { text?: unknown })?.text)
    .filter((text): text is string => typeof text === "string")
    .join("")
    .trim();
}

/** Gemini TTS → WAV audio buffer. */
export async function vertexGenerateSpeech(
  credentials: VertexMediaCredentials,
  options: { model: string; input: string; voice?: string; signal?: AbortSignal }
): Promise<{ audio: Buffer<ArrayBuffer>; contentType: string }> {
  const auth = await resolveVertexAuth(credentials, options.signal);
  const { url, headers } = buildModelRequest(auth, options.model, "generateContent");
  const payload = {
    contents: [{ role: "user", parts: [{ text: options.input }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: options.voice && options.voice.trim() ? options.voice.trim() : "Kore",
          },
        },
      },
    },
  };
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: options.signal,
  });
  if (!res.ok) throw await vertexError(res);
  const data = await res.json();
  const inline = extractInlineAudio(data);
  if (!inline) throw new Error("Vertex TTS returned no audio content");
  const pcm = Buffer.from(inline.base64, "base64");
  return { audio: pcmToWav(pcm, parsePcmSampleRate(inline.mimeType)), contentType: "audio/wav" };
}

/** Gemini transcription (audio → text). `audioBase64` is the raw file bytes, base64-encoded. */
export async function vertexTranscribe(
  credentials: VertexMediaCredentials,
  options: {
    model: string;
    audioBase64: string;
    mimeType?: string;
    prompt?: string;
    language?: string;
    signal?: AbortSignal;
  }
): Promise<string> {
  const auth = await resolveVertexAuth(credentials, options.signal);
  const { url, headers } = buildModelRequest(auth, options.model, "generateContent");
  const instruction =
    options.prompt && options.prompt.trim().length > 0
      ? options.prompt.trim()
      : `Transcribe this audio verbatim. Output only the spoken words${
          options.language ? ` (language: ${options.language})` : ""
        }, with no commentary.`;
  const payload = {
    contents: [
      {
        role: "user",
        parts: [
          { text: instruction },
          { inlineData: { mimeType: options.mimeType || "audio/wav", data: options.audioBase64 } },
        ],
      },
    ],
  };
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: options.signal,
  });
  if (!res.ok) throw await vertexError(res);
  return extractText(await res.json());
}

/** Lyria music generation → { base64 WAV, format }. */
export async function vertexGenerateMusic(
  credentials: VertexMediaCredentials,
  options: {
    model?: string;
    prompt: string;
    negativePrompt?: string;
    sampleCount?: number;
    seed?: number;
    signal?: AbortSignal;
  }
): Promise<{ base64: string; format: string }> {
  const auth = await resolveVertexAuth(credentials, options.signal);
  const model = options.model && options.model.trim() ? options.model.trim() : "lyria-002";
  const { url, headers } = buildModelRequest(auth, model, "predict");
  const instance: Record<string, unknown> = { prompt: options.prompt };
  if (options.negativePrompt) instance.negative_prompt = options.negativePrompt;
  if (typeof options.seed === "number") instance.seed = options.seed;
  const parameters: Record<string, unknown> = {};
  if (typeof options.sampleCount === "number") parameters.sample_count = options.sampleCount;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ instances: [instance], parameters }),
    signal: options.signal,
  });
  if (!res.ok) throw await vertexError(res);
  const data = await res.json();
  const base64 = (data as { predictions?: Array<{ bytesBase64Encoded?: unknown }> })
    ?.predictions?.[0]?.bytesBase64Encoded;
  if (typeof base64 !== "string" || base64.length === 0) {
    throw new Error("Vertex Lyria returned no audio");
  }
  return { base64, format: "wav" };
}

/** Veo video generation (async long-running) → { base64 MP4 or gcsUri, format }. */
export async function vertexGenerateVideo(
  credentials: VertexMediaCredentials,
  options: {
    model: string;
    prompt: string;
    aspectRatio?: string;
    durationSeconds?: number;
    sampleCount?: number;
    negativePrompt?: string;
    image?: { bytesBase64Encoded: string; mimeType: string };
    pollIntervalMs?: number;
    maxWaitMs?: number;
    callerSignal?: AbortSignal | null;
  }
): Promise<{ base64?: string; url?: string; format: string }> {
  const deadline = createVeoDeadline(resolveVeoTimeout(options.maxWaitMs));
  const callerSignal = options.callerSignal;
  let submitDispatched = false;
  let operationAccepted = false;

  try {
    if (callerSignal?.aborted) throw new VertexVeoCallerCancelled(false);

    // The server-owned deadline starts before OAuth resolution, so a stalled token
    // exchange cannot consume unbounded time before the generation request begins.
    const authSignals = combineVeoSignals([deadline.signal, callerSignal]);
    let auth: ResolvedVertexAuth;
    try {
      auth = await deadline.run(
        () => resolveVertexAuth(credentials, authSignals.signal),
        "authentication"
      );
    } finally {
      authSignals.dispose();
    }
    if (callerSignal?.aborted) throw new VertexVeoCallerCancelled(false);
    const submit = buildModelRequest(auth, options.model, "predictLongRunning");

    const instance: Record<string, unknown> = { prompt: options.prompt };
    if (options.image) instance.image = options.image;
    const parameters: Record<string, unknown> = {
      sampleCount: typeof options.sampleCount === "number" ? options.sampleCount : 1,
    };
    if (options.aspectRatio) parameters.aspectRatio = options.aspectRatio;
    if (typeof options.durationSeconds === "number")
      parameters.durationSeconds = options.durationSeconds;
    if (options.negativePrompt) parameters.negativePrompt = options.negativePrompt;

    const submitRes = await deadline.run(() => {
      if (callerSignal?.aborted) throw new VertexVeoCallerCancelled(false);
      // Once fetch is called the server cannot know whether Vertex accepted the
      // operation if the socket/body fails. The handler marks that outcome terminal.
      submitDispatched = true;
      return fetch(submit.url, {
        method: "POST",
        headers: submit.headers,
        body: JSON.stringify({ instances: [instance], parameters }),
        signal: deadline.signal,
      });
    }, "submission");

    if (!submitRes.ok) {
      let upstreamError: VertexHttpError;
      try {
        upstreamError = await deadline.run(
          () => vertexError(submitRes),
          "submission response body"
        );
      } catch (error) {
        // The response headers already prove this was rejected. If only the
        // diagnostic body stalls, preserve the known HTTP status and its
        // retryability instead of turning a 429 into an ambiguous 504.
        if (error instanceof VertexVeoDeadlineExceeded) {
          upstreamError = veoFailureError(
            `Vertex AI error (${submitRes.status})`,
            submitRes.status,
            submitRes.status === 408 || submitRes.status >= 500
          );
        } else {
          throw error;
        }
      }
      if (callerSignal?.aborted) throw new VertexVeoCallerCancelled(true);
      // Explicit client/quota rejections are safe to route elsewhere. A timeout or
      // server error after dispatch is ambiguous because Vertex may have accepted it.
      if (submitRes.status === 408 || submitRes.status >= 500) upstreamError.terminal = true;
      throw upstreamError;
    }

    let operationName: unknown;
    try {
      const op = await deadline.run(() => submitRes.json(), "submission response body");
      operationName = (op as { name?: unknown })?.name;
    } catch (error) {
      if (error instanceof VertexVeoDeadlineExceeded) throw error;
      throw veoFailureError(
        "Vertex Veo accepted the request but returned an unreadable operation response",
        502,
        true
      );
    }
    if (typeof operationName !== "string" || operationName.length === 0) {
      throw veoFailureError(
        "Vertex Veo accepted the request but did not return an operation name",
        502,
        true
      );
    }
    operationAccepted = true;
    const poll = buildModelRequest(auth, options.model, "fetchPredictOperation");
    const intervalMs = resolveVeoPollInterval(options.pollIntervalMs);

    while (deadline.remainingMs() > 0) {
      await deadline.run(
        () => sleepWithVeoSignal(Math.min(intervalMs, deadline.remainingMs()), deadline.signal),
        "poll wait"
      );
      const pollRes = await deadline.run(
        () =>
          fetch(poll.url, {
            method: "POST",
            headers: poll.headers,
            body: JSON.stringify({ operationName }),
            signal: deadline.signal,
          }),
        "operation poll"
      );
      if (!pollRes.ok) {
        const upstreamError = await deadline.run(() => vertexError(pollRes), "poll response body");
        if (callerSignal?.aborted) throw new VertexVeoCallerCancelled(true);
        // The operation is already accepted. Never create a second operation via
        // combo after a polling transport/provider error.
        upstreamError.terminal = true;
        throw upstreamError;
      }

      let pollData: unknown;
      try {
        pollData = await deadline.run(() => pollRes.json(), "poll response body");
      } catch (error) {
        if (error instanceof VertexVeoDeadlineExceeded) throw error;
        throw veoFailureError(
          "Vertex Veo accepted operation returned an unreadable poll response",
          502,
          true
        );
      }
      if ((pollData as { done?: unknown })?.done) {
        if (callerSignal?.aborted) throw new VertexVeoCallerCancelled(true);
        const opError = (pollData as { error?: { code?: unknown; message?: unknown } })?.error;
        if (opError) {
          // Vertex has explicitly finished this operation with an error, so it is
          // safe for a combo to try another provider rather than duplicate work.
          const code = Number(opError.code);
          const status = Number.isInteger(code) && code >= 400 && code <= 599 ? code : 502;
          throw veoFailureError(String(opError.message || "Veo operation failed"), status);
        }

        const output = await deadline.run(async () => {
          const videos = (pollData as { response?: { videos?: unknown } })?.response?.videos;
          const video = Array.isArray(videos) ? (videos[0] as Record<string, unknown>) : null;
          if (video && typeof video.bytesBase64Encoded === "string") {
            return { base64: video.bytesBase64Encoded, format: "mp4" };
          }
          if (video && typeof video.gcsUri === "string") {
            return { url: video.gcsUri, format: "mp4" };
          }
          throw veoFailureError("Veo operation completed but returned no video", 502, true);
        }, "output processing");
        if (callerSignal?.aborted) throw new VertexVeoCallerCancelled(true);
        return output;
      }
    }
    throw new VertexVeoDeadlineExceeded("operation polling");
  } catch (error) {
    if (error instanceof VertexVeoCallerCancelled) {
      throw veoFailureError(error.message, 499, error.afterSubmit);
    }
    if (callerSignal?.aborted && !submitDispatched) {
      throw veoFailureError("Vertex Veo request cancelled before submission", 499);
    }
    const typedError = error as VertexHttpError;
    if (typeof typedError?.status === "number") {
      throw veoFailureError(typedError.message, typedError.status, typedError.terminal === true);
    }
    if (error instanceof VertexVeoDeadlineExceeded || deadline.isExpired()) {
      const phase = error instanceof VertexVeoDeadlineExceeded ? error.phase : "task";
      const cancelled = Boolean(callerSignal?.aborted && submitDispatched);
      throw veoFailureError(
        cancelled
          ? "Vertex Veo request cancelled after submission began"
          : `Vertex Veo ${phase} timed out`,
        cancelled ? 499 : 504,
        submitDispatched || operationAccepted
      );
    }
    if (callerSignal?.aborted && submitDispatched) {
      throw veoFailureError("Vertex Veo request cancelled after submission began", 499, true);
    }
    if (submitDispatched && !typedError?.status) {
      throw veoFailureError(
        operationAccepted
          ? "Vertex Veo accepted operation failed during polling or output processing"
          : "Vertex Veo submission outcome is unknown after a transport error",
        502,
        true
      );
    }
    if (typedError && typeof typedError.status === "number") {
      throw veoFailureError(typedError.message, typedError.status, typedError.terminal === true);
    }
    throw veoFailureError(error instanceof Error ? error.message : String(error), 502, false);
  } finally {
    deadline.dispose();
  }
}
