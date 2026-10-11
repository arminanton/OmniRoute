import { createHmac, randomUUID } from "node:crypto";

import {
  SqliteAsyncTaskOwner,
  type DurableAsyncTaskRecord,
  type DurableAsyncTaskPollClaim,
} from "@omniroute/open-sse/services/coordination/asyncTaskOwner.ts";
import { acquireSharedSemaphore } from "@omniroute/open-sse/services/coordination/sharedSemaphore.ts";
import { resolveQuotaIdentity } from "@omniroute/open-sse/services/quotaIdentity.ts";
import {
  pollVideoJobOnce,
  submitVideoJobOnce,
} from "@omniroute/open-sse/handlers/videoGeneration/job.ts";
import {
  createVideoTaskArtifact,
  deleteExpiredVideoTaskArtifacts,
  findVideoTaskArtifact,
  getFile,
  getFileContent,
  VIDEO_TASK_ARTIFACT_MAX_BYTES,
  type FileRecord,
} from "@/lib/db/files";
import { getProviderCredentials } from "@/sse/services/auth";
import { safeOutboundFetch } from "@/shared/network/safeOutboundFetch";
import { combineAbortSignals } from "@omniroute/open-sse/utils/combineAbortSignals.ts";

const PROVIDER_ID = "agnes";
const PRESET_ID = "agnes-video-job";
const STRATEGY_VERSION = "1";
const SUBMIT_DEADLINE_DEFAULT_MS = 5 * 60_000;
const SUBMIT_DEADLINE_MAX_MS = 15 * 60_000;
const POLL_INTERVAL_MS = 2_000;
const POLL_RETRY_INTERVAL_MS = 10_000;
const POLL_LEASE_MS = 240_000;
const PROVIDER_POLL_CONCURRENCY_KEY = "async-video-provider-poll:agnes";
const PROVIDER_POLL_MAX_CONCURRENCY = 4;
const ARTIFACT_DOWNLOAD_CONCURRENCY_KEY = "async-video-artifact-download:agnes";
const ALLOWED_RESULT_HOST = "platform-outputs.agnes-ai.space";

type OwnerRuntime = { filename: string; owner: SqliteAsyncTaskOwner };
type ProcessState = typeof globalThis & {
  __omniDurableAgnesTaskOwner?: OwnerRuntime;
  __omniDurableAgnesTaskOwnerInit?: { filename: string; promise: Promise<SqliteAsyncTaskOwner> };
  __omniDurableAgnesTaskMaintenance?: {
    filename: string;
    lastRecoveryAt: number;
    lastCleanupAt: number;
  };
};

export type DurableAgnesTaskIdentity = {
  apiKeyId: string;
  apiKey: string;
  idempotencyKey: string;
  model: string;
  body: Record<string, unknown>;
};

type AgnesCredentials = {
  [key: string]: unknown;
  connectionId?: string | null;
  id?: string | null;
  maxConcurrent?: number | null;
  releaseAccountRequest?: () => void;
};

export type DurableTaskCreateOutcome =
  | { kind: "task"; task: DurableAsyncTaskRecord }
  | { kind: "rejected"; status: number; errorCode: string }
  | { kind: "capacity_unavailable"; status: number; reason: string };

export function toDurableAgnesTaskResponse(task: DurableAsyncTaskRecord) {
  const now = Date.now();
  const statusUrl = `/api/v1/videos/tasks/${encodeURIComponent(task.id)}`;
  const resultAvailable =
    task.state === "succeeded" &&
    !!task.artifactFileId &&
    typeof task.artifactExpiresAt === "number" &&
    task.artifactExpiresAt > now;
  return {
    id: task.id,
    object: "video.task",
    status: task.state,
    provider: task.provider,
    model: task.model,
    created_at: Math.floor(task.createdAt / 1000),
    updated_at: Math.floor(task.updatedAt / 1000),
    deadline_at: Math.floor(task.deadlineAt / 1000),
    status_url: statusUrl,
    ...(resultAvailable
      ? {
          result_url: `${statusUrl}/content`,
          result_expires_at: Math.floor((task.artifactExpiresAt as number) / 1000),
        }
      : {}),
    result_available: resultAvailable,
    ...(task.errorCode ? { error: { code: task.errorCode } } : {}),
    ...(task.state === "cancel_requested"
      ? {
          cancellation: {
            requested: true,
            upstream_cancelled: false,
            reason: task.errorCode ?? "caller_cancelled",
          },
        }
      : {}),
  };
}

