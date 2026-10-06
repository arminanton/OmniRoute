/** Account allowances and purchased credits are not USD API token prices. */
const source = "https://learn.chatgpt.com/docs/pricing";
const standardCredits: Record<string, { input: number; cached: number; output: number }> = {
  "gpt-6-astra": { input: 250, cached: 25, output: 1250 },
  "gpt-6.1-sol": { input: 50, cached: 2.5, output: 250 },
  "gpt-6-sol": { input: 50, cached: 5, output: 250 },
  "gpt-6-luna": { input: 2.5, cached: 0.25, output: 12.5 },
  "gpt-5.6-sol": { input: 100, cached: 10, output: 500 },
  "gpt-5.6-terra": { input: 50, cached: 5, output: 300 },
  "gpt-5.6-luna": { input: 5, cached: 0.5, output: 30 },
};

export function getCodexBillingMetadata(provider: string | null, model: string | null) {
  if ((provider !== "codex" && provider !== "cx") || !model) return null;
  const base = model.replace(/-(?:none|low|medium|high|xhigh|max|ultra)$/i, "");
  const rates = standardCredits[base];
  if (!rates) return null;
  return {
    source,
    verified_at: "2026-10-06",
    dollar_pricing_basis: "token_value_estimate_not_subscription_invoice",
    credit_rates: { unit: "credits_per_million_tokens", ...rates, cache_creation: 0 },
    speed_metering: {
      // These describe billing only; upstream entitlement and requested tier decide availability.
      fast: { included_allowance_multiplier: 2.5, purchased_credit_multiplier: 2 },
      ...(base === "gpt-6-astra"
        ? {
            ultrafast: { included_allowance_multiplier: 8, purchased_credit_multiplier: 6 },
          }
        : {}),
    },
    notes:
      "Speed metering is not a speed guarantee. Legacy agreements and actual account usage may differ; no USD conversion is inferred.",
  };
}

export function getCodexLifecycleNotice(provider: string | null, model: string | null) {
  if ((provider !== "codex" && provider !== "cx") || !model) return null;
  const base = model.replace(/-(?:none|low|medium|high|xhigh|max|ultra)$/i, "");
  const dates: Record<string, string> = {
    "gpt-5.3-codex-spark": "2026-09-14",
    "gpt-5.4": "2026-08-31",
    "gpt-5.4-mini": "2026-08-31",
    "gpt-5.5": "2026-10-14",
  };
  if (!dates[base]) return null;
  return {
    source: "https://learn.chatgpt.com/docs/models",
    chatgpt_retirement_date: dates[base],
    authority: "public_notice_not_account_entitlement",
    notes:
      "Authenticated account discovery and explicit operator routing remain authoritative; this notice does not disable a route.",
  };
}
