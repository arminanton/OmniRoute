/**
 * Shared ComfyUI API Client
 *
 * Used by image, video, and music handlers to submit workflows,
 * poll for completion, and fetch output files from a ComfyUI server.
 */

type JsonRecord = Record<string, unknown>;

type ComfyOutputFile = {
  filename: string;
  subfolder?: string;
  type?: string;
};

type ComfyNodeOutput = {
  images?: ComfyOutputFile[];
  gifs?: ComfyOutputFile[];
  audio?: ComfyOutputFile[];
};

type ComfyHistoryEntry = {
  outputs?: Record<string, ComfyNodeOutput>;
  status?: { status_str?: unknown; completed?: unknown };
};

export type ComfyWorkflowDeadlineOptions = {
  signal?: AbortSignal | null;
  deadlineAt?: number;
};

export type ComfyWorkflowDeadline = ComfyWorkflowDeadlineOptions & {
  signal: AbortSignal;
  readonly expired: boolean;
  dispose: () => void;
};

/**
 * A server-owned deadline for a submitted ComfyUI workflow. The caller's
 * disconnect signal is deliberately not part of this controller: once /prompt
 * is dispatched, the remote job must remain observed until it settles or this
 * deadline expires.
 */
export function createComfyWorkflowDeadline(timeoutMs = 300_000): ComfyWorkflowDeadline {
  const controller = new AbortController();
  const startedAt = Date.now();
  const deadlineAt = startedAt + Math.max(1, timeoutMs);
  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      controller.abort(new Error(`ComfyUI workflow timed out after ${timeoutMs}ms`));
    },
    Math.max(1, timeoutMs)
  );

  return {
    signal: controller.signal,
    deadlineAt,
    get expired() {
      return timedOut || Date.now() >= deadlineAt;
    },
    dispose() {
      clearTimeout(timer);
    },
  };
}

export class ComfyWorkflowSubmitError extends Error {
  constructor(
    message: string,
    readonly terminal: boolean,
    readonly status?: number
  ) {
    super(message);
    this.name = "ComfyWorkflowSubmitError";
  }
}

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function throwIfComfyDeadlineExpired(options?: ComfyWorkflowDeadlineOptions | null) {
  if (options?.deadlineAt != null && Date.now() >= options.deadlineAt) {
    throw new Error("ComfyUI workflow deadline exceeded");
  }
  options?.signal?.throwIfAborted();
}

function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () =>
      finish(() => reject(signal.reason ?? new DOMException("Aborted", "AbortError")));

    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    );
  });
}

