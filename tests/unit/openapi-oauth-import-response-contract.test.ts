import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

const ROOT = process.cwd();
const spec = yaml.load(fs.readFileSync(path.join(ROOT, "docs/openapi.yaml"), "utf8")) as {
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, any> };
};
const publicSpec = yaml.load(fs.readFileSync(path.join(ROOT, "public/openapi.yaml"), "utf8"));

const successResponses: Array<{ path: string; method: "get" | "post"; schema: string }> = [
  {
    path: "/api/oauth/cliproxy-import",
    method: "get",
    schema: "CliProxyOAuthImportPreviewResponse",
  },
  {
    path: "/api/oauth/cliproxy-import",
    method: "post",
    schema: "CliProxyOAuthImportResponse",
  },
  { path: "/api/oauth/codex/import", method: "post", schema: "CodexOAuthBulkImportResponse" },
  {
    path: "/api/oauth/codex/import-token",
    method: "post",
    schema: "OAuthSingleConnectionImportResponse",
  },
  { path: "/api/oauth/cursor/auto-import", method: "get", schema: "CursorAutoImportResponse" },
  { path: "/api/oauth/cursor/import", method: "get", schema: "OAuthImportGuideResponse" },
  {
    path: "/api/oauth/cursor/import",
    method: "post",
    schema: "OAuthSingleConnectionImportResponse",
  },
  { path: "/api/oauth/cursor/login/start", method: "post", schema: "CursorLoginStartResponse" },
  { path: "/api/oauth/cursor/login/poll", method: "post", schema: "CursorLoginPollResponse" },
  { path: "/api/oauth/cursor/login/cancel", method: "post", schema: "CursorLoginCancelResponse" },
  {
    path: "/api/oauth/kiro/api-key",
    method: "post",
    schema: "OAuthSingleConnectionImportResponse",
  },
  { path: "/api/oauth/kiro/auto-import", method: "get", schema: "KiroAutoImportResponse" },
  {
    path: "/api/oauth/kiro/import",
    method: "post",
    schema: "OAuthSingleConnectionImportResponse",
  },
  { path: "/api/oauth/trae/import", method: "get", schema: "OAuthImportGuideResponse" },
  {
    path: "/api/oauth/trae/import",
    method: "post",
    schema: "OAuthSingleConnectionImportResponse",
  },
];

function schema(name: string): any {
  const value = spec.components.schemas[name];
  assert.ok(value, `components.schemas.${name} must exist`);
  return value;
}

function assertRequired(value: any, keys: string[], label: string): void {
  assert.deepEqual([...(value.required ?? [])].sort(), [...keys].sort(), `${label} required keys`);
}

test("OAuth credential-import and login operations declare their actual JSON 200 contracts", () => {
  assert.equal(successResponses.length, 15);

  for (const entry of successResponses) {
    const operation = spec.paths[entry.path]?.[entry.method];
    assert.ok(operation, `${entry.method.toUpperCase()} ${entry.path} must be documented`);
    const response = operation.responses?.["200"];
    assert.ok(response, `${entry.method.toUpperCase()} ${entry.path} must document HTTP 200`);
    assert.equal(
      response.content?.["application/json"]?.schema?.$ref,
      `#/components/schemas/${entry.schema}`,
      `${entry.method.toUpperCase()} ${entry.path} must reference its source-backed response schema`
    );
    assert.ok(
      operation.security?.some(
        (requirement: Record<string, unknown>) => "BearerAuth" in requirement
      ),
      `${entry.method.toUpperCase()} ${entry.path} must preserve management Bearer security`
    );
    assert.ok(
      operation.security?.some(
        (requirement: Record<string, unknown>) => "ManagementSessionAuth" in requirement
      ),
      `${entry.method.toUpperCase()} ${entry.path} must preserve dashboard session security`
    );
    assert.ok(
      operation.security?.some(
        (requirement: Record<string, unknown>) => Object.keys(requirement).length === 0
      ),
      `${entry.method.toUpperCase()} ${entry.path} must preserve the requireLogin=false alternative`
    );
  }

  assert.deepEqual(publicSpec, spec, "public OpenAPI artifact must mirror the canonical document");
  assert.equal(spec.paths["/api/oauth/cursor/auto-import"].get["x-local-only"], true);
  assert.equal(spec.paths["/api/oauth/kiro/auto-import"].get["x-local-only"], true);
});

