/**
 * Async job/poll video generation for custom OpenAI-compatible provider nodes
 * whose /videos surface is a submit → poll → fetch-result API (e.g. Agnes
 * Video V2.0, muapi.ai, OpenAI Sora). Presets are declarative data — the
 * handler here is one family; everything else is per-preset config.
 *
 * Response shape stays OpenAI-like: { created, data: [{ url, format: "mp4" }] } so the
 * /v1/videos/generations route returns the same contract as the synchronous
 * path.
 */

import {
  fetchWithTimeout,
  FetchTimeoutError,
  getConfiguredTimeout,
} from "@/shared/utils/fetchTimeout";
import { sanitizeErrorMessage } from "../../utils/error.ts";

/**
 * A job preset owns one server-side budget from submit through final poll.
 * Five minutes is the normal ceiling; callers may request longer, but never
 * more than fifteen minutes. The per-request fetch timeout is also capped so
 * a large FETCH_TIMEOUT_MS cannot outlive the task budget.
 */
const DEFAULT_VIDEO_JOB_TIMEOUT_MS = 5 * 60_000;
const MAX_VIDEO_JOB_TIMEOUT_MS = 15 * 60_000;
const MAX_VIDEO_JOB_FETCH_TIMEOUT_MS = 120_000;
const MAX_VIDEO_JOB_POLLS = 300;
const MAX_VIDEO_JOB_POLL_INTERVAL_MS = 10_000;

interface LogLike {
  info?: (tag: string, msg: string, meta?: unknown) => void;
  warn?: (tag: string, msg: string, meta?: unknown) => void;
  error?: (tag: string, msg: string, meta?: unknown) => void;
}

interface CredentialsLike {
  providerSpecificData?: { baseUrl?: unknown } | null;
  baseUrl?: unknown;
  apiKey?: unknown;
  accessToken?: unknown;
}

