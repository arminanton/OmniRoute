import { isApiKeyRevealEnabledFlag } from "@/shared/utils/featureFlags";

const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);

export function isApiKeyRevealEnabled(): boolean {
  try {
    return isApiKeyRevealEnabledFlag();
  } catch {
    const raw = String(process.env.ALLOW_API_KEY_REVEAL || "")
      .trim()
      .toLowerCase();
    return ENABLED_VALUES.has(raw);
  }
}

export function maskStoredApiKey(key: unknown): string | null {
  if (typeof key !== "string") return null;
  // Do not reveal a complete short credential through overlapping prefix/suffix slices.
  if (key.length <= 16) return "****";
  return key.slice(0, 8) + "****" + key.slice(-4);
}
