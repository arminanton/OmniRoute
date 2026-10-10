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

function source(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function schema(name: string): any {
  const value = spec.components.schemas[name];
  assert.ok(value, `components.schemas.${name} must exist`);
  return value;
}

function resolve(schemaOrRef: any): any {
  if (typeof schemaOrRef?.$ref !== "string") return schemaOrRef;
  const prefix = "#/components/schemas/";
  assert.ok(schemaOrRef.$ref.startsWith(prefix), `unexpected ref ${schemaOrRef.$ref}`);
  return schema(schemaOrRef.$ref.slice(prefix.length));
}

function assertRequired(value: any, keys: string[], label: string): void {
  assert.deepEqual([...(value.required ?? [])].sort(), [...keys].sort(), `${label} required keys`);
}

const JSON_SUCCESS_RESPONSES = [
  ["/api/services/9router/models", "get", "ServiceModelsResponse"],
  ["/api/services/bifrost/start", "post", "ServiceSupervisorStatus"],
  ["/api/services/bifrost/restart", "post", "ServiceSupervisorStatus"],
  ["/api/services/bifrost/status", "get", "BifrostStatusResponse"],
  ["/api/services/bifrost/stop", "post", "BifrostStopResponse"],
  ["/api/services/bifrost/update", "post", "BifrostUpdateResponse"],
  ["/api/services/cliproxy/accounts", "get", "CliproxyAccountHealthResult"],
] as const;

const NO_CONTENT_RESPONSES = [
  "/api/services/9router/provider-expose",
  "/api/services/cliproxy/provider-expose",
] as const;

test("service success statuses and media types match the source handlers", () => {
  for (const [pathname, method, component] of JSON_SUCCESS_RESPONSES) {
    const operation = spec.paths[pathname]?.[method];
    assert.ok(operation, `${method.toUpperCase()} ${pathname} must be documented`);
    assert.equal(operation["x-local-only"], true, `${pathname} must preserve LOCAL_ONLY`);
    assert.equal(
      operation.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
      `#/components/schemas/${component}`,
      `${method.toUpperCase()} ${pathname} success response`
    );
  }

  for (const pathname of NO_CONTENT_RESPONSES) {
    const operation = spec.paths[pathname]?.post;
    assert.ok(operation, `POST ${pathname} must be documented`);
    assert.equal(operation["x-local-only"], true, `${pathname} must preserve LOCAL_ONLY`);
    assert.ok(operation.responses?.["204"], `${pathname} must document its actual 204 response`);
    assert.equal(operation.responses["204"].content, undefined, `${pathname} is bodyless on success`);
    assert.equal(operation.responses?.["200"], undefined, `${pathname} must not claim a 200`);
  }

  for (const route of [
    "src/app/api/services/9router/provider-expose/route.ts",
    "src/app/api/services/cliproxy/provider-expose/route.ts",
  ]) {
    assert.match(source(route), /new Response\(null,\s*\{\s*status:\s*204\s*\}\)/);
  }

  const modelsRoute = source("src/app/api/services/9router/models/route.ts");
  assert.match(modelsRoute, /return Response\.json\(\{ data: models \}\)/);
  for (const route of [
    "src/app/api/services/9router/provider-expose/route.ts",
    "src/app/api/services/cliproxy/provider-expose/route.ts",
  ]) {
    assert.match(source(route), /new Response\(null,\s*\{\s*status:\s*204\s*\}\)/);
  }
});

test("9Router model schema permits upstream fields and matches the persisted model source", () => {
  const response = schema("ServiceModelsResponse");
  assertRequired(response, ["data"], "model list response");
  assert.equal(response.properties?.data?.type, "array");

  const model = resolve(response.properties?.data?.items);
  assertRequired(model, ["id"], "service model");
  assert.equal(model.properties?.id?.type, "string");
  assert.equal(
    model.additionalProperties,
    true,
    "model sync spreads upstream rows and ServiceModel preserves unknown properties"
  );

  const typeSource = source("src/lib/db/serviceModels.ts");
  assert.match(typeSource, /id:\s*string/);
  assert.match(typeSource, /\[key:\s*string\]:\s*unknown/);
  assert.match(source("src/lib/services/modelSync.ts"), /\.\.\.m/);
});

test("Bifrost status and lifecycle schemas match supervisor and update outcomes", () => {
  const supervisorStatus = schema("ServiceSupervisorStatus");
  assertRequired(
    supervisorStatus,
    ["tool", "state", "pid", "port", "health", "startedAt", "lastError", "adopted"],
    "supervisor status"
  );
  assert.equal(supervisorStatus.properties?.tool?.const, "bifrost");
  assert.deepEqual(supervisorStatus.properties?.state?.enum, [
    "not_installed",
    "stopped",
    "starting",
    "running",
    "stopping",
    "error",
  ]);
  assert.deepEqual(supervisorStatus.properties?.health?.enum, ["healthy", "unhealthy", "unknown"]);
  assert.deepEqual(supervisorStatus.properties?.pid?.type, ["integer", "null"]);
  assert.deepEqual(supervisorStatus.properties?.startedAt?.type, ["string", "null"]);
  assert.deepEqual(supervisorStatus.properties?.lastError?.type, ["string", "null"]);

  const status = schema("BifrostStatusResponse");
  assertRequired(
    status,
    [
      "tool",
      "state",
      "pid",
      "port",
      "health",
      "startedAt",
      "lastError",
      "installedVersion",
      "latestVersion",
      "updateAvailable",
      "autoStart",
      "adopted",
      "autoRestartAdopted",
    ],
    "status response"
  );
  assert.equal(status.properties?.tool?.const, "bifrost");
  assert.equal(status.properties?.state?.type, "string", "version-manager state is stored as a string");
  for (const field of ["pid", "lastError", "installedVersion", "latestVersion"]) {
    assert.ok(
      status.properties?.[field]?.type?.includes("null"),
      `${field} may be null before installation or while stopped`
    );
  }
  for (const secret of ["apiKey", "managementKey"]) {
    assert.equal(status.properties?.[secret], undefined, `status response must not expose ${secret}`);
  }

  const stop = schema("BifrostStopResponse");
  assert.deepEqual(
    stop.oneOf?.map((variant: any) => variant.$ref).sort(),
    [
      "#/components/schemas/BifrostStoppedResponse",
      "#/components/schemas/ServiceSupervisorStatus",
    ]
  );
  assert.equal(schema("BifrostStoppedResponse").properties?.state?.const, "stopped");

  const update = schema("BifrostUpdateResponse");
  const updateCases = new Map<string, any>(
    update.oneOf.map((variant: any): [string, any] => [
      String(variant.properties.updated.const),
      variant,
    ])
  );
  assert.deepEqual([...updateCases.keys()].sort(), ["false", "true"]);
  assertRequired(
    updateCases.get("false"),
    ["updated", "installedVersion", "latestVersion"],
    "up-to-date result"
  );
  assertRequired(
    updateCases.get("true"),
    ["updated", "oldVersion", "newVersion"],
    "updated result"
  );
  assert.deepEqual(updateCases.get("true").properties.oldVersion.type, ["string", "null"]);

  const supervisorType = source("src/lib/services/types.ts");
  for (const field of ["tool", "state", "pid", "port", "health", "startedAt", "lastError", "adopted"]) {
    assert.match(supervisorType, new RegExp(`\\b${field}\\??:`));
  }
  for (const route of [
    "src/app/api/services/bifrost/start/route.ts",
    "src/app/api/services/bifrost/restart/route.ts",
    "src/app/api/services/bifrost/stop/route.ts",
  ]) {
    assert.match(source(route), /Response\.json\(status\)/);
  }
  const statusSource = source("src/app/api/services/bifrost/status/route.ts");
  for (const field of [
    "tool",
    "state",
    "pid",
    "port",
    "health",
    "startedAt",
    "lastError",
    "installedVersion",
    "latestVersion",
    "updateAvailable",
    "autoStart",
    "adopted",
    "autoRestartAdopted",
  ]) {
    assert.match(statusSource, new RegExp(`\\b${field}(?::|,)`));
  }
  const updateSource = source("src/app/api/services/bifrost/update/route.ts");
  assert.match(updateSource, /updated:\s*false/);
  assert.match(updateSource, /updated:\s*true/);
});

test("Cliproxy account health is no-store and contains only the sanitized field projection", () => {
  const result = schema("CliproxyAccountHealthResult");
  assertRequired(result, ["state", "accounts", "version"], "account health result");
  assert.deepEqual(result.properties?.state?.enum, [
    "ready",
    "disabled",
    "missing_key",
    "unreachable",
    "unauthorized",
    "unsupported",
    "invalid_response",
  ]);
  assert.deepEqual(result.properties?.version?.type, ["string", "null"]);
  assert.equal(result["x-sensitive"], true);

  const account = resolve(result.properties?.accounts?.items);
  assertRequired(
    account,
    [
      "authIndex",
      "provider",
      "type",
      "label",
      "status",
      "disabled",
      "unavailable",
      "createdAt",
      "updatedAt",
      "success",
      "failed",
      "recentRequests",
    ],
    "account summary"
  );
  for (const secret of ["apiKey", "managementKey", "token", "accessToken", "refreshToken", "auth"]) {
    assert.equal(account.properties?.[secret], undefined, `account response omits ${secret}`);
  }
  assert.deepEqual(account.properties?.createdAt?.type, ["string", "null"]);
  assert.deepEqual(account.properties?.updatedAt?.type, ["string", "null"]);
  const recent = resolve(account.properties?.recentRequests?.items);
  assertRequired(recent, ["time", "success", "failed"], "recent request bucket");
  assert.equal(account.properties?.recentRequests?.maxItems, 20);

  const route = source("src/app/api/services/cliproxy/accounts/route.ts");
  assert.match(route, /requireManagementAuth\(request\)/);
  assert.match(route, /Cache-Control.*no-store/);
  const sanitizer = source("src/lib/services/cliproxyAccountHealth.ts");
  assert.match(sanitizer, /authIndex:\s*string\(file\.auth_index\)/);
  assert.match(sanitizer, /recentRequests:\s*sanitizeRecentRequests/);
});
