/**
 * MaxAI model discovery — live model list + per-model context windows from the
 * web app's own `/models/get_config` endpoint (the signed call the app makes on
 * load). Feeds OmniRoute's model-discovery pipeline so the MaxAI catalog and its
 * per-model context windows self-update instead of relying only on the static
 * catalog (`open-sse/executors/maxai/catalog.ts`).
 *
 * The response's `chat_models[]` carries `model_name` (id), `ui_display_name`,
 * `group`, `max_tokens` (the per-model context window), `is_deprecated`, and a
 * `capabilities` block ({ vision, thinking_mode, artifacts, file_upload }). We
 * map each non-deprecated chat model to a discovery record whose `inputTokenLimit`
 * is `max_tokens`, so `persistDiscoveredModels` → `syncedAvailableModels` →
 * `contextWindowResolver` reconciles the real window as an `auto:discovery`
 * override.
 *
 * Signed + residential like every MaxAI call (see ./maxai/signing.ts). Never
 * throws for the caller's convenience is NOT the contract here — the route wraps
 * it in try/catch and falls back to the curated catalog — but it validates HTTP
 * status and shape and throws a sanitized error on failure so the route logs it.
 */
import { readMaxaiJson } from "../executors/maxai/response.ts";
import { isRuntimePolicyError } from "@/shared/runtimePolicy";
import { resolveMaxaiCredential } from "../executors/maxai/credentials.ts";
import { MaxaiRefreshError, ensureFreshMaxaiCredential } from "../executors/maxai/refresh.ts";
import { maxaiFetch, runMaxaiConnectionTransport } from "./maxaiTransport.ts";
import { buildMaxaiSignedHeaders } from "../executors/maxai/signing.ts";
import { ensureMaxaiConstants } from "../executors/maxai/constantsStore.ts";
import {
  maxaiStaticHeaders,
  MAXAI_BASE_URL,
  MAXAI_MODELS_CONFIG_PATH,
} from "../executors/maxai/protocol.ts";
import { maxaiContextWindow, MAXAI_MODELS } from "../executors/maxai/catalog.ts";

// Re-export the registry-shaped catalog through this service so `src/app` routes
// can consume it WITHOUT importing the executor directly (the no-restricted-imports
// rule: "executor implementations must stay behind an open-sse handler or service
// boundary"). This service IS that boundary, and already owns the catalog import.
export { MAXAI_REGISTRY_MODELS } from "../executors/maxai/catalog.ts";

/** A discovered MaxAI model in the shape persistDiscoveredModels normalizes. */
export interface MaxaiDiscoveredModel {
  id: string;
  name: string;
  /** Per-model context window (chars→tokens handled upstream); the reconciler key. */
  inputTokenLimit: number;
  group?: string;
  supportsReasoning?: boolean;
  supportsVision?: boolean;
  toolCalling: boolean;
}

export interface MaxaiModelDiscoveryInput {
  /** Required before any refresh, signing-bundle fetch, or API request. */
  connectionId?: string | null;
  /** Connection credential material (from providerSpecificData + apiKey). */
  providerSpecificData: Record<string, unknown> | null | undefined;
  accessToken?: string | null;
  refreshToken?: string | null;
  signal?: AbortSignal | null;
  /** Offline test seam. Production uses the connection-bound MaxAI transport. */
  fetchImpl?: typeof fetch;
}

export interface MaxaiModelDiscoveryResult {
  models: MaxaiDiscoveredModel[];
  warning?: string;
}

export const MAXAI_DISCOVERY_ERRORS = {
  connection: [400, "MaxAI model discovery requires a connection."],
  credentials: [401, "MaxAI credentials unavailable."],
  constants: [503, "MaxAI signing constants unavailable."],
  rejected: [502, "MaxAI model catalog unavailable."],
  invalid: [502, "MaxAI model catalog invalid."],
  empty: [502, "MaxAI model catalog empty."],
  aborted: [499, "MaxAI model discovery cancelled."],
  timeout: [504, "MaxAI model discovery timed out."],
  failed: [502, "MaxAI model discovery failed."],
} as const;
export class MaxaiDiscoveryError extends Error {
  readonly status: number;
  constructor(readonly code: keyof typeof MAXAI_DISCOVERY_ERRORS, status?: number) {
    super(MAXAI_DISCOVERY_ERRORS[code][1]);
    this.name = "MaxaiDiscoveryError";
    this.status = status ?? MAXAI_DISCOVERY_ERRORS[code][0];
  }
}

