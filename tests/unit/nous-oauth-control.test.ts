import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-nous-oauth-"));
process.env.DATA_DIR = dir;
process.env.API_KEY_SECRET ||= "nous-oauth-control-test-secret";
process.env.STORAGE_ENCRYPTION_KEY ||= "nous-oauth-control-test-encryption-key";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../src/lib/db/core.ts");
const db = await import("../../src/lib/db/providers.ts");
const readCache = await import("../../src/lib/db/readCache.ts");
const encryption = await import("../../src/lib/db/encryption.ts");
const settings = await import("../../src/lib/db/settings.ts");
const route = await import("../../src/app/api/oauth/[provider]/[action]/route.ts");
const oauth = await import("../../src/lib/oauth/providers/nous-oauth.ts");
const refresh = await import("../../open-sse/services/tokenRefresh.ts");
const { NOUS_OAUTH_CONFIG } = await import("../../src/lib/oauth/constants/oauth.ts");
const { NOUS_OAUTH_INFERENCE_PSD_KEY } = await import("../../open-sse/config/nousOAuth.ts");
const paid = "https://inference-api.nousresearch.com/v1";
const guest = "https://welcome-api.nousresearch.com/v1";
const realFetch = globalThis.fetch;

test.before(async () => { await settings.updateSettings({ requireLogin: false }); });
test.afterEach(() => { globalThis.fetch = realFetch; });
test.after(() => {
  core.resetDbInstance();
  fs.rmSync(dir, { recursive: true, force: true });
});

function deviceResponse(): Record<string, unknown> {
  return {
    device_code: "device-code-opaque", user_code: "USER-CODE",
    verification_uri: "https://portal.nousresearch.com/device",
    verification_uri_complete: "https://portal.nousresearch.com/device?user_code=USER-CODE",
    expires_in: 600, interval: 2,
  };
}
function request(action: string, body?: Record<string, unknown>, cookie?: string): Request {
  return new Request(`http://localhost/api/oauth/nous-oauth/${action}`, body ? {
    method: "POST", headers: {
      "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}),
    }, body: JSON.stringify(body),
  } : { headers: cookie ? { Cookie: cookie } : {} });
}
const context = (action: string) => ({ params: Promise.resolve({ provider: "nous-oauth", action }) });

async function createNousConnection(url = paid) {
  return db.createProviderConnection({
    provider: "nous-oauth", authType: "oauth", accessToken: "access-old",
    refreshToken: "refresh-old", expiresAt: new Date(Date.now() + 600_000).toISOString(),
    providerSpecificData: { [NOUS_OAUTH_INFERENCE_PSD_KEY]: url, other: "keep-me" },
  });
}

test("device POST uses Hermes form fields, fixed HTTPS portal, and no redirect or token import", async () => {
  globalThis.fetch = (async (url, init) => {
    assert.equal(String(url), NOUS_OAUTH_CONFIG.deviceCodeUrl);
    assert.equal(init?.method, "POST");
    assert.deepEqual([...new URLSearchParams(init?.body as URLSearchParams)], [
      ["client_id", "hermes-cli"], ["scope", "inference:invoke"],
    ]);
    return Response.json(deviceResponse());
  }) as typeof fetch;
  const result = await oauth.nousOAuth.requestDeviceCode(NOUS_OAUTH_CONFIG);
  assert.equal(result.device_code, "device-code-opaque");
  assert.throws(() => oauth.nousOAuth.mapTokens({
    access_token: "access", refresh_token: "refresh", expires_in: 600,
    inference_base_url: "https://inference-api.nousresearch.com.evil.test/v1",
  }), /Invalid/);
  assert.equal(oauth.nousOAuth.mapTokens({
    access_token: "access", refresh_token: "refresh", expires_in: 600,
  }).providerSpecificData[NOUS_OAUTH_INFERENCE_PSD_KEY], paid);
  assert.equal(oauth.nousOAuth.mapTokens({
    access_token: "access", refresh_token: "refresh", expires_in: 600,
    inference_base_url: guest,
  }).providerSpecificData[NOUS_OAUTH_INFERENCE_PSD_KEY], guest);
});

test("device response rejects unbounded and nonintegral timing fields", async () => {
  const cases = [
    { expires_in: 1e308 }, { expires_in: 1.5 }, { expires_in: "600" },
    { interval: 1e308 }, { interval: 0.5 }, { interval: "2" },
  ];
  for (const invalid of cases) {
    globalThis.fetch = (async () => Response.json({ ...deviceResponse(), ...invalid })) as typeof fetch;
    await assert.rejects(oauth.nousOAuth.requestDeviceCode(NOUS_OAUTH_CONFIG), /incomplete data/);
  }
});

test("device route enforces server poll interval, slow_down +5s, and rejects unissued flow IDs", async () => {
  let now = Date.now();
  const realNow = Date.now;
  Date.now = () => now;
  let polls = 0;
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith("/device/code")) return Response.json(deviceResponse());
    polls++;
    assert.equal(String(url), NOUS_OAUTH_CONFIG.tokenUrl);
    const form = init?.body as URLSearchParams;
    assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code");
    assert.equal(form.get("device_code"), "device-code-opaque");
    return Response.json({ error: "slow_down" }, { status: 400 });
  }) as typeof fetch;
  try {
    const start = await route.GET(request("device-code"), context("device-code"));
    assert.equal(start.status, 200);
    const device = await start.json();
    assert.ok(device.flowId);
    const cookie = start.headers.get("set-cookie")!.split(";", 1)[0];
    const payload = { deviceCode: device.device_code, extraData: { flowId: device.flowId } };
    assert.equal((await (await route.POST(request("poll", payload), context("poll"))).json()).error, "expired_token", "cross-session poll must fail");
    assert.equal((await (await route.POST(request("poll", { deviceCode: device.device_code, extraData: { flowId: "invalid" } }, cookie), context("poll"))).json()).error, "expired_token");
    assert.equal((await (await route.POST(request("poll", payload, cookie), context("poll"))).json()).pending, true);
    assert.equal(polls, 0);
    now += 2_000;
    const slow = await (await route.POST(request("poll", payload, cookie), context("poll"))).json();
    assert.equal(slow.error, "slow_down");
    assert.equal(polls, 1);
    now += 2_000;
    assert.equal((await (await route.POST(request("poll", payload, cookie), context("poll"))).json()).pending, true);
    assert.equal(polls, 1);
    now += 5_000;
    assert.equal((await (await route.POST(request("poll", payload, cookie), context("poll"))).json()).error, "slow_down");
    assert.equal(polls, 2);
  } finally {
    Date.now = realNow;
  }
});

