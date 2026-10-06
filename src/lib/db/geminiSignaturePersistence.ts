import { getDbInstance } from "./core.ts";
import { encrypt, decrypt, looksEncrypted, isEncryptionEnabled } from "./encryption.ts";
import {
  getSharedConversationState,
  isSharedConversationStateRequired,
} from "./sharedConversationState.ts";
const namespace = "gemini_thought_signatures";
export interface PersistedGeminiSignature {
  signature: string;
  createdAt: number;
  expiresAt: number;
}
const boundScope = (key: string) => /^gs2:([a-f0-9]{64}):/.exec(key)?.[1] ?? null;

export function writeGeminiSignature(key: string, entry: PersistedGeminiSignature): boolean {
  const shared = getSharedConversationState();
  if (shared && !boundScope(key)) return false;
  if (shared)
    return shared.put(
      "gemini_signature",
      key,
      boundScope(key)!,
      entry,
      Math.min(entry.expiresAt - Date.now(), 3600000)
    );
  // No plaintext fallback, even outside overlap mode. RAM-only inference remains available.
  if (!isEncryptionEnabled()) return false;
  const value = encrypt(JSON.stringify(entry));
  if (!looksEncrypted(value)) return false;
  const db = getDbInstance();
  db.prepare("INSERT OR REPLACE INTO key_value(namespace,key,value) VALUES(?,?,?)").run(
    namespace,
    key,
    value
  );
  db.prepare(
    "DELETE FROM key_value WHERE namespace=? AND rowid IN(SELECT rowid FROM key_value WHERE namespace=? ORDER BY rowid DESC LIMIT -1 OFFSET 2000)"
  ).run(namespace, namespace);
  return true;
}

export function readGeminiSignature(key: string): PersistedGeminiSignature | null {
  const shared = getSharedConversationState();
  if (shared)
    return boundScope(key)
      ? shared.get<PersistedGeminiSignature>("gemini_signature", key, boundScope(key)!)
      : null;
  const row = getDbInstance()
    .prepare("SELECT value FROM key_value WHERE namespace=? AND key=?")
    .get(namespace, key) as { value?: unknown } | undefined;
  if (typeof row?.value !== "string") return null;
  // Legacy plaintext may be migrated only with encryption present, never used as overlap proof.
  if (!looksEncrypted(row.value) && !isEncryptionEnabled()) return null;
  const value = looksEncrypted(row.value) ? decrypt(row.value, { quiet: true }) : row.value;
  if (!value) return null;
  try {
    const entry = JSON.parse(value) as PersistedGeminiSignature;
    if (
      typeof entry.signature !== "string" ||
      !entry.signature ||
      !Number.isFinite(entry.expiresAt) ||
      entry.expiresAt <= Date.now()
    )
      return null;
    if (!looksEncrypted(row.value)) writeGeminiSignature(key, entry);
    return entry;
  } catch {
    return null;
  }
}
export function clearPersistedGeminiSignatures() {
  const shared = getSharedConversationState();
  if (shared) shared.clear("gemini_signature");
  getDbInstance().prepare("DELETE FROM key_value WHERE namespace=?").run(namespace);
}
export function requiresSharedSignatureReadthrough() {
  return isSharedConversationStateRequired();
}
