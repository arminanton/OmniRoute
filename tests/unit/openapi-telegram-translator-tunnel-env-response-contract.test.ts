import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import * as yaml from "js-yaml";

const canonicalText = fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8");
const spec = yaml.load(canonicalText) as {
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, any> };
};

function operation(method: string, pathname: string) {
  const value = spec.paths[pathname]?.[method];
  assert.ok(value, `Missing ${method.toUpperCase()} ${pathname}`);
  return value;
}

const contracts = [
  ["post", "/api/radar/sync-all", ["200", "400", "401", "403", "404", "413", "500", "503"], "RadarSyncAllResponse"],
  ["get", "/api/synced-available-models", ["200", "401", "403", "500", "503"], "SyncedAvailableModelsResponse"],
  ["get", "/api/system/env/repair", ["200", "401", "403", "503", "500"], "EnvRepairPlanResponse"],
  ["post", "/api/system/env/repair", ["200", "401", "403", "503", "500"], "EnvRepairApplyResponse"],
  ["post", "/api/telegram/update", ["200", "400", "401", "503"], "TelegramUpdateResponse"],
  ["get", "/api/token-health", ["200", "401", "403", "500", "503"], "TokenHealthResponse"],
  ["post", "/api/translator/detect", ["200", "400", "401", "403", "500", "503"], "TranslatorDetectResponse"],
  ["get", "/api/translator/history", ["200", "401", "403", "500", "503"], "TranslatorHistoryResponse"],
  ["post", "/api/translator/send", ["200", "400", "401", "403", "500", "503", "default"], null],
  ["post", "/api/translator/transform-stream", ["200", "400", "401", "403", "500", "503"], "TranslatorTransformStreamResponse"],
  ["get", "/api/tunnels/cloudflared", ["200", "401", "403", "500", "503"], "CloudflaredTunnelStatus"],
  ["post", "/api/tunnels/cloudflared", ["200", "400", "401", "403", "500", "503"], "CloudflaredTunnelActionResponse"],
  ["get", "/api/tunnels/ngrok", ["200", "401", "403", "500", "503"], "NgrokTunnelStatus"],
  ["post", "/api/tunnels/ngrok", ["200", "400", "401", "403", "500", "503"], "NgrokTunnelActionResponse"],
  ["get", "/api/tunnels/tailscale", ["200", "401", "403", "500", "503"], "TailscaleTunnelStatus"],
] as const;

test("all 15 implemented operations have source-backed statuses and typed success bodies", () => {
  assert.equal(contracts.length, 15);
  for (const [method, pathname, statuses, schemaName] of contracts) {
    const op = operation(method, pathname);
    assert.deepEqual(Object.keys(op.responses).sort(), [...statuses].sort(), `${method.toUpperCase()} ${pathname}`);
    const success = op.responses["200"];
    assert.ok(success, `${method.toUpperCase()} ${pathname} declares 200`);
    if (pathname === "/api/translator/send") {
      assert.equal(success.content["text/event-stream"].schema.type, "string");
      assert.equal(op.responses.default.content["application/json"].schema.$ref, "#/components/schemas/TranslatorSendUpstreamFailureResponse");
      continue;
    }
    assert.equal(success.content["application/json"].schema.$ref, `#/components/schemas/${schemaName}`);
    assert.ok(spec.components.schemas[schemaName!], `Missing ${schemaName}`);
  }
});

test("the unsupported Tailscale base POST stays absent while nested action handlers remain", () => {
  assert.ok(operation("get", "/api/tunnels/tailscale"));
  assert.equal(spec.paths["/api/tunnels/tailscale"].post, undefined);
  for (const route of ["enable", "disable", "login", "install", "start-daemon"]) {
    assert.ok(operation("post", `/api/tunnels/tailscale/${route}`));
  }
});

