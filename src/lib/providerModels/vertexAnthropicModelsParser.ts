import { parseVertexPublisherModels, type VertexPublisherDiscoveryModel } from "./vertexPublisherModelsParser.ts";

export type VertexAnthropicDiscoveryModel = VertexPublisherDiscoveryModel;

export function parseVertexAnthropicModels(data: unknown): VertexAnthropicDiscoveryModel[] {
  return parseVertexPublisherModels(data, "anthropic");
}
