import { BaseExecutor, type ProviderCredentials } from "./base.ts";
import { PROVIDERS } from "../config/constants.ts";
import { getModelTargetFormat, PROVIDER_ID_TO_ALIAS } from "../config/providerModels.ts";

/**
 * Normalization map from short aliases or alternative representations
 * to the exact canonical IDs required by upstream GhostCLI endpoints.
 */
export const GHOSTCLI_MODEL_MAP: Record<string, string> = {
  "glm-5.3": "z-ai/glm-5.3",
  "glm-5.3-flash": "z-ai/glm-5.3-flash",
  "claude-opus-5.5": "claude-opus-5-5",
  "claude-opus-5-5": "claude-opus-5-5",
  "opus-5.5": "claude-opus-5-5",
  "opus": "claude-opus-5-5",
  "claude-sonnet-5": "claude-sonnet-5",
  "sonnet-5": "claude-sonnet-5",
  "sonnet": "claude-sonnet-5",
  "claude-fable-5.1": "claude-fable-5.1",
  "claude-fable-5-1": "claude-fable-5.1",
  "fable-5.1": "claude-fable-5.1",
  "fable": "claude-fable-5.1",
  "gpt-6-astra": "gpt-6-astra",
  "astra": "gpt-6-astra",
};

/**
 * GhostCliExecutor — https://ghostcli.cloud
 *
 * GhostCLI is an Enterprise API Gateway providing 1,000,000 token context window
 * across Claude, OpenAI, and GLM models with 1,000 RPM capacity.
 *
 * Surfaces supported:
 *  - Anthropic Messages: /v1/messages (for Claude models tagged targetFormat: "claude")
 *  - OpenAI Responses: /v1/responses (for models tagged targetFormat: "openai-responses")
 *  - OpenAI Chat Completions: /v1/chat/completions (default for GLM and chat models)
 *  - Gemini GenerateContent: /v1beta/models/{model}:generateContent
 *
 * Auth accepts Authorization: Bearer gcli_... or x-api-key: gcli_...
 */
export class GhostCliExecutor extends BaseExecutor {
  constructor(provider = "ghostcli") {
    super(provider, PROVIDERS[provider]);
  }

  public normalizeModel(model: string): string {
    const stripped = (model || "").replace(/^(ghcl|ghostcli|gcli)\//i, "").trim();
    return GHOSTCLI_MODEL_MAP[stripped] || stripped;
  }

  private usesMessagesEndpoint(model: string): boolean {
    const normalized = this.normalizeModel(model);
    const alias = PROVIDER_ID_TO_ALIAS[this.provider] || this.provider;
    const target = getModelTargetFormat(alias, normalized) || getModelTargetFormat(alias, model);
    return target === "claude" || /^claude/i.test(normalized);
  }

  private usesResponsesEndpoint(model: string): boolean {
    const normalized = this.normalizeModel(model);
    const alias = PROVIDER_ID_TO_ALIAS[this.provider] || this.provider;
    const target = getModelTargetFormat(alias, normalized) || getModelTargetFormat(alias, model);
    return target === "openai-responses";
  }

  buildUrl(model: string, _stream: boolean, _urlIndex = 0): string {
    if (this.usesMessagesEndpoint(model) && this.config.messagesUrl) {
      return this.config.messagesUrl;
    }
    if (this.usesResponsesEndpoint(model) && this.config.responsesBaseUrl) {
      return this.config.responsesBaseUrl;
    }
    return this.config.baseUrl;
  }

  transformRequest(
    model: string,
    body: unknown,
    stream: boolean,
    credentials: ProviderCredentials
  ): unknown {
    const cleanedBody = super.transformRequest(model, body, stream, credentials);
    if (!cleanedBody || typeof cleanedBody !== "object" || Array.isArray(cleanedBody)) {
      return cleanedBody;
    }

    const reqObj = cleanedBody as Record<string, unknown>;
    const targetModel = this.normalizeModel(String(reqObj.model || model));
    if (targetModel) {
      reqObj.model = targetModel;
    }

    return reqObj;
  }
}

export default GhostCliExecutor;