test("reauth ticket rejects foreign provider row, cross-session poll, and changed connection ID", async () => {
  const own = await createNousConnection();
  const foreign = await db.createProviderConnection({ provider: "nous-research", authType: "apikey", apiKey: "test-foreign-key" });
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  let calls = 0;
  globalThis.fetch = (async (url) => {
    calls++;
    if (String(url).endsWith("/device/code")) return Response.json(deviceResponse());
    return Response.json({
      access_token: "access-reauth", refresh_token: "refresh-reauth", expires_in: 600,
      inference_base_url: guest,
    });
  }) as typeof fetch;
  try {
    const invalid = await route.GET(new Request(`http://localhost/api/oauth/nous-oauth/device-code?connectionId=${foreign.id}`), context("device-code"));
    assert.equal(invalid.status, 400);
    assert.equal(calls, 0, "foreign account must be rejected before any upstream request");
    const start = await route.GET(new Request(`http://localhost/api/oauth/nous-oauth/device-code?connectionId=${own.id}`), context("device-code"));
    const device = await start.json();
    const cookie = start.headers.get("set-cookie")!.split(";", 1)[0];
    const payload = { deviceCode: device.device_code, connectionId: own.id, extraData: { flowId: device.flowId } };
    now += 2_000;
    const wrong = await route.POST(request("poll", { ...payload, connectionId: foreign.id }, cookie), context("poll"));
    assert.equal((await wrong.json()).error, "expired_token");
    const absentCookie = await route.POST(request("poll", payload), context("poll"));
    assert.equal((await absentCookie.json()).error, "expired_token");
    assert.equal(calls, 1, "session/connection mismatch must not hit token endpoint");
    const approved = await route.POST(request("poll", payload, cookie), context("poll"));
    assert.equal((await approved.json()).success, true);
    const row = await db.getProviderConnectionById(own.id);
    assert.equal(row?.accessToken, "access-reauth");
    assert.equal(row?.providerSpecificData?.[NOUS_OAUTH_INFERENCE_PSD_KEY], guest);
    assert.equal((await db.getProviderConnectionById(foreign.id))?.apiKey, "test-foreign-key");
    const replay = await route.POST(request("poll", payload, cookie), context("poll"));
    assert.equal((await replay.json()).error, "expired_token", "flow ticket is one-use");
  } finally {
    Date.now = realNow;
  }
});

test("stored OAuth row hydrates without an API key or extra key aliases", async () => {
  const conn = await createNousConnection();
  const { getProviderCredentials } = await import("../../src/sse/services/auth.ts");
  const selected = await getProviderCredentials("nous-oauth", null, [conn.id]);
  assert.equal(selected?.connectionId, conn.id);
  assert.equal(selected?.apiKey, null);
  assert.equal(selected?.extraApiKeys, undefined);
  assert.equal(selected?.accessToken, "access-old");
  assert.equal(selected?.providerSpecificData?.[NOUS_OAUTH_INFERENCE_PSD_KEY], paid);
});

test("refresh sends single-use token in header only; encrypted DB CAS persists pair + guest URL", async () => {
  const connection = await createNousConnection();
  let calls = 0;
  globalThis.fetch = (async (url, init) => {
    calls++;
    assert.equal(String(url), NOUS_OAUTH_CONFIG.tokenUrl);
    assert.equal((init?.headers as Record<string, string>)["x-nous-refresh-token"], "refresh-old");
    assert.deepEqual([...new URLSearchParams(init?.body as URLSearchParams)], [
      ["grant_type", "refresh_token"], ["client_id", "hermes-cli"],
    ]);
    assert.equal(String(init?.body).includes("refresh-old"), false);
    return Response.json({
      access_token: "access-new", refresh_token: "refresh-new", expires_in: 3600,
      inference_base_url: guest,
    });
  }) as typeof fetch;
  const creds = { connectionId: connection.id, accessToken: "access-old", refreshToken: "refresh-old" };
  const result = await refresh.getAccessToken("nous-oauth", creds, null);
  assert.equal(result?.accessToken, "access-new");
  assert.equal(result?.providerSpecificData[NOUS_OAUTH_INFERENCE_PSD_KEY], guest);
  const row = await db.getProviderConnectionById(connection.id);
  assert.equal(row?.accessToken, "access-new");
  assert.equal(row?.refreshToken, "refresh-new");
  const raw = core.getDbInstance().prepare("SELECT access_token, refresh_token FROM provider_connections WHERE id = ?").get(connection.id);
  assert.match(raw.access_token, /^enc:v1:/);
  assert.match(raw.refresh_token, /^enc:v1:/);
  assert.equal(raw.refresh_token.includes("refresh-new"), false);
  assert.equal(row?.providerSpecificData?.[NOUS_OAUTH_INFERENCE_PSD_KEY], guest);
  assert.equal(row?.providerSpecificData?.other, "keep-me");
  const stale = await refresh.getAccessToken("nous-oauth", creds, null);
  assert.equal(stale?.accessToken, "access-new");
  assert.equal(calls, 1, "a failed old bearer must re-read DB, never re-spend an old refresh token");
});

test("portal redirects are never followed for device and refresh POST", async () => {
  const conn = await createNousConnection();
  let calls = 0;
  globalThis.fetch = (async (_url, init) => {
    calls++;
    assert.equal(init?.redirect, "manual");
    return new Response(null, { status: 302, headers: { location: "https://attacker.invalid/steal" } });
  }) as typeof fetch;
  await assert.rejects(oauth.nousOAuth.requestDeviceCode(NOUS_OAUTH_CONFIG), /redirected/);
  await assert.rejects(oauth.nousOAuth.pollToken(NOUS_OAUTH_CONFIG, "device-code"), /redirected/);
  const result = await refresh.getAccessToken("nous-oauth", {
    connectionId: conn.id, accessToken: "access-old", refreshToken: "refresh-old",
  }, null);
  assert.equal(result, null);
  assert.equal(calls, 3, "each method makes one request; no redirect leaks credentials");
  assert.equal((await db.getProviderConnectionById(conn.id))?.refreshToken, "refresh-old");
});

