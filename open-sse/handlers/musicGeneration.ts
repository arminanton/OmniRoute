/**
 * Music Generation Handler
 *
 * Handles POST /v1/music/generations requests.
 * Proxies to upstream music generation providers.
 *
 * Supported provider formats:
 * - ComfyUI: submit audio workflow → poll → fetch output
 *
 * Response format (OpenAI-like):
 * {
 *   "created": 1234567890,
 *   "data": [{ "b64_json": "...", "format": "wav" }]
 * }
 */

import { getMusicProvider, parseMusicModel } from "../config/musicRegistry.ts";
import { kieExecutor } from "../executors/kie.ts";
import { vertexGenerateMusic } from "../executors/vertexMedia.ts";
import {
  ComfyWorkflowSubmitError,
  submitComfyWorkflow,
  pollComfyResult,
  fetchComfyOutput,
  extractComfyOutputFiles,
  resolveComfyUiBaseUrl,
} from "../utils/comfyuiClient.ts";
import { saveCallLog } from "@/lib/usageDb";
import {
  getKieCallbackUrl,
  getKieTaskId,
  isJsonObject,
  parseKieResultJson,
} from "../utils/kieTask.ts";
import { sanitizeErrorMessage } from "../utils/error.ts";
import { handleFalMusicGeneration } from "./mediaGeneration/fal.ts";
import { handleMinimaxMusicGeneration } from "./mediaGeneration/minimaxMusic.ts";

function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

function normalizeKieSunoModel(model: string): string {
  const map: Record<string, string> = {
    "suno-v3.5": "V3_5",
    "suno-v4.0": "V4",
  };
  return map[model] || model;
}

function normalizeKieMusicTracks(recordData: unknown): Array<Record<string, unknown>> {
  const record = isJsonObject(recordData) ? recordData : {};
  const data = isJsonObject(record.data) ? record.data : {};
  const response = isJsonObject(data.response) ? data.response : {};
  const resultJson = parseKieResultJson(recordData);
  const candidates = [
    response.sunoData,
    response.data,
    data.data,
    data.sunoData,
    resultJson.sunoData,
    resultJson.data,
    resultJson.result,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) {
      return candidate
        .map((track) =>
          isJsonObject(track) ? track : typeof track === "string" ? { audioUrl: track } : null
        )
        .filter((track): track is Record<string, unknown> => track !== null);
    }
  }

  const singleUrl =
    response.audioUrl ||
    response.audio_url ||
    data.resultUrl ||
    data.audio_url ||
    resultJson.audioUrl ||
    resultJson.audio_url ||
    resultJson.url;

  return typeof singleUrl === "string" && singleUrl.length > 0 ? [{ audioUrl: singleUrl }] : [];
}

/**
 * Handle music generation request
 */
export async function handleMusicGeneration({ body, credentials, log, signal, pollSignal }) {
  const { provider, model } = parseMusicModel(body.model);

  if (!provider) {
    return {
      success: false,
      status: 400,
      error: `Invalid music model: ${body.model}. Use format: provider/model`,
    };
  }

  const providerConfig = getMusicProvider(provider);
  if (!providerConfig) {
    return {
      success: false,
      status: 400,
      error: `Unknown music provider: ${provider}`,
    };
  }

  if (providerConfig.format === "vertex-lyria") {
    try {
      const { base64, format } = await vertexGenerateMusic(credentials, {
        model,
        prompt: String(body.prompt ?? ""),
        negativePrompt: typeof body.negative_prompt === "string" ? body.negative_prompt : undefined,
        sampleCount: typeof body.sample_count === "number" ? body.sample_count : undefined,
        seed: typeof body.seed === "number" ? body.seed : undefined,
        signal,
      });
      return {
        success: true,
        data: { created: Math.floor(Date.now() / 1000), data: [{ b64_json: base64, format }] },
      };
    } catch (err: any) {
      log?.error?.("MUSIC", `Vertex Lyria generation failed: ${err?.message}`);
      return {
        success: false,
        status: typeof err?.status === "number" ? err.status : 502,
        error: sanitizeErrorMessage(err?.message || "Vertex Lyria generation failed"),
      };
    }
  }

  if (providerConfig.format === "fal-ai-music") {
    // Fal queue handling is shared with the video route and currently owns its
    // own bounded poll lifecycle. Pass the request/admission signal for the
    // pre-dispatch and completed-artifact boundaries; the helper intentionally
    // keeps polling without it after Fal accepts a remote job.
    return handleFalMusicGeneration({
      model,
      provider,
      providerConfig,
      body,
      credentials,
      log,
      signal,
    });
  }

  if (providerConfig.format === "comfyui") {
    return handleComfyUIMusicGeneration({
      model,
      provider,
      providerConfig: {
        ...providerConfig,
        baseUrl: resolveComfyUiBaseUrl(credentials, providerConfig.baseUrl),
      },
      body,
      log,
      signal,
    });
  }

  if (providerConfig.format === "kie-music") {
    return handleKieMusicGeneration({
      model,
      provider,
      providerConfig,
      body,
      credentials,
      log,
      signal,
      pollSignal,
    });
  }

  if (providerConfig.format === "suno-music") {
    return handleSunoMusicGeneration({
      model,
      provider,
      providerConfig,
      body,
      credentials,
      log,
      signal,
      pollSignal,
    });
  }
  if (providerConfig.format === "udio-music") {
    return handleUdioMusicGeneration({
      model,
      provider,
      providerConfig,
      body,
      credentials,
      log,
      signal,
      pollSignal,
    });
  }

  if (providerConfig.format === "minimax-music") {
    return handleMinimaxMusicGeneration({
      model,
      provider,
      providerConfig,
      body,
      credentials,
      log,
      signal,
    });
  }

  return {
    success: false,
    status: 400,
    error: `Unsupported music format: ${providerConfig.format}`,
  };
}

