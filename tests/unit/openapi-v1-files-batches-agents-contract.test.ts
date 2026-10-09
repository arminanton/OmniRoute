import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

type Schema = {
  $ref?: string;
  type?: string | string[];
  format?: string;
  enum?: unknown[];
  const?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minProperties?: number;
  maxProperties?: number;
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  oneOf?: Schema[];
  anyOf?: Schema[];
  writeOnly?: boolean;
  description?: string;
  pattern?: string;
};

type Response = {
  $ref?: string;
  content?: Record<string, { schema?: Schema }>;
  headers?: Record<string, unknown>;
};

type Operation = {
  description?: string;
  security?: Array<Record<string, unknown>>;
  parameters?: Array<{
    name: string;
    in: string;
    required?: boolean;
    schema?: Schema;
  }>;
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: Schema }>;
  };
  responses?: Record<string, Response>;
};

type PathItem = Record<string, Operation> & { parameters?: unknown[] };

const spec = yaml.load(fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8")) as {
  paths: Record<string, PathItem>;
  components: { schemas: Record<string, Schema> };
};

function operation(pathTemplate: string, method: string): Operation {
  const result = spec.paths[pathTemplate]?.[method];
  assert.ok(result, `missing ${method.toUpperCase()} ${pathTemplate}`);
  return result;
}

function successSchema(pathTemplate: string, method: string, status = "200"): Schema {
  const schema = operation(pathTemplate, method).responses?.[status]?.content?.["application/json"]
    ?.schema;
  assert.ok(
    schema,
    `missing ${status} response schema for ${method.toUpperCase()} ${pathTemplate}`
  );
  return schema;
}

function assertApiV1Auth(op: Operation, anonymousAllowed = true): void {
  const alternatives = op.security ?? [];
  assert.ok(alternatives.some((entry) => Object.hasOwn(entry, "BearerAuth")));
  assert.ok(alternatives.some((entry) => Object.hasOwn(entry, "ClientApiKeyAuth")));
  assert.ok(alternatives.some((entry) => Object.hasOwn(entry, "ManagementSessionAuth")));
  assert.equal(
    alternatives.some((entry) => Object.keys(entry).length === 0),
    anonymousAllowed
  );
  assert.ok(op.responses?.["401"]);
}

function assertManagementAuth(op: Operation): void {
  const alternatives = op.security ?? [];
  assert.ok(alternatives.some((entry) => Object.hasOwn(entry, "BearerAuth")));
  assert.ok(alternatives.some((entry) => Object.hasOwn(entry, "ManagementSessionAuth")));
  assert.ok(alternatives.some((entry) => Object.keys(entry).length === 0));
  assert.equal(
    op.responses?.["401"]?.$ref,
    "#/components/responses/ManagementAuthenticationRequired"
  );
  assert.equal(op.responses?.["503"]?.$ref, "#/components/responses/ManagementAuthUnavailable");
}

const fileOperations: Array<[string, string]> = [
  ["/api/v1/files", "get"],
  ["/api/v1/files", "post"],
  ["/api/v1/files/{id}", "get"],
  ["/api/v1/files/{id}", "delete"],
  ["/api/v1/files/{id}/content", "get"],
];

const batchOperations: Array<[string, string]> = [
  ["/api/v1/batches", "get"],
  ["/api/v1/batches", "post"],
  ["/api/v1/batches/{id}", "get"],
  ["/api/v1/batches/{id}", "delete"],
  ["/api/v1/batches/{id}/cancel", "post"],
  ["/api/v1/batches/delete-completed", "delete"],
];

const cloudAgentOperations: Array<[string, string]> = [
  ["/api/v1/agents/credentials", "get"],
  ["/api/v1/agents/credentials", "post"],
  ["/api/v1/agents/health", "get"],
  ["/api/v1/agents/tasks", "get"],
  ["/api/v1/agents/tasks", "post"],
  ["/api/v1/agents/tasks", "delete"],
  ["/api/v1/agents/tasks/{id}", "get"],
  ["/api/v1/agents/tasks/{id}", "post"],
  ["/api/v1/agents/tasks/{id}", "delete"],
];

test("v1 files, batches, and cloud-agent routes expose source-backed success bodies and auth", () => {
  for (const [pathTemplate, method] of [...fileOperations, ...batchOperations]) {
    const op = operation(pathTemplate, method);
    assertApiV1Auth(op, false);
    assert.equal(
      op.responses?.["401"]?.$ref,
      "#/components/responses/V1ResourceAuthenticationRequired",
      `missing source-backed 401 for ${method.toUpperCase()} ${pathTemplate}`
    );
    assert.equal(
      op.responses?.["503"]?.$ref,
      "#/components/responses/V1ResourceAuthenticationUnavailable",
      `missing source-backed 503 for ${method.toUpperCase()} ${pathTemplate}`
    );
    for (const [status, response] of Object.entries(op.responses ?? {})) {
      if (!status.startsWith("2")) continue;
      assert.ok(
        Object.values(response.content ?? {}).some((entry) => entry.schema),
        `missing ${status} response content for ${method.toUpperCase()} ${pathTemplate}`
      );
    }
  }
  for (const [pathTemplate, method] of cloudAgentOperations) {
    const op = operation(pathTemplate, method);
    assertManagementAuth(op);
    for (const [status, response] of Object.entries(op.responses ?? {})) {
      if (!status.startsWith("2")) continue;
      assert.ok(
        Object.values(response.content ?? {}).some((entry) => entry.schema),
        `missing ${status} response content for ${method.toUpperCase()} ${pathTemplate}`
      );
    }
  }
});