test("unsafe refresh metadata cannot discard rotated tokens or their previous binding", async () => {
  const conn = await createNousConnection();
  globalThis.fetch = (async () => Response.json({
    access_token: "access-rotated", refresh_token: "refresh-rotated", expires_in: 1800,
    inference_base_url: "https://attacker.invalid/v1",
  })) as typeof fetch;
  const result = await refresh.getAccessToken("nous-oauth", {
    connectionId: conn.id, accessToken: "access-old", refreshToken: "refresh-old",
  }, null);
  assert.equal(result?.accessToken, "access-rotated");
  assert.equal(result?.providerSpecificData?.[NOUS_OAUTH_INFERENCE_PSD_KEY], paid);
  assert.equal((await db.getProviderConnectionById(conn.id))?.refreshToken, "refresh-rotated");
});

test("NO_PROXY cannot leak a pinned Nous refresh token by forcing direct egress", async () => {
  const conn = await createNousConnection();
  const previousNoProxy = process.env.NO_PROXY;
  const previousFallback = process.env.OMNIROUTE_CONTROL_PLANE_PROXY_DIRECT_FALLBACK;
  process.env.NO_PROXY = "portal.nousresearch.com";
  process.env.OMNIROUTE_CONTROL_PLANE_PROXY_DIRECT_FALLBACK = "true";
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return Response.json({}); }) as typeof fetch;
  try {
    const result = await refresh.getAccessToken("nous-oauth", {
      connectionId: conn.id, accessToken: "access-old", refreshToken: "refresh-old",
    }, null, { type: "http", host: "127.0.0.1", port: 9 });
    assert.equal(result, null);
    assert.equal(calls, 0, "pinned proxy with NO_PROXY must fail before a direct POST");
  } finally {
    if (previousNoProxy === undefined) delete process.env.NO_PROXY;
    else process.env.NO_PROXY = previousNoProxy;
    if (previousFallback === undefined) delete process.env.OMNIROUTE_CONTROL_PLANE_PROXY_DIRECT_FALLBACK;
    else process.env.OMNIROUTE_CONTROL_PLANE_PROXY_DIRECT_FALLBACK = previousFallback;
  }
});

test("never-ending 429/403 bodies stop at five seconds without losing credentials", async () => {
  const conn = await createNousConnection();
  // Both methods POST /api/oauth/token; separate mocks by header grant type.
  globalThis.fetch = (async (_url, init) => {
    const stalled = new ReadableStream({ start() { /* intentionally never close */ } });
    return (init?.headers as Record<string, string>)["x-nous-refresh-token"]
      ? new Response(stalled, { status: 429 })
      : new Response(stalled, { status: 403, headers: { "x-vercel-mitigated": "challenge" } });
  }) as typeof fetch;
  const started = performance.now();
  const [refreshed, polled] = await Promise.all([
    refresh.getAccessToken("nous-oauth", { connectionId: conn.id,
      accessToken: "access-old", refreshToken: "refresh-old" }, null),
    oauth.nousOAuth.pollToken(NOUS_OAUTH_CONFIG, "opaque-device-code"),
  ]);
  assert.ok(performance.now() - started < 8000, "body read must be bounded, not hang indefinitely");
  assert.equal(refreshed, null);
  assert.equal(polled.data.error, "temporarily_unavailable");
  assert.equal((await db.getProviderConnectionById(conn.id))?.refreshToken, "refresh-old");
});

test("refresh lease blocks duplicate upstream POST and invalid_grant is terminal only while unrotated", async () => {
  const connection = await createNousConnection();
  const owner = "other-process";
  const held = db.acquireNousOAuthRefreshLease(connection.id, "refresh-old", owner);
  assert.equal(held.status, "acquired");
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return Response.json({ error: "invalid_grant" }, { status: 400 }); }) as typeof fetch;
  const creds = { connectionId: connection.id, accessToken: "access-old", refreshToken: "refresh-old" };
  try {
    assert.equal(await refresh.getAccessToken("nous-oauth", creds, null), null);
    assert.equal(calls, 0, "existing DB lease prevents the duplicate grant");
  } finally {
    if (held.status === "acquired") db.releaseNousOAuthRefreshLease(connection.id, held.leaseOwner);
  }
  assert.deepEqual(await refresh.getAccessToken("nous-oauth", creds, null), {
    error: "unrecoverable_refresh_error", code: "invalid_grant",
  });
  assert.equal(calls, 1);
  const transient = await createNousConnection();
  globalThis.fetch = (async () => { calls++; return new Response("WAF", { status: 403, headers: { "x-vercel-mitigated": "challenge" } }); }) as typeof fetch;
  const transientCreds = { connectionId: transient.id, accessToken: "access-old", refreshToken: "refresh-old" };
  assert.equal(await refresh.getAccessToken("nous-oauth", transientCreds, null), null);
  const row = await db.getProviderConnectionById(transient.id);
  assert.equal(row?.isActive, true);
  assert.equal(row?.refreshToken, "refresh-old");
  assert.equal(await refresh.getAccessToken("nous-oauth", transientCreds, null), null);
  assert.equal(await refresh.getAccessToken("nous-oauth", { refreshToken: "refresh-old" }, null), null);
  assert.equal(calls, 2, "WAF ambiguity is quarantined; connectionId-less refresh never POSTs");
});

test("uncertain single-use POST stays quarantined across clock jump; late original response can commit", async () => {
  const conn = await createNousConnection();
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  let settle!: (response: Response) => void;
  let started!: () => void;
  const invoked = new Promise<void>((resolve) => { started = resolve; });
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    started();
    return new Promise<Response>((resolve) => { settle = resolve; });
  }) as typeof fetch;
  const creds = { connectionId: conn.id, accessToken: "access-old", refreshToken: "refresh-old" };
  try {
    const original = refresh.getAccessToken("nous-oauth", creds, null);
    await invoked;
    now += 91_000; // longer than a normal lease, without any wall-clock sleep
    assert.equal(await refresh.getAccessToken("nous-oauth", creds, null), null);
    assert.equal(calls, 1, "second process cannot POST same token after lease window");
    settle(Response.json({ access_token: "access-late", refresh_token: "refresh-late",
      expires_in: 3600, inference_base_url: guest }));
    const first = await original;
    assert.equal(first?.accessToken, "access-late");
    assert.equal((await db.getProviderConnectionById(conn.id))?.refreshToken, "refresh-late");
    assert.equal((await refresh.getAccessToken("nous-oauth", creds, null))?.accessToken, "access-late");
    assert.equal(calls, 1);
  } finally {
    Date.now = realNow;
  }
});