export function durableAgnesTaskHttpStatus(task: DurableAsyncTaskRecord): number {
  return ["succeeded", "failed", "cancelled", "rejected"].includes(task.state) ? 200 : 202;
}

export function durableAgnesTaskRetryAfterSeconds(task: DurableAsyncTaskRecord): number {
  if (task.state === "submission_unknown") return 30;
  return Math.max(2, Math.min(60, Math.ceil((task.nextPollAt - Date.now()) / 1000)));
}

/** Rate-limit SQLite maintenance so frequent client status polls stay read-light. */
export function runDurableAgnesTaskMaintenance(owner: SqliteAsyncTaskOwner): void {
  const runtime = globalThis as ProcessState;
  let state = runtime.__omniDurableAgnesTaskMaintenance;
  if (!state || state.filename !== owner.filename) {
    state = {
      filename: owner.filename,
      lastRecoveryAt: 0,
      lastCleanupAt: 0,
    };
    runtime.__omniDurableAgnesTaskMaintenance = state;
  }
  const now = Date.now();
  if (now - state.lastRecoveryAt >= 1_000) {
    state.lastRecoveryAt = now;
    owner.recoverExpiredSubmissions(now);
  }
  if (now - state.lastCleanupAt >= 60_000) {
    state.lastCleanupAt = now;
    owner.pruneExpiredTerminalTasks(now);
    deleteExpiredVideoTaskArtifacts(Math.floor(now / 1000));
  }
}

/** Requires shared SQLite admission; durable task capacity is not process-local. */
export async function getDurableAgnesTaskOwner(): Promise<SqliteAsyncTaskOwner> {
  if (process.env.OMNI_SHARED_ADMISSION !== "true") {
    throw new Error("durable_async_tasks_require_shared_admission");
  }
  if (process.env.OMNI_COORDINATION_UNHEALTHY === "true") {
    throw new Error("shared_coordination_unhealthy");
  }
  const filename = process.env.OMNI_COORDINATION_DB;
  if (!filename) throw new Error("durable_async_tasks_require_coordination_db");

  const runtime = globalThis as ProcessState;
  if (runtime.__omniDurableAgnesTaskOwner?.filename === filename) {
    return runtime.__omniDurableAgnesTaskOwner.owner;
  }
  if (runtime.__omniDurableAgnesTaskOwnerInit?.filename === filename) {
    return runtime.__omniDurableAgnesTaskOwnerInit.promise;
  }

  const promise = (async () => {
    // Initialize/validate the shared coordinator before the task store checks
    // its protocol. The unique probe leaves no persistent capacity row.
    const releaseProbe = await acquireSharedSemaphore(
      [{ key: `async-video-init:${randomUUID()}`, maxConcurrency: 1 }],
      { timeoutMs: 1_000, onLeaseLost: () => {} }
    );
    releaseProbe();

    runtime.__omniDurableAgnesTaskOwner?.owner.close();
    const owner = new SqliteAsyncTaskOwner(filename);
    runtime.__omniDurableAgnesTaskOwner = { filename, owner };
    return owner;
  })();
  runtime.__omniDurableAgnesTaskOwnerInit = { filename, promise };
  try {
    return await promise;
  } finally {
    if (runtime.__omniDurableAgnesTaskOwnerInit?.promise === promise) {
      runtime.__omniDurableAgnesTaskOwnerInit = undefined;
    }
  }
}