/**
 * Handle ComfyUI music generation
 * Submits an audio generation workflow (Stable Audio / MusicGen), polls, fetches output
 */
async function handleComfyUIMusicGeneration({
  model,
  provider,
  providerConfig,
  body,
  log,
  signal,
}) {
  const startTime = Date.now();
  const duration = body.duration || 10; // seconds
  let promptAccepted = false;

  // Audio generation workflow template for ComfyUI
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
      class_type: "EmptyLatentAudio",
      inputs: { seconds: duration },
    },
    "5": {
      class_type: "KSampler",
      inputs: {
        seed: Math.floor(Math.random() * 2 ** 32),
        steps: body.steps || 100,
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
      class_type: "VAEDecodeAudio",
      inputs: { samples: ["5", 0], vae: ["1", 2] },
    },
    "7": {
      class_type: "SaveAudio",
      inputs: {
        filename_prefix: "omniroute_music",
        audio: ["6", 0],
      },
    },
  };

  if (log) {
    const promptPreview = String(body.prompt ?? "").slice(0, 60);
    log.info(
      "MUSIC",
      `${provider}/${model} (comfyui) | prompt: "${promptPreview}..." | duration: ${duration}s`
    );
  }

  try {
    const promptId = await submitComfyWorkflow(providerConfig.baseUrl, workflow, signal);
    promptAccepted = true;
    const historyEntry = await pollComfyResult(providerConfig.baseUrl, promptId, 300_000);
    // ComfyUI has no safe per-prompt interrupt endpoint for a running job.
    // Retain the awaited poll through completion, then skip result retrieval
    // when the caller or account lease was cancelled.
    if (signal?.aborted) {
      const error = "Music generation request cancelled";
      saveCallLog({
        method: "POST",
        path: "/v1/music/generations",
        status: 499,
        model: `${provider}/${model}`,
        provider,
        duration: Date.now() - startTime,
        error,
      }).catch(() => {});
      return { success: false, status: 499, terminal: true, error };
    }
    const outputFiles = extractComfyOutputFiles(historyEntry);

    const audioFiles = [];
    for (const file of outputFiles) {
      const buffer = await fetchComfyOutput(
        providerConfig.baseUrl,
        file.filename,
        file.subfolder,
        file.type,
        signal
      );
      const base64 = Buffer.from(buffer).toString("base64");
      audioFiles.push({ b64_json: base64, format: "wav" });
    }

    saveCallLog({
      method: "POST",
      path: "/v1/music/generations",
      status: 200,
      model: `${provider}/${model}`,
      provider,
      duration: Date.now() - startTime,
      responseBody: { audio_count: audioFiles.length },
    }).catch(() => {});

    return {
      success: true,
      data: { created: Math.floor(Date.now() / 1000), data: audioFiles },
    };
  } catch (err) {
    if (log) log.error("MUSIC", `${provider} comfyui error: ${err.message}`);
    const cancelled = signal?.aborted;
    const status = cancelled ? 499 : 502;
    const terminal =
      promptAccepted || (err instanceof ComfyWorkflowSubmitError && err.terminal) || cancelled;
    saveCallLog({
      method: "POST",
      path: "/v1/music/generations",
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
      error: cancelled
        ? "Music generation request cancelled"
        : sanitizeErrorMessage(err) || "Music provider error",
    };
  }
}

