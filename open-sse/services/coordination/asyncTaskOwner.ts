import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { COORDINATION_PROTOCOL } from "./sqliteCoordinator.ts";

/** Additive schema protocol for durable provider tasks stored beside admission state. */
export const ASYNC_TASK_OWNER_PROTOCOL = "omni-async-task-owner/v2";

export type DurableAsyncTaskState =
  | "submitting"
  | "accepted"
  | "submission_unknown"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "rejected";

export type DurableAsyncTaskTerminalState = Extract<
  DurableAsyncTaskState,
  "succeeded" | "failed" | "cancelled" | "rejected"
>;

export interface DurableAsyncTaskCapacity {
  /** Must be the same canonical resource key used by shared account admission. */
  key: string;
  maxConcurrency: number;
}

export interface CreateDurableAsyncTaskInput {
  provider: string;
  model: string;
  connectionId?: string | null;
  strategy: string;
  strategyVersion: string;
  /** Stable client idempotency scope/key. Only SHA-256 digests are persisted. */
  idempotencyScope: string;
  idempotencyKey: string;
  /** Absolute UTC epoch milliseconds. Expired submit intents become unknown, never replayed. */
  deadlineAt: number;
  capacity: readonly DurableAsyncTaskCapacity[];
}

export interface DurableAsyncTaskRecord {
  id: string;
  state: DurableAsyncTaskState;
  provider: string;
  model: string;
  connectionId: string | null;
  remoteTaskId: string | null;
  strategy: string;
  strategyVersion: string;
  deadlineAt: number;
  createdAt: number;
  updatedAt: number;
  nextPollAt: number;
  terminalAt: number | null;
  errorCode: string | null;
}

export interface DurableAsyncTaskPollClaim {
  task: DurableAsyncTaskRecord;
  owner: string;
  fence: number;
}

export type CreateDurableAsyncTaskResult =
  | { kind: "created"; task: DurableAsyncTaskRecord; submissionFence: number }
  | { kind: "existing"; task: DurableAsyncTaskRecord }
  | {
      kind: "capacity_unavailable";
      resource: string;
      reason: "full" | "blocked" | "queued" | "queue_state_unknown";
    };

const TASK_RESOURCE_PREFIX = "async-task:";
const MAX_CAPACITY_RESOURCES = 8;

/**
 * Durable metadata and provider-account occupancy for accepted asynchronous jobs.
 *
 * This class deliberately owns no network operations: once a caller receives an
 * existing task, it must not submit again. Only accepted jobs can be claimed for
 * polling. A `submitting` row whose deadline expires is changed to
 * `submission_unknown`, retaining its capacity reservation for explicit
 * provider/operator reconciliation. An unknown task is not released based on a
 * generic "not found" lookup: a provider-specific resolver needs a guarantee
 * that no late acceptance can still arrive before terminal capacity is freed.
 * In this generic slice, only a late fenced submit response can move unknown
 * back to accepted; provider-specific reconciliation is deliberately unwired.
 *
 * Capacity rows use the exact `coordination_resources` table read by shared
 * `SqliteCoordinator` admission. Callers must only rely on that cross-process
 * capacity when shared admission is enabled for every serving generation.
 * Idempotency compares provider/model/connection, strategy/version, and the
 * immutable capacity snapshot. It does not fingerprint prompt or media content.
 * A caller must never reuse one key for different request content.
 */
export class SqliteAsyncTaskOwner {
  private readonly db: DatabaseSync;

