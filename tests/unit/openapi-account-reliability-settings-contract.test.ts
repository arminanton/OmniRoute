import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as yaml from "js-yaml";
import { updateAutoDisableAccountsSchema } from "../../src/shared/validation/schemas/settings.ts";
import { makeManagementSessionRequest } from "../helpers/managementSession.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-openapi-account-reliability-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.NODE_ENV = "test";

const spec = yaml.load(fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8")) as {
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, any> };
};

const coreDb = await import("../../src/lib/db/core.ts");
const autoDisableRoute = await import("../../src/app/api/settings/auto-disable-accounts/route.ts");
const degradationRoute = await import("../../src/app/api/settings/background-degradation/route.ts");
const degradationService = await import("../../open-sse/services/backgroundTaskDetector.ts");

async function managementRequest(url: string, method = "GET", body?: unknown): Promise<Request> {
  return makeManagementSessionRequest(url, {
    method,
    ...(body === undefined ? {} : { body }),
  });
}

function operation(path: string, method: string): Record<string, any> {
  const result = spec.paths[path]?.[method];
  assert.ok(result, `missing ${method.toUpperCase()} ${path}`);
  return result;
}

test.beforeEach(() => {
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  degradationService.setBackgroundDegradationConfig({
    enabled: false,
    degradationMap: {},
    detectionPatterns: [],
  });
  degradationService.resetStats();
});

test.after(() => {
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("auto-disable account GET/PUT match their normalized runtime and strict Zod body", async () => {
  const get = await autoDisableRoute.GET(
    await managementRequest("http://localhost/api/settings/auto-disable-accounts")
  );
  const defaultBody = await get.json();
  assert.equal(get.status, 200);
  assert.deepEqual(Object.keys(defaultBody).sort(), ["enabled", "scope", "threshold"]);
  assert.equal(defaultBody.threshold, 3);
  assert.equal(defaultBody.scope, "all");

  const put = await autoDisableRoute.PUT(
    await managementRequest("http://localhost/api/settings/auto-disable-accounts", "PUT", {
      enabled: true,
      threshold: 7,
      scope: "subscription",
    })
  );
  const body = await put.json();
  assert.equal(put.status, 200);
  assert.deepEqual(body, { enabled: true, threshold: 7, scope: "subscription" });
  assert.deepEqual(
    Object.keys(spec.components.schemas.AutoDisableAccountsSettingsUpdate.properties).sort(),
    Object.keys(updateAutoDisableAccountsSchema.shape).sort()
  );
});

test("background degradation GET, PUT, and reset expose config while retaining server-owned stats", async () => {
  const get = await degradationRoute.GET(
    await managementRequest("http://localhost/api/settings/background-degradation")
  );
  const defaultBody = await get.json();
  assert.equal(get.status, 200);
  assert.deepEqual(Object.keys(defaultBody).sort(), [
    "degradationMap",
    "detectionPatterns",
    "enabled",
    "stats",
  ]);
  assert.deepEqual(Object.keys(defaultBody.stats).sort(), ["detected", "tokensSaved"]);

  const put = await degradationRoute.PUT(
    await managementRequest("http://localhost/api/settings/background-degradation", "PUT", {
      enabled: true,
      degradationMap: { "premium-model": "budget-model" },
      detectionPatterns: ["generate a title"],
      stats: { detected: 999, tokensSaved: 999 },
    })
  );
  const updated = await put.json();
  assert.equal(put.status, 200);
  assert.equal(updated.success, true);
  assert.equal(updated.enabled, true);
  assert.equal(updated.degradationMap["premium-model"], "budget-model");
  assert.deepEqual(updated.detectionPatterns, ["generate a title"]);
  assert.deepEqual(updated.stats, { detected: 0, tokensSaved: 0 });

  const reset = await degradationRoute.POST(
    await managementRequest("http://localhost/api/settings/background-degradation", "POST", {
      action: "reset-stats",
    })
  );
  const resetBody = await reset.json();
  assert.equal(reset.status, 200);
  assert.deepEqual(Object.keys(resetBody).sort(), ["stats", "success"]);
  assert.deepEqual(resetBody.stats, { detected: 0, tokensSaved: 0 });
});

test("account and background degradation routes document auth, bodies, and responses", () => {
  const autoPath = "/api/settings/auto-disable-accounts";
  const degradationPath = "/api/settings/background-degradation";
  for (const [path, method] of [
    [autoPath, "get"],
    [autoPath, "put"],
    [degradationPath, "get"],
    [degradationPath, "put"],
    [degradationPath, "post"],
  ] as const) {
    const op = operation(path, method);
    assert.ok(op.security?.some((item: object) => Object.hasOwn(item, "BearerAuth")));
    assert.ok(op.security?.some((item: object) => Object.hasOwn(item, "ManagementSessionAuth")));
    assert.ok(op.security?.some((item: object) => Object.keys(item).length === 0));
    assert.equal(
      op.responses["401"].$ref,
      "#/components/responses/ManagementAuthenticationRequired"
    );
    assert.equal(op.responses["403"].$ref, "#/components/responses/ManagementInvalidToken");
    assert.equal(op.responses["503"].$ref, "#/components/responses/ManagementAuthUnavailable");
  }
  assert.equal(
    operation(autoPath, "put").requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/AutoDisableAccountsSettingsUpdate"
  );
  assert.equal(
    operation(degradationPath, "put").requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/BackgroundDegradationUpdateRequest"
  );
  assert.equal(
    operation(degradationPath, "post").requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/BackgroundDegradationResetRequest"
  );
  assert.equal(
    spec.components.schemas.BackgroundDegradationResetRequest.properties.action.const,
    "reset-stats"
  );
});
