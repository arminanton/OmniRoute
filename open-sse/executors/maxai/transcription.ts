/**
 * MaxAI speech to text client.
 *
 * The web app records microphone audio as WebM and sends a multipart request to
 * `/gpt/speech_to_text`. The request uses MaxAI's normal signed headers and
 * bearer credential. The upstream response is `{status:"OK", data:{speech_text}}`.
 */
import { buildMaxaiSignedHeaders } from "./signing.ts";
import { ensureMaxaiConstants } from "./constantsStore.ts";
import { resolveMaxaiCredential } from "./credentials.ts";
import { maxaiStaticHeaders, MAXAI_BASE_URL } from "./protocol.ts";

export const MAXAI_STT_PATH = "/gpt/speech_to_text";

export interface MaxaiTranscriptionInput {
  file: Blob & { name?: unknown };
  providerSpecificData?: Record<string, unknown> | null;
  accessToken?: string | null;
  signal?: AbortSignal | null;
  fetchImpl?: typeof fetch;
  featureName?: "immersive_chat" | "sidebar";
  eventSource?: "web" | "browser";
}

export interface MaxaiTranscriptionResult {
  ok: boolean;
  status: number;
  text?: string;
  error?: string;
}

function uploadedFileName(file: Blob & { name?: unknown }): string {
  if (typeof file.name !== "string" || !file.name.trim()) return "audio.webm";
  return file.name.replace(/[\r\n"\\/]/g, "_");
}

/** Submit one captured audio blob to MaxAI and normalize its transcription. */
export async function transcribeMaxaiAudio(
  input: MaxaiTranscriptionInput
): Promise<MaxaiTranscriptionResult> {
  const credential = resolveMaxaiCredential(input.providerSpecificData, input.accessToken);
  if (!credential) {
    return { ok: false, status: 401, error: "MaxAI transcription credentials are incomplete" };
  }

  const doFetch = input.fetchImpl ?? fetch;
  const constants = await ensureMaxaiConstants({ fetchImpl: doFetch, signal: input.signal });
  if (!constants) {
    return { ok: false, status: 401, error: "MaxAI signing constants are unavailable" };
  }

  const body = new FormData();
  body.append("audio_file", input.file, uploadedFileName(input.file));
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
    Authorization: `Bearer ${credential.accessToken}`,
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
    return {
      ok: false,
      status: 502,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const raw = await response.text().catch(() => "");
  if (!response.ok) {
    return { ok: false, status: response.status, error: raw.slice(0, 300) };
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
