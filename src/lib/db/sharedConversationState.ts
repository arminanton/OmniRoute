import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { encrypt, decrypt, isEncryptionEnabled, looksEncrypted } from "./encryption.ts";

export const CONVERSATION_STATE_PROTOCOL = "omni-conversation-state/v1";
export interface ConversationScope {
  principal: string;
  conversation: string;
  provider: string;
  model: string;
  account: string;
  authGeneration: string;
}
export const conversationScopeKey = (scope: ConversationScope) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        scope.principal,
        scope.conversation,
        scope.provider,
        scope.model,
        scope.account,
        scope.authGeneration,
      ])
    )
    .digest("hex");
export const opaqueStateKey = (value: string) => createHash("sha256").update(value).digest("hex");

/** Shared POSIX SQLite authority. Sensitive payloads must be authenticated ciphertext. */
export class SharedConversationState {
  private db: DatabaseSync;
  readonly instance = `${process.env.OMNIROUTE_APP_GENERATION || "local"}:${process.pid}:${randomUUID()}`;
  constructor(filename: string) {
    if (!isEncryptionEnabled())
      throw new Error("Shared conversation state requires field encryption");
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS conversation_state_protocol(version TEXT PRIMARY KEY);
      INSERT OR IGNORE INTO conversation_state_protocol VALUES('omni-conversation-state/v1');
      CREATE TABLE IF NOT EXISTS conversation_state_records(
        kind TEXT NOT NULL, key TEXT NOT NULL, scope TEXT NOT NULL, value TEXT NOT NULL,
        expires INTEGER NOT NULL, PRIMARY KEY(kind,key,scope));
      CREATE TABLE IF NOT EXISTS conversation_state_pins(
        key TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL);`);
    const versions = this.db.prepare("SELECT version FROM conversation_state_protocol").all();
    if (versions.length !== 1 || versions[0].version !== CONVERSATION_STATE_PROTOCOL)
      throw new Error("Incompatible shared conversation state protocol");
  }
  put(kind: string, key: string, scope: string, value: unknown, ttlMs = 3600000): boolean {
    if (!/^[a-f0-9]{64}$/.test(scope) || !kind || !key) return false;
    const expires = Date.now() + ttlMs;
    const serialized = JSON.stringify({
      protocol: CONVERSATION_STATE_PROTOCOL,
      kind,
      key: opaqueStateKey(key),
      scope,
      expires,
      value,
    });
    if (
      Buffer.byteLength(serialized) > 512 * 1024 ||
      !Number.isFinite(ttlMs) ||
      ttlMs < 1 ||
      ttlMs > 2 * 3600000
    )
      return false;
    const ciphertext = encrypt(serialized);
    if (!looksEncrypted(ciphertext))
      throw new Error("Shared conversation encryption failed closed");
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM conversation_state_records WHERE expires <= ?").run(now);
      this.db
        .prepare("INSERT OR REPLACE INTO conversation_state_records VALUES(?,?,?,?,?)")
        .run(kind, opaqueStateKey(key), scope, ciphertext as string, expires);
      const count = this.db
        .prepare("SELECT COUNT(*) AS n FROM conversation_state_records")
        .get()?.n;
      if (typeof count === "number" && count > 5000)
        this.db
          .prepare(
            "DELETE FROM conversation_state_records WHERE rowid IN(SELECT rowid FROM conversation_state_records ORDER BY expires LIMIT ?)"
          )
          .run(count - 5000);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  get<T>(kind: string, key: string, scope: string): T | null {
    const row = this.db
      .prepare(
        "SELECT value FROM conversation_state_records WHERE kind=? AND key=? AND scope=? AND expires>?"
      )
      .get(kind, opaqueStateKey(key), scope, Date.now());
    if (!row || typeof row.value !== "string" || !looksEncrypted(row.value)) return null;
    const plaintext = decrypt(row.value, { quiet: true });
    if (!plaintext || looksEncrypted(plaintext)) return null;
    try {
      const envelope = JSON.parse(plaintext) as {
        protocol: unknown;
        kind: unknown;
        key: unknown;
        scope: unknown;
        expires: number;
        value: T;
      };
      if (
        envelope.protocol !== CONVERSATION_STATE_PROTOCOL ||
        envelope.kind !== kind ||
        envelope.key !== opaqueStateKey(key) ||
        envelope.scope !== scope ||
        !Number.isFinite(envelope.expires) ||
        envelope.expires <= Date.now()
      )
        return null;
      return envelope.value;
    } catch {
      return null;
    }
  }
  knownScopes(kind: string, key: string): string[] {
    const rows = this.db
      .prepare("SELECT scope FROM conversation_state_records WHERE kind=? AND key=? AND expires>?")
      .all(kind, opaqueStateKey(key), Date.now());
    return rows.flatMap((row) =>
      typeof row.scope === "string" && this.get(kind, key, row.scope) !== null ? [row.scope] : []
    );
  }
  remove(kind: string, key: string, scope: string) {
    this.db
      .prepare("DELETE FROM conversation_state_records WHERE kind=? AND key=? AND scope=?")
      .run(kind, opaqueStateKey(key), scope);
  }
  clear(kind: string) {
    this.db.prepare("DELETE FROM conversation_state_records WHERE kind=?").run(kind);
  }
  pin(scope: string, ttlMs = 300000): boolean {
    if (!Number.isFinite(ttlMs) || ttlMs < 1 || ttlMs > 2 * 3600000)
      throw new Error("Invalid conversation pin TTL");
    const changed = this.db
      .prepare(
        `INSERT INTO conversation_state_pins VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET owner=excluded.owner,expires=excluded.expires
      WHERE conversation_state_pins.owner=excluded.owner OR conversation_state_pins.expires<=?`
      )
      .run(scope, this.instance, Date.now() + ttlMs, Date.now());
    return Number(changed.changes) === 1;
  }
  unpin(scope: string) {
    this.db
      .prepare("DELETE FROM conversation_state_pins WHERE key=? AND owner=?")
      .run(scope, this.instance);
  }
  pinOwner(scope: string): string | null {
    const row = this.db
      .prepare("SELECT owner FROM conversation_state_pins WHERE key=? AND expires>?")
      .get(scope, Date.now());
    return typeof row?.owner === "string" ? row.owner : null;
  }
  activePins(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM conversation_state_pins WHERE owner=? AND expires>?")
      .get(this.instance, Date.now());
    return Number(row?.n ?? 0);
  }
  close() {
    this.db.close();
  }
}

let shared: SharedConversationState | null = null;
export function isSharedConversationStateRequired() {
  return process.env.OMNI_SHARED_ADMISSION === "true";
}
export function getSharedConversationState(): SharedConversationState | null {
  if (!isSharedConversationStateRequired()) return null;
  const filename = process.env.OMNI_COORDINATION_DB;
  if (!filename) throw new Error("Shared conversation state requires the coordination volume");
  return (shared ||= new SharedConversationState(filename));
}
export function closeSharedConversationStateForTests() {
  shared?.close();
  shared = null;
}
