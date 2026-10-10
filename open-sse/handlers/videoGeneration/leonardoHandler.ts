/**
 * Leonardo AI (Phoenix) video generation: submit → poll → fetch output.
 *
 * Extracted out of the frozen `videoGeneration.ts` god-file (unchanged behavior) to make
 * room for the new DeepInfra video adapter without pushing the file-size ratchet over its
 * baseline — mirrors the existing `googleFlowHandler.ts` extraction.
 */

import { clearTimeout as clearNativeTimeout, setTimeout as setNativeTimeout } from "node:timers";
import { saveCallLog } from "@/lib/usageDb";

const DEFAULT_TASK_TIMEOUT_MS = 300_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface LeonardoHandlerArgs {
  model: string;
  provider: string;
  providerConfig: { baseUrl: string };
  body: Record<string, unknown> & { timeout_ms?: unknown; poll_interval_ms?: unknown };
  credentials?: { apiKey?: string } | null;
  callerSignal?: AbortSignal | null;
  log?: {
    info?: (scope: string, message: string) => void;
    error?: (scope: string, message: string) => void;
  } | null;
}

type LeonardoHandlerResult =
  | {
      success: true;
      data: { created: number; data: [{ b64_json: string; format: string }] };
    }
  | { success: false; status: number; terminal?: true; error: string };

class LeonardoDeadlineExceeded extends Error {
  constructor(readonly phase: string) {
    super(`Leonardo video ${phase} exceeded the task deadline`);
    this.name = "LeonardoDeadlineExceeded";
  }
}

class LeonardoCallerCancelled extends Error {
  constructor() {
    super("Leonardo video request cancelled before submission");
    this.name = "LeonardoCallerCancelled";
  }
}

function resolveTiming(body: LeonardoHandlerArgs["body"]) {
  const requestedTimeoutMs = Number(body.timeout_ms);
  const timeoutMs =
    Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
      ? Math.min(Math.floor(requestedTimeoutMs), DEFAULT_TASK_TIMEOUT_MS)
      : DEFAULT_TASK_TIMEOUT_MS;
  const requestedPollIntervalMs = Number(body.poll_interval_ms);
  const pollIntervalMs =
    Number.isFinite(requestedPollIntervalMs) && requestedPollIntervalMs > 0
      ? Math.min(Math.floor(requestedPollIntervalMs), MAX_TIMER_DELAY_MS)
      : DEFAULT_POLL_INTERVAL_MS;

  return {
    timeoutMs: Math.max(1, timeoutMs),
    pollIntervalMs: Math.max(1, pollIntervalMs),
  };
}

/**
 * Own one deadline for the whole async job and race each phase against it. The
 * explicit race bounds non-cooperative fetch/body promises; the signal also lets
 * fetch and sleeps stop their underlying I/O when the server deadline expires.
 */
function createTaskDeadline(timeoutMs: number) {
  const deadlineAt = Date.now() + timeoutMs;
  const controller = new AbortController();
  let activePhase = "task";
  let expired = false;

  const expire = (phase: string) => {
    if (expired) return;
    expired = true;
    activePhase = phase;
    controller.abort(new LeonardoDeadlineExceeded(phase));
  };

  const deadlineTimer = setNativeTimeout(
    () => expire(activePhase),
    Math.min(timeoutMs, MAX_TIMER_DELAY_MS)
  );

  return {
    signal: controller.signal,
    remainingMs: () => Math.max(0, deadlineAt - Date.now()),
    isExpired: () => expired || Date.now() >= deadlineAt,
    async run<T>(operation: () => Promise<T>, phase: string): Promise<T> {
      activePhase = phase;
      if (controller.signal.aborted || Date.now() >= deadlineAt) {
        expire(phase);
        throw controller.signal.reason ?? new LeonardoDeadlineExceeded(phase);
      }

      let onAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(controller.signal.reason ?? new LeonardoDeadlineExceeded(phase));
        controller.signal.addEventListener("abort", onAbort, { once: true });
      });

      try {
        const result = await Promise.race([Promise.resolve().then(operation), aborted]);
        if (Date.now() >= deadlineAt) {
          expire(phase);
          throw controller.signal.reason ?? new LeonardoDeadlineExceeded(phase);
        }
        return result;
      } finally {
        if (onAbort) controller.signal.removeEventListener("abort", onAbort);
      }
    },
    dispose() {
      clearNativeTimeout(deadlineTimer);
    },
  };
}

