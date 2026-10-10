/**
 * Video Generation Handler
 *
 * Handles POST /v1/videos/generations requests. Proxies to upstream video
 * generation providers (ComfyUI AnimateDiff/SVD, SD WebUI AnimateDiff, and
 * more — see the per-format handlers below). Response format (OpenAI-like):
 * { "created": 1234567890, "data": [{ "url": "https://…", "format": "mp4" }] }
 */

import { getVideoProvider, parseVideoModel } from "../config/videoRegistry.ts";
import { getAccountAdmissionAbortStatus } from "../services/accountRequestAdmission.ts";
import { kieExecutor } from "../executors/kie.ts";
import { vertexGenerateVideo } from "../executors/vertexMedia.ts";
import { handleGoogleFlowVideoGeneration } from "./videoGeneration/googleFlowHandler.ts";
import { handleDeepinfraVideoGeneration } from "./videoGeneration/deepinfraHandler.ts";
import { handleLeonardoVideoGeneration } from "./videoGeneration/leonardoHandler.ts";
import { handleDashscopeVideoGeneration } from "./videoGeneration/dashscopeHandler.ts";
import { handleNovitaVideoGeneration } from "./videoGeneration/novitaHandler.ts";
import { handleXaiVideoGeneration } from "./videoGeneration/xaiGrokImagineHandler.ts";
import { handleSegmindVideoGeneration } from "./videoGeneration/providers/segmind.ts";
import { handleUcVideoGeneration } from "./videoGeneration/providers/ucVideo.ts";
import { handleAdobeFireflyVideoGeneration } from "./videoGeneration/adobeFireflyHandler.ts";
import { handleOpenAIVideoGeneration } from "./videoGeneration/openai.ts";
import { getVideoJobPreset, handleVideoJobGeneration } from "./videoGeneration/job.ts";
import {
  extractRunwayFailureMessage,
  normalizeRunwayVideoResult,
  resolvePositiveInteger,
  resolveRunwayDuration,
  resolveRunwayPromptImage,
  resolveRunwayRatio,
} from "./videoGeneration/runwayHelpers.ts";
import { getExecutor } from "../executors/index.ts";
import { getKieTaskId, isJsonObject, parseKieResultJson } from "../utils/kieTask.ts";
import {
  buildRunwayApiUrl,
  buildRunwayHeaders,
  RUNWAYML_IMAGE_REQUIRED_MODELS,
} from "../config/runway.ts";
import {
  createComfyWorkflowDeadline,
  ComfyWorkflowSubmitError,
  submitComfyWorkflow,
  pollComfyResult,
  fetchComfyOutput,
  extractComfyOutputFiles,
  resolveComfyUiBaseUrl,
} from "../utils/comfyuiClient.ts";
import { saveCallLog } from "@/lib/usageDb";
import { getAllCustomModels } from "@/lib/db/models";
import { sanitizeErrorMessage } from "../utils/error.ts";
import {
  FetchTimeoutError,
  fetchWithTimeout,
  getConfiguredTimeout,
} from "@/shared/utils/fetchTimeout";
import { handleFalVideoGeneration } from "./mediaGeneration/fal.ts";

/**
 * Resolve the base URL for OpenAI-compatible video generation endpoints.
 * Prefers providerSpecificData.baseUrl (from custom node config), falls back to
 * top-level credentials.baseUrl, then to the provided fallback.
 */
