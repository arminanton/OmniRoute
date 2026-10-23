import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-unpriced-usage-route-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "unpriced-usage-route-test-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.INITIAL_PASSWORD = "unpriced-usage-route-test-password";

const core = await import("../../src/lib/db/core.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const { calculateCostDetailed } = await import("../../src/lib/usage/costCalculator.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const usageHistory = await import("../../src/lib/usage/usageHistory.ts");
const { GET: getUnpricedUsageReport } = await import(
  "../../src/app/api/pricing/unpriced-usage/route.ts"
);

test.before(async () => {
  await settingsDb.updateSettings({ requireLogin: true });
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

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

test("partial or invalid price rows fail closed under both unpriced policies", async () => {
  const provider = "openai";
  const malformedPricing: Record<string, Record<string, unknown>> = {
    "partial-pricing-14608-missing-input": { output: 0.25 },
    "partial-pricing-14608-missing-output": { input: 0.25 },
    "partial-pricing-14608-null-input": { input: null, output: 0.25 },
    "partial-pricing-14608-null-output": { input: 0.25, output: null },
    "partial-pricing-14608-invalid-input": { input: "not-a-price", output: 0.25 },
    "partial-pricing-14608-invalid-output": { input: 0.25, output: "not-a-price" },
    "partial-pricing-14608-non-finite-input": { input: "Infinity", output: 0.25 },
    "partial-pricing-14608-non-finite-output": { input: 0.25, output: "Infinity" },
    "partial-pricing-14608-negative-input": { input: -1, output: 0.25 },
    "partial-pricing-14608-negative-output": { input: 0.25, output: -1 },
    "partial-pricing-14608-null-cached": { input: 0.25, output: 0.25, cached: null },
    "partial-pricing-14608-invalid-reasoning": {
      input: 0.25,
      output: 0.25,
      reasoning: "not-a-price",
    },
    "partial-pricing-14608-non-finite-cache-creation": {
      input: 0.25,
      output: 0.25,
      cache_creation: "Infinity",
    },
  };
  const zeroModel = "partial-pricing-14608-explicit-zero";
  await settingsDb.updatePricing({
    [provider]: {
      ...malformedPricing,
      [zeroModel]: { input: 0, output: 0 },
    },
  });

  for (const model of Object.keys(malformedPricing)) {
    const result = await calculateCostDetailed(provider, model, { input: 1, output: 1 });
    assert.equal(result.missingPricing, false, `${model} is a malformed row, not a missing row`);
    assert.equal(result.failed, true, `${model} must report a pricing lookup failure`);

    for (const policy of ["fail_closed", "count_as_zero"] as const) {
      const response = buildApiKeyUsageLimitPolicyRejectionForStatus(
        REQUEST,
        status({
          unpricedUsagePolicy: policy,
          dailyPricingFailure: result.failed,
          weeklyPricingFailure: result.failed,
        }),
        NOW
      );
      assert.ok(response, `${policy} must reject ${model}`);
      assert.equal(response.status, 400, `${policy} must reject ${model}`);
    }
  }

  // JSON pricing rows intentionally support explicit numeric zero as a valid free rate.
  const zero = await calculateCostDetailed(provider, zeroModel, { input: 1, output: 1 });
  assert.deepEqual(zero, { cost: 0, missingPricing: false, failed: false });
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

test("GET /api/pricing/unpriced-usage requires management auth and returns bounded groups", async (t) => {
  const windowMs = 8 * 24 * 60 * 60 * 1000;
  t.mock.timers.enable({ apis: ["Date"], now: new Date(NOW) });
  const windowStartIso = new Date(NOW - windowMs).toISOString();
  const windowEndIso = new Date(NOW).toISOString();
  const model = "unpriced-usage-report-route-14608";

  for (const [apiKeyId, timestamp] of [
    ["lower-window-key", windowStartIso],
    ["upper-window-key", windowEndIso],
    ["before-window-key", new Date(NOW - windowMs - 1).toISOString()],
    ["after-window-key", new Date(NOW + 1).toISOString()],
  ]) {
    await usageHistory.saveRequestUsage({
      provider: "openai",
      model,
      apiKeyId,
      tokens: { input: 1, output: 1 },
      success: true,
      timestamp,
    });
  }

  const unauthorized = await getUnpricedUsageReport(
    new Request("http://localhost/api/pricing/unpriced-usage")
  );
  const unauthorizedBody = await unauthorized.json();
  assert.equal(unauthorized.status, 401);
  assert.equal("items" in unauthorizedBody, false);
  assert.equal("affectedKeyIds" in unauthorizedBody, false);
  assert.equal("affectedKeyCount" in unauthorizedBody, false);
  assert.equal(JSON.stringify(unauthorizedBody).includes("lower-window-key"), false);
  assert.equal(JSON.stringify(unauthorizedBody).includes("requestCount"), false);

  const { key } = await apiKeysDb.createApiKey("unpriced-usage-report", "test", ["manage"]);
  const response = await getUnpricedUsageReport(
    new Request("http://localhost/api/pricing/unpriced-usage", {
      headers: { Authorization: `Bearer ${key}` },
    })
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ["items", "policy", "windowEndIso", "windowStartIso"]);
  assert.equal(body.windowStartIso, windowStartIso);
  assert.equal(body.windowEndIso, windowEndIso);
  assert.equal(body.items.length, 1);
  const [item] = body.items;
  assert.deepEqual(Object.keys(item).sort(), [
    "affectedKeyCount",
    "affectedKeyIds",
    "model",
    "pricingFailure",
    "provider",
    "requestCount",
  ]);
  assert.equal(item.provider, "openai");
  assert.equal(item.model, model);
  assert.equal(item.requestCount, 2);
  assert.deepEqual([...item.affectedKeyIds].sort(), ["lower-window-key", "upper-window-key"]);
  assert.equal(item.affectedKeyCount, 2);
  assert.equal(item.pricingFailure, false);
});

