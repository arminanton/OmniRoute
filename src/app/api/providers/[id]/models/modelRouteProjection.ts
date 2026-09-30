import { NextResponse } from "next/server";
import { getRegistryEntry } from "@omniroute/open-sse/config/providerRegistry.ts";
import { filterChatSelectableModels } from "@omniroute/open-sse/services/modelEndpointPolicy.ts";
import { filterSelectableModels } from "@omniroute/open-sse/services/modelLifecycle.ts";
import { getModelIsHidden } from "@/lib/db/models";
import { getSettings } from "@/lib/db/settings";
import { readNoAuthModelCatalog, replaceNoAuthModelCatalog } from "@/lib/db/models/noAuthCatalog";
import { isRuntimePolicyError } from "@/shared/runtimePolicy";
import { discoverDuckDuckGoModels } from "@/lib/providerModels/duckDuckGoModels";
import { getStaticModelsForProvider } from "@/lib/providers/staticModels";
import { usesNoAuthLiveCatalog } from "@/lib/providers/noAuthCatalogPolicy";
import { SAFE_OUTBOUND_FETCH_PRESETS, safeOutboundFetch } from "@/shared/network/safeOutboundFetch";
import { getProviderOutboundGuard } from "@/shared/network/outboundUrlGuardPolicy";
import { getModelsByProviderId } from "@/shared/constants/models";
import { isProviderBlockedByIdOrAlias } from "@/shared/utils/noAuthProviders";
import { mergeLocalCatalogModels } from "./discovery/helpers";

export function filterModelsForRoute<
  T extends { id: string; supportedEndpoints?: readonly string[] },
>(provider: string, models: readonly T[], chatOnly: boolean): T[] {
  // OpenCode Free shares Zen's catalog endpoint, which also advertises paid models.
  // Match the existing executor's keyless model convention; do not change Zen/Go.
  const catalog =
    provider === "opencode"
      ? models.filter((model) => model.id === "big-pickle" || model.id.endsWith("-free"))
      : models;
  const selectable = filterSelectableModels(provider, catalog);
  return chatOnly ? filterChatSelectableModels(provider, selectable) : selectable;
}

function toLiveModel(item: Record<string, unknown>): { id: string; name: string } | null {
  const itemId = typeof item.id === "string" ? item.id.trim() : "";
  if (!itemId) return null;
  const itemName =
    typeof item.display_name === "string"
      ? item.display_name
      : typeof item.name === "string"
        ? item.name
        : itemId;
  return { id: itemId, name: itemName };
}

async function fetchLiveNoAuthModels(
  modelsUrl: string
): Promise<Array<{ id: string; name: string }> | null> {
  try {
    const liveResponse = await safeOutboundFetch(modelsUrl, {
      ...SAFE_OUTBOUND_FETCH_PRESETS.modelsDiscovery,
      guard: getProviderOutboundGuard(),
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });
    if (!liveResponse.ok) return null;

    const data: unknown = await liveResponse.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const payload = data as Record<string, unknown>;
    const rows = payload.data ?? payload.models;
    if (!Array.isArray(rows)) return null;
    const liveModels: Array<{ id: string; name: string }> = [];
    for (const row of rows) {
      if (!row || typeof row !== "object" || Array.isArray(row)) return null;
      const model = toLiveModel(row as Record<string, unknown>);
      if (!model) return null;
      liveModels.push(model);
    }
    return liveModels;
  } catch (error) {
    if (isRuntimePolicyError(error)) throw error;
    return null;
  }
}

export async function buildNoAuthModelsResponse(
  providerId: string,
  connectionId: string,
  excludeHidden: boolean,
  chatOnly: boolean
) {
  if (isProviderBlockedByIdOrAlias(providerId, (await getSettings()).blockedProviders)) {
    return NextResponse.json({ error: "Provider is disabled" }, { status: 403 });
  }

  const registryEntry = getRegistryEntry(providerId);
  const modelsUrl =
    typeof registryEntry?.modelsUrl === "string" && registryEntry.modelsUrl.length > 0
      ? registryEntry.modelsUrl
      : null;
  const hasLiveDiscovery = !!modelsUrl || providerId === "duckduckgo-web";
  const liveModels =
    providerId === "duckduckgo-web"
      ? await discoverDuckDuckGoModels()
      : modelsUrl
        ? await fetchLiveNoAuthModels(modelsUrl)
        : null;

  if (liveModels !== null) {
    // Store provider eligibility/lifecycle decisions, never request-specific visibility.
    const catalogModels = filterModelsForRoute(providerId, liveModels, false);
    let persistenceWarning: string | undefined;
    try {
      if (usesNoAuthLiveCatalog(providerId)) {
        await replaceNoAuthModelCatalog(providerId, catalogModels);
      }
    } catch {
      persistenceWarning = "Live catalog loaded but could not be saved";
    }
    const selectable = filterModelsForRoute(providerId, catalogModels, chatOnly);
    const visible = excludeHidden
      ? selectable.filter((model) => !getModelIsHidden(providerId, model.id))
      : selectable;
    return NextResponse.json({
      provider: providerId,
      connectionId,
      models: visible,
      source: "upstream",
      authoritative: true,
      ...(persistenceWarning ? { warning: persistenceWarning } : {}),
    });
  }

  if (hasLiveDiscovery && usesNoAuthLiveCatalog(providerId)) {
    const snapshot = await readNoAuthModelCatalog(providerId);
    if (snapshot) {
      const selectable = filterModelsForRoute(providerId, snapshot.models, chatOnly);
      const visible = excludeHidden
        ? selectable.filter((model) => !getModelIsHidden(providerId, model.id))
        : selectable;
      return NextResponse.json({
        provider: providerId,
        connectionId,
        models: visible,
        source: "cache",
        authoritative: true,
        fetchedAt: snapshot.fetchedAt,
        warning:
          "Upstream catalog unavailable — using last discovered catalog; availability is unverified",
      });
    }
  }

  const catalog = mergeLocalCatalogModels(
    getModelsByProviderId(providerId) || [],
    getStaticModelsForProvider(providerId) || []
  ).map((model) => ({ id: model.id, name: model.name || model.id }));
  const selectable = filterModelsForRoute(providerId, catalog, chatOnly);
  const visible = excludeHidden
    ? selectable.filter((model) => !getModelIsHidden(providerId, model.id))
    : selectable;
  return NextResponse.json({
    provider: providerId,
    connectionId,
    models: visible,
    source: "local_catalog",
    ...(hasLiveDiscovery
      ? {
          warning: "Upstream catalog unavailable — using local catalog; availability is unverified",
        }
      : {}),
  });
}
