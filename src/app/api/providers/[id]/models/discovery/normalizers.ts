import { createHash } from "node:crypto";
import { SAFE_OUTBOUND_FETCH_PRESETS, safeOutboundFetch } from "@/shared/network/safeOutboundFetch";
import { getProviderOutboundGuard } from "@/shared/network/outboundUrlGuardPolicy";
import {
  getAntigravityModelsDiscoveryUrls,
  getAntigravityFetchAvailableModelsUrls,
} from "@omniroute/open-sse/config/antigravityUpstream.ts";
import { getAntigravityContentHeaders } from "@omniroute/open-sse/services/antigravityHeaders.ts";
import { resolveAntigravityClientVersion } from "@omniroute/open-sse/services/antigravityClientProfile.ts";
import {
  getClientVisibleAntigravityModelName,
  isDiscoverableAntigravityModelId,
  toClientAntigravityModelId,
} from "@omniroute/open-sse/config/antigravityModelAliases.ts";
import {
  getClientVisibleAgyModelName,
  isDiscoverableAgyModelId,
} from "@omniroute/open-sse/config/agyModels.ts";
import { normalizeAntigravityClientProfile } from "@/shared/constants/antigravityClientProfile";
import {
  ensureAntigravityProjectAssigned,
  ANTIGRAVITY_REQUIRES_MANUAL_PROJECT,
} from "@omniroute/open-sse/services/antigravityProjectBootstrap.ts";
import { persistDiscoveredAntigravityProjectId } from "@omniroute/open-sse/services/antigravityProjectPersist.ts";
import { asRecord, toNonEmptyString } from "./helpers";
import {
  normalizeCodeAssistDiscovery,
  normalizeCodeAssistCatalogReply,
  type CodeAssistDiscoveredModel,
} from "@omniroute/open-sse/services/codeAssistDiscovery.ts";
import { expandAntigravityClaudeEffortModels } from "@omniroute/open-sse/config/antigravityClaudeEffort.ts";

const antigravityDiscoveryInflight = new Map<
  string,
  Promise<Array<{ id: string; name: string }> | null>
>();

type AntigravityDiscoveryModel = CodeAssistDiscoveredModel;

export const normalizeAntigravityModelsResponse = normalizeCodeAssistDiscovery;

export function filterUserCallableAntigravityModels(
  models: AntigravityDiscoveryModel[],
  provider: "antigravity" | "agy" = "antigravity"
) {
  return models.filter(
    (model) =>
      model.isInternal !== true &&
      model.disabled !== true &&
      (provider === "agy"
        ? isDiscoverableAgyModelId(model.id)
        : isDiscoverableAntigravityModelId(model.id))
  );
}

export function mapAntigravityModelForClient(
  model: AntigravityDiscoveryModel,
  provider: "antigravity" | "agy" = "antigravity"
): {
  id: string;
  name: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportsAdaptiveThinking?: boolean;
  supportsImages?: boolean;
  supportsVision?: boolean;
  supportsThinking?: boolean;
  supportsVideo?: boolean;
  supportsPdf?: boolean;
  supportedMimeTypes?: Record<string, boolean>;
  discoveryRoles?: string[];
} {
  const clientId = toClientAntigravityModelId(model.id);
  return {
    id: clientId,
    ...(typeof model.supportsImages === "boolean"
      ? { supportsImages: model.supportsImages, supportsVision: model.supportsImages }
      : {}),
    ...(typeof model.supportsThinking === "boolean"
      ? { supportsThinking: model.supportsThinking }
      : {}),
    ...(typeof model.supportsVideo === "boolean" ? { supportsVideo: model.supportsVideo } : {}),
    ...(typeof model.supportsPdf === "boolean" ? { supportsPdf: model.supportsPdf } : {}),
    ...(model.supportedMimeTypes ? { supportedMimeTypes: model.supportedMimeTypes } : {}),
    ...(model.discoveryRoles ? { discoveryRoles: model.discoveryRoles } : {}),
    ...(model.supportsAdaptiveThinking === true ? { supportsAdaptiveThinking: true } : {}),
    name:
      provider === "agy"
        ? getClientVisibleAgyModelName(clientId, model.name)
        : getClientVisibleAntigravityModelName(clientId, model.name),
    ...(typeof model.inputTokenLimit === "number"
      ? { inputTokenLimit: model.inputTokenLimit }
      : {}),
    ...(typeof model.outputTokenLimit === "number"
      ? { outputTokenLimit: model.outputTokenLimit }
      : {}),
  };
}

