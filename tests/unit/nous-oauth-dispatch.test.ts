// @ts-nocheck
/** Persisted OAuth row → credential hydration → chatCore → dedicated inference executor. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-nous-oauth-dispatch-"));
process.env.DATA_DIR = dataDir;
const core = await import("../../src/lib/db/core.ts");
const db = await import("../../src/lib/db/providers.ts");
const { getProviderCredentials } = await import("../../src/sse/services/auth.ts");
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.ts");
const { NOUS_OAUTH_INFERENCE_PSD_KEY } = await import("../../open-sse/config/nousOAuth.ts");

const originalFetch = globalThis.fetch;
const inferenceBase = "https://inference-api.nousresearch.com/v1";
const chatUrl = `${inferenceBase}/chat/completions`;
const log = { debug() {}, info() {}, warn() {}, error() {} };
let nextConnectionNumber = 0;

async function dispatch(credentials, stream = false) {
  const body = {
    model: "Hermes-4-70B",
    messages: [{ role: "user", content: "Hello" }],
    tags: ["product=hermes-agent"],
    stream,
  };
  return handleChatCore({
    body: structuredClone(body),
    modelInfo: { provider: "nous-oauth", model: body.model, extendedContext: false },
    credentials,
    connectionId: credentials.connectionId,
    log,
    clientRawRequest: {
      endpoint: "/v1/chat/completions",
      body: structuredClone(body),
      headers: new Headers({ accept: stream ? "text/event-stream" : "application/json" }),
    },
    userAgent: "unit-test",
  });
}

async function persistAndHydrate() {
  // Distinct credentials matter: the refresh path must never see a sibling
  // account's bearer/refresh pair or reuse a prior test's token-hash state.
  const index = ++nextConnectionNumber;
  const row = await db.createProviderConnection({
    provider: "nous-oauth",
    authType: "oauth",
    name: `Nous device login ${index}`,
    accessToken: `stored-oauth-access-${index}`,
    refreshToken: `stored-oauth-refresh-${index}`,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    isActive: true,
    testStatus: "active",
    providerSpecificData: { [NOUS_OAUTH_INFERENCE_PSD_KEY]: inferenceBase },
  });
  const saved = await db.getProviderConnectionById(row.id);
  assert.equal(saved?.apiKey ?? null, null, "OAuth row must not acquire an API key");
  assert.equal(saved?.providerSpecificData?.extraApiKeys, undefined);
  const hydrated = await getProviderCredentials("nous-oauth", null, [row.id], "Hermes-4-70B");
  assert.ok(hydrated);
  assert.equal(hydrated.connectionId, row.id);
  assert.equal(hydrated.accessToken, `stored-oauth-access-${index}`);
  assert.equal(hydrated.refreshToken, `stored-oauth-refresh-${index}`);
  assert.equal(hydrated.apiKey ?? null, null);
  assert.equal(hydrated.providerSpecificData.extraApiKeys, undefined);
  return hydrated;
}

test.after(async () => {
  globalThis.fetch = originalFetch;
  // Allow fire-and-forget request/usage logging to complete before removing DB.
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("real persisted OAuth row dispatches to the fixed chat URL with only OAuth bearer", async () => {
  const hydrated = await persistAndHydrate();
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(String(url), chatUrl);
    assert.equal(init?.redirect, "manual");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${hydrated.accessToken}`);
    assert.deepEqual(JSON.parse(String(init?.body)).tags, ["product=hermes-agent"]);
    return Response.json({
      id: "chatcmpl-nous",
      object: "chat.completion",
      model: "Hermes-4-70B",
      choices: [
        { index: 0, message: { role: "assistant", content: "Hello back" }, finish_reason: "stop" },
      ],
    });
  };
  const result = await dispatch(hydrated);
  assert.equal(result.success, true);
  assert.equal(calls, 1);
});

test("real chatCore 401 has exactly one rotating refresh and two inference sends", async () => {
  const hydrated = await persistAndHydrate();
  let sends = 0;
  let refreshes = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url) === "https://portal.nousresearch.com/api/oauth/token") {
      refreshes++;
      assert.equal(init?.redirect, "manual");
      assert.equal(new Headers(init?.headers).get("x-nous-refresh-token"), hydrated.refreshToken);
      return Response.json({
        access_token: "new-oauth-access",
        refresh_token: "new-oauth-refresh",
        expires_in: 3600,
        inference_base_url: inferenceBase,
      });
    }
    assert.equal(String(url), chatUrl);
    sends++;
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      sends === 1 ? `Bearer ${hydrated.accessToken}` : "Bearer new-oauth-access"
    );
    return Response.json({ error: { message: "Unauthorized" } }, { status: 401 });
  };
  const result = await dispatch(hydrated);
  assert.equal(result.success, false);
  assert.equal(result.status, 401);
  assert.equal(sends, 2, "chatCore must not retry a second 401 after executor retry");
  assert.equal(refreshes, 1, "chatCore must not POST a duplicate rotating refresh");
});
