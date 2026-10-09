import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

type Schema = {
  $ref?: string;
  type?: string | string[];
  description?: string;
  default?: unknown;
  const?: unknown;
  enum?: unknown[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  minProperties?: number;
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  additionalProperties?: boolean | Schema;
  oneOf?: Schema[];
};

type Response = {
  $ref?: string;
  content?: Record<string, { schema?: Schema }>;
};

type Operation = {
  security?: Array<Record<string, unknown>>;
  parameters?: Array<{
    name: string;
    in: string;
    required?: boolean;
    schema?: Schema;
  }>;
  requestBody?: { content?: Record<string, { schema?: Schema }> };
  responses?: Record<string, Response>;
};

type Spec = {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, Schema> };
};

const docsSpecText = fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8");
const publicSpecText = fs.readFileSync(path.join(process.cwd(), "public/openapi.yaml"), "utf8");
const spec = yaml.load(docsSpecText) as Spec;
const publicSpec = yaml.load(publicSpecText) as Spec;

function op(pathTemplate: string, method: string): Operation {
  const operation = spec.paths[pathTemplate]?.[method];
  assert.ok(operation, `missing OpenAPI operation ${method.toUpperCase()} ${pathTemplate}`);
  return operation;
}

function responseSchema(pathTemplate: string, method: string, status = "200"): Schema {
  const schema = op(pathTemplate, method).responses?.[status]?.content?.["application/json"]
    ?.schema;
  assert.ok(schema, `missing JSON schema for ${method.toUpperCase()} ${pathTemplate} ${status}`);
  return schema;
}

function assertManagementAuth(operation: Operation) {
  const alternatives = operation.security ?? [];
  assert.equal(
    alternatives.some((entry) => Object.hasOwn(entry, "BearerAuth")),
    true
  );
  assert.equal(
    alternatives.some((entry) => Object.hasOwn(entry, "ManagementSessionAuth")),
    true
  );
  assert.equal(
    alternatives.some((entry) => Object.keys(entry).length === 0),
    true
  );
  assert.equal(
    operation.responses?.["401"]?.$ref,
    "#/components/responses/ManagementAuthenticationRequired"
  );
  const forbidden = operation.responses?.["403"];
  assert.ok(forbidden);
  assert.equal(
    forbidden.$ref === "#/components/responses/ManagementInvalidToken" ||
      forbidden.content?.["application/json"]?.schema?.oneOf?.some(
        (variant) => variant.$ref === "#/components/schemas/ApiErrorResponse"
      ),
    true
  );
  assert.equal(
    operation.responses?.["503"]?.$ref,
    "#/components/responses/ManagementAuthUnavailable"
  );
}

test("model capability overrides expose public targets, keys, and effort-value shape", () => {
  const route = spec.paths["/api/model-capability-overrides"];
  for (const method of ["get", "patch", "delete"]) {
    assert.equal(
      responseSchema("/api/model-capability-overrides", method).$ref,
      "#/components/schemas/ModelCapabilityOverridesResponse"
    );
    assertManagementAuth(route[method]);
  }

  const request = route.patch.requestBody?.content?.["application/json"]?.schema;
  assert.equal(request?.$ref, "#/components/schemas/ModelCapabilityOverrideUpsertRequest");
  const variants = spec.components.schemas.ModelCapabilityOverrideUpsertRequest.oneOf ?? [];
  assert.deepEqual(variants[0]?.properties?.key?.enum, [
    "context_length",
    "max_input_tokens",
    "max_output_tokens",
  ]);
  assert.deepEqual(spec.components.schemas.ModelCapabilityOverrideNumeric.properties?.key?.enum, [
    "context_length",
    "max_input_tokens",
    "max_output_tokens",
    "max_token",
  ]);
  assert.equal(variants[1]?.properties?.key?.const, "reasoning_efforts");
  assert.equal(variants[1]?.properties?.value?.type, "string");
  assert.match(variants[1]?.properties?.value?.description ?? "", /comma-separated/i);

  const remove = route.delete;
  assert.equal(remove.parameters?.find((parameter) => parameter.name === "target")?.required, true);
  assert.equal(remove.parameters?.find((parameter) => parameter.name === "key")?.required, true);
  assert.deepEqual(remove.parameters?.find((parameter) => parameter.name === "key")?.schema?.enum, [
    "context_length",
    "max_input_tokens",
    "max_output_tokens",
    "reasoning_efforts",
  ]);
  assert.deepEqual(
    route.patch.responses?.["400"]?.content?.["application/json"]?.schema?.oneOf?.map(
      (variant) => variant.$ref
    ),
    [
      "#/components/schemas/StringErrorResponse",
      "#/components/schemas/ModelCapabilityOverrideValidationErrorResponse",
    ]
  );
});

