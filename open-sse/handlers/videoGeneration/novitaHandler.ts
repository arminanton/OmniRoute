/**
 * Novita AI video generation — request orchestration.
 *
 * Reuses the stored Novita provider Bearer apiKey (same credential the Novita
 * chat/LLM gateway already uses — no separate credential flow). Submits to the
 * model-specific `/v3/async/<model>` endpoint, polls the shared `task-result`
 * endpoint by `task_id` with backoff, and returns the OpenAI-like response shape.
 */

import { sanitizeErrorMessage } from "../../utils/error.ts";
import { clearTimeout as clearNativeTimeout, setTimeout as setNativeTimeout } from "node:timers";
import {
  buildNovitaPollUrl,
  buildNovitaSubmitBody,
  buildNovitaSubmitUrl,
  normalizeNovitaVideoParams,
  parseNovitaTaskId,
  parseNovitaTaskResult,
} from "./novita.ts";

interface NovitaHandlerArgs {
  model: string;
  provider: string;
  providerConfig: { baseUrl: string; statusUrl?: string };
  body: Record<string, unknown> & { timeout_ms?: unknown; poll_interval_ms?: unknown };
  credentials?: { apiKey?: string; accessToken?: string } | null;
  log?: {
    info?: (scope: string, message: string) => void;
    error?: (scope: string, message: string) => void;
  } | null;
}

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_POLL_INTERVAL_MS = 2500;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(getAbortError(signal));
      return;
    }

    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      reject(getAbortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
  });

function getAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : Object.assign(new Error("Novita video task deadline elapsed"), { status: 504 });
}

/** Race even non-cooperative fetch/body promises against our server-owned deadline. */
function beforeDeadline<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(getAbortError(signal));

  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(getAbortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      }
    );
  });
}

type NovitaHandlerResult =
  | { success: true; data: { created: number; data: [{ url: string; format: string }] } }
  | { success: false; status: number; terminal?: true; error: string };

/** Submit the async video task; returns the task_id or a ready-to-return error result. */
async function submitNovitaTask(
  submitUrl: string,
  headers: Record<string, string>,
  payload: Record<string, unknown>,
  log: NovitaHandlerArgs["log"],
  signal: AbortSignal
): Promise<{ taskId: string } | { error: NovitaHandlerResult }> {
  const submitRes = await fetch(submitUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal,
  });
  const submitData = await submitRes.json().catch((error) => {
    if (signal.aborted) throw error;
    return {};
  });
  const taskId = parseNovitaTaskId(submitData);
  if (taskId) return { taskId };

  const errorMessage =
    (submitData as { message?: unknown })?.message || "Novita did not return a task_id";
  log?.error?.("VIDEO", `Novita createTask failed: ${JSON.stringify(submitData)}`);
  return {
    error: {
      success: false,
      status: submitRes.ok ? 502 : submitRes.status,
      // A successful submit without an id, a timeout, or a server-side error
      // may mean the provider accepted work whose task id was lost in transit.
      ...(submitRes.ok || submitRes.status === 408 || submitRes.status >= 500
        ? { terminal: true as const }
        : {}),
      error: String(errorMessage),
    },
  };
}

/** Resolve the request timeout + poll interval, falling back to the module defaults. */
function resolveNovitaTiming(body: NovitaHandlerArgs["body"]): {
  timeoutMs: number;
  pollIntervalMs: number;
} {
  const timeoutMs = Number(body.timeout_ms) > 0 ? Number(body.timeout_ms) : DEFAULT_TIMEOUT_MS;
  const pollIntervalMs =
    Number(body.poll_interval_ms) > 0 ? Number(body.poll_interval_ms) : DEFAULT_POLL_INTERVAL_MS;
  return {
    timeoutMs: Math.max(1, Math.min(MAX_TIMER_DELAY_MS, Math.floor(timeoutMs))),
    pollIntervalMs: Math.max(1, Math.min(MAX_TIMER_DELAY_MS, Math.floor(pollIntervalMs))),
  };
}

