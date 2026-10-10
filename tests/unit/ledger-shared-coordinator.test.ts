import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { SqliteCoordinator } from "../../open-sse/services/coordination/sqliteCoordinator.ts";
import { buildAntigravityModelCooldownKey } from "../../open-sse/services/coordination/antigravityModelCooldown.ts";
test("separate processes share atomic permits, FIFO, expiry and fences", () => {
  const dir = mkdtempSync(join(tmpdir(), "omni-coordination-"));
  const file = join(dir, "permits.sqlite");
  const a = new SqliteCoordinator(file, "old");
  const b = new SqliteCoordinator(file, "candidate");
  try {
    const first = a.enqueue([{ key: "account", limit: 1 }], 9000, 20, 1000);
    const lease = a.tryAcquire(first, 1000, 1000)!;
    assert.ok(lease);
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx/esm",
        "--input-type=module",
        "-e",
        `import {SqliteCoordinator} from './open-sse/services/coordination/sqliteCoordinator.ts'; const c=new SqliteCoordinator(process.env.TEST_COORDINATION_DB,'child'); const id=c.enqueue([{key:'account',limit:1}],9000,20,1000); console.log(c.tryAcquire(id,1000,1000)); c.cancel(id); c.close();`,
      ],
      { encoding: "utf8", env: { ...process.env, TEST_COORDINATION_DB: file } }
    );
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout.trim(), "null");
    const wait = b.enqueue([{ key: "account", limit: 1 }], 9000, 20, 1000);
    assert.equal(b.tryAcquire(wait, 1000, 1000), null);
    const separate = b.enqueue([{ key: "other", limit: 1 }], 9000, 20, 1000);
    const independent = b.tryAcquire(separate, 1000, 1000)!;
    assert.ok(independent);
    assert.equal(b.renew(lease, 1000, 1100), false);
    assert.equal(a.renew(lease, 1000, 1100), true);
    assert.equal(b.tryAcquire(wait, 1000, 2000), null);
    const next = b.tryAcquire(wait, 1000, 2200)!;
    assert.ok(next);
    assert.ok(next.fence > lease.fence);
    assert.equal(a.valid(lease, 2200), false);
    a.release(lease);
    assert.equal(b.valid(next, 2200), true);
    b.release(next);
    b.release(independent);
  } finally {
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shared cooldown cannot be shortened and cap disagreement remains conservative", () => {
  const dir = mkdtempSync(join(tmpdir(), "omni-cooldown-"));
  const file = join(dir, "c.sqlite");
  const a = new SqliteCoordinator(file, "a"),
    b = new SqliteCoordinator(file, "b");
  try {
    a.block("quota", 2000);
    b.block("quota", 1500);
    const id = b.enqueue([{ key: "quota", limit: 4 }], 9000, 20, 1000);
    assert.equal(b.tryAcquire(id, 1000, 1700), null);
    const first = b.tryAcquire(id, 1000, 2100)!;
    assert.ok(first);
    const strict = a.enqueue([{ key: "quota", limit: 1 }], 9000, 20, 2100);
    assert.equal(a.tryAcquire(strict, 1000, 2100), null);
    b.release(first);
    const l = a.tryAcquire(strict, 1000, 2100)!;
    assert.ok(l);
    const wide = b.enqueue([{ key: "quota", limit: 4 }], 9000, 20, 2100);
    assert.equal(b.tryAcquire(wide, 1000, 2100), null);
    a.release(l);
    assert.ok(b.tryAcquire(wide, 1000, 2100));
  } finally {
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Antigravity model cooldown is shared by workers and scoped to one account/model tuple", () => {
  const dir = mkdtempSync(join(tmpdir(), "omni-ag-model-cooldown-"));
  const file = join(dir, "c.sqlite");
  const owner = new SqliteCoordinator(file, "owner");
  const follower = new SqliteCoordinator(file, "follower");
  try {
    const blocked = buildAntigravityModelCooldownKey(
      "synthetic-account",
      "gemini-3.8-flash-high",
      "active"
    );
    const sameAlias = buildAntigravityModelCooldownKey(
      "synthetic-account",
      " GEMINI-3.8-FLASH-HIGH ",
      "active"
    );
    const siblingModel = buildAntigravityModelCooldownKey(
      "synthetic-account",
      "claude-sonnet-4-6",
      "active"
    );
    const siblingAccount = buildAntigravityModelCooldownKey(
      "another-account",
      "gemini-3.8-flash-high",
      "active"
    );
    const pending = buildAntigravityModelCooldownKey(
      "synthetic-account",
      "gemini-3.8-flash-high",
      "pending"
    );
    assert.ok(blocked && siblingModel && siblingAccount && pending);
    assert.equal(sameAlias, blocked);
    const until = Date.now() + 60_000;
    owner.block(blocked, until);
    assert.equal(follower.blockUntil(blocked), until);
    assert.deepEqual([...follower.blockUntilMany([blocked, siblingModel])], [[blocked, until]]);
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx/esm",
        "--input-type=module",
        "-e",
        `import {SqliteCoordinator} from './open-sse/services/coordination/sqliteCoordinator.ts'; const c=new SqliteCoordinator(process.env.TEST_COORDINATION_DB,'child'); console.log(c.blockUntil(process.env.TEST_COOLDOWN_KEY)); c.close();`,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, TEST_COORDINATION_DB: file, TEST_COOLDOWN_KEY: blocked },
      }
    );
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout.trim(), String(until));
    assert.equal(follower.blockUntil(siblingModel), null);
    assert.equal(follower.blockUntil(siblingAccount), null);
    owner.block(pending, until);
    owner.unblockPrefix("cooldown:active:v1:");
    assert.equal(follower.blockUntil(blocked), null);
    assert.equal(follower.blockUntil(pending), until);
    owner.unblockPrefix("cooldown:pending:v1:");
    assert.equal(follower.blockUntil(pending), null);
  } finally {
    owner.close();
    follower.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shared adaptation reuses measured windows and never exceeds operator cap", () => {
  const dir = mkdtempSync(join(tmpdir(), "omni-adaptation-"));
  const a = new SqliteCoordinator(join(dir, "a.sqlite"), "a");
  try {
    const reserve = (now: number) => {
      const id = a.enqueue([{ key: "a", limit: 4, adaptive: true }], now + 10000, 20, now);
      return a.tryAcquire(id, 1000, now);
    };
    const first = reserve(1000)!;
    assert.ok(first);
    a.observe("a", "concurrency_overload", 0, 1000);
    const second = reserve(1000)!;
    assert.ok(second);
    assert.equal(reserve(1000), null);
    a.observe("a", "concurrency_overload", 0, 1000); // only one critical decrease per measured window
    a.release(first);
    a.release(second);
    assert.ok(reserve(32000));
  } finally {
    a.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("only explicit concurrency overload yields adaptive capacity reduction", async () => {
  const { classifyAdmissionFeedback } =
    await import("../../open-sse/services/coordination/overloadClassification.ts");
  assert.equal(classifyAdmissionFeedback(429, "usage quota exhausted"), "ignored");
  assert.equal(classifyAdmissionFeedback(401, "too_many_concurrent_requests"), "ignored");
  assert.equal(classifyAdmissionFeedback(503, "upstream timeout"), "ignored");
  assert.equal(
    classifyAdmissionFeedback(429, "Too many concurrent requests"),
    "concurrency_overload"
  );
});

test("generation counters exclude maintenance and report queued reservations for the actual owner", () => {
  const dir = mkdtempSync(join(tmpdir(), "omni-counter-"));
  const a = new SqliteCoordinator(join(dir, "c.sqlite"), "generation-a");
  try {
    const maintenance = a.enqueue([{ key: "task:maintenance", limit: 1 }], 9000, 20, 1000);
    a.tryAcquire(maintenance, 1000, 1000);
    const generation = a.enqueue([{ key: "account:a", limit: 1 }], 9000, 20, 1000);
    const lease = a.tryAcquire(generation, 1000, 1000)!;
    const queued = a.enqueue([{ key: "account:a", limit: 1 }], 9000, 20, 1000);
    assert.equal(a.tryAcquire(queued, 1000, 1000), null);
    assert.deepEqual(a.runtimeCounts(1000), {
      owner: "generation-a",
      activeGeneration: 1,
      queuedGeneration: 1,
      observedAt: 1000,
    });
    a.cancel(queued);
    a.release(lease);
    assert.equal(a.runtimeCounts(1000).activeGeneration, 0);
  } finally {
    a.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
