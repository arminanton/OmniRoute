import test from "node:test";
import assert from "node:assert/strict";

// The cloud adapter intentionally uses only the base in-memory schema, not
// persistent migrations, and saveCallLog is disabled there. No disk DB is read.
const originalCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
Object.defineProperty(globalThis, "caches", { value: {}, configurable: true });
const core = await import("../../src/lib/db/core.ts");
const logs = await import("../../src/lib/usage/callLogs.ts");
const { shouldPersistToDisk } = await import("../../src/lib/usage/migrations.ts");

test.after(() => {
  core.resetDbInstance();
  if (originalCaches) Object.defineProperty(globalThis, "caches", originalCaches);
  else Reflect.deleteProperty(globalThis, "caches");
});

test("non-persistent memory mode keeps exact/legacy lookup and missing-ID behavior without mapping schema", async (t) => {
  assert.equal(shouldPersistToDisk, false);
  const db = core.getDbInstance();
  assert.equal(db.name, ":memory:");
  assert.equal(
    db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'call_log_identities'").get(),
    undefined
  );
  assert.equal(await logs.getCallLogById("missing-memory-id"), null);
  db.prepare("INSERT INTO call_logs (id, timestamp, status) VALUES (?, ?, 204)").run(
    "memory-group::attempt::legacy",
    "2026-09-29T12:00:00.000Z"
  );
  assert.equal((await logs.getCallLogById("memory-group::attempt::legacy"))?.status, 204);
  assert.equal((await logs.getCallLogById("memory-group"))?.id, "memory-group::attempt::legacy");
  await logs.saveCallLog({ id: "disabled-memory-save", status: 200 });
  assert.equal(await logs.getCallLogById("disabled-memory-save"), null);
  const errors = t.mock.method(console, "error", () => {});
  logs.rotateCallLogs();
  assert.equal(
    errors.mock.callCount(),
    0,
    "disabled disk rotation must not query migration-only tables"
  );
});
