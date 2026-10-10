import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

const spec = yaml.load(
  fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8"),
) as { paths: Record<string, Record<string, any>>; components: { schemas: Record<string, any> } };

const expectedSecurity = [
  { BearerAuth: [] },
  { ManagementGoogleApiKeyAuth: [] },
  { ManagementAnthropicApiKeyAuth: [] },
  { ManagementSessionAuth: [] },
  { LocalCliTokenAuth: [] },
  { InternalServiceTokenAuth: [] },
  {},
];

function operation(method: string, route: string) {
  const result = spec.paths[route]?.[method];
  assert.ok(result, `Missing OpenAPI operation ${method.toUpperCase()} ${route}`);
  return result;
}

test("CLIProxy update has no ignored version body and documents both source result branches", () => {
  const update = operation("post", "/api/services/cliproxy/update");
  assert.equal(update.requestBody, undefined);
  assert.match(update.description, /accepts no version request body.*latest release/i);
  assert.equal(update.responses["200"].content["application/json"].schema.$ref, "#/components/schemas/CliproxyUpdateResponse");

  const response = spec.components.schemas.CliproxyUpdateResponse;
  assert.deepEqual(response.oneOf.map((branch: any) => branch.$ref), [
    "#/components/schemas/CliproxyUpdateCurrentResponse",
    "#/components/schemas/CliproxyUpdateInstalledResponse",
  ]);
  const current = spec.components.schemas.CliproxyUpdateCurrentResponse;
  assert.deepEqual(current.required, ["updated", "installedVersion", "latestVersion"]);
  assert.equal(current.properties.updated.const, false);
  const installed = spec.components.schemas.CliproxyUpdateInstalledResponse;
  assert.deepEqual(installed.required, ["updated", "oldVersion", "newVersion"]);
  assert.equal(installed.properties.updated.const, true);
  assert.deepEqual(installed.properties.oldVersion.type, ["string", "null"]);
});

test("both service install endpoints document the shared installer wrapper payload", () => {
  const installs = [
    operation("post", "/api/services/cliproxy/install"),
    operation("post", "/api/services/dario/install"),
  ];
  for (const install of installs) {
    assert.equal(install.responses["200"].content["application/json"].schema.$ref, "#/components/schemas/ServiceInstallResponse");
  }
  const schema = spec.components.schemas.ServiceInstallResponse;
  assert.deepEqual(schema.required, ["ok", "installedVersion", "installPath", "durationMs"]);
  assert.equal(schema.properties.ok.const, true);
  assert.equal(schema.properties.installPath["x-sensitive"], true);
  assert.equal(schema.properties.durationMs.type, "integer");
  assert.equal(schema.properties.path, undefined);
});

test("Dario status uses its no-key status projection, preserving required source fields", () => {
  const status = operation("get", "/api/services/dario/status");
  assert.equal(status.responses["200"].content["application/json"].schema.$ref, "#/components/schemas/DarioServiceStatusResponse");
  const schema = spec.components.schemas.DarioServiceStatusResponse;
  assert.deepEqual(schema.required, [
    "tool", "state", "pid", "port", "health", "startedAt", "lastError",
    "installedVersion", "latestVersion", "updateAvailable", "autoStart", "adopted", "autoRestartAdopted",
  ]);
  assert.equal(schema.properties.tool.const, "dario");
  assert.equal(schema.properties.apiKeyMasked, undefined);
  assert.equal(schema.properties.apiKeyPlain, undefined);
  assert.equal(schema.properties.managementKey, undefined);
  assert.equal(schema["x-sensitive"], true);
});

test("the four corrected operations retain their existing LOCAL_ONLY and auth contracts", () => {
  for (const [method, route] of [
    ["post", "/api/services/cliproxy/update"],
    ["post", "/api/services/cliproxy/install"],
    ["post", "/api/services/dario/install"],
    ["get", "/api/services/dario/status"],
  ] as const) {
    const routeOperation = operation(method, route);
    assert.equal(routeOperation["x-local-only"], true);
    assert.deepEqual(routeOperation.security, expectedSecurity);
  }
});