async function handleKieMusicGeneration({
  model,
  provider,
  providerConfig,
  body,
  credentials,
  log,
  signal,
  pollSignal,
}: {
  model: string;
  provider: string;
  providerConfig: {
    baseUrl: string;
    statusUrl?: string;
  };
  body: Record<string, unknown> & {
    prompt?: unknown;
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
  signal?: AbortSignal;
  /** Lease-only signal used after the provider accepts an asynchronous task. */
  pollSignal?: AbortSignal | null;
}) {
  const startTime = Date.now();
  const timeoutMs = Math.min(
    2_147_483_647,
    Number(body.timeout_ms) > 0 ? Number(body.timeout_ms) : 300_000
  );
  const pollIntervalMs = Number(body.poll_interval_ms) > 0 ? Number(body.poll_interval_ms) : 2500;
  const token = credentials?.apiKey || credentials?.accessToken;
  const baseUrl = providerConfig.baseUrl.replace(/\/$/, "");
  const prompt = typeof body.prompt === "string" ? body.prompt : String(body.prompt ?? "");

  if (!token) {
    return { success: false, status: 401, error: "KIE API key is required" };
  }

  // Check if model is a Market model
  const fullRegistry = getMusicProvider(provider);
  const modelEntry = fullRegistry?.models?.find((m) => m.id === model);
  const isMarket = modelEntry?.isMarket || model.includes("/");

  let url = "";
  let payload: Record<string, unknown> = {};

  if (isMarket) {
    url = `${baseUrl}/api/v1/jobs/createTask`;
    payload = {
      model,
      callBackUrl: getKieCallbackUrl(body),
      input: {
        prompt,
        instrumental: true,
      },
    };
  } else {
    url = `${baseUrl}/api/v1/generate`;
    payload = {
      prompt,
      customMode: false,
      instrumental: true,
      model: normalizeKieSunoModel(model),
      callBackUrl: getKieCallbackUrl(body),
    };
  }

  if (log) {
    const promptPreview = String(body.prompt ?? "").slice(0, 60);
    log.info(
      "MUSIC",
      `${provider}/${model} (${isMarket ? "market" : "direct"}) | prompt: "${promptPreview}..."`
    );
  }

  const deadlineAt = Date.now() + timeoutMs;
  const deadlineController = new AbortController();
  const deadlineError = Object.assign(new Error("KIE music generation timed out"), {
    name: "TimeoutError",
    status: 504,
  });
  const deadlineTimer = setTimeout(() => deadlineController.abort(deadlineError), timeoutMs);
  let taskId: string | null = null;
  let taskAccepted = false;

  try {
    // Check caller/lease cancellation before submit, then use a server-owned
    // deadline. The remote task cannot be cancelled once this POST is accepted.
    signal?.throwIfAborted();
    const endpoint = new URL(url).pathname;
    const createData = await kieExecutor.createTask({
      baseUrl,
      token,
      payload,
      endpoint,
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
        "KIE music generation did not return taskId";
      if (log) {
        log.error("MUSIC", `KIE createTask failed: ${JSON.stringify(createData)}`);
      }
      return { success: false, status: 502, terminal: true, error: errorMessage };
    }

    const statusUrl = isMarket
      ? `${baseUrl}/api/v1/jobs/recordInfo`
      : providerConfig.statusUrl && !providerConfig.statusUrl.includes("jobs/recordInfo")
        ? providerConfig.statusUrl
        : `${baseUrl}/api/v1/generate/record-info`;

    const pollTaskSignal = pollSignal
      ? AbortSignal.any([deadlineController.signal, pollSignal])
      : deadlineController.signal;
    const { data: recordData, state } = await kieExecutor.pollTask({
      statusUrl,
      taskId: String(taskId),
      token,
      timeoutMs: Math.max(0, deadlineAt - Date.now()),
      pollIntervalMs,
      signal: pollTaskSignal,
    });

    if (state === "success") {
      const tracks = normalizeKieMusicTracks(recordData);

      const audioFiles = tracks
        .map((track) =>
          typeof track.audioUrl === "string"
            ? track.audioUrl
            : typeof track.audio_url === "string"
              ? track.audio_url
              : typeof track.url === "string"
                ? track.url
                : null
        )
        .filter((url): url is string => typeof url === "string" && url.length > 0)
        .map((url: string) => ({ url, format: "mp3" }));

      saveCallLog({
        method: "POST",
        path: "/v1/music/generations",
        status: 200,
        model: `${provider}/${model}`,
        provider,
        duration: Date.now() - startTime,
        responseBody: { audio_count: audioFiles.length },
      }).catch(() => {});

      return {
        success: true,
        data: { created: Math.floor(Date.now() / 1000), data: audioFiles },
      };
    }

    const record = isJsonObject(recordData) ? recordData : {};
    const data = isJsonObject(record.data) ? record.data : {};
    const errorMessage = data.errorMessage || data.failMsg || record.msg || "KIE music task failed";
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
      error: sanitizeErrorMessage(err) || "Music provider error",
    };
  } finally {
    clearTimeout(deadlineTimer);
  }
}

async function handleSunoMusicGeneration({
  model,
  provider,
  providerConfig,
  body,
  credentials,
  log,
  signal,
  pollSignal,
}) {
  const startTime = Date.now();
  const cookie = credentials?.apiKey || credentials?.providerSpecificData?.cookie || "";
  if (!cookie) {
    return { success: false, status: 401, error: "Suno session cookie is required" };
  }
  const prompt = typeof body.prompt === "string" ? body.prompt : String(body.prompt ?? "");
  if (log) {
    log.info("MUSIC", `${provider}/${model} (suno) | prompt: "${prompt.slice(0, 60)}..."`);
  }
  try {
    const res = await fetch(providerConfig.baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        gpt_description_prompt: prompt,
        mv: model || "chirp-v3-5",
        prompt: body.lyrics || "",
        title: body.title || "",
        tags: body.tags || "",
        make_instrumental: body.instrumental || false,
      }),
      signal,
    });
    if (!res.ok) {
      const errorText = await res.text();
      saveCallLog({
        method: "POST",
        path: "/v1/music/generations",
        status: res.status,
        model: `${provider}/${model}`,
        provider,
        duration: Date.now() - startTime,
        error: errorText.slice(0, 500),
      }).catch(() => {});
      return { success: false, status: res.status, error: errorText };
    }
    const clips = await res.json();
    const ids = clips.map((c) => c.id).filter(Boolean);
    if (ids.length === 0) {
      saveCallLog({
        method: "POST",
        path: "/v1/music/generations",
        status: 502,
        model: `${provider}/${model}`,
        provider,
        duration: Date.now() - startTime,
        error: "No clips returned from Suno",
      }).catch(() => {});
      return { success: false, status: 502, error: "No clips returned from Suno" };
    }
    const deadline = Date.now() + 300000;
    // The provider cannot cancel a task after returning clip IDs. Continue
    // polling under the account lease and let the route report 499 after the
    // accepted job reaches a terminal state.
    const taskSignal = pollSignal === undefined ? signal : (pollSignal ?? undefined);
    while (Date.now() < deadline) {
      await sleepWithSignal(5000, taskSignal);
      const feedRes = await fetch(`${providerConfig.statusUrl}?ids=${ids.join(",")}`, {
        headers: { Cookie: cookie },
        signal: taskSignal,
      });
      const songs = await feedRes.json();
      const ready = songs.filter((s) => s.audio_url);
      if (ready.length > 0) {
        const audioRes = await fetch(ready[0].audio_url, { signal: taskSignal });
        if (!audioRes.ok) {
          return {
            success: false,
            status: audioRes.status,
            error: `Failed to download audio: ${audioRes.status}`,
          };
        }
        const buf = await audioRes.arrayBuffer();
        saveCallLog({
          method: "POST",
          path: "/v1/music/generations",
          status: 200,
          model: `${provider}/${model}`,
          provider,
          duration: Date.now() - startTime,
        }).catch(() => {});
        return {
          success: true,
          data: {
            created: Math.floor(Date.now() / 1000),
            data: [{ b64_json: Buffer.from(buf).toString("base64"), format: "mp3" }],
          },
        };
      }
    }
    saveCallLog({
      method: "POST",
      path: "/v1/music/generations",
      status: 504,
      model: `${provider}/${model}`,
      provider,
      duration: Date.now() - startTime,
      error: "Suno music generation timed out",
    }).catch(() => {});
    return { success: false, status: 504, error: "Suno music generation timed out" };
  } catch (err) {
    if (log) log.error("MUSIC", `${provider} suno error: ${err.message}`);
    saveCallLog({
      method: "POST",
      path: "/v1/music/generations",
      status: 502,
      model: `${provider}/${model}`,
      provider,
      duration: Date.now() - startTime,
      error: err.message,
    }).catch(() => {});
    return {
      success: false,
      status: 502,
      error: sanitizeErrorMessage(err) || "Music provider error",
    };
  }
}

