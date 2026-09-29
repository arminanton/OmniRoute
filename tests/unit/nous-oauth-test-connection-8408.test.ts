import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Synthetic credentials in an isolated DB: no private OAuth account or live API.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-nous-test-8408-"));
process.env.DATA_DIR = dataDir;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.OMNIROUTE_DISABLE_CREDENTIAL_HEALTH_CHECK = "true";

const originalFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = (async () => {
  networkCalls++;
  throw new Error("Test Connection must not refresh or send a bearer/inference request");
}) as typeof fetch;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const { POST } = await import("../../src/app/api/providers/[id]/test/route.ts");

test.after(() => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("#8408: manual Nous OAuth Test Connection skips without spending refresh or changing DB status", async () => {
  const connection = await providersDb.createProviderConnection({
    provider: "nous-oauth",
    authType: "oauth",
    accessToken: "synthetic-old-bearer",
    refreshToken: "synthetic-single-use-refresh",
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    testStatus: "unknown",
    isActive: false,
  });
  const db = core.getDbInstance();
  const readRow = () =>
    db
      .prepare(
        `SELECT access_token, refresh_token, test_status, last_error, last_tested,
              updated_at, is_active, rate_limited_until
       FROM provider_connections WHERE id = ?`
      )
      .get(connection.id);
  const before = readRow();
  networkCalls = 0;

  const response = await POST(
    new Request(`http://localhost/api/providers/${connection.id}/test`, { method: "POST" }),
    { params: Promise.resolve({ id: connection.id }) }
  );
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.valid, false, "unsupported is not a successful credential probe");
  assert.equal(result.skipped, true);
  assert.equal(result.refreshed, false);
  assert.equal(result.testedAt, null);
  assert.equal(result.diagnosis?.type, "unsupported");
  assert.match(result.warning, /Nous OAuth Test Connection is not supported/i);
  assert.match(result.warning, /no credential check was made/i);
  assert.equal(networkCalls, 0, "no refresh grant or bearer/inference fetch may run");
  assert.deepEqual(readRow(), before, "no testStatus error, activation, or token write is allowed");
});
