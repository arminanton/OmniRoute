import assert from "node:assert/strict";
import { createHash, randomUUID, createCipheriv, scryptSync, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Set every storage/encryption input BEFORE importing core or the domain module.
// These are synthetic fixtures. Never inherit an operator's encryption key.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-maxai-leases-"));
process.env.DATA_DIR = dir;
Object.assign(process.env, { NODE_ENV: "test" });
process.env.API_KEY_SECRET = "maxai-refresh-leases-test-secret";
process.env.STORAGE_ENCRYPTION_KEY = "maxai-refresh-leases-test-encryption-key";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
const realFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error("Network is forbidden in persistence tests");
};

const core = await import("../../../src/lib/db/core.ts");
const { maxaiRefreshStore: store } = await import("../../../src/lib/db/maxaiCredentials.ts");
const { encrypt, decrypt } = await import("../../../src/lib/db/encryption.ts");
const realNow = Date.now;
let now = realNow();
Date.now = () => now;

function jwt(label: string, exp = Math.floor(now / 1000) + 3600): string {
  return `fixture.${Buffer.from(JSON.stringify({ sub: "synthetic-user", exp, label })).toString("base64url")}.fake`;
}
function fingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
function connection(legacy = false, provider = "maxai") {
  const id = randomUUID();
  const credential = {
    accessToken: jwt(`old-${id}`),
    refreshToken: `synthetic-refresh-${id}`,
    deviceId: "synthetic-device",
    userId: "synthetic-user",
  };
  const psd = {
    maxaiDeviceId: credential.deviceId,
    maxaiUserId: credential.userId,
    unrelated: { keep: true },
    ...(legacy
      ? { maxaiAccessToken: credential.accessToken, maxaiRefreshToken: credential.refreshToken }
      : {}),
  };
  core
    .getDbInstance()
    .prepare(
      `INSERT INTO provider_connections
    (id, provider, auth_type, access_token, refresh_token, api_key, provider_specific_data, created_at, updated_at)
    VALUES (?, ?, 'apikey', ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      provider,
      legacy ? null : encrypt(credential.accessToken),
      legacy ? null : encrypt(credential.refreshToken),
      legacy ? encrypt(credential.accessToken) : null,
      JSON.stringify(psd),
      new Date(now).toISOString(),
      new Date(now).toISOString()
    );
  return { id, credential };
}
async function readCredential(id: string) {
  const saved = await store.read(id);
  if (!saved) return null;
  assert.match(saved.credentialVersion, /^[a-f0-9]{64}$/);
  return {
    accessToken: saved.accessToken,
    refreshToken: saved.refreshToken,
    deviceId: saved.deviceId,
    userId: saved.userId,
  };
}

function leaseFor(id: string, refreshToken: string, duration = 30_000) {
  return {
    connectionId: id,
    generation: fingerprint(refreshToken),
    owner: randomUUID(),
    leaseExpiresAt: now + duration,
    expectedCredentialVersion: store.read(id)?.credentialVersion ?? "0".repeat(64),
  };
}
function rotated(credential: ReturnType<typeof connection>["credential"]) {
  return {
    ...credential,
    accessToken: jwt(`new-${randomUUID()}`),
    refreshToken: `rotated-${randomUUID()}`,
  };
}
function rawConnection(id: string) {
  return core
    .getDbInstance()
    .prepare("SELECT * FROM provider_connections WHERE id = ?")
    .get(id) as {
    access_token: string;
    refresh_token: string;
    api_key: string | null;
    provider_specific_data: string;
    expires_at: string;
    token_expires_at: string;
  };
}
function leaseRow(id: string, generation: string) {
  return core
    .getDbInstance()
    .prepare("SELECT * FROM maxai_refresh_leases WHERE connection_id = ? AND generation = ?")
    .get(id, generation) as
    { state: string; failure_code: string | null; owner: string } | undefined;
}

test.after(() => {
  Date.now = realNow;
  globalThis.fetch = realFetch;
  core.resetDbInstance();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("migration 177 is automatically applied and idempotent", () => {
  const db = core.getDbInstance();
  assert.equal(
    (
      db.prepare("SELECT name FROM _omniroute_migrations WHERE version = '177'").get() as {
        name: string;
      }
    ).name,
    "maxai_refresh_leases"
  );
  const sql = fs.readFileSync(
    new URL("../../../src/lib/db/migrations/177_maxai_refresh_leases.sql", import.meta.url),
    "utf8"
  );
  db.exec(sql);
  db.exec(sql);
  assert.equal(core.DATA_DIR, dir);
});

test("canonical encrypted credentials and legacy PSD/apiKey credentials are readable", async () => {
  for (const legacy of [false, true]) {
    const { id, credential } = connection(legacy);
    assert.deepEqual(await readCredential(id), credential);
  }
});

test("missing connection, other provider, missing refresh and malformed PSD fail closed", async () => {
  assert.equal(await readCredential("missing"), null);
  assert.equal(await store.acquire(leaseFor("missing", "synthetic")), "missing");
  const other = connection(false, "nous-oauth");
  assert.equal(await readCredential(other.id), null);
  assert.equal(await store.acquire(leaseFor(other.id, other.credential.refreshToken)), "missing");
  const { id, credential } = connection();
  core
    .getDbInstance()
    .prepare("UPDATE provider_connections SET refresh_token = NULL WHERE id = ?")
    .run(id);
  assert.equal(await readCredential(id), null);
  assert.equal(await store.acquire(leaseFor(id, credential.refreshToken)), "missing");
  for (const psd of ["{bad", "[]", "null"]) {
    core
      .getDbInstance()
      .prepare(
        "UPDATE provider_connections SET refresh_token = ?, provider_specific_data = ? WHERE id = ?"
      )
      .run(encrypt(credential.refreshToken), psd, id);
    assert.equal(await readCredential(id), null);
    assert.equal(await store.acquire(leaseFor(id, credential.refreshToken)), "missing");
  }
});

test("only one owner acquires a generation; stale callers cannot acquire or release it", async () => {
  const { id, credential } = connection();
  const first = leaseFor(id, credential.refreshToken);
  assert.equal(await store.acquire(first), "acquired");
  assert.equal(await store.acquire(leaseFor(id, credential.refreshToken)), "busy");
  assert.equal(await store.acquire(leaseFor(id, "wrong-generation")), "stale");
  await store.release({ ...first, owner: randomUUID() });
  assert.equal(await store.acquire(leaseFor(id, credential.refreshToken)), "busy");
  assert.equal(await store.markSent({ ...first, owner: randomUUID() }), false);
  assert.equal(
    await store.commit({ ...first, credential: rotated(credential) }),
    false,
    "unsent cannot commit"
  );
  await store.release(first);
  assert.equal(await store.acquire(leaseFor(id, credential.refreshToken)), "acquired");
});

test("expired unsent leases may retry, but late owners cannot mark sent or commit", async () => {
  const { id, credential } = connection();
  const first = leaseFor(id, credential.refreshToken, 10);
  assert.equal(await store.acquire(first), "acquired");
  now += 10;
  assert.equal(await store.markSent(first), false);
  assert.equal(await store.commit({ ...first, credential: rotated(credential) }), false);
  const second = leaseFor(id, credential.refreshToken);
  assert.equal(await store.acquire(second), "acquired");
  assert.equal(await store.markSent(first), false);
  await store.release(first);
  assert.equal(leaseRow(id, first.generation)?.owner, second.owner);
});

test("sent grants survive release, expiry and restart without a second dispatch", async () => {
  const { id, credential } = connection();
  const lease = leaseFor(id, credential.refreshToken, 10);
  assert.equal(await store.acquire(lease), "acquired");
  assert.equal(await store.markSent(lease), true);
  assert.equal(
    await store.markSent(lease),
    false,
    "markSent is one-shot, not idempotent dispatch permission"
  );
  await store.release(lease);
  assert.equal(await store.acquire(leaseFor(id, credential.refreshToken)), "busy");
  now += 10;
  core.resetDbInstance();
  assert.equal(await store.acquire(leaseFor(id, credential.refreshToken)), "quarantined");
  assert.equal(await store.commit({ ...lease, credential: rotated(credential) }), false);
  assert.equal(await store.markSent(lease), false);
  assert.equal(leaseRow(id, lease.generation)?.state, "quarantined");
  assert.ok(leaseRow(id, lease.generation)?.failure_code);
  assert.equal(rawConnection(id).refresh_token.startsWith("enc:v1:"), true);
});

test("successful CAS encrypts both rotated tokens and merges the newest unrelated PSD", async () => {
  for (const legacy of [false, true]) {
    const { id, credential } = connection(legacy);
    const before = rawConnection(id);
    const lease = leaseFor(id, credential.refreshToken);
    assert.equal(await store.acquire(lease), "acquired");
    assert.deepEqual(rawConnection(id), before, "acquire never migrates credentials prematurely");
    assert.equal(await store.markSent(lease), true);
    const psd = JSON.parse(before.provider_specific_data);
    core
      .getDbInstance()
      .prepare("UPDATE provider_connections SET provider_specific_data = ? WHERE id = ?")
      .run(JSON.stringify({ ...psd, unrelated: { newest: true }, concurrent: "keep" }), id);
    const next = rotated(credential);
    assert.equal(await store.commit({ ...lease, credential: next }), true);
    assert.deepEqual(await readCredential(id), next);
    const saved = rawConnection(id);
    assert.ok(saved.access_token.startsWith("enc:v1:"));
    assert.ok(saved.refresh_token.startsWith("enc:v1:"));
    assert.equal(decrypt(saved.access_token), next.accessToken);
    assert.equal(decrypt(saved.refresh_token), next.refreshToken);
    assert.ok(saved.api_key?.startsWith("enc:v1:"));
    assert.equal(decrypt(saved.api_key), next.accessToken);
    assert.deepEqual(JSON.parse(saved.provider_specific_data), {
      maxaiDeviceId: credential.deviceId,
      maxaiUserId: credential.userId,
      unrelated: { newest: true },
      concurrent: "keep",
    });
    assert.equal(saved.expires_at, saved.token_expires_at);
    assert.ok(new Date(saved.expires_at).getTime() > now);
    assert.equal(leaseRow(id, lease.generation)?.state, "committed");
    assert.equal(await store.commit({ ...lease, credential: rotated(next) }), false);
    assert.equal(await store.acquire(leaseFor(id, credential.refreshToken)), "stale");
    assert.equal(await store.acquire(leaseFor(id, next.refreshToken)), "acquired");
  }
});

test("legacy API-key-only access fallback and encrypted PSD aliases migrate safely", async () => {
  const { id, credential } = connection(true);
  const psd = JSON.parse(rawConnection(id).provider_specific_data);
  delete psd.maxaiAccessToken;
  psd.maxaiRefreshToken = encrypt(credential.refreshToken);
  core
    .getDbInstance()
    .prepare("UPDATE provider_connections SET provider_specific_data = ? WHERE id = ?")
    .run(JSON.stringify(psd), id);
  assert.deepEqual(await readCredential(id), credential);
  const lease = leaseFor(id, credential.refreshToken);
  assert.equal(await store.acquire(lease), "acquired");
  assert.equal(await store.markSent(lease), true);
  const next = rotated(credential);
  assert.equal(await store.commit({ ...lease, credential: next }), true);
  assert.deepEqual(await readCredential(id), next);
  assert.equal(JSON.parse(rawConnection(id).provider_specific_data).maxaiRefreshToken, undefined);
});

test("corrupt canonical credentials never fall back to stale plaintext PSD aliases", async () => {
  const { id, credential } = connection(true);
  const corrupt = "enc:v1:00000000000000000000000000000000:00:00000000000000000000000000000000";
  core
    .getDbInstance()
    .prepare("UPDATE provider_connections SET refresh_token = ? WHERE id = ?")
    .run(corrupt, id);
  assert.equal(await readCredential(id), null);
  assert.equal(await store.acquire(leaseFor(id, credential.refreshToken)), "missing");
});

test("a changed original cipher or credential identity prevents dispatch and late overwrite", async () => {
  for (const field of [
    "refresh_token",
    "access_token",
    "api_key",
    "provider_specific_data",
    "provider",
  ]) {
    const { id, credential } = connection();
    const lease = leaseFor(id, credential.refreshToken);
    assert.equal(await store.acquire(lease), "acquired");
    // Re-encrypting the same token is enough to invalidate the original cipher CAS.
    const value =
      field === "refresh_token"
        ? encrypt(credential.refreshToken)
        : field === "access_token"
          ? encrypt(credential.accessToken)
          : field === "api_key"
            ? encrypt("synthetic-new-api-key")
            : field === "provider"
              ? "other-provider"
              : JSON.stringify({ maxaiDeviceId: "new-device", maxaiUserId: credential.userId });
    const sql = `UPDATE provider_connections SET ${field} = ? WHERE id = ?`;
    core.getDbInstance().prepare(sql).run(value, id);
    assert.equal(await store.markSent(lease), false, field);
    assert.equal(await store.commit({ ...lease, credential: rotated(credential) }), false, field);
  }
  for (const legacy of [false, true]) {
    const { id, credential } = connection(legacy);
    const lease = leaseFor(id, credential.refreshToken);
    assert.equal(await store.acquire(lease), "acquired");
    assert.equal(await store.markSent(lease), true);
    const next = rotated(credential);
    const latestPsd = { maxaiDeviceId: next.deviceId, maxaiUserId: next.userId, newest: "keep" };
    core
      .getDbInstance()
      .prepare(
        `UPDATE provider_connections SET access_token = ?, refresh_token = ?,
        api_key = ?, provider_specific_data = ? WHERE id = ?`
      )
      .run(
        encrypt(next.accessToken),
        encrypt(next.refreshToken),
        encrypt(next.accessToken),
        JSON.stringify(latestPsd),
        id
      );
    const newest = rawConnection(id);
    assert.equal(await store.commit({ ...lease, credential: rotated(credential) }), false);
    assert.deepEqual(rawConnection(id), newest, "stale response cannot restore an old snapshot");
    assert.equal(leaseRow(id, lease.generation)?.state, "quarantined");
    assert.equal(leaseRow(id, lease.generation)?.failure_code, "refresh_conflict");
  }
});

test("late, expired, malformed, and wrong-owner results cannot commit", async () => {
  const { id, credential } = connection();
  const lease = leaseFor(id, credential.refreshToken, 20);
  assert.equal(await store.acquire(lease), "acquired");
  assert.equal(await store.markSent(lease), true);
  const before = rawConnection(id);
  const next = rotated(credential);
  assert.equal(await store.commit({ ...lease, owner: randomUUID(), credential: next }), false);
  for (const accessToken of [
    "",
    "opaque-token",
    jwt("expired", Math.floor(now / 1000)),
    jwt("infinite", 1e300),
    "bad token",
  ]) {
    assert.equal(await store.commit({ ...lease, credential: { ...next, accessToken } }), false);
  }
  now += 20;
  assert.equal(await store.commit({ ...lease, credential: next }), false);
  assert.deepEqual(rawConnection(id), before);
  assert.equal(leaseRow(id, lease.generation)?.failure_code, "refresh_expired");
});

test("credential update and spent marker roll back together on a DB failure", async () => {
  const { id, credential } = connection();
  const lease = leaseFor(id, credential.refreshToken);
  assert.equal(await store.acquire(lease), "acquired");
  assert.equal(await store.markSent(lease), true);
  const before = rawConnection(id);
  core.getDbInstance().exec(`CREATE TEMP TRIGGER maxai_test_fail_commit
    BEFORE UPDATE ON maxai_refresh_leases WHEN NEW.state = 'committed'
    BEGIN SELECT RAISE(ABORT, 'synthetic-private-error'); END;`);
  try {
    await assert.rejects(async () => store.commit({ ...lease, credential: rotated(credential) }), {
      message: "MaxAI credential persistence failed",
    });
  } finally {
    core.getDbInstance().exec("DROP TRIGGER maxai_test_fail_commit");
  }
  assert.deepEqual(rawConnection(id), before);
  assert.equal(leaseRow(id, lease.generation)?.state, "sent");
  await store.release(lease);
  now += 30_000;
  assert.equal(await store.acquire(leaseFor(id, credential.refreshToken)), "quarantined");
});

test("uncertain and spent generations remain blocked after credentials change and revert", async () => {
  for (const success of [false, true]) {
    const { id, credential } = connection();
    const before = rawConnection(id);
    const lease = leaseFor(id, credential.refreshToken, 10);
    assert.equal(await store.acquire(lease), "acquired");
    assert.equal(await store.markSent(lease), true);
    if (success)
      assert.equal(await store.commit({ ...lease, credential: rotated(credential) }), true);
    else
      core
        .getDbInstance()
        .prepare("UPDATE provider_connections SET refresh_token = ? WHERE id = ?")
        .run(encrypt("other-synthetic-generation"), id);
    now += 10;
    core
      .getDbInstance()
      .prepare(
        "UPDATE provider_connections SET access_token = ?, refresh_token = ?, api_key = ? WHERE id = ?"
      )
      .run(before.access_token, before.refresh_token, before.api_key, id);
    assert.equal(await store.acquire(leaseFor(id, credential.refreshToken)), "quarantined");
  }
});

test("lease table contains only redacted state and native nested transactions fail closed", async () => {
  const { id, credential } = connection();
  const lease = leaseFor(id, credential.refreshToken);
  assert.equal(await store.acquire(lease), "acquired");
  const db = core.getDbInstance();
  db.transaction(() => {
    assert.throws(() => store.markSent(lease), /durable native SQLite transaction/);
  })();
  assert.equal(leaseRow(id, lease.generation)?.state, "acquired");
  assert.equal(await store.markSent(lease), true);
  const persisted = JSON.stringify(leaseRow(id, lease.generation));
  for (const forbidden of [
    credential.accessToken,
    credential.refreshToken,
    "enc:v1:",
    credential.deviceId,
    credential.userId,
  ]) {
    assert.equal(persisted.includes(forbidden), false);
  }
  assert.equal(leaseRow(id, lease.generation)?.failure_code, "refresh_uncertain");
  assert.equal(
    Number(db.pragma("synchronous", { simple: true })),
    1,
    "restore the application's NORMAL setting"
  );
});

test("missing encryption and invalid/unbounded lease inputs fail before any reservation", async () => {
  const { id, credential } = connection();
  const lease = leaseFor(id, credential.refreshToken);
  for (const leaseExpiresAt of [now, now - 1, now + 30_001]) {
    assert.equal(await store.acquire({ ...lease, leaseExpiresAt }), "stale");
  }
  assert.equal(await store.acquire({ ...lease, owner: "not-a-uuid" }), "missing");
  const key = process.env.STORAGE_ENCRYPTION_KEY;
  delete process.env.STORAGE_ENCRYPTION_KEY;
  try {
    await assert.rejects(async () => store.acquire(lease), /credential encryption/);
  } finally {
    process.env.STORAGE_ENCRYPTION_KEY = key;
  }
  assert.equal(leaseRow(id, lease.generation), undefined);
});

test("only exact post-commit snapshots allow settled non-rotating refresh reuse", async () => {
  const { id, credential } = connection(true);
  const first = leaseFor(id, credential.refreshToken);
  assert.equal(await store.acquire(first), "acquired");
  assert.equal(await store.markSent(first), true);
  const next = { ...credential, accessToken: jwt("settled-no-rotation") };
  assert.equal(await store.commit({ ...first, credential: next }), true);
  core.resetDbInstance();
  assert.deepEqual(await readCredential(id), next);
  const second = leaseFor(id, credential.refreshToken);
  assert.equal(await store.acquire(second), "acquired");
  assert.equal(await store.markSent(first), false);
  assert.equal(await store.commit({ ...first, credential: rotated(credential) }), false);
  assert.equal(await store.markSent(second), true);
  const settled = { ...next, accessToken: jwt("settled-again") };
  assert.equal(await store.commit({ ...second, credential: settled }), true);
  // Re-encrypting identical plaintext is NOT evidence of a settled response.
  core
    .getDbInstance()
    .prepare("UPDATE provider_connections SET refresh_token = ? WHERE id = ?")
    .run(encrypt(credential.refreshToken), id);
  assert.equal(await store.acquire(leaseFor(id, credential.refreshToken)), "quarantined");
});

test("an uncertain second use of a previously settled token remains permanently blocked", async () => {
  const { id, credential } = connection();
  const first = leaseFor(id, credential.refreshToken);
  assert.equal(await store.acquire(first), "acquired");
  assert.equal(await store.markSent(first), true);
  assert.equal(
    await store.commit({ ...first, credential: { ...credential, accessToken: jwt("settled") } }),
    true
  );
  const second = leaseFor(id, credential.refreshToken, 10);
  assert.equal(await store.acquire(second), "acquired");
  assert.equal(await store.markSent(second), true);
  now += 10;
  await store.release(second);
  assert.equal(await store.acquire(leaseFor(id, credential.refreshToken)), "quarantined");
});

test("legacy dynamic-salt encrypted PSD decodes without rewriting until successful CAS", async () => {
  const { id, credential } = connection(true);
  const secret = process.env.STORAGE_ENCRYPTION_KEY!;
  const salt = createHash("sha256").update(secret).digest().subarray(0, 16);
  const key = scryptSync(secret, salt, 32);
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = cipher.update(credential.refreshToken, "utf8", "hex") + cipher.final("hex");
  const legacyCipher = `enc:v1:${iv.toString("hex")}:${encrypted}:${cipher.getAuthTag().toString("hex")}`;
  const psd = JSON.parse(rawConnection(id).provider_specific_data);
  psd.maxaiRefreshToken = legacyCipher;
  core
    .getDbInstance()
    .prepare("UPDATE provider_connections SET provider_specific_data = ? WHERE id = ?")
    .run(JSON.stringify(psd), id);
  assert.deepEqual(await readCredential(id), credential);
  assert.equal(
    JSON.parse(rawConnection(id).provider_specific_data).maxaiRefreshToken,
    legacyCipher
  );
  const lease = leaseFor(id, credential.refreshToken);
  assert.equal(await store.acquire(lease), "acquired");
  assert.equal(await store.markSent(lease), true);
  const next = rotated(credential);
  assert.equal(await store.commit({ ...lease, credential: next }), true);
  assert.deepEqual(await readCredential(id), next);
});

test("SQL.js and in-memory storage never authorize dispatch", async () => {
  const { setDbInstance } = await import("../../../src/lib/db/singleton.ts");
  const native = core.getDbInstance();
  for (const replacement of [
    { ...native, driver: "sql.js" as const },
    { ...native, name: ":memory:" },
  ]) {
    setDbInstance(replacement);
    try {
      assert.throws(() => store.read("synthetic-id"), /durable native SQLite transaction/);
    } finally {
      setDbInstance(native);
    }
  }
});

const workerSource = String.raw`
  // Independent OS process; the test sets a synthetic DATA_DIR and encryption key.
  globalThis.fetch = async () => { throw new Error("Network forbidden"); };
  const job = JSON.parse(process.env.MAXAI_TEST_JOB);
  Date.now = () => job.now;
  const { maxaiRefreshStore: store } = await import(job.moduleUrl);
  const status = await store.acquire(job.lease);
  const sent = job.send && status === "acquired" ? await store.markSent(job.lease) : false;
  process.stdout.write("RESULT:" + JSON.stringify({ status, sent }) + "\n", () => {
    // Deliberately skip graceful DB close/checkpoint/exit handlers.
    if (job.crash) process.kill(process.pid, "SIGKILL");
    else process.exit(0);
  });
`;

function worker(lease: ReturnType<typeof leaseFor>, send = false, crash = false) {
  return new Promise<{ status: string; sent: boolean; signal: string | null }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx/esm", "--input-type=module", "--eval", workerSource],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            MAXAI_TEST_JOB: JSON.stringify({
              lease,
              send,
              crash,
              now,
              moduleUrl: new URL("../../../src/lib/db/maxaiCredentials.ts", import.meta.url).href,
            }),
          },
          stdio: ["ignore", "pipe", "pipe"],
        }
      );
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.once("error", reject);
      child.once("close", (code, signal) => {
        const result = output.split("\n").find((line) => line.startsWith("RESULT:"));
        if (!result || (code !== 0 && signal !== "SIGKILL")) {
          reject(new Error(`Synthetic worker failed: ${output}`));
          return;
        }
        resolve({ ...JSON.parse(result.slice("RESULT:".length)), signal });
      });
    }
  );
}

test("independent processes racing for the same persisted generation get only one lease", async () => {
  const { id, credential } = connection();
  const results = await Promise.all([
    worker(leaseFor(id, credential.refreshToken)),
    worker(leaseFor(id, credential.refreshToken)),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["acquired", "busy"]);
});

test("SIGKILL after durable markSent cannot replay the grant in a later process", async () => {
  const { id, credential } = connection();
  const lease = leaseFor(id, credential.refreshToken, 10);
  const sent = await worker(lease, true, true);
  assert.deepEqual(sent, { status: "acquired", sent: true, signal: "SIGKILL" });
  now += 10;
  const retry = await worker(leaseFor(id, credential.refreshToken), true);
  assert.equal(retry.status, "quarantined");
  assert.equal(retry.sent, false);
  assert.equal(await store.commit({ ...lease, credential: rotated(credential) }), false);
  assert.deepEqual(await readCredential(id), credential);
});

test("a pre-commit waiter cannot reacquire even after a successful identical-token response", async () => {
  const { id, credential } = connection();
  const active = leaseFor(id, credential.refreshToken);
  const staleWaiter = leaseFor(id, credential.refreshToken);
  assert.equal(await store.acquire(active), "acquired");
  assert.equal(await store.markSent(active), true);
  assert.equal(await store.commit({ ...active, credential }), true);
  assert.equal(await store.acquire(staleWaiter), "stale");
  assert.equal(await store.acquire(leaseFor(id, credential.refreshToken)), "acquired");
});

test("mx alias rows refresh with an exact-original-provider CAS", async () => {
  for (const legacy of [false, true]) {
    const { id, credential } = connection(legacy, "mx");
    assert.deepEqual(await readCredential(id), credential);
    const lease = leaseFor(id, credential.refreshToken);
    assert.equal(await store.acquire(lease), "acquired");
    assert.equal(await store.markSent(lease), true);
    const next = rotated(credential);
    assert.equal(await store.commit({ ...lease, credential: next }), true);
    assert.deepEqual(await readCredential(id), next);
    assert.equal(
      (
        core
          .getDbInstance()
          .prepare("SELECT provider FROM provider_connections WHERE id = ?")
          .get(id) as { provider: string }
      ).provider,
      "mx"
    );
  }
  const { id, credential } = connection(false, "mx");
  const lease = leaseFor(id, credential.refreshToken);
  assert.equal(await store.acquire(lease), "acquired");
  assert.equal(await store.markSent(lease), true);
  core
    .getDbInstance()
    .prepare("UPDATE provider_connections SET provider = 'maxai' WHERE id = ?")
    .run(id);
  const latest = rawConnection(id);
  assert.equal(await store.commit({ ...lease, credential: rotated(credential) }), false);
  assert.deepEqual(
    rawConnection(id),
    latest,
    "changing even to the canonical alias invalidates the lease"
  );
});