function sleepWithAbort(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (!settled) signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Submit a workflow to ComfyUI for execution.
 * @returns The prompt_id for polling
 */
export async function submitComfyWorkflow(
  baseUrl: string,
  workflow: object,
  signal?: AbortSignal | null,
  deadline?: ComfyWorkflowDeadlineOptions | null
): Promise<string> {
  // Once a prompt POST starts, an abort cannot distinguish a rejected request
  // from an accepted-but-unobserved job. Check before dispatch, then let the
  // request finish and keep polling it at the caller until it reaches a terminal
  // state so provider/account occupancy is not released early.
  signal?.throwIfAborted();
  throwIfComfyDeadlineExpired(deadline);
  let res: Response;
  try {
    // Do not attach the caller signal here: a ComfyUI prompt may be accepted
    // even when the client loses the response, and then must still be tracked.
    res = await raceWithAbort(
      fetch(`${baseUrl}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: workflow }),
        ...(deadline?.signal ? { signal: deadline.signal } : {}),
      }),
      deadline?.signal
    );
    throwIfComfyDeadlineExpired(deadline);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ComfyWorkflowSubmitError(`ComfyUI submit request failed: ${detail}`, true);
  }

  if (!res.ok) {
    const terminal = res.status === 408 || res.status >= 500;
    let errText = "";
    try {
      errText = await raceWithAbort(res.text(), deadline?.signal);
      throwIfComfyDeadlineExpired(deadline);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ComfyWorkflowSubmitError(
        `ComfyUI submit response could not be read: ${detail}`,
        terminal,
        res.status
      );
    }
    throw new ComfyWorkflowSubmitError(
      `ComfyUI submit failed (${res.status}): ${errText}`,
      terminal,
      res.status
    );
  }

  let data: JsonRecord;
  try {
    data = toRecord(await raceWithAbort(res.json(), deadline?.signal));
    throwIfComfyDeadlineExpired(deadline);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ComfyWorkflowSubmitError(
      `ComfyUI submit response could not be parsed: ${detail}`,
      true
    );
  }
  const promptId = data.prompt_id;
  if (typeof promptId !== "string" || !promptId) {
    throw new ComfyWorkflowSubmitError("ComfyUI submit failed: missing prompt_id", true);
  }
  return promptId;
}

/**
 * Poll ComfyUI history endpoint until the prompt completes or times out.
 * @returns The history entry for the completed prompt
 */
export async function pollComfyResult(
  baseUrl: string,
  promptId: string,
  timeoutMs: number = 120_000,
  deadline?: ComfyWorkflowDeadlineOptions | null
): Promise<ComfyHistoryEntry> {
  const start = Date.now();
  const deadlineAt = deadline?.deadlineAt ?? start + timeoutMs;

  while (Date.now() < deadlineAt) {
    throwIfComfyDeadlineExpired(deadline);
    await sleepWithAbort(Math.min(2000, Math.max(1, deadlineAt - Date.now())), deadline?.signal);
    throwIfComfyDeadlineExpired(deadline);

    const res = await raceWithAbort(
      fetch(
        `${baseUrl}/history/${promptId}`,
        deadline?.signal ? { signal: deadline.signal } : undefined
      ),
      deadline?.signal
    );
    throwIfComfyDeadlineExpired(deadline);
    if (!res.ok) {
      // A failed history poll is retried, but its body is not needed. Cancel it
      // immediately so repeated 429/5xx responses do not retain unread streams
      // or hold pooled connections until the overall workflow deadline.
      void res.body?.cancel().catch(() => {});
      continue;
    }

    const data = toRecord(await raceWithAbort(res.json(), deadline?.signal));
    throwIfComfyDeadlineExpired(deadline);
    const entry = toRecord(data[promptId]) as ComfyHistoryEntry;
    const status = toRecord(entry.status);
    const statusText = typeof status.status_str === "string" ? status.status_str.toLowerCase() : "";
    if (["error", "failed", "cancelled", "canceled"].includes(statusText)) {
      throw new Error(`ComfyUI prompt ${promptId} failed during workflow execution`);
    }
    if (extractComfyOutputFiles(entry).length > 0) {
      return entry;
    }
    if (statusText === "success" || status.completed === true) {
      throw new Error(`ComfyUI prompt ${promptId} completed without media outputs`);
    }
  }

  throw new Error(
    `ComfyUI prompt ${promptId} timed out after ${deadline?.deadlineAt ? "the workflow deadline" : `${timeoutMs}ms`}`
  );
}

/**
 * Fetch an output file from ComfyUI.
 * @returns The file contents as ArrayBuffer
 */
export async function fetchComfyOutput(
  baseUrl: string,
  filename: string,
  subfolder: string,
  type: string,
  signal?: AbortSignal | null,
  deadline?: ComfyWorkflowDeadlineOptions | null
): Promise<ArrayBuffer> {
  throwIfComfyDeadlineExpired(deadline);
  const url = new URL(`${baseUrl}/view`);
  url.searchParams.set("filename", filename);
  url.searchParams.set("subfolder", subfolder);
  url.searchParams.set("type", type);

  const requestSignal = deadline?.signal ?? signal;
  const res = await raceWithAbort(
    fetch(url.toString(), requestSignal ? { signal: requestSignal } : undefined),
    deadline?.deadlineAt != null ? requestSignal : null
  );
  throwIfComfyDeadlineExpired(deadline);
  if (!res.ok) {
    void res.body?.cancel().catch(() => {});
    throw new Error(`ComfyUI fetch output failed (${res.status})`);
  }

  const body = await raceWithAbort(
    res.arrayBuffer(),
    deadline?.deadlineAt != null ? requestSignal : null
  );
  throwIfComfyDeadlineExpired(deadline);
  return body;
}

/**
 * Extract output files from a ComfyUI history entry.
 * Returns an array of { filename, subfolder, type } for each output.
 */
export function extractComfyOutputFiles(
  historyEntry: ComfyHistoryEntry
): Array<{ filename: string; subfolder: string; type: string }> {
  const files: Array<{ filename: string; subfolder: string; type: string }> = [];

  for (const nodeOutput of Object.values(historyEntry.outputs || {})) {
    const outputs = nodeOutput.images || nodeOutput.gifs || nodeOutput.audio || [];
    for (const file of outputs) {
      files.push({
        filename: file.filename,
        subfolder: file.subfolder || "",
        type: file.type || "output",
      });
    }
  }

  return files;
}

/**
 * Resolve the ComfyUI base URL to use for a request.
 *
 * Prefers a per-connection override (`credentials.providerSpecificData.baseUrl`,
 * the same storage convention self-hosted chat providers use — see
 * `providerPageHelpers.ts`'s `CONFIGURABLE_BASE_URL_PROVIDERS`) over the registry
 * default, so operators running ComfyUI on a Docker-network hostname (e.g.
 * `http://comfyui:8188`) aren't stuck on `localhost:8188` (#6928). Falls back to
 * `fallback` when no connection exists or no override is set — zero-config
 * localhost users see no behavior change.
 */
export function resolveComfyUiBaseUrl(
  credentials: { providerSpecificData?: { baseUrl?: unknown } | null } | null | undefined,
  fallback: string
): string {
  const psd = credentials?.providerSpecificData;
  const override =
    psd && typeof psd === "object" && typeof psd.baseUrl === "string" && psd.baseUrl.trim()
      ? psd.baseUrl.trim()
      : null;
  return override || fallback;
}
