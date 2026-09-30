import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Database from "better-sqlite3";

type CountRow = { n: number };
type ArtifactRow = { artifact_relpath: string | null };

const migration = fs.readFileSync("src/lib/db/migrations/176_call_log_identities.sql", "utf8");

function oldDatabase() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE call_logs (
    id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, status INTEGER,
    detail_state TEXT, artifact_relpath TEXT
  )`);
  db.prepare("INSERT INTO call_logs VALUES (?, ?, ?, ?, ?)").run(
    "old-pending::attempt::old-dispatch",
    "2026-09-29T12:00:00.000Z",
    200,
    "ready",
    "2026-09-29/old-artifact.json"
  );
  return db;
}

test("identity migration is idempotent and does not rewrite old rows or artifact references", () => {
  const db = oldDatabase();
  try {
    const before = db.prepare("SELECT * FROM call_logs").all();
    db.transaction(() => db.exec(migration))();
    db.exec(migration);
    assert.deepEqual(db.prepare("SELECT * FROM call_logs").all(), before);
    assert.equal(db.prepare<[], CountRow>("SELECT count(*) AS n FROM call_log_identities").get().n, 0);
    assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
    const indexRows = db.pragma("index_list(call_log_identities)") as { name: string }[];
    const indexes = indexRows.map((row) => row.name);
    assert.ok(indexes.includes("idx_cli_lookup"));
    assert.ok(indexes.includes("idx_cli_logical"));
  } finally {
    db.close();
  }
});

test("a rolled-back schema upgrade preserves the old schema and data", () => {
  const db = oldDatabase();
  try {
    assert.throws(
      () =>
        db.transaction(() => {
          db.exec(migration);
          throw new Error("rollback fixture");
        })(),
      /rollback fixture/
    );
    assert.equal(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'call_log_identities'").get(),
      undefined
    );
    assert.equal(db.prepare<[], CountRow>("SELECT count(*) AS n FROM call_logs").get().n, 1);
  } finally {
    db.close();
  }
});

test("old-version exact-ID readers and DELETEs still work after the additive upgrade", () => {
  const db = oldDatabase();
  try {
    db.exec(migration);
    const newId = "84b88575-4de2-43c7-a695-000000000001";
    db.prepare(
      `INSERT INTO call_log_identities
      (physical_id, lookup_key, logical_key, owner_pid, created_at, published)
      VALUES (?, 'alias-digest', 'group-digest', ?, 1, 1)`
    ).run(newId, process.pid);
    db.prepare("INSERT INTO call_logs VALUES (?, ?, 200, 'ready', ?)").run(
      newId,
      "2026-09-29T12:00:00.000Z",
      "2026-09-29/new-artifact.json"
    );
    assert.equal(
      db
        .prepare<[string], ArtifactRow>("SELECT artifact_relpath FROM call_logs WHERE id = ?")
        .get(newId).artifact_relpath,
      "2026-09-29/new-artifact.json"
    );
    db.prepare("DELETE FROM call_logs WHERE id = ?").run(newId);
    assert.equal(db.prepare<[], CountRow>("SELECT count(*) AS n FROM call_log_identities").get().n, 0);
    assert.equal(db.prepare<[], CountRow>("SELECT count(*) AS n FROM call_logs").get().n, 1);
    // Removing the additive mapping for an offline schema rollback loses new
    // aliases, not pre-existing rows, physical IDs, or their artifact references.
    db.exec("DROP TRIGGER call_logs_delete_identity; DROP TABLE call_log_identities;");
    assert.equal(
      db
        .prepare<[string], ArtifactRow>("SELECT artifact_relpath FROM call_logs WHERE id = ?")
        .get("old-pending::attempt::old-dispatch").artifact_relpath,
      "2026-09-29/old-artifact.json"
    );
  } finally {
    db.close();
  }
});
