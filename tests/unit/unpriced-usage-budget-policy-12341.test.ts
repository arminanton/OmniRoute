import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildApiKeyUsageLimitPolicyRejectionForStatus,
  type ApiKeyUsageLimitStatus,
} from "../../src/lib/usage/apiKeyUsageLimits.ts";

const NOW = Date.parse("2026-09-26T12:00:00.000Z");
const BASE_STATUS: ApiKeyUsageLimitStatus = {
  enabled: true,
  dailyLimitUsd: 10,
  weeklyLimitUsd: 50,
  dailySpentUsd: 0,
  weeklySpentUsd: 0,
  dailyWindowStartIso: "2026-09-26T03:00:00.000Z",
  dailyResetAtIso: "2026-09-27T03:00:00.000Z",
  weeklyWindowStartIso: "2026-09-21T00:00:00.000Z",
  weeklyResetAtIso: "2026-09-28T00:00:00.000Z",
  dailyExceeded: false,
  weeklyExceeded: false,
  dailyUnpricedModels: [],
  weeklyUnpricedModels: [],
  dailyPricingFailure: false,
  weeklyPricingFailure: false,
  unpricedUsagePolicy: "fail_closed",
};
const REQUEST = new Request("https://example.test/v1/chat/completions");

function status(overrides: Partial<ApiKeyUsageLimitStatus>): ApiKeyUsageLimitStatus {
  return { ...BASE_STATUS, ...overrides };
}

test("fail_closed rejects missing prices with 400 and no Retry-After", () => {
  const response = buildApiKeyUsageLimitPolicyRejectionForStatus(
    REQUEST,
    status({ dailyUnpricedModels: [{ provider: "openai", model: "new-model" }] }),
    NOW
  );
  assert.equal(response?.status, 400);
  assert.equal(response?.headers.has("Retry-After"), false);
});

test("count_as_zero permits missing prices but lookup failures still fail closed", () => {
  const missing = buildApiKeyUsageLimitPolicyRejectionForStatus(
    REQUEST,
    status({
      unpricedUsagePolicy: "count_as_zero",
      dailyUnpricedModels: [{ provider: "openai", model: "new-model" }],
    }),
    NOW
  );
  assert.equal(missing, null);

  const failed = buildApiKeyUsageLimitPolicyRejectionForStatus(
    REQUEST,
    status({ unpricedUsagePolicy: "count_as_zero", weeklyPricingFailure: true }),
    NOW
  );
  assert.equal(failed?.status, 400);
  assert.equal(failed?.headers.has("Retry-After"), false);
});

test("priced overage retains 429 + reset Retry-After", () => {
  const response = buildApiKeyUsageLimitPolicyRejectionForStatus(
    REQUEST,
    status({ dailyExceeded: true, dailySpentUsd: 11 }),
    NOW
  );
  assert.equal(response?.status, 429);
  assert.equal(response?.headers.get("Retry-After"), "54000");
});

test("Anthropic priced overage keeps its 400 response", () => {
  const request = new Request("https://example.test/v1/messages", {
    headers: { "anthropic-version": "2023-06-01" },
  });
  const response = buildApiKeyUsageLimitPolicyRejectionForStatus(
    request,
    status({ dailyExceeded: true, dailySpentUsd: 11 }),
    NOW
  );
  assert.equal(response?.status, 400);
});