test("unresolved grant is reconciled only after explicit reauth rotates DB refresh token", async () => {
  const conn = await createNousConnection();
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return Response.json({ error: "temporarily_unavailable" }, { status: 503 });
  }) as typeof fetch;
  const old = { connectionId: conn.id, accessToken: "access-old", refreshToken: "refresh-old" };
  try {
    assert.equal(await refresh.getAccessToken("nous-oauth", old, null), null);
    now += 180_000;
    assert.equal(await refresh.getAccessToken("nous-oauth", old, null), null);
    assert.equal(calls, 1, "unknown outcome remains quarantined past normal lease");
    await db.updateProviderConnection(conn.id, {
      accessToken: "access-reauth", refreshToken: "refresh-reauth",
      expiresAt: new Date(now + 3600_000).toISOString(),
    });
    assert.equal((await refresh.getAccessToken("nous-oauth", old, null))?.accessToken, "access-reauth");
    globalThis.fetch = (async (_url, init) => {
      calls++;
      assert.equal((init?.headers as Record<string, string>)["x-nous-refresh-token"], "refresh-reauth");
      return Response.json({ access_token: "access-next", refresh_token: "refresh-next", expires_in: 3600 });
    }) as typeof fetch;
    const newer = await refresh.getAccessToken("nous-oauth", {
      connectionId: conn.id, accessToken: "access-reauth", refreshToken: "refresh-reauth",
    }, null);
    assert.equal(newer?.accessToken, "access-next");
    assert.equal(calls, 2);
  } finally {
    Date.now = realNow;
  }
});

test("health sweep never rewrites an already-rotated Nous token or guest URL", async () => {
  const conn = await createNousConnection();
  const health = await import("../../src/lib/tokenHealthCheck.ts");
  const snapshot = await db.getProviderConnectionById(conn.id);
  assert.equal(refresh.isSelfPersistedOAuthProvider("nous-oauth"), true);
  assert.equal(db.updateNousOAuthHealthIfRefreshUnchanged(conn.id, "refresh-old", "success"), true);
  await db.updateProviderConnection(conn.id, {
    accessToken: "access-401", refreshToken: "refresh-401",
    providerSpecificData: { [NOUS_OAUTH_INFERENCE_PSD_KEY]: guest, other: "keep-me" },
  });
  assert.equal(db.updateNousOAuthHealthIfRefreshUnchanged(conn.id, "refresh-old", "invalid_grant"), false);
  assert.equal(db.updateNousOAuthHealthIfRefreshUnchanged(conn.id, "refresh-old", "success"), false);
  let fetches = 0;
  globalThis.fetch = (async () => { fetches++; return Response.json({}); }) as typeof fetch;
  await db.updateProviderConnection(conn.id, { expiresAt: null, tokenExpiresAt: null });
  await health.checkConnection(snapshot);
  const newest = await db.getProviderConnectionById(conn.id);
  assert.equal(newest?.accessToken, "access-401");
  assert.equal(newest?.refreshToken, "refresh-401");
  assert.equal(newest?.providerSpecificData?.[NOUS_OAUTH_INFERENCE_PSD_KEY], guest);
  assert.equal(newest?.isActive, true);
  assert.equal(fetches, 0, "missing expiry never triggers interval-only single-use grant");
});

function simulateSecondProcessNousReauth(id: string) {
  // Direct SQLite is the equivalent of a second process: this process's
  // 5-second getCachedProviderConnectionById entry remains stale.
  const encrypted = encryption.encryptConnectionFields({
    accessToken: "access-reauth", refreshToken: "refresh-reauth",
  });
  core.getDbInstance().prepare(`UPDATE provider_connections SET access_token = ?,
    refresh_token = ?, provider_specific_data = ?, test_status = 'active',
    is_active = 1, last_error = NULL, updated_at = ? WHERE id = ?`).run(
      encrypted.accessToken, encrypted.refreshToken,
      JSON.stringify({ [NOUS_OAUTH_INFERENCE_PSD_KEY]: guest, other: "kept-after-reauth" }),
      new Date().toISOString(), id
    );
}

test("stale cached no-refresh Nous sweep cannot expire a cross-process reauth", async () => {
  const health = await import("../../src/lib/tokenHealthCheck.ts");
  const conn = await createNousConnection();
  await db.updateProviderConnection(conn.id, { refreshToken: null });
  const stale = await db.getProviderConnectionById(conn.id);
  assert.ok(!stale?.refreshToken);
  assert.ok(!(await readCache.getCachedProviderConnectionById(conn.id))?.refreshToken);
  simulateSecondProcessNousReauth(conn.id);
  assert.ok(!(await readCache.getCachedProviderConnectionById(conn.id))?.refreshToken);
  let sends = 0;
  globalThis.fetch = (async () => { sends++; return Response.json({}); }) as typeof fetch;
  await health.checkConnection(stale);
  const newest = await db.getProviderConnectionById(conn.id);
  assert.equal(newest?.refreshToken, "refresh-reauth");
  assert.equal(newest?.accessToken, "access-reauth");
  assert.equal(newest?.testStatus, "active");
  assert.equal(newest?.isActive, true);
  assert.equal(newest?.providerSpecificData?.[NOUS_OAUTH_INFERENCE_PSD_KEY], guest);
  assert.equal(newest?.providerSpecificData?.other, "kept-after-reauth");
  assert.equal(sends, 0);
});

test("stale expired/max-retry Nous sweep cannot deactivate a cross-process reauth", async () => {
  const health = await import("../../src/lib/tokenHealthCheck.ts");
  const conn = await createNousConnection();
  await db.updateProviderConnection(conn.id, {
    testStatus: "expired", lastErrorType: "invalid_grant",
    providerSpecificData: {
      [NOUS_OAUTH_INFERENCE_PSD_KEY]: paid, expiredRetryCount: 3,
      expiredRetryAt: new Date().toISOString(),
    },
  });
  const stale = await db.getProviderConnectionById(conn.id);
  await readCache.getCachedProviderConnectionById(conn.id);
  simulateSecondProcessNousReauth(conn.id);
  let sends = 0;
  globalThis.fetch = (async () => { sends++; return Response.json({}); }) as typeof fetch;
  await health.checkConnection(stale);
  const newest = await db.getProviderConnectionById(conn.id);
  assert.equal(newest?.testStatus, "active");
  assert.equal(newest?.isActive, true);
  assert.equal(newest?.refreshToken, "refresh-reauth");
  assert.equal(newest?.providerSpecificData?.[NOUS_OAUTH_INFERENCE_PSD_KEY], guest);
  assert.equal(sends, 0);
});

