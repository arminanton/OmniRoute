import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

const docsText = fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8");
const publicText = fs.readFileSync(path.join(process.cwd(), "public/openapi.yaml"), "utf8");
const spec = yaml.load(docsText) as {
  paths: Record<string, Record<string, any>>;
};

function operation(route: string, method: string): any {
  const value = spec.paths[route]?.[method];
  assert.ok(value, `missing ${method.toUpperCase()} ${route}`);
  return value;
}

function assertResponse(route: string, method: string, status: string, schema: string): void {
  assert.equal(
    operation(route, method).responses?.[status]?.content?.["application/json"]?.schema?.$ref,
    `#/components/schemas/${schema}`,
    `${method.toUpperCase()} ${route} ${status}`
  );
}

function assertSecurity(operationValue: any, expected: string[]): void {
  const names = (operationValue.security ?? []).flatMap((alternative: Record<string, unknown>) =>
    Object.keys(alternative)
  );
  for (const scheme of expected) assert.ok(names.includes(scheme), `${scheme} is declared`);
  assert.ok(
    operationValue.security?.some(
      (alternative: Record<string, unknown>) => Object.keys(alternative).length === 0
    ),
    "unlocked management deployments retain the conditional anonymous alternative"
  );
}

test("memory route errors and management/legacy auth declarations match handlers", () => {
  const managementSchemes = [
    "BearerAuth",
    "ManagementSessionAuth",
    "LocalCliTokenAuth",
    "InternalServiceTokenAuth",
    "ManagementGoogleApiKeyAuth",
    "ManagementAnthropicApiKeyAuth",
  ];
  for (const [route, method] of [
    ["/api/memory", "get"],
    ["/api/memory", "post"],
    ["/api/memory/{id}", "get"],
    ["/api/memory/{id}", "put"],
    ["/api/memory/{id}", "delete"],
    ["/api/memory/health", "get"],
    ["/api/memory/reindex", "post"],
    ["/api/memory/retrieve-preview", "post"],
    ["/api/memory/summarize", "post"],
  ] as const) {
    const op = operation(route, method);
    assertSecurity(op, managementSchemes);
    assert.equal(
      op.responses?.["401"]?.$ref,
      "#/components/responses/ManagementAuthenticationRequired"
    );
    assert.equal(op.responses?.["403"]?.$ref, "#/components/responses/ManagementInvalidToken");
    assert.equal(op.responses?.["503"]?.$ref, "#/components/responses/ManagementAuthUnavailable");
  }

  for (const route of ["/api/memory/embedding-providers", "/api/memory/engine-status"]) {
    const op = operation(route, "get");
    assertSecurity(op, ["BearerAuth", "ManagementSessionAuth"]);
    assert.equal(op.responses?.["401"]?.$ref, "#/components/responses/Unauthorized");
    assertResponse(route, "get", "500", "ApiErrorResponse");
  }

  for (const [route, method, status, schema] of [
    ["/api/memory", "get", "500", "ApiErrorResponse"],
    ["/api/memory", "post", "400", "MemoryErrorResponse"],
    ["/api/memory", "post", "413", "ApiErrorResponse"],
    ["/api/memory/{id}", "get", "404", "MemoryErrorResponse"],
    ["/api/memory/{id}", "get", "500", "ApiErrorResponse"],
    ["/api/memory/{id}", "put", "400", "MemoryErrorResponse"],
    ["/api/memory/{id}", "put", "404", "MemoryErrorResponse"],
    ["/api/memory/{id}", "put", "413", "ApiErrorResponse"],
    ["/api/memory/{id}", "put", "500", "ApiErrorResponse"],
    ["/api/memory/{id}", "delete", "404", "MemoryErrorResponse"],
    ["/api/memory/{id}", "delete", "413", "ApiErrorResponse"],
    ["/api/memory/{id}", "delete", "500", "ApiErrorResponse"],
    ["/api/memory/health", "get", "500", "MemoryHealthResponse"],
    ["/api/memory/reindex", "post", "400", "MemoryErrorResponse"],
    ["/api/memory/reindex", "post", "413", "ApiErrorResponse"],
    ["/api/memory/reindex", "post", "500", "ApiErrorResponse"],
    ["/api/memory/retrieve-preview", "post", "400", "MemoryErrorResponse"],
    ["/api/memory/retrieve-preview", "post", "413", "ApiErrorResponse"],
    ["/api/memory/retrieve-preview", "post", "500", "ApiErrorResponse"],
    ["/api/memory/summarize", "post", "400", "MemoryErrorResponse"],
    ["/api/memory/summarize", "post", "413", "ApiErrorResponse"],
    ["/api/memory/summarize", "post", "500", "ApiErrorResponse"],
  ] as const) {
    assertResponse(route, method, status, schema);
  }
});