  constructor(readonly filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL;");
    try {
      this.assertSharedCoordinationProtocol();
      this.assertExistingAsyncTaskProtocol();
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS coordination_async_task_protocol (version TEXT PRIMARY KEY);
        INSERT OR IGNORE INTO coordination_async_task_protocol VALUES ('${ASYNC_TASK_OWNER_PROTOCOL}');
        CREATE TABLE IF NOT EXISTS coordination_async_tasks (
          id TEXT PRIMARY KEY,
          state TEXT NOT NULL CHECK (state IN (
            'submitting','accepted','submission_unknown','succeeded','failed','cancelled','rejected'
          )),
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          connection_id TEXT,
          remote_task_id TEXT,
          strategy TEXT NOT NULL,
          strategy_version TEXT NOT NULL,
          idempotency_scope_hash TEXT NOT NULL,
          idempotency_key_hash TEXT NOT NULL,
          submission_fence INTEGER NOT NULL,
          deadline_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          next_poll_at INTEGER NOT NULL DEFAULT 0,
          poll_owner TEXT,
          poll_fence INTEGER,
          poll_lease_until INTEGER,
          terminal_at INTEGER,
          error_code TEXT,
          UNIQUE (idempotency_scope_hash, idempotency_key_hash)
        );
        CREATE TABLE IF NOT EXISTS coordination_async_task_capacity (
          task_id TEXT NOT NULL,
          resource TEXT NOT NULL,
          cap INTEGER NOT NULL,
          PRIMARY KEY (task_id, resource)
        );
        CREATE INDEX IF NOT EXISTS coordination_async_tasks_pollable
          ON coordination_async_tasks(state, next_poll_at, poll_lease_until);
        CREATE INDEX IF NOT EXISTS coordination_async_tasks_deadline
          ON coordination_async_tasks(state, deadline_at);
      `);

      const versions = this.db
        .prepare("SELECT version FROM coordination_async_task_protocol")
        .all() as Array<{ version: string }>;
      if (versions.length !== 1 || versions[0].version !== ASYNC_TASK_OWNER_PROTOCOL) {
        throw new Error("Incompatible durable async task owner protocol");
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  /** This module may share reservation tables only with the supported v1 coordinator schema. */
  private assertSharedCoordinationProtocol(): void {
    const protocolTable = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='coordination_protocol'")
      .get();
    if (!protocolTable)
      throw new Error("Shared coordination must be initialized before async tasks");
    const versions = this.db.prepare("SELECT version FROM coordination_protocol").all() as Array<{
      version: string;
    }>;
    if (versions.length !== 1 || versions[0].version !== COORDINATION_PROTOCOL) {
      throw new Error("Incompatible shared coordination protocol for async tasks");
    }
    const required = new Set([
      "coordination_sequence",
      "coordination_resources",
      "coordination_blocks",
      "coordination_leases",
      "coordination_waiters",
    ]);
    const tables = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    for (const row of tables) required.delete(row.name);
    if (required.size) {
      throw new Error(`Incomplete shared coordination schema: ${[...required].join(",")}`);
    }
  }

  /** Reject old or partial task schemas before any task-specific DDL can mutate them. */
  private assertExistingAsyncTaskProtocol(): void {
    const rows = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('coordination_async_task_protocol','coordination_async_tasks','coordination_async_task_capacity')"
      )
      .all() as Array<{ name: string }>;
    const existing = new Set(rows.map((row) => row.name));
    if (!existing.has("coordination_async_task_protocol")) {
      if (existing.size > 0) throw new Error("Partial durable async task schema");
      return;
    }
    const versions = this.db
      .prepare("SELECT version FROM coordination_async_task_protocol")
      .all() as Array<{ version: string }>;
    if (versions.length !== 1 || versions[0].version !== ASYNC_TASK_OWNER_PROTOCOL) {
      throw new Error("Incompatible durable async task owner protocol");
    }
  }

  private atomic<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the operation error if SQLite has already rolled back.
      }
      throw error;
    }
  }

  /** Create the write-ahead submit intent and reserve all capacity in one SQLite transaction. */
  createSubmission(
    input: CreateDurableAsyncTaskInput,
    now = Date.now()
  ): CreateDurableAsyncTaskResult {
    const normalized = validateCreateInput(input, now);
    const scopeHash = digest(input.idempotencyScope);
    const keyHash = digest(input.idempotencyKey);

    return this.atomic(() => {
      this.pruneExpiredWorkerResources(now);
      const existingRow = this.db
        .prepare(
          `SELECT ${TASK_COLUMNS} FROM coordination_async_tasks
           WHERE idempotency_scope_hash=? AND idempotency_key_hash=?`
        )
        .get(scopeHash, keyHash);
      const decodedExisting = existingRow === undefined ? undefined : decodeTaskDbRow(existingRow);
      if (decodedExisting) {
        if (
          decodedExisting.provider !== input.provider ||
          decodedExisting.model !== input.model ||
          decodedExisting.connection_id !== (input.connectionId?.trim() || null) ||
          decodedExisting.strategy !== input.strategy ||
          decodedExisting.strategy_version !== input.strategyVersion ||
          !this.matchesCapacitySnapshot(decodedExisting.id, normalized)
        ) {
          throw new Error("idempotency_key_conflict");
        }
        return {
          kind: "existing",
          task: toTaskRecord(decodedExisting),
        };
      }
      if (input.deadlineAt <= now) throw new Error("invalid_task_deadline");

      for (const requirement of normalized) {
        const queued = this.hasOverlappingWaiter(requirement.key, now);
        if (queued === "unknown") {
          return {
            kind: "capacity_unavailable",
            resource: requirement.key,
            reason: "queue_state_unknown",
          };
        }
        if (queued) {
          return { kind: "capacity_unavailable", resource: requirement.key, reason: "queued" };
        }
        const block = this.db
          .prepare("SELECT until_ms FROM coordination_blocks WHERE resource=?")
          .get(requirement.key) as { until_ms: number } | undefined;
        if (Number(block?.until_ms ?? 0) > now) {
          return { kind: "capacity_unavailable", resource: requirement.key, reason: "blocked" };
        }
        const occupancy = this.db
          .prepare(
            "SELECT COUNT(*) AS n, MIN(cap) AS cap FROM coordination_resources WHERE resource=?"
          )
          .get(requirement.key) as { n: number; cap: number | null };
        const effectiveCap = Math.min(
          requirement.maxConcurrency,
          Number(occupancy.cap ?? requirement.maxConcurrency)
        );
        if (Number(occupancy.n) >= effectiveCap) {
          return { kind: "capacity_unavailable", resource: requirement.key, reason: "full" };
        }
      }

      const id = randomUUID();
      const resourceOwner = `${TASK_RESOURCE_PREFIX}${id}`;
      const submissionFence = Number(
        this.db.prepare("INSERT INTO coordination_sequence DEFAULT VALUES").run().lastInsertRowid
      );
      this.db
        .prepare(
          `INSERT INTO coordination_async_tasks (
             id,state,provider,model,connection_id,remote_task_id,strategy,strategy_version,
             idempotency_scope_hash,idempotency_key_hash,submission_fence,deadline_at,
             created_at,updated_at,next_poll_at
           ) VALUES (?,?,?,?,?,NULL,?,?,?,?,?,?,?,?,0)`
        )
        .run(
          id,
          "submitting",
          input.provider,
          input.model,
          input.connectionId?.trim() || null,
          input.strategy,
          input.strategyVersion,
          scopeHash,
          keyHash,
          submissionFence,
          input.deadlineAt,
          now,
          now
        );
      for (const requirement of normalized) {
        this.db
          .prepare(
            "INSERT INTO coordination_async_task_capacity (task_id,resource,cap) VALUES (?,?,?)"
          )
          .run(id, requirement.key, requirement.maxConcurrency);
        this.db
          .prepare("INSERT INTO coordination_resources (lease_id,resource,cap) VALUES (?,?,?)")
          .run(resourceOwner, requirement.key, requirement.maxConcurrency);
      }
      const row = this.db
        .prepare(`SELECT ${TASK_COLUMNS} FROM coordination_async_tasks WHERE id=?`)
        .get(id);
      return { kind: "created", task: toTaskRecord(decodeTaskDbRow(row)), submissionFence };
    });
  }

  /** Persist provider acceptance. This is the only normal transition that stores a remote id. */
  recordAccepted(
    taskId: string,
    submissionFence: number,
    remoteTaskId: string,
    now = Date.now()
  ): boolean {
    validateSubmissionTransition(taskId, submissionFence, now);
    const remoteId = validateRemoteTaskId(remoteTaskId);
    return (
      Number(
        this.db
          .prepare(
            `UPDATE coordination_async_tasks
             SET state='accepted',remote_task_id=?,updated_at=?,next_poll_at=?,error_code=NULL
             WHERE id=? AND state IN ('submitting','submission_unknown') AND submission_fence=?`
          )
          .run(remoteId, now, now, taskId, submissionFence).changes
      ) === 1
    );
  }

  /** Mark a dispatched submit ambiguous; the reservation remains held and the row cannot be polled. */
  markSubmissionUnknown(
    taskId: string,
    submissionFence: number,
    errorCode = "submit_outcome_unknown",
    now = Date.now()
  ): boolean {
    validateSubmissionTransition(taskId, submissionFence, now);
    return this.markUnknown(taskId, submissionFence, errorCode, now);
  }

  /** Release a submission reservation only after a definitive pre-acceptance rejection. */
  rejectSubmission(
    taskId: string,
    submissionFence: number,
    errorCode = "provider_rejected_submit",
    now = Date.now()
  ): boolean {
    validateSubmissionTransition(taskId, submissionFence, now);
    const safeErrorCode = validateErrorCode(errorCode);
    return this.atomic(() => {
      const changed = this.db
        .prepare(
          `UPDATE coordination_async_tasks SET state='rejected',terminal_at=?,updated_at=?,error_code=?
           WHERE id=? AND state IN ('submitting','submission_unknown') AND submission_fence=?`
        )
        .run(now, now, safeErrorCode, taskId, submissionFence).changes;
      if (Number(changed) !== 1) return false;
      this.deleteTaskResources(taskId);
      return true;
    });
  }

  /** Restart recovery never retries an expired submit; it quarantines it as unknown instead. */
  recoverExpiredSubmissions(now = Date.now()): number {
    validateNow(now);
    return this.atomic(() => {
      const rows = this.db
        .prepare(
          "SELECT id,submission_fence FROM coordination_async_tasks WHERE state='submitting' AND deadline_at<=?"
        )
        .all(now) as Array<{ id: string; submission_fence: number }>;
      const update = this.db.prepare(
        `UPDATE coordination_async_tasks SET state='submission_unknown',
         updated_at=?,error_code='submit_owner_expired'
         WHERE id=? AND state='submitting' AND submission_fence=? AND deadline_at<=?`
      );
      let changed = 0;
      for (const row of rows) {
        changed += Number(update.run(now, row.id, row.submission_fence, now).changes);
      }
      return changed;
    });
  }

  /** Bounded restart discovery; callers must acquire a fenced poll claim before network I/O. */
  listDueAcceptedTasks(now = Date.now(), limit = 50): DurableAsyncTaskRecord[] {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("invalid_task_list_time");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("invalid_task_list_limit");
    }
    const rows = this.db
      .prepare(
        `SELECT ${TASK_COLUMNS} FROM coordination_async_tasks
         WHERE state='accepted' AND remote_task_id IS NOT NULL AND next_poll_at<=?
         AND (poll_lease_until IS NULL OR poll_lease_until<=?)
         ORDER BY next_poll_at ASC,created_at ASC LIMIT ?`
      )
      .all(now, now, limit);
    return decodeTaskDbRows(rows).map(toTaskRecord);
  }

  /** Claim one accepted task for status polling; expired owners are fenced by a monotonic token. */
  claimPollOwner(
    taskId: string,
    owner: string,
    leaseMs = 30_000,
    now = Date.now()
  ): DurableAsyncTaskPollClaim | null {
    validateOwnerLease(owner, leaseMs);
    validateTaskId(taskId);
    validateNow(now);
    validateSafeTimestamp(now + leaseMs, "invalid_poll_lease");
    return this.atomic(() => {
      const rawRow = this.db
        .prepare(
          `SELECT ${TASK_COLUMNS},poll_lease_until FROM coordination_async_tasks
           WHERE id=? AND state='accepted' AND remote_task_id IS NOT NULL AND next_poll_at<=?`
        )
        .get(taskId, now);
      const row = rawRow === undefined ? undefined : decodeTaskDbRow(rawRow, true);
      if (!row || Number(row.poll_lease_until ?? 0) > now) return null;
      const fence = Number(
        this.db.prepare("INSERT INTO coordination_sequence DEFAULT VALUES").run().lastInsertRowid
      );
      const expiresAt = now + leaseMs;
      const changed = this.db
        .prepare(
          `UPDATE coordination_async_tasks SET poll_owner=?,poll_fence=?,poll_lease_until=?,updated_at=?
           WHERE id=? AND state='accepted' AND (poll_lease_until IS NULL OR poll_lease_until<=?)`
        )
        .run(owner, fence, expiresAt, now, taskId, now).changes;
      if (Number(changed) !== 1) return null;
      const claimed = this.db
        .prepare(`SELECT ${TASK_COLUMNS} FROM coordination_async_tasks WHERE id=?`)
        .get(taskId);
      return { task: toTaskRecord(decodeTaskDbRow(claimed)), owner, fence };
    });
  }

  renewPollOwner(claim: DurableAsyncTaskPollClaim, leaseMs = 30_000, now = Date.now()): boolean {
    validatePollClaim(claim, now);
    validateOwnerLease(claim.owner, leaseMs);
    const expiresAt = now + leaseMs;
    validateSafeTimestamp(expiresAt, "invalid_poll_lease");
    return (
      Number(
        this.db
          .prepare(
            `UPDATE coordination_async_tasks SET poll_lease_until=?,updated_at=?
             WHERE id=? AND state='accepted' AND poll_owner=? AND poll_fence=? AND poll_lease_until>?`
          )
          .run(expiresAt, now, claim.task.id, claim.owner, claim.fence, now).changes
      ) === 1
    );
  }

  /** End a polling slice without releasing provider capacity. */
  scheduleNextPoll(
    claim: DurableAsyncTaskPollClaim,
    nextPollAt: number,
    now = Date.now()
  ): boolean {
    if (!Number.isSafeInteger(nextPollAt) || nextPollAt < 0) throw new Error("invalid_poll_time");
    validatePollClaim(claim, now);
    return (
      Number(
        this.db
          .prepare(
            `UPDATE coordination_async_tasks SET next_poll_at=?,poll_owner=NULL,poll_fence=NULL,
             poll_lease_until=NULL,updated_at=?
             WHERE id=? AND state='accepted' AND poll_owner=? AND poll_fence=? AND poll_lease_until>?`
          )
          .run(nextPollAt, now, claim.task.id, claim.owner, claim.fence, now).changes
      ) === 1
    );
  }

  /** Terminal completion and capacity release are one fenced transaction. */
  finishPollTask(
    claim: DurableAsyncTaskPollClaim,
    state: Exclude<DurableAsyncTaskTerminalState, "rejected">,
    errorCode?: string,
    now = Date.now()
  ): boolean {
    validatePollClaim(claim, now);
    if (!POLL_TERMINAL_STATES.has(state as string)) {
      throw new Error("invalid_terminal_task_state");
    }
    const safeErrorCode = errorCode ? validateErrorCode(errorCode) : null;
    return this.atomic(() => {
      const changed = this.db
        .prepare(
          `UPDATE coordination_async_tasks SET state=?,terminal_at=?,updated_at=?,error_code=?,
           poll_owner=NULL,poll_fence=NULL,poll_lease_until=NULL
           WHERE id=? AND state='accepted' AND poll_owner=? AND poll_fence=? AND poll_lease_until>?`
        )
        .run(state, now, now, safeErrorCode, claim.task.id, claim.owner, claim.fence, now).changes;
      if (Number(changed) !== 1) return false;
      this.deleteTaskResources(claim.task.id);
      return true;
    });
  }

  getTask(taskId: string): DurableAsyncTaskRecord | null {
    validateTaskId(taskId);
    const row = this.db
      .prepare(`SELECT ${TASK_COLUMNS} FROM coordination_async_tasks WHERE id=?`)
      .get(taskId);
    return row === undefined ? null : toTaskRecord(decodeTaskDbRow(row));
  }

  close(): void {
    this.db.close();
  }

  private markUnknown(taskId: string, submissionFence: number, errorCode: string, now: number) {
    const safeErrorCode = validateErrorCode(errorCode);
    return (
      Number(
        this.db
          .prepare(
            `UPDATE coordination_async_tasks SET state='submission_unknown',updated_at=?,error_code=?
             WHERE id=? AND state='submitting' AND submission_fence=?`
          )
          .run(now, safeErrorCode, taskId, submissionFence).changes
      ) === 1
    );
  }

  private deleteTaskResources(taskId: string): void {
    this.db
      .prepare("DELETE FROM coordination_resources WHERE lease_id=?")
      .run(`${TASK_RESOURCE_PREFIX}${taskId}`);
  }

  private matchesCapacitySnapshot(
    taskId: string,
    requested: readonly { key: string; maxConcurrency: number }[]
  ): boolean {
    const rows = this.db
      .prepare(
        "SELECT resource,cap FROM coordination_async_task_capacity WHERE task_id=? ORDER BY resource"
      )
      .all(taskId) as Array<{ resource: string; cap: number }>;
    const expected = [...requested].sort((left, right) => left.key.localeCompare(right.key));
    return (
      rows.length === expected.length &&
      rows.every(
        (row, index) =>
          row.resource === expected[index].key && Number(row.cap) === expected[index].maxConcurrency
      )
    );
  }

  private pruneExpiredWorkerResources(now: number): void {
    this.db
      .prepare(
        "DELETE FROM coordination_resources WHERE lease_id IN (SELECT id FROM coordination_leases WHERE expires<=?)"
      )
      .run(now);
    this.db.prepare("DELETE FROM coordination_leases WHERE expires<=?").run(now);
    this.db.prepare("DELETE FROM coordination_waiters WHERE expires<=?").run(now);
  }

  /** Do not let durable submissions jump ahead of a queued shared-admission request. */
  private hasOverlappingWaiter(resource: string, now: number): boolean | "unknown" {
    const rows = this.db
      .prepare("SELECT resources FROM coordination_waiters WHERE expires>? ORDER BY sequence ASC")
      .all(now) as Array<{ resources: string }>;
    for (const row of rows) {
      let requirements: unknown;
      try {
        requirements = JSON.parse(row.resources);
      } catch {
        return "unknown";
      }
      if (!Array.isArray(requirements)) return "unknown";
      for (const requirement of requirements) {
        if (
          !requirement ||
          typeof requirement !== "object" ||
          typeof (requirement as { key?: unknown }).key !== "string"
        ) {
          return "unknown";
        }
        if ((requirement as { key: string }).key === resource) return true;
      }
    }
    return false;
  }
}

const TASK_COLUMNS =
  "id,state,provider,model,connection_id,remote_task_id,strategy,strategy_version,deadline_at,created_at,updated_at,next_poll_at,terminal_at,error_code,submission_fence";
const POLL_TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled"]);

interface TaskDbRow {
  id: string;
  state: DurableAsyncTaskState;
  provider: string;
  model: string;
  connection_id: string | null;
  remote_task_id: string | null;
  strategy: string;
  strategy_version: string;
  deadline_at: number;
  created_at: number;
  updated_at: number;
  next_poll_at: number;
  terminal_at: number | null;
  error_code: string | null;
  submission_fence: number;
}

interface TaskPollDbRow extends TaskDbRow {
  poll_lease_until: number | null;
}

const TASK_STATES = new Set<DurableAsyncTaskState>([
  "submitting",
  "accepted",
  "submission_unknown",
  "succeeded",
  "failed",
  "cancelled",
  "rejected",
]);

function decodeTaskDbRow(value: unknown): TaskDbRow;
function decodeTaskDbRow(value: unknown, includePollLease: true): TaskPollDbRow;
function decodeTaskDbRow(value: unknown, includePollLease = false): TaskDbRow | TaskPollDbRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid_async_task_sqlite_row");
  }
  const row = Object.fromEntries(Object.entries(value));
  const state = requiredString(row, "state");
  if (!TASK_STATES.has(state as DurableAsyncTaskState)) {
    throw new Error("invalid_async_task_state_in_sqlite");
  }
  const decoded: TaskDbRow = {
    id: requiredString(row, "id"),
    state: state as DurableAsyncTaskState,
    provider: requiredString(row, "provider"),
    model: requiredString(row, "model"),
    connection_id: nullableString(row, "connection_id"),
    remote_task_id: nullableString(row, "remote_task_id"),
    strategy: requiredString(row, "strategy"),
    strategy_version: requiredString(row, "strategy_version"),
    deadline_at: requiredInteger(row, "deadline_at"),
    created_at: requiredInteger(row, "created_at"),
    updated_at: requiredInteger(row, "updated_at"),
    next_poll_at: requiredInteger(row, "next_poll_at"),
    terminal_at: nullableInteger(row, "terminal_at"),
    error_code: nullableString(row, "error_code"),
    submission_fence: requiredInteger(row, "submission_fence"),
  };
  if (decoded.submission_fence < 1) throw new Error("invalid_async_task_fence_in_sqlite");
  if (!includePollLease) return decoded;
  if (!Object.hasOwn(row, "poll_lease_until")) {
    throw new Error("missing_poll_lease_in_sqlite_row");
  }
  return { ...decoded, poll_lease_until: nullableInteger(row, "poll_lease_until") };
}

function decodeTaskDbRows(value: unknown): TaskDbRow[] {
  if (!Array.isArray(value)) throw new Error("invalid_async_task_sqlite_rows");
  return value.map((row) => decodeTaskDbRow(row));
}

function requiredString(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value !== "string") throw new Error(`invalid_async_task_${field}_in_sqlite`);
  return value;
}

function nullableString(row: Record<string, unknown>, field: string): string | null {
  const value = row[field];
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`invalid_async_task_${field}_in_sqlite`);
  return value;
}

function requiredInteger(row: Record<string, unknown>, field: string): number {
  const value = row[field];
  if (typeof value === "bigint") {
    if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`invalid_async_task_${field}_in_sqlite`);
    }
    return Number(value);
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`invalid_async_task_${field}_in_sqlite`);
  }
  return value;
}

function nullableInteger(row: Record<string, unknown>, field: string): number | null {
  return row[field] === null ? null : requiredInteger(row, field);
}

function toTaskRecord(row: TaskDbRow): DurableAsyncTaskRecord {
  return {
    id: row.id,
    state: row.state,
    provider: row.provider,
    model: row.model,
    connectionId: row.connection_id,
    remoteTaskId: row.remote_task_id,
    strategy: row.strategy,
    strategyVersion: row.strategy_version,
    deadlineAt: row.deadline_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    nextPollAt: row.next_poll_at,
    terminalAt: row.terminal_at,
    errorCode: row.error_code,
  };
}

function validateCreateInput(
  input: CreateDurableAsyncTaskInput,
  now: number
): Array<{ key: string; maxConcurrency: number }> {
  for (const [name, value, maxLength] of [
    ["provider", input.provider, 128],
    ["model", input.model, 256],
    ["strategy", input.strategy, 128],
    ["strategyVersion", input.strategyVersion, 64],
    ["idempotencyScope", input.idempotencyScope, 512],
    ["idempotencyKey", input.idempotencyKey, 512],
  ] as const) {
    if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
      throw new Error(`invalid_${name}`);
    }
  }
  if (!Number.isSafeInteger(input.deadlineAt) || !Number.isSafeInteger(now) || now < 0) {
    throw new Error("invalid_task_deadline");
  }
  if (
    input.connectionId != null &&
    (typeof input.connectionId !== "string" ||
      !input.connectionId.trim() ||
      input.connectionId.length > 512)
  ) {
    throw new Error("invalid_connection_id");
  }
  if (
    !Array.isArray(input.capacity) ||
    input.capacity.length < 1 ||
    input.capacity.length > MAX_CAPACITY_RESOURCES
  ) {
    throw new Error("invalid_task_capacity");
  }

  const requirements = new Map<string, number>();
  for (const requirement of input.capacity) {
    if (
      !requirement ||
      typeof requirement.key !== "string" ||
      !requirement.key.trim() ||
      requirement.key.length > 512 ||
      !Number.isSafeInteger(requirement.maxConcurrency) ||
      requirement.maxConcurrency < 1
    ) {
      throw new Error("invalid_task_capacity");
    }
    requirements.set(
      requirement.key,
      Math.min(
        requirements.get(requirement.key) ?? requirement.maxConcurrency,
        requirement.maxConcurrency
      )
    );
  }
  return [...requirements].map(([key, maxConcurrency]) => ({ key, maxConcurrency }));
}

function validateRemoteTaskId(value: string): string {
  if (typeof value !== "string") throw new Error("invalid_remote_task_id");
  const remoteTaskId = value.trim();
  if (
    !remoteTaskId ||
    remoteTaskId.length > 1024 ||
    /^https?:\/\//i.test(remoteTaskId) ||
    /[\u0000-\u001f\u007f]/.test(remoteTaskId)
  ) {
    throw new Error("invalid_remote_task_id");
  }
  return remoteTaskId;
}

function validateOwnerLease(owner: string, leaseMs: number): void {
  if (typeof owner !== "string" || !owner.trim() || owner.length > 256) {
    throw new Error("invalid_poll_owner");
  }
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 300_000) {
    throw new Error("invalid_poll_lease");
  }
}

function validateSubmissionTransition(taskId: string, fence: number, now: number): void {
  validateTaskId(taskId);
  if (!Number.isSafeInteger(fence) || fence < 1) throw new Error("invalid_submission_fence");
  validateNow(now);
}

function validatePollClaim(claim: DurableAsyncTaskPollClaim, now: number): void {
  if (!claim || !claim.task) throw new Error("invalid_poll_claim");
  validateTaskId(claim.task.id);
  validateOwner(claim.owner);
  if (!Number.isSafeInteger(claim.fence) || claim.fence < 1) throw new Error("invalid_poll_fence");
  validateNow(now);
}

function validateOwner(owner: string): void {
  if (typeof owner !== "string" || !owner.trim() || owner.length > 256) {
    throw new Error("invalid_poll_owner");
  }
}

function validateTaskId(taskId: string): void {
  if (typeof taskId !== "string" || !taskId.trim() || taskId.length > 128) {
    throw new Error("invalid_task_id");
  }
}

function validateNow(now: number): void {
  validateSafeTimestamp(now, "invalid_task_time");
}

function validateSafeTimestamp(value: number, errorCode: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(errorCode);
}

function validateErrorCode(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) {
    throw new Error("invalid_task_error_code");
  }
  return value;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
