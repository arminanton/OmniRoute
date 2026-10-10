import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

type Schema = {
  $ref?: string;
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  pattern?: string;
  format?: string;
  description?: string;
  required?: string[];
  properties?: Record<string, Schema>;
  oneOf?: Schema[];
  additionalProperties?: Schema | boolean;
};

type Response = {
  $ref?: string;
  description?: string;
  headers?: Record<string, { schema?: Schema }>;
  content?: Record<string, { schema?: Schema }>;
};

type Operation = {
  security?: Array<Record<string, string[]>>;
  parameters?: Array<{ $ref?: string; name?: string; in?: string; required?: boolean }>;
  requestBody?: { required?: boolean; content?: Record<string, { schema?: Schema }> };
  responses?: Record<string, Response>;
  "x-local-only"?: boolean;
  "x-always-protected"?: boolean;
};

const spec = yaml.load(fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8")) as {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, Schema> };
};

const providersId = "/api/providers/{id}";
const providersIdPath = path.join(process.cwd(), "src/app/api/providers/[id]");
const readHandler = (relativePath: string) =>
  fs.readFileSync(path.join(providersIdPath, relativePath), "utf8");

function jsonSchema(operation: Operation | undefined, status: string) {
  return operation?.responses?.[status]?.content?.["application/json"]?.schema;
}

function hasAnonymousAlternative(operation: Operation | undefined) {
  return operation?.security?.some((requirement) => Object.keys(requirement).length === 0) ?? false;
}

test("provider login documents the local-only gate and provider-specific request/result contract", () => {
  const operation = spec.paths[`${providersId}/login`]?.post;
  assert.ok(operation);
  assert.equal(operation["x-local-only"], true);
  assert.equal(
    hasAnonymousAlternative(operation),
    true,
    "management auth is conditional by deployment policy"
  );
  assert.equal(
    operation.security?.some((requirement) => "BearerAuth" in requirement),
    true
  );
  assert.equal(
    operation.parameters?.some(
      (parameter) => parameter.$ref === "#/components/parameters/ResourceId"
    ),
    true
  );
  assert.equal(
    operation.requestBody?.required,
    false,
    "the handler defaults absent/malformed JSON to an empty object"
  );
  assert.equal(
    operation.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ProviderLoginRequest"
  );
  assert.equal(
    jsonSchema(operation, "200")?.$ref,
    "#/components/schemas/ProviderLoginSuccessResponse"
  );
  for (const status of ["400", "401", "403", "404", "500", "503"]) {
    assert.ok(operation.responses?.[status], `login documents HTTP ${status}`);
  }
  assert.equal(spec.components.schemas.ProviderLoginRequest.properties?.code.pattern, "^[0-9]{6}$");
  assert.deepEqual(spec.components.schemas.ProviderLoginRequest.properties?.step.enum, [
    "request",
    "verify",
  ]);
  assert.equal(
    spec.components.schemas.ProviderLoginSuccessResponse.properties?.success.const,
    true
  );

  const route = readHandler("login/route.ts");
  const routeGuard = fs.readFileSync(
    path.join(process.cwd(), "src/server/authz/routeGuard.ts"),
    "utf8"
  );
  const maxAiFlow = fs.readFileSync(
    path.join(process.cwd(), "open-sse/executors/maxai/emailLogin.ts"),
    "utf8"
  );
  assert.match(route, /requireManagementAuth\(req\)/);
  assert.match(route, /req\.json\(\)\.catch\(\(\) => \(\{\}\)\)/);
  assert.match(route, /status: 404/);
  assert.match(route, /status: result\.success \? 200 : 400/);
  assert.equal(
    routeGuard.split("\n").some((line) => line.startsWith("  /^") && line.includes("\\/login")),
    true,
    "route guard has a parameter-aware local-only rule for provider login"
  );
  assert.match(maxAiFlow, /step: z\.enum\(\["request", "verify"\]\)\.default\("request"\)/);
  assert.match(maxAiFlow, /codeSchema[\s\S]*\.length\(6\)[\s\S]*\[0-9\]/);
});

test("generic OAuth refresh documents rotating-token skips and handler error statuses", () => {
  const operation = spec.paths[`${providersId}/refresh`]?.post;
  assert.ok(operation);
  assert.equal(hasAnonymousAlternative(operation), true);
  assert.equal(
    jsonSchema(operation, "200")?.$ref,
    "#/components/schemas/ProviderTokenRefreshSuccessResponse"
  );
  assert.equal(
    spec.components.schemas.ProviderTokenRefreshSuccessResponse.properties?.skipped.type,
    "boolean"
  );
  for (const status of ["400", "401", "403", "404", "409", "422", "500", "502", "503"]) {
    assert.ok(operation.responses?.[status], `refresh documents HTTP ${status}`);
  }

  const route = readHandler("refresh/route.ts");
  const routeGuard = fs.readFileSync(
    path.join(process.cwd(), "src/server/authz/routeGuard.ts"),
    "utf8"
  );
  assert.match(route, /authType !== "oauth"/);
  assert.match(route, /rotationGroup === "openai-auth0"/);
  assert.match(route, /skipped: true/);
  for (const status of [400, 401, 409, 422, 502, 500]) {
    assert.match(route, new RegExp(`status: ${status}`), `handler contains HTTP ${status} branch`);
  }
  assert.ok(
    routeGuard.includes("including the generic `/refresh` route, intentionally stays"),
    "generic OAuth refresh stays remotely reachable"
  );
});

