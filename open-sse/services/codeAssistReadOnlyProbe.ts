/** Explicitly opted-in signed read-only Code Assist RPC. One attempt, no retries.
 * Caller supplies the reviewed safe outbound transport; no account/tool automation.
 */
import { getAntigravityContentHeaders } from "./antigravityHeaders.ts";
import type { AntigravityClientProfile } from "./antigravityClientProfile.ts";
import {
  buildCodeAssistCountTokensRequest,
  buildCodeAssistReadOnlyRpcPlan,
  parseCodeAssistCountTokensResponse,
} from "./codeAssistRpc.ts";

export class CodeAssistProbeError extends Error {
  constructor(
    public readonly category: string,
    public readonly status?: number
  ) {
    super(`Code Assist read-only probe failed (${category})`);
    this.name = "CodeAssistProbeError";
  }
}

type ProbeOptions = {
  enabled: boolean;
  provider: "agy" | "antigravity";
  accessToken: string;
  profile: AntigravityClientProfile;
  signal?: AbortSignal;
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
};

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new CodeAssistProbeError("empty-body", response.status);
  const reader = response.body.getReader();
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  let completed = false;
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      if (signal.aborted) throw new CodeAssistProbeError("cancelled-or-timeout");
      const { value, done } = await reader.read();
      if (signal.aborted) throw new CodeAssistProbeError("cancelled-or-timeout");
      if (done) {
        completed = true;
        break;
      }
      total += value.byteLength;
      if (total > 16384) throw new CodeAssistProbeError("body-limit", response.status);
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } finally {
    signal.removeEventListener("abort", abort);
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function probeCodeAssistCountTokens(
  model: unknown,
  input: unknown,
  options: ProbeOptions
): Promise<{ totalTokens: number; source: "cloud-code-count-tokens" }> {
  if (options.enabled !== true) throw new CodeAssistProbeError("disabled");
  if (
    typeof options.accessToken !== "string" ||
    !options.accessToken.trim() ||
    /[\r\n]/.test(options.accessToken)
  )
    throw new CodeAssistProbeError("missing-or-invalid-auth");
  if (
    !["agy", "antigravity"].includes(options.provider) ||
    !["cli", "ide"].includes(options.profile)
  ) {
    throw new CodeAssistProbeError("unsupported-provider-profile");
  }
  let plan: ReturnType<typeof buildCodeAssistReadOnlyRpcPlan>;
  try {
    const body = buildCodeAssistCountTokensRequest(model, input);
    plan = buildCodeAssistReadOnlyRpcPlan("cloud-code", "countTokens", body);
  } catch {
    throw new CodeAssistProbeError("invalid-request");
  }
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(5000)])
    : AbortSignal.timeout(5000);
  try {
    if (signal.aborted) throw new CodeAssistProbeError("cancelled-or-timeout");
    const response = await options.fetchImpl(plan.url, {
      method: plan.method,
      headers: getAntigravityContentHeaders(options.profile, options.accessToken),
      body: JSON.stringify(plan.body),
      signal,
      redirect: "manual",
    });
    if (!response.ok || response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw new CodeAssistProbeError("http-status", response.status);
    }
    return {
      totalTokens: parseCodeAssistCountTokensResponse(await boundedJson(response, signal)),
      source: "cloud-code-count-tokens",
    };
  } catch (error) {
    if (error instanceof CodeAssistProbeError) throw error;
    if (signal.aborted) throw new CodeAssistProbeError("cancelled-or-timeout");
    // Never forward fetch/body/Zod error messages containing provider/caller content.
    throw new CodeAssistProbeError("transport-or-payload");
  }
}
