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
};

export class ComfyWorkflowSubmitError extends Error {
  constructor(
    message: string,
    readonly terminal: boolean
  ) {
    super(message);
    this.name = "ComfyWorkflowSubmitError";
  }
}

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

/**
 * Submit a workflow to ComfyUI for execution.
 * @returns The prompt_id for polling
 */
export async function submitComfyWorkflow(
  baseUrl: string,
  workflow: object,
  signal?: AbortSignal | null
): Promise<string> {
  // Once a prompt POST starts, an abort cannot distinguish a rejected request
  // from an accepted-but-unobserved job. Check before dispatch, then let the
  // request finish and keep polling it at the caller until it reaches a terminal
  // state so provider/account occupancy is not released early.
  signal?.throwIfAborted();
  let res: Response;
  try {
    // Do not attach the caller signal here: a ComfyUI prompt may be accepted
    // even when the client loses the response, and then must still be tracked.
    res = await fetch(`${baseUrl}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: workflow }),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ComfyWorkflowSubmitError(`ComfyUI submit request failed: ${detail}`, true);
  }

  if (!res.ok) {
    const errText = await res.text();
    throw new ComfyWorkflowSubmitError(
      `ComfyUI submit failed (${res.status}): ${errText}`,
      res.status === 408 || res.status >= 500
    );
  }

  let data: JsonRecord;
  try {
    data = toRecord(await res.json());
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
  timeoutMs: number = 120_000
): Promise<ComfyHistoryEntry> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 2000));

    const res = await fetch(`${baseUrl}/history/${promptId}`);
    if (!res.ok) continue;

    const data = toRecord(await res.json());
    const entry = toRecord(data[promptId]) as ComfyHistoryEntry;

    if (entry && entry.outputs && Object.keys(entry.outputs).length > 0) {
      return entry;
    }
  }

  throw new Error(`ComfyUI prompt ${promptId} timed out after ${timeoutMs}ms`);
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
  signal?: AbortSignal | null
): Promise<ArrayBuffer> {
  const url = new URL(`${baseUrl}/view`);
  url.searchParams.set("filename", filename);
  url.searchParams.set("subfolder", subfolder);
  url.searchParams.set("type", type);

  const res = await fetch(url.toString(), signal ? { signal } : undefined);
  if (!res.ok) {
    throw new Error(`ComfyUI fetch output failed (${res.status})`);
  }

  return res.arrayBuffer();
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