/** Poll task-result until terminal (success/failure) or the deadline elapses. */
async function pollNovitaTask(
  pollUrl: string,
  token: string,
  taskId: string,
  deadline: number,
  pollIntervalMs: number,
  signal: AbortSignal
): Promise<NovitaHandlerResult> {
  let lastStatus = "UNKNOWN";

  while (Date.now() < deadline) {
    const remainingMs = Math.max(0, deadline - Date.now());
    await sleep(Math.min(pollIntervalMs, remainingMs), signal);
    if (signal.aborted || Date.now() >= deadline) break;

    const pollRes = await fetch(pollUrl, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    if (!pollRes.ok) {
      const details = await pollRes.text().catch(() => "");
      return {
        success: false,
        status: pollRes.status,
        terminal: true,
        error: sanitizeErrorMessage(details || `Novita task polling failed (${pollRes.status})`),
      };
    }
    const pollData = await pollRes.json().catch((error) => {
      if (signal.aborted) throw error;
      return {};
    });
    const result = parseNovitaTaskResult(pollData);
    lastStatus = result.status;

    if (!result.done) continue;

    if (result.videoUrl) {
      return {
        success: true,
        data: {
          created: Math.floor(Date.now() / 1000),
          data: [{ url: result.videoUrl, format: "mp4" }],
        },
      };
    }

    return { success: false, status: 502, error: sanitizeErrorMessage(result.errorMessage) };
  }

  return {
    success: false,
    status: 504,
    terminal: true,
    error: `Novita task ${taskId} timed out (status: ${lastStatus})`,
  };
}

export async function handleNovitaVideoGeneration({
  model,
  provider,
  providerConfig,
  body,
  credentials,
  log,
}: NovitaHandlerArgs): Promise<NovitaHandlerResult> {
  const token = credentials?.apiKey || credentials?.accessToken;
  if (!token) {
    return { success: false, status: 401, error: "Novita AI API key is required" };
  }

  const { timeoutMs, pollIntervalMs } = resolveNovitaTiming(body);

  const statusUrl = providerConfig.statusUrl || `${providerConfig.baseUrl}/task-result`;
  const submitUrl = buildNovitaSubmitUrl(providerConfig.baseUrl, model);
  const params = normalizeNovitaVideoParams(body);
  const payload = buildNovitaSubmitBody(params);
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  log?.info?.(
    "VIDEO",
    `${provider}/${model} (novita-video) | prompt: "${params.prompt.slice(0, 60)}..."`
  );

  const deadlineAt = Date.now() + timeoutMs;
  const deadlineController = new AbortController();
  const deadlineError = Object.assign(
    new Error("Novita video generation timed out (deadline elapsed)"),
    { status: 504 }
  );
  const deadlineTimer = setNativeTimeout(() => deadlineController.abort(deadlineError), timeoutMs);

  try {
    const submitted = await beforeDeadline(
      submitNovitaTask(submitUrl, headers, payload, log, deadlineController.signal),
      deadlineController.signal
    );
    if (Date.now() >= deadlineAt) throw deadlineError;
    if ("error" in submitted) return submitted.error;

    const pollUrl = buildNovitaPollUrl(statusUrl, submitted.taskId);
    const result = await beforeDeadline(
      pollNovitaTask(
        pollUrl,
        token,
        submitted.taskId,
        deadlineAt,
        pollIntervalMs,
        deadlineController.signal
      ),
      deadlineController.signal
    );
    if (Date.now() >= deadlineAt) throw deadlineError;
    return result;
  } catch (err) {
    const e = (err ?? {}) as { message?: string; status?: number };
    log?.error?.("VIDEO", `Novita video generation failed: ${e.message}`);
    return {
      success: false,
      status:
        deadlineController.signal.aborted || Date.now() >= deadlineAt
          ? 504
          : typeof e.status === "number"
            ? e.status
            : 502,
      // The submit may have reached Novita, or an already-accepted task may
      // still be running. Never duplicate that work on another combo target.
      terminal: true,
      error: sanitizeErrorMessage(e.message || "Novita video generation failed"),
    };
  } finally {
    clearNativeTimeout(deadlineTimer);
  }
}