test("manual refresh trusts committed Nous CAS and stale invalid_grant cannot deactivate newer bearer", async () => {
  const manual = await import("../../src/app/api/providers/[id]/refresh/route.ts");
  const conn = await createNousConnection();
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return Response.json({ access_token: "access-manual", refresh_token: "refresh-manual",
      expires_in: 3600, inference_base_url: guest });
  }) as typeof fetch;
  const makeRequest = () => new Request(`http://localhost/api/providers/${conn.id}/refresh`, { method: "POST" });
  const first = await manual.POST(makeRequest(), { params: Promise.resolve({ id: conn.id }) });
  assert.equal((await first.json()).success, true);
  const committed = await db.getProviderConnectionById(conn.id);
  assert.equal(committed?.refreshToken, "refresh-manual");
  assert.equal(committed?.providerSpecificData?.[NOUS_OAUTH_INFERENCE_PSD_KEY], guest);
  let settle!: (response: Response) => void;
  let started!: () => void;
  const invoked = new Promise<void>((resolve) => { started = resolve; });
  globalThis.fetch = (async () => {
    calls++; started();
    return new Promise<Response>((resolve) => { settle = resolve; });
  }) as typeof fetch;
  const pending = manual.POST(makeRequest(), { params: Promise.resolve({ id: conn.id }) });
  await invoked;
  await db.updateProviderConnection(conn.id, {
    accessToken: "access-401-newer", refreshToken: "refresh-401-newer",
    providerSpecificData: { [NOUS_OAUTH_INFERENCE_PSD_KEY]: paid },
  });
  settle(Response.json({ error: "invalid_grant" }, { status: 400 }));
  const response = await pending;
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal((await db.getProviderConnectionById(conn.id))?.accessToken, "access-401-newer");
  assert.equal((await db.getProviderConnectionById(conn.id))?.testStatus, "active");
  assert.equal(calls, 2);
});

test("proactive wrapper keeps paid/guest binding on both rotation directions", async () => {
  const wrapper = await import("../../src/sse/services/tokenRefresh.ts");
  const conn = await createNousConnection(paid);
  await db.updateProviderConnection(conn.id, {
    expiresAt: new Date(Date.now() + 10_000).toISOString(),
    tokenExpiresAt: new Date(Date.now() + 10_000).toISOString(),
  });
  let next = guest;
  globalThis.fetch = (async (_url, init) => {
    assert.equal(init?.redirect, "manual");
    assert.equal((init?.headers as Record<string, string>)["x-nous-refresh-token"],
      next === guest ? "refresh-old" : "refresh-next-guest");
    return Response.json({ access_token: `access-${next}`, refresh_token: `refresh-next-${next === guest ? "guest" : "paid"}`,
      expires_in: next === guest ? 1 : 3600, inference_base_url: next });
  }) as typeof fetch;
  const first = await wrapper.checkAndRefreshToken("nous-oauth", {
    connectionId: conn.id, accessToken: "access-old", refreshToken: "refresh-old",
    expiresAt: new Date(Date.now() + 10_000).toISOString(),
    providerSpecificData: { [NOUS_OAUTH_INFERENCE_PSD_KEY]: paid },
  });
  assert.equal(first?.providerSpecificData?.[NOUS_OAUTH_INFERENCE_PSD_KEY], guest);
  next = paid;
  const second = await wrapper.checkAndRefreshToken("nous-oauth", first);
  assert.equal(second?.providerSpecificData?.[NOUS_OAUTH_INFERENCE_PSD_KEY], paid);
  assert.equal((await db.getProviderConnectionById(conn.id))?.providerSpecificData?.[NOUS_OAUTH_INFERENCE_PSD_KEY], paid);
});

test("inherited edge relay cannot receive Nous refresh header or device code", async () => {
  const { runWithProxyContext } = await import("../../open-sse/utils/proxyFetch.ts");
  const conn = await createNousConnection();
  let sends = 0;
  globalThis.fetch = (async () => { sends++; return Response.json({}); }) as typeof fetch;
  const relay = { type: "vercel", host: "relay.invalid", relayAuth: "mock-secret" };
  await runWithProxyContext(relay, async () => {
    const refreshed = await refresh.getAccessToken("nous-oauth", {
      connectionId: conn.id, accessToken: "access-old", refreshToken: "refresh-old",
    }, null);
    assert.equal(refreshed, null);
    const device = await route.GET(request("device-code"), context("device-code"));
    assert.equal(device.status, 502, "inherited relay is rejected without upstream send");
  }, { skipUnreachableProbe: true });
  assert.equal(sends, 0, "neither refresh header nor device grant reached an edge relay");
});

test("proxy family precheck rejection sends zero grants and releases ordinary lease", async () => {
  const conn = await createNousConnection();
  const dns = (await import("node:dns/promises")).default;
  const originalLookup = dns.lookup;
  const { __clearFamilyCheckCacheForTest } = await import("../../open-sse/utils/proxyFamilyResolve.ts");
  dns.lookup = (async () => [{ address: "127.0.0.1", family: 4 }]) as typeof dns.lookup;
  __clearFamilyCheckCacheForTest();
  let posts = 0;
  globalThis.fetch = (async () => { posts++; return Response.json({}); }) as typeof fetch;
  try {
    const credentials = { connectionId: conn.id, accessToken: "access-old", refreshToken: "refresh-old" };
    const assigned = { type: "http", host: "proxy.example.test", port: 8080, family: "ipv6" };
    assert.equal(await refresh.getAccessToken("nous-oauth", credentials, null, assigned), null);
    assert.equal(posts, 0);
    const available = db.acquireNousOAuthRefreshLease(conn.id, "refresh-old", "second-attempt");
    assert.equal(available.status, "acquired", "precheck has not quarantined an unsent token");
    if (available.status === "acquired") db.releaseNousOAuthRefreshLease(conn.id, available.leaseOwner);
  } finally {
    dns.lookup = originalLookup;
    __clearFamilyCheckCacheForTest();
  }
});

test("missing expiry in proactive wrapper does not burn a single-use grant", async () => {
  const wrapper = await import("../../src/sse/services/tokenRefresh.ts");
  const conn = await createNousConnection();
  await db.updateProviderConnection(conn.id, { expiresAt: null, tokenExpiresAt: null });
  let sends = 0;
  globalThis.fetch = (async () => { sends++; return Response.json({}); }) as typeof fetch;
  const result = await wrapper.checkAndRefreshToken("nous-oauth", {
    connectionId: conn.id, accessToken: "access-old", refreshToken: "refresh-old",
    providerSpecificData: { [NOUS_OAUTH_INFERENCE_PSD_KEY]: paid },
  });
  assert.equal(result?.accessToken, "access-old");
  assert.equal(result?.providerSpecificData?.[NOUS_OAUTH_INFERENCE_PSD_KEY], paid);
  assert.equal(sends, 0);
});

