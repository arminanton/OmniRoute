import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const previousDataDir = process.env.DATA_DIR;
const previousApiKeySecret = process.env.API_KEY_SECRET;
const testDataDir = mkdtempSync(join(tmpdir(), "omniroute-reasoning-truncation-"));
process.env.DATA_DIR = testDataDir;
process.env.API_KEY_SECRET = "reasoning-cache-truncation-test-secret";

const {
  cacheReasoningByKey,
  lookupReasoning,
  clearReasoningCacheAll,
  getReasoningCacheServiceStats,
  getReasoningCacheServiceEntries,
} = await import("../../open-sse/services/reasoningCache.ts");
const { createLocalReasoningCacheContext } =
  await import("../../open-sse/services/reasoningCacheContext.ts");
const { resetDbInstance } = await import("../../src/lib/db/core.ts");
const { clearAllReasoningCache } = await import("../../src/lib/db/reasoningCache.ts");
const reasoningCacheContext = createLocalReasoningCacheContext();
assert.ok(reasoningCacheContext);

after(() => {
  try {
    clearReasoningCacheAll();
  } finally {
    resetDbInstance();
    rmSync(testDataDir, { recursive: true, force: true });
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    if (previousApiKeySecret === undefined) delete process.env.API_KEY_SECRET;
    else process.env.API_KEY_SECRET = previousApiKeySecret;
  }
});

function reset() {
  clearReasoningCacheAll();
}

// ── Constants ──

test("MAX_ENTRY_BYTES is 10000", async () => {
  // Verify by caching a string of exactly 10001 chars and checking it gets truncated.
  // We read the constant from the source to assert the value directly.
  const fs = await import("node:fs");
  const src = fs.readFileSync(
    new URL("../../open-sse/services/reasoningCache.ts", import.meta.url),
    "utf8"
  );
  const match = src.match(/const\s+MAX_ENTRY_BYTES\s*=\s*(\d+)/);
  assert.ok(match, "should find MAX_ENTRY_BYTES declaration");
  assert.equal(Number(match![1]), 10000);
});

// ── Truncation ──

test("reasoning string > 10000 chars is truncated to 10000", async () => {
  reset();
  const key = randomUUID();
  const long = "A".repeat(15000);
  cacheReasoningByKey(key, "deepseek", "deepseek-r1", long, reasoningCacheContext);
  const result = lookupReasoning(key, reasoningCacheContext);
  assert.ok(result, "should return cached reasoning");
  assert.equal(result.length, 10000, "should be truncated to MAX_ENTRY_BYTES");
});

test("short reasoning string is cached unchanged", async () => {
  reset();
  const key = randomUUID();
  const short = "short reasoning content";
  cacheReasoningByKey(key, "deepseek", "deepseek-r1", short, reasoningCacheContext);
  const result = lookupReasoning(key, reasoningCacheContext);
  assert.ok(result, "should return cached reasoning");
  assert.equal(result, short);
});

test("truncation preserves the beginning of the string", async () => {
  reset();
  const key = randomUUID();
  const prefix = "BEGINNING_MARKER_";
  const long = prefix + "X".repeat(20000);
  cacheReasoningByKey(key, "deepseek", "deepseek-r1", long, reasoningCacheContext);
  const result = lookupReasoning(key, reasoningCacheContext);
  assert.ok(result, "should return cached reasoning");
  assert.ok(result.startsWith(prefix), "truncated result should preserve the beginning");
  assert.equal(result.length, 10000);
});

// ── Memory cache MAX_MEMORY_ENTRIES limit ──

test("memory cache respects MAX_MEMORY_ENTRIES limit (200)", async () => {
  reset();
  const keys: string[] = [];
  // Cache 201 entries — the oldest should be evicted from memory
  for (let i = 0; i < 201; i++) {
    const k = `entry-${i}-${randomUUID()}`;
    keys.push(k);
    cacheReasoningByKey(k, "deepseek", "deepseek-r1", `reasoning-${i}`, reasoningCacheContext);
  }

  assert.equal(getReasoningCacheServiceStats().memoryEntries, 200);
  assert.equal(getReasoningCacheServiceStats().dbEntries, 201);
  const entries = getReasoningCacheServiceEntries() as Array<{ toolCallId: string }>;
  assert.ok(entries.length > 0);
  for (const entry of entries) assert.match(entry.toolCallId, /^rc2h:[0-9a-f]{64}$/);

  // Delete only the DB tier to verify memory eviction without private memory access.
  clearAllReasoningCache();
  assert.equal(lookupReasoning(keys[0], reasoningCacheContext), null);
  const last = lookupReasoning(keys[200], reasoningCacheContext);
  assert.ok(last, "most recent entry should be in memory cache");
  assert.ok(last.includes("reasoning-200"), "should contain expected content");
});
