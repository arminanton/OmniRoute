import {
  bindRuntimeProviderData,
  validateProviderNodeCandidate,
  validateProviderConnectionCandidate,
} from "@/shared/runtimePolicyEntrypoints";
import { isRuntimePolicyError, getRuntimePolicy, RuntimePolicyError } from "@/shared/runtimePolicy";
import { resolveProviderNodeForConnection } from "@/lib/db/providers/nodes";
import {
  requireCompatibleBaseUrl,
  getRegistryEntry,
} from "@omniroute/open-sse/config/providerRegistry.ts";

type JsonRecord = Record<string, unknown>;

/**
 * Rehydrate only from the persisted connection's provider identity, never from
 * request data or a copied baseUrl. Use an uncached node read: another process
 * may delete/change the node without invalidating this process's 5s read cache.
 * A bare legacy type is accepted only when the DB selector finds one node.
 */
export async function hydrateCompatibleNodeBaseUrl(
  provider: string,
  providerSpecificData: JsonRecord
): Promise<JsonRecord> {
  if (
    !provider.startsWith("openai-compatible-") &&
    !provider.startsWith("anthropic-compatible-") &&
    provider !== "anthropic-compatible"
  ) {
    return providerSpecificData;
  }
  try {
    const node = await resolveProviderNodeForConnection(provider);
    if (!node) {
      if (getRuntimePolicy().mode === "locked")
        throw new RuntimePolicyError("entrypoint-unapproved");
      return { ...providerSpecificData, baseUrl: undefined };
    }
    validateProviderNodeCandidate(node);
    const baseUrl = requireCompatibleBaseUrl(provider, node);
    return bindRuntimeProviderData(
      {
        ...providerSpecificData,
        baseUrl,
        prefix: node.prefix,
        apiType: node.apiType,
        nodeName: node.name,
        chatPath: node.chatPath,
        modelsPath: node.modelsPath,
        customHeaders: node.customHeaders,
      },
      { kind: "node", providerId: String(node.id), nodeId: String(node.id) }
    );
  } catch (error) {
    if (isRuntimePolicyError(error)) throw error;
    if (getRuntimePolicy().mode === "locked") throw new RuntimePolicyError("entrypoint-unapproved");
    // Invalidate even a previously populated copied URL. Do not throw at this
    // boundary: credential selection may already own a managed lease. The
    // executor fails before fetch and the existing request cleanup releases it.
    return { ...providerSpecificData, baseUrl: undefined };
  }
}

/**
 * Server-only connection admission for discovery and persistence. The caller must
 * USE the returned candidate: approving a fresh node but sending the copied URL
 * from an old connection would make the check meaningless. No DB work or object
 * replacement occurs in standalone mode.
 */
export async function assertResolvedProviderConnectionEntrypoint<
  T extends Readonly<Record<string, unknown>>,
>(candidate: T): Promise<T> {
  if (getRuntimePolicy().mode !== "locked") return candidate;
  const storedProvider = typeof candidate.provider === "string" ? candidate.provider : "";
  const provider = getRegistryEntry(storedProvider)?.id ?? storedProvider;
  const rawData = candidate.providerSpecificData;
  const data =
    rawData && typeof rawData === "object" && !Array.isArray(rawData)
      ? (rawData as Record<string, unknown>)
      : {};
  const providerSpecificData = await hydrateCompatibleNodeBaseUrl(
    storedProvider,
    bindRuntimeProviderData(data, {
      kind: "connection",
      providerId: provider,
      connectionId: typeof candidate.id === "string" ? candidate.id : "",
    })
  );
  const effective = { ...candidate, provider, providerSpecificData };
  const selection = validateProviderConnectionCandidate(effective);
  if (selection)
    effective.provider =
      selection.kind === "builtin" ? selection.providerId : selection.binding.providerId;
  return effective;
}
