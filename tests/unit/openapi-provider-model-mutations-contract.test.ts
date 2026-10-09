import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as yaml from "js-yaml";
import { providerModelMutationSchema } from "../../src/shared/validation/schemas/provider.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-openapi-provider-models-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.NODE_ENV = "test";

const spec = yaml.load(fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8")) as {
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, any> };
};

const coreDb = await import("../../src/lib/db/core.ts");
const providerModelsDb = await import("../../src/lib/db/models.ts");
const contextOverrides = await import("../../src/lib/db/modelContextOverrides.ts");
const providerModelsRoute = await import("../../src/app/api/provider-models/route.ts");

function operation(method: string): Record<string, any> {
  const result = spec.paths["/api/provider-models"]?.[method];
  assert.ok(result, `missing ${method.toUpperCase()} /api/provider-models`);
  return result;
}

function request(method: string, url = "http://localhost/api/provider-models", body?: unknown) {
  return new Request(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function json(response: Response): Promise<Record<string, any>> {
  return (await response.json()) as Record<string, any>;
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

test("provider-model mutation requests match the shared Zod validator", () => {
  const mutation = spec.components.schemas.ProviderModelMutationRequest;
  assert.deepEqual(
    Object.keys(mutation.properties).sort(),
    Object.keys(providerModelMutationSchema.shape).sort()
  );
  assert.deepEqual(mutation.required, ["provider", "modelId"]);
  assert.equal(mutation.properties.provider.maxLength, 120);
  assert.equal(mutation.properties.modelId.maxLength, 240);
  assert.equal(mutation.properties.apiFormat.default, "chat-completions");
  assert.deepEqual(mutation.properties.supportedEndpoints.default, ["chat"]);
  assert.equal(mutation.properties.contextWindowOverride.minimum, 1);
  assert.ok(mutation.properties.contextWindowOverride.type.includes("null"));
  assert.deepEqual(operation("post").requestBody.content["application/json"].schema, {
    $ref: "#/components/schemas/ProviderModelMutationRequest",
  });
  assert.deepEqual(operation("put").requestBody.content["application/json"].schema, {
    $ref: "#/components/schemas/ProviderModelMutationRequest",
  });
});

test("custom-model create/update and compat-only update match their response variants", async () => {
  const created = await providerModelsRoute.POST(
    request("POST", undefined, {
      provider: "openai",
      modelId: "gpt-contract-model",
      modelName: "Contract Model",
      apiFormat: "responses",
      supportedEndpoints: ["chat"],
      max_input_tokens: 872000,
      contextWindowOverride: 872000,
    })
  );
  const createBody = await json(created);
  assert.equal(created.status, 200);
  assert.deepEqual(Object.keys(createBody).sort(), ["contextWindowOverride", "model"]);
  assert.equal(createBody.model.id, "gpt-contract-model");
  assert.equal(createBody.contextWindowOverride, 872000);
  assert.equal(
    contextOverrides.getModelContextOverrideRecord("openai", "gpt-contract-model")?.realContext,
    872000
  );

  const cleared = await providerModelsRoute.POST(
    request("POST", undefined, {
      provider: "openai",
      modelId: "gpt-contract-model",
      contextWindowOverride: null,
    })
  );
  const clearedBody = await json(cleared);
  assert.equal(cleared.status, 200);
  assert.equal(clearedBody.contextWindowOverride, null);
  assert.equal(
    contextOverrides.getModelContextOverrideRecord("openai", "gpt-contract-model"),
    null
  );
  assert.equal(
    operation("post").responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/ProviderModelCreateResponse"
  );

  const updated = await providerModelsRoute.PUT(
    request("PUT", undefined, {
      provider: "openai",
      modelId: "gpt-contract-model",
      modelName: "Renamed Model",
      contextWindowOverride: 900000,
    })
  );
  const updateBody = await json(updated);
  assert.equal(updated.status, 200);
  assert.deepEqual(Object.keys(updateBody).sort(), ["contextWindowOverride", "model"]);
  assert.equal(updateBody.contextWindowOverride, 900000);

  const compat = await providerModelsRoute.PUT(
    request("PUT", undefined, {
      provider: "openai",
      modelId: "gpt-catalog-only",
      normalizeToolCallId: true,
    })
  );
  const compatBody = await json(compat);
  assert.equal(compat.status, 200);
  assert.deepEqual(Object.keys(compatBody).sort(), ["modelCompatOverrides", "ok"]);
  const putResponse = spec.components.schemas.ProviderModelPutResponse.oneOf;
  assert.equal(putResponse.length, 2);
});

test("visibility and delete contracts match query-string semantics and live handler envelopes", async () => {
  await providerModelsDb.addCustomModel("openai", "gpt-hidden-contract", "Hidden", "manual");
  const hidden = await providerModelsRoute.PATCH(
    request(
      "PATCH",
      "http://localhost/api/provider-models?provider=openai&modelId=gpt-hidden-contract",
      { isHidden: true }
    )
  );
  const hiddenBody = await json(hidden);
  assert.equal(hidden.status, 200);
  assert.deepEqual(Object.keys(hiddenBody).sort(), [
    "aliasChanges",
    "modelCompatOverrides",
    "models",
    "ok",
    "updated",
  ]);

  const reset = await providerModelsRoute.DELETE(
    request(
      "DELETE",
      "http://localhost/api/provider-models?provider=openai&model=gpt-hidden-contract&resetOverride=true"
    )
  );
  const resetBody = await json(reset);
  assert.equal(reset.status, 200);
  assert.equal(resetBody.resetOverride, true);
  assert.deepEqual(Object.keys(resetBody.aliasChanges).sort(), [
    "assignedAliases",
    "removedAliases",
    "storagePrefix",
  ]);

  await providerModelsDb.addCustomModel("openai", "gpt-clear-contract", "Clear", "manual");
  const clear = await providerModelsRoute.DELETE(
    request("DELETE", "http://localhost/api/provider-models?provider=openai&all=true")
  );
  const clearBody = await json(clear);
  assert.equal(clear.status, 200);
  assert.equal(clearBody.cleared, true);
  assert.equal(typeof clearBody.syncedAvailableModelListsRemoved, "number");

  const patch = operation("patch");
  assert.equal(
    patch.requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/ProviderModelsVisibilityUpdateRequest"
  );
  assert.deepEqual(
    patch.parameters.map((parameter: { name: string }) => parameter.name),
    ["provider", "modelId", "model"]
  );
  const deleteOp = operation("delete");
  assert.equal(
    deleteOp.parameters.find((parameter: { name: string }) => parameter.name === "all").schema.type,
    "string"
  );
  assert.equal(
    deleteOp.parameters.find((parameter: { name: string }) => parameter.name === "resetOverride")
      .schema.type,
    "string"
  );
  assert.equal(spec.components.schemas.ProviderModelsDeleteResponse.oneOf.length, 3);
});

test("provider-model operations document conditional authentication and all emitted errors", () => {
  for (const method of ["get", "post", "put", "patch", "delete"]) {
    const op = operation(method);
    assert.ok(op.security?.some((item: object) => Object.hasOwn(item, "BearerAuth")));
    assert.ok(op.security?.some((item: object) => Object.hasOwn(item, "ManagementSessionAuth")));
    assert.ok(op.security?.some((item: object) => Object.keys(item).length === 0));
    assert.ok(op.responses?.["401"]);
  }
  assert.ok(operation("post").responses["500"]);
  assert.ok(operation("put").responses["404"]);
  assert.ok(operation("patch").responses["500"]);
  assert.ok(operation("delete").responses["500"]);
});