test("API-key management and remote CLI bootstrap describe actual auth and error envelopes", () => {
  const managementSchemes = [
    "BearerAuth",
    "ManagementSessionAuth",
    "LocalCliTokenAuth",
    "InternalServiceTokenAuth",
    "ManagementGoogleApiKeyAuth",
    "ManagementAnthropicApiKeyAuth",
  ];
  for (const method of ["get", "post"]) {
    const op = operation("/api/keys", method);
    assertSecurity(op, managementSchemes);
    assert.match(op.description ?? "", /requireLogin=false/);
  }
  assertResponse("/api/keys", "get", "500", "StringErrorResponse");
  assertResponse("/api/keys", "post", "400", "ValidationErrorResponse");
  assertResponse("/api/keys", "post", "413", "ApiErrorResponse");
  assertResponse("/api/keys", "post", "500", "StringErrorResponse");

  const connect = operation("/api/cli/connect", "post");
  assert.deepEqual(connect.security, []);
  assert.deepEqual(
    connect.responses["400"].content["application/json"].schema.oneOf.map(
      (branch: Record<string, string>) => branch.$ref
    ),
    ["#/components/schemas/StringErrorResponse", "#/components/schemas/ValidationErrorResponse"]
  );
  assertResponse("/api/cli/connect", "post", "401", "StringErrorResponse");
  assertResponse("/api/cli/connect", "post", "403", "CliConnectNeedsSetupResponse");
  assertResponse("/api/cli/connect", "post", "413", "ApiErrorResponse");
  assertResponse("/api/cli/connect", "post", "429", "StringErrorResponse");
  assert.equal(connect.responses["429"].headers["Retry-After"].schema.type, "string");
  assertResponse("/api/cli/connect", "post", "500", "StringErrorResponse");
  assert.equal(publicText, docsText, "public OpenAPI artifact mirrors the canonical document");
});

test("model-list and alias routes document source errors and body-limit rejection", () => {
  assertResponse("/api/models", "get", "500", "StringErrorResponse");
  assertResponse("/api/models", "put", "413", "ApiErrorResponse");
  assertResponse("/api/models", "put", "500", "StringErrorResponse");
  assertResponse("/api/models/alias", "get", "400", "ApiErrorResponse");
  assertResponse("/api/models/alias", "get", "404", "ApiErrorResponse");
  assertResponse("/api/models/alias", "get", "409", "ApiErrorResponse");
  assertResponse("/api/models/alias", "get", "500", "ApiErrorResponse");
  assertResponse("/api/models/alias", "put", "413", "ApiErrorResponse");
  assertResponse("/api/models/alias", "put", "500", "ApiErrorResponse");
  assertResponse("/api/models/alias", "delete", "413", "ApiErrorResponse");
  assertResponse("/api/models/alias", "delete", "500", "ApiErrorResponse");
  assertResponse("/api/models/catalog", "get", "500", "ApiErrorResponse");
});

test("OAuth import and Cursor login handlers document their error status families", () => {
  const oauthErrors: Array<[string, string, string]> = [
    ["/api/oauth/cliproxy-import", "get", "500"],
    ["/api/oauth/cliproxy-import", "post", "500"],
    ["/api/oauth/codex/import", "post", "400"],
    ["/api/oauth/codex/import-token", "post", "500"],
    ["/api/oauth/cursor/auto-import", "get", "500"],
    ["/api/oauth/cursor/import", "post", "400"],
    ["/api/oauth/cursor/import", "post", "500"],
    ["/api/oauth/cursor/login/cancel", "post", "400"],
    ["/api/oauth/cursor/login/poll", "post", "400"],
    ["/api/oauth/cursor/login/poll", "post", "410"],
    ["/api/oauth/cursor/login/poll", "post", "500"],
    ["/api/oauth/cursor/login/start", "post", "500"],
    ["/api/oauth/kiro/api-key", "post", "400"],
    ["/api/oauth/kiro/auto-import", "get", "500"],
    ["/api/oauth/kiro/import", "post", "400"],
    ["/api/oauth/kiro/import", "post", "500"],
    ["/api/oauth/trae/import", "post", "400"],
    ["/api/oauth/trae/import", "post", "500"],
  ];
  for (const [route, method, status] of oauthErrors) {
    assertResponse(route, method, status, "OAuthOperationErrorResponse");
  }

  const bodyBearing = new Set([
    "/api/oauth/cliproxy-import post",
    "/api/oauth/codex/import post",
    "/api/oauth/codex/import-token post",
    "/api/oauth/cursor/import post",
    "/api/oauth/cursor/login/cancel post",
    "/api/oauth/cursor/login/poll post",
    "/api/oauth/cursor/login/start post",
    "/api/oauth/kiro/api-key post",
    "/api/oauth/kiro/import post",
    "/api/oauth/trae/import post",
  ]);
  for (const key of bodyBearing) {
    const [route, method] = key.split(" ");
    assertResponse(route, method, "413", "ApiErrorResponse");
  }
  assertResponse("/api/oauth/cursor/login/poll", "post", "4XX", "OAuthOperationErrorResponse");
  assertResponse("/api/oauth/cursor/login/poll", "post", "5XX", "OAuthOperationErrorResponse");
  assert.equal(publicText, docsText, "public OpenAPI artifact mirrors the canonical document");
});
