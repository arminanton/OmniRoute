import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-cli-connect-route-"));
const ENV_KEYS = ["DATA_DIR", "INITIAL_PASSWORD", "OMNIROUTE_DISABLE_REDIS_AUTH_CACHE"] as const;
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key] ?? null]));

process.env.DATA_DIR = TEST_DATA_DIR;
process.env.INITIAL_PASSWORD = "cli-connect-test-password";
process.env.OMNIROUTE_DISABLE_REDIS_AUTH_CACHE = "1";

const core = await import("../../src/lib/db/core.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const route = await import("../../src/app/api/cli/connect/route.ts");

test.before(async () => {
  await settingsDb.updateSettings({ requireLogin: true, bruteForceProtection: false });
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  for (const key of ENV_KEYS) {
    const original = ORIGINAL_ENV[key];
    if (original === null) delete process.env[key];
    else process.env[key] = original;
  }
});

test("CLI connect returns the one-time plaintext token with no-store cache policy", async () => {
  const response = await route.POST(
    new Request("http://localhost/api/cli/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "cli-connect-test-password" }),
    })
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = (await response.json()) as { success: boolean; token: string };
  assert.equal(body.success, true);
  assert.match(body.token, /^oma_live_[A-Za-z0-9_-]+$/);
});
