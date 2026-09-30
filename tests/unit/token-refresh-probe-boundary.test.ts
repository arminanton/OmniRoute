import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// No project import may run before this file owns a disposable data directory.
// All credentials below are synthetic. This fixture never delegates to real fetch.
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-refresh-probe-"));
const fixtureEnv: Record<string, string | undefined> = {
  DATA_DIR: TEST_DATA_DIR,
  NODE_ENV: "test",
  API_KEY_SECRET: "probe-boundary-fixture-api-secret",
  STORAGE_ENCRYPTION_KEY: "probe-boundary-fixture-encryption-secret",
  DISABLE_SQLITE_AUTO_BACKUP: "true",
  APP_LOG_TO_FILE: "false",
  APP_LOG_FILE_PATH: path.join(TEST_DATA_DIR, "fixture.log"),
  APP_LOG_LEVEL: "error",
  OMNIROUTE_HIDE_HEALTHCHECK_LOGS: "true",
  HTTP_PROXY: undefined,
  HTTPS_PROXY: undefined,
  ALL_PROXY: undefined,
  NO_PROXY: undefined,
  http_proxy: undefined,
  https_proxy: undefined,
  all_proxy: undefined,
  no_proxy: undefined,
};
const originalEnv = new Map(Object.keys(fixtureEnv).map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
for (const [key, value] of Object.entries(fixtureEnv)) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

type ExpectedFetch = {
  url: string;
  method: "GET" | "POST";
  respond: (init: RequestInit) => Response | Promise<Response>;
};
let expectedFetches: ExpectedFetch[] = [];
let fetchAttempts: Array<{ url: string; method: string }> = [];
let unexpectedFetches = 0;
const offlineFetch: typeof fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
  fetchAttempts.push({ url, method });
  const expected = expectedFetches[0];
  if (!expected || expected.url !== url || expected.method !== method) {
    unexpectedFetches++;
    // Do not print arbitrary request URLs, headers, or bodies in failures.
    throw new Error("Unexpected fetch in offline token-refresh probe fixture");
  }
  expectedFetches.shift();
  return expected.respond(init);
};
globalThis.fetch = offlineFetch;

