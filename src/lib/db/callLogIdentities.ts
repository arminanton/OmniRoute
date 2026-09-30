/**
 * Durable, bounded lookup aliases for immutable per-save call-log identities.
 * Alias digests normalize lookup keys only; they are NOT authentication principals.
 */
import { createHash } from "node:crypto";
import { readlinkSync } from "node:fs";
import { getCallLogLogicalRequestId } from "@/shared/utils/callLogAttemptId";
import { getDbInstance } from "./core";

const ID_RETRY_LIMIT = 3;
const ABANDONED_RESERVATION_GRACE_MS = 5 * 60_000;
let cleanupCursor = 0;

function getOwnerScope(): string | null {
  try {
    return process.platform === "linux" ? readlinkSync("/proc/self/ns/pid") : null;
  } catch {
    return null;
  }
}
const ownerScope = getOwnerScope();

export type CallLogIdentity = { id: string; ordinal: number | bigint };

function lookupKey(id: string): string {
  // Fixed-size storage even for a pathological caller ID. Hash the full value:
  // wildcard characters, case and separators retain their literal meaning.
  return createHash("sha256").update(id).digest("hex");
}

export function reserveCallLogIdentity(callerId: unknown): CallLogIdentity {
  const db = getDbInstance();
  const lookupId = typeof callerId === "string" && callerId.length > 0 ? callerId : null;
  const lookup = lookupId === null ? null : lookupKey(lookupId);
  const logical = lookupId === null ? null : lookupKey(getCallLogLogicalRequestId(lookupId));
  const insert = db.prepare(`
    INSERT INTO call_log_identities (physical_id, lookup_key, logical_key, owner_pid, owner_scope, created_at)
    SELECT @id, @lookup, @logical, @owner, @ownerScope, @createdAt
    WHERE NOT EXISTS (SELECT 1 FROM call_logs WHERE id = @id)
    ON CONFLICT(physical_id) DO NOTHING
  `);
  for (let attempt = 0; attempt < ID_RETRY_LIMIT; attempt++) {
    const id = globalThis.crypto.randomUUID();
    const result = insert.run({
      id,
      lookup,
      logical,
      owner: process.pid,
      ownerScope,
      createdAt: Date.now(),
    });
    if (result.changes === 1) return { id, ordinal: result.lastInsertRowid };
  }
  throw new Error("Could not reserve a unique call-log identity");
}

export function publishCallLogIdentity(identity: CallLogIdentity, insertLog: () => void): void {
  const db = getDbInstance();
  db.transaction(() => {
    const claimed = db
      .prepare(
        `
      UPDATE call_log_identities SET published = 1
      WHERE ordinal = ? AND physical_id = ? AND owner_pid = ? AND published = 0
    `
      )
      .run(identity.ordinal, identity.id, process.pid);
    if (claimed.changes !== 1) throw new Error("Call-log identity reservation is unavailable");
    insertLog();
  })();
}

/** Only release this save's unpublished reservation, never another save or row. */
export function releaseCallLogIdentity(identity: CallLogIdentity): boolean {
  return (
    getDbInstance()
      .prepare(
        `
    DELETE FROM call_log_identities
    WHERE ordinal = ? AND physical_id = ? AND owner_pid = ? AND published = 0
      AND NOT EXISTS (SELECT 1 FROM call_logs WHERE id = physical_id)
  `
      )
      .run(identity.ordinal, identity.id, process.pid).changes === 1
  );
}

export function resolveCallLogAlias(id: string): string | null {
  const key = lookupKey(id);
  const db = getDbInstance();
  // Two indexed point lookups avoid an OR plan that can scan the published
  // index for the whole log table. At most two candidates enter JS memory.
  const candidates = (["lookup_key", "logical_key"] as const).flatMap((column) => {
    const row = db
      .prepare(
        `
      SELECT identities.physical_id, identities.ordinal FROM call_log_identities identities
      JOIN call_logs cl ON cl.id = identities.physical_id
      WHERE identities.${column} = ? AND identities.published = 1
      ORDER BY identities.ordinal DESC LIMIT 1
    `
      )
      .get(key) as { physical_id: string; ordinal: number } | undefined;
    return row ? [row] : [];
  });
  candidates.sort((a, b) => b.ordinal - a.ordinal);
  return candidates[0]?.physical_id ?? null;
}

function ownerHasExited(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // EPERM or an unknown platform error is NOT proof of death. PID reuse also
    // conservatively retains the reservation until that process exits.
    return (error as NodeJS.ErrnoException)?.code === "ESRCH";
  }
}

/**
 * Reap at most one bounded page of crashed writers, not slow live writers.
 * Only probe owners in this Linux PID namespace. Unknown/different scopes are
 * conservatively retained. Age alone never authorizes deletion: a known-dead
 * owner is also required. Artifacts
 * left by a crash are reclaimed by the existing bounded orphan-file rotation.
 */
export function cleanupAbandonedCallLogIdentities(maxCandidates = 100): number {
  if (!ownerScope || !Number.isInteger(maxCandidates) || maxCandidates < 1) return 0;
  const db = getDbInstance();
  const rows = db
    .prepare(
      `
    SELECT ordinal, owner_pid FROM call_log_identities
    WHERE published = 0 AND ordinal > ? AND created_at < ? AND owner_scope = ?
    ORDER BY ordinal LIMIT ?
  `
    )
    .all(
      cleanupCursor,
      Date.now() - ABANDONED_RESERVATION_GRACE_MS,
      ownerScope,
      Math.min(maxCandidates, 100)
    ) as Array<{ ordinal: number; owner_pid: number }>;
  if (rows.length === 0) {
    cleanupCursor = 0;
    return 0;
  }
  cleanupCursor = rows[rows.length - 1].ordinal;
  const remove = db.prepare(`
    DELETE FROM call_log_identities WHERE ordinal = ? AND published = 0
      AND NOT EXISTS (SELECT 1 FROM call_logs WHERE id = physical_id)
  `);
  let deleted = 0;
  for (const row of rows) {
    if (ownerHasExited(row.owner_pid)) deleted += remove.run(row.ordinal).changes;
  }
  return deleted;
}

/** Protect a bounded orphan-scan page while artifact writes are still unpublished. */
export function findReservedCallLogArtifactPaths(relativePaths: string[]): string[] {
  const candidates = relativePaths.flatMap((relativePath) => {
    const match = /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/.exec(
      relativePath
    );
    return match ? [{ relativePath, id: match[1] }] : [];
  });
  if (candidates.length === 0) return [];
  const placeholders = candidates.map(() => "?").join(", ");
  const rows = getDbInstance()
    .prepare(
      `
    SELECT physical_id FROM call_log_identities
    WHERE published = 0 AND physical_id IN (${placeholders})
  `
    )
    .all(...candidates.map((candidate) => candidate.id)) as Array<{ physical_id: string }>;
  const reserved = new Set(rows.map((row) => row.physical_id));
  return candidates
    .filter((candidate) => reserved.has(candidate.id))
    .map((candidate) => candidate.relativePath);
}
