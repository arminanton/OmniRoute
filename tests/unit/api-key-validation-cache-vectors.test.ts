import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-api-key-cache-vectors-"));
process.env.DATA_DIR = testDataDir;
process.env.API_KEY_SECRET = "api-key-cache-vector-test-only";
process.env.NODE_ENV = "test";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../src/lib/db/core.ts");
const apiKeys = await import("../../src/lib/db/apiKeys.ts");

type VectorAction =
  | { op: "seed-key"; key: string; valid: boolean }
  | { op: "seed-valid-range"; prefix: string; start: number; endInclusive: number }
  | { op: "set-authoritative-validity"; key: string; valid: boolean }
  | { op: "validate"; key: string; atMs: number; expected: boolean }
  | {
      op: "validate-range";
      prefix: string;
      start: number;
      endInclusive: number;
      atMs: number;
    }
  | { op: "write-invalidate"; key: string; valid: boolean }
  | { op: "revoke"; key: string };

type CacheVectorFixture = {
  schemaVersion: number;
  policy: { ttlMs: number; maxEntries: number; evictEntries: number };
  vectors: Array<{ name: string; actions: VectorAction[] }>;
};

const fixturePath = fileURLToPath(
  new URL(
    "../../benchmarks/runtime-proxy/fixtures/api-key-validation-cache-v1.json",
    import.meta.url
  )
);
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as CacheVectorFixture;

type ApiKeysDb = {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { changes?: number };
  };
};

function dataDb(): ApiKeysDb {
  return core.getDbInstance() as unknown as ApiKeysDb;
}

function insertFixtureKey(key: string, valid: boolean, ids: Map<string, string>): void {
  const id = `fixture:${randomUUID()}`;
  const result = dataDb()
    .prepare(
      "INSERT INTO api_keys (id, name, key, machine_id, created_at, is_active) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(id, `cache-vector:${key}`, key, "cache-vector", new Date(0).toISOString(), valid ? 1 : 0);
  assert.equal(result.changes, 1, `fixture key ${key} should be inserted`);
  ids.set(key, id);
}

function setAuthoritativeValidity(key: string, valid: boolean): void {
  // Deliberately bypass the API mutation path so this action does not clear the process cache.
  const result = dataDb()
    .prepare("UPDATE api_keys SET is_active = ? WHERE key = ?")
    .run(valid ? 1 : 0, key);
  assert.equal(result.changes, 1, `fixture key ${key} should be updated directly`);
}

function withClock<T>(nowMs: number, fn: () => T): T {
  const originalNow = Date.now;
  Date.now = () => nowMs;
  try {
    return fn();
  } finally {
    Date.now = originalNow;
  }
}

async function validateAt(key: string, atMs: number, expected: boolean, vectorName: string) {
  const actual = await withClock(atMs, () => apiKeys.validateApiKey(key));
  assert.equal(actual, expected, `${vectorName}: validate(${key}) at ${atMs}ms`);
}

function seedValidRange(
  prefix: string,
  start: number,
  endInclusive: number,
  ids: Map<string, string>
): void {
  const db = dataDb();
  const insert = db.prepare(
    "INSERT INTO api_keys (id, name, key, machine_id, created_at, is_active) VALUES (?, ?, ?, ?, ?, 1)"
  );
  db.exec("BEGIN IMMEDIATE");
  try {
    for (let index = start; index <= endInclusive; index++) {
      const key = `${prefix}${index}`;
      const id = `fixture:${randomUUID()}`;
      const result = insert.run(
        id,
        `cache-vector:${key}`,
        key,
        "cache-vector",
        new Date(0).toISOString()
      );
      assert.equal(result.changes, 1, `fixture key ${key} should be inserted`);
      ids.set(key, id);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

async function runAction(
  action: VectorAction,
  ids: Map<string, string>,
  vectorName: string
): Promise<void> {
  switch (action.op) {
    case "seed-key":
      insertFixtureKey(action.key, action.valid, ids);
      return;
    case "seed-valid-range":
      seedValidRange(action.prefix, action.start, action.endInclusive, ids);
      return;
    case "set-authoritative-validity":
      setAuthoritativeValidity(action.key, action.valid);
      return;
    case "validate":
      await validateAt(action.key, action.atMs, action.expected, vectorName);
      return;
    case "validate-range":
      for (let index = action.start; index <= action.endInclusive; index++) {
        await validateAt(`${action.prefix}${index}`, action.atMs, true, vectorName);
      }
      return;
    case "write-invalidate": {
      const id = ids.get(action.key);
      assert.ok(id, `${vectorName}: missing fixture id for ${action.key}`);
      assert.equal(
        await apiKeys.updateApiKeyPermissions(id, { isActive: action.valid }),
        true,
        `${vectorName}: local key write should succeed`
      );
      return;
    }
    case "revoke": {
      const id = ids.get(action.key);
      assert.ok(id, `${vectorName}: missing fixture id for ${action.key}`);
      assert.equal(await apiKeys.revokeApiKey(id), true, `${vectorName}: revoke should succeed`);
      return;
    }
  }
}

test("TypeScript local API-key cache follows the shared deterministic action vectors", async () => {
  assert.equal(fixture.schemaVersion, 1);
  assert.deepEqual(fixture.policy, { ttlMs: 60_000, maxEntries: 1_000, evictEntries: 200 });

  for (const vector of fixture.vectors) {
    apiKeys.resetApiKeyState();
    core.resetDbInstance();
    fs.rmSync(testDataDir, { recursive: true, force: true });
    fs.mkdirSync(testDataDir, { recursive: true });
    core.getDbInstance();
    await apiKeys.getApiKeys(); // Run the API-key column fallback before fixture SQL inserts.

    const ids = new Map<string, string>();
    try {
      for (const action of vector.actions) await runAction(action, ids, vector.name);
    } catch (error) {
      assert.fail(`${vector.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
});

test.after(() => {
  apiKeys.resetApiKeyState();
  core.resetDbInstance();
  fs.rmSync(testDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
