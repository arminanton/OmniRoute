import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as yaml from "js-yaml";
import { makeManagementSessionRequest } from "../helpers/managementSession.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-openapi-reasoning-rules-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.NODE_ENV = "test";

const spec = yaml.load(fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8")) as {
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, any> };
};

const coreDb = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const rulesDb = await import("../../src/lib/db/reasoningRoutingRules.ts");
const collectionRoute = await import("../../src/app/api/settings/reasoning-routing-rules/route.ts");
const itemRoute = await import("../../src/app/api/settings/reasoning-routing-rules/[id]/route.ts");
const simulateRoute =
  await import("../../src/app/api/settings/reasoning-routing-rules/simulate/route.ts");

function rulePayload() {
  return {
    name: "OpenAPI contract rule",
    description: "Created by handler-backed API contract test",
    scope: "global",
    sourceEffort: "missing",
    requestTags: ["coding"],
    tagMatchMode: "any",
    effortMode: "force",
    targetEffort: "high",
    targetKind: "model",
    targetModel: "custom/unknown-reasoning-model",
    budgetAction: "preserve",
    priority: 5,
    enabled: true,
  };
}

function request(pathname: string, method = "GET", body?: unknown): Promise<Request> {
  return makeManagementSessionRequest(`http://localhost${pathname}`, {
    method,
    ...(body === undefined ? {} : { body }),
  });
}

function itemPath(id: string): string {
  return `/api/settings/reasoning-routing-rules/${id}`;
}

function operation(pathname: string, method: string): Record<string, any> {
  const result = spec.paths[pathname]?.[method];
  assert.ok(result, `missing ${method.toUpperCase()} ${pathname}`);
  return result;
}

async function resetStorage(): Promise<void> {
  apiKeysDb.resetApiKeyState();
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  rulesDb.invalidateReasoningRoutingRuleCache();
}

test.beforeEach(resetStorage);

