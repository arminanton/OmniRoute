import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

const ROOT = process.cwd();
const canonicalPath = path.join(ROOT, "docs/openapi.yaml");
const publicPath = path.join(ROOT, "public/openapi.yaml");
const canonicalText = fs.readFileSync(canonicalPath, "utf8");
const publicText = fs.readFileSync(publicPath, "utf8");
const spec = yaml.load(canonicalText) as {
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, any> };
};

const statusContracts = [
  ["/api/compliance/audit-log", "get", ["200", "401", "403", "500", "503"]],
  ["/api/routing/decisions/{requestId}", "get", ["200", "401", "403", "404", "500", "503"]],
  ["/api/upstream-proxy/{providerId}", "get", ["200", "400", "401", "403", "503"]],
  ["/api/upstream-proxy/{providerId}", "put", ["200", "400", "401", "403", "503"]],
  ["/api/upstream-proxy/{providerId}", "delete", ["200", "400", "401", "403", "503"]],
  ["/api/policies", "get", ["200", "401", "403", "500", "503"]],
  ["/api/policies", "post", ["200", "400", "401", "403", "500", "503"]],
  ["/api/webhooks", "get", ["200", "401", "403", "500", "503"]],
  ["/api/webhooks", "post", ["201", "400", "401", "403", "500", "503"]],
  ["/api/webhooks/validate-url", "post", ["200", "400", "401", "403", "503"]],
  ["/api/files", "get", ["200", "401", "403", "500", "503"]],
  ["/api/files/{id}/content", "get", ["200", "401", "403", "404", "503"]],
  ["/api/middleware/hooks", "get", ["200", "401", "403", "404", "500", "503"]],
  ["/api/middleware/hooks", "post", ["201", "400", "401", "403", "409", "500", "503"]],
  ["/api/models/openrouter-catalog", "get", ["200", "401", "403", "503"]],
] as const;

const successSchemaContracts = [
  ["/api/compliance/audit-log", "get", "200", "ComplianceAuditLogResponse"],
  ["/api/routing/decisions/{requestId}", "get", "200", "RouteExplainabilityResponse"],
  ["/api/upstream-proxy/{providerId}", "get", "200", "UpstreamProxyGetResponse"],
  ["/api/upstream-proxy/{providerId}", "put", "200", "UpstreamProxyConfig"],
  ["/api/upstream-proxy/{providerId}", "delete", "200", "UpstreamProxyDeleteResponse"],
  ["/api/policies", "get", "200", "PolicyListResponse"],
  ["/api/policies", "post", "200", "PolicyUnlockResponse"],
  ["/api/webhooks", "get", "200", "WebhookListResponse"],
  ["/api/webhooks", "post", "201", "WebhookUpdatedResponse"],
  ["/api/webhooks/validate-url", "post", "200", "WebhookUrlValidationResponse"],
  ["/api/files", "get", "200", "ManagementFileListResponse"],
  ["/api/middleware/hooks", "get", "200", "MiddlewareHooksGetResponse"],
  ["/api/middleware/hooks", "post", "201", "MiddlewareHookCreateResponse"],
  ["/api/models/openrouter-catalog", "get", "200", "OpenRouterCatalogResponse"],
] as const;

function operation(pathname: string, method: string): any {
  const value = spec.paths[pathname]?.[method];
  assert.ok(value, `${method.toUpperCase()} ${pathname} must exist`);
  return value;
}

function schema(name: string): any {
  const value = spec.components.schemas[name];
  assert.ok(value, `components.schemas.${name} must exist`);
  return value;
}

function assertSchemaRef(pathname: string, method: string, status: string, name: string): void {
  assert.equal(
    operation(pathname, method).responses[status].content?.["application/json"]?.schema?.$ref,
    `#/components/schemas/${name}`,
    `${method.toUpperCase()} ${pathname} ${status} response schema`
  );
}

