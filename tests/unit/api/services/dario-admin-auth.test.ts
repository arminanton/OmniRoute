import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-dario-admin-auth-"));
const ORIGINAL_INITIAL_PASSWORD = process.env.INITIAL_PASSWORD;
const ORIGINAL_INTERNAL_SERVICE_TOKEN = process.env.OMNIROUTE_INTERNAL_SERVICE_TOKEN;
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "dario-admin-auth-test-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.INITIAL_PASSWORD = "dario-admin-auth-test-password";

const core = await import("../../../../src/lib/db/core.ts");
const settingsDb = await import("../../../../src/lib/db/settings.ts");
const apiKeysDb = await import("../../../../src/lib/db/apiKeys.ts");
const accessTokensDb = await import("../../../../src/lib/db/accessTokens.ts");
const authzHeaders = await import("../../../../src/server/authz/headers.ts");
const { requireAdminAuth } = await import(
  "../../../../src/app/api/services/dario/admin/_lib.ts"
);

const URL = "http://localhost/api/services/dario/admin/accounts";

test.before(async () => {
  await settingsDb.updateSettings({ requireLogin: true, setupComplete: true });
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (ORIGINAL_INITIAL_PASSWORD === undefined) delete process.env.INITIAL_PASSWORD;
  else process.env.INITIAL_PASSWORD = ORIGINAL_INITIAL_PASSWORD;
  if (ORIGINAL_INTERNAL_SERVICE_TOKEN === undefined) {
    delete process.env.OMNIROUTE_INTERNAL_SERVICE_TOKEN;
  } else {
    process.env.OMNIROUTE_INTERNAL_SERVICE_TOKEN = ORIGINAL_INTERNAL_SERVICE_TOKEN;
  }
});

function request(headers: Record<string, string> = {}): Request {
  return new Request(URL, { headers });
}

test("Dario admin wrapper requires authentication when management login is enabled", async () => {
  const rejection = await requireAdminAuth(request());
  assert.equal(rejection?.status, 401);
});

test("Dario admin wrapper accepts a management-scoped API key", async () => {
  const { key } = await apiKeysDb.createApiKey("dario-admin-manage", "dario-test", ["manage"]);
  assert.equal(await requireAdminAuth(request({ authorization: `Bearer ${key}` })), null);
});

test("Dario admin wrapper accepts an admin Access Token and rejects insufficient scopes", async () => {
  const admin = accessTokensDb.createAccessToken({ name: "dario-admin", scope: "admin" });
  assert.equal(
    await requireAdminAuth(request({ authorization: `Bearer ${admin.secret}` })),
    null
  );

  const write = accessTokensDb.createAccessToken({ name: "dario-write", scope: "write" });
  assert.equal(
    (await requireAdminAuth(request({ authorization: `Bearer ${write.secret}` })))?.status,
    403
  );
});

test("Dario admin wrapper accepts central loopback CLI and internal-service identities", async () => {
  const cliRequest = request({
    [authzHeaders.AUTHZ_HEADER_ROUTE_CLASS]: "MANAGEMENT",
    [authzHeaders.AUTHZ_HEADER_AUTH_KIND]: "management_key",
    [authzHeaders.AUTHZ_HEADER_AUTH_ID]: "cli",
    [authzHeaders.AUTHZ_HEADER_AUTH_LABEL]: "local-cli-token",
  });
  assert.equal(await requireAdminAuth(cliRequest), null);

  const token = "dario-internal-service-token-0123456789";
  process.env.OMNIROUTE_INTERNAL_SERVICE_TOKEN = token;
  const internalRequest = request({
    [authzHeaders.AUTHZ_HEADER_ROUTE_CLASS]: "MANAGEMENT",
    [authzHeaders.AUTHZ_HEADER_AUTH_KIND]: "management_key",
    [authzHeaders.AUTHZ_HEADER_AUTH_ID]: "internal-service",
    [authzHeaders.AUTHZ_HEADER_AUTH_LABEL]: "internal-service-token",
    [authzHeaders.AUTHZ_HEADER_PEER_LOCALITY]: "loopback",
    "x-omniroute-internal-service-token": token,
  });
  assert.equal(await requireAdminAuth(internalRequest), null);

  const remoteInternalRequest = request({
    [authzHeaders.AUTHZ_HEADER_ROUTE_CLASS]: "MANAGEMENT",
    [authzHeaders.AUTHZ_HEADER_AUTH_KIND]: "management_key",
    [authzHeaders.AUTHZ_HEADER_AUTH_ID]: "internal-service",
    [authzHeaders.AUTHZ_HEADER_AUTH_LABEL]: "internal-service-token",
    [authzHeaders.AUTHZ_HEADER_PEER_LOCALITY]: "remote",
    "x-omniroute-internal-service-token": token,
  });
  assert.equal((await requireAdminAuth(remoteInternalRequest))?.status, 401);
});

test("Dario admin wrapper preserves the configured no-login mode", async () => {
  await settingsDb.updateSettings({ requireLogin: false });
  assert.equal(await requireAdminAuth(request()), null);
});
