export type ServiceTierId = "standard" | "priority" | "ultrafast" | "flex";

export type TranslationFn = ((key: string, values?: Record<string, unknown>) => string) & {
  has?: (key: string) => boolean;
};

const SERVICE_TIER_LABEL_KEYS: Record<ServiceTierId, string> = {
  priority: "serviceTierFast",
  ultrafast: "serviceTierUltrafast",
  flex: "serviceTierFlex",
  standard: "serviceTierStandard",
};

const SERVICE_TIER_FALLBACK_LABELS: Record<ServiceTierId, string> = {
  priority: "Fast",
  ultrafast: "Ultrafast",
  flex: "Flex",
  standard: "Standard",
};

export function normalizeServiceTierId(value: unknown): ServiceTierId {
  const tier = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (tier === "priority" || tier === "fast") return "priority";
  if (tier === "ultrafast") return "ultrafast";
  if (tier === "flex") return "flex";
  return "standard";
}

export function translateCostText(t: TranslationFn, key: string, fallback: string): string {
  return typeof t.has === "function" && t.has(key) ? t(key) : fallback;
}

export function getServiceTierDisplayLabel(
  t: TranslationFn,
  serviceTier: unknown,
  fallback?: unknown
): string {
  const normalized = normalizeServiceTierId(serviceTier);
  const fallbackText = typeof fallback === "string" ? fallback.trim() : "";
  const fallbackLabel =
    fallbackText && normalizeServiceTierId(fallbackText) !== normalized
      ? fallbackText
      : SERVICE_TIER_FALLBACK_LABELS[normalized];
  return translateCostText(t, SERVICE_TIER_LABEL_KEYS[normalized], fallbackLabel);
}
