import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import * as yaml from "js-yaml";

type Schema = {
  $ref?: string;
  type?: string | string[];
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, Schema>;
};

type Operation = {
  parameters?: Array<{ name: string; in: string; required?: boolean }>;
  requestBody?: { content?: Record<string, { schema?: Schema }> };
  responses?: Record<string, { content?: Record<string, { schema?: Schema }> }>;
};

type ProviderNodeOpenApi = {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, Schema> };
};

const spec = yaml.load(
  fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8")
) as ProviderNodeOpenApi;

function assertResponse(pathTemplate: string, method: string, status: string, schemaName: string) {
  const schema =
    spec.paths[pathTemplate]?.[method]?.responses?.[status]?.content?.["application/json"]?.schema;
  assert.equal(schema?.$ref, `#/components/schemas/${schemaName}`);
  assert.ok(spec.components.schemas[schemaName], `schema ${schemaName} is defined`);
}

function assertRequest(pathTemplate: string, method: string, schemaName: string) {
  const schema =
    spec.paths[pathTemplate]?.[method]?.requestBody?.content?.["application/json"]?.schema;
  assert.equal(schema?.$ref, `#/components/schemas/${schemaName}`);
  assert.ok(spec.components.schemas[schemaName], `schema ${schemaName} is defined`);
}

test("provider-node CRUD and validation routes have typed requests and responses", () => {
  assertResponse("/api/provider-nodes", "get", "200", "ProviderNodeListResponse");
  assertResponse("/api/provider-nodes", "post", "201", "ProviderNodeEnvelope");
  assertRequest("/api/provider-nodes", "post", "ProviderNodeCreateRequest");
  assertResponse("/api/provider-nodes/{id}", "put", "200", "ProviderNodeEnvelope");
  assertRequest("/api/provider-nodes/{id}", "put", "ProviderNodeUpdateRequest");
  assertResponse("/api/provider-nodes/{id}", "delete", "200", "ProviderNodeDeleteResponse");
  assertResponse("/api/provider-nodes/validate", "post", "200", "ProviderNodeValidationResponse");
  assertRequest("/api/provider-nodes/validate", "post", "ValidateProviderNodeRequest");

  assert.equal(spec.components.schemas.ProviderNodeCreateRequest.required, undefined);
  assert.deepEqual(spec.components.schemas.ProviderNodeUpdateRequest.required, [
    "name",
    "prefix",
    "baseUrl",
  ]);
  assert.deepEqual(spec.components.schemas.ValidateProviderNodeRequest.required, ["baseUrl"]);
  assert.deepEqual(spec.components.schemas.ProviderNode.properties?.type?.enum, [
    "openai-compatible",
    "anthropic-compatible",
  ]);
  assert.ok(
    spec.paths["/api/provider-nodes"]?.get?.parameters?.some(
      (parameter) => parameter.name === "offset"
    )
  );
  assert.ok(
    spec.paths["/api/provider-nodes"]?.get?.parameters?.some(
      (parameter) => parameter.name === "limit"
    )
  );
});