export function makeDurableAgnesTaskIdentity(input: DurableAgnesTaskIdentity) {
  const idempotencyKey = input.idempotencyKey.trim();
  if (
    !idempotencyKey ||
    idempotencyKey.length > 255 ||
    /[\u0000-\u001f\u007f]/.test(idempotencyKey)
  ) {
    throw new Error("invalid_idempotency_key");
  }
  if (!input.apiKeyId?.trim() || !input.apiKey?.trim()) {
    throw new Error("durable_async_tasks_require_registered_api_key");
  }
  const requestFingerprint = createHmac("sha256", input.apiKey)
    .update("omni:agnes-video-task:v1\0")
    .update(stableJson({ provider: PROVIDER_ID, model: input.model, body: input.body }))
    .digest("hex");
  return {
    apiKeyId: input.apiKeyId,
    provider: PROVIDER_ID,
    model: input.model,
    strategy: PRESET_ID,
    strategyVersion: STRATEGY_VERSION,
    idempotencyScope: input.apiKeyId,
    idempotencyKey,
    requestFingerprint,
  };
}

export async function submitDurableAgnesVideoTask(input: {
  identity: ReturnType<typeof makeDurableAgnesTaskIdentity>;
  body: Record<string, unknown>;
  credentials: AgnesCredentials;
  signal?: AbortSignal | null;
}): Promise<DurableTaskCreateOutcome> {
  const owner = await getDurableAgnesTaskOwner();
  runDurableAgnesTaskMaintenance(owner);
  const credentials = input.credentials;
  const connectionId = String(credentials.connectionId ?? credentials.id ?? "").trim();
  const capacity = Number(credentials.maxConcurrent);
  const resource = resolveQuotaIdentity(PROVIDER_ID, connectionId, credentials);
  if (!connectionId || !resource)
    return { kind: "rejected", status: 503, errorCode: "provider_account_identity_unavailable" };
  const maxConcurrency = Number.isFinite(capacity) && capacity >= 1 ? Math.trunc(capacity) : 1;
  const timeoutValue = Number(input.body.timeout_ms);
  const requestedTimeout =
    Number.isFinite(timeoutValue) && timeoutValue > 0
      ? Math.floor(timeoutValue)
      : SUBMIT_DEADLINE_DEFAULT_MS;
  const deadlineAt = Date.now() + Math.min(SUBMIT_DEADLINE_MAX_MS, requestedTimeout);

  let created;
  try {
    created = owner.createSubmission(
      {
        ...input.identity,
        connectionId,
        deadlineAt,
        capacity: [{ key: resource, maxConcurrency }],
      },
      Date.now()
    );
  } catch (error) {
    if (error instanceof Error && error.message === "idempotency_key_conflict") {
      const raced = owner.findSubmission(input.identity);
      if (raced) return { kind: "task", task: raced };
    }
    throw error;
  }

  if (created.kind === "existing") return { kind: "task", task: created.task };
  if (created.kind === "capacity_unavailable") {
    // A parallel request with the same idempotency key may have committed
    // while this request waited for account selection.
    const raced = owner.findSubmission(input.identity);
    if (raced) return { kind: "task", task: raced };
    return {
      kind: "capacity_unavailable",
      status: created.reason === "queue_state_unknown" ? 503 : 429,
      reason: created.reason,
    };
  }

  let outcome;
  try {
    outcome = await submitVideoJobOnce({
      model: input.identity.model,
      presetName: PRESET_ID,
      body: input.body,
      credentials,
      deadlineAt,
      callerSignal: input.signal,
    });
  } catch {
    owner.markSubmissionUnknown(created.task.id, created.submissionFence, "submit_outcome_unknown");
    const task = owner.getTask(created.task.id);
    if (!task) throw new Error("durable_async_task_disappeared");
    return { kind: "task", task };
  }
  if (outcome.kind === "accepted") {
    if (!owner.recordAccepted(created.task.id, created.submissionFence, outcome.remoteTaskId)) {
      return { kind: "task", task: owner.getTask(created.task.id)! };
    }
  } else if (outcome.kind === "rejected") {
    owner.rejectSubmission(created.task.id, created.submissionFence, outcome.errorCode);
    return { kind: "rejected", status: outcome.status, errorCode: outcome.errorCode };
  } else {
    owner.markSubmissionUnknown(created.task.id, created.submissionFence, outcome.errorCode);
  }
  const task = owner.getTask(created.task.id);
  if (!task) throw new Error("durable_async_task_disappeared");
  return { kind: "task", task };
}