export function resolveVideoBaseUrl(
  credentials:
    { baseUrl?: unknown; providerSpecificData?: { baseUrl?: unknown } | null } | null | undefined,
  fallback: string
): string {
  const psd = credentials?.providerSpecificData;
  const psdBaseUrl =
    psd && typeof psd === "object" && typeof psd.baseUrl === "string" && psd.baseUrl.trim()
      ? psd.baseUrl.trim()
      : null;
  const topLevelBaseUrl =
    typeof credentials?.baseUrl === "string" && credentials.baseUrl.trim()
      ? credentials.baseUrl.trim()
      : null;
  const nodeBaseUrl = psdBaseUrl || topLevelBaseUrl;

  if (!nodeBaseUrl) return fallback;

  // Trim trailing slashes
  let normalized = nodeBaseUrl;
  while (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  if (normalized.endsWith("/videos/generations")) return normalized;
  const stripped = normalized.replace(/\/videos\/generations$/, "");
  return `${stripped}/videos/generations`;
}

function combineMediaSignals(...signals: Array<AbortSignal | null | undefined>) {
  const unique = [...new Set(signals.filter((signal): signal is AbortSignal => Boolean(signal)))];
  return unique.length > 1 ? AbortSignal.any(unique) : (unique[0] ?? null);
}

/**
 * Read generationConfig.preset from the custom model row for the given
 * provider/model id. Returns null when the model has no preset configured (or
 * the registry is unreadable), so callers can fall back to the sync path.
 */
async function getCustomModelVideoPreset(
  providerId: string,
  modelId: string
): Promise<string | null> {
  try {
    const customModelsMap = (await getAllCustomModels()) as Record<
      string,
      Array<Record<string, unknown>>
    >;
    const models = customModelsMap[providerId];
    if (!Array.isArray(models)) return null;
    for (const model of models) {
      if (!model || typeof model !== "object" || model.id !== modelId) continue;
      const generationConfig = model.generationConfig;
      if (
        generationConfig &&
        typeof generationConfig === "object" &&
        typeof (generationConfig as Record<string, unknown>).preset === "string"
      ) {
        return (generationConfig as Record<string, unknown>).preset as string;
      }
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Handle video generation request
 */

/**
 * Handle video generation request
 */
export async function handleVideoGeneration({
  body,
  credentials,
  log,
  resolvedProvider = null,
  signal = null,
  callerSignal = null,
  admissionSignal = null,
}) {
  let { provider, model } = parseVideoModel(body.model);
  if (resolvedProvider) {
    provider = resolvedProvider;
    model = body.model.startsWith(provider + "/")
      ? body.model.slice(provider.length + 1)
      : body.model;
  }

  if (!provider) {
    return {
      success: false,
      status: 400,
      error: `Invalid video model: ${body.model}. Use format: provider/model`,
    };
  }

  const providerConfig = getVideoProvider(provider);
  if (!providerConfig) {
    if (!resolvedProvider) {
      return {
        success: false,
        status: 400,
        error: `Unknown video provider: ${provider}`,
      };
    }
    // Custom provider node. When the custom model row carries a
    // generationConfig.preset (e.g. "agnes-video-job"), dispatch through the
    // submit → poll job pipeline; otherwise mirror the images route and use the
    // generic OpenAI-compatible handler with a synthetic config.
    const presetName = await getCustomModelVideoPreset(provider, model);
    if (presetName !== null) {
      if (!getVideoJobPreset(presetName)) {
        return {
          success: false,
          status: 502,
          error: `Unknown video job preset: ${presetName}`,
        };
      }
      if (log)
        log.info("VIDEO", `Custom model ${provider}/${model} — using job preset ${presetName}`);
      return handleVideoJobGeneration({
        model,
        presetName,
        body,
        credentials,
        log,
        callerSignal: callerSignal ?? signal,
      });
    }
    if (log)
      log.info("VIDEO", `Custom model ${provider}/${model} — using OpenAI-compatible handler`);
    const syntheticConfig = {
      id: provider,
      baseUrl: resolveVideoBaseUrl(
        credentials,
        "http://generative.language.googleapis.com/v1beta/openai/videos/generations"
      ),
      authType: "apikey",
      authHeader: "bearer",
      format: "openai-video",
    };
    return handleOpenAIVideoGeneration({
      model,
      body,
      credentials,
      provider,
      providerConfig: syntheticConfig,
      log,
      signal,
      callerSignal,
      admissionSignal,
    });
  }
  if (getVideoJobPreset(providerConfig.format)) {
    return handleVideoJobGeneration({
      model,
      presetName: providerConfig.format,
      body,
      credentials,
      log,
      callerSignal: callerSignal ?? signal,
    });
  }
  if (providerConfig.format === "openai-video") {
    return handleOpenAIVideoGeneration({
      model,
      provider,
      providerConfig,
      body,
      credentials,
      log,
      signal,
      callerSignal,
      admissionSignal,
    });
  }

  if (providerConfig.format === "vertex-veo") {
    return handleVertexVeoGeneration({
      model,
      body,
      credentials,
      log,
      callerSignal: callerSignal ?? signal,
    });
  }

  if (providerConfig.format === "fal-ai-video") {
    const result = await handleFalVideoGeneration({
      model,
      provider,
      providerConfig,
      body,
      credentials,
      log,
      signal,
      callerSignal,
      admissionSignal,
    });
    const abortStatus = getAccountAdmissionAbortStatus(callerSignal, admissionSignal);
    return abortStatus ? { ...result, success: false, status: abortStatus } : result;
  }

  if (providerConfig.format === "google-flow") {
    return handleGoogleFlowVideoGeneration({ model, providerConfig, body, credentials, log });
  }

  if (providerConfig.format === "comfyui") {
    const result = await handleComfyUIVideoGeneration({
      model,
      provider,
      providerConfig: {
        ...providerConfig,
        baseUrl: resolveComfyUiBaseUrl(credentials, providerConfig.baseUrl),
      },
      body,
      log,
      signal: combineMediaSignals(signal, callerSignal, admissionSignal),
      callerSignal,
      admissionSignal,
    });
    const abortStatus = getAccountAdmissionAbortStatus(callerSignal, admissionSignal);
    return abortStatus ? { ...result, success: false, status: abortStatus } : result;
  }

  if (providerConfig.format === "sdwebui-video") {
    return handleSDWebUIVideoGeneration({
      model,
      provider,
      providerConfig,
      body,
      log,
      signal,
      callerSignal,
      admissionSignal,
    });
  }

  if (providerConfig.format === "kie-video") {
    return handleKieVideoGeneration({ model, provider, providerConfig, body, credentials, log });
  }

  if (providerConfig.format === "runwayml") {
    return handleRunwayVideoGeneration({ model, provider, providerConfig, body, credentials, log });
  }

  if (providerConfig.format === "haiper-video") {
    return handleHaiperVideoGeneration({
      model,
      provider,
      providerConfig,
      body,
      credentials,
      log,
      callerSignal: callerSignal ?? signal,
    });
  }

  if (providerConfig.format === "veoaifree-web") {
    return handleVeoAiFreeVideoGeneration({ model, provider, body, credentials, log });
  }

  if (providerConfig.format === "leonardo-video") {
    return handleLeonardoVideoGeneration({
      model,
      provider,
      providerConfig,
      body,
      credentials,
      log,
      callerSignal,
    });
  }

  if (providerConfig.format === "deepinfra-video") {
    return handleDeepinfraVideoGeneration({
      model,
      provider,
      providerConfig,
      body,
      credentials,
      log,
      signal,
      callerSignal,
      admissionSignal,
    });
  }

  if (providerConfig.format === "dashscope-video") {
    return handleDashscopeVideoGeneration({
      model,
      provider,
      providerConfig,
      body,
      credentials,
      log,
    });
  }

  if (providerConfig.format === "segmind") {
    return handleSegmindVideoGeneration({
      model,
      provider,
      providerConfig,
      body,
      credentials,
      log,
    });
  }
  if (providerConfig.format === "novita-video") {
    return handleNovitaVideoGeneration({ model, provider, providerConfig, body, credentials, log });
  }
  if (providerConfig.format === "xai-video") {
    return handleXaiVideoGeneration({ model, provider, providerConfig, body, credentials, log });
  }
  if (providerConfig.format === "uc-video") {
    // UC (uncensored.com): one handler serves both surfaces, picking by
    // credential — persona web (Clerk JWT, un-metered, upload/generate + HEAD
    // poll) or uc-direct REST (X-api-key, metered, async submit + status poll).
    return handleUcVideoGeneration({
      model,
      provider,
      body,
      credentials,
      log,
      callerSignal: callerSignal ?? signal,
    });
  }
  if (providerConfig.format === "adobe-firefly-video") {
    return handleAdobeFireflyVideoGeneration({
      model,
      provider,
      providerConfig,
      body,
      credentials,
      log,
      signal,
    });
  }
  if (resolvedProvider) {
    // Custom provider with no matching built-in format — use OpenAI-compatible fallback
    return handleOpenAIVideoGeneration({
      model,
      provider,
      providerConfig,
      body,
      credentials,
      log,
      signal,
      callerSignal,
      admissionSignal,
    });
  }
  return {
    success: false,
    status: 400,
    error: `Unsupported video format: ${providerConfig.format}`,
  };
}

/**
 * Whether a video target is a single direct OpenAI-compatible request that can
 * be aborted with its caller. Asynchronous job presets are excluded because a
 * caller disconnect cannot cancel accepted provider-side work.
 */
export async function isCancellableDirectVideoTarget(
  provider: string,
  model: string,
  isCustomModel: boolean
): Promise<boolean> {
  if (isCustomModel) return (await getCustomModelVideoPreset(provider, model)) === null;
  const providerConfig = getVideoProvider(provider);
  return ["openai-video", "deepinfra-video", "sdwebui-video"].includes(
    providerConfig?.format ?? ""
  );
}

/**
 * Veo video generation via Vertex AI (predictLongRunning → poll → MP4).
 * Uses the Vertex chat credentials (Service Account JSON or Express key).
 */
async function handleVertexVeoGeneration({ model, body, credentials, log, callerSignal }) {
  try {
    const aspectRatio =
      typeof body.aspect_ratio === "string"
        ? body.aspect_ratio
        : typeof body.aspectRatio === "string"
          ? body.aspectRatio
          : typeof body.size === "string"
            ? body.size
            : undefined;
    const durationSeconds =
      typeof body.duration === "number"
        ? body.duration
        : typeof body.durationSeconds === "number"
          ? body.durationSeconds
          : undefined;

    const result = await vertexGenerateVideo(credentials, {
      model,
      prompt: String(body.prompt ?? ""),
      aspectRatio,
      durationSeconds,
      negativePrompt: typeof body.negative_prompt === "string" ? body.negative_prompt : undefined,
      maxWaitMs: body.timeout_ms ?? body.max_wait_ms ?? body.maxWaitMs,
      pollIntervalMs: body.poll_interval_ms,
      callerSignal,
    });

    const item = result.base64
      ? { b64_json: result.base64, format: result.format }
      : { url: result.url, format: result.format };

    return {
      success: true,
      data: { created: Math.floor(Date.now() / 1000), data: [item] },
    };
  } catch (err: any) {
    log?.error?.("VIDEO", `Vertex Veo generation failed: ${err?.message}`);
    return {
      success: false,
      status: typeof err?.status === "number" ? err.status : 502,
      ...(err?.terminal === true ? { terminal: true } : {}),
      error: sanitizeErrorMessage(err?.message || "Vertex Veo generation failed"),
    };
  }
}

/**
 * Handle ComfyUI video generation
 * Submits an AnimateDiff or SVD workflow, polls for completion, fetches output video
 */
async function handleVeoAiFreeVideoGeneration({ model, provider, body, credentials, log }) {
  const executor = await getExecutor(provider);
  if (!executor) {
    return { success: false, status: 400, error: `Unknown video provider: ${provider}` };
  }

  const prompt = String(body.prompt ?? "");
  const systemParts = [];
  if (body.size) systemParts.push(`aspect_ratio: ${body.size}`);
  if (body.aspect_ratio) systemParts.push(`aspect_ratio: ${body.aspect_ratio}`);

  const response = await executor.execute({
    model,
    body: {
      ...body,
      model: `${provider}/${model}`,
      messages: [
        ...(systemParts.length > 0 ? [{ role: "system", content: systemParts.join("\n") }] : []),
        { role: "user", content: prompt },
      ],
    },
    stream: false,
    credentials: credentials || { connectionId: "noauth" },
    signal: null,
    log,
  });

  const upstreamResponse = response instanceof Response ? response : response.response;
  if (!upstreamResponse.ok) {
    return {
      success: false,
      status: upstreamResponse.status || 502,
      error: await upstreamResponse.text().catch(() => "Video provider error"),
    };
  }

  const payload = await upstreamResponse.json().catch(() => null);
  const item = Array.isArray(payload?.data) ? payload.data[0] : null;
  if (
    !payload ||
    !Array.isArray(payload.data) ||
    payload.data.length !== 1 ||
    !item ||
    typeof item.b64_json !== "string" ||
    item.b64_json.trim().length === 0 ||
    item.format !== "mp4" ||
    typeof item.url === "string"
  ) {
    return {
      success: false,
      status: 502,
      error: {
        error: {
          message: "Veo AI Free did not return a valid MP4 artifact",
          type: "upstream_error",
          code: "VIDEO_ARTIFACT_UNAVAILABLE",
        },
      },
    };
  }

  return {
    success: true,
    data: payload,
  };
}

async function handleComfyUIVideoGeneration({
  model,
  provider,
  providerConfig,
  body,
  log,
  signal,
  callerSignal,
  admissionSignal,
}) {
  const startTime = Date.now();
  const [width, height] = (body.size || "512x512").split("x").map(Number);
  const frames = body.frames || 16;
  let promptAccepted = false;

  // AnimateDiff workflow template
  const workflow = {
    "1": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: model },
    },
    "2": {
      class_type: "CLIPTextEncode",
      inputs: { text: body.prompt, clip: ["1", 1] },
    },
    "3": {
      class_type: "CLIPTextEncode",
      inputs: { text: body.negative_prompt || "", clip: ["1", 1] },
    },
    "4": {
      class_type: "EmptyLatentImage",
      inputs: { width: width || 512, height: height || 512, batch_size: frames },
    },
    "5": {
      class_type: "KSampler",
      inputs: {
        seed: Math.floor(Math.random() * 2 ** 32),
        steps: body.steps || 20,
        cfg: body.cfg_scale || 7,
        sampler_name: "euler",
        scheduler: "normal",
        denoise: 1,
        model: ["1", 0],
        positive: ["2", 0],
        negative: ["3", 0],
        latent_image: ["4", 0],
      },
    },
    "6": {
      class_type: "VAEDecode",
      inputs: { samples: ["5", 0], vae: ["1", 2] },
    },
    "7": {
      class_type: "SaveAnimatedWEBP",
      inputs: {
        filename_prefix: "omniroute_video",
        fps: body.fps || 8,
        lossless: false,
        quality: 80,
        method: "default",
        images: ["6", 0],
      },
    },
  };

  if (log) {
    const promptPreview = String(body.prompt ?? "").slice(0, 60);
    log.info(
      "VIDEO",
      `${provider}/${model} (comfyui) | prompt: "${promptPreview}..." | frames: ${frames}`
    );
  }

  const deadline = createComfyWorkflowDeadline(300_000);
  try {
    const promptId = await submitComfyWorkflow(providerConfig.baseUrl, workflow, signal, {
      signal: deadline.signal,
      deadlineAt: deadline.deadlineAt,
    });
    promptAccepted = true;
    const historyEntry = await pollComfyResult(providerConfig.baseUrl, promptId, 300_000, {
      signal: deadline.signal,
      deadlineAt: deadline.deadlineAt,
    });
    // Keep the remote prompt and its account reservation awaited until the
    // history entry proves the job settled. Only cancel retrieval afterward.
    if (signal?.aborted) {
      return {
        success: false,
        status: getAccountAdmissionAbortStatus(callerSignal, admissionSignal) ?? 499,
        terminal: true,
        error: "Video generation request cancelled",
      };
    }
    const outputFiles = extractComfyOutputFiles(historyEntry);

    const videos = [];
    const outputSignal = combineMediaSignals(deadline.signal, signal);
    for (const file of outputFiles) {
      const buffer = await fetchComfyOutput(
        providerConfig.baseUrl,
        file.filename,
        file.subfolder,
        file.type,
        outputSignal,
        { deadlineAt: deadline.deadlineAt }
      );
      const base64 = Buffer.from(buffer).toString("base64");
      videos.push({ b64_json: base64, format: "webp" });
    }

    saveCallLog({
      method: "POST",
      path: "/v1/videos/generations",
      status: 200,
      model: `${provider}/${model}`,
      provider,
      duration: Date.now() - startTime,
      responseBody: { videos_count: videos.length },
    }).catch(() => {});

    return {
      success: true,
      data: { created: Math.floor(Date.now() / 1000), data: videos },
    };
  } catch (err) {
    if (log) log.error("VIDEO", `${provider} comfyui error: ${err.message}`);
    const abortStatus = getAccountAdmissionAbortStatus(callerSignal, admissionSignal);
    const callerCancelled = Boolean(callerSignal?.aborted || (signal?.aborted && !abortStatus));
    const knownSubmitStatus = err instanceof ComfyWorkflowSubmitError ? err.status : undefined;
    const status =
      abortStatus ??
      (callerCancelled ? 499 : (knownSubmitStatus ?? (deadline.expired ? 504 : 502)));
    const terminal =
      promptAccepted ||
      (err instanceof ComfyWorkflowSubmitError && err.terminal) ||
      status === 499 ||
      status === 503 ||
      status === 504;
    saveCallLog({
      method: "POST",
      path: "/v1/videos/generations",
      status,
      model: `${provider}/${model}`,
      provider,
      duration: Date.now() - startTime,
      error: err.message,
    }).catch(() => {});
    return {
      success: false,
      status,
      ...(terminal ? { terminal: true } : {}),
      error:
        abortStatus === 503
          ? "Provider account capacity lease lost"
          : status === 499
            ? "Video generation request cancelled"
            : sanitizeErrorMessage(err) || "Video provider error",
    };
  } finally {
    deadline.dispose();
  }
}

/**
 * Handle SD WebUI video generation via AnimateDiff extension
 * POST to the AnimateDiff API endpoint
 */
async function handleSDWebUIVideoGeneration({
  model,
  provider,
  providerConfig,
  body,
  log,
  signal,
  callerSignal,
  admissionSignal,
}) {
  const startTime = Date.now();
  const [width, height] = (body.size || "512x512").split("x").map(Number);
  const url = `${providerConfig.baseUrl}/animatediff/v1/generate`;

  const upstreamBody = {
    prompt: body.prompt,
    negative_prompt: body.negative_prompt || "",
    width: width || 512,
    height: height || 512,
    steps: body.steps || 20,
    cfg_scale: body.cfg_scale || 7,
    frames: body.frames || 16,
    fps: body.fps || 8,
  };

  if (log) {
    const promptPreview = String(body.prompt ?? "").slice(0, 60);
    log.info("VIDEO", `${provider}/${model} (sdwebui) | prompt: "${promptPreview}..."`);
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(upstreamBody),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      if (log)
        log.error("VIDEO", `${provider} error ${response.status}: ${errorText.slice(0, 200)}`);
      saveCallLog({
        method: "POST",
        path: "/v1/videos/generations",
        status: response.status,
        model: `${provider}/${model}`,
        provider,
        duration: Date.now() - startTime,
        error: errorText.slice(0, 500),
      }).catch(() => {});
      return {
        success: false,
        status: response.status,
        ...(response.status === 408 || response.status >= 500 ? { terminal: true } : {}),
        error: errorText,
      };
    }

    const data = await response.json();
    // SD WebUI AnimateDiff returns { video: "base64..." } or { images: [...] }
    const videos = [];
    if (data.video) {
      videos.push({ b64_json: data.video, format: "mp4" });
    } else if (data.images) {
      for (const img of data.images) {
        videos.push({ b64_json: typeof img === "string" ? img : img.image, format: "mp4" });
      }
    }

    saveCallLog({
      method: "POST",
      path: "/v1/videos/generations",
      status: 200,
      model: `${provider}/${model}`,
      provider,
      duration: Date.now() - startTime,
      responseBody: { videos_count: videos.length },
    }).catch(() => {});

    return {
      success: true,
      data: { created: Math.floor(Date.now() / 1000), data: videos },
    };
  } catch (err) {
    if (log) log.error("VIDEO", `${provider} sdwebui error: ${err.message}`);
    const abortStatus = getAccountAdmissionAbortStatus(callerSignal, admissionSignal);
    const status = abortStatus ?? 502;
    saveCallLog({
      method: "POST",
      path: "/v1/videos/generations",
      status,
      model: `${provider}/${model}`,
      provider,
      duration: Date.now() - startTime,
      error: err.message,
    }).catch(() => {});
    return {
      success: false,
      status,
      terminal: true,
      error: sanitizeErrorMessage(err) || "Video provider error",
    };
  }
}

function normalizeKieVideoResult(recordData: unknown): string[] {
  const record = isJsonObject(recordData) ? recordData : {};
  const data = isJsonObject(record.data) ? record.data : {};
  const response = isJsonObject(data.response) ? data.response : {};
  const resultJson = parseKieResultJson(recordData);

  const urls = Array.isArray(resultJson?.resultUrls)
    ? (resultJson.resultUrls as string[])
    : Array.isArray(resultJson?.videoUrls)
      ? (resultJson.videoUrls as string[])
      : Array.isArray(response.resultUrls)
        ? (response.resultUrls as string[])
        : [];

  return urls.filter((url: unknown) => typeof url === "string" && url.length > 0);
}

async function handleKieVideoGeneration({
  model,
  provider,
  providerConfig,
  body,
  credentials,
  log,
}: {
  model: string;
  provider: string;
  providerConfig: {
    baseUrl: string;
    statusUrl?: string;
  };
  body: Record<string, unknown> & {
    prompt?: unknown;
    duration?: unknown;
    aspect_ratio?: unknown;
    sound?: unknown;
    timeout_ms?: unknown;
    poll_interval_ms?: unknown;
  };
  credentials?: {
    apiKey?: string;
    accessToken?: string;
  } | null;
  log?: {
    info: (scope: string, message: string) => void;
    error: (scope: string, message: string) => void;
  } | null;
}) {
  const startTime = Date.now();
  const timeoutMs = Math.min(2_147_483_647, resolvePositiveInteger(body.timeout_ms, 300_000));
  const pollIntervalMs = Number(body.poll_interval_ms) > 0 ? Number(body.poll_interval_ms) : 2500;
  const token = credentials?.apiKey || credentials?.accessToken;
  const baseUrl = providerConfig.baseUrl.replace(/\/$/, "");
  const prompt = typeof body.prompt === "string" ? body.prompt : String(body.prompt ?? "");

  if (!token) {
    return { success: false, status: 401, error: "KIE API key is required" };
  }

  const payload = {
    model,
    input: {
      prompt,
      duration: body.duration ? String(body.duration) : "5",
      aspect_ratio: typeof body.aspect_ratio === "string" ? body.aspect_ratio : "16:9",
      sound: body.sound === true,
    },
  };

  if (log) {
    const promptPreview = String(body.prompt ?? "").slice(0, 60);
    log.info("VIDEO", `${provider}/${model} (kie-video) | prompt: "${promptPreview}..."`);
  }

  const deadlineAt = Date.now() + timeoutMs;
  const deadlineController = new AbortController();
  const deadlineError = Object.assign(new Error("KIE video generation timed out"), {
    name: "TimeoutError",
    status: 504,
  });
  const deadlineTimer = setTimeout(() => deadlineController.abort(deadlineError), timeoutMs);
  let taskId: string | null = null;
  let taskAccepted = false;

  try {
    const createData = await kieExecutor.createTask({
      baseUrl,
      token,
      payload,
      signal: deadlineController.signal,
    });
    taskId = getKieTaskId(createData);
    taskAccepted = Boolean(taskId);
    if (deadlineController.signal.aborted) throw deadlineController.signal.reason;
    if (!taskId) {
      const errorMessage =
        createData?.msg ||
        createData?.message ||
        createData?.error ||
        "KIE video generation did not return taskId";
      if (log) {
        log.error("VIDEO", `KIE createTask failed: ${JSON.stringify(createData)}`);
      }
      return { success: false, status: 502, terminal: true, error: errorMessage };
    }

    const statusUrl = providerConfig.statusUrl || `${baseUrl}/api/v1/jobs/recordInfo`;

    const { data: recordData, state } = await kieExecutor.pollTask({
      statusUrl,
      taskId: String(taskId),
      token,
      timeoutMs: Math.max(0, deadlineAt - Date.now()),
      pollIntervalMs,
      signal: deadlineController.signal,
    });

    if (state === "success") {
      const videoUrls = normalizeKieVideoResult(recordData);
      const videos = videoUrls.map((url) => ({ url, format: "mp4" }));

      saveCallLog({
        method: "POST",
        path: "/v1/videos/generations",
        status: 200,
        model: `${provider}/${model}`,
        provider,
        duration: Date.now() - startTime,
        responseBody: { videos_count: videos.length },
      }).catch(() => {});

      return {
        success: true,
        data: { created: Math.floor(Date.now() / 1000), data: videos },
      };
    }

    const record = isJsonObject(recordData) ? recordData : {};
    const data = isJsonObject(record.data) ? record.data : {};
    const errorMessage = data.failMsg || data.errorMessage || record.msg || "KIE video task failed";
    return { success: false, status: 502, error: String(errorMessage) };
  } catch (err: unknown) {
    const errorStatus =
      typeof err === "object" && err !== null && "status" in err
        ? Number((err as { status?: unknown }).status) || 502
        : 502;
    const timedOut =
      deadlineController.signal.aborted || errorStatus === 504 || Date.now() >= deadlineAt;
    const explicitRejection = [400, 401, 403, 404, 429].includes(errorStatus);
    return {
      success: false,
      status: timedOut ? 504 : errorStatus,
      ...(taskAccepted || timedOut || !explicitRejection ? { terminal: true } : {}),
      error: sanitizeErrorMessage(err) || "Video provider error",
    };
  } finally {
    clearTimeout(deadlineTimer);
  }
}

async function handleRunwayVideoGeneration({
  model,
  provider,
  providerConfig,
  body,
  credentials,
  log,
}) {
  const startTime = Date.now();
  const token = credentials?.apiKey || credentials?.accessToken;
  if (!token) {
    return { success: false, status: 400, error: "No credentials for Runway provider" };
  }

  const promptImage = resolveRunwayPromptImage(body);
  const useImageToVideo = Boolean(promptImage);
  if (!useImageToVideo && RUNWAYML_IMAGE_REQUIRED_MODELS.has(model)) {
    return {
      success: false,
      status: 400,
      error: `Runway model ${model} requires promptImage for image-to-video generation`,
    };
  }

  const ratio = resolveRunwayRatio(body);
  const duration = resolveRunwayDuration(body);
  const timeoutMs = Math.min(2_147_483_647, resolvePositiveInteger(body.timeout_ms, 300_000));
  const pollIntervalMs = Math.min(
    2_147_483_647,
    resolvePositiveInteger(body.poll_interval_ms, 5_000)
  );
  const submitUrl = buildRunwayApiUrl(
    useImageToVideo ? "/image_to_video" : "/text_to_video",
    providerConfig.baseUrl
  );
  const headers = buildRunwayHeaders(token);

  // prettier-ignore
  const upstreamBody: { model: typeof model; promptText: typeof body.prompt; ratio: typeof ratio; duration: typeof duration; promptImage?: typeof promptImage; seed?: number } = {
    model,
    promptText: body.prompt,
    ratio, duration,
  };

  if (useImageToVideo) upstreamBody.promptImage = promptImage;
  if (typeof body.seed === "number" && Number.isFinite(body.seed)) {
    upstreamBody.seed = Math.max(0, Math.floor(body.seed));
  }

  if (log) {
    const promptPreview = String(body.prompt ?? "").slice(0, 60);
    log.info(
      "VIDEO",
      `${provider}/${model} (runway ${useImageToVideo ? "image_to_video" : "text_to_video"}) | prompt: "${promptPreview}..."`
    );
  }

  const deadlineAt = Date.now() + timeoutMs;
  const deadlineController = new AbortController();
  const deadlineError = Object.assign(new Error("Runway task timed out"), {
    name: "TimeoutError",
    status: 504,
  });
  const deadlineTimer = setTimeout(() => deadlineController.abort(deadlineError), timeoutMs);
  let taskId = "";
  let taskAccepted = false;

  try {
    const submitResponse = await fetch(submitUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(upstreamBody),
      signal: deadlineController.signal,
    });

    if (!submitResponse.ok) {
      const errorText = await submitResponse.text();
      if (log) {
        log.error(
          "VIDEO",
          `${provider} submit error ${submitResponse.status}: ${errorText.slice(0, 200)}`
        );
      }
      saveCallLog({
        method: "POST",
        path: "/v1/videos/generations",
        status: submitResponse.status,
        model: `${provider}/${model}`,
        provider,
        duration: Date.now() - startTime,
        error: errorText.slice(0, 500),
      }).catch(() => {});
      return {
        success: false,
        status: submitResponse.status,
        ...(submitResponse.status >= 500 ? { terminal: true } : {}),
        error: errorText,
      };
    }

    const submitData = await submitResponse.json();
    taskId = typeof submitData?.id === "string" ? submitData.id : "";
    if (!taskId) {
      const errorText = `Runway submit did not return task id: ${JSON.stringify(submitData).slice(0, 400)}`;
      saveCallLog({
        method: "POST",
        path: "/v1/videos/generations",
        status: 502,
        model: `${provider}/${model}`,
        provider,
        duration: Date.now() - startTime,
        error: errorText,
      }).catch(() => {});
      return { success: false, status: 502, terminal: true, error: errorText };
    }
    taskAccepted = true;

    let lastTask = null;

    while (Date.now() < deadlineAt && !deadlineController.signal.aborted) {
      const taskResponse = await fetch(
        buildRunwayApiUrl(`/tasks/${encodeURIComponent(taskId)}`, providerConfig.baseUrl),
        {
          method: "GET",
          headers,
          signal: deadlineController.signal,
        }
      );

      if (!taskResponse.ok) {
        const errorText = await taskResponse.text();
        if (log) {
          log.error(
            "VIDEO",
            `${provider} poll error ${taskResponse.status}: ${errorText.slice(0, 200)}`
          );
        }
        saveCallLog({
          method: "POST",
          path: "/v1/videos/generations",
          status: taskResponse.status,
          model: `${provider}/${model}`,
          provider,
          duration: Date.now() - startTime,
          error: errorText.slice(0, 500),
          responseBody: { taskId, stage: "poll" },
        }).catch(() => {});
        return { success: false, status: taskResponse.status, terminal: true, error: errorText };
      }

      const task = await taskResponse.json();
      lastTask = task;
      const status = String(task?.status || "").toUpperCase();

      if (status === "SUCCEEDED") {
        const videos = await normalizeRunwayVideoResult(task, body, deadlineController.signal);
        saveCallLog({
          method: "POST",
          path: "/v1/videos/generations",
          status: 200,
          model: `${provider}/${model}`,
          provider,
          duration: Date.now() - startTime,
          responseBody: { videos_count: videos.length, taskId, mode: "async" },
        }).catch(() => {});
        return {
          success: true,
          data: { created: Math.floor(Date.now() / 1000), data: videos },
        };
      }

      if (RUNWAY_TERMINAL_FAILURE_STATUSES.has(status)) {
        const errorText =
          extractRunwayFailureMessage(task) || `Runway task failed with status ${status}`;
        saveCallLog({
          method: "POST",
          path: "/v1/videos/generations",
          status: 502,
          model: `${provider}/${model}`,
          provider,
          duration: Date.now() - startTime,
          error: errorText.slice(0, 500),
          responseBody: { taskId, status },
        }).catch(() => {});
        return { success: false, status: 502, error: errorText };
      }

      await sleepWithSignal(pollIntervalMs, deadlineController.signal);
    }

    const timeoutError = `Runway task timeout after ${timeoutMs}ms (taskId=${taskId}, status=${String(
      lastTask?.status || "unknown"
    )})`;
    saveCallLog({
      method: "POST",
      path: "/v1/videos/generations",
      status: 504,
      model: `${provider}/${model}`,
      provider,
      duration: Date.now() - startTime,
      error: timeoutError,
      responseBody: { taskId, status: lastTask?.status ?? null },
    }).catch(() => {});
    return { success: false, status: 504, terminal: true, error: timeoutError };
  } catch (err) {
    const timedOut = deadlineController.signal.aborted || Date.now() >= deadlineAt;
    const errorStatus =
      typeof err === "object" && err !== null && "status" in err
        ? Number((err as { status?: unknown }).status) || 502
        : 502;
    if (log) log.error("VIDEO", `${provider} runway error: ${err.message}`);
    saveCallLog({
      method: "POST",
      path: "/v1/videos/generations",
      status: timedOut ? 504 : errorStatus,
      model: `${provider}/${model}`,
      provider,
      duration: Date.now() - startTime,
      error: err.message,
    }).catch(() => {});
    return {
      success: false,
      status: timedOut ? 504 : errorStatus,
      ...(taskAccepted || timedOut ? { terminal: true } : {}),
      error: sanitizeErrorMessage(err) || "Video provider error",
    };
  } finally {
    clearTimeout(deadlineTimer);
  }
}