export async function fetchAntigravityDiscoveryModelsCached(
  accessToken: string,
  connectionId: string,
  proxy: unknown,
  providerSpecificData?: unknown,
  provider: "antigravity" | "agy" = "antigravity"
): Promise<Array<{
  id: string;
  name: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
}> | null> {
  const profile = normalizeAntigravityClientProfile(asRecord(providerSpecificData).clientProfile);
  const cacheKey = `${provider}:${connectionId}:${createHash("sha256")
    .update(JSON.stringify([accessToken, asRecord(providerSpecificData).projectId ?? null]))
    .digest("hex")}:${profile}`;
  const inflight = antigravityDiscoveryInflight.get(cacheKey);
  if (inflight) return inflight;

  const promise = (async () => {
    await resolveAntigravityClientVersion(profile);
    const bootstrapFetch: typeof fetch = (url, init) =>
      safeOutboundFetch(String(url), {
        ...SAFE_OUTBOUND_FETCH_PRESETS.modelsDiscovery,
        ...(init as Record<string, unknown>),
        guard: getProviderOutboundGuard(),
        proxyConfig: proxy,
      });
    const configured = asRecord(providerSpecificData).projectId;
    const configuredProject =
      typeof configured === "string" &&
      configured.trim() &&
      configured !== ANTIGRAVITY_REQUIRES_MANUAL_PROJECT
        ? configured.trim()
        : undefined;
    const bootstrapProject =
      configuredProject ??
      (await ensureAntigravityProjectAssigned(accessToken, bootstrapFetch, profile));
    const discovered =
      bootstrapProject === ANTIGRAVITY_REQUIRES_MANUAL_PROJECT ? undefined : bootstrapProject;
    if (discovered && !configuredProject) {
      // #8491: persist the recovered id so it survives the next token refresh
      // or process restart instead of being silently rediscovered every time.
      await persistDiscoveredAntigravityProjectId(
        connectionId,
        discovered,
        asRecord(providerSpecificData)
      );
    }

    for (const discoveryUrl of [
      ...getAntigravityFetchAvailableModelsUrls(),
      ...getAntigravityModelsDiscoveryUrls(),
    ]) {
      try {
        const response = await safeOutboundFetch(discoveryUrl, {
          ...SAFE_OUTBOUND_FETCH_PRESETS.modelsDiscovery,
          guard: getProviderOutboundGuard(),
          proxyConfig: proxy,
          method: "POST",
          headers: getAntigravityContentHeaders(profile, accessToken),
          body: JSON.stringify(discovered ? { project: discovered } : {}),
        });

        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          console.warn(`[models] ${provider} discovery failed (${response.status})`);
          continue;
        }

        const payload = (await response.json()) as unknown;
        const normalized = normalizeCodeAssistCatalogReply(payload);
        if (normalized === null) continue;
        const models = filterUserCallableAntigravityModels(normalized, provider).map((model) =>
          mapAntigravityModelForClient(model, provider)
        );
        // A signed valid empty/disabled catalog is authoritative, not API failure.
        return expandAntigravityClaudeEffortModels(models);
      } catch (error) {
        const category =
          error instanceof Error && error.name === "TimeoutError"
            ? "timeout"
            : "transport-or-payload";
        console.warn(`[models] ${provider} discovery failed (${category})`);
      }
    }

    return null;
  })().finally(() => {
    antigravityDiscoveryInflight.delete(cacheKey);
  });

  antigravityDiscoveryInflight.set(cacheKey, promise);
  return promise;
}

