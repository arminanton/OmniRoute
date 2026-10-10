import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

const root = process.cwd();
const docsText = fs.readFileSync(path.join(root, "docs/openapi.yaml"), "utf8");
const publicText = fs.readFileSync(path.join(root, "public/openapi.yaml"), "utf8");
const spec = yaml.load(docsText) as {
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, any> };
};

function operation(route: string, method: string): any {
  const value = spec.paths[route]?.[method];
  assert.ok(value, `missing ${method.toUpperCase()} ${route}`);
  return value;
}

function responseSchema(route: string, method: string, status: string): any {
  return operation(route, method).responses?.[status]?.content?.["application/json"]?.schema;
}

function assertSchemaRef(route: string, method: string, status: string, name: string): void {
  assert.equal(
    responseSchema(route, method, status)?.$ref,
    `#/components/schemas/${name}`,
    `${method.toUpperCase()} ${route} ${status}`
  );
}

test("API-key routes describe accepted management credentials and handler failures", () => {
  const requiredSchemes = [
    "BearerAuth",
    "ManagementSessionAuth",
    "LocalCliTokenAuth",
    "InternalServiceTokenAuth",
    "ManagementGoogleApiKeyAuth",
    "ManagementAnthropicApiKeyAuth",
  ];

  for (const method of ["get", "post"]) {
    const op = operation("/api/keys", method);
    for (const scheme of requiredSchemes) {
      assert.ok(
        op.security?.some((alternative: Record<string, unknown>) => scheme in alternative),
        `${method.toUpperCase()} /api/keys lists ${scheme}`
      );
    }
    assert.ok(
      op.security?.some(
        (alternative: Record<string, unknown>) => Object.keys(alternative).length === 0
      )
    );
    assert.match(op.description ?? "", /requireLogin=false/);
  }

  assertSchemaRef("/api/keys", "get", "500", "StringErrorResponse");
  assertSchemaRef("/api/keys", "post", "400", "ValidationErrorResponse");
  assertSchemaRef("/api/keys", "post", "413", "ApiErrorResponse");
  assertSchemaRef("/api/keys", "post", "500", "StringErrorResponse");
});

test("public CLI bootstrap documents its authentication, throttling, and body errors", () => {
  const op = operation("/api/cli/connect", "post");
  assert.deepEqual(op.security, [], "CLI bootstrap authenticates with its password body");
  const badRequestRefs = responseSchema("/api/cli/connect", "post", "400")?.oneOf?.map(
    (branch: Record<string, string>) => branch.$ref
  );
  assert.deepEqual(badRequestRefs, [
    "#/components/schemas/StringErrorResponse",
    "#/components/schemas/ValidationErrorResponse",
  ]);
  assertSchemaRef("/api/cli/connect", "post", "401", "StringErrorResponse");
  assertSchemaRef("/api/cli/connect", "post", "403", "CliConnectNeedsSetupResponse");
  assertSchemaRef("/api/cli/connect", "post", "413", "ApiErrorResponse");
  assertSchemaRef("/api/cli/connect", "post", "429", "StringErrorResponse");
  assert.equal(op.responses["429"].headers["Retry-After"].schema.type, "string");
  assertSchemaRef("/api/cli/connect", "post", "500", "StringErrorResponse");
});

test("memory API contracts distinguish management auth, legacy auth, and route errors", () => {
  const managementSchemes = [
    "BearerAuth",
    "ManagementSessionAuth",
    "LocalCliTokenAuth",
    "InternalServiceTokenAuth",
    "ManagementGoogleApiKeyAuth",
    "ManagementAnthropicApiKeyAuth",
  ];
  const managementOperations: Array<[string, string]> = [
    ["/api/memory", "get"],
    ["/api/memory", "post"],
    ["/api/memory/{id}", "get"],
    ["/api/memory/{id}", "put"],
    ["/api/memory/{id}", "delete"],
    ["/api/memory/health", "get"],
    ["/api/memory/reindex", "post"],
    ["/api/memory/retrieve-preview", "post"],
    ["/api/memory/summarize", "post"],
  ];
  for (const [route, method] of managementOperations) {
    const op = operation(route, method);
    for (const scheme of managementSchemes) {
      assert.ok(
        op.security?.some((alternative: Record<string, unknown>) => scheme in alternative),
        `${method.toUpperCase()} ${route} lists ${scheme}`
      );
    }
    assert.ok(
      op.security?.some(
        (alternative: Record<string, unknown>) => Object.keys(alternative).length === 0
      )
    );
    assert.equal(
      op.responses["401"]?.$ref,
      "#/components/responses/ManagementAuthenticationRequired"
    );
    assert.equal(op.responses["403"]?.$ref, "#/components/responses/ManagementInvalidToken");
    assert.equal(op.responses["503"]?.$ref, "#/components/responses/ManagementAuthUnavailable");
  }

  for (const route of ["/api/memory/embedding-providers", "/api/memory/engine-status"]) {
    const op = operation(route, "get");
    assert.ok(op.security?.some((entry: Record<string, unknown>) => "BearerAuth" in entry));
    assert.ok(
      op.security?.some((entry: Record<string, unknown>) => "ManagementSessionAuth" in entry)
    );
    assert.ok(
      op.security?.some((entry: Record<string, unknown>) => Object.keys(entry).length === 0)
    );
    assert.equal(op.responses["401"]?.$ref, "#/components/responses/Unauthorized");
    assertSchemaRef(route, "get", "500", "ApiErrorResponse");
  }

  for (const [route, method, status] of [
    ["/api/memory", "get", "500"],
    ["/api/memory", "post", "400"],
    ["/api/memory", "post", "413"],
    ["/api/memory/{id}", "get", "404"],
    ["/api/memory/{id}", "get", "500"],
    ["/api/memory/{id}", "put", "400"],
    ["/api/memory/{id}", "put", "404"],
    ["/api/memory/{id}", "put", "413"],
    ["/api/memory/{id}", "put", "500"],
    ["/api/memory/{id}", "delete", "404"],
    ["/api/memory/{id}", "delete", "413"],
    ["/api/memory/{id}", "delete", "500"],
    ["/api/memory/health", "get", "500"],
    ["/api/memory/reindex", "post", "400"],
    ["/api/memory/reindex", "post", "413"],
    ["/api/memory/reindex", "post", "500"],
    ["/api/memory/retrieve-preview", "post", "400"],
    ["/api/memory/retrieve-preview", "post", "413"],
    ["/api/memory/retrieve-preview", "post", "500"],
    ["/api/memory/summarize", "post", "400"],
    ["/api/memory/summarize", "post", "413"],
    ["/api/memory/summarize", "post", "500"],
  ] as const) {
    assert.ok(
      operation(route, method).responses[status],
      `${method.toUpperCase()} ${route} ${status}`
    );
  }
  assertSchemaRef("/api/memory", "post", "400", "MemoryErrorResponse");
  assertSchemaRef("/api/memory/{id}", "put", "400", "MemoryErrorResponse");
  assertSchemaRef("/api/memory/reindex", "post", "400", "MemoryErrorResponse");
  assertSchemaRef("/api/memory/retrieve-preview", "post", "400", "MemoryErrorResponse");
  assertSchemaRef("/api/memory/summarize", "post", "400", "MemoryErrorResponse");
  assertSchemaRef("/api/memory/health", "get", "500", "MemoryHealthResponse");
  assert.equal(publicText, docsText, "public OpenAPI artifact must mirror the canonical document");
});
