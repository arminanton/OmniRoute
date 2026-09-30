/** Durable MaxAI refresh leases and credential CAS. No HTTP or credential logging. */
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  accessTokenExpiry,
  userIdFromJwt,
  type MaxaiCredential,
} from "@omniroute/open-sse/executors/maxai/credentials.ts";
import type {
  MaxaiRefreshStore,
  MaxaiStoredCredential,
  MaxaiRefreshLease,
  MaxaiRefreshAcquireInput,
  MaxaiRefreshCommitInput,
} from "@omniroute/open-sse/executors/maxai/refresh.ts";
import { getDbInstance } from "./core";
import {
  decrypt,
  encrypt,
  isEncryptionEnabled,
  looksEncrypted,
  migrateLegacyEncryptedString,
} from "./encryption";
import { invalidateDbCache } from "./readCache";
import { bumpProxyConfigGeneration } from "./settings";
import type { SqliteAdapter } from "./adapters/types";

type JsonRecord = Record<string, unknown>;
type AcquireStatus = Awaited<ReturnType<MaxaiRefreshStore["acquire"]>>;
type ConnectionRow = {
  provider: string;
  auth_type: string | null;
  access_token: string | null;
  refresh_token: string | null;
  api_key: string | null;
  id_token: string | null;
  provider_specific_data: string | null;
  created_at: string | null;
};
type CurrentCredential = {
  row: ConnectionRow;
  psd: JsonRecord;
  credential: MaxaiCredential & { refreshToken: string };
  generation: string;
  snapshot: string;
};
type LeaseRow = {
  owner: string;
  credential_snapshot: string;
  reusable_snapshot: string | null;
  lease_expires_at: number;
  state: "acquired" | "sent" | "quarantined" | "committed";
};

const tokenSchema = z
  .string()
  .min(1)
  .max(65_536)
  .regex(/^\S+$/)
  .refine((v) => !looksEncrypted(v));
const idSchema = z.string().trim().min(1).max(512);
const leaseSchema = z.object({
  connectionId: idSchema,
  generation: z.string().regex(/^[a-f0-9]{64}$/),
  owner: z.string().uuid(),
});
const acquireSchema = leaseSchema.extend({
  leaseExpiresAt: z.number().int().positive().safe(),
  expectedCredentialVersion: z.string().regex(/^[a-f0-9]{64}$/),
});
const credentialSchema = z.object({
  accessToken: tokenSchema,
  refreshToken: tokenSchema,
  deviceId: idSchema,
  userId: idSchema,
});
// A caller cannot leave a live grant lease indefinitely. The refresh helper's
// deadline is at most 30s, including setup and response-body parsing.
const MAX_LEASE_MS = 30_000;
const SECRET_PSD_KEYS = [
  "maxaiAccessToken",
  "maxaiRefreshToken",
  "accessToken",
  "refreshToken",
] as const;
const IDENTITY_PSD_KEYS = ["maxaiDeviceId", "maxaiUserId", "deviceId", "userId"] as const;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function nativeDb(): SqliteAdapter {
  const db = getDbInstance();
  // SQL.js schedules file saves and does not hold cross-process SQLite locks.
  // Nested transactions could return dispatch permission before an outer COMMIT.
  if (db.driver === "sql.js" || !db.name || db.name === ":memory:" || db.inTransaction) {
    throw new Error("MaxAI refresh requires a durable native SQLite transaction");
  }
  return db;
}

/** FULL sync makes the sent marker durable even across a machine/power crash. */
function durableTransaction<T>(db: SqliteAdapter, fn: () => T): T {
  const previous = Number(db.pragma("synchronous", { simple: true }));
  db.pragma("synchronous = FULL");
  let result: T;
  try {
    db.immediate(() => {
      result = fn();
    });
  } catch {
    // Do not propagate driver errors that could include bound credentials.
    throw new Error("MaxAI credential persistence failed");
  } finally {
    // The transaction is already committed. A pragma/cache error must not turn
    // a successful rotation into a retry of the consumed refresh token.
    if (Number.isInteger(previous) && previous >= 0 && previous <= 3) {
      try {
        db.pragma(`synchronous = ${previous}`);
      } catch {
        /* Keep FULL on failure. */
      }
    }
  }
  return result!;
}

function parsePsd(raw: string | null): JsonRecord | null {
  if (raw === null || raw === "") return {};
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as JsonRecord)
      : null;
  } catch {
    return null;
  }
}

