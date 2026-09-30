import { isRuntimePolicyError } from "@/shared/runtimePolicy";
import { parseVertexPublisherModels, type VertexPublisherDiscoveryModel } from "./vertexPublisherModelsParser.ts";

export type VertexModelDiscoveryFetch = (url: string, init: RequestInit) => Promise<Response>;
export interface VertexModelDiscoveryResult {
  models: Array<VertexPublisherDiscoveryModel | Record<string, unknown>>;
  warning?: string;
  failureStatus?: number;
  unavailable?: boolean;
}
const PAGE_SIZE = 300;
const MAX_PAGES = 20;

/** Service-account/OAuth credentials belong to Vertex, not Generative Language. */
export async function discoverVertexModelsWithBearer(options: {
  bearerToken: string;
  fetchImpl: VertexModelDiscoveryFetch;
}): Promise<VertexModelDiscoveryResult> {
  const models = new Map<string, VertexPublisherDiscoveryModel>();
  let failureStatus: number | undefined;
  let incomplete = false;
  // Keep the existing two publishers; this is not a Model Garden product expansion.
  for (const publisher of ["google", "anthropic"]) {
    const base = `https://aiplatform.googleapis.com/v1beta1/publishers/${publisher}/models`;
    let token: string | undefined;
    const seen = new Set<string>();
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const url = new URL(base);
        url.searchParams.set("pageSize", String(PAGE_SIZE));
        if (token) url.searchParams.set("pageToken", token);
        const response = await options.fetchImpl(url.toString(), {
          method: "GET",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.bearerToken}` },
        });
        if (!response.ok) {
          failureStatus ??= response.status;
          incomplete = true;
          break;
        }
        const data: unknown = await response.json();
        for (const model of parseVertexPublisherModels(data, publisher)) models.set(model.id, model);
        const next = data && typeof data === "object" ? (data as { nextPageToken?: unknown }).nextPageToken : null;
        if (typeof next !== "string" || !next) break;
        if (seen.has(next) || page === MAX_PAGES - 1) { incomplete = true; break; }
        seen.add(next);
        token = next;
      }
    } catch (error) {
      if (isRuntimePolicyError(error)) throw error;
      incomplete = true;
    }
  }
  return {
    models: [...models.values()],
    ...(incomplete ? { warning: "Some Vertex catalogs were unavailable — imported available models" } : {}),
    ...(models.size === 0 && failureStatus ? { failureStatus } : {}),
    ...(models.size === 0 && incomplete ? { unavailable: true } : {}),
  };
}

/** Express keys have no list-all API. Validate on Vertex and return the local catalog. */
export async function discoverVertexModelsWithApiKey(options: {
  apiKey: string;
  fetchImpl: VertexModelDiscoveryFetch;
  curatedModels?: Array<{ id: string; name?: string; [key: string]: unknown }>;
}): Promise<VertexModelDiscoveryResult> {
  try {
    const response = await options.fetchImpl(
      "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.7-flash",
      { method: "GET", headers: { "Content-Type": "application/json", "x-goog-api-key": options.apiKey } }
    );
    if (!response.ok) return { models: [], failureStatus: response.status, unavailable: ![400, 401, 403].includes(response.status) };
    return {
      models: options.curatedModels ?? [],
      warning: "Vertex Express does not expose model listing — using local catalog",
    };
  } catch (error) {
    if (isRuntimePolicyError(error)) throw error;
    return { models: [], unavailable: true };
  }
}
