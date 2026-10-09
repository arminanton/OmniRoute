import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as yaml from "js-yaml";
import { makeManagementSessionRequest } from "../helpers/managementSession.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-openapi-model-aliases-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.NODE_ENV = "test";

const spec = yaml.load(fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8")) as {
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, any> };
};

const coreDb = await import("../../src/lib/db/core.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const modelDeprecation = await import("../../open-sse/services/modelDeprecation.ts");
const route = await import("../../src/app/api/settings/model-aliases/route.ts");

function request(method: string, body?: unknown): Promise<Request> {
  return makeManagementSessionRequest("http://localhost/api/settings/model-aliases", {
    method,
    ...(body === undefined ? {} : { body }),
  });
}

function operation(method: string): Record<string, any> {
  const result = spec.paths["/api/settings/model-aliases"]?.[method];
  assert.ok(result, `missing ${method.toUpperCase()} /api/settings/model-aliases`);
  return result;
}

function resetStorage(): void {
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  modelDeprecation.setCustomAliases({});
}

test.beforeEach(resetStorage);

test.after(() => {
  resetStorage();
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("model-alias GET returns built-in, custom, and merged maps", async () => {
  modelDeprecation.setCustomAliases({ "team-default": "openai/gpt-6-sol" });
  const response = await route.GET(await request("GET"));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(body).sort(), ["all", "builtIn", "custom"]);
  assert.deepEqual(body.custom, { "team-default": "openai/gpt-6-sol" });
  assert.ok(Object.keys(body.builtIn).length > 0);
  assert.deepEqual(body.all, { ...body.builtIn, ...body.custom });
});

test("model-alias PUT replaces, POST adds, and DELETE removes custom aliases", async () => {
  const put = await route.PUT(
    await request("PUT", { aliases: { "legacy-fast": "openai/gpt-6-sol" } })
  );
  const putBody = await put.json();
  assert.equal(put.status, 200);
  assert.deepEqual(putBody, {
    success: true,
    custom: { "legacy-fast": "openai/gpt-6-sol" },
  });

  const post = await route.POST(
    await request("POST", { from: "legacy-pro", to: "anthropic/claude-opus" })
  );
  const postBody = await post.json();
  assert.equal(post.status, 200);
  assert.deepEqual(postBody.custom, {
    "legacy-fast": "openai/gpt-6-sol",
    "legacy-pro": "anthropic/claude-opus",
  });

  const deleted = await route.DELETE(await request("DELETE", { from: "legacy-pro" }));
  const deletedBody = await deleted.json();
  assert.equal(deleted.status, 200);
  assert.deepEqual(deletedBody, {
    success: true,
    custom: { "legacy-fast": "openai/gpt-6-sol" },
  });
  const missing = await route.DELETE(await request("DELETE", { from: "missing-alias" }));
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "Alias not found" });
});

test("model-alias GET recovers persisted custom aliases when runtime state is empty", async () => {
  await settingsDb.updateSettings({ modelAliases: { "restored-alias": "openai/gpt-6-sol" } });
  modelDeprecation.setCustomAliases({});
  const response = await route.GET(await request("GET"));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.custom, { "restored-alias": "openai/gpt-6-sol" });
  assert.equal(body.all["restored-alias"], "openai/gpt-6-sol");
});

test("model-alias validation errors and OpenAPI request/result/auth contracts match", async () => {
  const invalid = await route.POST(await request("POST", { from: "   ", to: "target" }));
  assert.equal(invalid.status, 400);
  assert.ok((await invalid.json()).error);

  for (const method of ["get", "put", "post", "delete"]) {
    const op = operation(method);
    assert.ok(op.security?.some((item: object) => Object.hasOwn(item, "BearerAuth")));
    assert.ok(op.security?.some((item: object) => Object.hasOwn(item, "ManagementSessionAuth")));
    assert.ok(op.security?.some((item: object) => Object.keys(item).length === 0));
    assert.ok(op.responses["401"]);
    assert.ok(op.responses["503"]);
  }
  assert.equal(
    operation("get").responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/ModelAliasesGetResponse"
  );
  assert.equal(
    operation("put").requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/ModelAliasesUpdateRequest"
  );
  assert.equal(
    operation("post").requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/ModelAliasAddRequest"
  );
  assert.equal(
    operation("delete").requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/ModelAliasRemoveRequest"
  );
  for (const method of ["put", "post", "delete"]) {
    assert.equal(
      operation(method).responses["200"].content["application/json"].schema.$ref,
      "#/components/schemas/SettingsModelAliasMutationResponse"
    );
  }
});