function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new LeonardoDeadlineExceeded("poll interval"));
      return;
    }

    const timer = setNativeTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearNativeTimeout(timer);
      reject(signal.reason ?? new LeonardoDeadlineExceeded("poll interval"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isDeadlineExceeded(error: unknown): error is LeonardoDeadlineExceeded {
  return error instanceof LeonardoDeadlineExceeded;
}

function failure(status: number, error: string, terminal = false): LeonardoHandlerResult {
  return { success: false, status, ...(terminal ? { terminal: true as const } : {}), error };
}

export async function handleLeonardoVideoGeneration({
  model,
  provider,
  providerConfig,
  body,
  credentials,
  callerSignal,
  log,
}: LeonardoHandlerArgs): Promise<LeonardoHandlerResult> {
  const startTime = Date.now();
  const token = credentials?.apiKey || "";
  const { timeoutMs, pollIntervalMs } = resolveTiming(body);

  // Do not begin expensive remote work for an already-disconnected request. Once a
  // submit begins, however, caller cancellation must not cancel the ambiguous POST;
  // after acceptance the provider task is polled with only the server-owned deadline.
  if (callerSignal?.aborted) return failure(499, "Leonardo video request cancelled");

  const deadline = createTaskDeadline(timeoutMs);
  let taskAccepted = false;
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
  const finish = (result: LeonardoHandlerResult): LeonardoHandlerResult =>
    callerSignal?.aborted
      ? failure(499, "Leonardo request cancelled after submission began", true)
      : result;

  try {
    const submitRes = await deadline.run(() => {
      if (callerSignal?.aborted) throw new LeonardoCallerCancelled();
      return fetch(providerConfig.baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          modelId: "phoenix",
          prompt: body.prompt,
          width: 1024,
          height: 576,
          num_frames: 24,
        }),
        signal: deadline.signal,
      });
    }, "task submission");

    if (!submitRes.ok) {
      let errorText = `Leonardo task submission failed (${submitRes.status})`;
      try {
        errorText = await deadline.run(() => submitRes.text(), "submission response handling");
      } catch (error) {
        // Headers already confirmed an HTTP rejection. A stalled error body does not
        // make a rejected 4xx ambiguous or justify submitting a duplicate task.
        if (isDeadlineExceeded(error) && submitRes.status >= 500) {
          record(504, error.message);
          return finish(failure(504, "Leonardo task submission timed out", true));
        }
      }
      record(submitRes.status, errorText);
      return finish(
        failure(submitRes.status, errorText, submitRes.status === 408 || submitRes.status >= 500)
      );
    }

    let submitData: any;
    try {
      submitData = await deadline.run(() => submitRes.json(), "submission response handling");
    } catch (error) {
      if (isDeadlineExceeded(error)) throw error;
      throw new Error("Leonardo returned an unreadable successful submission response", {
        cause: error,
      });
    }

    const genId = submitData?.sdGenerationJob?.generationId;
    if (typeof genId !== "string" || genId.length === 0) {
      record(502, "No generation ID returned");
      return finish(failure(502, "No generation ID returned", true));
    }
    taskAccepted = true;

    while (deadline.remainingMs() > 0) {
      await deadline.run(
        () => sleepWithSignal(Math.min(pollIntervalMs, deadline.remainingMs()), deadline.signal),
        "poll interval"
      );
      if (deadline.remainingMs() <= 0) throw new LeonardoDeadlineExceeded("polling");

      const statusRes = await deadline.run(
        () =>
          fetch(`${providerConfig.baseUrl}/${encodeURIComponent(genId)}`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: deadline.signal,
          }),
        "task poll"
      );

      if (!statusRes.ok) {
        let errorText = `Leonardo accepted the task but polling returned HTTP ${statusRes.status}`;
        try {
          errorText = await deadline.run(() => statusRes.text(), "poll response handling");
        } catch {
          // The accepted task must not be replayed because its status body was lost.
        }
        record(statusRes.status, errorText);
        return finish(failure(statusRes.status, errorText, true));
      }

      let statusData: any;
      try {
        statusData = await deadline.run(() => statusRes.json(), "poll response handling");
      } catch (error) {
        if (isDeadlineExceeded(error)) throw error;
        throw new Error("Leonardo accepted the task but returned an unreadable poll response", {
          cause: error,
        });
      }

      const generation = statusData?.generations_by_pk || statusData;
      if (generation?.status === "COMPLETE") {
        const outputUrl = generation.generated_images?.[0]?.url;
        if (typeof outputUrl !== "string" || outputUrl.length === 0) {
          record(502, "Leonardo task completed without an output URL");
          return finish(failure(502, "Leonardo task completed without an output URL", true));
        }

        const videoRes = await deadline.run(
          () => fetch(outputUrl, { signal: deadline.signal }),
          "output fetch"
        );
        if (!videoRes.ok) {
          const errorText = `Leonardo output fetch failed (${videoRes.status})`;
          record(videoRes.status, errorText);
          return finish(failure(videoRes.status, errorText, true));
        }
        const buf = await deadline.run(() => videoRes.arrayBuffer(), "output response handling");
        record(200);
        return finish({
          success: true,
          data: {
            created: Math.floor(Date.now() / 1000),
            data: [{ b64_json: Buffer.from(buf).toString("base64"), format: "mp4" }],
          },
        });
      }

      if (generation?.status === "FAILED") {
        const message = "Leonardo video generation failed";
        record(502, message);
        // A confirmed provider-side task rejection is safe to retry on another
        // combo target: Leonardo has told us this job did not complete.
        return finish(failure(502, message));
      }
    }

    throw new LeonardoDeadlineExceeded("polling");
  } catch (error) {
    if (error instanceof LeonardoCallerCancelled) {
      return failure(499, error.message);
    }
    const timedOut = deadline.isExpired() || isDeadlineExceeded(error);
    const message = timedOut
      ? `Leonardo video generation timed out${taskAccepted ? " after task acceptance" : " during task submission"}`
      : taskAccepted
        ? "Leonardo accepted the video task but the request failed before completion"
        : "Leonardo task submission outcome is unknown; refusing to submit a duplicate";
    const details = error instanceof Error ? error.message : String(error);
    const status = timedOut ? 504 : 502;
    log?.error?.("VIDEO", `${provider}/${model}: ${message}: ${details}`);
    record(status, `${message}: ${details}`);
    // A submit transport failure may have created a job whose id was lost. Likewise,
    // post-acceptance failures must not cause combo to create a duplicate job.
    return finish(failure(status, message, true));
  } finally {
    deadline.dispose();
  }
}
