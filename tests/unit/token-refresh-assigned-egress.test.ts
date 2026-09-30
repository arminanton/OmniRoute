import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-refresh-egress-"));
process.env.DATA_DIR = dir;
process.env.API_KEY_SECRET = "refresh-egress-test-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.OMNIROUTE_HIDE_HEALTHCHECK_LOGS = "true";
const core = await import("../../src/lib/db/core.ts");
const providers = await import("../../src/lib/db/providers.ts");
// These OAuth fixtures insert UUID ids; DB row helpers expose those ids as unknown.
type FixtureConnection = Awaited<ReturnType<typeof providers.createProviderConnection>> & {
  id: string;
};
const proxies = await import("../../src/lib/db/proxies.ts");
const settings = await import("../../src/lib/db/settings.ts");
const cache = await import("../../src/lib/db/readCache.ts");
const health = await import("../../src/lib/tokenHealthCheck.ts");
const refresh = await import("../../src/sse/services/tokenRefresh.ts");
const originalFetch = globalThis.fetch;
const originalFailOpen = process.env.PROXY_FAIL_OPEN;
let sends = 0;

test.beforeEach(() => {
  core.resetDbInstance();
  cache.invalidateDbCache();
  settings.bumpProxyConfigGeneration();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  sends = 0;
  // Even an explicit legacy fail-open switch cannot release refresh credentials.
  process.env.PROXY_FAIL_OPEN = "true";
  globalThis.fetch = (async () => {
    sends++;
    return Response.json({
      access_token: "unexpected-new-access",
      refresh_token: "unexpected-new-refresh",
      expires_in: 3600,
      token: "unexpected-copilot",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });
  }) as typeof fetch;
});
test.afterEach(() => {
  globalThis.fetch = originalFetch;
});
test.after(() => {
  core.resetDbInstance();
  fs.rmSync(dir, { recursive: true, force: true });
  if (originalFailOpen === undefined) delete process.env.PROXY_FAIL_OPEN;
  else process.env.PROXY_FAIL_OPEN = originalFailOpen;
});

async function connection(provider: string) {
  return providers.createProviderConnection({
    provider,
    authType: "oauth",
    name: provider,
    isActive: true,
    testStatus: "active",
    accessToken: "fixture-access",
    refreshToken: provider.includes("copilot") || provider === "github" ? null : "fixture-refresh",
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    healthCheckInterval: 60,
    providerSpecificData:
      provider === "ghe-copilot" ? { gheUrl: "https://enterprise.example.test" } : {},
  }) as Promise<FixtureConnection>;
}

for (const provider of ["gemini", "github", "ghe-copilot"]) {
  test(`background ${provider} refuses a disabled assigned proxy without sending credentials`, async () => {
    const conn = await connection(provider);
    const proxy = await proxies.createProxy({
      name: "fixture",
      type: "http",
      host: "127.0.0.1",
      port: 9411,
    });
    await proxies.assignProxyToScope("account", conn.id, proxy!.id);
    await proxies.updateProxy(proxy!.id, { status: "disabled" });
    await health.checkConnection(conn);
    assert.equal(sends, 0);
    const after = await providers.getProviderConnectionById(conn.id);
    assert.equal(after!.accessToken, conn.accessToken);
    assert.equal(after!.refreshToken, conn.refreshToken);
    assert.equal(after!.lastHealthCheckAt, conn.lastHealthCheckAt);
  });
}

for (const off of ["connection", "global"]) {
  test(`assigned refresh proxy cannot escape through ${off} Proxy Off`, async () => {
    const conn = await connection("github");
    const proxy = await proxies.createProxy({
      name: "fixture",
      type: "http",
      host: "127.0.0.1",
      port: 9412,
    });
    await proxies.assignProxyToScope("account", conn.id, proxy!.id);
    if (off === "connection")
      await providers.updateProviderConnection(conn.id, { proxyEnabled: false });
    else await settings.updateSettings({ proxyEnabled: false });
    await health.checkConnection(conn);
    await assert.rejects(
      refresh.refreshCopilotToken("fixture-access", { connectionId: conn.id }),
      /PROXY_ASSIGNED_UNAVAILABLE/
    );
    assert.equal(sends, 0);
  });
}

