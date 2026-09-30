import { getGoogleModelEndpoints } from "./googleModelEndpoints.ts";

export interface VertexPublisherDiscoveryModel {
  id: string;
  name: string;
  supportedEndpoints: string[];
  targetFormat?: string;
  owned_by: string;
  description?: string;
}

/** Google and Anthropic only: retain the existing executor's publisher surface. */
export function parseVertexPublisherModels(data: unknown, publisher: string): VertexPublisherDiscoveryModel[] {
  if (!["google", "anthropic"].includes(publisher)) return [];
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const record = data as { publisherModels?: unknown[]; models?: unknown[] };
  const models = Array.isArray(record.publisherModels) ? record.publisherModels
    : Array.isArray(record.models) ? record.models : [];
  return models.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const model = candidate as Record<string, unknown>;
    const raw = typeof model.name === "string" ? model.name : typeof model.id === "string" ? model.id : "";
    const normalized = raw.replace(/^projects\/[^/]+\/locations\/[^/]+\//, "");
    const match = /^publishers\/([^/]+)\/models\/(.+)$/.exec(normalized);
    if (match && match[1] !== publisher) return [];
    const id = match ? match[2] : normalized;
    if (!id || id.includes("/")) return [];
    const supportedEndpoints = getGoogleModelEndpoints(model, id);
    if (!supportedEndpoints.length) return [];
    return [{
      id, name: typeof model.displayName === "string" ? model.displayName : id,
      supportedEndpoints, owned_by: publisher,
      ...(publisher === "anthropic" && supportedEndpoints.includes("chat") ? { targetFormat: "claude" } : {}),
      ...(typeof model.description === "string" ? { description: model.description } : {}),
    }];
  });
}