const RUNWAY_TERMINAL_FAILURE_STATUSES = new Set([
  "FAILED",
  "CANCELED",
  "CANCELLED",
  "ABORTED",
  "DELETED",
]);

const HAIPER_DEFAULT_TASK_TIMEOUT_MS = 300_000;
const HAIPER_MAX_TASK_TIMEOUT_MS = 600_000;
const HAIPER_DEFAULT_POLL_INTERVAL_MS = 5_000;
const HAIPER_MAX_TIMER_DELAY_MS = 2_147_483_647;

class HaiperDeadlineExceeded extends Error {
  constructor(readonly phase: string) {
    super(`Haiper video ${phase} exceeded the task deadline`);
    this.name = "HaiperDeadlineExceeded";
  }
}

function createHaiperTaskDeadline(timeoutMs: number) {
  const deadlineAt = Date.now() + timeoutMs;
  const controller = new AbortController();
  let expired = false;
  let phase = "task";

  const expire = (expiredPhase: string) => {
    if (expired) return;
    expired = true;
    phase = expiredPhase;
    controller.abort(new HaiperDeadlineExceeded(expiredPhase));
  };
  const timer = setTimeout(() => expire(phase), Math.min(timeoutMs, HAIPER_MAX_TIMER_DELAY_MS));

  return {
    signal: controller.signal,
    remainingMs: () => Math.max(0, deadlineAt - Date.now()),
    isExpired: () => expired || Date.now() >= deadlineAt,
    getPhase: () => phase,
    async run<T>(operation: () => Promise<T>, operationPhase: string): Promise<T> {
      phase = operationPhase;
      if (controller.signal.aborted || Date.now() >= deadlineAt) {
        expire(operationPhase);
        throw controller.signal.reason ?? new HaiperDeadlineExceeded(operationPhase);
      }

      let onAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () =>
          reject(controller.signal.reason ?? new HaiperDeadlineExceeded(operationPhase));
        controller.signal.addEventListener("abort", onAbort, { once: true });
      });

      try {
        const result = await Promise.race([Promise.resolve().then(operation), aborted]);
        if (Date.now() >= deadlineAt) {
          expire(operationPhase);
          throw controller.signal.reason ?? new HaiperDeadlineExceeded(operationPhase);
        }
        return result;
      } finally {
        if (onAbort) controller.signal.removeEventListener("abort", onAbort);
      }
    },
    dispose() {
      clearTimeout(timer);
      if (!controller.signal.aborted) controller.abort();
    },
  };
}

