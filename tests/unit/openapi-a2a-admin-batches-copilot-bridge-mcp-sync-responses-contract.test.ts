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
  components: {
    schemas: Record<string, any>;
    securitySchemes: Record<string, any>;
  };
};

const statusContracts = [
  ["/api/a2a/status", "get", ["200", "401", "403", "500", "503"]],
  ["/api/admin/concurrency", "get", ["200", "401", "403", "503"]],
  ["/api/admin/concurrency", "post", ["200", "400", "401", "403", "503"]],
  ["/api/batches", "get", ["200", "401", "403", "500", "503"]],
  ["/api/batches/{id}", "get", ["200", "401", "403", "404", "500", "503"]],
  ["/api/copilot/chat", "post", ["200", "400", "401", "403", "500", "503"]],
  ["/api/internal/codex-responses-ws", "post", ["200", "400", "401", "403", "409", "426", "500", "503"]],
  ["/api/mcp/audit", "get", ["200", "401", "403", "500", "503"]],
  ["/api/mcp/audit/stats", "get", ["200", "401", "403", "500", "503"]],
  ["/api/mcp/status", "get", ["200", "401", "403", "500", "503"]],
  ["/api/mcp/tools", "get", ["200", "401", "403", "500", "503"]],
  ["/api/sync/bundle", "get", ["200", "304", "401", "500"]],
  ["/api/sync/tokens", "get", ["200", "401", "403", "500", "503"]],
  ["/api/sync/tokens", "post", ["201", "400", "401", "403", "500", "503"]],
  ["/api/sync/tokens/{id}", "delete", ["200", "401", "403", "404", "500", "503"]],
] as const;

const successSchemaContracts = [
  ["/api/a2a/status", "get", "200", "A2AStatusResponse"],
  ["/api/admin/concurrency", "get", "200", "AdminConcurrencyResponse"],
  ["/api/admin/concurrency", "post", "200", "AdminConcurrencyResetResponse"],
  ["/api/batches", "get", "200", "ManagementBatchListResponse"],
  ["/api/batches/{id}", "get", "200", "ManagementBatchResponse"],
  ["/api/copilot/chat", "post", "200", "CopilotChatResponse"],
  ["/api/internal/codex-responses-ws", "post", "200", "CodexResponsesWsBridgeResponse"],
  ["/api/mcp/audit", "get", "200", "McpAuditEntriesResponse"],
  ["/api/mcp/audit/stats", "get", "200", "McpAuditStatsResponse"],
  ["/api/mcp/status", "get", "200", "McpStatusResponse"],
  ["/api/mcp/tools", "get", "200", "McpToolsResponse"],
  ["/api/sync/bundle", "get", "200", "ConfigSyncBundleResponse"],
  ["/api/sync/tokens", "get", "200", "SyncTokenListResponse"],
  ["/api/sync/tokens", "post", "201", "SyncTokenCreateResponse"],
  ["/api/sync/tokens/{id}", "delete", "200", "SyncTokenRevokeResponse"],
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

function assertSchemaRef(
  pathname: string,
  method: string,
  status: string,
  name: string
): void {
  assert.equal(
    operation(pathname, method).responses[status].content?.["application/json"]?.schema?.$ref,
    `#/components/schemas/${name}`,
    `${method.toUpperCase()} ${pathname} ${status} response schema`
  );
}

test("A2A, management, bridge, MCP, and sync response contracts match source statuses and schemas", () => {
  assert.equal(statusContracts.length, 15);
  assert.equal(successSchemaContracts.length, 15);

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
    ["/api/a2a/status", "get", "500", "StringErrorResponse"],
    ["/api/admin/concurrency", "post", "400", "StringErrorResponse"],
    ["/api/batches", "get", "500", "StringErrorResponse"],
    ["/api/batches/{id}", "get", "404", "StringErrorResponse"],
    ["/api/batches/{id}", "get", "500", "StringErrorResponse"],
    ["/api/copilot/chat", "post", "400", "ApiErrorResponse"],
    ["/api/copilot/chat", "post", "500", "ApiErrorResponse"],
    ["/api/mcp/audit", "get", "500", "StringErrorResponse"],
    ["/api/mcp/audit/stats", "get", "500", "StringErrorResponse"],
    ["/api/mcp/status", "get", "500", "StringErrorResponse"],
    ["/api/mcp/tools", "get", "500", "StringErrorResponse"],
    ["/api/sync/bundle", "get", "401", "ApiErrorResponse"],
    ["/api/sync/bundle", "get", "500", "ApiErrorResponse"],
    ["/api/sync/tokens", "post", "500", "ApiErrorResponse"],
    ["/api/sync/tokens/{id}", "delete", "404", "ApiErrorResponse"],
  ] as const;
  for (const [pathname, method, status, component] of errorContracts) {
    assertSchemaRef(pathname, method, status, component);
  }

  assert.deepEqual(
    operation("/api/admin/concurrency", "get").responses["401"],
    { $ref: "#/components/responses/ManagementAuthenticationRequired" }
  );
  assert.equal(
    operation("/api/sync/tokens", "post").responses["400"].content["application/json"].schema
      .oneOf.length,
    2,
    "malformed JSON uses ApiErrorResponse while validation errors use StringErrorResponse"
  );
  assert.equal(
    operation("/api/sync/tokens", "post").responses["201"].headers["Cache-Control"].schema.const,
    "no-store"
  );
});

