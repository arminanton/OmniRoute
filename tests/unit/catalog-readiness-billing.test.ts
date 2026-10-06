import assert from "node:assert/strict";
import test from "node:test";
import { catalogReadinessErrorResponse } from "../../src/app/api/v1/models/catalogReadiness.ts";
import { buildSyncedBilling } from "../../src/app/api/v1/models/syncedBilling.ts";

test("cold catalog timeout is a retryable503 instead of an internal failure500", async () => {
  const response = catalogReadinessErrorResponse(new Error("catalog_build_timeout"), {
    "Access-Control-Allow-Origin": "*",
  });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Retry-After"), "2");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal((await response.json()).error.code, "service_unavailable");
});

test("unexpected catalog errors stay sanitized500 without readiness retry hints", async () => {
  const response = catalogReadinessErrorResponse(new Error("internal failure"), {});
  assert.equal(response.status, 500);
  assert.equal(response.headers.get("Retry-After"), null);
});

test("catalog publishes native request billing independently of token pricing", () => {
  assert.deepEqual(buildSyncedBilling({}), {});
  assert.deepEqual(buildSyncedBilling({ premiumRequestMultiplier: Infinity }), {});
  const row = buildSyncedBilling({ premiumRequestMultiplier: 0 });
  assert.equal(row.billing_metadata?.unit, "premium_requests");
  assert.equal(row.billing_metadata?.multiplier, 0);
  assert.equal((row as Record<string, unknown>).pricing, undefined);
});
