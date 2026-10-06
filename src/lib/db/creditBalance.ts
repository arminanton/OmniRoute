/**
 * Antigravity GOOGLE_ONE_AI credit balance persistence.
 *
 * Stores last-known credit balances in the `key_value` table so they survive
 * server restarts. The in-memory `creditBalanceCache` in the executor is the
 * primary source at runtime; this module provides the fallback read/write layer.
 */

import { getDbInstance, isBuildPhase, isCloud } from "./core";

interface StatementLike<TRow = unknown> {
  get: (...params: unknown[]) => TRow | undefined;
  run: (...params: unknown[]) => { changes?: number };
  all: (...params: unknown[]) => TRow[];
}

interface DbLike {
  prepare: <TRow = unknown>(sql: string) => StatementLike<TRow>;
}

interface KeyValueRow {
  key: string;
  value: string;
}

export interface CreditBalanceEntry {
  balance: number;
  updatedAt: string;
}

const NAMESPACE = "antigravityCreditBalance";

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Read the persisted credit balance for an accountId.
 * Returns the balance number, or null if not found.
 */
export function getPersistedCreditBalance(accountId: string): number | null {
  if (isBuildPhase || isCloud) return null;
  const db = getDbInstance() as unknown as DbLike;
  const row = db
    .prepare("SELECT value FROM key_value WHERE namespace = ? AND key = ?")
    .get(NAMESPACE, accountId) as KeyValueRow | undefined;
  if (!row?.value) return null;
  const parsed = parseJson(row.value) as CreditBalanceEntry | null;
  if (!parsed || typeof parsed.balance !== "number") return null;
  return parsed.balance;
}

/**
 * Read all persisted credit balances.
 * Returns a Map of accountId → balance.
 */
export function getAllPersistedCreditBalances(): Map<string, number> {
  const result = new Map<string, number>();
  if (isBuildPhase || isCloud) return result;
  const db = getDbInstance() as unknown as DbLike;
  const rows = db
    .prepare("SELECT key, value FROM key_value WHERE namespace = ?")
    .all(NAMESPACE) as KeyValueRow[];
  for (const row of rows) {
    const parsed = parseJson(row.value) as CreditBalanceEntry | null;
    if (parsed && typeof parsed.balance === "number") {
      result.set(row.key, parsed.balance);
    }
  }
  return result;
}

/**
 * Persist a credit balance for an accountId.
 */
export function persistCreditBalance(
  accountId: string,
  balance: number,
  observedAt = Date.now()
): void {
  if (isBuildPhase || isCloud) return;
  if (!Number.isFinite(balance) || balance < 0 || !Number.isFinite(observedAt)) return;
  const db = getDbInstance() as unknown as DbLike;
  const entry: CreditBalanceEntry = {
    balance,
    updatedAt: new Date(observedAt).toISOString(),
  };
  db.prepare(
    `INSERT INTO key_value (namespace, key, value) VALUES (?, ?, ?)
    ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value
    WHERE json_extract(key_value.value,'$.updatedAt') IS NULL
       OR json_extract(key_value.value,'$.updatedAt') <= json_extract(excluded.value,'$.updatedAt')`
  ).run(NAMESPACE, accountId, JSON.stringify(entry));
}

/** Preserve upstream observation age when hydrating; restarting must not make stale data fresh. */
export function getAllPersistedCreditBalanceEntries(): Map<string, CreditBalanceEntry> {
  const result = new Map<string, CreditBalanceEntry>();
  if (isBuildPhase || isCloud) return result;
  const rows = (getDbInstance() as unknown as DbLike)
    .prepare("SELECT key,value FROM key_value WHERE namespace=?")
    .all(NAMESPACE) as KeyValueRow[];
  for (const row of rows) {
    const value = parseJson(row.value) as CreditBalanceEntry | null;
    if (
      value &&
      Number.isFinite(value.balance) &&
      value.balance >= 0 &&
      Number.isFinite(Date.parse(value.updatedAt))
    )
      result.set(row.key, value);
  }
  return result;
}
