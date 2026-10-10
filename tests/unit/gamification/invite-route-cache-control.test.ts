import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-invite-route-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "invite-route-cache-control-test-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../../src/lib/db/core.ts");
const settingsDb = await import("../../../src/lib/db/settings.ts");
const inviteRoute = await import("../../../src/app/api/gamification/invite/route.ts");
const { NextRequest } = await import("next/server");

before(async () => {
  core.resetDbInstance();
  await settingsDb.updateSettings({ requireLogin: false });
});

after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("POST /api/gamification/invite marks plaintext invite credentials no-store", async () => {
  const response = await inviteRoute.POST(
    new NextRequest("http://localhost/api/gamification/invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKeyId: "invite-route-test-key", maxUses: 1 }),
    }),
  );

  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = (await response.json()) as { code: string; token: string };
  assert.equal(body.code.length, 8);
  assert.ok(body.token.length > 0);
});