/** Dot-path reader restricted to plain objects/arrays (no prototypes). */
function readPath(value: unknown, path: string): unknown {
  if (!path) return value;
  let current: unknown = value;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Non-empty string from a dot path, or null. */
function readStringPath(value: unknown, path: string): string | null {
  const found = readPath(value, path);
  return typeof found === "string" && found.trim() ? found : null;
}

function isDoneStatus(
  status: unknown,
  done: string[],
  failed: string[]
): "done" | "failed" | "pending" {
  if (typeof status !== "string") return "pending";
  if (failed.includes(status)) return "failed";
  if (done.includes(status)) return "done";
  return "pending";
}

export type VideoJobPreset = {
  id: string;
  displayName: string;
  /** auth header name plus value scheme */
  authHeaderName: "x-api-key" | "Authorization";
  authScheme: "bearer" | "raw";
  baseUrlFallback: string;
  submit: {
    method: "POST";
    /** may contain {model} — substituted before POST */
    path: string;
    buildBody: (params: {
      model?: string;
      prompt?: string;
      duration?: number;
      extras: Record<string, unknown>;
    }) => Record<string, unknown>;
  };
  /** dot path into the submit response identifying the job */
  taskIdPath: string;
  poll: {
    /** contains {taskId} */
    pathTemplate: string;
  };
  statusPath: string;
  statusDone: string[];
  statusFailed: string[];
  /** dot path into the poll response holding the finished video URL/array */
  resultPath: string;
  maxPolls: number;
  pollIntervalMs: number;
};

// #9820: declarative presets for the shipping async job/poll video providers.
const VIDEO_JOB_PRESETS: Record<string, VideoJobPreset> = {
  "agnes-video-job": {
    id: "agnes-video-job",
    displayName: "Agnes Video V2.0",
    authHeaderName: "Authorization",
    authScheme: "bearer",
    // Official Agnes flow: POST /v1/videos returns video_id, then the recommended
    // status endpoint GET /agnesapi?video_id=… exposes status and metadata.url.
    baseUrlFallback: "https://apihub.agnes-ai.com",
    submit: {
      method: "POST",
      path: "/v1/videos",
      buildBody: ({ model, prompt, extras }) => ({
        model,
        prompt,
        // passthrough of image/mode/num_frames/frame_rate/…  — the generic
        // route body uses .catchall, so provider-specific knobs survive.
        ...extras,
      }),
    },
    taskIdPath: "video_id",
    poll: { pathTemplate: "/agnesapi?video_id={taskId}" },
    statusPath: "status",
    statusDone: ["completed"],
    statusFailed: ["failed"],
    resultPath: "metadata.url",
    maxPolls: 60,
    pollIntervalMs: 2000,
  },
  "muapi-video-job": {
    id: "muapi-video-job",
    displayName: "muapi.ai",
    authHeaderName: "x-api-key",
    authScheme: "raw",
    // muapi.ai video/audio surface is Replicate-style: POST /api/v1/{model}
    // returns { request_id }; poll GET /api/v1/predictions/{id}/result.
    baseUrlFallback: "https://api.muapi.ai",
    submit: {
      method: "POST",
      path: "/api/v1/{model}",
      buildBody: (params) => {
        const { prompt, duration, extras } = params;
        return {
          prompt,
          ...(typeof duration === "number" ? { duration } : {}),
          ...extras,
        };
      },
    },
    taskIdPath: "request_id",
    poll: { pathTemplate: "/api/v1/predictions/{taskId}/result" },
    statusPath: "status",
    statusDone: ["completed"],
    statusFailed: ["failed"],
    resultPath: "outputs",
    maxPolls: 60,
    pollIntervalMs: 2000,
  },
  "sora-job": {
    id: "sora-job",
    displayName: "OpenAI Sora",
    authHeaderName: "Authorization",
    authScheme: "bearer",
    baseUrlFallback: "https://api.openai.com",
    submit: {
      method: "POST",
      path: "/v1/videos",
      buildBody: (params) => {
        const { model, prompt, duration, extras } = params;
        // seconds is a STRING enum ("4"|"8"|"12") in the Sora API; absolute
        // size mapping is intentionally not forced here.
        return {
          model,
          prompt,
          ...(typeof duration === "number" ? { seconds: String(duration) } : {}),
          ...extras,
        };
      },
    },
    taskIdPath: "id",
    poll: { pathTemplate: "/v1/videos/{taskId}" },
    statusPath: "status",
    statusDone: ["completed"],
    statusFailed: ["failed"],
    resultPath: "data",
    maxPolls: 60,
    pollIntervalMs: 2000,
  },
};

/** Resolve a configured job preset; null when the preset is unknown/none. */
export function getVideoJobPreset(presetName: unknown): VideoJobPreset | null {
  if (typeof presetName !== "string") return null;
  const preset = VIDEO_JOB_PRESETS[presetName];
  return preset ?? null;
}

/**
 * Handle a video-generation job via the submit→poll preset pipeline.
 * Returns the same shape as the sync handlers: { success, data?: …, status?, error? }.
 */
export async function handleVideoJobGeneration({
  model,
  presetName,
  body,
  credentials,
  log,
  maxPolls: maxPollsOverride,
  pollIntervalMs: pollIntervalOverride,
  timeoutMs: timeoutMsOverride,
  callerSignal,
}: {
  model: string;
  presetName: string;
  /** `timeout_ms` and `poll_interval_ms` are OmniRoute controls, not upstream extras. */
  body: Record<string, unknown> & { timeout_ms?: unknown; poll_interval_ms?: unknown };
  credentials?: unknown;
  log?: {
    info?: (tag: string, msg: string, meta?: unknown) => void;
    error?: (tag: string, msg: string) => void;
  };
  maxPolls?: number;
  pollIntervalMs?: number;
  /** Optional lifecycle budget, clamped to MAX_VIDEO_JOB_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Client disconnect signal. It is used for preflight/submit only. */
  callerSignal?: AbortSignal | null;
}) {
  const preset = getVideoJobPreset(presetName);
  if (!preset) {
    return {
      success: false,
      status: 400,
      error: `Unknown video job preset: ${presetName}`,
    };
  }

  const baseUrl = resolveJobBaseUrl(credentials, preset.baseUrlFallback);
  const startedAt = Date.now();
  const requestedTimeout = Number.isFinite(timeoutMsOverride)
    ? Math.max(1, Number(timeoutMsOverride))
    : resolvePositiveMs(body.timeout_ms, DEFAULT_VIDEO_JOB_TIMEOUT_MS);
  const timeoutMs = Math.min(MAX_VIDEO_JOB_TIMEOUT_MS, requestedTimeout);
  const deadlineAt = startedAt + timeoutMs;
  log?.info?.("VIDEO", `Job preset ${presetName} submitting ${model}`);
  log?.info?.("VIDEO", JSON.stringify({ baseUrl }));

  const bodyForPreset = preset.submit.buildBody({
    model: model,
    prompt: typeof body.prompt === "string" ? body.prompt : undefined,
    duration: typeof body.duration === "number" ? body.duration : undefined,
    // passthrough of the remainder — the API keeps catchall extras
    extras: Object.fromEntries(
      Object.entries(body ?? {}).filter(
        ([key]) =>
          key !== "model" &&
          key !== "prompt" &&
          key !== "duration" &&
          key !== "timeout_ms" &&
          key !== "poll_interval_ms"
      )
    ),
  });

  const submitPath = preset.submit.path.replace("{model}", encodeURIComponent(model));
  const submitUrl = `${baseUrl}${submitPath}`; // baseUrl never ends with "/"
  // Do not dispatch a job after the client has already gone away. During the
  // submit itself, caller abort is ambiguous: the provider may have accepted
  // the POST even though we did not receive its response, so that outcome is
  // terminal and must not be replayed through a combo fallback.
  if (callerSignal?.aborted) {
    return cancelledJobResult(false);
  }

  const submitResult = await fetchJson(submitUrl, {
    method: preset.submit.method,
    headers: buildJobHeaders(preset, credentials),
    body: JSON.stringify(bodyForPreset),
    log,
    deadlineAt,
    callerSignal,
    honorCallerAbort: true,
  });
  if (submitResult.ok === false) {
    return {
      success: false,
      status: submitResult.status,
      error: submitResult.error,
      // A transport timeout or server failure may have happened after the
      // provider accepted the job but before OmniRoute received its id.
      ...(submitResult.status === 408 || submitResult.status === 499 || submitResult.status >= 500
        ? { terminal: true }
        : {}),
    };
  }

  const taskId = readStringPath(submitResult.data, preset.taskIdPath);
  if (!taskId) {
    return {
      success: false,
      status: 502,
      terminal: true,
      error: `Video provider did not return a job id (${presetName})`,
    };
  }

  // Poll loop.
  const requestedPolls = Number.isFinite(maxPollsOverride) ? maxPollsOverride : preset.maxPolls;
  const requestedPollInterval = Number.isFinite(pollIntervalOverride)
    ? pollIntervalOverride
    : resolvePositiveMs(body.poll_interval_ms, preset.pollIntervalMs);
  const maxPolls = Math.min(MAX_VIDEO_JOB_POLLS, Math.max(1, Math.floor(requestedPolls)));
  const pollInterval = Math.min(
    MAX_VIDEO_JOB_POLL_INTERVAL_MS,
    Math.max(0, Math.floor(requestedPollInterval))
  );

  for (let attempt = 1; attempt <= maxPolls; attempt += 1) {
    const remainingBeforeWait = deadlineAt - Date.now();
    if (remainingBeforeWait <= 0) break;
    await waitFor(Math.min(pollInterval, remainingBeforeWait));
    if (Date.now() >= deadlineAt) break;
    const pollUrl = `${baseUrl}${preset.poll.pathTemplate.replace("{taskId}", encodeURIComponent(taskId))}`;
    const pollResult = await fetchJson(pollUrl, {
      method: "GET",
      headers: buildJobHeaders(preset, credentials),
      log,
      deadlineAt,
    });
    if (pollResult.ok === false) {
      // Client cancellation never cancels already accepted upstream work. We
      // continue observing it until a terminal status or the task deadline.
      // If an observation itself becomes impossible after cancellation, the
      // only useful client result is still 499, and it remains non-replayable.
      return {
        success: false,
        status: callerSignal?.aborted ? 499 : pollResult.status,
        terminal: true,
        error: callerSignal?.aborted ? "Video generation request cancelled" : pollResult.error,
      };
    }
    if (Date.now() >= deadlineAt) break;

    const status = readPath(pollResult.data, preset.statusPath);
    const jobState = isDoneStatus(status, preset.statusDone, preset.statusFailed);
    if (jobState === "done") {
      if (callerSignal?.aborted) return cancelledJobResult(true);
      const url = readResultUrl(pollResult.data, preset.resultPath);
      if (!url) {
        return {
          success: false,
          status: 502,
          error: `Video job completed but no result URL found (${presetName})`,
        };
      }
      log?.info?.("VIDEO", `Job completed after ${attempt} poll(s)`);
      return {
        success: true,
        data: {
          created: Math.floor(Date.now() / 1000),
          data: [{ url, format: "mp4" }],
        },
      };
    }
    if (jobState === "failed") {
      if (callerSignal?.aborted) return cancelledJobResult(true);
      return {
        success: false,
        status: 502,
        error: `Video job failed (${presetName})`,
      };
    }
  }

  return {
    success: false,
    status: callerSignal?.aborted ? 499 : 504,
    terminal: true,
    error: callerSignal?.aborted
      ? "Video generation request cancelled"
      : Date.now() >= deadlineAt
        ? `Video job exceeded its ${timeoutMs}ms deadline (${presetName})`
        : `Video job timed out after ${maxPolls} polls (${presetName})`,
  };
}

function cancelledJobResult(ambiguousOrAccepted: boolean) {
  return {
    success: false,
    status: 499,
    ...(ambiguousOrAccepted ? { terminal: true } : {}),
    error: "Video generation request cancelled",
  };
}

function waitFor(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolvePositiveMs(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function buildJobHeaders(preset: VideoJobPreset, credentials?: unknown): Record<string, string> {
  const creds = credentials as CredentialsLike | null | undefined;
  const apiKey =
    typeof creds?.apiKey === "string" && creds.apiKey
      ? creds.apiKey
      : typeof creds?.accessToken === "string" && creds.accessToken
        ? creds.accessToken
        : "";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (!apiKey) return headers;
  if (preset.authScheme === "raw") {
    headers[preset.authHeaderName] = apiKey;
  } else {
    headers[preset.authHeaderName] = `Bearer ${apiKey}`;
  }
  return headers;
}

function resolveJobBaseUrl(credentials: unknown, fallback: string): string {
  const creds = credentials as CredentialsLike | null | undefined;
  const psdBaseUrl =
    creds?.providerSpecificData?.baseUrl != null &&
    typeof creds.providerSpecificData.baseUrl === "string" &&
    creds.providerSpecificData.baseUrl.trim()
      ? (creds.providerSpecificData.baseUrl as string).trim()
      : null;
  const topLevelBaseUrl =
    creds?.baseUrl != null && typeof creds.baseUrl === "string" && creds.baseUrl.trim()
      ? (creds.baseUrl as string).trim()
      : null;
  const nodeBaseUrl = psdBaseUrl || topLevelBaseUrl;
  if (!nodeBaseUrl) return fallback.replace(/\/+$/, "");
  let normalized = nodeBaseUrl;
  while (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  return normalized;
}

async function fetchJson(
  url: string,
  {
    method,
    headers,
    body,
    log,
    deadlineAt,
    callerSignal,
    honorCallerAbort = false,
  }: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    log?: LogLike;
    deadlineAt: number;
    callerSignal?: AbortSignal | null;
    honorCallerAbort?: boolean;
  }
): Promise<{ ok: true; data: unknown } | { ok: false; status: number; error: string }> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    return {
      ok: false,
      status: callerSignal?.aborted ? 499 : 504,
      error: callerSignal?.aborted
        ? "Video generation request cancelled"
        : "Video job lifecycle deadline exceeded",
    };
  }
  if (honorCallerAbort && callerSignal?.aborted) {
    return { ok: false, status: 499, error: "Video generation request cancelled" };
  }

  const controller = new AbortController();
  const timeoutMs = Math.max(
    1,
    Math.min(MAX_VIDEO_JOB_FETCH_TIMEOUT_MS, getConfiguredTimeout(), remainingMs)
  );
  let requestTimedOut = false;
  let callerAborted = false;
  const abortForCaller = () => {
    callerAborted = true;
    controller.abort();
  };
  if (honorCallerAbort && callerSignal) {
    callerSignal.addEventListener("abort", abortForCaller, { once: true });
  }
  // fetchWithTimeout clears its timer when response headers arrive. Keep this
  // outer timer alive until the response body has been fully read and parsed.
  const requestTimer = setTimeout(() => {
    requestTimedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetchWithTimeout(url, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      timeoutMs,
      signal: controller.signal,
    });
    const responseText = await response.text();
    if (Date.now() >= deadlineAt) {
      return {
        ok: false,
        status: callerSignal?.aborted ? 499 : 504,
        error: callerSignal?.aborted
          ? "Video generation request cancelled"
          : "Video job lifecycle deadline exceeded",
      };
    }
    if (honorCallerAbort && callerSignal?.aborted) {
      return { ok: false, status: 499, error: "Video generation request cancelled" };
    }
    if (!response.ok) {
      log?.error?.(
        "VIDEO",
        `Upstream ${response.status} for ${url}: ${responseText.slice(0, 200)}`
      );
      return { ok: false, status: response.status, error: responseText };
    }
    const data: unknown = JSON.parse(responseText);
    return { ok: true, data };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout =
      err instanceof FetchTimeoutError || (err instanceof Error && err.name === "AbortError");
    if (callerAborted || (honorCallerAbort && callerSignal?.aborted)) {
      return {
        ok: false,
        status: 499,
        error: "Video generation request cancelled",
      };
    }
    log?.error?.(
      "VIDEO",
      `${isTimeout ? "Timeout" : "Request error"} for ${url}: ${sanitizeErrorMessage(message)}`
    );
    return {
      ok: false,
      status: isTimeout || requestTimedOut || Date.now() >= deadlineAt ? 504 : 502,
      error: `Video provider error: ${sanitizeErrorMessage(message)}`,
    };
  } finally {
    clearTimeout(requestTimer);
    if (honorCallerAbort && callerSignal) {
      callerSignal.removeEventListener("abort", abortForCaller);
    }
  }
}

function readResultUrl(data: unknown, resultPath: string): string | null {
  const found = readPath(data, resultPath);
  if (typeof found === "string" && found.trim()) return found.trim();
  if (Array.isArray(found)) {
    const first = found[0];
    // muapi-style: resultPath "outputs" resolves to ["https://…"].
    if (typeof first === "string" && first.trim()) return first.trim();
    // sora-style: resultPath "data" resolves to [{ url: "https://…" }].
    if (first && typeof first === "object" && !Array.isArray(first)) {
      const urlEntry = (first as Record<string, unknown>).url;
      if (typeof urlEntry === "string" && urlEntry.trim()) return urlEntry.trim();
    }
    return null;
  }
  return null;
}
