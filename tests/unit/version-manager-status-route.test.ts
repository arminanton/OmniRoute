import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-version-manager-status-route-"));
const ORIGINALS = Object.fromEntries(
  [
    "DATA_DIR",
    "API_KEY_SECRET",
    "OMNIROUTE_DISABLE_REDIS_AUTH_CACHE",
    "JWT_SECRET",
    "INITIAL_PASSWORD",
  ].map((key) => [key, process.env[key]])
);

process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "version-manager-status-route-test-secret";
process.env.OMNIROUTE_DISABLE_REDIS_AUTH_CACHE = "1";

const core = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const versionManagerDb = await import("../../src/lib/db/versionManager.ts");
const statusRoute = await import("../../src/app/api/version-manager/status/route.ts");

test.before(async () => {
  process.env.JWT_SECRET = "version-manager-status-route-jwt";
  process.env.INITIAL_PASSWORD = "version-manager-status-route-password";
  await settingsDb.updateSettings({ requireLogin: true });
});

test.after(() => {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  for (const [key, value] of Object.entries(ORIGINALS)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("version-manager status returns operational fields without stored credentials/config and is no-store", async () => {
  const apiKeySecret = "version-manager-api-key-secret";
  const managementKeySecret = "version-manager-management-key-secret";
  const overrideSecret = "config-overrides-nested-secret";
  const stored = await versionManagerDb.upsertVersionManagerTool({
    tool: "version-manager-status-test",
    currentVersion: "6.1.0",
    installedVersion: "6.0.0",
    binaryPath: "/tmp/version-manager-status-test",
    status: "running",
    pid: 6123,
    port: 8317,
    apiKey: apiKeySecret,
    managementKey: managementKeySecret,
    autoUpdate: false,
    autoStart: true,
    healthStatus: "healthy",
    configOverrides: { privateSettings: { token: overrideSecret } },
  });

  // The projection is an HTTP-boundary change; stored/internal rows retain their full fields.
  assert.equal(stored.apiKey, apiKeySecret);
  assert.equal(stored.managementKey, managementKeySecret);
  assert.deepEqual(stored.configOverrides, { privateSettings: { token: overrideSecret } });

  const managementApiKey = await apiKeysDb.createApiKey("version-manager-status", "test-machine", [
    "manage",
  ]);
  const response = await statusRoute.GET(
    new Request("http://localhost/api/version-manager/status", {
      headers: { authorization: `Bearer ${managementApiKey.key}` },
    })
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const rows = (await response.json()) as Array<Record<string, unknown>>;
  const row = rows.find((entry) => entry.tool === "version-manager-status-test");
  assert.ok(row, "the test row should remain in the HTTP status array");
  assert.equal(row.currentVersion, "6.1.0");
  assert.equal(row.installedVersion, "6.0.0");
  assert.equal(row.status, "running");
  assert.equal(row.pid, 6123);
  assert.equal(row.port, 8317);
  assert.equal(row.healthStatus, "healthy");
  assert.equal(row.autoUpdate, false);
  assert.equal(row.autoStart, true);
  assert.equal(Object.hasOwn(row, "apiKey"), false);
  assert.equal(Object.hasOwn(row, "managementKey"), false);
  assert.equal(Object.hasOwn(row, "configOverrides"), false);

  const body = JSON.stringify(rows);
  assert.doesNotMatch(body, /version-manager-api-key-secret/);
  assert.doesNotMatch(body, /version-manager-management-key-secret/);
  assert.doesNotMatch(body, /config-overrides-nested-secret/);
});