/** Race inside the transport owner so ignored I/O cannot renew it indefinitely. */
async function withDiscoverySignal<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  let abort: () => void = () => {};
  try {
    signal.throwIfAborted();
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new MaxaiDiscoveryError("aborted"));
      signal.addEventListener("abort", abort, { once: true });
    });
    return await Promise.race([run(), aborted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** The curated paid-model id set — only these are surfaced (quality gate). */
const CURATED_IDS = new Set(MAXAI_MODELS.map((m) => m.id));

interface RawChatModel {
  model_name?: unknown;
  ui_display_name?: unknown;
  type?: unknown;
  group?: unknown;
  max_tokens?: unknown;
  is_deprecated?: unknown;
  capabilities?: {
    vision?: unknown;
    thinking_mode?: unknown;
  } | null;
}

/** Map one raw chat model to a discovery record, or null when it should be dropped. */
function toDiscovered(raw: RawChatModel): MaxaiDiscoveredModel | null {
  const id = typeof raw.model_name === "string" ? raw.model_name : "";
  if (!id) return null;
  if (raw.is_deprecated === true) return null;
  if (raw.type !== undefined && raw.type !== "chat") return null;
  // Quality gate: only surface the curated paid models (the ones catalog.ts offers).
  if (!CURATED_IDS.has(id)) return null;

  const liveWindow =
    typeof raw.max_tokens === "number" && Number.isFinite(raw.max_tokens) && raw.max_tokens > 0
      ? Math.trunc(raw.max_tokens)
      : maxaiContextWindow(id); // fall back to the static catalog window

  const caps = raw.capabilities ?? {};
  return {
    id,
    name: typeof raw.ui_display_name === "string" ? raw.ui_display_name : id,
    inputTokenLimit: liveWindow,
    group: typeof raw.group === "string" ? raw.group : undefined,
    supportsReasoning: caps.thinking_mode === true || undefined,
    supportsVision: caps.vision === true || undefined,
    toolCalling: true, // prompted tool-calling (see maxai.ts + webTools.ts)
  };
}

/**
 * Fetch MaxAI's live model catalog + per-model context windows. Throws a
 * sanitized Error on auth/transport/shape failure (the route catches and falls
 * back to the curated static catalog).
 */
export async function discoverMaxaiModels(
  input: MaxaiModelDiscoveryInput,
  // Trusted offline dependency seams, never read from request input.
  dependencies: {
    runTransport?: typeof runMaxaiConnectionTransport;
    ensureCredential?: typeof ensureFreshMaxaiCredential;
  } = {}
): Promise<MaxaiModelDiscoveryResult> {
  const connectionId = input.connectionId;
  if (typeof connectionId !== "string" || !connectionId.trim()) {
    throw new MaxaiDiscoveryError("connection");
  }
  const doFetch = input.fetchImpl ?? maxaiFetch;
  const runTransport = dependencies.runTransport ?? runMaxaiConnectionTransport;
  const ensureCredential = dependencies.ensureCredential ?? ensureFreshMaxaiCredential;
  // Preserve the discovery budget without generic safeOutboundFetch, which can
  // replace the selected account proxy with a provider/global proxy.
  const timeout = AbortSignal.timeout(10_000);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;

  try {
    signal.throwIfAborted();
    return await runTransport(connectionId, () => withDiscoverySignal(signal, async () => {
      signal.throwIfAborted();
      const credential = resolveMaxaiCredential(
        input.providerSpecificData,
        input.accessToken,
        input.refreshToken
      );
      if (!credential) throw new MaxaiDiscoveryError("credentials");
      // This helper owns durable token rotation. Never write a stale connection
      // snapshot back from the discovery route after a shared refresh completes.
      const cred = await ensureCredential({
        connectionId,
        credential,
        signal,
        fetchImpl: doFetch,
      });
      signal.throwIfAborted();
      const path = MAXAI_MODELS_CONFIG_PATH;
      const constants = await ensureMaxaiConstants({ fetchImpl: doFetch, signal });
      signal.throwIfAborted();
      if (!constants) throw new MaxaiDiscoveryError("constants");
      const res = await doFetch(MAXAI_BASE_URL + path, {
        method: "POST",
        headers: {
          ...maxaiStaticHeaders(),
          ...buildMaxaiSignedHeaders(
            { path, userId: cred.userId, deviceId: cred.deviceId },
            constants
          ),
          Authorization: `Bearer ${cred.accessToken}`,
        },
        body: JSON.stringify({ language: "en", client_type: "web" }),
        signal,
        redirect: "error",
      });

      if (signal.aborted || res.status !== 200 || res.redirected ||
          (res.url && res.url !== MAXAI_BASE_URL + path)) {
        // Upstream bodies can contain credentials. Do not read or log them.
        void res.body?.cancel().catch(() => {});
        signal.throwIfAborted();
        throw new MaxaiDiscoveryError("rejected", [401, 403, 429].includes(res.status) ? res.status : 502);
      }

      let parsed: { data?: { chat_models?: unknown }; chat_models?: unknown };
      try {
        parsed = await readMaxaiJson(res, signal) as typeof parsed;
      } catch (error) {
        if (isRuntimePolicyError(error)) throw error;
        throw new MaxaiDiscoveryError("invalid");
      }
      signal.throwIfAborted();
      const data = parsed?.data ?? parsed;
      const chatModels = data?.chat_models;
      if (!Array.isArray(chatModels)) throw new MaxaiDiscoveryError("invalid");

      const models: MaxaiDiscoveredModel[] = [];
      for (const raw of chatModels) {
        if (!raw || typeof raw !== "object") continue;
        const mapped = toDiscovered(raw as RawChatModel);
        if (mapped) models.push(mapped);
      }
      if (models.length === 0) throw new MaxaiDiscoveryError("empty");

      const liveIds = new Set(models.map((m) => m.id));
      const missing = [...CURATED_IDS].filter((id) => !liveIds.has(id));
      const warning =
        missing.length > 0
          ? `MaxAI no longer offers ${missing.length} curated model(s): ${missing.join(", ")}`
          : undefined;
      return { models, warning };
    }));
  } catch (error) {
    if (isRuntimePolicyError(error)) throw error;
    // Neither transport exceptions nor caller-provided abort reasons are safe
    // to pass through the route's logs or public fallback response.
    if (input.signal?.aborted) throw new MaxaiDiscoveryError("aborted");
    if (timeout.aborted) throw new MaxaiDiscoveryError("timeout");
    if (error instanceof MaxaiDiscoveryError) throw error;
    if (error instanceof MaxaiRefreshError) throw new MaxaiDiscoveryError("credentials", error.status);
    throw new MaxaiDiscoveryError("failed");
  }
}
