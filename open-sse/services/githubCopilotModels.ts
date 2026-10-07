/**
 * GitHub Copilot live model discovery (#3120, #3121).
 *
 * The `github` provider previously relied on a static catalog and had no live
 * discovery source, so Import Models could not refresh its displayed rows.
 * This service requests the Copilot models endpoint with the configured bearer
 * token and standard chat headers. The parser accepts only explicitly handled
 * model-list shapes and filters rows using their capability/policy fields; it
 * does not infer account entitlements from model names or the fallback list.
 *
 * The curated static fallback is used only when live discovery is unavailable
 * (missing credentials, request failure, non-success status, or invalid data).
 * A successful response containing an explicit empty model list stays empty.
 */
import { getGitHubCopilotChatHeaders } from "../config/providerHeaderProfiles.ts";

export const GITHUB_COPILOT_MODELS_URL = "https://api.githubcopilot.com/models";

// Static fallback catalog. Used only when live discovery is unavailable
// (offline / unauthed / upstream error). It is a curated set of model IDs for
// fallback display; it is not merged into or used to gate a successful live response.
export const GITHUB_COPILOT_STATIC_FALLBACK_MODELS = [
  "claude-fable-5",
  "claude-opus-5",
  "claude-opus-4.8-fast",
  "claude-opus-4.8",
  "claude-opus-4.7",
  "claude-opus-4.6",
  "claude-sonnet-4.6",
  "claude-opus-4.5",
  "claude-sonnet-5",
  "claude-sonnet-4.5",
  "claude-haiku-4.5",
  "gemini-3.1-pro-preview",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.3-codex",
  "gpt-5-mini",
  "gpt-4o-2024-11-20",
  "gpt-4o-mini",
  "gpt-4-0125-preview",
  "kimi-k2.7-code",
  "mai-code-1-flash",
  "mai-code-1.1-flash",
  "mai-code-1-flash-picker",
  "grok-4.6",
  "grok-4.5",
  "oswe-vscode-prime",
] as const;

// Back-compat alias: earlier code + tests imported this name. It is now the
// static FALLBACK catalog, not a live-response gate.
export const GITHUB_COPILOT_MODEL_ALLOWLIST = GITHUB_COPILOT_STATIC_FALLBACK_MODELS;

const GITHUB_COPILOT_STATIC_FALLBACK_SET = new Set<string>(GITHUB_COPILOT_STATIC_FALLBACK_MODELS);

export type GitHubCopilotModel = {
  id: string;
  name: string;
  owned_by: string;
  supportedEndpoints?: string[];
  targetFormat?: "openai-responses";
};

type RawRecord = Record<string, unknown>;