// Register cleanup before dynamic imports, including for an import failure.
let resetStorage = () => {};
let restoreProviderConfigs = () => {};
test.after(() => {
  try {
    try {
      restoreProviderConfigs();
    } finally {
      resetStorage();
    }
  } finally {
    try {
      fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    } finally {
      Date.now = originalNow;
      globalThis.fetch = originalFetch;
      for (const [key, value] of originalEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }
});

const core = await import("../../src/lib/db/core.ts");
resetStorage = () => core.resetDbInstance();
const providers = await import("../../src/lib/db/providers.ts");
const cache = await import("../../src/lib/db/readCache.ts");
const encryption = await import("../../src/lib/db/encryption.ts");
const wrapper = await import("../../src/sse/services/tokenRefresh.ts");
const refresh = await import("../../open-sse/services/tokenRefresh.ts");
const { PROVIDERS, OAUTH_ENDPOINTS } = await import("../../open-sse/config/constants.ts");
const { runAsProbe, isProbeContext } = await import("../../src/shared/utils/probeOrigin.ts");
const { NOUS_OAUTH_INFERENCE_PSD_KEY } = await import("../../open-sse/config/nousOAuth.ts");
const { RuntimePolicyError, isRuntimePolicyError } =
  await import("../../src/shared/runtimePolicy.ts");
// proxyFetch may install its wrapper during import. Its captured fetch was also
// offlineFetch; reinstall our strict fixture before any test action.
globalThis.fetch = offlineFetch;

const NOW = Date.parse("2026-09-29T12:00:00Z");
const GENERIC_PROVIDER = "genericOAuth";
const GENERIC_TOKEN_URL = "https://oauth.probe-fixture.invalid/token";
const GHE_URL = "https://ghe.probe-fixture.invalid";
const NOUS_TOKEN_URL = "https://portal.nousresearch.com/api/oauth/token";
const PAID_URL = "https://inference-api.nousresearch.com/v1";
const GUEST_URL = "https://welcome-api.nousresearch.com/v1";
const RENEWED_EXPIRY = new Date(NOW + 3_600_000).toISOString();
const expiryStates = [
  { name: "expired", ms: NOW - 60_000 },
  { name: "near", ms: NOW + 60_000 },
  { name: "fresh", ms: NOW + 3_600_000 },
] as const;
const expiryForms: Array<{ name: string; encode: (ms: number) => string | number }> = [
  { name: "ISO", encode: (ms) => new Date(ms).toISOString() },
  { name: "seconds number", encode: (ms) => ms / 1000 },
  { name: "seconds string", encode: (ms) => String(ms / 1000) },
  { name: "milliseconds number", encode: (ms) => ms },
  { name: "milliseconds string", encode: (ms) => String(ms) },
];

type FixtureConnection = NonNullable<
  Awaited<ReturnType<typeof providers.createProviderConnection>>
> & {
  id: string;
  accessToken: string;
  refreshToken: string;
};
let sequence = 0;
async function createConnection(provider: string, overrides: Record<string, unknown> = {}) {
  const tag = `probe-fixture-${++sequence}`;
  const row = await providers.createProviderConnection({
    provider,
    authType: "oauth",
    name: tag,
    isActive: true,
    testStatus: "active",
    accessToken: `${tag}-access`,
    refreshToken: `${tag}-refresh`,
    expiresAt: new Date(NOW - 60_000).toISOString(),
    providerSpecificData: { fixtureMarker: tag },
    ...overrides,
  });
  assert.ok(row);
  assert.equal(typeof row.id, "string");
  assert.equal(typeof row.accessToken, "string");
  assert.equal(typeof row.refreshToken, "string");
  return row as FixtureConnection;
}

async function createNous(overrides: Record<string, unknown> = {}) {
  return createConnection("nous-oauth", {
    providerSpecificData: { [NOUS_OAUTH_INFERENCE_PSD_KEY]: PAID_URL, fixtureMarker: "stored" },
    ...overrides,
  });
}

async function readConnection(id: string) {
  const row = await providers.getProviderConnectionById(id);
  assert.ok(row);
  return row;
}

function providerData(row: Record<string, unknown>): Record<string, unknown> {
  assert.ok(row.providerSpecificData && typeof row.providerSpecificData === "object");
  return row.providerSpecificData as Record<string, unknown>;
}

function storageSnapshot() {
  const sqlite = core.getDbInstance();
  return {
    // total_changes also catches idempotent UPDATEs and lease writes later undone.
    changes: (sqlite.prepare("SELECT total_changes() AS n").get() as { n: number }).n,
    rows: sqlite.prepare("SELECT * FROM provider_connections ORDER BY id").all(),
    // A probe must not even create the single-use Nous refresh lease table.
    schema: sqlite.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all(),
  };
}

function assertNoEffects(before: ReturnType<typeof storageSnapshot>, expectedAttempts = 0) {
  assert.equal(fetchAttempts.length, expectedAttempts, "unexpected token-mint attempt");
  assert.deepEqual(storageSnapshot(), before, "refresh boundary must not write SQLite");
}

function copilotEndpoint(provider: string) {
  return provider === "github"
    ? "https://api.github.com/copilot_internal/v2/token"
    : `${GHE_URL}/api/v3/copilot_internal/v2/token`;
}

function expectOAuthRefresh(provider: string, oldRefreshToken: string, tag: string) {
  const tokens = { accessToken: `${tag}-access`, refreshToken: `${tag}-refresh`, expiresIn: 3600 };
  expectedFetches.push({
    url: provider === GENERIC_PROVIDER ? GENERIC_TOKEN_URL : OAUTH_ENDPOINTS.github.token,
    method: "POST",
    respond(init) {
      const form = new URLSearchParams(String(init.body));
      assert.equal(form.get("grant_type"), "refresh_token");
      assert.equal(form.get("refresh_token"), oldRefreshToken);
      assert.equal(
        new Headers(init.headers).get("content-type"),
        "application/x-www-form-urlencoded"
      );
      return Response.json({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        expires_in: tokens.expiresIn,
      });
    },
  });
  return tokens;
}

function expectCopilotRefresh(provider: string, accessToken: string, token: string) {
  expectedFetches.push({
    url: copilotEndpoint(provider),
    method: "GET",
    respond(init) {
      assert.equal(new Headers(init.headers).get("authorization"), `token ${accessToken}`);
      return Response.json({ token, expires_at: (NOW + 3_600_000) / 1000 });
    },
  });
}

const savedProviderConfigs = new Map(
  [GENERIC_PROVIDER, "github"].map((id) => [id, Object.getOwnPropertyDescriptor(PROVIDERS, id)])
);
restoreProviderConfigs = () => {
  for (const [id, descriptor] of savedProviderConfigs) {
    if (descriptor) Object.defineProperty(PROVIDERS, id, descriptor);
    else delete PROVIDERS[id];
  }
};

test.before(() => {
  assert.equal(core.DATA_DIR, TEST_DATA_DIR);
  assert.equal(core.SQLITE_FILE, path.join(TEST_DATA_DIR, "storage.sqlite"));
  core.getDbInstance();
  assert.equal(fetchAttempts.length, 0, "project imports and DB initialization must not fetch");
  PROVIDERS[GENERIC_PROVIDER] = {
    format: "openai",
    refreshUrl: GENERIC_TOKEN_URL,
    clientId: "probe-fixture-generic-client",
    clientSecret: "probe-fixture-generic-secret",
  };
  PROVIDERS.github = {
    ...PROVIDERS.github,
    clientId: "probe-fixture-github-client",
    clientSecret: "probe-fixture-github-secret",
  };
});

test.beforeEach(() => {
  expectedFetches = [];
  fetchAttempts = [];
  unexpectedFetches = 0;
  Date.now = () => NOW;
  globalThis.fetch = offlineFetch;
  assert.equal(isProbeContext(), false);
});

test.afterEach(() => {
  try {
    assert.equal(unexpectedFetches, 0, "even a swallowed unexpected fetch must fail the fixture");
    assert.equal(expectedFetches.length, 0, "expected offline refresh was not attempted");
    assert.equal(isProbeContext(), false, "probe context must not escape its callback");
  } finally {
    Date.now = originalNow;
    globalThis.fetch = offlineFetch;
    refresh._clearTokenRotationMap();
    cache.invalidateDbCache();
  }
});

for (const provider of [GENERIC_PROVIDER, "github", "ghe-copilot"]) {
  for (const state of expiryStates) {
    for (const form of expiryForms) {
      test(`probe ${provider}: ${state.name} ${form.name} returns a copy without mint or persistence`, async () => {
        const expiry = form.encode(state.ms);
        const data =
          provider === GENERIC_PROVIDER
            ? { fixtureMarker: "preserve" }
            : {
                fixtureMarker: "preserve",
                copilotToken: "probe-fixture-copilot-current",
                copilotTokenExpiresAt: expiry,
                ...(provider === "ghe-copilot" ? { gheUrl: GHE_URL } : {}),
              };
        const connection = await createConnection(provider, {
          expiresAt: expiry,
          providerSpecificData: data,
          testStatus: "error",
          lastError: "synthetic prior failure",
        });
        // SQLite expiry columns are TEXT. Override only the caller representation
        // to also cover numeric seconds/ms inputs alongside persisted strings.
        const input = {
          ...connection,
          connectionId: connection.id,
          expiresAt: expiry,
          providerSpecificData: data,
          ...(provider === GENERIC_PROVIDER ? {} : { copilotToken: data.copilotToken }),
        };
        const originalInput = structuredClone(input);
        const before = storageSnapshot();
        const result = await runAsProbe(async () => {
          assert.equal(isProbeContext(), true);
          return wrapper.checkAndRefreshToken(provider, input);
        });
        assert.notStrictEqual(result, input);
        assert.deepEqual(result, originalInput);
        assert.deepEqual(input, originalInput);
        assertNoEffects(before);
      });
    }
  }
}

for (const state of expiryStates) {
  test(`normal genericOAuth: ${state.name} ISO refresh decision and persisted lifetime`, async () => {
    const connection = await createConnection(GENERIC_PROVIDER, {
      expiresAt: new Date(state.ms).toISOString(),
      testStatus: "error",
      lastError: "synthetic prior failure",
    });
    const input = { ...connection, connectionId: connection.id };
    const originalInput = structuredClone(input);
    const before = storageSnapshot();
    // Same row, same clock: only the trusted AsyncLocalStorage context differs.
    assert.deepEqual(
      await runAsProbe(() => wrapper.checkAndRefreshToken(GENERIC_PROVIDER, input)),
      input
    );
    assertNoEffects(before);
    const tokens =
      state.name === "fresh"
        ? null
        : expectOAuthRefresh(
            GENERIC_PROVIDER,
            connection.refreshToken!,
            `normal-generic-${state.name}`
          );
    const result = await wrapper.checkAndRefreshToken(GENERIC_PROVIDER, input);
    assert.notStrictEqual(result, input);
    assert.deepEqual(input, originalInput);
    if (!tokens) {
      assert.deepEqual(result, input);
      assertNoEffects(before);
      return;
    }
    assert.equal(fetchAttempts.length, 1);
    assert.equal(result.accessToken, tokens.accessToken);
    assert.equal(result.refreshToken, tokens.refreshToken);
    assert.equal(result.expiresAt, RENEWED_EXPIRY);
    const stored = await readConnection(connection.id);
    assert.equal(stored.accessToken, tokens.accessToken);
    assert.equal(stored.refreshToken, tokens.refreshToken);
    assert.equal(stored.expiresAt, RENEWED_EXPIRY);
    assert.equal(stored.tokenExpiresAt, RENEWED_EXPIRY);
    assert.equal(stored.expiresIn, 3600);
    assert.equal(stored.testStatus, "active");
    assert.equal(stored.lastError, undefined);
    assert.ok(storageSnapshot().changes > before.changes);
  });
}

for (const provider of ["github", "ghe-copilot"]) {
  for (const state of expiryStates) {
    test(`normal ${provider}: ${state.name} ISO Copilot expiry refreshes only when due`, async () => {
      const data = {
        fixtureMarker: "preserve",
        copilotToken: "normal-fixture-copilot-old",
        copilotTokenExpiresAt: new Date(state.ms).toISOString(),
        ...(provider === "ghe-copilot" ? { gheUrl: GHE_URL } : {}),
      };
      const connection = await createConnection(provider, {
        expiresAt: RENEWED_EXPIRY,
        providerSpecificData: data,
      });
      const input = { ...connection, connectionId: connection.id, copilotToken: data.copilotToken };
      const originalInput = structuredClone(input);
      const before = storageSnapshot();
      assert.deepEqual(
        await runAsProbe(() => wrapper.checkAndRefreshToken(provider, input)),
        input
      );
      assertNoEffects(before);
      const nextToken = `normal-${provider}-${state.name}-copilot`;
      if (state.name !== "fresh")
        expectCopilotRefresh(provider, connection.accessToken!, nextToken);
      const result = await wrapper.checkAndRefreshToken(provider, input);
      assert.notStrictEqual(result, input);
      assert.deepEqual(input, originalInput);
      if (state.name === "fresh") {
        assert.deepEqual(result, input);
        assertNoEffects(before);
        return;
      }
      assert.deepEqual(fetchAttempts, [{ url: copilotEndpoint(provider), method: "GET" }]);
      assert.equal(result.copilotToken, nextToken, "top-level Copilot bearer must track rotation");
      const expectedData = {
        ...data,
        copilotToken: nextToken,
        copilotTokenExpiresAt: (NOW + 3_600_000) / 1000,
      };
      assert.deepEqual(result.providerSpecificData, expectedData);
      const stored = await readConnection(connection.id);
      assert.deepEqual(providerData(stored), expectedData);
      assert.equal(stored.accessToken, connection.accessToken);
      assert.equal(stored.refreshToken, connection.refreshToken);
      assert.equal(stored.expiresAt, RENEWED_EXPIRY);
      assert.ok(storageSnapshot().changes > before.changes);
    });
  }
}

for (const state of expiryStates.filter((state) => state.name !== "fresh")) {
  test(`normal github: ${state.name} ISO OAuth and Copilot rotate in order using the new bearer`, async () => {
    const connection = await createConnection("github", {
      expiresAt: new Date(state.ms).toISOString(),
      providerSpecificData: {
        copilotToken: "github-fixture-copilot-old",
        copilotTokenExpiresAt: new Date(state.ms).toISOString(),
        fixtureMarker: "preserve",
      },
    });
    const input = { ...connection, connectionId: connection.id };
    const originalInput = structuredClone(input);
    const before = storageSnapshot();
    assert.deepEqual(await runAsProbe(() => wrapper.checkAndRefreshToken("github", input)), input);
    assertNoEffects(before);
    const tokens = expectOAuthRefresh("github", connection.refreshToken!, `github-${state.name}`);
    expectCopilotRefresh("github", tokens.accessToken, `github-${state.name}-copilot`);
    const result = await wrapper.checkAndRefreshToken("github", input);
    assert.deepEqual(fetchAttempts, [
      { url: OAUTH_ENDPOINTS.github.token, method: "POST" },
      { url: copilotEndpoint("github"), method: "GET" },
    ]);
    assert.equal(result.accessToken, tokens.accessToken);
    assert.equal(result.refreshToken, tokens.refreshToken);
    assert.equal(result.expiresAt, RENEWED_EXPIRY);
    assert.equal(result.copilotToken, `github-${state.name}-copilot`);
    const stored = await readConnection(connection.id);
    assert.equal(stored.accessToken, tokens.accessToken);
    assert.equal(stored.refreshToken, tokens.refreshToken);
    assert.equal(stored.tokenExpiresAt, RENEWED_EXPIRY);
    assert.deepEqual(providerData(stored), result.providerSpecificData);
    assert.deepEqual(input, originalInput);
    assert.ok(storageSnapshot().changes > before.changes);
  });
}

test("caller probe-shaped fields cannot suppress an ordinary OAuth refresh", async () => {
  const connection = await createConnection(GENERIC_PROVIDER);
  const input = {
    ...connection,
    connectionId: connection.id,
    probe: true,
    isProbe: true,
    isProbeContext: true,
  };
  const tokens = expectOAuthRefresh(
    GENERIC_PROVIDER,
    connection.refreshToken!,
    "untrusted-probe-fields"
  );
  const result = await wrapper.checkAndRefreshToken(GENERIC_PROVIDER, input);
  assert.equal(result.accessToken, tokens.accessToken);
  assert.equal((await readConnection(connection.id)).refreshToken, tokens.refreshToken);
  assert.equal(fetchAttempts.length, 1);
});

for (const provider of ["maxai", "mx"]) {
  for (const probe of [false, true]) {
    test(`${provider}: ${probe ? "probe" : "normal"} retains early pass-through without a row`, async () => {
      const input = {
        connectionId: "maxai-fixture-no-row",
        accessToken: "maxai-fixture-access",
        refreshToken: "maxai-fixture-refresh",
        expiresAt: new Date(NOW - 60_000).toISOString(),
        providerSpecificData: { fixtureMarker: "unchanged" },
      };
      const before = storageSnapshot();
      const invoke = () => wrapper.checkAndRefreshToken(provider, input);
      const result = await (probe ? runAsProbe(invoke) : invoke());
      assert.notStrictEqual(result, input);
      assert.deepEqual(result, input);
      assertNoEffects(before);
    });
  }
}

for (const state of expiryStates) {
  for (const boundUrl of [PAID_URL, GUEST_URL]) {
    test(`Nous probe: ${state.name} current stored ${boundUrl === PAID_URL ? "paid" : "guest"} credentials replace stale caller data`, async () => {
      const expiry = new Date(state.ms).toISOString();
      const data = { [NOUS_OAUTH_INFERENCE_PSD_KEY]: boundUrl, fixtureMarker: "stored-only" };
      const connection = await createNous({
        // tokenExpiresAt must win, even if the other stored expiry is far away.
        expiresAt: new Date(NOW + 86_400_000).toISOString(),
        tokenExpiresAt: expiry,
        providerSpecificData: data,
      });
      const input = {
        connectionId: connection.id,
        accessToken: "nous-fixture-caller-stale-access",
        refreshToken: "nous-fixture-caller-stale-refresh",
        expiresAt: new Date(NOW + 86_400_000).toISOString(),
        requestMarker: "keep-top-level",
        providerSpecificData: {
          [NOUS_OAUTH_INFERENCE_PSD_KEY]: boundUrl === PAID_URL ? GUEST_URL : PAID_URL,
          callerOnly: "must-not-survive",
        },
      };
      const originalInput = structuredClone(input);
      const before = storageSnapshot();
      const result = await runAsProbe(() => wrapper.checkAndRefreshToken("nous-oauth", input));
      assert.notStrictEqual(result, input);
      assert.equal(result.accessToken, connection.accessToken);
      assert.equal(result.refreshToken, connection.refreshToken);
      assert.equal(result.expiresAt, expiry);
      assert.equal(result.requestMarker, "keep-top-level");
      assert.deepEqual(result.providerSpecificData, data);
      assert.deepEqual(input, originalInput);
      assertNoEffects(before);
    });
  }
}

for (const state of expiryStates) {
  for (const form of expiryForms) {
    test(`Nous probe: valid current row with ${state.name} ${form.name} never spends its grant`, async () => {
      const connection = await createNous({ expiresAt: form.encode(state.ms) });
      const row = await readConnection(connection.id);
      const input = { ...row, connectionId: connection.id };
      const originalInput = structuredClone(input);
      const before = storageSnapshot();
      const result = await runAsProbe(() => wrapper.checkAndRefreshToken("nous-oauth", input));
      assert.notStrictEqual(result, input);
      assert.equal(result.accessToken, row.accessToken);
      assert.equal(result.refreshToken, row.refreshToken);
      assert.equal(result.expiresAt, row.expiresAt);
      assert.deepEqual(result.providerSpecificData, providerData(row));
      assert.deepEqual(input, originalInput);
      assertNoEffects(before);
    });
  }
}

test("Nous re-reads successive committed rows instead of the cached caller, without minting or leases", async () => {
  const connection = await createNous();
  const cached = await cache.getCachedProviderConnectionById(connection.id);
  assert.ok(cached);
  const input = { ...cached, connectionId: connection.id };
  const originalInput = structuredClone(input);
  for (const [index, url] of [GUEST_URL, PAID_URL].entries()) {
    const accessToken = `nous-fixture-committed-${index}-access`;
    const refreshToken = `nous-fixture-committed-${index}-refresh`;
    const expiry = new Date(index ? NOW + 60_000 : NOW - 60_000).toISOString();
    const data = { [NOUS_OAUTH_INFERENCE_PSD_KEY]: url, fixtureMarker: `committed-${index}` };
    // Like another process: a real encrypted SQL write deliberately leaves the
    // process-local read cache stale. Never replace the production row reader.
    core
      .getDbInstance()
      .prepare(
        `UPDATE provider_connections SET
      access_token = ?, refresh_token = ?, expires_at = ?, token_expires_at = ?,
      provider_specific_data = ? WHERE id = ?`
      )
      .run(
        encryption.encrypt(accessToken),
        encryption.encrypt(refreshToken),
        expiry,
        expiry,
        JSON.stringify(data),
        connection.id
      );
    assert.strictEqual(await cache.getCachedProviderConnectionById(connection.id), cached);
    const before = storageSnapshot();
    const result = await runAsProbe(() => wrapper.checkAndRefreshToken("nous-oauth", input));
    assert.equal(result.accessToken, accessToken);
    assert.equal(result.refreshToken, refreshToken);
    assert.equal(result.expiresAt, expiry);
    assert.deepEqual(result.providerSpecificData, data);
    assert.strictEqual(await cache.getCachedProviderConnectionById(connection.id), cached);
    assert.deepEqual(input, originalInput);
    assertNoEffects(before);
  }
});

for (const connectionId of [undefined, null, "", "nous-fixture-missing-row"]) {
  test(`Nous probe: ${connectionId ? "missing row" : String(connectionId) + " connectionId"} cannot use caller-only credentials`, async () => {
    const input = {
      connectionId,
      accessToken: "nous-fixture-unpersisted-access",
      refreshToken: "nous-fixture-unpersisted-refresh",
      expiresAt: RENEWED_EXPIRY,
      providerSpecificData: { [NOUS_OAUTH_INFERENCE_PSD_KEY]: PAID_URL },
    };
    const before = storageSnapshot();
    assert.equal(await runAsProbe(() => wrapper.checkAndRefreshToken("nous-oauth", input)), null);
    assertNoEffects(before);
  });
}

test("Nous probe: deleted row fails closed even when a valid old row remains cached", async () => {
  const connection = await createNous();
  const cached = await cache.getCachedProviderConnectionById(connection.id);
  assert.ok(cached);
  const input = { ...cached, connectionId: connection.id };
  core.getDbInstance().prepare("DELETE FROM provider_connections WHERE id = ?").run(connection.id);
  assert.strictEqual(await cache.getCachedProviderConnectionById(connection.id), cached);
  const before = storageSnapshot();
  assert.equal(await runAsProbe(() => wrapper.checkAndRefreshToken("nous-oauth", input)), null);
  assertNoEffects(before);
});

const invalidRows = [
  { name: "foreign provider", column: "provider", value: "nous-research" },
  { name: "empty provider", column: "provider", value: "" },
  { name: "wrong auth type", column: "auth_type", value: "apikey" },
  { name: "missing auth type", column: "auth_type", value: null },
  { name: "missing access token", column: "access_token", value: null },
  { name: "empty access token", column: "access_token", value: "" },
  { name: "missing refresh token", column: "refresh_token", value: null },
  { name: "empty refresh token", column: "refresh_token", value: "" },
  {
    name: "corrupt encrypted access token",
    column: "access_token",
    value: "enc:v1:fixture:invalid:access",
  },
  {
    name: "corrupt encrypted refresh token",
    column: "refresh_token",
    value: "enc:v1:fixture:invalid:refresh",
  },
] as const;
for (const invalid of invalidRows) {
  test(`Nous probe: current row with ${invalid.name} cannot fall back to valid cached credentials`, async () => {
    const connection = await createNous({ expiresAt: RENEWED_EXPIRY });
    const cached = await cache.getCachedProviderConnectionById(connection.id);
    assert.ok(cached);
    const input = { ...cached, connectionId: connection.id };
    // The column names are fixed fixture literals, not caller input.
    core
      .getDbInstance()
      .prepare(`UPDATE provider_connections SET ${invalid.column} = ? WHERE id = ?`)
      .run(invalid.value, connection.id);
    const before = storageSnapshot();
    assert.equal(await runAsProbe(() => wrapper.checkAndRefreshToken("nous-oauth", input)), null);
    assert.strictEqual(await cache.getCachedProviderConnectionById(connection.id), cached);
    assertNoEffects(before);
  });
}

const invalidMetadata = [
  { name: "missing metadata", raw: null },
  { name: "malformed metadata JSON", raw: "{fixture-not-json" },
  { name: "null metadata JSON", raw: "null" },
  { name: "array metadata", raw: "[]" },
  { name: "missing bound URL", raw: "{}" },
  ...[
    { name: "null bound URL", value: null },
    { name: "numeric bound URL", value: 42 },
    { name: "empty bound URL", value: "" },
    { name: "foreign bound URL", value: "https://untrusted.probe-fixture.invalid/v1" },
    {
      name: "lookalike bound host",
      value: "https://inference-api.nousresearch.com.probe-fixture.invalid/v1",
    },
    { name: "HTTP bound URL", value: "http://inference-api.nousresearch.com/v1" },
    { name: "bound URL userinfo", value: "https://fixture@inference-api.nousresearch.com/v1" },
    { name: "bound URL explicit port", value: "https://inference-api.nousresearch.com:443/v1" },
    { name: "bound URL query", value: `${PAID_URL}?fixture=1` },
    { name: "bound URL fragment", value: `${PAID_URL}#fixture` },
    { name: "bound URL trailing slash", value: `${PAID_URL}/` },
  ].map(({ name, value }) => ({
    name,
    raw: JSON.stringify({ [NOUS_OAUTH_INFERENCE_PSD_KEY]: value }),
  })),
];
for (const invalid of invalidMetadata) {
  test(`Nous probe: rejects ${invalid.name} before returning even a fresh cached bearer`, async () => {
    const connection = await createNous({ expiresAt: RENEWED_EXPIRY });
    const cached = await cache.getCachedProviderConnectionById(connection.id);
    assert.ok(cached);
    const input = { ...cached, connectionId: connection.id };
    core
      .getDbInstance()
      .prepare("UPDATE provider_connections SET provider_specific_data = ? WHERE id = ?")
      .run(invalid.raw, connection.id);
    const before = storageSnapshot();
    await assert.rejects(
      runAsProbe(() => wrapper.checkAndRefreshToken("nous-oauth", input)),
      { message: "Invalid or missing Nous OAuth inference base URL" }
    );
    assert.strictEqual(await cache.getCachedProviderConnectionById(connection.id), cached);
    assertNoEffects(before);
  });
}

for (const state of expiryStates.filter((state) => state.name !== "fresh")) {
  test(`Nous probe sends no grant; the same ${state.name} ISO current row normally rotates and persists`, async () => {
    const connection = await createNous({ expiresAt: new Date(state.ms).toISOString() });
    const input = { ...connection, connectionId: connection.id };
    const originalInput = structuredClone(input);
    const before = storageSnapshot();
    const probeResult = await runAsProbe(() => wrapper.checkAndRefreshToken("nous-oauth", input));
    assert.equal(probeResult.accessToken, connection.accessToken);
    assert.equal(probeResult.refreshToken, connection.refreshToken);
    assert.deepEqual(probeResult.providerSpecificData, providerData(connection));
    assertNoEffects(before);
    expectedFetches.push({
      url: NOUS_TOKEN_URL,
      method: "POST",
      respond(init) {
        assert.equal(init.redirect, "manual");
        assert.equal(
          new Headers(init.headers).get("x-nous-refresh-token"),
          connection.refreshToken
        );
        assert.deepEqual(
          [...new URLSearchParams(String(init.body))],
          [
            ["grant_type", "refresh_token"],
            ["client_id", "hermes-cli"],
          ]
        );
        assert.equal(String(init.body).includes(connection.refreshToken!), false);
        return Response.json({
          access_token: "nous-fixture-rotated-access",
          refresh_token: "nous-fixture-rotated-refresh",
          expires_in: 3600,
          inference_base_url: GUEST_URL,
        });
      },
    });
    const result = await wrapper.checkAndRefreshToken("nous-oauth", input);
    assert.deepEqual(fetchAttempts, [{ url: NOUS_TOKEN_URL, method: "POST" }]);
    assert.equal(result.accessToken, "nous-fixture-rotated-access");
    assert.equal(result.refreshToken, "nous-fixture-rotated-refresh");
    assert.equal(result.expiresAt, RENEWED_EXPIRY);
    assert.deepEqual(result.providerSpecificData, {
      [NOUS_OAUTH_INFERENCE_PSD_KEY]: GUEST_URL,
      fixtureMarker: "stored",
    });
    const stored = await readConnection(connection.id);
    assert.equal(stored.accessToken, result.accessToken);
    assert.equal(stored.refreshToken, result.refreshToken);
    assert.equal(stored.expiresAt, RENEWED_EXPIRY);
    assert.equal(stored.tokenExpiresAt, RENEWED_EXPIRY);
    assert.deepEqual(providerData(stored), result.providerSpecificData);
    assert.deepEqual(input, originalInput);
    assert.ok(storageSnapshot().changes > before.changes);
    const afterRotation = storageSnapshot();
    // Ordinary fresh behavior is unchanged and returns the latest binding too.
    const freshResult = await wrapper.checkAndRefreshToken("nous-oauth", input);
    assert.equal(freshResult.accessToken, result.accessToken);
    assert.deepEqual(freshResult.providerSpecificData, result.providerSpecificData);
    assertNoEffects(afterRotation, 1);
  });
}

test("normal GitHub refresh preserves a local branded rejection without persisting or retrying", async () => {
  const connection = await createConnection("github");
  const input = { ...connection, connectionId: connection.id };
  const originalInput = structuredClone(input);
  const denied = new RuntimePolicyError("capability-disabled");
  assert.equal(isRuntimePolicyError(denied), true);
  const before = storageSnapshot();
  // The real DB/proxy/refresh path runs. Only its expected offline fetch rejects;
  // no policy activation, validator replacement, or mocked row reader is needed.
  expectedFetches.push({
    url: OAUTH_ENDPOINTS.github.token,
    method: "POST",
    respond(init) {
      const form = new URLSearchParams(String(init.body));
      assert.equal(form.get("refresh_token"), connection.refreshToken);
      throw denied;
    },
  });
  await assert.rejects(wrapper.checkAndRefreshToken("github", input), (error) => {
    assert.strictEqual(error, denied);
    assert.equal(isRuntimePolicyError(error), true);
    return true;
  });
  assert.deepEqual(input, originalInput);
  assertNoEffects(before, 1);
});