async function handleUdioMusicGeneration({
  model,
  provider,
  providerConfig,
  body,
  credentials,
  log,
  signal,
  pollSignal,
}) {
  const startTime = Date.now();
  const cookie = credentials?.apiKey || credentials?.providerSpecificData?.cookie || "";
  if (!cookie) {
    return { success: false, status: 401, error: "Udio session cookie is required" };
  }
  const prompt = typeof body.prompt === "string" ? body.prompt : String(body.prompt ?? "");
  if (log) {
    log.info("MUSIC", `${provider}/${model} (udio) | prompt: "${prompt.slice(0, 60)}..."`);
  }
  try {
    const res = await fetch(providerConfig.baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ prompt, samplerOptions: { seed: -1 } }),
      signal,
    });
    if (!res.ok) {
      const errorText = await res.text();
      saveCallLog({
        method: "POST",
        path: "/v1/music/generations",
        status: res.status,
        model: `${provider}/${model}`,
        provider,
        duration: Date.now() - startTime,
        error: errorText.slice(0, 500),
      }).catch(() => {});
      return { success: false, status: res.status, error: errorText };
    }
    const data = await res.json();
    const trackIds = data.track_ids || [];
    if (trackIds.length === 0) {
      saveCallLog({
        method: "POST",
        path: "/v1/music/generations",
        status: 502,
        model: `${provider}/${model}`,
        provider,
        duration: Date.now() - startTime,
        error: "No tracks returned from Udio",
      }).catch(() => {});
      return { success: false, status: 502, error: "No tracks returned from Udio" };
    }
    const deadline = Date.now() + 300000;
    const taskSignal = pollSignal === undefined ? signal : (pollSignal ?? undefined);
    while (Date.now() < deadline) {
      await sleepWithSignal(5000, taskSignal);
      const statusRes = await fetch(
        `https://www.udio.com/api/songs?songIds=${trackIds.join(",")}`,
        { headers: { Cookie: cookie }, signal: taskSignal }
      );
      const songs = await statusRes.json();
      const ready = songs.filter((s) => s.finished && s.song_path);
      if (ready.length > 0) {
        const audioRes = await fetch(ready[0].song_path, { signal: taskSignal });
        if (!audioRes.ok) {
          return {
            success: false,
            status: audioRes.status,
            error: `Failed to download audio: ${audioRes.status}`,
          };
        }
        const buf = await audioRes.arrayBuffer();
        saveCallLog({
          method: "POST",
          path: "/v1/music/generations",
          status: 200,
          model: `${provider}/${model}`,
          provider,
          duration: Date.now() - startTime,
        }).catch(() => {});
        return {
          success: true,
          data: {
            created: Math.floor(Date.now() / 1000),
            data: [{ b64_json: Buffer.from(buf).toString("base64"), format: "mp3" }],
          },
        };
      }
    }
    saveCallLog({
      method: "POST",
      path: "/v1/music/generations",
      status: 504,
      model: `${provider}/${model}`,
      provider,
      duration: Date.now() - startTime,
      error: "Udio music generation timed out",
    }).catch(() => {});
    return { success: false, status: 504, error: "Udio music generation timed out" };
  } catch (err) {
    if (log) log.error("MUSIC", `${provider} udio error: ${err.message}`);
    saveCallLog({
      method: "POST",
      path: "/v1/music/generations",
      status: 502,
      model: `${provider}/${model}`,
      provider,
      duration: Date.now() - startTime,
      error: err.message,
    }).catch(() => {});
    return {
      success: false,
      status: 502,
      error: sanitizeErrorMessage(err) || "Music provider error",
    };
  }
}
