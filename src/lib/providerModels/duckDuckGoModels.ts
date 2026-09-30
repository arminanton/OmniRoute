import {
  DUCKDUCKGO_MODELS_URL,
  extractFreeDuckDuckGoModelIds,
} from "@omniroute/open-sse/executors/duckduckgo-web/models.ts";
import { SAFE_OUTBOUND_FETCH_PRESETS, safeOutboundFetch } from "@/shared/network/safeOutboundFetch";
import { getProviderOutboundGuard } from "@/shared/network/outboundUrlGuardPolicy";
import { isRuntimePolicyError } from "@/shared/runtimePolicy";

/** Public catalog only. Never acquire a session or send an inference request. */
export async function discoverDuckDuckGoModels(
  fetchModels: typeof safeOutboundFetch = safeOutboundFetch
): Promise<Array<{ id: string; name: string }> | null> {
  try {
    const response = await fetchModels(DUCKDUCKGO_MODELS_URL, {
      ...SAFE_OUTBOUND_FETCH_PRESETS.modelsDiscovery,
      guard: getProviderOutboundGuard(),
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;
    const payload: unknown = await response.json();
    if (
      !payload ||
      typeof payload !== "object" ||
      !Array.isArray((payload as { models?: unknown }).models)
    )
      return null;
    const rows = (payload as { models: unknown[] }).models.filter(
      (item): item is Record<string, unknown> =>
        !!item && typeof item === "object" && !Array.isArray(item)
    );
    const validRows = rows.filter(
      (item) => typeof item.id === "string" && item.id.trim().length > 0
    );
    const freeIds = extractFreeDuckDuckGoModelIds({ models: validRows });
    return [...freeIds].map((id) => {
      const row = validRows.find((item) => item.id === id);
      const name = typeof row?.name === "string" && row.name.trim() ? row.name : id;
      return { id, name };
    });
  } catch (error) {
    if (isRuntimePolicyError(error)) throw error;
    return null;
  }
}
