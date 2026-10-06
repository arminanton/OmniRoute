import {
  createAdaptationState,
  closeAdaptationWindow,
  noteLatency,
  sampleActiveIntegral,
  setPressure,
  type AdaptationState,
} from "../admission/adaptation.ts";
import { validateConfig } from "../admission/config.ts";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export const COORDINATION_PROTOCOL = "omni-coordination/v1";
export interface CoordinationRequirement {
  key: string;
  limit: number;
  adaptive?: boolean;
}
export interface FencedLease {
  id: string;
  fence: number;
  expiresAt: number;
}

/** Dedicated local SQLite file on a shared POSIX volume. Never use sql.js/NFS for coordination. */
export class SqliteCoordinator {
  private db: DatabaseSync;
  constructor(
    filename: string,
    readonly owner: string
  ) {
    if (!owner.trim()) throw new Error("Coordination owner is required");
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS coordination_protocol (version TEXT PRIMARY KEY);
      INSERT OR IGNORE INTO coordination_protocol VALUES ('omni-coordination/v1');
      CREATE TABLE IF NOT EXISTS coordination_sequence (id INTEGER PRIMARY KEY AUTOINCREMENT);
      CREATE TABLE IF NOT EXISTS coordination_leases
        (id TEXT PRIMARY KEY, owner TEXT NOT NULL, fence INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS coordination_resources
        (lease_id TEXT NOT NULL, resource TEXT NOT NULL, cap INTEGER NOT NULL, PRIMARY KEY (lease_id, resource));
      CREATE INDEX IF NOT EXISTS coordination_resource ON coordination_resources(resource);
      CREATE TABLE IF NOT EXISTS coordination_adaptation (resource TEXT PRIMARY KEY, state TEXT NOT NULL, sampled_at INTEGER NOT NULL, configured_cap INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS coordination_blocks (resource TEXT PRIMARY KEY, until_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS coordination_waiters
        (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
         owner TEXT NOT NULL, resources TEXT NOT NULL, expires INTEGER NOT NULL);`);
    const versions = this.db.prepare("SELECT version FROM coordination_protocol").all();
    if (versions.length !== 1 || versions[0].version !== COORDINATION_PROTOCOL)
      throw new Error("Incompatible coordination protocol");
  }
  private atomic<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private prune(now: number): void {
    this.db
      .prepare(
        "DELETE FROM coordination_resources WHERE lease_id IN (SELECT id FROM coordination_leases WHERE expires <= ?)"
      )
      .run(now);
    this.db.prepare("DELETE FROM coordination_leases WHERE expires <= ?").run(now);
    this.db.prepare("DELETE FROM coordination_waiters WHERE expires <= ?").run(now);
  }
  enqueue(
    requirements: CoordinationRequirement[],
    expiresAt: number,
    maxQueueSize = 20,
    now = Date.now()
  ): string {
    if (!requirements.length || !Number.isFinite(expiresAt)) throw new Error("Invalid reservation");
    for (const r of requirements)
      if (!r.key || !Number.isSafeInteger(r.limit) || r.limit < 1)
        throw new Error("Invalid coordination requirement");
    const limits = new Map<string, number>();
    for (const r of requirements)
      limits.set(r.key, Math.min(limits.get(r.key) ?? r.limit, r.limit));
    const normalized = [...limits].map(([key, limit]) => ({
      key,
      limit,
      adaptive: requirements.some((r) => r.key === key && r.adaptive),
    }));
    return this.atomic(() => {
      this.prune(now);
      const waiting = this.db.prepare("SELECT resources FROM coordination_waiters").all();
      if (
        maxQueueSize > 0 &&
        normalized.some(
          (r) =>
            waiting.filter((row) =>
              (JSON.parse(String(row.resources)) as CoordinationRequirement[]).some(
                (w) => w.key === r.key
              )
            ).length >= maxQueueSize
        )
      )
        throw Object.assign(new Error("Shared admission queue is full"), {
          code: "SEMAPHORE_QUEUE_FULL",
        });
      const id = randomUUID();
      this.db
        .prepare("INSERT INTO coordination_waiters (id,owner,resources,expires) VALUES (?,?,?,?)")
        .run(id, this.owner, JSON.stringify(normalized), expiresAt);
      return id;
    });
  }

  tryAcquire(id: string, ttlMs: number, now = Date.now()): FencedLease | null {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000) throw new Error("Invalid lease TTL");
    return this.atomic(() => {
      this.prune(now);
      const row = this.db
        .prepare("SELECT * FROM coordination_waiters WHERE id=? AND owner=?")
        .get(id, this.owner);
      if (!row) return null;
      const requirements = JSON.parse(String(row.resources)) as CoordinationRequirement[];
      const older = this.db
        .prepare("SELECT resources FROM coordination_waiters WHERE sequence < ?")
        .all(row.sequence);
      // Independent accounts may progress; overlapping requests retain FIFO fairness across processes.
      if (
        older.some((other) =>
          (JSON.parse(String(other.resources)) as CoordinationRequirement[]).some((r) =>
            requirements.some((ours) => ours.key === r.key)
          )
        )
      )
        return null;
      for (const r of requirements) {
        const adaptiveCap = r.adaptive ? this.adaptiveLimit(r.key, r.limit, now) : r.limit;
        const block = this.db
          .prepare("SELECT until_ms FROM coordination_blocks WHERE resource=?")
          .get(r.key);
        if (Number(block?.until_ms ?? 0) > now) return null;
        const count = this.db
          .prepare(
            "SELECT COUNT(*) AS n, MIN(cap) AS cap FROM coordination_resources WHERE resource=?"
          )
          .get(r.key);
        if (Number(count?.n) >= Math.min(adaptiveCap, Number(count?.cap ?? r.limit))) return null;
      }
      const fence = Number(
        this.db.prepare("INSERT INTO coordination_sequence DEFAULT VALUES").run().lastInsertRowid
      );
      const expiresAt = now + ttlMs;
      this.db
        .prepare("INSERT INTO coordination_leases VALUES (?,?,?,?)")
        .run(id, this.owner, fence, expiresAt);
      for (const r of requirements)
        this.db
          .prepare("INSERT INTO coordination_resources VALUES (?,?,?)")
          .run(id, r.key, r.limit);
      this.db.prepare("DELETE FROM coordination_waiters WHERE id=?").run(id);
      return { id, fence, expiresAt };
    });
  }
  renew(lease: FencedLease, ttlMs: number, now = Date.now()): boolean {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000) throw new Error("Invalid lease TTL");
    return (
      Number(
        this.db
          .prepare(
            "UPDATE coordination_leases SET expires=? WHERE id=? AND owner=? AND fence=? AND expires>?"
          )
          .run(now + ttlMs, lease.id, this.owner, lease.fence, now).changes
      ) === 1
    );
  }
  valid(lease: FencedLease, now = Date.now()): boolean {
    return !!this.db
      .prepare(
        "SELECT id FROM coordination_leases WHERE id=? AND owner=? AND fence=? AND expires>?"
      )
      .get(lease.id, this.owner, lease.fence, now);
  }
  release(lease: FencedLease): void {
    this.atomic(() => {
      if (
        !this.db
          .prepare("SELECT id FROM coordination_leases WHERE id=? AND owner=? AND fence=?")
          .get(lease.id, this.owner, lease.fence)
      )
        return;
      this.db.prepare("DELETE FROM coordination_resources WHERE lease_id=?").run(lease.id);
      this.db.prepare("DELETE FROM coordination_leases WHERE id=?").run(lease.id);
    });
  }
  cancel(id: string): void {
    this.db.prepare("DELETE FROM coordination_waiters WHERE id=? AND owner=?").run(id, this.owner);
  }
  private adaptiveLimit(resource: string, cap: number, now: number): number {
    const row = this.db
      .prepare("SELECT * FROM coordination_adaptation WHERE resource=?")
      .get(resource);
    const params = validateConfig({
      mode: "enforce",
      maxQueueCount: 1,
      maxQueueCost: 1,
      initialLimit: cap,
      minLimit: 1,
      maxLimit: cap,
      windowMs: 30000,
    }).adaptation;
    const state = row
      ? (JSON.parse(String(row.state)) as AdaptationState)
      : createAdaptationState(cap, 1, cap, now);
    state.currentLimit = Math.min(cap, Math.max(1, state.currentLimit));
    state.recoveryCeiling = cap;
    const active = Number(
      this.db
        .prepare("SELECT COUNT(*) AS n FROM coordination_resources WHERE resource=?")
        .get(resource)?.n ?? 0
    );
    sampleActiveIntegral(state, active, Math.max(0, now - Number(row?.sampled_at ?? now)));
    if (now - state.windowStartMs >= params.windowMs) closeAdaptationWindow(state, params, now);
    this.db
      .prepare(
        "INSERT INTO coordination_adaptation VALUES (?,?,?,?) ON CONFLICT(resource) DO UPDATE SET state=excluded.state,sampled_at=excluded.sampled_at,configured_cap=excluded.configured_cap"
      )
      .run(resource, JSON.stringify(state), now, cap);
    return state.currentLimit;
  }
  observe(
    resource: string,
    outcome: "success" | "concurrency_overload" | "ignored",
    latencyMs: number,
    now = Date.now()
  ): void {
    if (outcome === "ignored") return;
    this.atomic(() => {
      const row = this.db
        .prepare("SELECT configured_cap FROM coordination_adaptation WHERE resource=?")
        .get(resource);
      if (!row) return;
      const cap = Number(row.configured_cap);
      this.adaptiveLimit(resource, cap, now);
      const updated = this.db
        .prepare("SELECT state FROM coordination_adaptation WHERE resource=?")
        .get(resource)!;
      const state = JSON.parse(String(updated.state)) as AdaptationState;
      const params = validateConfig({
        mode: "enforce",
        maxQueueCount: 1,
        maxQueueCost: 1,
        initialLimit: cap,
        minLimit: 1,
        maxLimit: cap,
        windowMs: 30000,
      }).adaptation;
      if (outcome === "concurrency_overload") {
        setPressure(state, "critical");
        if (!state.criticalDecreaseConsumed) {
          state.currentLimit = Math.max(
            1,
            Math.floor(state.currentLimit * params.criticalDecreaseFactor)
          );
          state.criticalDecreaseConsumed = true;
        }
      } else {
        state.windowCompleted++;
        noteLatency(state, latencyMs, params);
      }
      this.db
        .prepare("UPDATE coordination_adaptation SET state=? WHERE resource=?")
        .run(JSON.stringify(state), resource);
    });
  }
  block(resource: string, untilMs: number): void {
    if (!resource || !Number.isFinite(untilMs)) throw new Error("Invalid cooldown");
    this.db
      .prepare(
        "INSERT INTO coordination_blocks VALUES (?,?) ON CONFLICT(resource) DO UPDATE SET until_ms=MAX(until_ms,excluded.until_ms)"
      )
      .run(resource, untilMs);
  }
  unblock(resource: string): void {
    this.db.prepare("DELETE FROM coordination_blocks WHERE resource=?").run(resource);
  }
  runtimeCounts(now = Date.now()) {
    const rows = this.db
      .prepare(
        "SELECT l.id,r.resource FROM coordination_leases l JOIN coordination_resources r ON l.id=r.lease_id WHERE l.owner=? AND l.expires>?"
      )
      .all(this.owner, now);
    const activeGeneration = new Set(
      rows.filter((r) => !String(r.resource).startsWith("task:")).map((r) => String(r.id))
    ).size;
    const waits = this.db
      .prepare("SELECT resources FROM coordination_waiters WHERE owner=? AND expires>?")
      .all(this.owner, now);
    const queuedGeneration = waits.filter((row) =>
      (JSON.parse(String(row.resources)) as CoordinationRequirement[]).some(
        (r) => !r.key.startsWith("task:")
      )
    ).length;
    return { owner: this.owner, activeGeneration, queuedGeneration, observedAt: now };
  }
  hasLiveResource(key: string, now = Date.now()): boolean {
    return !!this.db
      .prepare(
        "SELECT l.id FROM coordination_leases l JOIN coordination_resources r ON r.lease_id=l.id WHERE r.resource=? AND l.expires>?"
      )
      .get(key, now);
  }
  readiness() {
    return {
      protocol: COORDINATION_PROTOCOL,
      owner: this.owner,
      driver: "node:sqlite",
      sharedAdmission: true,
      active: Number(
        this.db
          .prepare("SELECT COUNT(*) AS n FROM coordination_leases WHERE expires>?")
          .get(Date.now())?.n ?? 0
      ),
    };
  }
  close(): void {
    this.db.close();
  }
}