test("dangling registry assignment blocks both background callers", async () => {
  const conn = await connection("github");
  // Simulate an old/cross-process orphan without calling a proxy or reading a private DB.
  const db = core.getDbInstance();
  db.pragma("foreign_keys = OFF");
  db.prepare(
    "INSERT INTO proxy_assignments (id, proxy_id, scope, scope_id) VALUES (?, ?, ?, ?)"
  ).run(999, "deleted-proxy", "account", conn.id);
  db.pragma("foreign_keys = ON");
  await health.checkConnection(conn);
  await assert.rejects(
    refresh.refreshCopilotToken("fixture-access", { connectionId: conn.id }),
    /PROXY_ASSIGNED_UNAVAILABLE/
  );
  assert.equal(sends, 0);
});

test("malformed legacy proxy is not interpreted as permission for direct refresh", async () => {
  const conn = await connection("github");
  await settings.setProxyForLevel("key", conn.id, { type: "http", port: 9412 });
  await health.checkConnection(conn);
  await assert.rejects(
    refresh.refreshCopilotToken("fixture-access", { connectionId: conn.id }),
    /PROXY_ASSIGNED_UNAVAILABLE/
  );
  assert.equal(sends, 0);
});

test("provider-only refresh refuses a dead assigned pool with PROXY_FAIL_OPEN=true", async () => {
  const proxy = await proxies.createProxy({
    name: "fixture",
    type: "http",
    host: "127.0.0.1",
    port: 9413,
  });
  await proxies.assignProxyToScope("provider", "github", proxy!.id);
  await proxies.updateProxy(proxy!.id, { status: "inactive" });
  await assert.rejects(refresh.refreshCopilotToken("fixture-access"), /PROXY_ASSIGNED_UNAVAILABLE/);
  assert.equal(sends, 0);
});

test("assignment read errors fail closed rather than sending through an unresolved connection", async () => {
  const conn = await connection("github");
  core.getDbInstance().prepare("DROP TABLE proxy_assignments").run();
  await health.checkConnection(conn);
  await assert.rejects(
    refresh.refreshCopilotToken("fixture-access", { connectionId: conn.id }),
    /PROXY_ASSIGNED_UNAVAILABLE/
  );
  assert.equal(sends, 0);
});

test("healthy assigned proxy is returned unchanged and does not perform a network probe", async () => {
  const conn = await connection("github");
  const proxy = await proxies.createProxy({
    name: "fixture",
    type: "http",
    host: "127.0.0.1",
    port: 9414,
  });
  await proxies.assignProxyToScope("account", conn.id, proxy!.id);
  const resolved = await refresh.resolveProxyForCredentials("github", { connectionId: conn.id });
  assert.equal((resolved as { host: string }).host, "127.0.0.1");
  assert.equal((resolved as { port: number }).port, 9414);
  assert.equal(sends, 0);
  // Cross-process disable: the settings resolver's cached healthy proxy cannot defeat the guard.
  core
    .getDbInstance()
    .prepare("UPDATE proxy_registry SET status = 'disabled' WHERE id = ?")
    .run(proxy!.id);
  await assert.rejects(
    refresh.refreshCopilotToken("fixture-access", { connectionId: conn.id }),
    /PROXY_ASSIGNED_UNAVAILABLE/
  );
  assert.equal(sends, 0);
});

test("unassigned resolution keeps the existing transport context without claiming residential egress", async () => {
  const conn = await connection("github");
  assert.equal(await refresh.resolveProxyForCredentials("github", { connectionId: conn.id }), null);
  assert.equal(sends, 0);
});