test("assigned proxy cannot silently direct-fallback device start or poll", async () => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  let sends = 0;
  globalThis.fetch = (async () => { sends++; return Response.json(deviceResponse()); }) as typeof fetch;
  const first = await route.GET(request("device-code"), context("device-code"));
  const flow = await first.json();
  const cookie = first.headers.get("set-cookie")!.split(";", 1)[0];
  const previousNoProxy = process.env.NO_PROXY;
  const previousFallback = process.env.OMNIROUTE_CONTROL_PLANE_PROXY_DIRECT_FALLBACK;
  process.env.NO_PROXY = "portal.nousresearch.com";
  process.env.OMNIROUTE_CONTROL_PLANE_PROXY_DIRECT_FALLBACK = "true";
  const assigned = { type: "http", host: "127.0.0.1", port: "9" };
  try {
    await settings.setProxyForLevel("provider", "nous-oauth", assigned);
    const start = await route.GET(request("device-code"), context("device-code"));
    assert.equal(start.status, 502);
    now += 2_000;
    const poll = await route.POST(request("poll", {
      deviceCode: flow.device_code, extraData: { flowId: flow.flowId },
    }, cookie), context("poll"));
    assert.equal((await poll.json()).error, "temporarily_unavailable");
    assert.equal(sends, 1, "only pre-assignment device start may send upstream");
  } finally {
    await settings.setProxyForLevel("provider", "nous-oauth", null);
    Date.now = realNow;
    if (previousNoProxy === undefined) delete process.env.NO_PROXY;
    else process.env.NO_PROXY = previousNoProxy;
    if (previousFallback === undefined) delete process.env.OMNIROUTE_CONTROL_PLANE_PROXY_DIRECT_FALLBACK;
    else process.env.OMNIROUTE_CONTROL_PLANE_PROXY_DIRECT_FALLBACK = previousFallback;
  }
});

test("assigned edge relay is refused before a portal start POST", async () => {
  let sends = 0;
  globalThis.fetch = (async () => { sends++; return Response.json(deviceResponse()); }) as typeof fetch;
  try {
    await settings.setProxyForLevel("provider", "nous-oauth", {
      type: "vercel", host: "relay.invalid", port: "443",
    });
    const result = await route.GET(request("device-code"), context("device-code"));
    assert.equal(result.status, 503);
    assert.equal(sends, 0);
  } finally {
    await settings.setProxyForLevel("provider", "nous-oauth", null);
  }
});

test("SOCKS-only assignment blocks device start, poll, and refresh before secret egress", async () => {
  const conn = await createNousConnection();
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  let sends = 0;
  globalThis.fetch = (async () => { sends++; return Response.json(deviceResponse()); }) as typeof fetch;
  const first = await route.GET(request("device-code"), context("device-code"));
  const flow = await first.json();
  const cookie = first.headers.get("set-cookie")!.split(";", 1)[0];
  const socks = { type: "socks5", host: "127.0.0.1", port: "1080" };
  try {
    await settings.setProxyForLevel("provider", "nous-oauth", socks);
    const start = await route.GET(request("device-code"), context("device-code"));
    assert.equal(start.status, 503);
    assert.match((await start.json()).error, /SOCKS egress is not validated/);
    now += 2_000;
    const poll = await route.POST(request("poll", {
      deviceCode: flow.device_code, extraData: { flowId: flow.flowId },
    }, cookie), context("poll"));
    assert.equal(poll.status, 503);
    assert.equal((await poll.json()).error, "unsupported_proxy");
    assert.equal(await refresh.getAccessToken("nous-oauth", {
      connectionId: conn.id, accessToken: "access-old", refreshToken: "refresh-old",
    }, null, socks), null);
    assert.equal(sends, 1, "only the initial unassigned device start reached portal");
  } finally {
    await settings.setProxyForLevel("provider", "nous-oauth", null);
    Date.now = realNow;
  }
});

test("environment SOCKS proxy is rejected at effective egress before every portal POST", async () => {
  const conn = await createNousConnection();
  const names = ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"] as const;
  const prior = new Map(names.map((name) => [name, process.env[name]]));
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  let sends = 0;
  globalThis.fetch = (async () => { sends++; return Response.json(deviceResponse()); }) as typeof fetch;
  const initial = await route.GET(request("device-code"), context("device-code"));
  const flow = await initial.json();
  const cookie = initial.headers.get("set-cookie")!.split(";", 1)[0];
  try {
    for (const name of names) delete process.env[name];
    process.env.HTTPS_PROXY = "socks5://127.0.0.1:1080";
    const start = await route.GET(request("device-code"), context("device-code"));
    assert.equal(start.status, 502);
    now += 2_000;
    const poll = await route.POST(request("poll", {
      deviceCode: flow.device_code, extraData: { flowId: flow.flowId },
    }, cookie), context("poll"));
    assert.equal((await poll.json()).error, "temporarily_unavailable");
    const refreshed = await refresh.getAccessToken("nous-oauth", {
      connectionId: conn.id, accessToken: "access-old", refreshToken: "refresh-old",
    }, null);
    assert.equal(refreshed, null);
    assert.equal(sends, 1, "only the pre-SOCKS initial device start was sent");
    const retry = db.acquireNousOAuthRefreshLease(conn.id, "refresh-old", "after-unsent-env-socks");
    assert.equal(retry.status, "acquired", "no grant was attempted or quarantined");
    if (retry.status === "acquired") db.releaseNousOAuthRefreshLease(conn.id, retry.leaseOwner);
  } finally {
    Date.now = realNow;
    for (const name of names) {
      const original = prior.get(name);
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    }
  }
});

// Keep the cap test last: its four live tickets intentionally remain pending.
test("process-local flow tickets cap per browser session BEFORE a fifth upstream POST", async () => {
  let upstreamCalls = 0;
  globalThis.fetch = (async () => { upstreamCalls++; return Response.json(deviceResponse()); }) as typeof fetch;
  const first = await route.GET(request("device-code"), context("device-code"));
  assert.equal(first.status, 200);
  const cookie = first.headers.get("set-cookie")!.split(";", 1)[0];
  for (let i = 0; i < 3; i++) {
    const next = await route.GET(request("device-code", undefined, cookie), context("device-code"));
    assert.equal(next.status, 200);
  }
  const denied = await route.GET(request("device-code", undefined, cookie), context("device-code"));
  assert.equal(denied.status, 429);
  assert.equal(upstreamCalls, 4);
});

