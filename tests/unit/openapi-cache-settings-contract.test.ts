import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as yaml from "js-yaml";
import { makeManagementSessionRequest } from "../helpers/managementSession.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-openapi-cache-settings-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.NODE_ENV = "test";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const spec = yaml.load(fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8")) as {
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, any> };
};

const coreDb = await import("../../src/lib/db/core.ts");
const cacheConfigRoute = await import("../../src/app/api/settings/cache-config/route.ts");
const cacheMetricsRoute = await import("../../src/app/api/settings/cache-metrics/route.ts");

function operation(path: string, method: string): Record<string, any> {
  const result = spec.paths[path]?.[method];
  assert.ok(result, `missing ${method.toUpperCase()} ${path}`);
  return result;
}

function cacheConfigRequest(method: string, body?: unknown): Request {
  return new Request("http://localhost/api/settings/cache-config", {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function managementRequest(path: string, method = "GET"): Promise<Request> {
  return makeManagementSessionRequest(`http://localhost${path}`, { method });
}

function schemaKeys(name: string): string[] {
  return Object.keys(spec.components.schemas[name].properties).sort();
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

test("cache config GET and PUT match the effective two-store settings path", async () => {
  const initial = await cacheConfigRoute.GET(cacheConfigRequest("GET") as never);
  const initialBody = await initial.json();
  assert.equal(initial.status, 200);
  assert.deepEqual(Object.keys(initialBody).sort(), schemaKeys("CacheRuntimeSettingsResponse"));
  assert.equal(typeof initialBody.modelCatalogCacheTtlMs, "number");

  const put = await cacheConfigRoute.PUT(
    cacheConfigRequest("PUT", {
      semanticCacheEnabled: false,
      promptCacheStrategy: "manual",
      alwaysPreserveClientCache: "always",
      idempotencyWindowMs: 12000,
      modelCatalogCacheTtlMs: 24000,
    }) as never
  );
  const putBody = await put.json();
  assert.equal(put.status, 200);
  assert.deepEqual(putBody, { ok: true });

  const updated = await cacheConfigRoute.GET(cacheConfigRequest("GET") as never);
  const updatedBody = await updated.json();
  assert.equal(updatedBody.semanticCacheEnabled, false);
  assert.equal(updatedBody.promptCacheStrategy, "manual");
  assert.equal(updatedBody.alwaysPreserveClientCache, "always");
  assert.equal(updatedBody.idempotencyWindowMs, 12000);
  assert.equal(updatedBody.modelCatalogCacheTtlMs, 24000);

  assert.equal(
    operation("/api/settings/cache-config", "get").responses["200"].content["application/json"]
      .schema.$ref,
    "#/components/schemas/CacheRuntimeSettingsResponse"
  );
  assert.equal(
    operation("/api/settings/cache-config", "put").requestBody.content["application/json"].schema
      .$ref,
    "#/components/schemas/CacheRuntimeSettingsUpdate"
  );
});

test("cache metrics GET and deprecated DELETE return the computed cache metrics snapshot", async () => {
  const metricsPath = "/api/settings/cache-metrics";
  const get = await cacheMetricsRoute.GET(await managementRequest(metricsPath));
  const getBody = await get.json();
  assert.equal(get.status, 200);
  assert.deepEqual(Object.keys(getBody).sort(), schemaKeys("CachePromptMetrics"));

  const remove = await cacheMetricsRoute.DELETE(await managementRequest(metricsPath, "DELETE"));
  const removeBody = await remove.json();
  assert.equal(remove.status, 200);
  assert.deepEqual(Object.keys(removeBody).sort(), schemaKeys("CachePromptMetrics"));
  for (const key of [
    "totalRequests",
    "requestsWithCacheControl",
    "totalInputTokens",
    "totalCachedTokens",
    "totalCacheCreationTokens",
    "tokensSaved",
    "estimatedCostSaved",
    "byProvider",
    "byStrategy",
  ]) {
    assert.deepEqual(
      removeBody[key],
      getBody[key],
      `${key} remains derived from unchanged history`
    );
  }
});

test("cache settings routes document their distinct conditional auth and error envelopes", () => {
  for (const [path, method] of [
    ["/api/settings/cache-config", "get"],
    ["/api/settings/cache-config", "put"],
    ["/api/settings/cache-metrics", "get"],
    ["/api/settings/cache-metrics", "delete"],
  ] as const) {
    const op = operation(path, method);
    assert.ok(op.security?.some((entry: object) => Object.hasOwn(entry, "BearerAuth")));
    assert.ok(op.security?.some((entry: object) => Object.hasOwn(entry, "ManagementSessionAuth")));
    assert.ok(op.security?.some((entry: object) => Object.keys(entry).length === 0));
  }

  for (const method of ["get", "delete"]) {
    const op = operation("/api/settings/cache-metrics", method);
    assert.equal(
      op.responses["401"].$ref,
      "#/components/responses/ManagementAuthenticationRequired"
    );
    assert.equal(op.responses["403"].$ref, "#/components/responses/ManagementInvalidToken");
    assert.equal(op.responses["503"].$ref, "#/components/responses/ManagementAuthUnavailable");
    assert.equal(
      op.responses["500"].content["application/json"].schema.$ref,
      "#/components/schemas/StringErrorResponse"
    );
  }

  assert.equal(
    operation("/api/settings/cache-metrics", "get").responses["200"].content["application/json"]
      .schema.$ref,
    "#/components/schemas/CachePromptMetrics"
  );
  assert.match(
    operation("/api/settings/cache-metrics", "delete").description,
    /does not delete historical data/
  );
  assert.equal(
    operation("/api/settings/cache-config", "put").responses["400"].content["application/json"]
      .schema.anyOf.length,
    2
  );
});
