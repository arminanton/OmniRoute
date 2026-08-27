/**
 * MaxAI speech to text client.
 *
 * The Firefox web app records Ogg Opus bytes, labels the multipart file
 * `audio.webm` with `audio/webm`, and sends it to `/gpt/speech_to_text`.
 * The request uses MaxAI's normal signed headers and bearer credential. The
 * upstream response is `{status:"OK", data:{speech_text}}`.
 */
import { buildMaxaiSignedHeaders } from "./signing.ts";
import { ensureMaxaiConstants } from "./constantsStore.ts";
import { resolveMaxaiCredential } from "./credentials.ts";
import { maxaiStaticHeaders, MAXAI_BASE_URL } from "./protocol.ts";
import {
  maxaiAccessTokenNeedsRefresh,
  maxaiRefreshAccessToken,
  maxaiRefreshAccessTokenOnce,
} from "./refresh.ts";

export const MAXAI_STT_PATH = "/gpt/speech_to_text";
export const MAXAI_STT_TIMEOUT_MS = 30_000;

export interface MaxaiTranscriptionInput {
  file: Blob & { name?: unknown };
  providerSpecificData?: Record<string, unknown> | null;
  accessToken?: string | null;
  signal?: AbortSignal | null;
  fetchImpl?: typeof fetch;
  featureName?: "immersive_chat" | "sidebar";
  eventSource?: "web" | "browser";
  /** Stable connection id used to share an in-flight refresh across requests. */
  refreshScope?: string;
  /** Test seam; production matches the official client's 30 second timeout. */
  timeoutMs?: number;
  onCredentialsRefreshed?: (credentials: {
    accessToken: string;
    providerSpecificData: Record<string, unknown>;
  }) => void | Promise<void>;
  refreshAccessToken?: typeof maxaiRefreshAccessToken;
}

export interface MaxaiTranscriptionResult {
  ok: boolean;
  status: number;
  text?: string;
  error?: string;
}

function isSupportedWebmUpload(file: Blob & { name?: unknown }): boolean {
  const mediaType = file.type.trim().toLowerCase().split(";", 1)[0]?.trim() ?? "";
  if (mediaType) return mediaType === "audio/webm";
  return typeof file.name === "string" && /\.webm$/i.test(file.name.trim());
}

const EBML_SIGNATURE = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]);
const OGG_SIGNATURE = new TextEncoder().encode("OggS");
const OPUS_HEAD = new TextEncoder().encode("OpusHead");

function abortResult(signal: AbortSignal): MaxaiTranscriptionResult {
  const reason = signal.reason;
  const timedOut = reason instanceof DOMException && reason.name === "TimeoutError";
  return {
    ok: false,
    status: timedOut ? 504 : 499,
    error: timedOut ? "MaxAI transcription timed out" : "MaxAI transcription request aborted",
  };
}

function linkedTranscriptionSignal(
  parent: AbortSignal | null | undefined,
  timeoutMs: number
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) forwardAbort();
  else parent?.addEventListener("abort", forwardAbort, { once: true });

  const timeout = setTimeout(
    () => controller.abort(new DOMException("MaxAI transcription timed out", "TimeoutError")),
    timeoutMs
  );
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", forwardAbort);
    },
  };
}

function hasBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let offset = 0; offset <= haystack.length - needle.length; offset += 1) {
    for (let index = 0; index < needle.length; index += 1) {
      if (haystack[offset + index] !== needle[index]) continue outer;
    }
    return true;
  }
  return false;
}

async function hasCapturedAudioSignature(file: Blob): Promise<boolean> {
  if (file.size < EBML_SIGNATURE.length) return false;
  const prefix = new Uint8Array(await file.slice(0, 96).arrayBuffer());
  if (EBML_SIGNATURE.every((byte, index) => prefix[index] === byte)) return true;
  return (
    OGG_SIGNATURE.every((byte, index) => prefix[index] === byte) && hasBytes(prefix, OPUS_HEAD)
  );
}

/** Submit one captured audio blob to MaxAI and normalize its transcription. */
export async function transcribeMaxaiAudio(
  input: MaxaiTranscriptionInput
): Promise<MaxaiTranscriptionResult> {
  const timeoutMs =
    typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
      ? input.timeoutMs
      : MAXAI_STT_TIMEOUT_MS;
  const linked = linkedTranscriptionSignal(input.signal, timeoutMs);
  try {
    return await transcribeMaxaiAudioWithSignal({ ...input, signal: linked.signal });
  } finally {
    linked.dispose();
  }
}

