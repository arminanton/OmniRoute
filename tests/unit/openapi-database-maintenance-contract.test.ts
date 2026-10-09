import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as yaml from "js-yaml";
import { databaseSettingsSchema } from "../../src/shared/validation/settingsSchemas.ts";
import { makeManagementSessionRequest } from "../helpers/managementSession.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-openapi-db-maintenance-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.NODE_ENV = "test";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const spec = yaml.load(fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8")) as {
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, any> };
};

const coreDb = await import("../../src/lib/db/core.ts");
const databaseSettingsDb = await import("../../src/lib/db/databaseSettings.ts");
const vacuumScheduler = await import("../../src/lib/db/vacuumScheduler.ts");
const databaseSettingsRoute = await import("../../src/app/api/settings/database/route.ts");
const refreshStatsRoute =
  await import("../../src/app/api/settings/database/refresh-stats/route.ts");
const vacuumRoute = await import("../../src/app/api/settings/database/vacuum/route.ts");

function operation(path: string, method: string): Record<string, any> {
  const result = spec.paths[path]?.[method];
  assert.ok(result, `missing ${method.toUpperCase()} ${path}`);
  return result;
}

async function request(path: string, method = "GET", body?: unknown): Promise<Request> {
  return makeManagementSessionRequest(`http://localhost${path}`, {
    method,
    ...(body === undefined ? {} : { body }),
  });
}

function properties(schema: string): string[] {
  return Object.keys(spec.components.schemas[schema].properties).sort();
}

