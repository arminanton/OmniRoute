// MaxAI (web-app) image-generation handler.
// Family: maxai-image | Provider: maxai
//
// MaxAI exposes 6 image models (gpt-image-1, dall-e-3, flux-1-schnell/dev/pro,
// sd3-medium) behind a SINGLE synchronous endpoint:
//   POST https://api.maxai.me/gpt/get_image_generate_response
//   body {prompt, style, size, n, model_name}
//   -> {status:"OK", data:[{webp_url, png_url}]}
// No submit-then-poll (unlike Microsoft Designer) — one request returns the
// image URLs. Auth reuses the EXISTING signed-executor pieces (the same
// X-Authorization signer + Firefox-150 identity the chat path uses); the signer
// signs whatever `path` it is given, so image and chat share one auth module.
//
// Refresh, signing-bundle fetches and image requests share one verified,
// connection-selected residential Firefox-150 transport. No ambient fetch fallback.

import { isRuntimePolicyError } from "@/shared/runtimePolicy";
import { resolveMaxaiCredential } from "../../../executors/maxai/credentials.ts";
import { ensureFreshMaxaiCredential } from "../../../executors/maxai/refresh.ts";
import { maxaiFetch, runMaxaiConnectionTransport } from "../../../services/maxaiTransport.ts";
import { buildMaxaiSignedHeaders } from "../../../executors/maxai/signing.ts";
import { ensureMaxaiConstants } from "../../../executors/maxai/constantsStore.ts";
import { MAXAI_BASE_URL, maxaiStaticHeaders } from "../../../executors/maxai/protocol.ts";
import { sanitizeErrorMessage } from "../../../utils/error.ts";
import { saveImageErrorResult, saveImageSuccessResult } from "../../imageGeneration.ts";

export const MAXAI_IMAGE_PATH = "/gpt/get_image_generate_response";
const MAXAI_IMAGE_DEFAULT_SIZE = "1024x1024";
const MAXAI_IMAGE_N_MAX = 4;

// Models whose upstream REJECTS non-1024 sizes (verified: gpt-image-1/dall-e-3
// 500 on 256x256/512x512). The flux family + sd3-medium have no size constraint
// and pass the requested WxH through unchanged.
const MAXAI_STRICT_SIZE_MODELS: Record<string, Set<string>> = {
  "gpt-image-1": new Set(["1024x1024", "1024x1536", "1536x1024", "auto"]),
  "dall-e-3": new Set(["1024x1024", "1024x1792", "1792x1024"]),
};

const MAXAI_IMAGE_ALIASES: Record<string, string> = {
  "stable-diffusion-v3": "sd3-medium",
  "stable-diffusion-3-medium": "sd3-medium",
  "flux-1-schneil": "flux-1-schnell", // tolerate a common typo
};

/** Strip a `maxai/` or `mx/` prefix and resolve aliases to the canonical model id. */
export function resolveMaxaiImageModel(model: unknown): string {
  let m = typeof model === "string" ? model.trim() : "";
  if (m.startsWith("maxai/")) m = m.slice("maxai/".length);
  else if (m.startsWith("mx/")) m = m.slice("mx/".length);
  return MAXAI_IMAGE_ALIASES[m] ?? m;
}

/**
 * Snap an OpenAI-style "WxH" size to something MaxAI accepts. gpt-image-1 /
 * dall-e-3 reject anything outside their bucket (→ upstream 500), so an
 * unsupported size (e.g. 512x512 from a standard OpenAI client) is snapped to
 * the model default. Models with no constraint pass the size through.
 */
export function snapMaxaiImageSize(model: string, size: unknown): string {
  const requested =
    typeof size === "string" && size.trim() ? size.trim() : MAXAI_IMAGE_DEFAULT_SIZE;
  const allowed = MAXAI_STRICT_SIZE_MODELS[model];
  if (!allowed) return requested; // flux / sd3: no constraint
  return allowed.has(requested) ? requested : MAXAI_IMAGE_DEFAULT_SIZE;
}

/** Pull image URLs out of MaxAI's response into OpenAI data[] items (prefer png_url). */
export function extractMaxaiImageUrls(json: unknown): string[] {
  // Accept either the raw items array or a { data: [...] } wrapper. MaxAI's real
  // response is { status:"OK", data:[{webp_url, png_url}] }, so both shapes occur
  // depending on how far the caller unwrapped.
  let items: unknown[] = [];
  if (Array.isArray(json)) {
    items = json;
  } else if (
    json &&
    typeof json === "object" &&
    Array.isArray((json as Record<string, unknown>).data)
  ) {
    items = (json as Record<string, unknown>).data as unknown[];
  }
  const urls: string[] = [];
  for (const it of items) {
    if (it && typeof it === "object") {
      const rec = it as Record<string, unknown>;
      const url =
        (typeof rec.png_url === "string" && rec.png_url) ||
        (typeof rec.webp_url === "string" && rec.webp_url) ||
        (typeof rec.url === "string" && rec.url) ||
        "";
      if (url) urls.push(url);
    }
  }
  return urls;
}