test.after(async () => {
  await resetStorage();
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("reasoning-rule create, list, patch, read and delete match the typed rule envelopes", async () => {
  const collectionPath = "/api/settings/reasoning-routing-rules";
  const createdResponse = await collectionRoute.POST(
    await request(collectionPath, "POST", rulePayload())
  );
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  const ruleSchema = spec.components.schemas.ReasoningRoutingRule;
  assert.deepEqual(Object.keys(created).sort(), ["rule"]);
  for (const required of ruleSchema.required) assert.ok(Object.hasOwn(created.rule, required));
  assert.deepEqual(Object.keys(created.rule).sort(), Object.keys(ruleSchema.properties).sort());
  assert.equal(created.rule.scope, "global");
  assert.equal(created.rule.targetEffort, "high");
  assert.equal(created.rule.requestTags[0], "coding");
  assert.ok(Number.isFinite(Date.parse(created.rule.createdAt)));

  const listedResponse = await collectionRoute.GET(await request(collectionPath));
  const listed = await listedResponse.json();
  assert.equal(listedResponse.status, 200);
  assert.deepEqual(Object.keys(listed).sort(), ["rules"]);
  assert.deepEqual(listed.rules, [created.rule]);

  const patchedResponse = await itemRoute.PATCH(
    await request(itemPath(created.rule.id), "PATCH", { priority: 50 }),
    { params: Promise.resolve({ id: created.rule.id }) }
  );
  const patched = await patchedResponse.json();
  assert.equal(patchedResponse.status, 200);
  assert.equal(patched.rule.priority, 50);
  assert.equal(patched.rule.createdAt, created.rule.createdAt);
  assert.notEqual(patched.rule.updatedAt, "");

  const readResponse = await itemRoute.GET(await request(itemPath(created.rule.id)), {
    params: Promise.resolve({ id: created.rule.id }),
  });
  assert.equal(readResponse.status, 200);
  assert.deepEqual(await readResponse.json(), patched);

  const deletedResponse = await itemRoute.DELETE(
    await request(itemPath(created.rule.id), "DELETE"),
    {
      params: Promise.resolve({ id: created.rule.id }),
    }
  );
  assert.equal(deletedResponse.status, 200);
  assert.deepEqual(await deletedResponse.json(), { success: true });
  assert.equal((await rulesDb.getReasoningRoutingRules()).length, 0);
});

test("reasoning-rule routes reject invalid references and report missing item IDs", async () => {
  const collectionPath = "/api/settings/reasoning-routing-rules";
  const invalid = await collectionRoute.POST(
    await request(collectionPath, "POST", {
      ...rulePayload(),
      scope: "apiKey",
      apiKeyId: "missing-key",
    })
  );
  assert.equal(invalid.status, 400);
  assert.ok((await invalid.json()).error);

  const id = "rule-that-does-not-exist";
  const read = await itemRoute.GET(await request(itemPath(id)), {
    params: Promise.resolve({ id }),
  });
  assert.equal(read.status, 404);
  assert.ok((await read.json()).error);
  const patch = await itemRoute.PATCH(await request(itemPath(id), "PATCH", { priority: 4 }), {
    params: Promise.resolve({ id }),
  });
  assert.equal(patch.status, 404);
  const deleted = await itemRoute.DELETE(await request(itemPath(id), "DELETE"), {
    params: Promise.resolve({ id }),
  });
  assert.equal(deleted.status, 404);
});

test("reasoning-rule simulator exposes a proposed decision without provider execution", async () => {
  await collectionRoute.POST(
    await request("/api/settings/reasoning-routing-rules", "POST", rulePayload())
  );
  const response = await simulateRoute.POST(
    await request("/api/settings/reasoning-routing-rules/simulate", "POST", {
      model: "openai/gpt-4o-mini",
      effort: "missing",
      requestTags: ["coding"],
      transport: "http",
    })
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(body).sort(), ["decision", "errors", "matched"]);
  assert.equal(body.matched, true);
  assert.equal(body.decision.targetModel, "custom/unknown-reasoning-model");
  assert.equal(body.decision.targetEffort, "high");
  assert.ok(["supported", "unsupported", "unknown"].includes(body.decision.capability));
  assert.ok(Array.isArray(body.decision.warnings));
  assert.deepEqual(body.errors, []);
});

test("reasoning-routing OpenAPI covers validators, result variants, auth, and 201 creation", () => {
  const collection = "/api/settings/reasoning-routing-rules";
  const item = "/api/settings/reasoning-routing-rules/{id}";
  const simulate = "/api/settings/reasoning-routing-rules/simulate";
  const operations = [
    operation(collection, "get"),
    operation(collection, "post"),
    operation(item, "get"),
    operation(item, "patch"),
    operation(item, "delete"),
    operation(simulate, "post"),
  ];
  for (const op of operations) {
    assert.ok(op.security?.some((item: object) => Object.hasOwn(item, "BearerAuth")));
    assert.ok(op.security?.some((item: object) => Object.hasOwn(item, "ManagementSessionAuth")));
    assert.ok(op.security?.some((item: object) => Object.keys(item).length === 0));
    assert.ok(op.responses["401"]);
    assert.ok(op.responses["503"]);
  }
  assert.equal(
    operation(collection, "get").responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/ReasoningRoutingRuleListResponse"
  );
  assert.equal(
    operation(collection, "post").responses["201"].content["application/json"].schema.$ref,
    "#/components/schemas/ReasoningRoutingRuleEnvelope"
  );
  assert.equal(
    operation(collection, "post").requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/ReasoningRoutingRuleCreateRequest"
  );
  assert.equal(
    operation(item, "patch").requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/ReasoningRoutingRulePatchRequest"
  );
  assert.equal(
    operation(simulate, "post").responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/ReasoningRoutingSimulationResponse"
  );
  assert.equal(
    spec.components.schemas.ReasoningRoutingRuleCreateRequest.allOf[1].required.includes("scope"),
    true
  );
  assert.equal(spec.components.schemas.ReasoningRoutingRulePatchRequest.minProperties, 1);
});