test("OAuth import schemas model summaries, partial results, nullable metadata, and credential-bearing variants", () => {
  const connection = schema("OAuthImportedConnectionSummary");
  assertRequired(connection, ["id", "provider"], "imported connection summary");
  assert.deepEqual(connection.properties.email.type, ["string", "null"]);
  assert.deepEqual(connection.properties.name.type, ["string", "null"]);
  for (const secret of ["apiKey", "accessToken", "refreshToken", "idToken"]) {
    assert.equal(
      connection.properties[secret],
      undefined,
      `${secret} must not appear in summaries`
    );
  }

  const singleImport = schema("OAuthSingleConnectionImportResponse");
  assertRequired(singleImport, ["success", "connection"], "single import response");
  assert.equal(singleImport.properties.success.const, true);

  const preview = schema("CliProxyOAuthImportPreviewResponse");
  assert.equal(preview["x-sensitive"], true);
  assertRequired(preview, ["dir", "scanned", "skipped", "accounts"], "CLIProxy preview");
  assert.deepEqual(schema("CliProxyOAuthImportPreviewAccount").properties.email.type, [
    "string",
    "null",
  ]);
  const cliProxyImport = schema("CliProxyOAuthImportResponse");
  assertRequired(cliProxyImport, ["scanned", "skipped", "imported", "results"], "CLIProxy import");
  assert.equal(cliProxyImport.properties.success, undefined);
  assert.equal(schema("CliProxyOAuthImportResult").properties.ok.type, "boolean");

  const codexBulk = schema("CodexOAuthBulkImportResponse");
  assertRequired(
    codexBulk,
    ["success", "imported", "failed", "total", "results"],
    "Codex bulk import"
  );
  assert.equal(codexBulk.properties.success.type, "boolean");
  assert.equal(codexBulk.properties.results.items.oneOf.length, 2);
  assert.equal(schema("CodexOAuthImportSuccessResult").properties.ok.const, true);
  assert.equal(schema("CodexOAuthImportFailureResult").properties.ok.const, false);

  const cursorAuto = schema("CursorAutoImportResponse");
  assert.equal(cursorAuto["x-sensitive"], true);
  assert.equal(cursorAuto.oneOf.length, 3);
  assert.equal(
    spec.paths["/api/oauth/cursor/auto-import"].get.responses["200"].headers["Cache-Control"].schema
      .enum[0],
    "no-store"
  );
  assert.deepEqual(schema("CursorAutoImportNotFoundResponse").properties.found.const, false);

  const guide = schema("OAuthImportGuideResponse");
  assertRequired(guide, ["provider", "method", "instructions", "requiredFields"], "import guide");
  assert.deepEqual(schema("OAuthImportGuideField").required, [
    "name",
    "label",
    "description",
    "type",
  ]);
  assert.equal(schema("OAuthImportGuideField").properties.required.type, "boolean");

  assertRequired(
    schema("CursorLoginStartResponse"),
    ["success", "sessionId", "loginUrl", "expiresInSeconds"],
    "Cursor login start"
  );
  assert.equal(schema("CursorLoginStartResponse").properties.expiresInSeconds.const, 900);
  assert.equal(schema("CursorLoginPollPendingResponse").properties.status.const, "pending");
  assert.equal(schema("CursorLoginPollCompleteResponse").properties.status.const, "ok");
  assertRequired(
    schema("CursorLoginCancelResponse"),
    ["success", "cancelled"],
    "Cursor login cancellation"
  );

  const kiroAuto = schema("KiroAutoImportResponse");
  assert.equal(kiroAuto["x-sensitive"], true);
  assert.equal(kiroAuto.oneOf.length, 2);
  assertRequired(
    schema("KiroAutoImportFoundResponse"),
    ["found", "source", "email", "profileArn", "region", "message"],
    "Kiro auto-import found"
  );
  assert.deepEqual(schema("KiroAutoImportFoundResponse").properties.profileArn.type, [
    "string",
    "null",
  ]);
  assert.equal(schema("KiroAutoImportNotFoundResponse").properties.triedPaths.type, "array");
});
