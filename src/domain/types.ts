/**
 * Domain Types — FASE-03 Architecture Refactoring
 *
 * Centralized type definitions for the OmniRoute domain layer.
 * Uses JSDoc for type safety without TypeScript compilation.
 *
 * @module domain/types
 */

/**
 * @typedef {'openai'|'claude'|'gemini'|'codex'|'deepseek'|'cohere'|'groq'|'blackbox'|'mistral'|'openrouter'} ProviderId
 */

/**
 * @typedef {'apikey'|'oauth'|'bearer'} AuthType
 */

const MODEL_CONCURRENCY_VALIDATION_ERROR =
  "Model concurrency overrides must map model IDs to integer limits from 1 to 10,000.";

export function formatModelConcurrencyOverrides(value: unknown): string {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (JSON.stringify(value, null, 2) ?? "")
    : "";
}

export function withModelConcurrencyOverride<T extends Record<string, unknown>>(
  overrides: T,
  raw: string
): T & { modelConcurrency?: Record<string, number> } {
  if (!raw.trim()) {
    return overrides as T & { modelConcurrency?: Record<string, number> };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(MODEL_CONCURRENCY_VALIDATION_ERROR);
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.entries(value).some(
      ([model, limit]) =>
        !model.trim() ||
        typeof limit !== "number" ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 10_000
    )
  ) {
    throw new Error(MODEL_CONCURRENCY_VALIDATION_ERROR);
  }
  if (Object.keys(value).length === 0) {
    return overrides as T & { modelConcurrency?: Record<string, number> };
  }
  return { ...overrides, modelConcurrency: value as Record<string, number> };
}

/**
 * @typedef {Object} ProviderConnection
 * @property {string} id - Unique connection ID
 * @property {ProviderId} provider - Provider identifier
 * @property {AuthType} authType - Authentication type
 * @property {string} name - Display name
 * @property {boolean} isActive - Whether the connection is active
 * @property {string} [apiKey] - API key (for apikey auth)
 * @property {string} [accessToken] - Access token (for oauth auth)
 * @property {string} [refreshToken] - Refresh token (for oauth auth)
 * @property {string} [email] - Email (for oauth auth)
 * @property {string} [baseUrl] - Custom base URL
 * @property {boolean} [rateLimitProtection] - Whether rate limit protection is enabled
 * @property {object} [rateLimitOverrides] - Per-connection rate limit overrides
 * @property {number} [rateLimitOverrides.rpm] - Requests per minute limit
 * @property {number} [rateLimitOverrides.rpd] - Requests per day limit
 * @property {number} [rateLimitOverrides.tpm] - Tokens per minute limit
 * @property {number} [rateLimitOverrides.tpd] - Tokens per day limit
 * @property {number} [rateLimitOverrides.minTime] - Minimum ms between requests
 * @property {number} [rateLimitOverrides.maxConcurrent] - Max concurrent requests
 * @property {Record<string, number>} [rateLimitOverrides.modelConcurrency] - Per-model concurrent caps keyed by exact upstream model ID; integer values from 1 to 10,000
 * @property {string} createdAt - ISO timestamp
 * @property {string} updatedAt - ISO timestamp
 */

/**
 * @typedef {Object} Combo
 * @property {string} id - Combo unique ID
 * @property {string} name - Display name
 * @property {'priority'|'weighted'|'round-robin'|'random'|'least-used'|'cost-optimized'} strategy - Selection strategy
 * @property {Array<string|{model: string, weight?: number}>} models - Model entries
 * @property {boolean} [isActive] - Whether the combo is active
 */

/**
 * @typedef {Object} UsageEntry
 * @property {string} id - Unique entry ID
 * @property {string} model - Model identifier
 * @property {string} provider - Provider identifier
 * @property {string} connectionId - Connection ID
 * @property {number} inputTokens - Input token count
 * @property {number} outputTokens - Output token count
 * @property {number} totalTokens - Total token count
 * @property {number} [cost] - Estimated cost in USD
 * @property {string} status - Request status (success, error, timeout)
 * @property {number} latencyMs - Response latency in milliseconds
 * @property {string} timestamp - ISO timestamp
 */

/**
 * @typedef {Object} ChatRequest
 * @property {Array<{role: string, content: string|Array}>} [messages] - OpenAI/Claude format
 * @property {Array} [input] - Responses API format
 * @property {string} [model] - Model identifier
 * @property {string} [system] - System prompt (Claude format)
 * @property {boolean} [stream] - Whether to stream response
 * @property {number} [max_tokens] - Maximum output tokens
 */

/**
 * @typedef {Object} SanitizeResult
 * @property {boolean} blocked - Whether the request was blocked
 * @property {boolean} modified - Whether the request body was modified
 * @property {Array<{pattern: string, severity: string, matched: string}>} detections - Detected patterns
 * @property {ChatRequest} [sanitizedBody] - Modified body (if redacted)
 */

/**
 * @typedef {Object} SecretsValidationResult
 * @property {boolean} valid - Whether all secrets pass validation
 * @property {Array<{name: string, issue: string}>} errors - Critical errors
 * @property {Array<{name: string, issue: string}>} warnings - Non-blocking warnings
 */

/**
 * @typedef {Object} ProxyConfig
 * @property {'http'|'https'|'socks5'} type - Proxy type
 * @property {string} host - Proxy host
 * @property {string} port - Proxy port
 * @property {string} [username] - Proxy username
 * @property {string} [password] - Proxy password
 */

/**
 * @typedef {Object} AppSettings
 * @property {boolean} requireLogin - Whether login is required
 * @property {boolean} hasPassword - Whether a password has been set
 * @property {string} [theme] - UI theme
 * @property {string} [language] - UI language
 * @property {boolean} [enableSocks5Proxy] - Whether SOCKS5 proxy is allowed
 * @property {string} [instanceName] - Instance display name
 * @property {string} [corsOrigins] - Allowed CORS origins
 * @property {boolean} [call_log_pipeline_enabled] - Whether per-request pipeline capture is enabled
 * @property {string[]} [hiddenSidebarItems] - Sidebar entry ids hidden for visual decluttering
 * @property {string[]} [hiddenSidebarGroupLabels] - Sidebar group separator labels hidden from navigation
 */

/**
 * Standard API error response shape.
 * @typedef {Object} ApiError
 * @property {number} status - HTTP status code
 * @property {string} code - Error code (e.g. 'INVALID_INPUT', 'AUTH_REQUIRED')
 * @property {string} message - Human-readable error message
 * @property {Object} [details] - Additional error details
 */

// Export nothing — this file is purely for JSDoc type definitions
export {};