export async function getDurableAgnesVideoTask(input: {
  taskId: string;
  apiKeyId: string;
}): Promise<DurableAsyncTaskRecord | null> {
  const owner = await getDurableAgnesTaskOwner();
  runDurableAgnesTaskMaintenance(owner);
  let task = owner.getTaskForScope(input.taskId, input.apiKeyId);
  if (!task) return null;
  if (task.state === "accepted" && task.deadlineAt <= Date.now()) {
    task = owner.requestCancellation(task.id, input.apiKeyId, "task_deadline_exceeded") ?? task;
  }
  if (
    (task.state === "accepted" || task.state === "cancel_requested") &&
    task.remoteTaskId &&
    task.nextPollAt <= Date.now()
  ) {
    const claim = owner.claimPollOwner(task.id, `${process.pid}:${randomUUID()}`, POLL_LEASE_MS);
    if (claim) await pollAndPersist(owner, claim, input.apiKeyId);
    task = owner.getTaskForScope(input.taskId, input.apiKeyId);
  }
  return task;
}

export async function requestDurableAgnesVideoTaskCancellation(input: {
  taskId: string;
  apiKeyId: string;
}): Promise<DurableAsyncTaskRecord | null> {
  const owner = await getDurableAgnesTaskOwner();
  runDurableAgnesTaskMaintenance(owner);
  return owner.requestCancellation(input.taskId, input.apiKeyId);
}

export async function findDurableAgnesVideoTask(
  identity: ReturnType<typeof makeDurableAgnesTaskIdentity>
): Promise<DurableAsyncTaskRecord | null> {
  const owner = await getDurableAgnesTaskOwner();
  runDurableAgnesTaskMaintenance(owner);
  return owner.findSubmission(identity);
}

/** Bounded sequential worker slice; only the maintenance runtime calls this. */
export async function pollDueDurableAgnesVideoTasks(
  limit = 4,
  signal?: AbortSignal | null
): Promise<number> {
  const owner = await getDurableAgnesTaskOwner();
  runDurableAgnesTaskMaintenance(owner);
  const due = owner.listDueAcceptedTasks(Date.now(), limit);
  let claimedCount = 0;
  for (const task of due) {
    if (signal?.aborted) break;
    if (task.state === "accepted" && task.deadlineAt <= Date.now()) {
      owner.requestCancellation(task.id, task.apiKeyId, "task_deadline_exceeded");
    }
    const claim = owner.claimPollOwner(task.id, `maintenance:${process.pid}`, POLL_LEASE_MS);
    if (!claim) continue;
    claimedCount += 1;
    await pollAndPersist(owner, claim, task.apiKeyId, signal);
  }
  return claimedCount;
}

export function closeDurableAgnesTaskOwner(): void {
  const runtime = globalThis as ProcessState;
  runtime.__omniDurableAgnesTaskOwner?.owner.close();
  runtime.__omniDurableAgnesTaskOwner = undefined;
}

export function getDurableTaskResult(
  task: DurableAsyncTaskRecord,
  apiKeyId: string
): FileRecord | null {
  if (
    task.state !== "succeeded" ||
    !task.artifactFileId ||
    !task.artifactExpiresAt ||
    task.artifactExpiresAt <= Date.now()
  ) {
    return null;
  }
  const file = getFile(task.artifactFileId);
  if (!file || file.apiKeyId !== apiKeyId || file.purpose !== "video_task") return null;
  const content = getFileContent(file.id);
  return content ? { ...file, content } : null;
}

