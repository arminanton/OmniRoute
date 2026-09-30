// Auto-extracted from open-sse/handlers/imageGeneration.ts in PR-#4582-batch
// Family: ideogram | Module: ideogram | Lines: 3559-3669 (111 LOC)
// Ref: see open-sse/handlers/imageGeneration.ts top-of-file comment for split rationale

import { saveCallLog } from "@/lib/usageDb";
import {
  fetchRemoteImage,
  RemoteMediaFetchError,
  createRemoteMediaFailureResult,
} from "@/shared/network/remoteImageFetch";
import { sanitizeErrorMessage } from "../../../utils/error.ts";

interface IdeogramGenerationParams {
  model: string;
  provider: string;
  providerConfig: { baseUrl: string; statusUrl?: string };
  body: Record<string, unknown>;
  credentials: { apiKey?: string };
  log?: { info: (tag: string, msg: string) => void; error: (tag: string, msg: string) => void };
  signal?: AbortSignal;
}

export async function handleIdeogramImageGeneration({
  model,
  provider,
  providerConfig,
  body,
  credentials,
  log,
  signal,
}: IdeogramGenerationParams) {
  const startTime = Date.now();
  const token = credentials?.apiKey || "";
  const prompt = typeof body.prompt === "string" ? body.prompt : String(body.prompt ?? "");
  if (log) {
    log.info("IMAGE", `${provider}/${model} (ideogram) | prompt: "${prompt.slice(0, 60)}..."`);
  }
  try {
    signal?.throwIfAborted();
    const res = await fetch(providerConfig.baseUrl, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json", "Api-Key": token },
      body: JSON.stringify({ prompt, aspect_ratio: "ASPECT_16_9", model: model || "V_3" }),
    });
    if (!res.ok) {
      const errorText = await res.text();
      saveCallLog({
        method: "POST",
        path: "/v1/images/generations",
        status: res.status,
        model: `${provider}/${model}`,
        provider,
        duration: Date.now() - startTime,
        error: errorText.slice(0, 500),
      }).catch(() => {});
      return { success: false, status: res.status, error: errorText };
    }
    const data = await res.json();
    if (data.data && data.data.length > 0) {
      const imgUrl = data.data[0].url;
      const { buffer: buf } = await fetchRemoteImage(imgUrl, {
        guard: "public-only",
        pinDns: true,
        signal,
      });
      saveCallLog({
        method: "POST",
        path: "/v1/images/generations",
        status: 200,
        model: `${provider}/${model}`,
        provider,
        duration: Date.now() - startTime,
      }).catch(() => {});
      return {
        success: true,
        data: {
          created: Math.floor(Date.now() / 1000),
          data: [{ b64_json: Buffer.from(buf).toString("base64") }],
        },
      };
    }
    saveCallLog({
      method: "POST",
      path: "/v1/images/generations",
      status: 502,
      model: `${provider}/${model}`,
      provider,
      duration: Date.now() - startTime,
      error: "No images returned from Ideogram",
    }).catch(() => {});
    return { success: false, status: 502, error: "No images returned from Ideogram" };
  } catch (err) {
    if (err instanceof RemoteMediaFetchError || signal?.aborted) {
      return createRemoteMediaFailureResult(err, signal);
    }
    if (log) log.error("IMAGE", `${provider} ideogram error: ${err.message}`);
    saveCallLog({
      method: "POST",
      path: "/v1/images/generations",
      status: 502,
      model: `${provider}/${model}`,
      provider,
      duration: Date.now() - startTime,
      error: err.message,
    }).catch(() => {});
    return {
      success: false,
      status: 502,
      error: `Image provider error: ${sanitizeErrorMessage((err as Error).message || err)}`,
    };
  }
}