export function normalizeDataRobotCatalogResponse(
  data: unknown
): Array<{ id: string; name: string }> {
  const items = Array.isArray(asRecord(data).data) ? (asRecord(data).data as unknown[]) : [];

  return items
    .map((value) => {
      const item = asRecord(value);
      const model =
        toNonEmptyString(item.model) || toNonEmptyString(item.id) || toNonEmptyString(item.name);
      if (!model) return null;
      if (item.isActive === false) return null;
      const name = toNonEmptyString(item.label) || toNonEmptyString(item.displayName) || model;
      return { id: model, name };
    })
    .filter((value): value is { id: string; name: string } => Boolean(value));
}

export function normalizeOpenAiLikeModelsResponse(
  data: unknown,
  fallbackOwner: string
): Array<{ id: string; name: string; owned_by: string }> {
  const payload = asRecord(data);
  const items = Array.isArray(data)
    ? data
    : Array.isArray(payload.data)
      ? (payload.data as unknown[])
      : Array.isArray(payload.models)
        ? (payload.models as unknown[])
        : [];

  return items
    .map((value) => {
      const item = asRecord(value);
      const id =
        toNonEmptyString(item.id) || toNonEmptyString(item.model) || toNonEmptyString(item.name);
      if (!id) return null;
      const name =
        toNonEmptyString(item.display_name) ||
        toNonEmptyString(item.displayName) ||
        toNonEmptyString(item.name) ||
        id;
      const ownedBy =
        toNonEmptyString(item.owned_by) || toNonEmptyString(item.provider) || fallbackOwner;
      return { id, name, owned_by: ownedBy };
    })
    .filter((value): value is { id: string; name: string; owned_by: string } => Boolean(value));
}

export function normalizeSapModelsResponse(
  data: unknown
): Array<{ id: string; name: string; owned_by: string }> {
  const payload = asRecord(data);
  const items = Array.isArray(payload.resources) ? (payload.resources as unknown[]) : [];

  return items
    .map((value) => {
      const item = asRecord(value);
      const id =
        toNonEmptyString(item.model) || toNonEmptyString(item.id) || toNonEmptyString(item.name);
      if (!id) return null;
      const name =
        toNonEmptyString(item.displayName) ||
        toNonEmptyString(item.display_name) ||
        toNonEmptyString(item.name) ||
        id;
      const ownedBy = toNonEmptyString(item.provider) || "sap";
      return { id, name, owned_by: ownedBy };
    })
    .filter((value): value is { id: string; name: string; owned_by: string } => Boolean(value));
}

export function normalizeAzureModelsResponse(
  data: unknown,
  fallbackOwner = "azure-ai"
): Array<{ id: string; name: string; owned_by: string }> {
  const payload = asRecord(data);
  const items = Array.isArray(data)
    ? data
    : Array.isArray(payload.data)
      ? (payload.data as unknown[])
      : Array.isArray(payload.models)
        ? (payload.models as unknown[])
        : Array.isArray(payload.value)
          ? (payload.value as unknown[])
          : Array.isArray(payload.deployments)
            ? (payload.deployments as unknown[])
            : [];

  return items
    .map((value) => {
      const item = asRecord(value);
      const id =
        toNonEmptyString(item.id) ||
        toNonEmptyString(item.deployment_name) ||
        toNonEmptyString(item.deploymentName) ||
        toNonEmptyString(item.name) ||
        toNonEmptyString(item.model);
      if (!id) return null;
      const name =
        toNonEmptyString(item.display_name) ||
        toNonEmptyString(item.displayName) ||
        toNonEmptyString(item.name) ||
        id;
      const ownedBy =
        toNonEmptyString(item.owned_by) || toNonEmptyString(item.provider) || fallbackOwner;
      return { id, name, owned_by: ownedBy };
    })
    .filter((value): value is { id: string; name: string; owned_by: string } => Boolean(value));
}
