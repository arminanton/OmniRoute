import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as yaml from "js-yaml";
import { makeManagementSessionRequest } from "../helpers/managementSession.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-openapi-tier-config-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.NODE_ENV = "test";

const spec = yaml.load(fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8")) as {
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, any> };
};

const coreDb = await import("../../src/lib/db/core.ts");
const route = await import("../../src/app/api/settings/tier-config/route.ts");
const tierResolver = await import("../../open-sse/services/tierResolver.ts");
const tierConfigModule = await import("../../open-sse/services/tierConfig.ts");

function operation(method: string): Record<string, any> {
  const result = spec.paths["/api/settings/tier-config"]?.[method];
  assert.ok(result, `missing ${method.toUpperCase()} /api/settings/tier-config`);
  return result;
}

function tierRequest(method: string, body?: unknown): Promise<Request> {
  return makeManagementSessionRequest("http://localhost/api/settings/tier-config", {
    method,
    ...(body === undefined ? {} : { body }),
  });
}

function resetStorage(): void {
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  tierResolver.setTierConfig(null);
}

test.beforeEach(() => {
  resetStorage();
});

test.after(() => {
  resetStorage();
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("tier-config GET exposes the full normalized default config", async () => {
  const response = await route.GET((await tierRequest("GET")) as never);
  const body = await response.json();
  const schema = spec.components.schemas.TierConfigResponse;
  assert.equal(response.status, 200);
  for (const key of schema.required) assert.ok(Object.hasOwn(body, key));
  assert.deepEqual(Object.keys(body).sort(), Object.keys(schema.properties).sort());
  assert.deepEqual(Object.keys(body.defaults).sort(), ["cheapThreshold", "freeThreshold"]);
  assert.deepEqual(body, tierConfigModule.DEFAULT_TIER_CONFIG);
});

test("tier-config PUT adds and clears provider overrides while returning full config", async () => {
  const provider = "custom-provider-route-contract";
  const added = await route.PUT((await tierRequest("PUT", { provider, tier: "premium" })) as never);
  const addedBody = await added.json();
  assert.equal(added.status, 200);
  assert.deepEqual(Object.keys(addedBody).sort(), [
    "defaults",
    "freeProviders",
    "modelOverrides",
    "providerOverrides",
    "version",
  ]);
  assert.deepEqual(addedBody.providerOverrides, [{ provider, tier: "premium" }]);

  const cleared = await route.PUT((await tierRequest("PUT", { provider, tier: null })) as never);
  const clearedBody = await cleared.json();
  assert.equal(cleared.status, 200);
  assert.deepEqual(clearedBody.providerOverrides, []);
  assert.deepEqual(clearedBody.defaults, addedBody.defaults);
  assert.deepEqual(clearedBody.freeProviders, addedBody.freeProviders);
});

test("tier-config rejects invalid payloads with the documented error envelope", async () => {
  for (const body of [
    { provider: "custom-provider", tier: "gold" },
    { provider: "", tier: "free" },
  ]) {
    const response = await route.PUT((await tierRequest("PUT", body)) as never);
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.ok(payload.error);
    assert.equal(typeof payload.error.message, "string");
  }
});

test("tier-config contract documents conditional auth, nullable removal and typed result", () => {
  for (const method of ["get", "put"]) {
    const op = operation(method);
    assert.ok(op.security?.some((item: object) => Object.hasOwn(item, "BearerAuth")));
    assert.ok(op.security?.some((item: object) => Object.hasOwn(item, "ManagementSessionAuth")));
    assert.ok(op.security?.some((item: object) => Object.keys(item).length === 0));
    assert.ok(op.responses["401"]);
    assert.ok(op.responses["503"]);
    assert.equal(
      op.responses["200"].content["application/json"].schema.$ref,
      "#/components/schemas/TierConfigResponse"
    );
  }
  const put = operation("put");
  assert.equal(
    put.requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/TierConfigProviderOverrideRequest"
  );
  assert.equal(
    put.responses["400"].content["application/json"].schema.$ref,
    "#/components/schemas/ApiErrorResponse"
  );
  const tier = spec.components.schemas.TierConfigProviderOverrideRequest.properties.tier;
  assert.ok(tier.enum.includes(null));
  assert.deepEqual(tierConfigModule.tierConfigSchema.parse(tierConfigModule.DEFAULT_TIER_CONFIG), {
    ...tierConfigModule.DEFAULT_TIER_CONFIG,
  });
});
