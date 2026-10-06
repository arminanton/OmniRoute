import {
  writeGeminiSignature,
  readGeminiSignature,
  clearPersistedGeminiSignatures,
  requiresSharedSignatureReadthrough,
} from "../../src/lib/db/geminiSignaturePersistence.ts";

const MAX_SIGNATURES = 1000;
const MEMORY_TTL_MS = 1000 * 60 * 60;
const PERSISTED_TTL_MS = 1000 * 60 * 60 * 24 * 30;

export type SignatureCacheMode = "enabled" | "bypass" | "bypass-strict";

type Entry = {
  signature: string;
  expiresAt: number;
};

const signatures = new Map<string, Entry>();
let signatureCacheMode: SignatureCacheMode = "enabled";
const MAX_LOGGED_ERRORS = 50;
const loggedPersistenceErrors = new Set<string>();

function warnPersistenceError(operation: string, error: unknown) {
  if (process.env.NODE_ENV === "test") return;
  if (loggedPersistenceErrors.has(operation)) return;
  if (loggedPersistenceErrors.size >= MAX_LOGGED_ERRORS) {
    const first = loggedPersistenceErrors.values().next().value;
    if (first !== undefined) loggedPersistenceErrors.delete(first);
  }
  loggedPersistenceErrors.add(operation);
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[signature-cache] persisted ${operation} failed: ${message}`);
}

export function buildGeminiThoughtSignatureKey(namespace: unknown, toolCallId: unknown): unknown {
  if (
    typeof namespace === "string" &&
    namespace.length > 0 &&
    typeof toolCallId === "string" &&
    toolCallId.length > 0
  ) {
    return `${namespace}:${toolCallId}`;
  }
  return toolCallId;
}

function pruneExpired() {
  const now = Date.now();
  for (const [key, value] of signatures.entries()) {
    if (value.expiresAt <= now) {
      signatures.delete(key);
    }
  }

  while (signatures.size > MAX_SIGNATURES) {
    const oldestKey = signatures.keys().next().value;
    if (!oldestKey) break;
    signatures.delete(oldestKey);
  }
}

export function storeGeminiThoughtSignature(toolCallId: unknown, signature: unknown) {
  if (typeof toolCallId !== "string" || !toolCallId) return;
  if (typeof signature !== "string" || !signature) return;

  const now = Date.now();
  pruneExpired();
  signatures.set(toolCallId, {
    signature,
    expiresAt: now + MEMORY_TTL_MS,
  });

  try {
    writeGeminiSignature(toolCallId, {
      signature,
      createdAt: now,
      expiresAt: now + PERSISTED_TTL_MS,
    });
  } catch (error) {
    warnPersistenceError("store", error);
  }
}

export function getGeminiThoughtSignature(toolCallId: unknown) {
  if (typeof toolCallId !== "string" || !toolCallId) return null;

  pruneExpired();
  const entry = signatures.get(toolCallId);
  if (entry && !requiresSharedSignatureReadthrough()) return entry.signature;

  try {
    const persisted = readGeminiSignature(toolCallId);
    if (persisted) {
      signatures.set(toolCallId, {
        signature: persisted.signature,
        expiresAt: Math.min(persisted.expiresAt, Date.now() + MEMORY_TTL_MS),
      });
      return persisted.signature;
    }
  } catch (error) {
    warnPersistenceError("read", error);
  }

  return null;
}

export function normalizeSignatureCacheMode(value: unknown): SignatureCacheMode {
  return value === "bypass" || value === "bypass-strict" ? value : "enabled";
}

export function setGeminiThoughtSignatureMode(mode: unknown) {
  signatureCacheMode = normalizeSignatureCacheMode(mode);
}

export function getGeminiThoughtSignatureMode(): SignatureCacheMode {
  return signatureCacheMode;
}

function decodeSignature(signature: string): Buffer | null {
  if (!signature || (signature[0] !== "R" && signature[0] !== "E")) return null;

  const payload = signature.slice(1);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload) || payload.length % 4 === 1) {
    return null;
  }

  try {
    const decoded = Buffer.from(payload, "base64");
    if (decoded.length === 0) return null;

    const canonical = decoded.toString("base64").replace(/=+$/g, "");
    if (canonical !== payload.replace(/=+$/g, "")) {
      return null;
    }

    return decoded;
  } catch {
    return null;
  }
}

function readVarint(
  buffer: Buffer,
  startOffset: number
): { nextOffset: number; value: number } | null {
  let offset = startOffset;
  let result = 0;
  let shift = 0;

  while (offset < buffer.length && shift < 35) {
    const byte = buffer[offset];
    result |= (byte & 0x7f) << shift;
    offset += 1;

    if ((byte & 0x80) === 0) {
      return { nextOffset: offset, value: result };
    }

    shift += 7;
  }

  return null;
}

export function isValidBasicGeminiThoughtSignature(signature: unknown): boolean {
  if (typeof signature !== "string") return false;
  const decoded = decodeSignature(signature);
  return Boolean(decoded && decoded[0] === 0x12);
}

export function isValidFullGeminiThoughtSignature(signature: unknown): boolean {
  if (typeof signature !== "string") return false;
  const decoded = decodeSignature(signature);
  if (!decoded || decoded[0] !== 0x12) return false;

  const outerLength = readVarint(decoded, 1);
  if (!outerLength) return false;

  const outerEnd = outerLength.nextOffset + outerLength.value;
  if (outerEnd !== decoded.length) return false;

  const inner = decoded.subarray(outerLength.nextOffset, outerEnd);
  if (inner.length === 0 || inner[0] !== 0x0a) return false;

  const innerLength = readVarint(inner, 1);
  if (!innerLength) return false;

  return innerLength.nextOffset + innerLength.value === inner.length;
}

export function resolveGeminiThoughtSignature(
  toolCallId: unknown,
  clientSignature?: unknown
): string | null {
  const persisted = getGeminiThoughtSignature(toolCallId);
  if (typeof clientSignature !== "string" || clientSignature.length === 0) {
    return persisted;
  }

  if (signatureCacheMode === "enabled") {
    return persisted;
  }

  const isValid =
    signatureCacheMode === "bypass-strict"
      ? isValidFullGeminiThoughtSignature(clientSignature)
      : isValidBasicGeminiThoughtSignature(clientSignature);

  if (isValid) {
    return clientSignature;
  }

  console.warn(
    `[signature-cache] ${signatureCacheMode}: invalid client thought signature, falling back`
  );
  return persisted;
}

export function clearGeminiThoughtSignatures() {
  signatures.clear();
  signatureCacheMode = "enabled";
  try {
    clearPersistedGeminiSignatures();
  } catch (error) {
    warnPersistenceError("clear", error);
  }
}

export function clearGeminiThoughtSignatureMemoryForTests() {
  signatures.clear();
}

export function getGeminiThoughtSignatureMemorySizeForTests() {
  pruneExpired();
  return signatures.size;
}
