import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as yaml from "js-yaml";
import { QuotaStoreSettingsSchema } from "../../src/shared/schemas/quota.ts";
import { makeManagementSessionRequest } from "../helpers/managementSession.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-openapi-quota-store-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.NODE_ENV = "test";

const spec = yaml.load(fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8")) as {
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, any> };
};

const coreDb = await import("../../src/lib/db/core.ts");
const quotaStoreRoute = await import("../../src/app/api/settings/quota-store/route.ts");

function operation(method: string): Record<string, any> {
  const result = spec.paths["/api/settings/quota-store"]?.[method];
  assert.ok(result, `missing ${method.toUpperCase()} /api/settings/quota-store`);
  return result;
}

async function request(method: string, body?: unknown): Promise<Request> {
  return makeManagementSessionRequest("http://localhost/api/settings/quota-store", {
    method,
    ...(body === undefined ? {} : { body }),
  });
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

test("quota store request schema follows Zod and separates secret input from redacted output", () => {
  const requestSchema = spec.components.schemas.QuotaStoreSettings;
  assert.deepEqual(
    Object.keys(requestSchema.properties).sort(),
    Object.keys(QuotaStoreSettingsSchema.shape).sort()
  );
  assert.deepEqual(requestSchema.required, ["driver"]);
  assert.equal(requestSchema.properties.redisUrl.writeOnly, true);
  assert.equal(requestSchema.properties.redisUrl.format, "uri");
  assert.equal(QuotaStoreSettingsSchema.safeParse({ driver: "sqlite" }).success, true);
  assert.equal(
    QuotaStoreSettingsSchema.safeParse({
      driver: "redis",
      redisUrl: "redis://user:secret@localhost:6379/0",
    }).success,
    true
  );
  assert.equal(
    QuotaStoreSettingsSchema.safeParse({ driver: "redis", redisUrl: "not-url" }).success,
    false
  );
});

test("quota-store GET and PUT return only a configured flag and null URL placeholder", async () => {
  const secretUrl = "redis://user:very-secret@localhost:6379/0";
  const put = await quotaStoreRoute.PUT(
    await request("PUT", { driver: "redis", redisUrl: secretUrl })
  );
  const putBody = await put.json();
  assert.equal(put.status, 200);
  assert.deepEqual(Object.keys(putBody).sort(), ["driver", "redisUrl", "redisUrlConfigured"]);
  assert.equal(putBody.driver, "redis");
  assert.equal(putBody.redisUrlConfigured, true);
  assert.equal(putBody.redisUrl, null);
  assert.equal(JSON.stringify(putBody).includes("very-secret"), false);

  const get = await quotaStoreRoute.GET(await request("GET"));
  const getBody = await get.json();
  assert.equal(get.status, 200);
  assert.deepEqual(getBody, putBody);
  assert.equal(
    operation("get").responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/QuotaStoreSettingsResponse"
  );
  assert.equal(
    operation("put").responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/QuotaStoreSettingsResponse"
  );
});

test("quota-store routes require conditional management auth and describe validation errors", () => {
  for (const method of ["get", "put"]) {
    const op = operation(method);
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
    operation("put").responses["400"].content["application/json"].schema.$ref,
    "#/components/schemas/ApiErrorResponse"
  );
});