async function transcribeMaxaiAudioWithSignal(
  input: MaxaiTranscriptionInput
): Promise<MaxaiTranscriptionResult> {
  if (input.signal?.aborted) return abortResult(input.signal);
  if (!isSupportedWebmUpload(input.file)) {
    return {
      ok: false,
      status: 415,
      error: "MaxAI transcription accepts WebM audio only",
    };
  }
  if (!(await hasCapturedAudioSignature(input.file))) {
    return {
      ok: false,
      status: 415,
      error: "MaxAI transcription requires WebM or captured Ogg Opus audio bytes",
    };
  }

  const credential = resolveMaxaiCredential(input.providerSpecificData, input.accessToken);
  if (!credential) {
    return { ok: false, status: 401, error: "MaxAI transcription credentials are incomplete" };
  }

  const doFetch = input.fetchImpl ?? fetch;
  let accessToken = credential.accessToken;
  if (credential.refreshToken && maxaiAccessTokenNeedsRefresh(accessToken)) {
    const refresh = input.refreshAccessToken ?? maxaiRefreshAccessToken;
    const refreshed = await maxaiRefreshAccessTokenOnce(
      input.refreshScope,
      {
        refreshToken: credential.refreshToken,
        deviceId: credential.deviceId,
        userId: credential.userId,
        signal: input.signal,
        fetchImpl: doFetch,
      },
      { run: refresh }
    );
    if (refreshed.ok && refreshed.accessToken) {
      accessToken = refreshed.accessToken;
      const refreshToken = refreshed.refreshToken ?? credential.refreshToken;
      try {
        await input.onCredentialsRefreshed?.({
          accessToken,
          providerSpecificData: {
            ...(input.providerSpecificData ?? {}),
            maxaiAccessToken: accessToken,
            ...(refreshToken ? { maxaiRefreshToken: refreshToken } : {}),
          },
        });
      } catch {
        // Persistence failure must not discard a token already minted for this request.
      }
    }
    if (input.signal?.aborted) return abortResult(input.signal);
  }

  const constants = await ensureMaxaiConstants({ fetchImpl: doFetch, signal: input.signal });
  if (input.signal?.aborted) return abortResult(input.signal);
  if (!constants) {
    return { ok: false, status: 401, error: "MaxAI signing constants are unavailable" };
  }

  const body = new FormData();
  // Firefox's captured request presents its Ogg Opus recording with this exact
  // WebM filename and media type, regardless of the recording's container bytes.
  const capturedAudio = input.file.slice(0, input.file.size, "audio/webm");
  body.append("audio_file", capturedAudio, "audio.webm");
  body.append("feature_name", input.featureName ?? "immersive_chat");
  body.append("prompt_name", "Use microphone");
  body.append("event_source", input.eventSource ?? "web");

  const { "Content-Type": _jsonContentType, ...staticHeaders } = maxaiStaticHeaders();
  const headers: Record<string, string> = {
    ...staticHeaders,
    ...buildMaxaiSignedHeaders(
      {
        path: MAXAI_STT_PATH,
        userId: credential.userId,
        deviceId: credential.deviceId,
      },
      constants
    ),
    Authorization: `Bearer ${accessToken}`,
  };

  let response: Response;
  try {
    response = await doFetch(MAXAI_BASE_URL + MAXAI_STT_PATH, {
      method: "POST",
      headers,
      body,
      signal: input.signal ?? undefined,
    });
  } catch (error) {
    if (input.signal?.aborted) return abortResult(input.signal);
    return {
      ok: false,
      status: 502,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const raw = await response.text().catch(() => "");
  if (input.signal?.aborted) return abortResult(input.signal);
  if (!response.ok) {
    return {
      ok: false,
      status: response.status === 418 ? 401 : response.status,
      error: raw.slice(0, 300),
    };
  }

  let parsed: {
    status?: unknown;
    detail?: unknown;
    data?: { speech_text?: unknown };
  };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return { ok: false, status: 502, error: "MaxAI transcription returned invalid JSON" };
  }

  if (parsed.status !== "OK") {
    return {
      ok: false,
      status: 502,
      error:
        typeof parsed.detail === "string"
          ? parsed.detail.slice(0, 300)
          : "MaxAI transcription failed",
    };
  }

  return {
    ok: true,
    status: 200,
    text: typeof parsed.data?.speech_text === "string" ? parsed.data.speech_text : "",
  };
}