test("public-origin poll and bound cancellation work behind a reverse proxy", async () => {
  const previous = process.env.OMNIROUTE_PUBLIC_BASE_URL;
  process.env.OMNIROUTE_PUBLIC_BASE_URL = "https://dashboard.example.test";
  globalThis.fetch = (async () => Response.json(deviceResponse())) as typeof fetch;
  try {
    const start = await route.GET(request("device-code"), context("device-code"));
    const device = await start.json();
    const cookie = start.headers.get("set-cookie")!.split(";", 1)[0];
    const payload = {
      deviceCode: device.device_code,
      extraData: { flowId: device.flowId },
    };
    const browserRequest = (action: string, origin: string, binding = cookie) => {
      const req = request(action, payload, binding);
      req.headers.set("origin", origin);
      req.headers.set("x-forwarded-host", new URL(origin).host);
      req.headers.set("x-forwarded-proto", "https");
      return req;
    };
    const publicPoll = await route.POST(
      browserRequest("poll", "https://dashboard.example.test"),
      context("poll")
    );
    assert.equal(publicPoll.status, 200);
    assert.equal((await publicPoll.json()).pending, true);
    const hostile = browserRequest("cancel", "https://evil.example.test");
    assert.equal((await route.POST(hostile, context("cancel"))).status, 403);
    const crossSite = browserRequest("cancel", "https://dashboard.example.test");
    crossSite.headers.set("sec-fetch-site", "cross-site");
    assert.equal((await route.POST(crossSite, context("cancel"))).status, 403);
    await route.POST(
      browserRequest("cancel", "https://dashboard.example.test", "nous_oauth_flow_session=foreign"),
      context("cancel")
    );
    assert.equal(
      (await (await route.POST(request("poll", payload, cookie), context("poll"))).json()).pending,
      true
    );
    assert.equal(
      (
        await route.POST(
          browserRequest("cancel", "https://dashboard.example.test"),
          context("cancel")
        )
      ).status,
      200
    );
    assert.equal(
      (await (await route.POST(request("poll", payload, cookie), context("poll"))).json()).error,
      "expired_token"
    );
    // Canceled attempts must release the per-session slot on every retry.
    for (let i = 0; i < 6; i++) {
      const retry = await route.GET(
        request("device-code", undefined, cookie),
        context("device-code")
      );
      assert.equal(retry.status, 200);
      const data = await retry.json();
      await route.POST(
        request(
          "cancel",
          { deviceCode: data.device_code, extraData: { flowId: data.flowId } },
          cookie
        ),
        context("cancel")
      );
    }
  } finally {
    if (previous === undefined) delete process.env.OMNIROUTE_PUBLIC_BASE_URL;
    else process.env.OMNIROUTE_PUBLIC_BASE_URL = previous;
  }
});

test("concurrent device starts reserve slots before contacting Nous", async () => {
  const cookie = "nous_oauth_flow_session=concurrent-start-test";
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = 0;
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  globalThis.fetch = (async () => {
    entered++;
    if (entered === 4) ready();
    await gate;
    return Response.json(deviceResponse());
  }) as typeof fetch;
  const starts = Array.from({ length: 4 }, () =>
    route.GET(request("device-code", undefined, cookie), context("device-code"))
  );
  await started;
  // Release upstream after allowing the fifth start to reach its admission check.
  const fifth = route.GET(request("device-code", undefined, cookie), context("device-code"));
  setImmediate(release);
  const denied = await fifth;
  const responses = await Promise.all(starts);
  try {
    assert.equal(denied.status, 429);
    assert.equal(entered, 4);
  } finally {
    for (const response of [...responses, denied]) {
      const data = await response.json();
      if (data.flowId)
        await route.POST(
          request(
            "cancel",
            {
              deviceCode: data.device_code,
              extraData: { flowId: data.flowId },
            },
            cookie
          ),
          context("cancel")
        );
    }
  }
});

test("Nous origin guard accepts only configured or stamped trusted forwarding", async () => {
  const names = [
    "OMNIROUTE_PUBLIC_BASE_URL",
    "NEXT_PUBLIC_BASE_URL",
    "NEXT_PUBLIC_APP_URL",
    "OMNIROUTE_TRUST_PROXY",
    "OMNIROUTE_PEER_STAMP_TOKEN",
  ];
  const previous = names.map((name) => process.env[name]);
  const { PEER_IP_HEADER } = await import("../../src/server/authz/headers.ts");
  for (const name of names) delete process.env[name];
  process.env.OMNIROUTE_TRUST_PROXY = "loopback";
  process.env.OMNIROUTE_PEER_STAMP_TOKEN = "test-peer-stamp";
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return Response.json(deviceResponse());
  }) as typeof fetch;
  try {
    const req = request("device-code");
    req.headers.set("origin", "https://proxy.example.test");
    req.headers.set("x-forwarded-host", "proxy.example.test");
    req.headers.set("x-forwarded-proto", "https");
    assert.equal((await route.GET(req, context("device-code"))).status, 403);
    req.headers.set(PEER_IP_HEADER, "forged|127.0.0.1");
    assert.equal((await route.GET(req, context("device-code"))).status, 403);
    assert.equal(calls, 0);
    req.headers.set(PEER_IP_HEADER, "test-peer-stamp|127.0.0.1");
    const started = await route.GET(req, context("device-code"));
    assert.equal(started.status, 200);
    assert.match(started.headers.get("set-cookie")!, /Secure/i);
    const data = await started.json();
    const cookie = started.headers.get("set-cookie")!.split(";", 1)[0];
    const payload = {
      deviceCode: data.device_code,
      extraData: { flowId: data.flowId },
    };
    const poll = request("poll", payload, cookie);
    for (const [key, value] of req.headers) poll.headers.set(key, value);
    assert.equal((await route.POST(poll, context("poll"))).status, 200);
    await route.POST(request("cancel", payload, cookie), context("cancel"));
  } finally {
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
  }
});