test("batch request, cursor paging, state transitions, and cleanup match the handlers", () => {
  const create = operation("/api/v1/batches", "post");
  assert.equal(
    create.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/V1BatchCreateRequest"
  );
  assert.equal(
    create.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/V1BatchObject"
  );
  assert.deepEqual(spec.components.schemas.V1BatchCreateRequest.required, [
    "input_file_id",
    "endpoint",
    "completion_window",
  ]);
  assert.deepEqual(spec.components.schemas.V1BatchCreateRequest.properties?.endpoint.enum, [
    "/v1/responses",
    "/v1/chat/completions",
    "/v1/embeddings",
    "/v1/completions",
    "/v1/moderations",
    "/v1/images/generations",
    "/v1/videos/generations",
  ]);
  assert.equal(
    spec.components.schemas.V1BatchCreateRequest.properties?.completion_window.const,
    "24h"
  );
  assert.equal(spec.components.schemas.V1BatchCreateRequest.properties?.metadata.maxProperties, 16);
  assert.deepEqual(
    operation("/api/v1/batches", "get").parameters?.map((parameter) => parameter.name),
    ["limit", "after"]
  );
  assert.equal(
    spec.components.schemas.V1BatchObject.properties?.created_at.description,
    "Unix epoch seconds."
  );
  assert.ok(operation("/api/v1/batches/{id}", "delete").responses?.["409"]);
  assert.ok(operation("/api/v1/batches/{id}/cancel", "post").responses?.["400"]);
  assert.equal(
    successSchema("/api/v1/batches/delete-completed", "delete").$ref,
    "#/components/schemas/V1BatchCleanupResponse"
  );
  assert.equal(
    operation("/api/v1/batches/delete-completed", "delete").security?.some(
      (entry) => Object.keys(entry).length === 0
    ),
    false
  );
  const cleanup = operation("/api/v1/batches/delete-completed", "delete");
  assert.match(cleanup.description ?? "", /all owners.*dashboard session/i);
  assert.match(cleanup.description ?? "", /exact API key/i);
  assert.match(cleanup.description ?? "", /no remaining batch references/i);
});

test("file upload, paging, deletion, and download describe their actual wire formats", () => {
  const upload = operation("/api/v1/files", "post");
  assert.equal(
    upload.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/V1FileObject"
  );
  assert.equal(upload.requestBody?.required, true);
  const multipart = upload.requestBody?.content?.["multipart/form-data"]?.schema;
  assert.deepEqual(multipart?.required, ["file", "purpose"]);
  assert.equal(multipart?.properties?.file.format, "binary");
  assert.match(upload.description ?? "", /512 MiB/);
  assert.equal(
    successSchema("/api/v1/files", "get").$ref,
    "#/components/schemas/V1FileListResponse"
  );
  assert.equal(
    operation("/api/v1/files", "get")
      .parameters?.map((parameter) => parameter.name)
      .join(","),
    "limit,after,order,purpose"
  );
  assert.equal(
    successSchema("/api/v1/files/{id}", "delete").$ref,
    "#/components/schemas/V1FileDeleteResponse"
  );
  const download = operation("/api/v1/files/{id}/content", "get").responses?.["200"];
  assert.equal(download?.content?.["*/*"]?.schema?.format, "binary");
  assert.ok(download?.headers?.["Content-Disposition"]);
});

test("cloud-agent credential, health, task, and action contracts preserve masking", () => {
  const schemas = spec.components.schemas;
  const saveCredentials = operation("/api/v1/agents/credentials", "post");
  assert.equal(
    saveCredentials.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/CloudAgentCredentialSaveRequest"
  );
  assert.equal(schemas.CloudAgentCredentialSaveRequest.properties?.apiKey.writeOnly, true);
  assert.match(schemas.CloudAgentCredential.properties?.apiKey.description ?? "", /masked/i);
  assert.equal(
    successSchema("/api/v1/agents/credentials", "get").$ref,
    "#/components/schemas/CloudAgentCredentialListResponse"
  );

  const createTask = operation("/api/v1/agents/tasks", "post");
  assert.equal(
    createTask.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/CloudAgentTaskCreateRequest"
  );
  assert.equal(
    createTask.responses?.["201"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/CloudAgentTaskCreatedResponse"
  );
  assert.equal(schemas.CloudAgentTaskCreateRequest.properties?.prompt.maxLength, 10000);
  assert.deepEqual(
    schemas.CloudAgentTaskActionRequest.oneOf?.map((variant) => variant.properties?.action.const),
    ["approve", "message", "cancel"]
  );
  assert.equal(
    operation("/api/v1/agents/tasks", "delete").parameters?.find(
      (parameter) => parameter.name === "id"
    )?.required,
    true
  );
  assert.equal(
    successSchema("/api/v1/agents/tasks/{id}", "post").$ref,
    "#/components/schemas/CloudAgentTaskActionResponse"
  );
  assert.equal(
    successSchema("/api/v1/agents/health", "get").$ref,
    "#/components/schemas/CloudAgentHealthResponse"
  );
});
