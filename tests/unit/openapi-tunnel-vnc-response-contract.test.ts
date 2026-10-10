import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

const spec = yaml.load(
  fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8"),
) as { paths: Record<string, Record<string, any>>; components: { schemas: Record<string, any> } };

const routes = [
  ["get", "/api/tunnels/tailscale/check", ["200", "401", "403", "500", "503"]],
  ["post", "/api/tunnels/tailscale/disable", ["200", "400", "401", "403", "500", "503"]],
  ["post", "/api/tunnels/tailscale/enable", ["200", "400", "401", "403", "500", "503"]],
  ["post", "/api/tunnels/tailscale/install", ["200", "400", "401", "403", "503"]],
  ["post", "/api/tunnels/tailscale/login", ["200", "400", "401", "403", "500", "503"]],
  ["post", "/api/tunnels/tailscale/start-daemon", ["200", "400", "401", "403", "500", "503"]],
  ["get", "/api/vnc-session", ["200", "401", "403", "503"]],
  ["delete", "/api/vnc-session/{params}", ["200", "400", "401", "403", "500", "503"]],
  ["get", "/api/vnc-session/{params}", ["200", "400", "401", "403", "404", "503"]],
  ["post", "/api/vnc-session/{params}", ["200", "400", "401", "403", "404", "500", "503"]],
] as const;

function operation(method: string, route: string) {
  const result = spec.paths[route]?.[method];
  assert.ok(result, `Missing OpenAPI operation ${method.toUpperCase()} ${route}`);
  return result;
}

function responseSchema(method: string, route: string, status: string) {
  return operation(method, route).responses[status]?.content?.["application/json"]?.schema;
}

test("all audited Tailscale and VNC operations declare source-backed responses", () => {
  for (const [method, route, statuses] of routes) {
    const op = operation(method, route);
    assert.deepEqual(Object.keys(op.responses).sort(), [...statuses].sort(), `${method.toUpperCase()} ${route}`);
    for (const status of statuses) {
      if (status === "200" || ["400", "401", "403", "404", "500", "503"].includes(status)) {
        assert.ok(op.responses[status].description || op.responses[status].$ref, `${method} ${route} ${status} needs a description`);
      }
    }
  }
});

test("public-safe tunnel error schema matches the implementation reason union", () => {
  const schema = spec.components.schemas.PublicSafeTunnelErrorBody;
  assert.deepEqual(schema.required, ["error", "reason"]);
  assert.equal(schema.properties.error.type, "string");
  assert.deepEqual(schema.properties.reason.enum, [
    "not_installed",
    "permission_denied",
    "already_running",
    "timeout",
    "network",
    "unknown",
  ]);
  assert.equal(schema.additionalProperties, false);

  const source = fs.readFileSync(
    path.join(process.cwd(), "src/lib/api/publicSafeTunnelError.ts"),
    "utf8"
  );
  const reasonType = source.match(/export type PublicSafeTunnelErrorReason =([\s\S]*?);/);
  assert.ok(reasonType, "implementation reason union should exist");
  for (const reason of schema.properties.reason.enum) {
    assert.match(reasonType[1], new RegExp(`"${reason}"`));
  }
});

test("existing LOCAL_ONLY and auth declarations remain intact", () => {
  assert.equal(operation("get", "/api/tunnels/tailscale/check")["x-local-only"], undefined);
  const tailscaleSecurity = [
    { ManagementApiKeyBearerAuth: [] },
    { ManagementGoogleApiKeyAuth: [] },
    { ManagementAnthropicApiKeyAuth: [] },
    { ManagementSessionAuth: [] },
    {},
  ];
  for (const [method, route] of routes.slice(0, 6)) {
    assert.deepEqual(operation(method, route).security, tailscaleSecurity, `${method.toUpperCase()} ${route}`);
  }
  for (const [method, route] of routes.slice(1, 6)) {
    assert.equal(operation(method, route)["x-local-only"], true, `${method.toUpperCase()} ${route}`);
  }
  const vncSecurity = [
    { BearerAuth: [] },
    { ManagementGoogleApiKeyAuth: [] },
    { ManagementAnthropicApiKeyAuth: [] },
    { ManagementSessionAuth: [] },
    { LocalCliTokenAuth: [] },
    { InternalServiceTokenAuth: [] },
    {},
  ];
  for (const [method, route] of routes.slice(6)) {
    assert.equal(operation(method, route)["x-local-only"], true, `${method.toUpperCase()} ${route}`);
    assert.deepEqual(operation(method, route).security, vncSecurity, `${method.toUpperCase()} ${route}`);
  }
});