test("Nous blocked assignment does not enter its CAS refresh or generic status writes", async () => {
  const conn = (await providers.createProviderConnection({
    provider: "nous-oauth",
    authType: "oauth",
    isActive: true,
    testStatus: "active",
    accessToken: "nous-fixture-access",
    refreshToken: "nous-fixture-refresh",
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    providerSpecificData: { nousInferenceBaseUrl: "https://welcome-api.nousresearch.com/v1" },
  })) as FixtureConnection;
  const proxy = await proxies.createProxy({
    name: "fixture",
    type: "http",
    host: "127.0.0.1",
    port: 9415,
  });
  await proxies.assignProxyToScope("account", conn.id, proxy!.id);
  await proxies.updateProxy(proxy!.id, { status: "disabled" });
  const before = await providers.getProviderConnectionById(conn.id);
  await health.checkConnection(before);
  await assert.rejects(
    refresh.getAccessToken("nous-oauth", { ...conn, connectionId: conn.id }),
    /PROXY_ASSIGNED_UNAVAILABLE/
  );
  assert.deepEqual(await providers.getProviderConnectionById(conn.id), before);
  assert.equal(sends, 0);
});

test("dead account assignment cannot be replaced by a healthy lower provider proxy", async () => {
  const conn = await connection("github");
  const dead = await proxies.createProxy({
    name: "dead",
    type: "http",
    host: "127.0.0.1",
    port: 9420,
  });
  const live = await proxies.createProxy({
    name: "live",
    type: "http",
    host: "127.0.0.1",
    port: 9421,
  });
  await proxies.assignProxyToScope("account", conn.id, dead!.id);
  await proxies.assignProxyToScope("provider", "github", live!.id);
  await proxies.updateProxy(dead!.id, { status: "disabled" });
  await assert.rejects(
    refresh.resolveProxyForCredentials("github", { connectionId: conn.id }),
    /PROXY_ASSIGNED_UNAVAILABLE/
  );
  assert.equal(sends, 0);
});

test("refresh rereads a partly live assigned pool rather than reusing its now-disabled cached member", async () => {
  const conn = await connection("github");
  const first = await proxies.createProxy({
    name: "first",
    type: "http",
    host: "127.0.0.1",
    port: 9422,
  });
  const second = await proxies.createProxy({
    name: "second",
    type: "http",
    host: "127.0.0.1",
    port: 9423,
  });
  await proxies.assignProxyToScope("account", conn.id, first!.id);
  await proxies.addProxyToScopePool("account", conn.id, second!.id);
  const initial = (await refresh.resolveProxyForCredentials("github", {
    connectionId: conn.id,
  })) as { port: number };
  const selected = initial.port === 9422 ? first! : second!;
  const survivorPort = initial.port === 9422 ? 9423 : 9422;
  core
    .getDbInstance()
    .prepare("UPDATE proxy_registry SET status = 'disabled' WHERE id = ?")
    .run(selected.id);
  const fresh = (await refresh.resolveProxyForCredentials("github", { connectionId: conn.id })) as {
    port: number;
  };
  assert.equal(fresh.port, survivorPort);
  assert.equal(sends, 0);
});

test("background resolution never auto-probes an unrelated registry fallback", async (t) => {
  const conn = await connection("github");
  await proxies.createProxy({
    name: "unassigned fixture",
    type: "http",
    host: "127.0.0.1",
    port: 9499,
  });
  let socketAttempts = 0;
  t.mock.method(net.Socket.prototype, "connect", () => {
    socketAttempts++;
    throw new Error("Mock blocked an unexpected outbound socket");
  });
  const previousAutoSelect = process.env.PROXY_AUTO_SELECT_ENABLED;
  process.env.PROXY_AUTO_SELECT_ENABLED = "true";
  try {
    assert.equal(
      await refresh.resolveProxyForCredentials("github", { connectionId: conn.id }),
      null
    );
    assert.equal(sends, 0);
    assert.equal(socketAttempts, 0, "refresh resolution must skip automatic fallback probes");
  } finally {
    if (previousAutoSelect === undefined) delete process.env.PROXY_AUTO_SELECT_ENABLED;
    else process.env.PROXY_AUTO_SELECT_ENABLED = previousAutoSelect;
  }
});

test("provider-only malformed assignment cannot fall through to a healthy global proxy", async () => {
  await settings.setProxyForLevel("provider", "github", { type: "http", port: 9412 });
  await settings.setProxyForLevel("global", null, { type: "http", host: "127.0.0.1", port: 9425 });
  await assert.rejects(refresh.resolveProxyForCredentials("github"), /PROXY_ASSIGNED_UNAVAILABLE/);
  assert.equal(sends, 0);
});
