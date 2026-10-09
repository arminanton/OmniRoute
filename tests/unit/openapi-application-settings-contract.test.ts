import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import { inferRequiredScope } from "../../src/server/authz/accessScopes.ts";

const ROOT = process.cwd();
const spec = yaml.load(fs.readFileSync(path.join(ROOT, "docs/openapi.yaml"), "utf8")) as {
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, any> };
};
const routeSource = fs.readFileSync(path.join(ROOT, "src/app/api/settings/route.ts"), "utf8");
const settingsSource = fs.readFileSync(path.join(ROOT, "src/lib/db/settings.ts"), "utf8");
const updateSchemaSource = fs.readFileSync(
  path.join(ROOT, "src/shared/validation/settingsSchemas.ts"),
  "utf8"
);
const managementAuthSource = fs.readFileSync(
  path.join(ROOT, "src/lib/api/requireManagementAuth.ts"),
  "utf8"
);
const apiAuthSource = fs.readFileSync(path.join(ROOT, "src/shared/utils/apiAuth.ts"), "utf8");
const apiKeyAuthSource = fs.readFileSync(path.join(ROOT, "src/sse/services/auth.ts"), "utf8");
const managementScopesSource = fs.readFileSync(
  path.join(ROOT, "src/shared/constants/managementScopes.ts"),
  "utf8"
);

function operation(method: string) {
  const result = spec.paths["/api/settings"]?.[method];
  assert.ok(result, `missing ${method.toUpperCase()} /api/settings`);
  return result;
}

function successSchema(method: string) {
  const response = operation(method).responses?.["200"];
  const schema = response?.content?.["application/json"]?.schema;
  assert.ok(schema, `missing ${method.toUpperCase()} /api/settings 200 JSON schema`);
  return { response, schema };
}