test("Tailscale responses model status/action unions, secret input, and install SSE frames", () => {
  assert.equal(responseSchema("get", "/api/tunnels/tailscale/check", "200").$ref, "#/components/schemas/TailscaleCheckStatus");
  assert.equal(responseSchema("post", "/api/tunnels/tailscale/disable", "200").$ref, "#/components/schemas/TailscaleDisableResponse");
  assert.equal(responseSchema("post", "/api/tunnels/tailscale/enable", "200").$ref, "#/components/schemas/TailscaleEnableResponse");
  assert.equal(responseSchema("post", "/api/tunnels/tailscale/login", "200").$ref, "#/components/schemas/TailscaleLoginResponse");
  assert.equal(responseSchema("post", "/api/tunnels/tailscale/start-daemon", "200").$ref, "#/components/schemas/TailscaleStartDaemonResponse");
  assert.equal(spec.components.schemas.TailscaleEnableResponse.oneOf.length, 3);
  assert.equal(spec.components.schemas.TailscaleLoginResponse.oneOf.length, 2);
  assert.equal(spec.components.schemas.TailscaleStartDaemonResponse.oneOf.length, 2);

  for (const [, route] of routes.slice(1, 6)) {
    const op = operation("post", route);
    assert.equal(op.responses["400"].content["application/json"].schema.$ref, "#/components/schemas/StringErrorResponse");
    assert.equal(op.responses["401"].content["application/json"].schema.$ref, "#/components/schemas/StringErrorResponse");
    if (op.responses["500"]) {
      assert.equal(op.responses["500"].content["application/json"].schema.$ref, "#/components/schemas/PublicSafeTunnelErrorBody");
    }
  }

  for (const [method, route] of routes.slice(1, 6)) {
    if (method !== "post") continue;
    const body = operation(method, route).requestBody;
    assert.equal(body.required, false);
    assert.equal(body["x-sensitive"], true);
    const requestSchema = spec.components.schemas[body.content["application/json"].schema.$ref.split("/").at(-1)];
    if (requestSchema.properties.sudoPassword) assert.equal(requestSchema.properties.sudoPassword["x-sensitive"], true);
    if (requestSchema.properties.hostname) assert.equal(requestSchema.properties.hostname["x-sensitive"], true);
  }

  const install = operation("post", "/api/tunnels/tailscale/install");
  const eventStream = install.responses["200"].content["text/event-stream"];
  assert.equal(eventStream.schema.type, "string");
  assert.equal(install.responses["200"]["x-sensitive"], true);
  assert.equal(install.responses["200"].headers["Cache-Control"].schema.const, "no-cache, no-transform");
  assert.equal(install.responses["200"].headers.Connection.schema.const, "keep-alive");
  assert.equal(eventStream["x-sse-event-schema"].$ref, "#/components/schemas/TailscaleInstallSseEvent");
  assert.equal(spec.components.schemas.TailscaleInstallSseEvent.oneOf.length, 3);
});

test("VNC responses keep session metadata sensitive and model each catch-all action", () => {
  assert.equal(responseSchema("get", "/api/vnc-session", "200").$ref, "#/components/schemas/VncSessionIndexResponse");
  assert.equal(responseSchema("get", "/api/vnc-session/{params}", "200").$ref, "#/components/schemas/VncSessionLookupResponse");
  assert.equal(responseSchema("post", "/api/vnc-session/{params}", "200").$ref, "#/components/schemas/VncSessionActionResponse");
  assert.equal(responseSchema("delete", "/api/vnc-session/{params}", "200").$ref, "#/components/schemas/VncSessionStopResponse");
  assert.equal(spec.components.schemas.VncSessionLookupResponse.oneOf.length, 2);
  assert.equal(spec.components.schemas.VncSessionActionResponse.oneOf.length, 3);

  for (const schemaName of [
    "VncSessionIndexResponse",
    "VncSessionIndexEntry",
    "VncPublicSession",
    "VncProviderSummary",
    "VncSessionLookupResponse",
    "VncSessionActionResponse",
    "VncSessionHarvestResponse",
    "VncSessionStopResponse",
  ]) {
    assert.equal(spec.components.schemas[schemaName]["x-sensitive"], true, schemaName);
  }
  assert.equal(operation("get", "/api/vnc-session/{params}").responses["404"].content["application/json"].schema.$ref, "#/components/schemas/ApiErrorResponse");
  assert.equal(operation("post", "/api/vnc-session/{params}").responses["500"].content["application/json"].schema.$ref, "#/components/schemas/ApiErrorResponse");
  assert.equal(operation("delete", "/api/vnc-session/{params}").responses["200"].content["application/json"].schema.$ref, "#/components/schemas/VncSessionStopResponse");
  assert.equal(spec.paths["/api/vnc-session/{params}"].parameters[0]["x-sensitive"], true);
  for (const [method, route] of routes.slice(6)) {
    const op = operation(method, route);
    for (const [status, responseName] of [["401", "ManagementAuthenticationRequired"], ["403", "ManagementInvalidToken"], ["503", "ManagementAuthUnavailable"]]) {
      assert.equal(op.responses[status].$ref, `#/components/responses/${responseName}`);
    }
  }
});
