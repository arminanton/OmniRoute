/** Per-attempt API-key, connection and priced-token accounting for image requests. */
import { getPricingForModel } from "@/lib/db/settings";
import { normalizeModelName } from "./costCalculator";
import { runWithCallLogApiKeyContext } from "./callLogApiKeyContext";
import { saveRequestUsage } from "./usageHistory";

export interface ImageRequestAccounting {
  endpoint: string;
  provider: string;
  model: string | null | undefined;
  apiKeyInfo?: { id?: string; name?: string } | null;
  credentials?: unknown;
  startTime: number;
  comboStrategy?: string | null;
}

function connectionIdOf(credentials: unknown): string | null {
  if (!credentials || typeof credentials !== "object") return null;
  const connectionId = (credentials as { connectionId?: unknown }).connectionId;
  return typeof connectionId === "string" && connectionId.trim() ? connectionId.trim() : null;
}

const TOKEN_COUNT_FIELDS = [
  "input",
  "prompt_tokens",
  "input_tokens",
  "cacheRead",
  "cached_tokens",
  "cache_read_input_tokens",
  "cacheCreation",
  "cache_creation_input_tokens",
  "output",
  "completion_tokens",
  "output_tokens",
  "reasoning",
  "reasoning_tokens",
] as const;

function upstreamUsageOf(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== "object") return null;
  const usage = (result as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;

  const tokenUsage = usage as Record<string, unknown>;
  const hasTokenCount = TOKEN_COUNT_FIELDS.some((field) =>
    Object.prototype.hasOwnProperty.call(tokenUsage, field)
  );
  const validCounts = TOKEN_COUNT_FIELDS.every((field) => {
    if (!Object.prototype.hasOwnProperty.call(tokenUsage, field)) return true;
    const count = tokenUsage[field];
    return typeof count === "number" && Number.isFinite(count) && count >= 0;
  });
  return hasTokenCount && validCounts ? tokenUsage : null;
}

function providerLocalModel(provider: string, model: string | null | undefined): string {
  const value = typeof model === "string" ? model : "";
  return value.startsWith(`${provider}/`) ? value.slice(provider.length + 1) : value;
}

export async function runImageRequestWithAccounting<T>(
  accounting: ImageRequestAccounting,
  attempt: () => Promise<T>
): Promise<T> {
  const connectionId = connectionIdOf(accounting.credentials);
  const apiKeyId = accounting.apiKeyInfo?.id || null;
  const apiKeyName = accounting.apiKeyInfo?.name || null;
  const result = await runWithCallLogApiKeyContext({ apiKeyId, apiKeyName, connectionId }, attempt);
  const usage = upstreamUsageOf(result);
  if (
    (result as { success?: unknown } | null)?.success !== true ||
    !usage ||
    !accounting.provider
  ) {
    return result;
  }

  const model = providerLocalModel(accounting.provider, accounting.model);
  if (!model) return result;
  // Match calculateCost's model normalization before deciding whether usage is chargeable.
  // Unpriced usage trips fail-closed API-key quota checks (#12341).
  let pricing: unknown = null;
  try {
    pricing = await getPricingForModel(accounting.provider, model);
    const normalizedModel = normalizeModelName(model);
    if (!pricing && normalizedModel !== model) {
      pricing = await getPricingForModel(accounting.provider, normalizedModel);
    }
  } catch {
    // Accounting must not turn a successful upstream image response into an error.
    return result;
  }
  if (!pricing) return result;

  const latencyMs = Date.now() - accounting.startTime;
  await saveRequestUsage({
    provider: accounting.provider,
    model,
    tokens: usage,
    status: "200",
    success: true,
    latencyMs,
    timeToFirstTokenMs: latencyMs,
    connectionId,
    apiKeyId,
    apiKeyName,
    comboStrategy: accounting.comboStrategy,
    endpoint: accounting.endpoint,
  });
  return result;
}
