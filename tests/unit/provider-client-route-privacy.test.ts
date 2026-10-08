import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { makeManagementSessionRequest } from "../helpers/managementSession.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-provider-client-privacy-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-provider-client-privacy-secret";
process.env.JWT_SECRET = "test-provider-client-privacy-jwt";
process.env.INITIAL_PASSWORD = "test-provider-client-admin-password";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const providerClientRoute = await import("../../src/app/api/providers/client/route.ts");

test.beforeEach(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("GET /api/providers/client authenticates and returns only masked provider credentials", async () => {
  const secrets = {
    apiKey: "sk-live-primary-secret-tail-1002",
    accessToken: "oauth-access-token-secret",
    refreshToken: "oauth-refresh-token-secret",
    extraApiKey: "sk-live-extra-secret-tail-2003",
  };
  const connection = await providersDb.createProviderConnection({
    provider: "codex",
    authType: "oauth",
    name: "codex account",
    apiKey: secrets.apiKey,
    accessToken: secrets.accessToken,
    refreshToken: secrets.refreshToken,
    providerSpecificData: {
      tag: "production",
      extraApiKeys: [secrets.extraApiKey],
    },
  });

  const request = await makeManagementSessionRequest("http://localhost/api/providers/client");
  const response = await providerClientRoute.GET(request);
  assert.equal(response.status, 200);
  const payload = (await response.json()) as {
    connections: Array<Record<string, unknown>>;
  };
  const projected = payload.connections.find((entry) => entry.id === connection.id);
  assert.ok(projected);
  assert.equal(projected.apiKey, "sk-live-****1002");
  assert.equal("accessToken" in projected, false);
  assert.equal("refreshToken" in projected, false);
  const providerSpecificData = projected.providerSpecificData as Record<string, unknown>;
  assert.equal(providerSpecificData.tag, "production");
  assert.deepEqual(providerSpecificData.extraApiKeys, ["sk-live-****2003#0"]);

  const serialized = JSON.stringify(payload);
  for (const secret of Object.values(secrets)) {
    assert.equal(serialized.includes(secret), false, `raw credential leaked: ${secret}`);
  }
});

test("GET /api/providers/client rejects unauthenticated requests when management auth is enabled", async () => {
  const response = await providerClientRoute.GET(
    new Request("http://localhost/api/providers/client")
  );
  assert.equal(response.status, 401);
});