function haiperFailure(status: number, error: string, terminal = false) {
  return {
    success: false as const,
    status,
    ...(terminal ? { terminal: true as const } : {}),
    error,
  };
}

function isHaiperDeadlineExceeded(error: unknown): error is HaiperDeadlineExceeded {
  return error instanceof HaiperDeadlineExceeded;
}

async function handleHaiperVideoGeneration({
  model,
  provider,
  providerConfig,
  body,
  credentials,
  log,
  callerSignal,
}) {
  const startTime = Date.now();
  const token = credentials?.apiKey || "";
  const requestedTimeoutMs = Number(body.timeout_ms);
  const timeoutMs =
    Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
      ? Math.min(Math.floor(requestedTimeoutMs), HAIPER_MAX_TASK_TIMEOUT_MS)
      : HAIPER_DEFAULT_TASK_TIMEOUT_MS;
  const requestedPollIntervalMs = Number(body.poll_interval_ms);
  const pollIntervalMs =
    Number.isFinite(requestedPollIntervalMs) && requestedPollIntervalMs > 0
      ? Math.min(Math.floor(requestedPollIntervalMs), HAIPER_MAX_TIMER_DELAY_MS)
      : HAIPER_DEFAULT_POLL_INTERVAL_MS;
  if (callerSignal?.aborted) {
    return haiperFailure(499, "Haiper video request cancelled before submission");
  }

  const deadline = createHaiperTaskDeadline(Math.max(1, timeoutMs));
  let submitDispatched = false;
  let taskAccepted = false;
  let lastStatus = "unknown";
  const record = (status: number, error?: string) => {
    saveCallLog({
      method: "POST",
      path: "/v1/videos/generations",
      status,
      model: `${provider}/${model}`,
      provider,
      duration: Date.now() - startTime,
      ...(error ? { error: error.slice(0, 500) } : {}),
    }).catch(() => {});
  };
  const finish = (result: ReturnType<typeof haiperFailure> | { success: true; data: unknown }) =>
    callerSignal?.aborted
      ? haiperFailure(499, "Haiper video request cancelled after submission began", true)
      : result;

  try {
    const res = await deadline.run(() => {
      if (callerSignal?.aborted) {
        return Promise.reject(new Error("Haiper video request cancelled before submission"));
      }
      submitDispatched = true;
      return fetch(providerConfig.baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", HAIPER_KEY: token },
        body: JSON.stringify({ prompt: body.prompt, duration: 4, aspect_ratio: "16:9" }),
        signal: deadline.signal,
      });
    }, "task submission");

    if (!res.ok) {
      let errorText = `Haiper task submission failed (${res.status})`;
      try {
        errorText = await deadline.run(() => res.text(), "submission response handling");
      } catch (error) {
        // The HTTP status itself is definitive for ordinary 4xx responses. Avoid
        // allowing a stalled error body to turn a confirmed rejection into a retryable timeout.
        if (isHaiperDeadlineExceeded(error) && (res.status === 408 || res.status >= 500)) {
          const timeoutError = "Haiper task submission response timed out";
          record(callerSignal?.aborted ? 499 : 504, timeoutError);
          return finish(haiperFailure(callerSignal?.aborted ? 499 : 504, timeoutError, true));
        }
      }
      record(res.status, errorText);
      return finish(haiperFailure(res.status, errorText, res.status === 408 || res.status >= 500));
    }

    let submitData: any;
    try {
      submitData = await deadline.run(() => res.json(), "submission response handling");
    } catch (error) {
      if (isHaiperDeadlineExceeded(error)) throw error;
      throw new Error("Haiper returned an unreadable successful submission response", {
        cause: error,
      });
    }

    const jobId = typeof submitData?.job_id === "string" ? submitData.job_id : "";
    if (!jobId) {
      const errorText = "Haiper successful submission response did not include job_id";
      record(502, errorText);
      return finish(haiperFailure(502, errorText, true));
    }
    taskAccepted = true;

    while (deadline.remainingMs() > 0) {
      if (deadline.remainingMs() <= 0) break;
      const statusRes = await deadline.run(
        () =>
          fetch(`${providerConfig.statusUrl}/${encodeURIComponent(jobId)}`, {
            headers: { HAIPER_KEY: token },
            signal: deadline.signal,
          }),
        "task poll"
      );
      if (!statusRes.ok) {
        let errorText = `Haiper accepted job ${jobId} but polling returned HTTP ${statusRes.status}`;
        try {
          errorText = await deadline.run(() => statusRes.text(), "poll response handling");
        } catch (error) {
          if (isHaiperDeadlineExceeded(error)) throw error;
        }
        record(callerSignal?.aborted ? 499 : statusRes.status, errorText);
        return finish(
          haiperFailure(callerSignal?.aborted ? 499 : statusRes.status, errorText, true)
        );
      }

      let status: any;
      try {
        status = await deadline.run(() => statusRes.json(), "poll response handling");
      } catch (error) {
        if (isHaiperDeadlineExceeded(error)) throw error;
        throw new Error(`Haiper accepted job ${jobId} but returned an unreadable poll response`, {
          cause: error,
        });
      }
      lastStatus = String(status?.status || "unknown").toLowerCase();

      if (lastStatus === "failed") {
        const errorText = status?.error || status?.message || "Haiper video generation failed";
        record(callerSignal?.aborted ? 499 : 502, errorText);
        // A provider-confirmed FAILED task cannot still be running, so another
        // combo target may safely be attempted when the caller remains connected.
        return finish(haiperFailure(502, errorText));
      }

      if (lastStatus === "completed" || lastStatus === "succeeded") {
        if (callerSignal?.aborted) {
          record(499, "Haiper video request cancelled after task completion");
          return haiperFailure(499, "Haiper video request cancelled after submission began", true);
        }
        const videoUrl = status?.creation_url || status?.output?.video_url;
        if (!videoUrl) {
          const errorText = `Haiper job ${jobId} completed without a video URL`;
          record(502, errorText);
          return haiperFailure(502, errorText, true);
        }
        const outputSignal = combineMediaSignals(deadline.signal, callerSignal) ?? deadline.signal;
        const videoRes = await deadline.run(
          () => fetch(videoUrl, { signal: outputSignal }),
          "output download"
        );
        if (!videoRes.ok) {
          void videoRes.body?.cancel().catch(() => {});
          const errorText = `Haiper output download returned HTTP ${videoRes.status}`;
          record(callerSignal?.aborted ? 499 : videoRes.status, errorText);
          return finish(
            haiperFailure(callerSignal?.aborted ? 499 : videoRes.status, errorText, true)
          );
        }
        const buf = await deadline.run(() => videoRes.arrayBuffer(), "output download body");
        record(callerSignal?.aborted ? 499 : 200);
        return finish({
          success: true,
          data: {
            created: Math.floor(Date.now() / 1000),
            data: [{ b64_json: Buffer.from(buf).toString("base64"), format: "mp4" }],
          },
        });
      }

      const waitMs = Math.min(pollIntervalMs, deadline.remainingMs());
      if (waitMs <= 0) break;
      await deadline.run(() => sleepWithSignal(waitMs, deadline.signal), "poll interval");
    }

    const timeoutError = `Haiper job ${jobId} timed out after ${timeoutMs}ms (status: ${lastStatus})`;
    const timedOutStatus = callerSignal?.aborted ? 499 : 504;
    record(timedOutStatus, timeoutError);
    return haiperFailure(
      timedOutStatus,
      callerSignal?.aborted ? "Haiper video request cancelled" : timeoutError,
      true
    );
  } catch (error) {
    const timedOut = isHaiperDeadlineExceeded(error) || deadline.isExpired();
    const callerCancelled = Boolean(callerSignal?.aborted);
    const status = callerCancelled ? 499 : timedOut ? 504 : 502;
    const message = callerCancelled
      ? "Haiper video request cancelled after submission began"
      : timedOut
        ? `Haiper video ${isHaiperDeadlineExceeded(error) ? error.phase : deadline.getPhase()} timed out`
        : error instanceof Error
          ? error.message
          : "Haiper video provider error";
    record(status, message);
    if (log?.error) log.error("VIDEO", `${provider} Haiper error: ${message}`);
    return haiperFailure(
      status,
      message,
      submitDispatched || taskAccepted || timedOut || callerCancelled
    );
  } finally {
    deadline.dispose();
  }
}

function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
