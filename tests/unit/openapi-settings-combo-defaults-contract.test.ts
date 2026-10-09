import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as yaml from "js-yaml";
import {
  scoringWeightsSchema,
  updateComboDefaultsSchema,
} from "../../src/shared/validation/schemas/combo.ts";
import { makeManagementSessionRequest } from "../helpers/managementSession.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-openapi-combo-defaults-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.NODE_ENV = "test";

const spec = yaml.load(fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8")) as {
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, any> };
};

const coreDb = await import("../../src/lib/db/core.ts");
const comboDefaultsRoute = await import("../../src/app/api/settings/combo-defaults/route.ts");

function operation(method: string): Record<string, any> {
  const result = spec.paths["/api/settings/combo-defaults"]?.[method];
  assert.ok(result, `missing ${method.toUpperCase()} /api/settings/combo-defaults`);
  return result;
}

async function managementRequest(method: string, body?: unknown): Promise<Request> {
  return makeManagementSessionRequest("http://localhost/api/settings/combo-defaults", {
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

test("combo-default GET publishes its current defaults and provider-override envelopes", async () => {
  const response = await comboDefaultsRoute.GET(await managementRequest("GET"));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(body).sort(), ["comboDefaults", "providerOverrides"]);
  assert.ok(
    Object.keys(body.comboDefaults).every((key: string) =>
      Object.hasOwn(spec.components.schemas.ComboRuntimeConfig.properties, key)
    )
  );
  assert.equal(body.comboDefaults.strategy, "priority");
  assert.deepEqual(body.providerOverrides, {});
});

test("combo-default patch matches Zod fields and coerces numeric inputs in the response", async () => {
  const runtimeConfigInput = updateComboDefaultsSchema.shape.comboDefaults.unwrap().in;
  const runtimeConfig = spec.components.schemas.ComboRuntimeConfig;
  assert.deepEqual(
    Object.keys(runtimeConfig.properties).sort(),
    Object.keys(runtimeConfigInput.shape).sort()
  );
  assert.deepEqual(
    Object.keys(runtimeConfig.properties.weights.properties).sort(),
    Object.keys(scoringWeightsSchema.unwrap().shape).sort()
  );
  assert.deepEqual(
    Object.keys(spec.components.schemas.ComboDefaultsUpdateRequest.properties).sort(),
    Object.keys(updateComboDefaultsSchema.shape).sort()
  );
  assert.equal(updateComboDefaultsSchema.safeParse({}).success, false);
  assert.equal(
    updateComboDefaultsSchema.safeParse({ comboDefaults: { compositeTiers: {} } }).success,
    false
  );

  const response = await comboDefaultsRoute.PATCH(
    await managementRequest("PATCH", {
      comboDefaults: { maxRetries: "3", fallbackDelayMs: "250" },
      providerOverrides: { openai: { handoffThreshold: "0.8" } },
    })
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(body).sort(), ["comboDefaults", "providerOverrides"]);
  assert.equal(body.comboDefaults.maxRetries, 3);
  assert.equal(body.comboDefaults.fallbackDelayMs, 250);
  assert.equal(body.providerOverrides.openai.handoffThreshold, 0.8);
});

test("combo-default operations declare conditional management auth and error results", () => {
  for (const method of ["get", "patch"]) {
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
    operation("get").responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/ComboDefaultsResponse"
  );
  assert.equal(
    operation("patch").requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/ComboDefaultsUpdateRequest"
  );
  assert.equal(
    operation("patch").responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/ComboDefaultsResponse"
  );
  assert.equal(
    operation("patch").responses["500"].content["application/json"].schema.$ref,
    "#/components/schemas/StringErrorResponse"
  );
});
