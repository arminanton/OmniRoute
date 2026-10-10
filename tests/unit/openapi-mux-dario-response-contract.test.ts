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

const expectedStatuses = [
  ["post", "/api/services/mux/install", ["200", "400", "401", "403", "500", "503", "504", "507"]],
  ["post", "/api/services/mux/start", ["200", "401", "403", "409", "503"]],
  ["post", "/api/services/mux/stop", ["200", "401", "403", "500", "503"]],
  ["post", "/api/services/mux/restart", ["200", "401", "403", "409", "503"]],
  ["post", "/api/services/mux/update", ["200", "401", "403", "500", "503"]],
  ["get", "/api/services/mux/status", ["200", "401", "403", "500", "503"]],
  ["post", "/api/services/mux/auto-start", ["204", "400", "401", "403", "500", "503"]],
  ["post", "/api/services/mux/auto-restart-adopted", ["204", "400", "401", "403", "500", "503"]],
  ["post", "/api/services/dario/stop", ["200", "401", "403", "500", "503"]],
  ["post", "/api/services/dario/update", ["200", "401", "403", "500", "503"]],
] as const;

function operation(method: string, route: string) {
  const result = spec.paths[route]?.[method];
  assert.ok(result, `Missing OpenAPI operation ${method.toUpperCase()} ${route}`);
  return result;
}

function schemaRef(method: string, route: string, status: string) {
  return operation(method, route).responses[status]?.content?.["application/json"]?.schema?.$ref;
}

test("Dario and Mux operations retain the committed locality and security declarations", () => {
  for (const [method, route] of expectedStatuses) {
    const op = operation(method, route);
    assert.equal(op["x-local-only"], true, `${method.toUpperCase()} ${route}`);
    assert.deepEqual(op.security, expectedSecurity, `${method.toUpperCase()} ${route}`);
  }
});

test("service operations list the route and source-supported responses", () => {
  for (const [method, route, statuses] of expectedStatuses) {
    assert.deepEqual(
      Object.keys(operation(method, route).responses).sort(),
      [...statuses].sort(),
      `${method.toUpperCase()} ${route}`,
    );
  }
});

test("Mux install uses the shared installer payload, version constraint, and error envelope", () => {
  const install = operation("post", "/api/services/mux/install");
  const requestSchema = install.requestBody.content["application/json"].schema;
  assert.equal(install.requestBody.required, false);
  assert.equal(requestSchema.properties.version.pattern, "^[A-Za-z0-9][A-Za-z0-9._+-]*$");
  assert.equal(requestSchema.properties.version.default, "latest");
  assert.equal(schemaRef("post", "/api/services/mux/install", "200"), "#/components/schemas/ServiceInstallResponse");
  assert.deepEqual(spec.components.schemas.ServiceInstallResponse.required, [
    "ok", "installedVersion", "installPath", "durationMs",
  ]);
  for (const status of ["400", "403", "500", "503", "504", "507"]) {
    const response = install.responses[status];
    if (response.$ref) continue;
    assert.equal(response.content["application/json"].schema.$ref, "#/components/schemas/ApiErrorResponse");
  }
});

test("Mux update ignores request bodies and both update routes use the exact result union", () => {
  assert.equal(operation("post", "/api/services/mux/update").requestBody, undefined);
  assert.equal(operation("post", "/api/services/dario/update").requestBody, undefined);
  for (const [method, route] of [
    ["post", "/api/services/mux/update"],
    ["post", "/api/services/dario/update"],
  ] as const) {
    assert.equal(schemaRef(method, route, "200"), "#/components/schemas/ServiceVersionUpdateResponse");
    assert.equal(operation(method, route).responses["500"].content["application/json"].schema.$ref, "#/components/schemas/ApiErrorResponse");
  }
  const update = spec.components.schemas.ServiceVersionUpdateResponse;
  assert.deepEqual(update.oneOf.map((branch: any) => branch.$ref), [
    "#/components/schemas/ServiceVersionUpdateCurrentResponse",
    "#/components/schemas/ServiceVersionUpdateAppliedResponse",
  ]);
  assert.deepEqual(spec.components.schemas.ServiceVersionUpdateCurrentResponse.required, [
    "updated", "installedVersion", "latestVersion",
  ]);
  assert.equal(spec.components.schemas.ServiceVersionUpdateCurrentResponse.properties.updated.const, false);
  assert.deepEqual(spec.components.schemas.ServiceVersionUpdateAppliedResponse.required, [
    "updated", "oldVersion", "newVersion",
  ]);
  assert.equal(spec.components.schemas.ServiceVersionUpdateAppliedResponse.properties.updated.const, true);
  assert.deepEqual(spec.components.schemas.ServiceVersionUpdateAppliedResponse.properties.oldVersion.type, ["string", "null"]);
});

test("Mux lifecycle and status contracts model supervisor, stopped, and database-backed results", () => {
  for (const route of ["/api/services/mux/start", "/api/services/mux/restart"]) {
    assert.equal(schemaRef("post", route, "200"), "#/components/schemas/MuxSupervisorStatusResponse");
    assert.equal(operation("post", route).responses["409"].content["application/json"].schema.$ref, "#/components/schemas/ApiErrorResponse");
  }
  assert.equal(schemaRef("post", "/api/services/mux/stop", "200"), "#/components/schemas/MuxStopResponse");
  assert.equal(schemaRef("post", "/api/services/dario/stop", "200"), "#/components/schemas/DarioStopResponse");
  assert.equal(spec.components.schemas.MuxStopResponse.oneOf.length, 2);
  assert.equal(spec.components.schemas.DarioStopResponse.oneOf.length, 2);
  assert.equal(schemaRef("get", "/api/services/mux/status", "200"), "#/components/schemas/MuxServiceStatusResponse");
  assert.equal(spec.components.schemas.MuxServiceStatusResponse.properties.tool.const, "mux");
  assert.deepEqual(spec.components.schemas.MuxServiceStatusResponse.required, [
    "tool", "state", "pid", "port", "health", "startedAt", "lastError",
    "installedVersion", "latestVersion", "updateAvailable", "autoStart", "adopted", "autoRestartAdopted",
  ]);
});

test("Mux auto-start is bodyless 204 and setting endpoints document JSON error bodies", () => {
  for (const route of ["/api/services/mux/auto-start", "/api/services/mux/auto-restart-adopted"]) {
    const op = operation("post", route);
    assert.equal(op.responses["204"].content, undefined);
    for (const status of ["400", "500"]) {
      assert.equal(op.responses[status].content["application/json"].schema.$ref, "#/components/schemas/ApiErrorResponse");
    }
    assert.equal(op.requestBody.required, true);
    assert.deepEqual(op.requestBody.content["application/json"].schema.required, ["enabled"]);
  }
  assert.equal(operation("post", "/api/services/mux/stop").responses["500"].content["application/json"].schema.$ref, "#/components/schemas/ApiErrorResponse");
  assert.equal(operation("get", "/api/services/mux/status").responses["500"].content["application/json"].schema.$ref, "#/components/schemas/ApiErrorResponse");
  assert.equal(operation("post", "/api/services/dario/stop").responses["500"].content["application/json"].schema.$ref, "#/components/schemas/ApiErrorResponse");
});