test("auth declarations are unchanged for auth-gated and intentionally open operations", () => {
  for (const [method, route] of [
    ["get", "/api/system/env/repair"],
    ["post", "/api/system/env/repair"],
  ]) assert.equal(operation(method, route).security.length, 5);
  assert.deepEqual(operation("post", "/api/telegram/update").security, []);
  const managementSecurity = [
    { BearerAuth: [] },
    { ManagementGoogleApiKeyAuth: [] },
    { ManagementAnthropicApiKeyAuth: [] },
    { ManagementSessionAuth: [] },
    { LocalCliTokenAuth: [] },
    { InternalServiceTokenAuth: [] },
    {},
  ];
  for (const [method, route] of [
    ["post", "/api/radar/sync-all"],
    ["get", "/api/token-health"],
    ["post", "/api/translator/detect"],
    ["get", "/api/translator/history"],
    ["post", "/api/translator/send"],
    ["post", "/api/translator/transform-stream"],
  ]) assert.deepEqual(operation(method, route).security, managementSecurity, `${method} ${route}`);
  const legacyManagementSecurity = [
    { ManagementApiKeyBearerAuth: [] },
    { ManagementGoogleApiKeyAuth: [] },
    { ManagementAnthropicApiKeyAuth: [] },
    { ManagementSessionAuth: [] },
    {},
  ];
  for (const [method, route] of [
    ["get", "/api/synced-available-models"],
    ["get", "/api/tunnels/cloudflared"],
    ["post", "/api/tunnels/cloudflared"],
    ["get", "/api/tunnels/ngrok"],
    ["post", "/api/tunnels/ngrok"],
    ["get", "/api/tunnels/tailscale"],
  ]) assert.deepEqual(operation(method, route).security, legacyManagementSecurity, `${method} ${route}`);
  assert.equal(operation("post", "/api/tunnels/cloudflared")["x-local-only"], true);
});

test("credentials, message content, host paths, and operational data are marked sensitive", () => {
  assert.equal(operation("post", "/api/radar/sync-all").responses["200"]["x-sensitive"], true);
  assert.equal(operation("get", "/api/synced-available-models").responses["200"]["x-sensitive"], true);
  assert.equal(spec.components.schemas.EnvRepairApplyResponse.properties.backupPath["x-sensitive"], true);
  assert.equal(operation("post", "/api/telegram/update").requestBody["x-sensitive"], true);
  assert.equal(spec.components.schemas.TelegramUpdateRequest.properties.initData["x-sensitive"], true);
  assert.equal(spec.components.schemas.TelegramUpdateRequest.properties.message["x-sensitive"], true);
  assert.equal(operation("get", "/api/token-health").responses["200"]["x-sensitive"], true);
  assert.equal(operation("post", "/api/translator/send").requestBody["x-sensitive"], true);
  assert.equal(operation("post", "/api/translator/send").responses["200"]["x-sensitive"], true);
  assert.equal(operation("get", "/api/translator/history").responses["200"]["x-sensitive"], true);
  assert.equal(spec.components.schemas.NgrokTunnelActionRequest.properties.authToken["x-sensitive"], true);
  assert.equal(spec.components.schemas.CloudflaredTunnelStatus.properties.binaryPath["x-sensitive"], true);
  assert.equal(spec.components.schemas.TailscaleTunnelStatus.properties.lastError["x-sensitive"], true);
});

test("SSE cache headers, generated error unions, and repair output are documented", () => {
  const send = operation("post", "/api/translator/send");
  assert.equal(send.responses["200"].headers["Cache-Control"].schema.const, "no-cache");
  assert.equal(send.responses["200"].headers.Connection.schema.const, "keep-alive");
  assert.deepEqual(send.responses["400"].content["application/json"].schema.$ref, "#/components/schemas/TranslatorSendLocalFailureResponse");
  assert.equal(operation("get", "/api/translator/history").parameters[0].name, "limit");
  assert.equal(operation("post", "/api/translator/transform-stream").requestBody.content["application/json"].schema.$ref, "#/components/schemas/TranslatorTransformStreamRequest");
  assert.deepEqual(
    operation("post", "/api/tunnels/ngrok").requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/NgrokTunnelActionRequest",
  );
  assert.equal(
    operation("get", "/api/system/env/repair").responses["401"].content["application/json"].schema.oneOf.length,
    2,
  );
  assert.equal(
    operation("post", "/api/system/env/repair").responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/EnvRepairApplyResponse",
  );
});

test("public OpenAPI mirror remains byte-identical to the canonical document", () => {
  assert.equal(fs.readFileSync(path.join(process.cwd(), "public/openapi.yaml"), "utf8"), canonicalText);
});
