import { before, after, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-cliproxy-accounts-api-"));
const ORIGINAL_INTERNAL_SERVICE_TOKEN = process.env.OMNIROUTE_INTERNAL_SERVICE_TOKEN;
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "cliproxy-accounts-api-test-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../../../src/lib/db/core.ts");
const settingsDb = await import("../../../../src/lib/db/settings.ts");
const apiKeysDb = await import("../../../../src/lib/db/apiKeys.ts");
const accessTokensDb = await import("../../../../src/lib/db/accessTokens.ts");
const authzHeaders = await import("../../../../src/server/authz/headers.ts");
const { GET } = await import("../../../../src/app/api/services/cliproxy/accounts/route.ts");

before(async () => {
  await settingsDb.updateSettings({ requireLogin: true });
  process.env.INITIAL_PASSWORD = "cliproxy-accounts-test-password";
});

after(() => {
  delete process.env.INITIAL_PASSWORD;
  if (ORIGINAL_INTERNAL_SERVICE_TOKEN === undefined) {
    delete process.env.OMNIROUTE_INTERNAL_SERVICE_TOKEN;
  } else {
    process.env.OMNIROUTE_INTERNAL_SERVICE_TOKEN = ORIGINAL_INTERNAL_SERVICE_TOKEN;
  }
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

it("requires OmniRoute management authentication", async () => {
  const response = await GET(new Request("http://localhost/api/services/cliproxy/accounts"));
  assert.equal(response.status, 401);
});

it("accepts a scoped OmniRoute management API key", async () => {
  const { key } = await apiKeysDb.createApiKey("cliproxy-accounts", "test", ["manage"]);
  const response = await GET(
    new Request("http://localhost/api/services/cliproxy/accounts", {
      headers: { Authorization: `Bearer ${key}` },
    })
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.state, "disabled");
  assert.deepEqual(body.accounts, []);
});

it("accepts an admin-scoped CLI access token for the services admin prefix", async () => {
  const { secret } = accessTokensDb.createAccessToken({
    name: "cliproxy-admin-access-token",
    scope: "admin",
  });
  const response = await GET(
    new Request("http://localhost/api/services/cliproxy/accounts", {
      headers: { authorization: `Bearer ${secret}` },
    })
  );
  assert.equal(response.status, 200);
});

it("rejects an access token whose scope is insufficient for services admin routes", async () => {
  const { secret } = accessTokensDb.createAccessToken({
    name: "cliproxy-write-access-token",
    scope: "write",
  });
  const response = await GET(
    new Request("http://localhost/api/services/cliproxy/accounts", {
      headers: { authorization: `Bearer ${secret}` },
    })
  );
  assert.equal(response.status, 403);
});

it("accepts the stamped local-CLI management identity forwarded by authz", async () => {
  // This models the trusted headers written by the proxy after it verifies the
  // loopback CLI token; the client-supplied equivalent is covered by the
  // runAuthzPipeline spoof regression.
  const response = await GET(
    new Request("http://localhost/api/services/cliproxy/accounts", {
      headers: {
        [authzHeaders.AUTHZ_HEADER_ROUTE_CLASS]: "MANAGEMENT",
        [authzHeaders.AUTHZ_HEADER_AUTH_KIND]: "management_key",
        [authzHeaders.AUTHZ_HEADER_AUTH_ID]: "cli",
        [authzHeaders.AUTHZ_HEADER_AUTH_LABEL]: "local-cli-token",
      },
    })
  );
  assert.equal(response.status, 200);
});

it("accepts an internal-service credential only with the trusted loopback stamp", async () => {
  const token = "cliproxy-internal-service-token-0123456789";
  process.env.OMNIROUTE_INTERNAL_SERVICE_TOKEN = token;
  const response = await GET(
    new Request("http://localhost/api/services/cliproxy/accounts", {
      headers: {
        [authzHeaders.AUTHZ_HEADER_ROUTE_CLASS]: "MANAGEMENT",
        [authzHeaders.AUTHZ_HEADER_AUTH_KIND]: "management_key",
        [authzHeaders.AUTHZ_HEADER_AUTH_ID]: "internal-service",
        [authzHeaders.AUTHZ_HEADER_AUTH_LABEL]: "internal-service-token",
        [authzHeaders.AUTHZ_HEADER_PEER_LOCALITY]: "loopback",
        "x-omniroute-internal-service-token": token,
      },
    })
  );
  assert.equal(response.status, 200);

  const remote = await GET(
    new Request("http://localhost/api/services/cliproxy/accounts", {
      headers: {
        [authzHeaders.AUTHZ_HEADER_ROUTE_CLASS]: "MANAGEMENT",
        [authzHeaders.AUTHZ_HEADER_AUTH_KIND]: "management_key",
        [authzHeaders.AUTHZ_HEADER_AUTH_ID]: "internal-service",
        [authzHeaders.AUTHZ_HEADER_AUTH_LABEL]: "internal-service-token",
        [authzHeaders.AUTHZ_HEADER_PEER_LOCALITY]: "remote",
        "x-omniroute-internal-service-token": token,
      },
    })
  );
  assert.equal(remote.status, 401);
});

it("preserves the configured no-login mode", async () => {
  await settingsDb.updateSettings({ requireLogin: false });
  const response = await GET(new Request("http://localhost/api/services/cliproxy/accounts"));
  assert.equal(response.status, 200);
});