function firstPresent(...values: unknown[]): unknown {
  return values.find((v) => v !== undefined && v !== null && v !== "");
}

function decodeToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Startup only migrates canonical columns. Legacy PSD can still contain old
  // dynamic-salt ciphertext; read it without writing before the successful CAS.
  const migrated = looksEncrypted(value) ? migrateLegacyEncryptedString(value).value : value;
  const decoded = decrypt(migrated, { quiet: true });
  const parsed = tokenSchema.safeParse(decoded);
  return parsed.success ? parsed.data : null;
}

function identity(...values: unknown[]): string | null {
  const value = firstPresent(...values);
  if (typeof value !== "string") return null;
  const parsed = idSchema.safeParse(value.trim().replace(/^"|"$/g, ""));
  return parsed.success ? parsed.data : null;
}

function currentCredential(db: SqliteAdapter, id: string): CurrentCredential | null {
  const row = db
    .prepare(
      `SELECT provider, auth_type, access_token, refresh_token, api_key,
      id_token, provider_specific_data, created_at FROM provider_connections WHERE id = ?`
    )
    .get(id) as ConnectionRow | undefined;
  if (!row || (row.provider !== "maxai" && row.provider !== "mx")) return null;
  const psd = parsePsd(row.provider_specific_data);
  if (!psd) return null;
  // A present but corrupt canonical credential must NOT revive a stale alias.
  const refreshToken = decodeToken(
    firstPresent(row.refresh_token, psd.maxaiRefreshToken, psd.refreshToken)
  );
  const accessToken = decodeToken(
    firstPresent(row.access_token, psd.maxaiAccessToken, psd.accessToken, row.api_key)
  );
  const deviceId = identity(psd.maxaiDeviceId, psd.deviceId);
  const userId =
    identity(psd.maxaiUserId, psd.userId) ?? (accessToken ? userIdFromJwt(accessToken) : null);
  if (!refreshToken || !accessToken || !deviceId || !userId || !idSchema.safeParse(userId).success)
    return null;
  // Bind original *stored* credentials, including cipher changes for the same
  // plaintext. Unrelated PSD edits do not invalidate this snapshot.
  const snapshot = credentialSnapshot(row, psd);
  return {
    row,
    psd,
    credential: { accessToken, refreshToken, deviceId, userId },
    generation: digest(refreshToken),
    snapshot,
  };
}

function credentialSnapshot(row: ConnectionRow, psd: JsonRecord): string {
  return digest(
    JSON.stringify([
      row.provider,
      row.auth_type,
      row.created_at,
      row.access_token,
      row.refresh_token,
      row.api_key,
      row.id_token,
      ...SECRET_PSD_KEYS.map((key) => psd[key] ?? null),
      ...IDENTITY_PSD_KEYS.map((key) => psd[key] ?? null),
    ])
  );
}

function getLease(db: SqliteAdapter, lease: MaxaiRefreshLease): LeaseRow | undefined {
  return db
    .prepare(
      `SELECT owner, credential_snapshot, reusable_snapshot, lease_expires_at, state
      FROM maxai_refresh_leases WHERE connection_id = ? AND generation = ?`
    )
    .get(lease.connectionId, lease.generation) as LeaseRow | undefined;
}

function quarantine(
  db: SqliteAdapter,
  lease: MaxaiRefreshLease,
  code: "refresh_expired" | "refresh_conflict"
): void {
  db.prepare(
    `UPDATE maxai_refresh_leases SET state = 'quarantined', failure_code = ?, updated_at = ?
      WHERE connection_id = ? AND generation = ? AND owner = ? AND state = 'sent'`
  ).run(code, Date.now(), lease.connectionId, lease.generation, lease.owner);
}

function read(connectionId: string): MaxaiStoredCredential | null {
  if (!idSchema.safeParse(connectionId).success) return null;
  const current = currentCredential(nativeDb(), connectionId);
  return current ? { ...current.credential, credentialVersion: current.snapshot } : null;
}