test("model-combo mapping pagination and CRUD match route validation and actual status codes", () => {
  const collection = spec.paths["/api/model-combo-mappings"];
  const limit = collection.get.parameters?.find((parameter) => parameter.name === "limit");
  const offset = collection.get.parameters?.find((parameter) => parameter.name === "offset");
  assert.equal(limit?.schema?.minimum, 0);
  assert.equal(limit?.schema?.maximum, 200);
  assert.equal(offset?.schema?.minimum, 0);
  assert.equal(
    responseSchema("/api/model-combo-mappings", "get").$ref,
    "#/components/schemas/ModelComboMappingListResponse"
  );

  const create = collection.post;
  const createBody = create.requestBody?.content?.["application/json"]?.schema;
  assert.equal(createBody?.$ref, "#/components/schemas/ModelComboMappingCreate");
  assert.deepEqual(spec.components.schemas.ModelComboMappingCreate.required, [
    "pattern",
    "comboId",
  ]);
  assert.equal(
    create.responses?.["201"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ModelComboMappingEnvelope"
  );
  assert.equal(create.responses?.["200"], undefined);

  const item = spec.paths["/api/model-combo-mappings/{id}"];
  assert.equal(
    item.parameters?.some((parameter) => parameter.name === "id" && parameter.required),
    true
  );
  assert.equal(
    responseSchema("/api/model-combo-mappings/{id}", "get").$ref,
    "#/components/schemas/ModelComboMappingEnvelope"
  );
  assert.equal(
    item.put.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ModelComboMappingUpdate"
  );
  assert.equal(spec.components.schemas.ModelComboMappingUpdate.minProperties, undefined);
  assert.equal(
    responseSchema("/api/model-combo-mappings/{id}", "put").$ref,
    "#/components/schemas/ModelComboMappingEnvelope"
  );
  assert.equal(
    responseSchema("/api/model-combo-mappings/{id}", "delete").$ref,
    "#/components/schemas/SuccessResponse"
  );
  assert.equal(
    item.put.responses?.["500"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/StringErrorResponse"
  );
  for (const method of ["get", "post"]) assertManagementAuth(collection[method]);
  for (const method of ["get", "put", "delete"]) assertManagementAuth(item[method]);
});

test("single and batch model tests document input caps and result contracts", () => {
  const single = op("/api/models/test", "post");
  const singleBody = single.requestBody?.content?.["application/json"]?.schema;
  assert.equal(singleBody?.$ref, "#/components/schemas/ModelTestRequest");
  assert.deepEqual(spec.components.schemas.ModelTestRequest.required, ["providerId", "modelId"]);
  assert.equal(
    responseSchema("/api/models/test", "post").$ref,
    "#/components/schemas/ModelTestSuccessResponse"
  );
  assert.equal(
    single.responses?.default?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ModelTestErrorResponse"
  );
  assert.deepEqual(
    single.responses?.["403"]?.content?.["application/json"]?.schema?.oneOf?.map(
      (variant) => variant.$ref
    ),
    ["#/components/schemas/ModelTestErrorResponse", "#/components/schemas/ApiErrorResponse"]
  );

  const batch = op("/api/models/test-all", "post");
  assert.equal(
    batch.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ModelTestBatchRequest"
  );
  assert.equal(spec.components.schemas.ModelTestBatchRequest.properties?.modelIds?.maxItems, 100);
  assert.equal(
    spec.components.schemas.ModelTestBatchRequest.properties?.respectRateLimit?.default,
    true
  );
  assert.equal(
    spec.components.schemas.ModelTestBatchRequest.properties?.autoHideFailed?.default,
    false
  );
  assert.equal(
    responseSchema("/api/models/test-all", "post").$ref,
    "#/components/schemas/ModelTestBatchResponse"
  );
  assert.deepEqual(spec.components.schemas.ModelTestBatchEntry.properties?.status?.enum, [
    "ok",
    "error",
    "slow",
  ]);
  assert.deepEqual(spec.components.schemas.ModelTestBatchResponse.properties?.stopReason?.enum, [
    "consecutive_rate_limits",
    "consecutive_bot_blocks",
  ]);
  assertManagementAuth(single);
  assertManagementAuth(batch);
});

test("selected model-routing contracts and schema refs are mirrored to public OpenAPI", () => {
  const selected: Array<[string, string]> = [
    ["/api/model-capability-overrides", "get"],
    ["/api/model-capability-overrides", "patch"],
    ["/api/model-capability-overrides", "delete"],
    ["/api/model-combo-mappings", "get"],
    ["/api/model-combo-mappings", "post"],
    ["/api/model-combo-mappings/{id}", "get"],
    ["/api/model-combo-mappings/{id}", "put"],
    ["/api/model-combo-mappings/{id}", "delete"],
    ["/api/models/test", "post"],
    ["/api/models/test-all", "post"],
  ];
  for (const [pathTemplate, method] of selected) {
    const success = Object.entries(op(pathTemplate, method).responses ?? {}).filter(([status]) =>
      status.startsWith("2")
    );
    assert.ok(success.length > 0);
    for (const [status, response] of success) {
      assert.ok(
        response.content?.["application/json"]?.schema,
        `empty ${status} ${method} ${pathTemplate}`
      );
    }
    assert.deepEqual(
      publicSpec.paths[pathTemplate]?.[method],
      spec.paths[pathTemplate]?.[method],
      `public OpenAPI is missing ${method.toUpperCase()} ${pathTemplate}`
    );
  }

  const schemaNames = [
    "ModelCapabilityOverride",
    "ModelCapabilityOverridesResponse",
    "ModelCapabilityOverrideUpsertRequest",
    "ModelComboMapping",
    "ModelComboMappingListResponse",
    "ModelComboMappingCreate",
    "ModelComboMappingUpdate",
    "ModelTestRequest",
    "ModelTestSuccessResponse",
    "ModelTestErrorResponse",
    "ModelTestBatchRequest",
    "ModelTestBatchEntry",
    "ModelTestBatchResponse",
  ];
  for (const name of schemaNames) {
    assert.deepEqual(
      publicSpec.components.schemas[name],
      spec.components.schemas[name],
      `public OpenAPI is missing schema ${name}`
    );
  }
});
