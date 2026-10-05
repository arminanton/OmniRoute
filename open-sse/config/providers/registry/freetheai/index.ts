import type { RegistryEntry } from "../../shared.ts";

// FreeTheAi — OpenAI-compatible gateway with a free tier (issue #6670).
// Same shape as the chutes aggregator entries: standard OpenAI
// chat/completions + /v1/models discovery, so no custom executor/translator
// is needed.
//
// #15385: model ids are namespaced and must be sent in full (fta/<group>/<model>).
export const freetheaiProvider: RegistryEntry = {
  id: "freetheai",
  alias: "fta",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.freetheai.org/v1/chat/completions",
  modelsUrl: "https://api.freetheai.org/v1/models",
  authType: "apikey",
  authHeader: "bearer",
  passthroughModels: true,
  defaultContextLength: 128000,
  // Fallback only; the live /v1/models list is authoritative after sync.
  models: [
    { id: "fta/zai/glm-5.3", name: "GLM 5.3 (zai)" },
    { id: "fta/kimi/k3", name: "Kimi K3" },
  ],
};