function section(source: string, start: string, end: string) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `source is missing ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `source is missing ${end}`);
  return source.slice(startIndex, endIndex);
}

test("application settings responses describe source-backed fields, redaction, and headers", () => {
  const get = successSchema("get");
  assert.equal(get.schema.$ref, "#/components/schemas/ApplicationSettingsReadResponse");
  assert.equal(get.response["x-sensitive"], true);
  assert.deepEqual(get.response.headers?.ETag?.schema, {
    type: "string",
    pattern: "^(0|[1-9][0-9]*)$",
  });
  assert.equal(get.response.headers?.["Cache-Control"]?.schema?.const, "no-store");

  const read = spec.components.schemas.ApplicationSettingsReadResponse;
  assert.equal(read["x-sensitive"], true);
  assert.deepEqual(read.allOf[0], {
    $ref: "#/components/schemas/ApplicationSettingsPersistedValues",
  });
  assert.deepEqual(read.allOf[1].required, [
    "settingsRevision",
    "hasPassword",
    "runtimePorts",
    "apiPort",
    "dashboardPort",
    "cloudConfigured",
    "cloudUrl",
    "machineId",
    "radarEnabled",
    "radarAdminUrl",
  ]);
  assert.deepEqual(Object.keys(read.allOf[1].properties).sort(), [
    "apiPort",
    "cliproxyapi_model_mapping",
    "cloudConfigured",
    "cloudUrl",
    "dashboardPort",
    "hasPassword",
    "machineId",
    "radarAdminUrl",
    "radarEnabled",
    "runtimePorts",
    "settingsRevision",
  ]);
  assert.equal(read.allOf[1].properties.settingsRevision.type, "integer");
  assert.equal(read.allOf[1].properties.hasPassword.type, "boolean");
  assert.equal(
    read.allOf[1].properties.runtimePorts.$ref,
    "#/components/schemas/ApplicationSettingsRuntimePorts"
  );
  assert.deepEqual(read.allOf[1].properties.cloudUrl.type, ["string", "null"]);
  assert.deepEqual(read.allOf[1].properties.radarAdminUrl.type, ["string", "null"]);

  const ports = spec.components.schemas.ApplicationSettingsRuntimePorts;
  assert.deepEqual(ports.required, [
    "port",
    "apiPort",
    "dashboardPort",
    "apiPortExplicit",
    "dashboardPortExplicit",
  ]);
  assert.equal(ports.properties.apiPortExplicit.type, "boolean");

  const routeGet = section(
    routeSource,
    "export async function GET(request: Request)",
    "export async function PATCH(request: Request)"
  );
  assert.match(routeGet, /const \{ password, \.\.\.safeSettings \} = settings;/);
  assert.match(routeGet, /hasPassword: hasManagementPasswordConfigured\(settings\)/);
  for (const field of [
    "settingsRevision",
    "hasPassword:",
    "runtimePorts",
    "apiPort:",
    "dashboardPort:",
    "cloudConfigured:",
    "cloudUrl,",
    "machineId,",
    "radarEnabled:",
    "radarAdminUrl:",
  ]) {
    assert.ok(routeGet.includes(field), `GET source is missing ${field}`);
  }
  assert.match(routeSource, /"Cache-Control": "no-store"/);
  assert.match(routeSource, /ETag: String\(settingsRevision\)/);
  assert.match(routeGet, /settingsResponseHeaders\(settingsRevision\)/);

  const settingsLoader = section(
    settingsSource,
    "export async function getSettings(",
    "/** Authoritative namespaces"
  );
  assert.match(settingsLoader, /key\.startsWith\("_"\)/);
  assert.match(settingsLoader, /settings\[key\] = JSON\.parse\(rawValue\)/);
  assert.match(settingsLoader, /oidcClientSecret: ""/);
  assert.match(settingsLoader, /settings\.oidcClientSecret = decrypt\(/);
  assert.match(settingsSource, /Object\.entries\(updates\)/);
  assert.match(settingsSource, /key === "oidcClientSecret" \? encrypt\(/);
  assert.match(updateSchemaSource, /oidcClientSecret: z\.string\(\)/);
  assert.match(updateSchemaSource, /skillsmpApiKey: z\.string\(\)/);
  assert.match(updateSchemaSource, /cliproxyapi_api_key: z\.string\(\)/);

  const persisted = spec.components.schemas.ApplicationSettingsPersistedValues;
  assert.equal(persisted["x-sensitive"], true);
  assert.deepEqual(persisted.required, ["oidcClientSecret"]);
  assert.equal(persisted.properties.password, undefined);
  assert.deepEqual(persisted.not.required, ["password"]);
  assert.equal(persisted.additionalProperties, true);
  for (const field of ["oidcClientSecret", "skillsmpApiKey", "cliproxyapi_api_key"]) {
    assert.equal(persisted.properties[field].type, "string");
    assert.equal(persisted.properties[field]["x-sensitive"], true);
  }
});

test("PATCH and PUT share the source handler and sensitive revision response", () => {
  const patch = successSchema("patch");
  const put = successSchema("put");
  assert.equal(patch.schema.$ref, "#/components/schemas/ApplicationSettingsUpdateResponse");
  assert.equal(put.schema.$ref, patch.schema.$ref);
  assert.equal(patch.response["x-sensitive"], true);
  assert.equal(put.response["x-sensitive"], true);
  assert.deepEqual(patch.response.headers, put.response.headers);

  const update = spec.components.schemas.ApplicationSettingsUpdateResponse;
  assert.equal(update["x-sensitive"], true);
  assert.deepEqual(update.allOf[0], {
    $ref: "#/components/schemas/ApplicationSettingsPersistedValues",
  });
  assert.deepEqual(update.allOf[1].required, ["settingsRevision"]);
  assert.equal(update.allOf[1].properties.settingsRevision.type, "integer");

  const patchSource = section(
    routeSource,
    "export async function PATCH(request: Request)",
    "export async function PUT(request: Request)"
  );
  assert.match(patchSource, /const \{ password, \.\.\.safeSettings \} = settings;/);
  assert.match(patchSource, /settingsRevision/);
  assert.match(patchSource, /settingsResponseHeaders\(settingsRevision\)/);
  assert.match(
    routeSource,
    /export async function PUT\(request: Request\)\s*\{\s*return PATCH\(request\);\s*\}/
  );
});

test("application settings document management-auth alternatives", () => {
  const expectedSecurity = [
    { BearerAuth: [] },
    { ManagementAnthropicApiKeyAuth: [] },
    { ManagementGoogleApiKeyAuth: [] },
    { ManagementSessionAuth: [] },
    { LocalCliTokenAuth: [] },
    { InternalServiceTokenAuth: [] },
    {},
  ];

  for (const method of ["get", "patch", "put"]) {
    const current = operation(method);
    assert.deepEqual(current.security, expectedSecurity, `${method.toUpperCase()} security`);
    assert.equal(
      current.responses?.["401"]?.$ref,
      "#/components/responses/ManagementAuthenticationRequired"
    );
    assert.equal(current.responses?.["403"]?.$ref, "#/components/responses/ManagementInvalidToken");
    assert.equal(
      current.responses?.["503"]?.$ref,
      "#/components/responses/ManagementAuthUnavailable"
    );

    const description = current.description ?? "";
    assert.match(description, /`manage`\/`admin` API key via Bearer/);
    assert.match(description, /Anthropic `x-api-key`/);
    assert.match(description, /`anthropic-version` header/);
    assert.match(description, /User-Agent matching `claude-code`, `claude-cli`, or `anthropic`/);
    assert.match(description, /Google `x-goog-api-key`/);
    assert.match(description, /loopback CLI token/);
    assert.match(description, /trusted loopback internal-service token/);
    assert.match(
      description,
      /Unlocked standalone installs with `requireLogin=false` may permit anonymous access/
    );
    assert.match(description, /fresh install may allow loopback bootstrap requests/);
    assert.match(description, /locked management still requires authentication/);
    assert.match(description, /URL credentials are not accepted/);
  }

  assert.match(operation("get").description, /`oma_live_` Access Token requires `read` scope/);
  assert.match(operation("patch").description, /`oma_live_` Access Token requires `write` scope/);
  assert.match(operation("put").description, /`oma_live_` Access Token requires `write` scope/);
  assert.equal(operation("patch").requestBody?.["x-sensitive"], true);
  assert.equal(operation("put").requestBody?.["x-sensitive"], true);

  assert.equal(inferRequiredScope("GET", "/api/settings"), "read");
  assert.equal(inferRequiredScope("PATCH", "/api/settings"), "write");
  assert.equal(inferRequiredScope("PUT", "/api/settings"), "write");
  assert.match(managementAuthSource, /hasManageScope\(meta\.scopes\)/);
  assert.match(managementScopesSource, /new Set<string>\(\["manage", "admin"\]\)/);
  assert.match(managementAuthSource, /extractApiKey\(request, \{ allowUrl: false \}\)/);
  assert.match(managementAuthSource, /!lockedManagementAuth && !options\.alwaysRequireAuth/);
  assert.match(apiAuthSource, /if \(settings\.requireLogin === false\) return false;/);
  assert.match(
    apiAuthSource,
    /settings\.setupComplete === true \|\| !isLoopbackRequest\(request\)/
  );
  assert.match(apiKeyAuthSource, /trimmedHeader\.toLowerCase\(\)\.startsWith\("bearer "\)/);
  assert.match(apiKeyAuthSource, /anthropicVersion \|\|/);
  assert.match(apiKeyAuthSource, /claude-code\|claude-cli\|anthropic/);
  assert.match(apiKeyAuthSource, /extractGoogApiKeyHeader\(request\?\.headers\)/);
  assert.equal((routeSource.match(/requireManagementAuth\(request\)/g) ?? []).length, 2);
  assert.match(
    routeSource,
    /export async function PUT\(request: Request\)\s*\{\s*return PATCH\(request\);\s*\}/
  );
});