function asRecord(value: unknown): RawRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RawRecord) : {};
}

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getEndpointMetadata(item: RawRecord, modelId: string): Partial<GitHubCopilotModel> {
  const capabilities = asRecord(item.capabilities);
  const endpoints = Array.isArray(item.supported_endpoints)
    ? item.supported_endpoints
    : Array.isArray(capabilities.supported_endpoints)
      ? capabilities.supported_endpoints
      : [];
  const supportedEndpoints = Array.from(
    new Set(
      endpoints
        .map(toNonEmptyString)
        .filter((endpoint): endpoint is string => !!endpoint)
        .map((endpoint) => endpoint.toLowerCase())
        .filter((endpoint) =>
          /^\/?(?:v1\/)?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*\/?$/.test(endpoint)
        )
        .map((endpoint) => endpoint.replace(/^\/+/, "").replace(/^v1\//, "").replace(/\/$/, ""))
        .map((endpoint) =>
          endpoint === "chat/completions" ||
          endpoint === "chat-completions" ||
          endpoint === "messages"
            ? "chat"
            : endpoint
        )
    )
  ).sort();
  if (supportedEndpoints.length === 0) return {};
  const responsesOnly =
    supportedEndpoints.includes("responses") &&
    !supportedEndpoints.includes("chat") &&
    !/claude|gemini/i.test(modelId);
  return {
    supportedEndpoints,
    ...(responsesOnly ? { targetFormat: "openai-responses" as const } : {}),
  };
}

// Decide whether a live /models row is a routable chat model. Capability-driven
// rather than an ID allowlist: keep rows marked as chat or carrying a chat-shaped
// supported_endpoints; filter rows with a disabled policy/model-picker flag and
// rows explicitly marked as non-chat (embeddings/completion).
function isRoutableChatModel(item: RawRecord): boolean {
  const policy = asRecord(item.policy);
  const policyState = toNonEmptyString(policy.state);
  if (policyState && policyState !== "enabled") return false;
  if (item.model_picker_enabled === false) return false;

  const capabilities = asRecord(item.capabilities);
  const capType = toNonEmptyString(capabilities.type);
  if (capType) return capType === "chat";

  // No capabilities.type present — fall back to supported_endpoints shape. A
  // chat model exposes /chat/completions, /responses, or /v1/messages.
  const endpoints = Array.isArray(item.supported_endpoints)
    ? (item.supported_endpoints as unknown[])
    : Array.isArray((asRecord(item.capabilities) as RawRecord).supported_endpoints)
      ? ((asRecord(item.capabilities) as RawRecord).supported_endpoints as unknown[])
      : [];
  if (endpoints.length > 0) {
    return endpoints.some((e) => {
      const s = toNonEmptyString(e) || "";
      return (
        s.includes("/chat/completions") || s.includes("/responses") || s.includes("/v1/messages")
      );
    });
  }

  // Neither signal present: keep it unless its id looks like a known non-chat
  // utility (embedding / completion sentinels). This keeps discovery permissive
  // without re-introducing a brittle positive allowlist.
  const id = (toNonEmptyString(item.id) || toNonEmptyString(item.model) || "").toLowerCase();
  if (!id) return false;
  return !(id.includes("embedding") || id === "gpt-41-copilot");
}

/**
 * Parse a Copilot `/models` response into managed chat-model rows. Keeps rows
 * in the response that match the supported chat capability/policy shape and
 * drops only rows explicitly identified as non-chat or disabled. No static IDs
 * are merged into or used to gate a successful live response.
 */
export function parseGitHubCopilotModels(data: unknown): GitHubCopilotModel[] {
  const payload = asRecord(data);
  const items = payload.data === undefined ? payload.models : payload.data;
  if (!Array.isArray(items)) {
    throw new Error("Invalid GitHub Copilot models response");
  }

  const seen = new Set<string>();
  const models: GitHubCopilotModel[] = [];

  for (const value of items) {
    const item = asRecord(value);
    const id = toNonEmptyString(item.id) || toNonEmptyString(item.model);
    if (!id || seen.has(id)) continue;
    if (!isRoutableChatModel(item)) continue;
    seen.add(id);
    const name = toNonEmptyString(item.name) || toNonEmptyString(item.display_name) || id;
    models.push({ id, name, owned_by: "github", ...getEndpointMetadata(item, id) });
  }

  return models;
}

export type FetchGitHubCopilotModelsOptions = {
  /** Copilot bearer token (copilotToken; falls back to GitHub accessToken upstream). */
  token: string | null | undefined;
  /** Injectable fetch (defaults to global fetch). */
  fetchImpl?: typeof fetch;
  /** Static catalog to fall back to when live discovery is unavailable. */
  fallbackModels?: Array<{ id: string; name?: string }>;
};

export type GitHubCopilotModelsResult = {
  models: GitHubCopilotModel[];
  /** "api" = live discovery; "fallback" = static catalog (offline/unauthed/error). */
  source: "api" | "fallback";
};

function toFallbackResult(
  fallbackModels: Array<{ id: string; name?: string }> | undefined
): GitHubCopilotModelsResult {
  const models = (fallbackModels || [])
    .map((model) => {
      const id = toNonEmptyString(model.id);
      if (!id) return null;
      if (!GITHUB_COPILOT_STATIC_FALLBACK_SET.has(id)) return null;
      return { id, name: toNonEmptyString(model.name) || id, owned_by: "github" };
    })
    .filter((model): model is GitHubCopilotModel => Boolean(model));
  return { models, source: "fallback" };
}

/**
 * Discover the Copilot model catalog live, falling back to the static catalog
 * when no token is available or the upstream request fails.
 */
export async function fetchGitHubCopilotModels(
  options: FetchGitHubCopilotModelsOptions
): Promise<GitHubCopilotModelsResult> {
  const { token, fetchImpl = fetch, fallbackModels } = options;

  if (!toNonEmptyString(token)) {
    return toFallbackResult(fallbackModels);
  }

  try {
    const response = await fetchImpl(GITHUB_COPILOT_MODELS_URL, {
      method: "GET",
      headers: {
        ...getGitHubCopilotChatHeaders("application/json"),
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      return toFallbackResult(fallbackModels);
    }

    const data = await response.json();
    const models = parseGitHubCopilotModels(data);
    return { models, source: "api" };
  } catch {
    // Network/parse/schema failure — never break the import flow.
    return toFallbackResult(fallbackModels);
  }
}

/**
 * GHE Copilot live model discovery.
 *
 * The GHE token endpoint returns TWO hosts in `endpoints`:
 *   - `endpoints.api`   (copilotApiUrl)   → chat/completions + the real chat
 *      model catalog. Response shape is `{ data: [{ id, name, ... }] }` (same
 *      shape as github.com's api.githubcopilot.com/models).
 *   - `endpoints.proxy` (copilotProxyUrl) → NES / autocomplete / instant-apply
 *      models only. Response shape is `{ models: [{ name, ... }] }`.
 *
 * We discover from the `api` host so the imported catalog is the real chat
 * models (claude-*, gpt-*, gemini-*), not the completion-only proxy set. Unlike
 * github.com, the IDs are enterprise-specific, so NO static allowlist applies —
 * every id in the live response is kept. Both response shapes are parsed so a
 * legacy connection that still points at the proxy host keeps working.
 */
function asGheRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function parseGheCopilotModels(data: unknown): GitHubCopilotModel[] {
  const payload = asGheRecord(data);
  // api host → { data: [{ id }] }; proxy host → { models: [{ name }] }.
  const items = Array.isArray(payload.data)
    ? (payload.data as unknown[])
    : Array.isArray(payload.models)
      ? (payload.models as unknown[])
      : [];

  const seen = new Set<string>();
  const models: GitHubCopilotModel[] = [];

  for (const value of items) {
    const item = asGheRecord(value);
    // api host uses `id`; proxy host uses `name` as the model id.
    const id = toNonEmptyString(item.id) || toNonEmptyString(item.name);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name =
      toNonEmptyString(item.name) ||
      toNonEmptyString(item.display_name) ||
      toNonEmptyString(item.label) ||
      id;
    models.push({
      id,
      name,
      owned_by: toNonEmptyString(item.vendor || item.provider) || "ghe-copilot",
    });
  }

  return models;
}

export type FetchGheCopilotModelsOptions = {
  /**
   * Copilot API base URL (providerSpecificData.copilotApiUrl, from
   * endpoints.api). This is the host that serves the real chat model catalog.
   */
  apiUrl: string | null | undefined;
  /** Copilot bearer token. */
  token: string | null | undefined;
  /** Injectable fetch (defaults to global fetch). */
  fetchImpl?: typeof fetch;
};

/**
 * Discover the GHE Copilot model catalog live from `<apiUrl>/models`.
 * Returns an empty list (no fallback catalog) when discovery is unavailable —
 * GHE model IDs are enterprise-specific, so a static fallback would be wrong.
 */
export async function fetchGheCopilotModels(
  options: FetchGheCopilotModelsOptions
): Promise<GitHubCopilotModel[]> {
  const { apiUrl, token, fetchImpl = fetch } = options;
  const base = toNonEmptyString(apiUrl);
  if (!base || !toNonEmptyString(token)) return [];

  try {
    const response = await fetchImpl(`${base.replace(/\/+$/, "")}/models`, {
      method: "GET",
      headers: {
        ...getGitHubCopilotChatHeaders("application/json"),
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) return [];
    const data = await response.json();
    return parseGheCopilotModels(data);
  } catch {
    return [];
  }
}