test("audit, routing, proxy, policy, webhook, file, middleware, and catalog statuses match source", () => {
  assert.equal(statusContracts.length, 15);
  assert.equal(successSchemaContracts.length, 14);

  for (const [pathname, method, expected] of statusContracts) {
    assert.deepEqual(
      Object.keys(operation(pathname, method).responses).sort(),
      [...expected].sort(),
      `${method.toUpperCase()} ${pathname} response status set`
    );
  }

  for (const [pathname, method, status, component] of successSchemaContracts) {
    assertSchemaRef(pathname, method, status, component);
  }

  const errorContracts = [
    ["/api/compliance/audit-log", "get", "500", "ApiErrorResponse"],
    ["/api/routing/decisions/{requestId}", "get", "404", "StringErrorResponse"],
    ["/api/routing/decisions/{requestId}", "get", "500", "StringErrorResponse"],
    ["/api/upstream-proxy/{providerId}", "get", "400", "StringErrorResponse"],
    ["/api/upstream-proxy/{providerId}", "delete", "400", "StringErrorResponse"],
    ["/api/policies", "get", "500", "StringErrorResponse"],
    ["/api/policies", "post", "500", "StringErrorResponse"],
    ["/api/webhooks", "get", "500", "StringErrorResponse"],
    ["/api/webhooks", "post", "500", "StringErrorResponse"],
    ["/api/files", "get", "500", "StringErrorResponse"],
    ["/api/files/{id}/content", "get", "404", "ApiErrorResponse"],
    ["/api/middleware/hooks", "get", "404", "StringErrorResponse"],
    ["/api/middleware/hooks", "post", "400", "ValidationErrorResponse"],
    ["/api/middleware/hooks", "post", "409", "StringErrorResponse"],
    ["/api/middleware/hooks", "post", "500", "StringErrorResponse"],
    ["/api/models/openrouter-catalog", "get", "401", "ManagementAuthenticationRequired"],
  ] as const;
  for (const [pathname, method, status, component] of errorContracts) {
    const response = operation(pathname, method).responses[status];
    if (response.$ref) {
      assert.equal(response.$ref, `#/components/responses/${component}`);
    } else {
      assertSchemaRef(pathname, method, status, component);
    }
  }

  assert.equal(
    operation("/api/upstream-proxy/{providerId}", "put").responses["400"].content[
      "application/json"
    ].schema.oneOf.length,
    2,
    "the validation helper's bare message/details body differs from the route's string error body"
  );
  assert.equal(
    operation("/api/policies", "post").responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/PolicyUnlockResponse",
    "policies POST returns 200 rather than the currently documented 201"
  );
  assert.deepEqual(
    operation("/api/policies", "post").responses["400"].content["application/json"].schema.oneOf.map(
      (entry: { $ref: string }) => entry.$ref
    ),
    ["#/components/schemas/ApiErrorResponse", "#/components/schemas/StringErrorResponse"]
  );
  assert.equal(
    operation("/api/webhooks", "post").responses["201"].content["application/json"].schema.$ref,
    "#/components/schemas/WebhookUpdatedResponse"
  );
  assert.equal(
    operation("/api/middleware/hooks", "post").responses["201"].content["application/json"]
      .schema.$ref,
    "#/components/schemas/MiddlewareHookCreateResponse"
  );
});

