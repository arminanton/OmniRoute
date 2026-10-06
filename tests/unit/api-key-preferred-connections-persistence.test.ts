process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const BetterSqlite3 = require_("better-sqlite3") as typeof import("better-sqlite3");
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-api-key-preferred-connections-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-secret";

const core = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const migrationPath = path.resolve(
  import.meta.dirname ?? ".",
  "../../src/lib/db/migrations/178_api_key_preferred_connections.sql"
);

function reset() {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(reset);
test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("migration adds an empty default for existing API keys", () => {
  const db = new BetterSqlite3(":memory:");
  db.exec("CREATE TABLE api_keys (id TEXT PRIMARY KEY)");
  db.exec(fs.readFileSync(migrationPath, "utf8"));
  const column = db
    .prepare("PRAGMA table_info(api_keys)")
    .all()
    .find((entry: { name: string }) => entry.name === "preferred_connections");
  assert.ok(column);
  assert.equal(column.dflt_value, "'[]'");
  db.prepare("INSERT INTO api_keys (id) VALUES (?)").run("legacy-key");
  assert.equal(
    db.prepare("SELECT preferred_connections FROM api_keys WHERE id = ?").get("legacy-key")
      .preferred_connections,
    "[]"
  );
  db.close();
});

test("create, metadata read, update, and clear persist ordered preferences", async () => {
  const primary = "00000000-0000-4000-8000-000000000001";
  const secondary = "00000000-0000-4000-8000-000000000002";
  const created = await apiKeysDb.createApiKey("preferred-test", "machine-preferred-test", [], {
    preferredConnections: [primary, secondary],
  });

  assert.deepEqual((await apiKeysDb.getApiKeyById(created.id)).preferredConnections, [
    primary,
    secondary,
  ]);
  assert.deepEqual((await apiKeysDb.getApiKeyMetadata(created.key)).preferredConnections, [
    primary,
    secondary,
  ]);

  await apiKeysDb.updateApiKeyPermissions(created.id, {
    preferredConnections: [secondary, primary],
  });
  assert.deepEqual((await apiKeysDb.getApiKeyById(created.id)).preferredConnections, [
    secondary,
    primary,
  ]);
  assert.deepEqual((await apiKeysDb.getApiKeyMetadata(created.key)).preferredConnections, [
    secondary,
    primary,
  ]);

  await apiKeysDb.updateApiKeyPermissions(created.id, { preferredConnections: [] });
  assert.deepEqual((await apiKeysDb.getApiKeyById(created.id)).preferredConnections, []);
});
