import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-required-refresh-"));
process.env.DATA_DIR = dir;
process.env.API_KEY_SECRET = "required-refresh-test-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.OMNIROUTE_HIDE_HEALTHCHECK_LOGS = "true";
const core = await import("../../src/lib/db/core.ts");
const providers = await import("../../src/lib/db/providers.ts");
// These OAuth fixtures insert UUID ids; DB row helpers expose those ids as unknown.
type FixtureConnection = Awaited<ReturnType<typeof providers.createProviderConnection>> & {
  id: string;
};
const proxies = await import("../../src/lib/db/proxies.ts");
const health = await import("../../src/lib/tokenHealthCheck.ts");
const refresh = await import("../../src/sse/services/tokenRefresh.ts");
const { proxyFetch } = await import("../../open-sse/utils/proxyFetch.ts");
const originalFetch = globalThis.fetch;
const originalNoProxy = process.env.NO_PROXY;
const originalLowerNoProxy = process.env.no_proxy;
let nativeSends = 0;
let proxySends = 0;
let fallbackProbes = 0;
let socketAttempts = 0;
const response = () =>
  Response.json({
    token: "fixture-new-copilot",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    access_token: "fixture-new-access",
    refresh_token: "fixture-new-refresh",
    expires_in: 3600,
  });

test.beforeEach(() => {
  nativeSends = proxySends = fallbackProbes = socketAttempts = 0;
  delete process.env.NO_PROXY;
  delete process.env.no_proxy;
  test.mock.method(net.Socket.prototype, "connect", () => {
    socketAttempts++;
    throw new Error("Mock blocked an unexpected socket/probe");
  });
  globalThis.fetch = ((input, init) =>
    proxyFetch(input, init, {
      nativeFetch: async () => {
        nativeSends++;
        return response();
      },
      undiciFetch: async () => {
        proxySends++;
        return response();
      },
      findWorkingProxy: async () => {
        fallbackProbes++;
        return null;
      },
    })) as typeof fetch;
});
test.afterEach(() => {
  test.mock.restoreAll();
  globalThis.fetch = originalFetch;
});
test.after(() => {
  core.resetDbInstance();
  fs.rmSync(dir, { recursive: true, force: true });
  if (originalNoProxy === undefined) delete process.env.NO_PROXY;
  else process.env.NO_PROXY = originalNoProxy;
  if (originalLowerNoProxy === undefined) delete process.env.no_proxy;
  else process.env.no_proxy = originalLowerNoProxy;
});

async function assigned(provider: string, gheUrl?: string) {
  const conn = (await providers.createProviderConnection({
    provider,
    authType: "oauth",
    isActive: true,
    testStatus: "active",
    accessToken: "fixture-old-access",
    refreshToken: provider === "gemini" ? "fixture-old-refresh" : null,
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    providerSpecificData: gheUrl ? { gheUrl } : {},
  })) as FixtureConnection;
  const proxy = await proxies.createProxy({
    name: "required fixture",
    type: "http",
    host: "127.0.0.1",
    port: 9481,
  });
  await proxies.assignProxyToScope("account", conn.id, proxy!.id);
  return conn;
}

function assertNoNetwork() {
  assert.equal(nativeSends, 0, "assigned refresh credentials must not reach a direct transport");
  assert.equal(proxySends, 0, "a blocked route must not reach any proxy transport either");
  assert.equal(fallbackProbes, 0);
  assert.equal(
    socketAttempts,
    0,
    "strict refresh must not race a reachability probe against the grant"
  );
}

for (const provider of ["github", "gemini"]) {
  test(`assigned ${provider} health refresh cannot bypass through NO_PROXY`, async () => {
    const conn = await assigned(provider);
    process.env.NO_PROXY = "*";
    await health.checkConnection(conn);
    assertNoNetwork();
    assert.equal(
      (await providers.getProviderConnectionById(conn.id))!.accessToken,
      "fixture-old-access"
    );
  });
}

for (const gheUrl of [
  "http://127.0.0.1:20128",
  "http://192.168.1.8:8123",
  "http://localhost:20128",
]) {
  test(`assigned GHE token endpoint cannot bypass to local/LAN ${gheUrl}`, async () => {
    const conn = await assigned("ghe-copilot", gheUrl);
    await health.checkConnection(conn);
    assertNoNetwork();
  });
}

test("local Copilot wrapper establishes required context before the provider leaf", async () => {
  const conn = await assigned("github");
  process.env.NO_PROXY = "api.github.com";
  await refresh.refreshCopilotToken("fixture-old-access", { connectionId: conn.id });
  assertNoNetwork();
});

test("bulk refresh cannot bypass connection-level required proxy context", async () => {
  const conn = await assigned("gemini");
  process.env.NO_PROXY = "*";
  await assert.rejects(refresh.getAllAccessTokens({ connections: [conn] }), {
    code: "PROXY_REQUIRED_EGRESS",
  });
  assertNoNetwork();
});

test("healthy assigned refresh sends only through the mocked proxy without a network probe", async () => {
  const conn = await assigned("github");
  const result = await refresh.refreshCopilotToken("fixture-old-access", { connectionId: conn.id });
  assert.equal(result?.token, "fixture-new-copilot");
  assert.equal(nativeSends, 0);
  assert.equal(proxySends, 1);
  assert.equal(fallbackProbes, 0);
  assert.equal(socketAttempts, 0);
});

test("post-OAuth Copilot mint keeps the required proxy scope after the first refresh returns", async () => {
  const conn = await assigned("github");
  await providers.updateProviderConnection(conn.id, { refreshToken: "github-fixture-refresh" });
  // The OAuth exchange uses github.com, while the sub-token mint uses api.github.com.
  process.env.NO_PROXY = "api.github.com";
  await health.checkConnection((await providers.getProviderConnectionById(conn.id))!);
  const after = await providers.getProviderConnectionById(conn.id);
  assert.equal(
    after!.accessToken,
    "fixture-new-access",
    "the permitted mocked OAuth exchange completes"
  );
  assert.equal(
    (after!.providerSpecificData as { copilotToken?: unknown } | null | undefined)?.copilotToken,
    undefined,
    "blocked sub-token mint must not commit a token"
  );
  assert.equal(nativeSends, 0);
  assert.equal(proxySends, 1, "only the initial OAuth exchange may reach mocked transport");
  assert.equal(fallbackProbes, 0);
  assert.equal(socketAttempts, 0);
});