test("webhook, file, audit, route-decision, and executable-hook data are marked sensitive", () => {
  assert.equal(operation("/api/compliance/audit-log", "get").responses["200"]["x-sensitive"], true);
  assert.equal(operation("/api/routing/decisions/{requestId}", "get").responses["200"]["x-sensitive"], true);
  assert.equal(operation("/api/webhooks", "get").responses["200"]["x-sensitive"], true);
  assert.equal(operation("/api/webhooks", "post").responses["201"]["x-sensitive"], true);
  assert.equal(schema("WebhookStoredRecord").properties.secret["x-sensitive"], true);
  assert.equal(schema("WebhookMaskedRecord").properties.secret["x-sensitive"], true);
  assert.equal(schema("WebhookCreateRequest").properties.secret["x-sensitive"], true);
  assert.equal(schema("ManagementFileRecord").properties.apiKeyId["x-sensitive"], true);
  assert.equal(operation("/api/files/{id}/content", "get").responses["200"]["x-sensitive"], true);
  assert.equal(schema("MiddlewareHookConfig").properties.code["x-sensitive"], true);
  assert.equal(schema("MiddlewareHookLogEntry").properties.error["x-sensitive"], true);
  assert.equal(operation("/api/middleware/hooks", "get")["x-local-only"], true);
  assert.equal(operation("/api/middleware/hooks", "post")["x-local-only"], true);
});

test("request-dependent success bodies and binary content are described", () => {
  assert.deepEqual(
    schema("UpstreamProxyGetResponse").oneOf.map((entry: { $ref: string }) => entry.$ref),
    [
      "#/components/schemas/UpstreamProxyConfig",
      "#/components/schemas/UpstreamProxyDisabledDefaultResponse",
    ]
  );
  assert.deepEqual(
    schema("WebhookUrlValidationResponse").oneOf.map((entry: { $ref: string }) => entry.$ref),
    [
      "#/components/schemas/WebhookUrlValidResponse",
      "#/components/schemas/WebhookUrlInvalidResponse",
    ]
  );
  assert.deepEqual(
    schema("MiddlewareHooksGetResponse").oneOf.map((entry: { $ref: string }) => entry.$ref),
    [
      "#/components/schemas/MiddlewareHookDetailResponse",
      "#/components/schemas/MiddlewareHookListResponse",
    ]
  );
  const fileContent = operation("/api/files/{id}/content", "get").responses["200"];
  assert.equal(fileContent.content["*/*"].schema.type, "string");
  assert.equal(fileContent.content["*/*"].schema.format, "binary");
  assert.equal(
    operation("/api/models/openrouter-catalog", "get").responses["200"].content[
      "application/json"
    ].schema.$ref,
    "#/components/schemas/OpenRouterCatalogResponse"
  );
});

test("management and local-only authentication declarations are source-aligned", () => {
  const managementOperations = [
    ["/api/compliance/audit-log", "get"],
    ["/api/routing/decisions/{requestId}", "get"],
    ["/api/upstream-proxy/{providerId}", "get"],
    ["/api/upstream-proxy/{providerId}", "put"],
    ["/api/upstream-proxy/{providerId}", "delete"],
    ["/api/policies", "get"],
    ["/api/policies", "post"],
    ["/api/webhooks", "get"],
    ["/api/webhooks", "post"],
    ["/api/webhooks/validate-url", "post"],
    ["/api/files", "get"],
    ["/api/files/{id}/content", "get"],
  ] as const;
  for (const [pathname, method] of managementOperations) {
    const op = operation(pathname, method);
    assert.ok(op.security.some((alternative: Record<string, unknown>) => Object.keys(alternative).length === 0));
    assert.equal(op.responses["401"].$ref, "#/components/responses/ManagementAuthenticationRequired");
    assert.equal(op.responses["403"].$ref, "#/components/responses/ManagementInvalidToken");
    assert.equal(op.responses["503"].$ref, "#/components/responses/ManagementAuthUnavailable");
  }
  const openRouter = operation("/api/models/openrouter-catalog", "get");
  assert.deepEqual(openRouter.security, [
    { ManagementApiKeyBearerAuth: [] },
    { ManagementSessionAuth: [] },
    {},
  ]);
  assert.equal(spec.components.schemas.V1FileListResponse.properties.data.items.$ref,
    "#/components/schemas/V1FileObject",
    "the OpenAI V1 file shape remains distinct from the management file record");
});

test("public OpenAPI mirror stays byte-identical to the canonical contract", () => {
  assert.equal(publicText, canonicalText);
});