test("Cursor refresh documents its local-only gate, cooldown header, and result variants", () => {
  const operation = spec.paths[`${providersId}/refresh-cursor`]?.post;
  assert.ok(operation);
  assert.equal(operation["x-local-only"], true);
  assert.equal(hasAnonymousAlternative(operation), true);
  assert.equal(
    jsonSchema(operation, "200")?.$ref,
    "#/components/schemas/ProviderCursorRefreshSuccessResponse"
  );
  assert.equal(
    jsonSchema(operation, "429")?.$ref,
    "#/components/schemas/ProviderCursorRefreshCooldownResponse"
  );
  assert.equal(operation.responses?.["429"]?.headers?.["Retry-After"]?.schema?.type, "integer");
  for (const status of ["400", "401", "403", "404", "429", "500", "502", "503"]) {
    assert.ok(operation.responses?.[status], `Cursor refresh documents HTTP ${status}`);
  }

  const route = readHandler("refresh-cursor/route.ts");
  const routeGuard = fs.readFileSync(
    path.join(process.cwd(), "src/server/authz/routeGuard.ts"),
    "utf8"
  );
  assert.match(route, /MANUAL_REFRESH_COOLDOWN_MS = 30_000/);
  assert.match(route, /status: 429/);
  assert.match(route, /"Retry-After"/);
  assert.match(route, /case "renewed"/);
  assert.match(route, /case "unchanged"/);
  assert.equal(
    routeGuard
      .split("\n")
      .some((line) => line.startsWith("  /^") && line.includes("\\/refresh-cursor")),
    true,
    "route guard has a parameter-aware local-only rule for Cursor refresh"
  );
});

test("legacy Kimi refresh documents the provider restriction and redacted success result", () => {
  const operation = spec.paths[`${providersId}/refresh-token`]?.post;
  assert.ok(operation);
  assert.equal(hasAnonymousAlternative(operation), true);
  assert.equal(
    jsonSchema(operation, "200")?.$ref,
    "#/components/schemas/KimiProviderTokenRefreshSuccessResponse"
  );
  assert.equal(
    operation.responses?.["400"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ProviderActionErrorResponse"
  );
  for (const status of ["400", "401", "403", "404", "500", "503"]) {
    assert.ok(operation.responses?.[status], `Kimi refresh documents HTTP ${status}`);
  }

  const route = readHandler("refresh-token/route.ts");
  assert.match(route, /requireManagementAuth\(req\)/);
  assert.match(route, /provider === "kimi-web" \|\| provider === "kimi_web"/);
  assert.match(route, /Token refreshed successfully/);
  assert.match(route, /userId: payload\?\.sub \|\| null/);
  assert.match(route, /status: 404/);
  assert.match(route, /status: 400/);
});

test("Claude CLI credential operations are always protected and expose only intended payloads", () => {
  const apply = spec.paths[`${providersId}/claude-auth/apply-local`]?.post;
  const exportCredentials = spec.paths[`${providersId}/claude-auth/export`]?.post;
  assert.ok(apply);
  assert.ok(exportCredentials);

  for (const operation of [apply, exportCredentials]) {
    assert.equal(operation["x-always-protected"], true);
    assert.equal(hasAnonymousAlternative(operation), false);
    assert.equal(
      operation.security?.some((requirement) => "ManagementSessionAuth" in requirement),
      true
    );
    assert.ok(
      operation.parameters?.some(
        (parameter) => parameter.$ref === "#/components/parameters/ResourceId"
      )
    );
    for (const status of ["400", "401", "403", "404", "409", "500", "502", "503"]) {
      assert.ok(
        operation.responses?.[status],
        `Claude credential operation documents HTTP ${status}`
      );
    }
  }

  assert.equal(jsonSchema(apply, "200")?.$ref, "#/components/schemas/ClaudeAuthApplyLocalResponse");
  assert.equal(apply.requestBody, undefined, "the apply route takes no JSON body");
  assert.equal(
    jsonSchema(exportCredentials, "200")?.$ref,
    "#/components/schemas/ClaudeAuthFilePayload"
  );
  assert.equal(
    exportCredentials.responses?.["200"]?.headers?.["Cache-Control"]?.schema?.const,
    "no-store, max-age=0"
  );
  assert.equal(
    spec.components.schemas.ClaudeAuthFilePayload.properties?.claudeAiOauth.required?.includes(
      "refreshToken"
    ),
    true
  );

  const applyRoute = readHandler("claude-auth/apply-local/route.ts");
  const exportRoute = readHandler("claude-auth/export/route.ts");
  const authFile = fs.readFileSync(
    path.join(process.cwd(), "src/lib/oauth/utils/claudeAuthFile.ts"),
    "utf8"
  );
  const routeGuard = fs.readFileSync(
    path.join(process.cwd(), "src/server/authz/routeGuard.ts"),
    "utf8"
  );
  assert.match(applyRoute, /requireManagementAuth\(request\)/);
  assert.match(applyRoute, /ensureCliConfigWriteAllowed\(\)/);
  assert.match(applyRoute, /mcpOAuthPreserved: result\.mcpOAuthPreserved/);
  assert.match(exportRoute, /requireManagementAuth\(_request\)/);
  assert.match(exportRoute, /"Cache-Control": "no-store, max-age=0"/);
  assert.match(exportRoute, /"X-Content-Type-Options": "nosniff"/);
  assert.match(
    authFile,
    /accessToken: string;[\s\S]*refreshToken: string;[\s\S]*expiresAt: number;[\s\S]*scopes: string\[\]/
  );
  assert.equal(
    routeGuard
      .split("\n")
      .some((line) => line.startsWith("  /^\\/api\\/providers") && line.includes("claude|codex")),
    true,
    "route guard has a dynamic-path always-protected rule for Claude/Codex credential operations"
  );
});