test("Codex bridge action contracts and credential boundaries are explicit", () => {
  const bridge = operation("/api/internal/codex-responses-ws", "post");
  assert.deepEqual(bridge.security, [{ CodexResponsesWsBridgeSecretAuth: [] }]);
  assert.equal(bridge["x-local-only"], undefined);
  assert.equal(
    bridge.requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/CodexResponsesWsBridgeRequest"
  );
  assert.deepEqual(schema("CodexResponsesWsBridgeRequest").properties.action.enum, [
    "authenticate",
    "prepare",
    "log",
  ]);
  assert.deepEqual(
    schema("CodexResponsesWsBridgeResponse").oneOf.map((entry: { $ref: string }) => entry.$ref),
    [
      "#/components/schemas/CodexResponsesWsBridgeAuthenticateResponse",
      "#/components/schemas/CodexResponsesWsBridgePrepareResponse",
      "#/components/schemas/CodexResponsesWsBridgeLogResponse",
    ]
  );
  assert.equal(spec.components.securitySchemes.CodexResponsesWsBridgeSecretAuth.name, "x-omniroute-ws-bridge-secret");
  assert.equal(schema("CodexResponsesWsBridgeRequest")["x-sensitive"], true);
  assert.equal(schema("CodexResponsesWsBridgePrepareResponse").properties.headers["x-sensitive"], true);
  assert.equal(schema("CodexResponsesWsBridgePrepareResponse").properties.response["x-sensitive"], true);
});

test("credential-bearing Copilot and sync payloads are marked sensitive", () => {
  assert.equal(operation("/api/copilot/chat", "post")["x-local-only"], true);
  assert.equal(schema("CopilotChatResponse")["x-sensitive"], true);
  assert.equal(schema("CopilotToolCall").properties.result["x-sensitive"], true);
  assert.equal(schema("ConfigSyncBundleResponse")["x-sensitive"], true);
  assert.equal(schema("ConfigSyncProviderConnection")["x-sensitive"], true);
  assert.equal(schema("ConfigSyncApiKey").properties.key["x-sensitive"], true);
  assert.equal(schema("SyncTokenCreateResponse")["x-sensitive"], true);
  assert.equal(schema("SyncTokenCreateResponse").properties.token["x-sensitive"], true);

  const bundle = operation("/api/sync/bundle", "get");
  assert.deepEqual(bundle.security, [{ SyncTokenHeaderAuth: [] }, { SyncTokenBearerAuth: [] }]);
  assert.equal(bundle.responses["304"].content, undefined);
  assert.equal(bundle.responses["200"].headers["Cache-Control"].schema.const, "private, no-store");
  assert.equal(bundle.responses["304"].headers["Cache-Control"].schema.const, "private, no-store");
  assert.equal(operation("/api/sync/tokens", "post").responses["201"].content["application/json"].schema.$ref,
    "#/components/schemas/SyncTokenCreateResponse");
});

test("the public OpenAPI mirror remains byte-identical to the canonical contract", () => {
  assert.equal(publicText, canonicalText);
});
