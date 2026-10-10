/**
 * xAI Grok Imagine video generation: create async job → poll → MP4.
 * Reuses the stored xai provider Bearer apiKey (same credential the
 * image-generation "xai" entry in imageRegistry.ts already uses) — no
 * separate credential flow. Mirrors the DashScope create+poll shape in
 * videoGeneration.ts, adapted to xAI's request_id / status
 * ("pending"|"processing"|"done"|"failed") job shape
 * (https://docs.x.ai/developers/rest-api-reference/inference/videos).
 */

import { isJsonObject } from "../../utils/kieTask.ts";
import { saveCallLog } from "@/lib/usageDb";
import { sanitizeErrorMessage } from "../../utils/error.ts";

interface XaiVideoBody {
  prompt?: unknown;
  image?: unknown;
  duration?: unknown;
  aspect_ratio?: unknown;
  resolution?: unknown;
  timeout_ms?: unknown;
  poll_interval_ms?: unknown;
  [key: string]: unknown;
}

interface XaiVideoLog {
  info: (scope: string, message: string) => void;
  error: (scope: string, message: string) => void;
}

const DEFAULT_TIMEOUT_MS = 300_000;
// Keep a server-owned upper bound even when a request body asks for a much
// longer timeout. Callers may choose a shorter window, but cannot pin a worker
// indefinitely with an unbounded async video job.
const MAX_TIMEOUT_MS = 10 * 60 * 1000;

/** Map the OmniRoute video body onto xAI's create-job payload. */
function buildXaiVideoPayload(model: string, prompt: string, body: XaiVideoBody) {
  const payload: Record<string, unknown> = { model, prompt };
  if (typeof body.image === "string") payload.image = body.image;
  if (body.duration != null) payload.duration = Number(body.duration);
  if (typeof body.aspect_ratio === "string") payload.aspect_ratio = body.aspect_ratio;
  if (typeof body.resolution === "string") payload.resolution = body.resolution;
  return payload;
}

/** POST the create-job request; resolves to the request_id or a ready error message. */
async function createXaiVideoJob({
  baseUrl,
  token,
  payload,
  signal,
  log,
}: {
  baseUrl: string;
  token: string;
  payload: Record<string, unknown>;
  signal: AbortSignal;
  log?: XaiVideoLog | null;
}): Promise<{ requestId?: string; error?: string; status?: number; terminal?: boolean }> {
  const createRes = await fetch(`${baseUrl}/generations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal,
  });
  const createText = await createRes.text();
  let createData: Record<string, unknown> = {};
  try {
    createData = JSON.parse(createText) as Record<string, unknown>;
  } catch {
    // Keep the provider's plain-text error available below.
  }
  const requestId = createData?.request_id;
  if (requestId) return { requestId: String(requestId) };

  const errorMessage =
    (createData?.error as { message?: unknown } | undefined)?.message ||
    createData?.message ||
    createText ||
    "xAI video generation did not return request_id";
  if (log) {
    log.error("VIDEO", `xAI createJob failed: ${JSON.stringify(createData)}`);
  }
  // A successful response without an id may still represent accepted work.
  // Likewise, a timeout/server error after POST dispatch has an ambiguous
  // acceptance state. Only a clear client rejection is safe for combo retry.
  return {
    error: String(errorMessage),
    // Keep the handler's existing submit-error status mapping for API
    // compatibility; `terminal` carries the duplicate-work safety decision.
    status: 502,
    ...(createRes.ok || createRes.status === 408 || createRes.status >= 500
      ? { terminal: true }
      : {}),
  };
}

type XaiPollOutcome =
  | { terminal: "done"; videoUrl?: string }
  | { terminal: "failed"; error?: unknown }
  | { terminal: "timeout"; lastStatus: string };

/**
 * Poll statusUrl/{request_id} until a terminal status or the deadline.
 * Date.now() is read only in the loop condition, so the caller keeps full
 * control over the timeout budget it computed from its own startTime.
 */
async function pollXaiVideoJob({
  statusUrl,
  requestId,
  token,
  deadline,
  pollIntervalMs,
  signal,
}: {
  statusUrl: string;
  requestId: string;
  token: string;
  deadline: number;
  pollIntervalMs: number;
  signal: AbortSignal;
}): Promise<XaiPollOutcome> {
  let lastStatus = "pending";
  while (Date.now() < deadline) {
    await sleepWithinDeadline(pollIntervalMs, deadline, signal);
    const pollRes = await fetch(`${statusUrl}/${requestId}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    const pollText = await pollRes.text();
    let pollData: Record<string, unknown> = {};
    try {
      pollData = JSON.parse(pollText) as Record<string, unknown>;
    } catch {
      // A malformed status response cannot establish the accepted task state.
    }
    if (!pollRes.ok) {
      const message =
        (pollData?.error as { message?: unknown } | undefined)?.message ||
        pollData?.message ||
        pollText ||
        `xAI video status request failed (${pollRes.status})`;
      throw Object.assign(new Error(String(message)), { status: pollRes.status });
    }
    lastStatus = String(pollData?.status || "pending");

    if (lastStatus === "done") {
      const video = pollData.video as { url?: unknown } | undefined;
      return { terminal: "done", videoUrl: typeof video?.url === "string" ? video.url : undefined };
    }
    if (lastStatus === "failed") return { terminal: "failed", error: pollData?.error };
    // pending / processing → keep polling
  }
  return { terminal: "timeout", lastStatus };
}