export async function handleMaxaiImageGeneration({
  model,
  provider,
  body,
  credentials,
  log,
  signal,
  connectionId = credentials?.connectionId,
  fetchImpl = maxaiFetch,
}: {
  model: string;
  provider: string;
  body: { prompt?: unknown; size?: unknown; n?: unknown; style?: unknown };
  credentials: {
    apiKey?: string;
    accessToken?: string;
    refreshToken?: string;
    connectionId?: string;
    providerSpecificData?: Record<string, unknown> | null;
  } | null;
  connectionId?: string | null;
  log?: { info?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void };
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}) {
  const startTime = Date.now();

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return saveImageErrorResult({
      provider,
      model,
      status: 400,
      startTime,
      error: "Prompt is required for MaxAI image generation",
    });
  }

  const credential = resolveMaxaiCredential(
    credentials?.providerSpecificData,
    credentials?.accessToken || credentials?.apiKey,
    credentials?.refreshToken
  );
  if (!credential) {
    return saveImageErrorResult({
      provider,
      model,
      status: 401,
      startTime,
      error: "MaxAI credentials missing access_token",
      retryable: true,
    });
  }

  if (typeof connectionId !== "string" || !connectionId.trim()) {
    return saveImageErrorResult({
      provider,
      model,
      status: 503,
      startTime,
      error: "MaxAI image generation requires a connection.",
    });
  }

  const canonicalModel = resolveMaxaiImageModel(model);
  const nRaw = Number(body.n);
  const n = Number.isFinite(nRaw) && nRaw >= 1 ? Math.min(Math.floor(nRaw), MAXAI_IMAGE_N_MAX) : 1;
  const requestBody = {
    prompt,
    style: typeof body.style === "string" && body.style ? body.style : "vivid",
    size: snapMaxaiImageSize(canonicalModel, body.size),
    n,
    model_name: canonicalModel,
  };

  try {
    signal?.throwIfAborted();
    return await runMaxaiConnectionTransport(connectionId, async () => {
      signal?.throwIfAborted();
      // Unified refresh commits rotation durably. Do not persist a stale
      // providerSpecificData snapshot from this handler or its route.
      const cred = await ensureFreshMaxaiCredential({
        connectionId,
        credential,
        signal,
        fetchImpl,
      });
      signal?.throwIfAborted();
      const constants = await ensureMaxaiConstants({ fetchImpl, signal });
      signal?.throwIfAborted();
      if (!constants) {
        return saveImageErrorResult({
          provider,
          model,
          status: 503,
          startTime,
          error: "MaxAI signing constants unavailable.",
        });
      }
      const headers: Record<string, string> = {
        ...maxaiStaticHeaders(),
        ...buildMaxaiSignedHeaders(
          { path: MAXAI_IMAGE_PATH, userId: cred.userId, deviceId: cred.deviceId },
          constants
        ),
        Authorization: `Bearer ${cred.accessToken}`,
        "Content-Type": "application/json",
      };

      const resp = await fetchImpl(MAXAI_BASE_URL + MAXAI_IMAGE_PATH, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal,
        redirect: "error",
      });
      signal?.throwIfAborted();

      if (!resp.ok) {
        // Never read/log credential-adjacent upstream error bodies.
        await resp.body?.cancel().catch(() => {});
        const error = `MaxAI image generation failed (HTTP ${resp.status}).`;
        log?.error?.("IMAGE", error);
        return saveImageErrorResult({
          provider,
          model,
          status: resp.status,
          startTime,
          error,
          requestBody,
          // Expired token or masked TLS rejection: select the next account.
          retryable: resp.status === 401 || resp.status === 418,
        });
      }

      let json: unknown;
      try {
        json = await resp.json();
      } catch {
        signal?.throwIfAborted();
        return saveImageErrorResult({
          provider,
          model,
          status: 502,
          startTime,
          error: "MaxAI returned a non-JSON image response.",
          requestBody,
        });
      }
      signal?.throwIfAborted();
      const status = (json as Record<string, unknown>)?.status;
      const urls = extractMaxaiImageUrls(json);
      if (status !== "OK" || urls.length === 0) {
        return saveImageErrorResult({
          provider,
          model,
          status: 502,
          startTime,
          error: "MaxAI image generation returned no images.",
          requestBody,
        });
      }

      return saveImageSuccessResult({
        provider,
        model,
        startTime,
        requestBody,
        responseBody: { images_count: urls.length },
        images: urls.map((url) => ({ url })),
      });
    });
  } catch (cause) {
    if (isRuntimePolicyError(cause)) throw cause;
    const error = sanitizeErrorMessage(
      signal?.aborted ? "MaxAI image generation cancelled." : "MaxAI image generation unavailable."
    );
    log?.error?.("IMAGE", error);
    return saveImageErrorResult({
      provider,
      model,
      status: signal?.aborted ? 499 : 503,
      startTime,
      error,
      requestBody,
      retryable: !signal?.aborted,
    });
  }
}
