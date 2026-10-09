import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as yaml from "js-yaml";
import { cloudSyncActionSchema } from "../../src/shared/validation/schemas/cloud.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-openapi-cloud-sync-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.NODE_ENV = "test";

const spec = yaml.load(fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8")) as {
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, any> };
};

const coreDb = await import("../../src/lib/db/core.ts");
const settings = await import("../../src/lib/db/settings.ts");
const cloudSyncRoute = await import("../../src/app/api/sync/cloud/route.ts");

function operation(method: string): Record<string, any> {
  const result = spec.paths["/api/sync/cloud"]?.[method];
  assert.ok(result, `missing ${method.toUpperCase()} /api/sync/cloud`);
  return result;
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

test("cloud-sync status matches its disabled-state handler response", async () => {
  await settings.updateSettings({ cloudEnabled: false });
  const response = await cloudSyncRoute.GET();
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body, { enabled: false });
  assert.equal(
    operation("get").responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/CloudSyncStatusResponse"
  );
  assert.equal(spec.components.schemas.CloudSyncStatusResponse.oneOf.length, 2);
});

test("cloud-sync action body, dynamic success results, raw-key disclosure and errors are typed", () => {
  const action = operation("post");
  const requestSchema = action.requestBody.content["application/json"].schema;
  assert.equal(requestSchema.$ref, "#/components/schemas/CloudSyncActionRequest");
  assert.deepEqual(Object.keys(spec.components.schemas.CloudSyncActionRequest.properties), [
    "action",
  ]);
  assert.deepEqual(spec.components.schemas.CloudSyncActionRequest.properties.action.enum, [
    "enable",
    "sync",
    "disable",
  ]);
  assert.equal(cloudSyncActionSchema.safeParse({ action: "enable" }).success, true);
  assert.equal(cloudSyncActionSchema.safeParse({ action: "reset" }).success, false);

  assert.equal(
    action.responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/CloudSyncActionResponse"
  );
  assert.deepEqual(
    spec.components.schemas.CloudSyncActionResponse.oneOf
      .map((entry: { $ref: string }) => entry.$ref)
      .sort(),
    [
      "#/components/schemas/CloudSyncDisableResponse",
      "#/components/schemas/CloudSyncEnableResponse",
      "#/components/schemas/CloudSyncResultResponse",
    ].sort()
  );
  assert.equal(spec.components.schemas.CloudSyncCreatedApiKey.properties.key["x-sensitive"], true);
  assert.match(
    spec.components.schemas.CloudSyncCreatedApiKey.properties.key.description,
    /raw API key secret/
  );
  assert.equal(
    action.responses["502"].content["application/json"].schema.$ref,
    "#/components/schemas/StringErrorResponse"
  );
  assert.equal(
    action.responses["500"].content["application/json"].schema.$ref,
    "#/components/schemas/StringErrorResponse"
  );
});

test("cloud-sync management auth reflects the configurable global route policy", () => {
  for (const method of ["get", "post"]) {
    const action = operation(method);
    assert.ok(action.security?.some((item: object) => Object.hasOwn(item, "BearerAuth")));
    assert.ok(
      action.security?.some((item: object) => Object.hasOwn(item, "ManagementSessionAuth"))
    );
    assert.ok(action.security?.some((item: object) => Object.keys(item).length === 0));
    assert.equal(
      action.responses["401"].$ref,
      "#/components/responses/ManagementAuthenticationRequired"
    );
    assert.equal(action.responses["403"].$ref, "#/components/responses/ManagementInvalidToken");
    assert.equal(action.responses["503"].$ref, "#/components/responses/ManagementAuthUnavailable");
  }
});
