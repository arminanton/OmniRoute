import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as yaml from "js-yaml";
import { makeManagementSessionRequest } from "../helpers/managementSession.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-openapi-feature-flags-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.NODE_ENV = "test";

const spec = yaml.load(fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8")) as {
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, any> };
};

const coreDb = await import("../../src/lib/db/core.ts");
const featureFlagsRoute = await import("../../src/app/api/settings/feature-flags/route.ts");

function operation(method: string): Record<string, any> {
  const result = spec.paths["/api/settings/feature-flags"]?.[method];
  assert.ok(result, `missing ${method.toUpperCase()} /api/settings/feature-flags`);
  return result;
}

function flagRequest(method: string, body?: unknown): Promise<Request> {
  return makeManagementSessionRequest("http://localhost/api/settings/feature-flags", {
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

test("feature-flag GET matches resolved definitions, source values, and summary counts", async () => {
  const response = await featureFlagsRoute.GET((await flagRequest("GET")) as never);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(body).sort(), ["flags", "summary"]);
  assert.deepEqual(
    Object.keys(body.summary).sort(),
    Object.keys(spec.components.schemas.FeatureFlagsSummary.properties).sort()
  );
  assert.equal(body.summary.total, body.flags.length);
  assert.equal(body.summary.active + body.summary.inactive, body.summary.total);
  const flagSchema = spec.components.schemas.FeatureFlagDefinitionResponse;
  for (const flag of body.flags) {
    for (const required of flagSchema.required) assert.ok(Object.hasOwn(flag, required));
    assert.ok(Object.keys(flag).every((key) => Object.hasOwn(flagSchema.properties, key)));
    assert.ok(["db", "env", "default"].includes(flag.source));
  }
});

test("feature-flag PUT updates one override and DELETE clears all override rows", async () => {
  const put = await featureFlagsRoute.PUT(
    (await flagRequest("PUT", { key: "INPUT_SANITIZER_ENABLED", value: "false" })) as never
  );
  const putBody = await put.json();
  assert.equal(put.status, 200);
  assert.deepEqual(Object.keys(putBody).sort(), [
    "effectiveValue",
    "key",
    "previousSource",
    "previousValue",
    "requiresRestart",
    "source",
  ]);
  assert.equal(putBody.key, "INPUT_SANITIZER_ENABLED");
  assert.equal(putBody.effectiveValue, "false");
  assert.equal(putBody.source, "db");

  const deleted = await featureFlagsRoute.DELETE((await flagRequest("DELETE")) as never);
  const deleteBody = await deleted.json();
  assert.equal(deleted.status, 200);
  assert.equal(deleteBody.cleared, 1);
  assert.equal(deleteBody.message, "Cleared 1 feature flag override");
  assert.deepEqual(Object.keys(deleteBody).sort(), ["cleared", "message"]);
});

test("feature-flag operations document conditional management auth and result envelopes", () => {
  for (const method of ["get", "put", "delete"]) {
    const op = operation(method);
    assert.ok(op.security?.some((item: object) => Object.hasOwn(item, "BearerAuth")));
    assert.ok(op.security?.some((item: object) => Object.hasOwn(item, "ManagementSessionAuth")));
    assert.ok(op.security?.some((item: object) => Object.keys(item).length === 0));
    assert.ok(op.responses["401"]);
    assert.ok(op.responses["403"]);
    assert.ok(op.responses["503"]);
  }
  assert.equal(
    operation("get").responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/FeatureFlagsListResponse"
  );
  assert.equal(
    operation("put").requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/FeatureFlagUpdateRequest"
  );
  assert.equal(
    operation("put").responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/FeatureFlagUpdateResponse"
  );
  assert.equal(
    operation("delete").responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/FeatureFlagsDeleteResponse"
  );
});
