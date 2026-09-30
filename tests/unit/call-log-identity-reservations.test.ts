import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-call-log-reservations-"));
process.env.DATA_DIR = dataDir;
process.env.CALL_LOG_RETENTION_DAYS = "3650";
const core = await import("../../src/lib/db/core.ts");
const logs = await import("../../src/lib/usage/callLogs.ts");
const identities = await import("../../src/lib/db/callLogIdentities.ts");
const artifacts = await import("../../src/lib/usage/callLogArtifacts.ts");
const timestamp = "2026-09-29T12:00:00.000Z";

test.after(async () => {
  await logs.closeCallLogSaves(10_000);
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function savedEntry(id: string, model = "fixture-model") {
  return { id, timestamp, status: 200, model, provider: "fixture-provider", responseBody: { id } };
}

function identityRow(id: string) {
  return core
    .getDbInstance()
    .prepare("SELECT * FROM call_log_identities WHERE physical_id = ?")
    .get(id);
}

test("UUID collisions retry before artifact writes, including legacy physical IDs", async (t) => {
  const oldId = "84b88575-4de2-43c7-a695-000000000011";
  const reservedId = "84b88575-4de2-43c7-a695-000000000012";
  const freshId = "84b88575-4de2-43c7-a695-000000000013";
  core
    .getDbInstance()
    .prepare("INSERT INTO call_logs (id, timestamp, status) VALUES (?, ?, 200)")
    .run(oldId, timestamp);
  const next = [reservedId, oldId, reservedId, freshId];
  const uuid = t.mock.method(globalThis.crypto, "randomUUID", () => next.shift()!);
  const pending = identities.reserveCallLogIdentity("pending-collision");
  await logs.saveCallLog(savedEntry("collision-alias"));
  assert.equal(uuid.mock.callCount(), 4);
  assert.equal((await logs.getCallLogById("collision-alias"))?.id, freshId);
  assert.ok(identityRow(pending.id));
  assert.equal(
    fs.existsSync(
      path.join(dataDir, "call_logs", artifacts.buildArtifactRelativePath(timestamp, oldId))
    ),
    false
  );
  assert.equal(
    fs.existsSync(
      path.join(dataDir, "call_logs", artifacts.buildArtifactRelativePath(timestamp, reservedId))
    ),
    false
  );
  assert.ok(identities.releaseCallLogIdentity(pending));
});

test("exhausted collisions are bounded and do not consume another reservation", async (t) => {
  const id = "84b88575-4de2-43c7-a695-000000000021";
  const uuid = t.mock.method(globalThis.crypto, "randomUUID", () => id);
  const pending = identities.reserveCallLogIdentity("bounded-pending");
  t.mock.method(console, "error", () => {});
  await logs.saveCallLog(savedEntry("bounded-alias"));
  assert.equal(uuid.mock.callCount(), 4, "one reservation plus three bounded retries");
  assert.ok(identityRow(id));
  assert.equal(await logs.getCallLogById("bounded-alias"), null);
  assert.ok(identities.releaseCallLogIdentity(pending));
});

test("failed final insert rolls back publication and cleans only its own artifact/reservation", async (t) => {
  const id = "84b88575-4de2-43c7-a695-000000000031";
  await logs.saveCallLog(savedEntry("unchanged-alias"));
  const earlier = await logs.getCallLogById("unchanged-alias");
  assert.ok(earlier?.artifactRelPath);
  const earlierPath = path.join(dataDir, "call_logs", earlier.artifactRelPath);
  const before = fs.readFileSync(earlierPath, "utf8");
  t.mock.method(globalThis.crypto, "randomUUID", () => id);
  t.mock.method(console, "error", () => {});
  core.getDbInstance().exec(`CREATE TEMP TRIGGER fail_identity_fixture BEFORE INSERT ON call_logs
    WHEN NEW.model = 'fail-insert' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;`);
  try {
    await logs.saveCallLog(savedEntry("unchanged-alias", "fail-insert"));
    assert.equal(identityRow(id), undefined);
    assert.equal(await logs.getCallLogById(id), null);
    assert.equal((await logs.getCallLogById("unchanged-alias"))?.id, earlier.id);
    assert.equal(fs.readFileSync(earlierPath, "utf8"), before);
    assert.equal(
      fs.existsSync(
        path.join(dataDir, "call_logs", artifacts.buildArtifactRelativePath(timestamp, id))
      ),
      false
    );
  } finally {
    core.getDbInstance().exec("DROP TRIGGER fail_identity_fixture");
  }
});

test("unpublished aliases are invisible, and active reservations protect artifacts regardless of age", async () => {
  const pending = identities.reserveCallLogIdentity("live-pending");
  const relativePath = artifacts.buildArtifactRelativePath(timestamp, pending.id);
  const absolutePath = path.join(dataDir, "call_logs", relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, '{"pending":true}');
  fs.utimesSync(absolutePath, 1, 1);
  core
    .getDbInstance()
    .prepare("UPDATE call_log_identities SET created_at = 1 WHERE physical_id = ?")
    .run(pending.id);
  assert.equal(await logs.getCallLogById("live-pending"), null);
  assert.equal(await logs.getCallLogById(pending.id), null);
  assert.equal(
    (await logs.getCallLogs({})).some((row) => row.id === pending.id),
    false
  );
  identities.cleanupAbandonedCallLogIdentities();
  logs.cleanupOrphanCallLogFiles();
  assert.ok(identityRow(pending.id));
  assert.equal(fs.existsSync(absolutePath), true);
  assert.ok(identities.releaseCallLogIdentity(pending));
  logs.cleanupOrphanCallLogFiles();
  assert.equal(fs.existsSync(absolutePath), false);
});

test("cleanup requires a definitely exited same-namespace owner, never age, PID reuse, or an unknown process check", (t) => {
  const db = core.getDbInstance();
  const live = identities.reserveCallLogIdentity("other-process-live");
  const denied = identities.reserveCallLogIdentity("other-process-denied");
  const dead = identities.reserveCallLogIdentity("other-process-dead");
  const otherScope = identities.reserveCallLogIdentity("other-namespace");
  const unknownScope = identities.reserveCallLogIdentity("unknown-namespace");
  const unsupported = identities.reserveCallLogIdentity("unsupported-process-check");
  for (const [identity, pid] of [
    [live, 111111],
    [denied, 222222],
    [dead, 333333],
    [otherScope, 444444],
    [unknownScope, 555555],
    [unsupported, 666666],
  ] as const) {
    db.prepare(
      "UPDATE call_log_identities SET owner_pid = ?, created_at = 1 WHERE physical_id = ?"
    ).run(pid, identity.id);
  }
  db.prepare(
    "UPDATE call_log_identities SET owner_scope = 'different-pid-namespace' WHERE physical_id = ?"
  ).run(otherScope.id);
  db.prepare("UPDATE call_log_identities SET owner_scope = NULL WHERE physical_id = ?").run(
    unknownScope.id
  );
  t.mock.method(process, "kill", (pid: number) => {
    if (pid === 111111) return true; // Live process or PID reuse: neither may be deleted.
    if (pid === 666666) throw Object.assign(new Error("unsupported check"), { code: "ENOSYS" });
    if (pid === 222222) throw Object.assign(new Error("permission denied"), { code: "EPERM" });
    throw Object.assign(new Error("process exited"), { code: "ESRCH" });
  });
  // Bounded cursor pages advance past live owners, rather than starving the
  // dead owner behind them or making a whole-table JS snapshot.
  for (let page = 0; page < 10; page++) identities.cleanupAbandonedCallLogIdentities(1);
  assert.ok(identityRow(live.id));
  assert.ok(identityRow(denied.id));
  assert.ok(identityRow(otherScope.id));
  assert.ok(identityRow(unknownScope.id));
  assert.ok(identityRow(unsupported.id));
  if (process.platform === "linux") assert.equal(identityRow(dead.id), undefined);
  for (const identity of [live, denied, dead, otherScope, unknownScope, unsupported]) {
    db.prepare("UPDATE call_log_identities SET owner_pid = ? WHERE physical_id = ?").run(
      process.pid,
      identity.id
    );
    identities.releaseCallLogIdentity(identity);
  }
});

test("retention and direct purge delete published mappings with their rows", async () => {
  await logs.saveCallLog(savedEntry("retained-mapping"));
  const row = await logs.getCallLogById("retained-mapping");
  assert.ok(row);
  assert.ok(identityRow(row.id));
  core.getDbInstance().prepare("DELETE FROM call_logs WHERE id = ?").run(row.id);
  assert.equal(identityRow(row.id), undefined);
  assert.equal(await logs.getCallLogById("retained-mapping"), null);
  await logs.saveCallLog({
    ...savedEntry("expired-mapping"),
    timestamp: "2020-01-01T00:00:00.000Z",
  });
  const expired = await logs.getCallLogById("expired-mapping");
  assert.ok(expired);
  logs.deleteCallLogsBefore("2021-01-01T00:00:00.000Z");
  assert.equal(identityRow(expired.id), undefined);
  assert.equal(await logs.getCallLogById("expired-mapping"), null);
});

test("lookup keys are bounded and literal even for oversized or path-like caller IDs", async () => {
  const alias = "../untrusted/" + "x".repeat(100_000) + "_%_ABC";
  await logs.saveCallLog(savedEntry(alias));
  const detail = await logs.getCallLogById(alias);
  assert.ok(detail);
  assert.match(detail.id, /^[0-9a-f-]{36}$/);
  assert.ok(detail.artifactRelPath && detail.artifactRelPath.length < 100);
  const row = identityRow(detail.id) as { lookup_key: string; logical_key: string };
  assert.equal(row.lookup_key.length, 64);
  assert.equal(row.logical_key.length, 64);
  assert.equal(await logs.getCallLogById(alias.toLowerCase()), null);
});

test("latest completed alias ignores timestamp/UUID order and excludes a later pending save", async (t) => {
  const highId = "ffffffff-ffff-4fff-afff-ffffffffffff";
  const lowId = "00000000-0000-4000-a000-000000000001";
  const pendingId = "00000000-0000-4000-a000-000000000002";
  const ids = [highId, lowId, pendingId];
  t.mock.method(globalThis.crypto, "randomUUID", () => ids.shift()!);
  await logs.saveCallLog({ ...savedEntry("ordered-alias"), timestamp: "2026-09-29T14:00:00.000Z" });
  await logs.saveCallLog({ ...savedEntry("ordered-alias"), timestamp: "2026-09-29T13:00:00.000Z" });
  assert.equal((await logs.getCallLogById("ordered-alias"))?.id, lowId);
  const pending = identities.reserveCallLogIdentity("ordered-alias");
  for (let repeat = 0; repeat < 3; repeat++) {
    assert.equal((await logs.getCallLogById("ordered-alias"))?.id, lowId);
    assert.equal((await logs.getCallLogById(highId))?.id, highId);
    assert.equal(await logs.getCallLogById(pendingId), null);
  }
  const { getCallLogsForExport } = await import("../../src/lib/usage/callLogExportSource.ts");
  assert.equal(
    getCallLogsForExport(0, 1000).some((row) => row.record.id === pendingId),
    false
  );
  assert.ok(identities.releaseCallLogIdentity(pending));
});

test("both exact alias lookups use bounded index searches rather than the published-row scan", (t) => {
  const db = core.getDbInstance();
  const originalPrepare = db.prepare.bind(db);
  const plans: string[] = [];
  t.mock.method(db, "prepare", (sql: string) => {
    if (sql.includes("SELECT identities.physical_id, identities.ordinal")) {
      const rows = originalPrepare(`EXPLAIN QUERY PLAN ${sql}`).all("fixture-key") as Array<{
        detail: string;
      }>;
      plans.push(rows.map((row) => row.detail).join("\n"));
    }
    return originalPrepare(sql);
  });
  assert.equal(identities.resolveCallLogAlias("unknown-alias"), null);
  assert.equal(plans.length, 2);
  assert.match(plans[0], /SEARCH identities USING INDEX idx_cli_lookup/);
  assert.match(plans[1], /SEARCH identities USING INDEX idx_cli_logical/);
  assert.ok(plans.every((plan) => !/SCAN identities|USE TEMP B-TREE/.test(plan)));
});

test("orphan cleanup keeps one snapshot across publication by another SQLite connection", async (t) => {
  const pending = identities.reserveCallLogIdentity("publication-race");
  const relativePath = artifacts.buildArtifactRelativePath(timestamp, pending.id);
  const absolutePath = path.join(dataDir, "call_logs", relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, '{"responseBody":{"race":"preserved"}}');
  fs.utimesSync(absolutePath, 1, 1);
  const db = core.getDbInstance();
  const { default: Database } = await import("better-sqlite3");
  const writer = new Database(db.name);
  let published = false;
  const originalPrepare = db.prepare.bind(db);
  t.mock.method(db, "prepare", (sql: string) => {
    if (!published && sql.includes("SELECT physical_id FROM call_log_identities")) {
      // The final-row SELECT already returned. A different connection now
      // finishes the save before the reserved-artifact SELECT executes.
      writer.transaction(() => {
        writer
          .prepare(
            `INSERT INTO call_logs
          (id, timestamp, status, detail_state, artifact_relpath)
          VALUES (?, ?, 200, 'ready', ?)`
          )
          .run(pending.id, timestamp, relativePath);
        writer
          .prepare("UPDATE call_log_identities SET published = 1 WHERE physical_id = ?")
          .run(pending.id);
      })();
      published = true;
    }
    return originalPrepare(sql);
  });
  try {
    logs.cleanupOrphanCallLogFiles();
    assert.equal(published, true, "fixture must publish between the two reference reads");
    assert.equal(
      fs.existsSync(absolutePath),
      true,
      "a just-published artifact must not be deleted"
    );
    assert.deepEqual((await logs.getCallLogById(pending.id))?.responseBody, { race: "preserved" });
  } finally {
    writer.close();
  }
});

test("persistent-mode missing identity schema remains an error, not a false lookup miss", async () => {
  const { shouldPersistToDisk } = await import("../../src/lib/usage/migrations.ts");
  assert.equal(shouldPersistToDisk, true);
  const db = core.getDbInstance();
  db.exec("ALTER TABLE call_log_identities RENAME TO unavailable_identity_fixture");
  try {
    await assert.rejects(
      logs.getCallLogById("missing-persistent-id"),
      /no such table: call_log_identities/
    );
  } finally {
    db.exec("ALTER TABLE unavailable_identity_fixture RENAME TO call_log_identities");
  }
});