async function pollAndPersist(
  owner: SqliteAsyncTaskOwner,
  claim: DurableAsyncTaskPollClaim,
  apiKeyId: string,
  signal?: AbortSignal | null
): Promise<void> {
  const task = claim.task;
  const connectionId = task.connectionId;
  if (!connectionId || !task.remoteTaskId) {
    owner.finishPollTask(
      claim,
      task.state === "cancel_requested" ? "cancelled" : "failed",
      "task_identity_missing"
    );
    return;
  }

  let credentials: AgnesCredentials | null;
  try {
    credentials = (await getProviderCredentials(PROVIDER_ID, null, [connectionId], task.model, {
      reserveAccountRequest: true,
    })) as AgnesCredentials | null;
  } catch {
    owner.scheduleNextPoll(claim, Date.now() + POLL_RETRY_INTERVAL_MS);
    return;
  }
  if (!credentials || credentials.allRateLimited || credentials.allExpired) {
    owner.scheduleNextPoll(claim, Date.now() + POLL_RETRY_INTERVAL_MS);
    return;
  }

  try {
    const pollAbort = new AbortController();
    const releasePoll = await acquireSharedSemaphore(
      [{ key: PROVIDER_POLL_CONCURRENCY_KEY, maxConcurrency: PROVIDER_POLL_MAX_CONCURRENCY }],
      {
        timeoutMs: 1_000,
        signal,
        onLeaseLost: (error) => pollAbort.abort(error),
      }
    );
    let outcome;
    try {
      outcome = await pollVideoJobOnce({
        model: task.model,
        presetName: PRESET_ID,
        remoteTaskId: task.remoteTaskId,
        credentials,
        signal: signal ? combineAbortSignals([signal, pollAbort.signal]) : pollAbort.signal,
      });
    } finally {
      releasePoll();
    }
    if (outcome.kind === "pending") {
      owner.scheduleNextPoll(claim, Date.now() + POLL_INTERVAL_MS);
      return;
    }
    if (outcome.kind === "retry") {
      owner.scheduleNextPoll(claim, Date.now() + POLL_RETRY_INTERVAL_MS);
      return;
    }
    if (outcome.kind === "failed") {
      owner.finishPollTask(
        claim,
        task.state === "cancel_requested" ? "cancelled" : "failed",
        task.state === "cancel_requested"
          ? (task.errorCode ?? outcome.errorCode)
          : outcome.errorCode
      );
      return;
    }
    if (task.state === "cancel_requested") {
      owner.finishPollTask(claim, "cancelled", task.errorCode ?? "caller_cancelled");
      return;
    }

    const current = owner.getTaskForScope(task.id, apiKeyId);
    if (current?.state === "cancel_requested") {
      owner.finishPollTask(claim, "cancelled", current.errorCode ?? "caller_cancelled");
      return;
    }

    if (task.state === "accepted" && !owner.markArtifactPending(claim)) {
      const raced = owner.getTaskForScope(task.id, apiKeyId);
      if (raced?.state === "cancel_requested") {
        owner.finishPollTask(claim, "cancelled", raced.errorCode ?? "caller_cancelled");
      }
      return;
    }
    const artifactTask = owner.getTaskForScope(task.id, apiKeyId);
    if (artifactTask?.state === "cancelled") return;
    if (artifactTask?.state !== "artifact_pending") return;

    const prior = findVideoTaskArtifact(task.id, apiKeyId);
    const artifact =
      prior ??
      (await persistCompletedVideo(owner, task.id, apiKeyId, outcome.resultUrl, claim, signal));
    owner.finishPollTaskWithArtifact(claim, artifact.id, Number(artifact.expiresAt) * 1000);
  } catch (error) {
    // Keep the remote reservation and retry a GET after a bounded delay. Error
    // details may include signed URLs or provider payloads, so do not persist/log them.
    const code = error instanceof Error ? error.message : "video_result_unavailable";
    if (
      new Set([
        "invalid_agnes_result_url",
        "blocked_agnes_result_url",
        "video_task_artifact_too_large",
        "video_task_artifact_budget_exceeded",
        "agnes_result_unavailable_terminal",
        "agnes_result_empty",
        "agnes_result_body_missing",
        "invalid_agnes_result_content_type",
      ]).has(code)
    ) {
      owner.finishPollTask(claim, "failed", "result_artifact_unavailable");
    } else {
      owner.scheduleNextPoll(claim, Date.now() + POLL_RETRY_INTERVAL_MS);
    }
  } finally {
    credentials.releaseAccountRequest?.();
  }
}

