import { BaseExecutor, type ProviderCredentials } from "./base.ts";
import { PROVIDERS } from "../config/constants.ts";
import { getModelTargetFormat, PROVIDER_ID_TO_ALIAS } from "../config/providerModels.ts";

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

  private usesMessagesEndpoint(model: string): boolean {
    const alias = PROVIDER_ID_TO_ALIAS[this.provider] || this.provider;
    const target = getModelTargetFormat(alias, model);
    return target === "claude" || /^claude/i.test(model);
  }

  private usesResponsesEndpoint(model: string): boolean {
    const alias = PROVIDER_ID_TO_ALIAS[this.provider] || this.provider;
    const target = getModelTargetFormat(alias, model);
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
    return cleanedBody;
  }
}

export default GhostCliExecutor;