test.beforeEach(() => {
  vacuumScheduler.__resetForTests();
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

test.afterEach(() => {
  vacuumScheduler.__resetForTests();
  coreDb.resetDbInstance();
});

test.after(() => {
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("database settings response and partial section validator match live GET/PATCH", async () => {
  const responseSchema = spec.components.schemas.DatabaseSettingsResponse;
  const updateSchema = spec.components.schemas.DatabaseSettingsUpdateRequest;
  assert.deepEqual(
    Object.keys(updateSchema.properties).sort(),
    Object.keys(databaseSettingsSchema.shape).sort()
  );
  assert.deepEqual(
    Object.keys(spec.components.schemas.DatabaseSettingsLogs.properties).sort(),
    Object.keys(databaseSettingsSchema.shape.logs.shape).sort()
  );
  assert.deepEqual(
    Object.keys(spec.components.schemas.DatabaseSettingsBackup.properties).sort(),
    Object.keys(databaseSettingsSchema.shape.backup.shape).sort()
  );
  assert.deepEqual(
    Object.keys(spec.components.schemas.DatabaseSettingsCache.properties).sort(),
    Object.keys(databaseSettingsSchema.shape.cache.shape).sort()
  );
  assert.deepEqual(
    Object.keys(spec.components.schemas.DatabaseSettingsAggregation.properties).sort(),
    Object.keys(databaseSettingsSchema.shape.aggregation.shape).sort()
  );
  assert.deepEqual(
    Object.keys(spec.components.schemas.DatabaseSettingsOptimization.properties).sort(),
    Object.keys(databaseSettingsSchema.shape.optimization.shape).sort()
  );
  assert.deepEqual(
    Object.keys(spec.components.schemas.DatabaseSettingsRetentionUpdate.properties).sort(),
    Object.keys(databaseSettingsSchema.shape.retention.shape).sort()
  );

  const getResponse = await databaseSettingsRoute.GET(await request("/api/settings/database"));
  const getBody = await getResponse.json();
  assert.equal(getResponse.status, 200);
  assert.deepEqual(Object.keys(getBody).sort(), Object.keys(responseSchema.properties).sort());
  assert.deepEqual(
    Object.keys(getBody.retention).sort(),
    properties("DatabaseSettingsRetentionResponse")
  );

  const current = databaseSettingsDb.getUserDatabaseSettings();
  const patchResponse = await databaseSettingsRoute.PATCH(
    (await request("/api/settings/database", "PATCH", {
      retention: { ...current.retention, callLogs: 12, autoCleanupEnabled: false },
      aggregation: { ...current.aggregation, enabled: false, rawDataRetentionDays: 8 },
    })) as never
  );
  const patchBody = await patchResponse.json();
  assert.equal(patchResponse.status, 200);
  assert.equal(patchBody.retention.callLogs, 12);
  assert.equal(patchBody.retention.autoCleanupEnabled, false);
  assert.equal(patchBody.aggregation.enabled, false);
  assert.equal(patchBody.aggregation.rawDataRetentionDays, 8);
  assert.deepEqual(Object.keys(patchBody).sort(), Object.keys(responseSchema.properties).sort());

  assert.equal(
    operation("/api/settings/database", "get").responses["200"].content["application/json"].schema
      .$ref,
    "#/components/schemas/DatabaseSettingsResponse"
  );
  for (const method of ["patch", "put"]) {
    assert.equal(
      operation("/api/settings/database", method).requestBody.content["application/json"].schema
        .$ref,
      "#/components/schemas/DatabaseSettingsUpdateRequest"
    );
    assert.equal(
      operation("/api/settings/database", method).responses["200"].content["application/json"]
        .schema.$ref,
      "#/components/schemas/DatabaseSettingsResponse"
    );
  }
});

test("database statistics and vacuum scheduler response schemas match real maintenance operations", async () => {
  const statsResponse = await refreshStatsRoute.POST(
    (await request("/api/settings/database/refresh-stats", "POST")) as never
  );
  const statsBody = await statsResponse.json();
  assert.equal(statsResponse.status, 200);
  assert.deepEqual(Object.keys(statsBody), ["success", "stats"]);
  assert.deepEqual(
    Object.keys(statsBody.stats).sort(),
    spec.components.schemas.DatabaseStats.required.slice().sort()
  );
  if (statsBody.stats.tables.length > 0) {
    assert.deepEqual(
      Object.keys(statsBody.stats.tables[0]).sort(),
      properties("DatabaseStatsTable")
    );
  }
  if (statsBody.stats.indexes.length > 0) {
    assert.deepEqual(
      Object.keys(statsBody.stats.indexes[0]).sort(),
      properties("DatabaseStatsIndex")
    );
  }

  const before = await vacuumRoute.GET((await request("/api/settings/database/vacuum")) as never);
  const beforeBody = await before.json();
  assert.equal(before.status, 200);
  assert.deepEqual(Object.keys(beforeBody), ["state"]);
  assert.deepEqual(Object.keys(beforeBody.state).sort(), properties("VacuumSchedulerState"));

  const manual = await vacuumRoute.POST(
    (await request("/api/settings/database/vacuum", "POST")) as never
  );
  const manualBody = await manual.json();
  assert.equal(manual.status, 200, JSON.stringify(manualBody));
  assert.equal(manualBody.success, true);
  assert.equal(typeof manualBody.duration, "number");
  assert.equal(
    operation("/api/settings/database/vacuum", "post").responses["200"].content["application/json"]
      .schema.$ref,
    "#/components/schemas/VacuumRunSuccessResponse"
  );
});

test("database maintenance routes preserve the always-protected and conditional auth tiers", () => {
  for (const method of ["get", "patch", "put"]) {
    const op = operation("/api/settings/database", method);
    assert.equal(op["x-always-protected"], true);
    assert.ok(op.security?.some((item: object) => Object.hasOwn(item, "BearerAuth")));
    assert.ok(op.security?.some((item: object) => Object.hasOwn(item, "ManagementSessionAuth")));
    assert.equal(
      op.security?.some((item: object) => Object.keys(item).length === 0),
      false
    );
  }
  for (const [path, method] of [
    ["/api/settings/database/refresh-stats", "post"],
    ["/api/settings/database/vacuum", "get"],
    ["/api/settings/database/vacuum", "post"],
  ] as const) {
    const op = operation(path, method);
    assert.ok(op.security?.some((item: object) => Object.hasOwn(item, "BearerAuth")));
    assert.ok(op.security?.some((item: object) => Object.hasOwn(item, "ManagementSessionAuth")));
    assert.ok(op.security?.some((item: object) => Object.keys(item).length === 0));
  }
  assert.equal(
    operation("/api/settings/database/refresh-stats", "post").responses["200"].content[
      "application/json"
    ].schema.$ref,
    "#/components/schemas/DatabaseStatsRefreshResponse"
  );
  assert.equal(
    operation("/api/settings/database/vacuum", "get").responses["200"].content["application/json"]
      .schema.$ref,
    "#/components/schemas/VacuumSchedulerStateResponse"
  );
});
