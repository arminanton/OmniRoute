import type { UnpricedUsageBudgetPolicy } from "@/shared/utils/featureFlags";

export interface UnpricedUsageModel {
  provider: string;
  model: string;
}

export function isUnpricedUsagePolicyBlocked(
  policy: UnpricedUsageBudgetPolicy,
  dailyLimited: boolean,
  weeklyLimited: boolean,
  dailyUnpricedModels: UnpricedUsageModel[],
  weeklyUnpricedModels: UnpricedUsageModel[],
  dailyPricingFailure: boolean,
  weeklyPricingFailure: boolean
): boolean {
  if ((dailyLimited && dailyPricingFailure) || (weeklyLimited && weeklyPricingFailure)) return true;
  return (
    policy === "fail_closed" &&
    ((dailyLimited && dailyUnpricedModels.length > 0) ||
      (weeklyLimited && weeklyUnpricedModels.length > 0))
  );
}

export function buildUnpricedUsageMessage(
  dailyUnpricedModels: UnpricedUsageModel[],
  weeklyUnpricedModels: UnpricedUsageModel[],
  pricingFailure: boolean
): string {
  if (pricingFailure) {
    return "Unable to enforce this API key's USD usage limit because a pricing lookup failed. Repair pricing data and retry; lookup failures always fail closed.";
  }
  const models = [...dailyUnpricedModels, ...weeklyUnpricedModels];
  const uniqueModels = [...new Set(models.map(({ provider, model }) => `${provider}/${model}`))];
  const affected = uniqueModels.length ? ` Missing prices: ${uniqueModels.join(", ")}.` : "";
  return `Unable to enforce this API key's USD usage limit because usage has no configured model price.${affected} Add model pricing or set UNPRICED_USAGE_BUDGET_POLICY=count_as_zero to allow genuinely unpriced usage.`;
}