function acquire(input: MaxaiRefreshAcquireInput): AcquireStatus {
  const parsed = acquireSchema.safeParse(input);
  if (!parsed.success) return "missing";
  const db = nativeDb();
  if (!isEncryptionEnabled()) throw new Error("MaxAI refresh requires credential encryption");
  return durableTransaction(db, () => {
    const now = Date.now();
    if (input.leaseExpiresAt <= now || input.leaseExpiresAt > now + MAX_LEASE_MS) return "stale";
    const current = currentCredential(db, input.connectionId);
    if (!current) return "missing";
    if (
      current.generation !== input.generation ||
      current.snapshot !== input.expectedCredentialVersion
    )
      return "stale";
    // Detect the encryption module's plaintext fallback before spending a grant.
    encryptRequired(current.credential.refreshToken);
    const existing = getLease(db, input);
    if (existing?.state === "quarantined") return "quarantined";
    if (existing?.state === "committed" && existing.reusable_snapshot !== current.snapshot)
      return "quarantined";
    if (existing?.state === "sent") {
      if (existing.lease_expires_at > now) return "busy";
      quarantine(db, { ...input, owner: existing.owner }, "refresh_expired");
      return "quarantined";
    }
    if (existing?.state === "acquired" && existing.lease_expires_at > now) return "busy";
    // Replace only expired UNSENT reservations or explicitly settled no-rotation
    // grants whose exact post-commit cipher snapshot still matches the row.
    db.prepare(
      `INSERT INTO maxai_refresh_leases
        (connection_id, generation, owner, credential_snapshot, lease_expires_at, state, updated_at)
        VALUES (?, ?, ?, ?, ?, 'acquired', ?)
        ON CONFLICT(connection_id, generation) DO UPDATE SET owner = excluded.owner,
          credential_snapshot = excluded.credential_snapshot, lease_expires_at = excluded.lease_expires_at,
          state = 'acquired', sent_at = NULL, failure_code = NULL, reusable_snapshot = NULL,
          updated_at = excluded.updated_at
        WHERE (maxai_refresh_leases.state = 'acquired' AND maxai_refresh_leases.lease_expires_at <= ?)
          OR (maxai_refresh_leases.state = 'committed' AND maxai_refresh_leases.reusable_snapshot = ?)`
    ).run(
      input.connectionId,
      input.generation,
      input.owner,
      current.snapshot,
      input.leaseExpiresAt,
      now,
      now,
      current.snapshot
    );
    return "acquired";
  });
}

/** One-shot dispatch permission. Must commit BEFORE invoking the HTTP client. */
function markSent(input: MaxaiRefreshLease): boolean {
  if (!leaseSchema.safeParse(input).success) return false;
  const db = nativeDb();
  return durableTransaction(db, () => {
    const lease = getLease(db, input);
    if (
      !lease ||
      lease.owner !== input.owner ||
      lease.state !== "acquired" ||
      lease.lease_expires_at <= Date.now()
    )
      return false;
    const current = currentCredential(db, input.connectionId);
    if (
      !current ||
      current.generation !== input.generation ||
      current.snapshot !== lease.credential_snapshot
    )
      return false;
    // A sent marker is never released. Even a crash before the actual POST is
    // conservative quarantine, not permission to risk a duplicate grant.
    const now = Date.now();
    return (
      db
        .prepare(
          `UPDATE maxai_refresh_leases SET state = 'sent', sent_at = ?,
        failure_code = 'refresh_uncertain', updated_at = ?
        WHERE connection_id = ? AND generation = ? AND owner = ? AND state = 'acquired'
          AND credential_snapshot = ? AND lease_expires_at > ?`
        )
        .run(now, now, input.connectionId, input.generation, input.owner, current.snapshot, now)
        .changes === 1
    );
  });
}

function encryptRequired(value: string): string {
  if (!isEncryptionEnabled()) throw new Error("MaxAI credential encryption unavailable");
  const cipher = encrypt(value);
  // encrypt() has a legacy plaintext fallback. Never accept it for new grants.
  if (!looksEncrypted(cipher) || decrypt(cipher, { quiet: true }) !== value) {
    throw new Error("MaxAI credential encryption unavailable");
  }
  return cipher!;
}