test("failed device starts release reservations and terminal polls release tickets", async () => {
  const cookie = "nous_oauth_flow_session=failed-start-test";
  for (let i = 0; i < 6; i++) {
    globalThis.fetch = (async () => {
      throw new Error("upstream unavailable");
    }) as typeof fetch;
    assert.equal(
      (await route.GET(request("device-code", undefined, cookie), context("device-code"))).status,
      502
    );
  }
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  globalThis.fetch = (async (url) =>
    String(url).endsWith("/device/code")
      ? Response.json(deviceResponse())
      : Response.json({ error: "access_denied" }, { status: 400 })) as typeof fetch;
  try {
    for (let i = 0; i < 6; i++) {
      const started = await route.GET(
        request("device-code", undefined, cookie),
        context("device-code")
      );
      assert.equal(started.status, 200);
      const data = await started.json();
      const payload = {
        deviceCode: data.device_code,
        extraData: { flowId: data.flowId },
      };
      now += 2_000;
      assert.equal(
        (await (await route.POST(request("poll", payload, cookie), context("poll"))).json()).error,
        "access_denied"
      );
      assert.equal(
        (await (await route.POST(request("poll", payload, cookie), context("poll"))).json()).error,
        "expired_token"
      );
    }
  } finally {
    Date.now = realNow;
  }
});

test("canceling an in-flight poll cannot persist a late successful response", async () => {
  const cookie = "nous_oauth_flow_session=cancel-in-flight-test";
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const inFlight = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const connection = await createNousConnection();
  globalThis.fetch = (async (url) => {
    if (String(url).endsWith("/device/code")) return Response.json(deviceResponse());
    entered();
    await gate;
    return Response.json({
      access_token: "late-access",
      refresh_token: "late-refresh",
      expires_in: 600,
    });
  }) as typeof fetch;
  try {
    const req = new Request(
      `http://localhost/api/oauth/nous-oauth/device-code?connectionId=${connection.id}`,
      { headers: { Cookie: cookie } }
    );
    const data = await (await route.GET(req, context("device-code"))).json();
    const payload = {
      deviceCode: data.device_code,
      connectionId: connection.id,
      extraData: { flowId: data.flowId },
    };
    now += 2_000;
    const pending = route.POST(request("poll", payload, cookie), context("poll"));
    await inFlight;
    // Wrong connection must not remove the active ticket.
    await route.POST(
      request("cancel", { ...payload, connectionId: "wrong" }, cookie),
      context("cancel")
    );
    assert.equal(
      (await (await route.POST(request("poll", payload, cookie), context("poll"))).json()).pending,
      true
    );
    await route.POST(request("cancel", payload, cookie), context("cancel"));
    release();
    assert.equal((await (await pending).json()).error, "expired_token");
    assert.equal((await db.getProviderConnectionById(connection.id))?.accessToken, "access-old");
  } finally {
    release();
    Date.now = realNow;
  }
});

test("authenticated reverse-proxy poll keeps session binding and central CSRF origin fallback", async () => {
  const { SignJWT } = await import("jose");
  const { issueDashboardCsrfToken } = await import("../../src/server/authz/csrf.ts");
  const { DASHBOARD_CSRF_HEADER } = await import("../../src/shared/constants/dashboardCsrf.ts");
  const previousSecret = process.env.JWT_SECRET;
  const previousOrigin = process.env.OMNIROUTE_PUBLIC_BASE_URL;
  process.env.JWT_SECRET = "nous-test-dashboard-session-signing-key";
  process.env.OMNIROUTE_PUBLIC_BASE_URL = "https://dashboard.example.test";
  const previousPassword = process.env.INITIAL_PASSWORD;
  process.env.INITIAL_PASSWORD = "nous-test-auth-enabled";
  await settings.updateSettings({ requireLogin: true });
  globalThis.fetch = (async () => Response.json(deviceResponse())) as typeof fetch;
  try {
    const jwt = await new SignJWT({ sub: "dashboard-test" })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
    const cookie = `auth_token=${jwt}`;
    const start = await route.GET(
      request("device-code", undefined, cookie),
      context("device-code")
    );
    const data = await start.json();
    assert.equal(start.status, 200, JSON.stringify(data));
    const payload = {
      deviceCode: data.device_code,
      extraData: { flowId: data.flowId },
    };
    const req = request("poll", payload, cookie);
    req.headers.set("origin", "https://dashboard.example.test");
    const initialPoll = await (await route.POST(req, context("poll"))).json();
    assert.equal(initialPoll.pending, true, JSON.stringify(initialPoll));
    // An attacker cannot use Origin or forwarded headers as proof of CSRF.
    const hostile = request("cancel", payload, cookie);
    hostile.headers.set("origin", "https://hostile.example.test");
    hostile.headers.set("x-forwarded-host", "hostile.example.test");
    hostile.headers.set("x-forwarded-proto", "https");
    assert.equal((await route.POST(hostile.clone(), context("cancel"))).status, 403);
    hostile.headers.set("sec-fetch-site", "cross-site");
    assert.equal((await route.POST(hostile.clone(), context("cancel"))).status, 403);
    // Even a real CSRF token cannot override explicit cross-site fetch metadata.
    const token = issueDashboardCsrfToken(hostile)!;
    hostile.headers.set(DASHBOARD_CSRF_HEADER, token.token);
    assert.equal((await route.POST(hostile.clone(), context("cancel"))).status, 403);
    // Unknown dashboard origin + authenticated session-bound token matches central middleware.
    const fallback = request("poll", payload, cookie);
    fallback.headers.set("origin", "https://alternate-dashboard.example.test");
    fallback.headers.set(DASHBOARD_CSRF_HEADER, token.token);
    assert.equal(
      (await (await route.POST(fallback.clone(), context("poll"))).json()).pending,
      true
    );
    fallback.headers.set(DASHBOARD_CSRF_HEADER, "invalid");
    assert.equal((await route.POST(fallback.clone(), context("poll"))).status, 403);
    const otherJwt = await new SignJWT({ sub: "other-dashboard-test" })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
    await route.POST(request("cancel", payload, `auth_token=${otherJwt}`), context("cancel"));
    assert.equal(
      (await (await route.POST(request("poll", payload, cookie), context("poll"))).json()).pending,
      true
    );
    await route.POST(request("cancel", payload, cookie), context("cancel"));
  } finally {
    await settings.updateSettings({ requireLogin: false });
    if (previousPassword === undefined) delete process.env.INITIAL_PASSWORD;
    else process.env.INITIAL_PASSWORD = previousPassword;
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
    if (previousOrigin === undefined) delete process.env.OMNIROUTE_PUBLIC_BASE_URL;
    else process.env.OMNIROUTE_PUBLIC_BASE_URL = previousOrigin;
  }
});
