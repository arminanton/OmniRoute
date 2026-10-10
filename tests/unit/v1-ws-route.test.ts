import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as yaml from "js-yaml";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-v1-ws-route-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
const ORIGINAL_API_KEY_SECRET = process.env.API_KEY_SECRET;

process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "test-v1-ws-route-secret";

const core = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const { updateSettings } = await import("@/lib/db/settings");
const localDb = { updateSettings };
const wsRoute = await import("../../src/app/api/v1/ws/route.ts");
const canonicalOpenApi = fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8");
const publicOpenApi = fs.readFileSync(path.join(process.cwd(), "public/openapi.yaml"), "utf8");
const openApi = yaml.load(canonicalOpenApi) as any;

function resetStorage() {
  apiKeysDb.resetApiKeyState();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(async () => {
  resetStorage();
  await localDb.updateSettings({
    wsAuth: false,
    requireLogin: true,
    password: "hashed-password",
  });
});

test.after(() => {
  apiKeysDb.resetApiKeyState();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

  if (ORIGINAL_DATA_DIR === undefined) {
    delete process.env.DATA_DIR;
  } else {
    process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  }

  if (ORIGINAL_API_KEY_SECRET === undefined) {
    delete process.env.API_KEY_SECRET;
  } else {
    process.env.API_KEY_SECRET = ORIGINAL_API_KEY_SECRET;
  }
});

test("v1 ws handshake succeeds without credentials when wsAuth is disabled", async () => {
  await localDb.updateSettings({ wsAuth: false });

  const response = await wsRoute.GET(
    new Request("http://localhost/api/v1/ws?handshake=1", {
      headers: { origin: "http://localhost" },
    })
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as any;
  assert.equal(body.ok, true);
  assert.equal(body.wsAuth, false);
  assert.equal(body.authenticated, false);
  assert.equal(body.path, "/v1/ws");
});

test("v1 ws handshake output matches the documented frame and live descriptors", async () => {
  await localDb.updateSettings({ wsAuth: false });

  const response = await wsRoute.GET(
    new Request("http://localhost/api/v1/ws?handshake=1", {
      headers: { origin: "http://localhost" },
    })
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as any;
  const handshakeSchema = openApi.components.schemas.WebSocketHandshakeResponse;
  const protocolSchema = handshakeSchema.properties.protocol;
  const protocolDescriptorSchema = openApi.components.schemas.WebSocketProtocolDescriptor;
  const protocolLiveSchema = openApi.components.schemas.WebSocketProtocolLiveDescriptor;
  const liveSchema = openApi.components.schemas.WebSocketLiveDescriptor;
  const operation = openApi.paths["/api/v1/ws"].get;

  assert.deepEqual(operation.security, [
    { WebSocketApiKeyBearerAuth: [] },
    { ManagementSessionAuth: [] },
    { WebSocketApiKeyQueryAuth: [] },
    { WebSocketTokenQueryAuth: [] },
    { WebSocketAccessTokenQueryAuth: [] },
    {},
  ]);
  for (const scheme of [
    "WebSocketApiKeyBearerAuth",
    "WebSocketApiKeyQueryAuth",
    "WebSocketTokenQueryAuth",
    "WebSocketAccessTokenQueryAuth",
    "ManagementSessionAuth",
  ]) {
    assert.ok(openApi.components.securitySchemes[scheme], `missing security scheme ${scheme}`);
  }
  assert.match(operation.description, /default port `LIVE_WS_PORT=20132`, path `\/live-ws`/);
  assert.match(
    operation.description,
    /query credentials must be API keys, not management access tokens/i
  );

  const exactKeys = (actual: object, schema: any, label: string) => {
    assert.deepEqual(
      Object.keys(actual).sort(),
      Object.keys(schema.properties).sort(),
      `${label} keys match the OpenAPI properties`
    );
  };

  exactKeys(body, handshakeSchema, "handshake");
  assert.equal(handshakeSchema.properties.ok.const, true);
  assert.equal(protocolSchema.$ref, "#/components/schemas/WebSocketProtocolDescriptor");
  assert.equal(
    protocolDescriptorSchema.properties.request.$ref,
    "#/components/schemas/WebSocketRequestDescriptor"
  );
  assert.equal(
    protocolDescriptorSchema.properties.cancel.$ref,
    "#/components/schemas/WebSocketCancelDescriptor"
  );
  assert.equal(
    protocolDescriptorSchema.properties.live.$ref,
    "#/components/schemas/WebSocketProtocolLiveDescriptor"
  );
  assert.equal(
    handshakeSchema.properties.live.$ref,
    "#/components/schemas/WebSocketLiveDescriptor"
  );

  exactKeys(body.protocol, protocolDescriptorSchema, "protocol");
  exactKeys(
    body.protocol.request,
    openApi.components.schemas.WebSocketRequestDescriptor,
    "request frame"
  );
  exactKeys(
    body.protocol.cancel,
    openApi.components.schemas.WebSocketCancelDescriptor,
    "cancel frame"
  );
  exactKeys(body.protocol.live, protocolLiveSchema, "protocol live descriptor");
  exactKeys(body.live, liveSchema, "live descriptor");
  assert.equal(body.protocol.request.type, "request");
  assert.deepEqual(body.protocol.request.payload.messages, []);
  assert.equal(body.protocol.cancel.type, "cancel");
  assert.equal(body.protocol.live.heartbeatMs, 15000);
  assert.equal(body.protocol.live.protocol, "json");
  assert.equal(body.live.description, "Real-time dashboard events via WebSocket");
  assert.equal(publicOpenApi, canonicalOpenApi);
});

test("v1 ws handshake requires credentials when wsAuth is enabled", async () => {
  await localDb.updateSettings({ wsAuth: true });

  const response = await wsRoute.GET(new Request("http://localhost/api/v1/ws?handshake=1"));

  assert.equal(response.status, 401);
  const body = (await response.json()) as any;
  assert.equal(body.error.code, "ws_auth_required");
  assert.equal(body.wsAuth, true);
  assert.deepEqual(Object.keys(body).sort(), ["error", "path", "wsAuth"]);
  assert.deepEqual(Object.keys(body.error).sort(), ["code", "message", "type"]);
  assert.equal(
    openApi.paths["/api/v1/ws"].get.responses["401"].content["application/json"].schema.$ref,
    "#/components/schemas/WebSocketHandshakeAuthRequiredResponse"
  );
  const authRequiredSchema = openApi.components.schemas.WebSocketHandshakeAuthRequiredResponse;
  assert.deepEqual(authRequiredSchema.required, ["error", "wsAuth", "path"]);
  assert.equal(authRequiredSchema.properties.error.properties.code.const, "ws_auth_required");

  const invalid = await wsRoute.GET(
    new Request("http://localhost/api/v1/ws?handshake=1&api_key=not-a-valid-key")
  );
  assert.equal(invalid.status, 403);
  const invalidBody = (await invalid.json()) as any;
  assert.equal(invalidBody.error.code, "ws_auth_invalid");
  assert.deepEqual(Object.keys(invalidBody).sort(), ["error", "path", "wsAuth"]);
  assert.equal(
    openApi.paths["/api/v1/ws"].get.responses["403"].content["application/json"].schema.$ref,
    "#/components/schemas/WebSocketHandshakeAuthInvalidResponse"
  );
  assert.equal(
    openApi.components.schemas.WebSocketHandshakeAuthInvalidResponse.properties.error.properties
      .code.const,
    "ws_auth_invalid"
  );
});

test("v1 ws handshake accepts documented API key query aliases when wsAuth is enabled", async () => {
  await localDb.updateSettings({ wsAuth: true });
  const key = await apiKeysDb.createApiKey("ws client", "machine-ws-route");

  for (const parameter of ["api_key", "token", "access_token"]) {
    const response = await wsRoute.GET(
      new Request(
        `http://localhost/api/v1/ws?handshake=1&${parameter}=${encodeURIComponent(key.key)}`
      )
    );

    assert.equal(response.status, 200, `query credential ${parameter} is accepted`);
    const body = (await response.json()) as any;
    assert.equal(body.ok, true);
    assert.equal(body.authenticated, true);
    assert.equal(body.authType, "api_key");
  }

  const bearerResponse = await wsRoute.GET(
    new Request("http://localhost/api/v1/ws?handshake=1", {
      headers: { Authorization: `Bearer ${key.key}` },
    })
  );
  assert.equal(bearerResponse.status, 200);
  const bearerBody = (await bearerResponse.json()) as any;
  assert.equal(bearerBody.authenticated, true);
  assert.equal(bearerBody.authType, "api_key");
});

test("v1 ws HTTP GET reports upgrade required outside handshake mode", async () => {
  const response = await wsRoute.GET(new Request("http://localhost/api/v1/ws"));

  assert.equal(response.status, 426);
  assert.equal(response.headers.get("upgrade"), "websocket");
  const body = (await response.json()) as any;
  assert.equal(body.error.code, "upgrade_required");
  assert.deepEqual(Object.keys(body).sort(), ["error", "path", "protocol", "wsAuth"]);
  assert.deepEqual(Object.keys(body.protocol).sort(), ["cancel", "live", "request"]);
  assert.equal(
    openApi.paths["/api/v1/ws"].get.responses["426"].content["application/json"].schema.$ref,
    "#/components/schemas/WebSocketUpgradeRequiredResponse"
  );
  assert.equal(
    openApi.components.schemas.WebSocketUpgradeRequiredResponse.properties.error.properties.code
      .const,
    "upgrade_required"
  );
  assert.equal(
    openApi.paths["/api/v1/ws"].get.responses["426"].headers.Upgrade.schema.const,
    "websocket"
  );
});