function commit(input: MaxaiRefreshCommitInput): boolean {
  if (!leaseSchema.safeParse(input).success) return false;
  const parsed = credentialSchema.safeParse(input.credential);
  if (!parsed.success) return false;
  const credential = parsed.data;
  const expirySeconds = accessTokenExpiry(credential.accessToken);
  const expiresMs = expirySeconds * 1000;
  if (!Number.isFinite(expiresMs) || expiresMs <= Date.now() || expiresMs > 8_640_000_000_000_000)
    return false;
  const db = nativeDb();
  const applied = durableTransaction(db, () => {
    const lease = getLease(db, input);
    if (!lease || lease.owner !== input.owner || lease.state !== "sent") return false;
    if (lease.lease_expires_at <= Date.now()) {
      quarantine(db, input, "refresh_expired");
      return false;
    }
    const current = currentCredential(db, input.connectionId);
    if (
      !current ||
      current.generation !== input.generation ||
      current.snapshot !== lease.credential_snapshot ||
      credential.deviceId !== current.credential.deviceId ||
      credential.userId !== current.credential.userId ||
      (credential.refreshToken !== current.credential.refreshToken &&
        getLease(db, { ...input, generation: digest(credential.refreshToken) }))
    ) {
      quarantine(db, input, "refresh_conflict");
      return false;
    }
    const psd = { ...current.psd };
    for (const key of SECRET_PSD_KEYS) delete psd[key];
    const accessCipher = encryptRequired(credential.accessToken);
    const refreshCipher = encryptRequired(credential.refreshToken);
    const now = Date.now();
    if (lease.lease_expires_at <= now || expiresMs <= now) {
      quarantine(db, input, "refresh_expired");
      return false;
    }
    const expiresAt = new Date(expiresMs).toISOString();
    // IMMEDIATE holds the writer lock from original-cipher comparison through
    // this write. SQL CAS also guards every canonical column and latest PSD.
    const changed =
      db
        .prepare(
          `UPDATE provider_connections SET access_token = ?, refresh_token = ?,
        api_key = ?, provider_specific_data = ?, expires_at = ?, token_expires_at = ?, expires_in = ?, updated_at = ?
        WHERE id = ? AND provider = ? AND auth_type IS ? AND created_at IS ?
          AND access_token IS ? AND refresh_token IS ? AND api_key IS ? AND id_token IS ?
          AND provider_specific_data IS ?
          AND EXISTS (SELECT 1 FROM maxai_refresh_leases WHERE connection_id = ? AND generation = ?
            AND owner = ? AND state = 'sent' AND credential_snapshot = ? AND lease_expires_at > ?)`
        )
        .run(
          accessCipher,
          refreshCipher,
          accessCipher,
          JSON.stringify(psd),
          expiresAt,
          expiresAt,
          Math.ceil((expiresMs - now) / 1000),
          new Date(now).toISOString(),
          input.connectionId,
          current.row.provider,
          current.row.auth_type,
          current.row.created_at,
          current.row.access_token,
          current.row.refresh_token,
          current.row.api_key,
          current.row.id_token,
          current.row.provider_specific_data,
          input.connectionId,
          input.generation,
          input.owner,
          current.snapshot,
          now
        ).changes === 1;
    if (!changed) {
      quarantine(db, input, "refresh_conflict");
      return false;
    }
    // Tokens and spent tombstone commit atomically. Keep the old generation even
    // if an operator later restores it: it has already consumed its one POST.
    const reusableSnapshot =
      credential.refreshToken === current.credential.refreshToken
        ? credentialSnapshot(
            {
              ...current.row,
              access_token: accessCipher,
              refresh_token: refreshCipher,
              api_key: accessCipher,
            },
            psd
          )
        : null;
    db.prepare(
      `UPDATE maxai_refresh_leases SET state = 'committed', failure_code = NULL,
        reusable_snapshot = ?, updated_at = ? WHERE connection_id = ? AND generation = ? AND owner = ?`
    ).run(reusableSnapshot, now, input.connectionId, input.generation, input.owner);
    return true;
  });
  if (applied) {
    try {
      invalidateDbCache("connections");
      bumpProxyConfigGeneration();
    } catch {
      // Credentials are already durable. Never conceal success or retry a grant.
    }
  }
  return applied;
}

/** Only provably UNSENT reservations can be released, never a sent/spent grant. */
function release(input: MaxaiRefreshLease): void {
  if (!leaseSchema.safeParse(input).success) return;
  const db = nativeDb();
  durableTransaction(db, () => {
    db.prepare(
      `DELETE FROM maxai_refresh_leases
        WHERE connection_id = ? AND generation = ? AND owner = ? AND state = 'acquired'`
    ).run(input.connectionId, input.generation, input.owner);
  });
}

export const maxaiRefreshStore = {
  read,
  acquire,
  markSent,
  commit,
  release,
} satisfies MaxaiRefreshStore;
