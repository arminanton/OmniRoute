import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as yaml from "js-yaml";
import { makeManagementSessionRequest } from "../helpers/managementSession.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-openapi-history-cleanup-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.NODE_ENV = "test";

const spec = yaml.load(fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8")) as {
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, any> };
};

const coreDb = await import("../../src/lib/db/core.ts");
const lkgpRoute = await import("../../src/app/api/settings/lkgp-cache/route.ts");
const usageHistoryRoute = await import("../../src/app/api/settings/purge-usage-history/route.ts");
const callLogsRoute = await import("../../src/app/api/settings/purge-call-logs/route.ts");
const detailedLogsRoute = await import("../../src/app/api/settings/purge-detailed-logs/route.ts");
const retentionLogsRoute = await import("../../src/app/api/settings/purge-logs/route.ts");
const quotaSnapshotsRoute =
  await import("../../src/app/api/settings/purge-quota-snapshots/route.ts");

const PATHS = {
  lkgp: "/api/settings/lkgp-cache",
  usage: "/api/settings/purge-usage-history",
  callLogs: "/api/settings/purge-call-logs",
  detailed: "/api/settings/purge-detailed-logs",
  retention: "/api/settings/purge-logs",
  quota: "/api/settings/purge-quota-snapshots",
};

function request(pathname: string, method: string, body?: unknown): Promise<Request> {
  return makeManagementSessionRequest(`http://localhost${pathname}`, {
    method,
    ...(body === undefined ? {} : { body }),
  });
}

function operation(pathname: string, method: string): Record<string, any> {
  const result = spec.paths[pathname]?.[method];
  assert.ok(result, `missing ${method.toUpperCase()} ${pathname}`);
  return result;
}

function resetStorage(): void {
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(resetStorage);

test.after(() => {
  resetStorage();
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("usage-history reset returns the typed full-table cleanup summary", async () => {
  const response = await usageHistoryRoute.POST(
    await request(PATHS.usage, "POST", { period: "all" })
  );
  const body = await response.json();
  const schema = spec.components.schemas.ResetUsageHistoryResponse;
  assert.equal(response.status, 200);
  for (const key of schema.required) assert.ok(Object.hasOwn(body, key));
  assert.deepEqual(Object.keys(body).sort(), Object.keys(schema.properties).sort());
  assert.equal(body.errors, 0);
  assert.equal(body.deleted, 0);

  const invalid = await usageHistoryRoute.POST(
    await request(PATHS.usage, "POST", { period: "forever" })
  );
  assert.equal(invalid.status, 400);
  assert.ok((await invalid.json()).error);
});

test("call-log, detailed-log, quota-snapshot, retention, and LKGP cleanup results match schemas", async () => {
  const callLogs = await callLogsRoute.POST(await request(PATHS.callLogs, "POST"));
  assert.equal(callLogs.status, 200);
  assert.deepEqual(Object.keys(await callLogs.json()).sort(), [
    "deleted",
    "deletedArtifacts",
    "errors",
  ]);

  const detailed = await detailedLogsRoute.POST(await request(PATHS.detailed, "POST"));
  assert.equal(detailed.status, 200);
  assert.deepEqual(Object.keys(await detailed.json()).sort(), ["deleted", "errors"]);

  const quota = await quotaSnapshotsRoute.POST(await request(PATHS.quota, "POST"));
  assert.equal(quota.status, 200);
  assert.deepEqual(Object.keys(await quota.json()).sort(), ["deleted", "errors"]);

  const retention = await retentionLogsRoute.POST(await request(PATHS.retention, "POST"));
  assert.equal(retention.status, 200);
  assert.deepEqual(Object.keys(await retention.json()).sort(), ["deleted", "deletedArtifacts"]);

  const lkgp = await lkgpRoute.DELETE(await request(PATHS.lkgp, "DELETE"));
  assert.equal(lkgp.status, 200);
  assert.deepEqual(await lkgp.json(), { cleared: true });
});

test("cleanup OpenAPI documents auth, reset periods, responses, and error variants", () => {
  const operations = [
    operation(PATHS.lkgp, "delete"),
    operation(PATHS.usage, "post"),
    operation(PATHS.callLogs, "post"),
    operation(PATHS.detailed, "post"),
    operation(PATHS.retention, "post"),
    operation(PATHS.quota, "post"),
  ];
  for (const op of operations) {
    assert.ok(op.security?.some((item: object) => Object.hasOwn(item, "BearerAuth")));
    assert.ok(op.security?.some((item: object) => Object.hasOwn(item, "ManagementSessionAuth")));
    assert.ok(op.security?.some((item: object) => Object.keys(item).length === 0));
    assert.ok(op.responses["401"]);
  }
  assert.equal(
    operation(PATHS.usage, "post").requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/ResetUsageHistoryRequest"
  );
  assert.deepEqual(spec.components.schemas.ResetUsageHistoryRequest.properties.period.enum, [
    "5m",
    "1h",
    "3h",
    "6h",
    "12h",
    "1d",
    "7d",
    "30d",
    "all",
  ]);
  assert.equal(
    operation(PATHS.callLogs, "post").responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/PurgeCallLogsResponse"
  );
  assert.equal(
    operation(PATHS.detailed, "post").responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/PurgeCountWithErrorsResponse"
  );
  assert.equal(
    operation(PATHS.retention, "post").responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/PurgeLogsResponse"
  );
  assert.equal(
    operation(PATHS.quota, "post").responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/PurgeCountWithErrorsResponse"
  );
  assert.equal(
    operation(PATHS.lkgp, "delete").responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/LkgpCacheClearedResponse"
  );
});
