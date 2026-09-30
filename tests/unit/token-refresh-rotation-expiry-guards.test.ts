import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-refresh-rotation-"));
process.env.DATA_DIR = dir;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.API_KEY_SECRET = "rotation-fixture-secret";
process.env.CODEX_REFRESH_SPACING_MS = "0";
process.env.OMNIROUTE_HIDE_HEALTHCHECK_LOGS = "true";
const core = await import("../../src/lib/db/core.ts");
const providers = await import("../../src/lib/db/providers.ts");
// These OAuth fixtures insert UUID ids; DB row helpers expose those ids as unknown.
type FixtureConnection = Awaited<ReturnType<typeof providers.createProviderConnection>> & {
  id: string;
};
const cache = await import("../../src/lib/db/readCache.ts");
const encryption = await import("../../src/lib/db/encryption.ts");
const refresh = await import("../../open-sse/services/tokenRefresh.ts");
const health = await import("../../src/lib/tokenHealthCheck.ts");
const { __resetRefreshSerializerForTest } =
  await import("../../open-sse/services/refreshSerializer.ts");
const realFetch = globalThis.fetch;
const log = { info() {}, warn() {}, error() {}, debug() {} };
test.afterEach(() => {
  globalThis.fetch = realFetch;
  refresh._clearTokenRotationMap();
  __resetRefreshSerializerForTest();
});
test.after(() => {
  core.resetDbInstance();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("serialized Layer 1 rechecks rotation made by a Layer 2 caller before posting a single-use token", async () => {
  const firstEntered = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const presented: string[] = [];
  globalThis.fetch = (async (_url, init) => {
    presented.push(new URLSearchParams(String(init?.body)).get("refresh_token") || "");
    if (presented.length === 1) {
      firstEntered.resolve();
      await releaseFirst.promise;
    }
    return Response.json({
      access_token: "rotated-access",
      refresh_token: "rotated-refresh",
      expires_in: 28800,
    });
  }) as typeof fetch;
  const layer2 = refresh.getAccessToken("claude", { refreshToken: "single-use-old" }, log);
  await firstEntered.promise;
  const layer1 = refresh.getAccessToken(
    "claude",
    { connectionId: "synthetic-waiter", refreshToken: "single-use-old" },
    log
  );
  releaseFirst.resolve();
  const results = await Promise.all([layer2, layer1]);
  assert.deepEqual(presented, ["single-use-old"]);
  for (const result of results) assert.equal(result?.refreshToken, "rotated-refresh");
});

for (const provider of ["codex", "claude"]) {
  test(`${provider} future numeric expiry skips rotation; near expiry refreshes`, async () => {
    let sends = 0;
    globalThis.fetch = (async () => {
      sends++;
      return Response.json({
        access_token: "numeric-new-access",
        refresh_token: `numeric-new-${provider}`,
        expires_in: 3600,
      });
    }) as typeof fetch;
    const conn = (await providers.createProviderConnection({
      provider,
      authType: "oauth",
      isActive: true,
      testStatus: "active",
      accessToken: "numeric-access",
      refreshToken: `numeric-old-${provider}`,
      expiresAt: String(Math.floor(Date.now() / 1000) + 86400),
    })) as FixtureConnection;
    await health.checkConnection(conn);
    assert.equal(sends, 0);
    await providers.updateProviderConnection(conn.id, {
      expiresAt: String(Date.now() - 1000),
      tokenExpiresAt: String(Date.now() - 1000),
    });
    await health.checkConnection((await providers.getProviderConnectionById(conn.id))!);
    assert.equal(sends, 1, "numeric TEXT expiry must not disable refresh on a rotating provider");
  });
}

test("Copilot numeric-string healthy expiry keeps the local interval; near expiry overrides it", async () => {
  let sends = 0;
  globalThis.fetch = (async () => {
    sends++;
    return Response.json({
      token: "new-copilot",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });
  }) as typeof fetch;
  const conn = (await providers.createProviderConnection({
    provider: "github",
    authType: "oauth",
    isActive: true,
    testStatus: "active",
    accessToken: "github-fixture",
    healthCheckInterval: 60,
    providerSpecificData: {
      copilotToken: "healthy-copilot",
      copilotTokenExpiresAt: String(Math.floor(Date.now() / 1000) + 3600),
    },
  })) as FixtureConnection;
  await providers.updateProviderConnection(conn.id, {
    lastHealthCheckAt: new Date().toISOString(),
  });
  await health.checkConnection(conn);
  assert.equal(sends, 0);
  await providers.updateProviderConnection(conn.id, {
    providerSpecificData: {
      copilotToken: "expiring-copilot",
      copilotTokenExpiresAt: String(Date.now() + 60_000),
    },
  });
  await health.checkConnection(conn);
  assert.equal(sends, 1);
});

test("unrecoverable refresh rereads past cached sweep credentials before clearing a rotated token", async () => {
  const conn = (await providers.createProviderConnection({
    provider: "codex",
    authType: "oauth",
    isActive: true,
    testStatus: "active",
    accessToken: "stale-access",
    refreshToken: "stale-refresh",
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  })) as FixtureConnection;
  await cache.getCachedProviderConnectionById(conn.id);
  globalThis.fetch = (async () => {
    // Simulate another process committing its new token without invalidating our read cache.
    core
      .getDbInstance()
      .prepare(
        "UPDATE provider_connections SET access_token = ?, refresh_token = ?, expires_at = ? WHERE id = ?"
      )
      .run(
        encryption.encrypt("fresh-access"),
        encryption.encrypt("fresh-refresh"),
        new Date(Date.now() + 86400_000).toISOString(),
        conn.id
      );
    return Response.json({ error: "invalid_grant" }, { status: 400 });
  }) as typeof fetch;
  await health.checkConnection(conn);
  const current = await providers.getProviderConnectionById(conn.id);
  assert.equal(current!.refreshToken, "fresh-refresh");
  assert.equal(current!.accessToken, "fresh-access");
  assert.equal(current!.testStatus, "active");
});

test("Claude unrecoverable refresh preserves its recovery token", async () => {
  const conn = (await providers.createProviderConnection({
    provider: "claude",
    authType: "oauth",
    isActive: true,
    testStatus: "active",
    accessToken: "expired-claude-access",
    refreshToken: "keep-claude-refresh",
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  })) as FixtureConnection;
  globalThis.fetch = (async () =>
    Response.json({ error: "invalid_grant" }, { status: 400 })) as typeof fetch;
  await health.checkConnection(conn);
  const current = await providers.getProviderConnectionById(conn.id);
  assert.equal(current!.refreshToken, "keep-claude-refresh");
  assert.equal(current!.testStatus, "expired");
});

test("expiry parser accepts seconds/ms/ISO and rejects unknown or unbounded values", async () => {
  const { parseTokenExpiryMs } = await import("../../open-sse/utils/tokenExpiry.ts");
  const ms = Date.parse("2026-09-29T00:00:00Z");
  for (const value of [ms, String(ms), ms / 1000, String(ms / 1000), " 2026-09-29T00:00:00Z "]) {
    assert.equal(parseTokenExpiryMs(value), ms);
  }
  assert.equal(parseTokenExpiryMs(1e12), 1e12);
  assert.equal(parseTokenExpiryMs("1000000000000"), 1e12);
  assert.equal(parseTokenExpiryMs(1e12 - 1), (1e12 - 1) * 1000);
  for (const value of [
    undefined,
    null,
    {},
    "",
    " ",
    "unknown",
    0,
    "0",
    -1,
    "-1",
    NaN,
    Infinity,
    "Infinity",
    1e308,
    "1e308",
  ]) {
    assert.equal(parseTokenExpiryMs(value), 0);
  }
});

test("unknown expiry does not burn rotating grants but retains non-rotating interval checks", async () => {
  let sends = 0;
  globalThis.fetch = (async () => {
    sends++;
    return Response.json({ access_token: "unknown-new", expires_in: 3600 });
  }) as typeof fetch;
  for (const provider of ["codex", "gemini"]) {
    const conn = await providers.createProviderConnection({
      provider,
      authType: "oauth",
      isActive: true,
      testStatus: "active",
      accessToken: `unknown-${provider}`,
      refreshToken: `unknown-refresh-${provider}`,
      expiresAt: "not-a-date",
      healthCheckInterval: 60,
    });
    await health.checkConnection(conn);
    assert.equal(sends, provider === "codex" ? 0 : 1);
  }
});

test("serialized refresh refuses DB-read uncertainty without posting the cached token", async () => {
  let sends = 0;
  globalThis.fetch = (async () => {
    sends++;
    return Response.json({ access_token: "unexpected", refresh_token: "unexpected-rotated" });
  }) as typeof fetch;
  core
    .getDbInstance()
    .prepare("ALTER TABLE provider_connections RENAME TO unavailable_fixture_connections")
    .run();
  try {
    const result = await refresh.getAccessToken(
      "claude",
      { connectionId: "fixture-unavailable", refreshToken: "must-not-post" },
      log
    );
    assert.equal(result, null);
    assert.equal(sends, 0);
  } finally {
    core
      .getDbInstance()
      .prepare("ALTER TABLE unavailable_fixture_connections RENAME TO provider_connections")
      .run();
  }
});
