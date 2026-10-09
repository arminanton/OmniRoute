import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as yaml from "js-yaml";
import { makeManagementSessionRequest } from "../helpers/managementSession.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-openapi-quota-state-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.NODE_ENV = "test";

const spec = yaml.load(fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8")) as {
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, any> };
};

const coreDb = await import("../../src/lib/db/core.ts");
const quotaStateRoute = await import("../../src/app/api/settings/quota/state/route.ts");

function operation(method: string): Record<string, any> {
  const result = spec.paths["/api/settings/quota/state"]?.[method];
  assert.ok(result, `missing ${method.toUpperCase()} /api/settings/quota/state`);
  return result;
}

function quotaRequest(method: string, body?: unknown): Promise<Request> {
  return makeManagementSessionRequest("http://localhost/api/settings/quota/state", {
    method,
    ...(body === undefined ? {} : { body }),
  });
}

function insertQuota(
  connectionId: string,
  model: string,
  tokensUsed: number,
  tokenLimit: number,
  windowReset: number
): void {
  coreDb
    .getDbInstance()
    .prepare(
      `INSERT OR REPLACE INTO provider_quota_state
       (connection_id, model, tokens_used, token_limit, window_start, window_reset, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      connectionId,
      model,
      tokensUsed,
      tokenLimit,
      Date.now(),
      windowReset,
      new Date().toISOString()
    );
}

test.beforeEach(() => {
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

test.after(() => {
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("quota-state GET returns typed aggregates and reset timer rows", async () => {
  const now = Date.now();
  insertQuota("quota-a", "gpt-6.1-sol", 80, 100, now + 60_000);
  insertQuota("quota-b", "claude-sonnet", 10, 100, now - 1_000);

  const response = await quotaStateRoute.GET((await quotaRequest("GET")) as never);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(body).sort(), ["analytics", "resetTimers", "success", "timestamp"]);
  assert.equal(body.success, true);
  assert.ok(Number.isFinite(Date.parse(body.timestamp)));
  assert.equal(body.analytics.totalConnectionsTracked, 2);
  assert.equal(body.analytics.connections.length, 2);
  assert.equal(
    body.analytics.connections.find((row: any) => row.connectionId === "quota-b").tokensUsed,
    0
  );
  assert.equal(
    body.analytics.connections.find((row: any) => row.connectionId === "quota-b").tokenLimit,
    0
  );
  assert.deepEqual(Object.keys(body.analytics.connections[0]).sort(), [
    "connectionId",
    "isExhausted",
    "model",
    "remainingRatio",
    "tokenLimit",
    "tokensRemaining",
    "tokensUsed",
    "windowReset",
  ]);
  assert.equal(body.resetTimers.length, 2);
  assert.ok(body.resetTimers.some((row: any) => row.timeRemainingMs === 0));
  assert.deepEqual(Object.keys(body.resetTimers[0]).sort(), [
    "connectionId",
    "model",
    "timeRemainingMs",
    "tokenLimit",
    "tokensUsed",
    "windowReset",
  ]);
});

test("quota-state actions reset expired windows and clear all rows for a connection", async () => {
  const now = Date.now();
  insertQuota("expired-quota", "model-a", 10, 10, now - 1_000);
  const reset = await quotaStateRoute.POST(
    (await quotaRequest("POST", { action: "reset_expired" })) as never
  );
  const resetBody = await reset.json();
  assert.equal(reset.status, 200);
  assert.deepEqual(Object.keys(resetBody).sort(), ["message", "resetCount", "success"]);
  assert.equal(resetBody.success, true);
  assert.equal(resetBody.resetCount, 1);

  insertQuota("clear-quota", "model-a", 10, 10, now + 10_000);
  insertQuota("clear-quota", "model-b", 20, 20, now + 20_000);
  insertQuota("keep-quota", "model-a", 30, 30, now + 30_000);
  const clear = await quotaStateRoute.POST(
    (await quotaRequest("POST", {
      action: "clear_connection",
      connectionId: "clear-quota",
      model: "model-a",
    })) as never
  );
  const clearBody = await clear.json();
  assert.equal(clear.status, 200);
  assert.deepEqual(Object.keys(clearBody).sort(), ["message", "success"]);
  assert.equal(clearBody.success, true);
  assert.equal(clearBody.message, "Cleared quota state for connection clear-quota (model-a).");
  const remaining = coreDb
    .getDbInstance()
    .prepare("SELECT connection_id, model FROM provider_quota_state ORDER BY connection_id, model")
    .all();
  assert.deepEqual(remaining, [{ connection_id: "keep-quota", model: "model-a" }]);
});

test("quota-state rejects invalid action bodies and serves unauthenticated CORS preflight", async () => {
  const invalid = await quotaStateRoute.POST(
    (await quotaRequest("POST", {
      action: "clear_connection",
      connectionId: "",
      model: "model-a",
    })) as never
  );
  assert.equal(invalid.status, 400);
  assert.ok((await invalid.json()).error);

  const options = await quotaStateRoute.OPTIONS();
  assert.equal(options.status, 204);
  assert.equal(await options.text(), "");
  assert.ok(options.headers.has("access-control-allow-methods"));
});

test("quota-state OpenAPI describes envelopes, action unions, CORS, and conditional auth", () => {
  for (const method of ["get", "post"]) {
    const op = operation(method);
    assert.ok(op.security?.some((item: object) => Object.hasOwn(item, "BearerAuth")));
    assert.ok(op.security?.some((item: object) => Object.hasOwn(item, "ManagementSessionAuth")));
    assert.ok(op.security?.some((item: object) => Object.keys(item).length === 0));
    assert.ok(op.responses["401"]);
    assert.ok(op.responses["503"]);
  }
  assert.equal(
    operation("get").responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/QuotaStateResponse"
  );
  assert.equal(
    operation("post").requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/QuotaStateActionRequest"
  );
  assert.equal(
    operation("post").responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/QuotaStateActionResponse"
  );
  assert.equal(spec.paths["/api/settings/quota/state"].options, undefined);
  assert.match(
    spec.paths["/api/settings/quota/state"].description,
    /OPTIONS is intentionally omitted/
  );
  assert.ok(spec.components.schemas.QuotaStateActionRequest.oneOf);
  assert.ok(spec.components.schemas.QuotaStateActionResponse.oneOf);
});