/** Wait for a poll interval without sleeping past the absolute job deadline. */
function sleepWithinDeadline(ms: number, deadline: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) return Promise.reject(signal.reason || timeoutError());

  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer !== undefined) clearTimeout(timer);
      reject(signal.reason || timeoutError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      Math.min(ms, remainingMs)
    );
  });
}

function timeoutError() {
  return Object.assign(new Error("xAI video generation timed out"), {
    name: "TimeoutError",
    status: 504,
  });
}

/** Resolve the request knobs (timeouts, credential, endpoints, prompt) from the call. */
function resolveXaiVideoOptions(
  body: XaiVideoBody,
  providerConfig: { baseUrl: string; statusUrl?: string },
  credentials?: { apiKey?: string; accessToken?: string } | null
) {
  const baseUrl = providerConfig.baseUrl.replace(/\/$/, "");
  return {
    timeoutMs:
      Number.isFinite(Number(body.timeout_ms)) && Number(body.timeout_ms) > 0
        ? Math.min(Number(body.timeout_ms), MAX_TIMEOUT_MS)
        : DEFAULT_TIMEOUT_MS,
    pollIntervalMs: Number(body.poll_interval_ms) > 0 ? Number(body.poll_interval_ms) : 2500,
    token: credentials?.apiKey || credentials?.accessToken,
    baseUrl,
    statusUrl: (providerConfig.statusUrl || baseUrl).replace(/\/$/, ""),
    prompt: typeof body.prompt === "string" ? body.prompt : String(body.prompt ?? ""),
  };
}

/** Map a terminal poll outcome onto the OpenAI-like video response (or an error). */
function buildXaiVideoResponse({
  outcome,
  requestId,
  provider,
  model,
  startTime,
}: {
  outcome: XaiPollOutcome;
  requestId: string;
  provider: string;
  model: string;
  startTime: number;
}) {
  if (outcome.terminal === "failed") {
    return { success: false, status: 502, error: String(outcome.error || "xAI video job failed") };
  }

  if (outcome.terminal === "timeout") {
    return {
      success: false,
      status: 504,
      terminal: true,
      error: `xAI video job ${requestId} timed out (status: ${outcome.lastStatus})`,
    };
  }

  if (!outcome.videoUrl) {
    return {
      success: false,
      status: 502,
      terminal: true,
      error: "xAI video job done but no video.url",
    };
  }

  saveCallLog({
    method: "POST",
    path: "/v1/videos/generations",
    status: 200,
    model: `${provider}/${model}`,
    provider,
    duration: Date.now() - startTime,
    responseBody: { videos_count: 1 },
  }).catch(() => {});

  return {
    success: true,
    data: {
      created: Math.floor(Date.now() / 1000),
      data: [{ url: outcome.videoUrl, format: "mp4" }],
    },
  };
}

export async function handleXaiVideoGeneration({
  model,
  provider,
  providerConfig,
  body,
  credentials,
  log,
}: {
  model: string;
  provider: string;
  providerConfig: { baseUrl: string; statusUrl?: string };
  body: XaiVideoBody;
  credentials?: { apiKey?: string; accessToken?: string } | null;
  log?: XaiVideoLog | null;
}) {
  const startTime = Date.now();
  const { timeoutMs, pollIntervalMs, token, baseUrl, statusUrl, prompt } = resolveXaiVideoOptions(
    body,
    providerConfig,
    credentials
  );

  if (!token) {
    return { success: false, status: 401, error: "xAI API key is required" };
  }

  if (log) {
    log.info("VIDEO", `${provider}/${model} (xai-video) | prompt: "${prompt.slice(0, 60)}..."`);
  }

  const deadline = startTime + timeoutMs;
  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(() => deadlineController.abort(timeoutError()), timeoutMs);
  let submitDispatched = false;
  let taskAccepted = false;

  try {
    const payload = buildXaiVideoPayload(model, prompt, body);
    submitDispatched = true;
    const created = await createXaiVideoJob({
      baseUrl,
      token,
      payload,
      signal: deadlineController.signal,
      log,
    });
    if (!created.requestId) {
      return {
        success: false,
        status: created.status || 502,
        ...(created.terminal ? { terminal: true } : {}),
        error: created.error || "xAI video generation did not return request_id",
      };
    }
    taskAccepted = true;

    if (deadlineController.signal.aborted || Date.now() >= deadline) {
      throw deadlineController.signal.reason || timeoutError();
    }

    const outcome = await pollXaiVideoJob({
      statusUrl,
      requestId: created.requestId,
      token,
      deadline,
      pollIntervalMs,
      signal: deadlineController.signal,
    });

    return buildXaiVideoResponse({
      outcome,
      requestId: created.requestId,
      provider,
      model,
      startTime,
    });
  } catch (err: unknown) {
    const timedOut = deadlineController.signal.aborted || Date.now() >= deadline;
    const errorStatus =
      isJsonObject(err) && Number.isFinite(Number(err.status)) ? Number(err.status) : 502;
    return {
      success: false,
      status: timedOut ? 504 : errorStatus,
      // Once POST was dispatched, a transport error has an ambiguous acceptance
      // state. After a request_id is returned, any poll/result transport failure
      // must also stop combo from creating a duplicate video elsewhere.
      ...(submitDispatched || taskAccepted ? { terminal: true } : {}),
      error: sanitizeErrorMessage(err) || "Video provider error",
    };
  } finally {
    clearTimeout(deadlineTimer);
  }
}
