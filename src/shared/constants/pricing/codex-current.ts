/**
 * Standard Codex USD-equivalent rates per 1M tokens, verified 2026-10-06.
 * https://help.openai.com/en/articles/20001415-chatgpt-rate-card-enterprise-token-based-pricing
 * Included plan allowance and Fast/Ultrafast metering are separate from these rates.
 * Codex does not charge cache writes. This table does not grant model entitlement.
 */
const standard = {
  "gpt-6-astra": { input: 10, cached: 1, output: 50, cache_creation: 0 },
  "gpt-6.1-sol": { input: 2, cached: 0.1, output: 10, cache_creation: 0 },
  "gpt-6-sol": { input: 2, cached: 0.2, output: 10, cache_creation: 0 },
  "gpt-6-luna": { input: 0.1, cached: 0.01, output: 0.5, cache_creation: 0 },
};

export const CODEX_CURRENT_STANDARD_PRICING = Object.fromEntries(
  Object.entries(standard).flatMap(([model, rates]) =>
    ["", "-none", "-low", "-medium", "-high", "-xhigh", "-max", "-ultra"].map((suffix) => [
      model + suffix,
      rates,
    ])
  )
);
