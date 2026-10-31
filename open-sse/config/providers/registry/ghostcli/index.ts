import type { RegistryEntry, RegistryModel } from "../../shared.ts";

/**
 * GhostCLI (https://ghostcli.cloud) — High-throughput Enterprise API gateway
 * providing 1,000,000 token context window on all models with 1,000 RPM capacity.
 *
 * Exposes multiple protocol surfaces:
 *  - Anthropic Messages: /v1/messages
 *  - OpenAI Responses: /v1/responses
 *  - OpenAI Chat Completions: /v1/chat/completions
 *  - Gemini GenerateContent: /v1beta/models/{model}:generateContent
 *
 * Authentication accepts Authorization: Bearer gcli_... or x-api-key: gcli_...
 * IP whitelisting is required on the GhostCLI dashboard (e.g. 66.183.196.137).
 */
export const GHOSTCLI_MODELS: RegistryModel[] = [
  {
    id: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    supportsVision: true,
    supportsReasoning: true,
    toolCalling: true,
    contextLength: 1000000,
    maxOutputTokens: 128000,
    targetFormat: "claude",
  },
  {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    supportsVision: true,
    supportsReasoning: true,
    toolCalling: true,
    contextLength: 1000000,
    maxOutputTokens: 128000,
    targetFormat: "claude",
  },
  {
    id: "claude-fable-5.1",
    name: "Claude Fable 5.1",
    supportsVision: true,
    supportsReasoning: true,
    toolCalling: true,
    contextLength: 1000000,
    maxOutputTokens: 128000,
    targetFormat: "claude",
  },
  {
    id: "z-ai/glm-5.3",
    name: "GLM 5.3",
    supportsReasoning: true,
    toolCalling: true,
    contextLength: 1000000,
    maxOutputTokens: 128000,
  },
  {
    id: "z-ai/glm-5.3-flash",
    name: "GLM 5.3 Flash",
    supportsReasoning: true,
    toolCalling: true,
    contextLength: 1000000,
    maxOutputTokens: 8192,
  },
  {
    id: "gpt-6-astra",
    name: "GPT-6 Astra",
    supportsVision: true,
    supportsReasoning: true,
    toolCalling: true,
    contextLength: 1000000,
    maxOutputTokens: 128000,
    targetFormat: "openai-responses",
  },
];

export const ghostcliProvider: RegistryEntry = {
  id: "ghostcli",
  alias: "gcli",
  additionalAliases: ["ghost-cli"],
  format: "openai",
  executor: "ghostcli",
  baseUrl: "https://ghostcli.cloud/v1/chat/completions",
  responsesBaseUrl: "https://ghostcli.cloud/v1/responses",
  messagesUrl: "https://ghostcli.cloud/v1/messages",
  testKeyModelsUrl: "https://ghostcli.cloud/v1/models",
  authType: "apikey",
  authHeader: "bearer",
  defaultContextLength: 1000000,
  models: GHOSTCLI_MODELS,
};