async function persistCompletedVideo(
  owner: SqliteAsyncTaskOwner,
  taskId: string,
  apiKeyId: string,
  rawUrl: string,
  claim: DurableAsyncTaskPollClaim,
  signal?: AbortSignal | null
): Promise<FileRecord> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("invalid_agnes_result_url");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== ALLOWED_RESULT_HOST ||
    url.username ||
    url.password
  ) {
    throw new Error("blocked_agnes_result_url");
  }

  const abortController = new AbortController();
  const abortFromWorker = () => abortController.abort(signal?.reason);
  if (signal?.aborted) abortFromWorker();
  else signal?.addEventListener("abort", abortFromWorker, { once: true });
  let lostLease = false;
  const heartbeat = setInterval(() => {
    try {
      if (owner.renewPollOwner(claim, POLL_LEASE_MS)) return;
    } catch {
      // Treat SQLite errors exactly like a lost owner lease: stop work safely.
    }
    lostLease = true;
    abortController.abort(new Error("video_task_poll_lease_lost"));
  }, 15_000);
  heartbeat.unref?.();
  let releaseDownload: (() => void) | undefined;
  try {
    releaseDownload = await acquireSharedSemaphore(
      [{ key: ARTIFACT_DOWNLOAD_CONCURRENCY_KEY, maxConcurrency: 1 }],
      {
        timeoutMs: 30_000,
        signal,
        onLeaseLost: (error) => {
          lostLease = true;
          abortController.abort(error);
        },
      }
    );
    if (!owner.renewPollOwner(claim, POLL_LEASE_MS)) throw new Error("video_task_poll_lease_lost");
    const response = await safeOutboundFetch(url, {
      method: "GET",
      guard: "public-only",
      allowRedirect: false,
      retry: false,
      timeoutMs: 120_000,
      signal: abortController.signal,
    });
    if (!response.ok) {
      const status = response.status;
      await response.body?.cancel().catch(() => {});
      throw new Error(
        status >= 400 && status < 500 && status !== 408 && status !== 429
          ? "agnes_result_unavailable_terminal"
          : "agnes_result_download_failed"
      );
    }
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > VIDEO_TASK_ARTIFACT_MAX_BYTES) {
      throw new Error("video_task_artifact_too_large");
    }
    const content = await readBoundedResponse(response, VIDEO_TASK_ARTIFACT_MAX_BYTES);
    if (lostLease) throw new Error("video_task_artifact_lease_lost");
    const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (mimeType && mimeType !== "video/mp4" && mimeType !== "application/octet-stream") {
      throw new Error("invalid_agnes_result_content_type");
    }
    return createVideoTaskArtifact({
      taskId,
      apiKeyId,
      content,
      mimeType: mimeType || "video/mp4",
    });
  } finally {
    clearInterval(heartbeat);
    signal?.removeEventListener("abort", abortFromWorker);
    releaseDownload?.();
  }
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) throw new Error("agnes_result_body_missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error("video_task_artifact_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total < 1) throw new Error("agnes_result_empty");
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total
  );
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}
