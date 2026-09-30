/**
 * Unit tests for the Reasoning Replay Cache (Issue #1628).
 *
 * Covers: memory cache, DB fallback, hit/miss counters,
 * provider detection, and cleanup behavior.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const previousDataDir = process.env.DATA_DIR;
const previousApiKeySecret = process.env.API_KEY_SECRET;
const testDataDir = mkdtempSync(join(tmpdir(), "omniroute-reasoning-"));
const TEST_API_KEY_SECRET = "reasoning-cache-test-secret";
process.env.DATA_DIR = testDataDir;
process.env.API_KEY_SECRET = TEST_API_KEY_SECRET;

// Import DB-dependent modules only after the isolated test environment is ready.
const {
  buildAssistantMessageCacheKey,
  cacheReasoningFromAssistantMessage,
  cacheReasoning,
  cacheReasoningByKey,
  cacheReasoningBatch,
  deleteReasoningCacheEntry,
  getReasoningCacheServiceEntries,
  lookupReasoning,
  recordReplay,
  getReasoningCacheServiceStats,
  clearReasoningCacheAll,
  isDeepSeekReasoningModel,
  requiresReasoningReplay,
  cleanupReasoningCache,
} = await import("../../open-sse/services/reasoningCache.ts");
const { createLocalReasoningCacheContext } =
  await import("../../open-sse/services/reasoningCacheContext.ts");
const { translateRequest } = await import("../../open-sse/translator/index.ts");
const { FORMATS } = await import("../../open-sse/translator/formats.ts");
const { ensureToolCallIds } = await import("../../open-sse/translator/helpers/toolCallHelper.ts");
const { translateNonStreamingResponse } =
  await import("../../open-sse/handlers/responseTranslator.ts");
const { getDbInstance, resetDbInstance } = await import("../../src/lib/db/core.ts");
const { getReasoningCache, setReasoningCache, deleteReasoningCache } =
  await import("../../src/lib/db/reasoningCache.ts");
const { DELETE, GET } = await import("../../src/app/api/cache/reasoning/route.ts");
const { createApiKey } = await import("../../src/lib/db/apiKeys.ts");
const { updateSettings } = await import("../../src/lib/db/settings.ts");
const { clearModelsDevCapabilities, saveModelsDevCapabilities } =
  await import("../../src/lib/modelsDevSync.ts");

const reasoningCacheContext = createLocalReasoningCacheContext();
assert.ok(reasoningCacheContext);

// DB-only fixtures use the documented v2 tuple, never a service storage-key bypass.
function storageKeyForTest(logicalId: string): string {
  const tuple = ["reasoning-cache-v2", "local", "", null, logicalId];
  return `rc2h:${createHmac("sha256", TEST_API_KEY_SECRET)
    .update(JSON.stringify(tuple))
    .digest("hex")}`;
}

function buildCapability(overrides = {}) {
  return {
    tool_call: null,
    reasoning: null,
    attachment: null,
    structured_output: null,
    temperature: null,
    modalities_input: "[]",
    modalities_output: "[]",
    knowledge_cutoff: null,
    release_date: null,
    last_updated: null,
    status: null,
    family: null,
    open_weights: null,
    limit_context: null,
    limit_input: null,
    limit_output: null,
    interleaved_field: null,
    ...overrides,
  };
}

before(async () => {
  await updateSettings({ requireLogin: false });
});

after(async () => {
  try {
    await updateSettings({ requireLogin: true });
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

describe("Reasoning Replay Cache — Service Layer", () => {
  before(() => {
    // Start each suite with a clean slate
    clearReasoningCacheAll();
  });

  after(() => {
    clearReasoningCacheAll();
  });

  it("should store and retrieve reasoning by tool_call_id", () => {
    cacheReasoning(
      "call_test_1",
      "deepseek",
      "deepseek-reasoner",
      "The user wants to read the file...",
      reasoningCacheContext
    );
    const result = lookupReasoning("call_test_1", reasoningCacheContext);
    assert.equal(result, "The user wants to read the file...");
    assert.equal(
      getReasoningCache(storageKeyForTest("call_test_1"))?.reasoning,
      "The user wants to read the file..."
    );
    assert.equal(getReasoningCache("call_test_1"), null);
  });

  it("should fall back to SQLite when memory misses", () => {
    clearReasoningCacheAll();
    setReasoningCache(
      storageKeyForTest("call_db_only"),
      "deepseek",
      "deepseek-reasoner",
      "DB-only reasoning"
    );

    assert.equal(lookupReasoning("call_db_only", reasoningCacheContext), "DB-only reasoning");

    const stats = getReasoningCacheServiceStats();
    assert.equal(stats.hits, 1);
    assert.equal(stats.memoryEntries, 1);
    assert.equal(stats.dbEntries, 1);
  });

  it("should preserve SQLite expiry when promoting an entry to memory", () => {
    clearReasoningCacheAll();
    const realDateNow = Date.now;
    const startedAt = realDateNow();
    setReasoningCache(
      storageKeyForTest("call_db_short_ttl"),
      "deepseek",
      "deepseek-v4-pro",
      "Short-lived DB reasoning",
      5_000
    );

    try {
      assert.equal(
        lookupReasoning("call_db_short_ttl", reasoningCacheContext),
        "Short-lived DB reasoning"
      );
      assert.equal(getReasoningCacheServiceStats().memoryEntries, 1);
      deleteReasoningCache(storageKeyForTest("call_db_short_ttl"));
      Date.now = () => startedAt + 6_000;
      assert.equal(lookupReasoning("call_db_short_ttl", reasoningCacheContext), null);
    } finally {
      Date.now = realDateNow;
    }
  });

  it("should enforce the memory cap when promoting SQLite-only entries", () => {
    clearReasoningCacheAll();
    for (let i = 0; i < 205; i++) {
      setReasoningCache(
        storageKeyForTest(`call_promote_${i}`),
        "deepseek",
        "deepseek-v4-pro",
        `DB reasoning ${i}`
      );
    }
    assert.equal(getReasoningCacheServiceStats().memoryEntries, 0);

    for (let i = 0; i < 205; i++) {
      assert.equal(
        lookupReasoning(`call_promote_${i}`, reasoningCacheContext),
        `DB reasoning ${i}`
      );
      assert.ok(getReasoningCacheServiceStats().memoryEntries <= 200);
    }
    assert.equal(getReasoningCacheServiceStats().memoryEntries, 200);
    assert.equal(getReasoningCacheServiceStats().dbEntries, 205);
    assert.equal(lookupReasoning("call_promote_0", reasoningCacheContext), "DB reasoning 0");
    assert.equal(getReasoningCacheServiceStats().memoryEntries, 200);
  });

  it("should return null for unknown tool_call_id", () => {
    const result = lookupReasoning("call_nonexistent", reasoningCacheContext);
    assert.equal(result, null);
  });

  it("should return null for empty tool_call_id", () => {
    const result = lookupReasoning("", reasoningCacheContext);
    assert.equal(result, null);
  });

  it("should skip caching when reasoning is empty", () => {
    cacheReasoning("call_empty", "deepseek", "deepseek-chat", "", reasoningCacheContext);
    const result = lookupReasoning("call_empty", reasoningCacheContext);
    assert.equal(result, null);
  });

  it("should cache reasoning for multiple tool_call_ids (batch)", () => {
    cacheReasoningBatch(
      ["call_batch_1", "call_batch_2", "call_batch_3"],
      "deepseek",
      "deepseek-reasoner",
      "Batch reasoning content",
      reasoningCacheContext
    );
    assert.equal(lookupReasoning("call_batch_1", reasoningCacheContext), "Batch reasoning content");
    assert.equal(lookupReasoning("call_batch_2", reasoningCacheContext), "Batch reasoning content");
    assert.equal(lookupReasoning("call_batch_3", reasoningCacheContext), "Batch reasoning content");
  });

  it("should capture assistant reasoning for all tool_call IDs", () => {
    clearReasoningCacheAll();

    const cached = cacheReasoningFromAssistantMessage(
      {
        role: "assistant",
        reasoning_content: "Captured assistant reasoning",
        tool_calls: [{ id: "call_capture_1" }, { id: "call_capture_2" }],
      },
      "deepseek",
      "deepseek-reasoner",
      reasoningCacheContext
    );

    assert.equal(cached, 2);
    assert.equal(
      lookupReasoning("call_capture_1", reasoningCacheContext),
      "Captured assistant reasoning"
    );
    assert.equal(
      lookupReasoning("call_capture_2", reasoningCacheContext),
      "Captured assistant reasoning"
    );
  });

  it("should keep request message cache keys stable when tool call IDs change", () => {
    clearReasoningCacheAll();

    const requestId = "req_reasoning_stable";
    const messageIndex = 2;
    const cacheKey = `${requestId}:${messageIndex}`;
    const body = {
      messages: [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_before_normalization",
              type: "function",
              function: { name: "lookup", arguments: { city: "Seoul" } },
            },
          ],
        },
        { role: "tool", content: "Sunny" },
      ],
    };

    cacheReasoning(
      cacheKey,
      "deepseek",
      "deepseek-reasoner",
      "Stable cached reasoning",
      reasoningCacheContext
    );
    const originalToolCallId = body.messages[0].tool_calls[0].id;

    ensureToolCallIds(body, { use9CharId: true });

    assert.notEqual(body.messages[0].tool_calls[0].id, originalToolCallId);
    assert.equal(lookupReasoning(cacheKey, reasoningCacheContext), "Stable cached reasoning");
  });

  it("should capture provider reasoning alias when reasoning_content is absent", () => {
    clearReasoningCacheAll();

    const cached = cacheReasoningFromAssistantMessage(
      {
        role: "assistant",
        reasoning: "Alias reasoning",
        tool_calls: [{ id: "call_capture_alias" }],
      },
      "kimi",
      "kimi-k2.5",
      reasoningCacheContext
    );

    assert.equal(cached, 1);
    assert.equal(lookupReasoning("call_capture_alias", reasoningCacheContext), "Alias reasoning");
  });

  it("should cache assistant reasoning without tool calls by scoped transcript", () => {
    clearReasoningCacheAll();
    const scope = "api-key:test:session:test";
    const historyMessages = [{ role: "user", content: "hi" }];
    const assistantMessage = {
      role: "assistant",
      content: "Hello!",
      reasoning_content: "No tool call reasoning",
    };

    const cached = cacheReasoningFromAssistantMessage(
      assistantMessage,
      "deepseek",
      "deepseek-v4-pro",
      reasoningCacheContext,
      { scope, historyMessages }
    );
    const cacheKey = buildAssistantMessageCacheKey(
      scope,
      [...historyMessages, assistantMessage],
      historyMessages.length
    );

    assert.equal(cached, 1);
    assert.equal(lookupReasoning(cacheKey, reasoningCacheContext), "No tool call reasoning");
  });

  it("should skip assistant reasoning without tool calls when stable transcript scope is absent", () => {
    clearReasoningCacheAll();

    const cached = cacheReasoningFromAssistantMessage(
      {
        role: "assistant",
        reasoning_content: "Missing key context",
      },
      "deepseek",
      "deepseek-reasoner",
      reasoningCacheContext
    );

    assert.equal(cached, 0);
    assert.equal(lookupReasoning("request:req_missing:message:0", reasoningCacheContext), null);
  });

  it("should store arbitrary reasoning cache keys", () => {
    clearReasoningCacheAll();

    cacheReasoningByKey(
      "request:req_direct:message:1",
      "deepseek",
      "deepseek-reasoner",
      "Keyed plan",
      reasoningCacheContext
    );

    assert.equal(
      lookupReasoning("request:req_direct:message:1", reasoningCacheContext),
      "Keyed plan"
    );
    assert.equal(
      getReasoningCache(storageKeyForTest("request:req_direct:message:1"))?.reasoning,
      "Keyed plan"
    );
    assert.equal(getReasoningCache("request:req_direct:message:1"), null);
  });

  it("should overwrite if the same tool_call_id is cached again in the same context", () => {
    cacheReasoning(
      "call_overwrite",
      "deepseek",
      "deepseek-chat",
      "First reasoning",
      reasoningCacheContext
    );
    cacheReasoning(
      "call_overwrite",
      "deepseek",
      "deepseek-chat",
      "Updated reasoning",
      reasoningCacheContext
    );
    // Second write wins (INSERT OR REPLACE)
    const result = lookupReasoning("call_overwrite", reasoningCacheContext);
    assert.equal(result, "Updated reasoning");
  });

  it("should track hits and misses correctly", () => {
    clearReasoningCacheAll();

    cacheReasoning(
      "call_hit_test",
      "deepseek",
      "deepseek-chat",
      "test reasoning",
      reasoningCacheContext
    );

    lookupReasoning("call_hit_test", reasoningCacheContext); // hit
    lookupReasoning("call_hit_test", reasoningCacheContext); // hit
    lookupReasoning("call_miss_test", reasoningCacheContext); // miss

    const stats = getReasoningCacheServiceStats();
    assert.ok(stats.hits >= 2, `Expected at least 2 hits, got ${stats.hits}`);
    assert.ok(stats.misses >= 1, `Expected at least 1 miss, got ${stats.misses}`);
  });

  it("should track replays", () => {
    clearReasoningCacheAll();

    recordReplay();
    recordReplay();
    recordReplay();

    const stats = getReasoningCacheServiceStats();
    assert.ok(stats.replays >= 3, `Expected at least 3 replays, got ${stats.replays}`);
  });

  it("should report correct stats structure", () => {
    clearReasoningCacheAll();

    cacheReasoning(
      "call_stat_1",
      "deepseek",
      "deepseek-reasoner",
      "Reasoning A",
      reasoningCacheContext
    );
    cacheReasoning(
      "call_stat_2",
      "kimi",
      "kimi-k2.5",
      "Reasoning B from Kimi",
      reasoningCacheContext
    );

    const stats = getReasoningCacheServiceStats();

    assert.equal(typeof stats.memoryEntries, "number");
    assert.equal(typeof stats.dbEntries, "number");
    assert.equal(typeof stats.totalEntries, "number");
    assert.equal(typeof stats.totalChars, "number");
    assert.equal(typeof stats.hits, "number");
    assert.equal(typeof stats.misses, "number");
    assert.equal(typeof stats.replays, "number");
    assert.equal(typeof stats.replayRate, "string");
    assert.ok(stats.replayRate.endsWith("%"));
    assert.equal(typeof stats.byProvider, "object");
    assert.equal(typeof stats.byModel, "object");
    assert.equal(stats.dbEntries, 2);
    assert.equal(stats.byProvider.deepseek.entries, 1);
    assert.equal(stats.byProvider.kimi.entries, 1);
  });

  it("should list persisted entries for the dashboard API", () => {
    clearReasoningCacheAll();

    cacheReasoning(
      "call_entry_1",
      "deepseek",
      "deepseek-reasoner",
      "Entry reasoning A",
      reasoningCacheContext
    );
    cacheReasoning("call_entry_2", "kimi", "kimi-k2.5", "Entry reasoning B", reasoningCacheContext);

    const deepseekEntries = getReasoningCacheServiceEntries({ provider: "deepseek" }) as Array<{
      toolCallId: string;
      expiresAt: string;
    }>;

    assert.equal(deepseekEntries.length, 1);
    assert.equal(deepseekEntries[0].toolCallId, storageKeyForTest("call_entry_1"));
    assert.match(deepseekEntries[0].toolCallId, /^rc2h:[0-9a-f]{64}$/);
    assert.doesNotThrow(() => new Date(deepseekEntries[0].expiresAt).toISOString());
  });

  it("should clear all entries", () => {
    cacheReasoning(
      "call_clear_1",
      "deepseek",
      "deepseek-chat",
      "Will be cleared",
      reasoningCacheContext
    );
    cacheReasoning(
      "call_clear_2",
      "deepseek",
      "deepseek-chat",
      "Also cleared",
      reasoningCacheContext
    );

    const count = clearReasoningCacheAll();
    assert.ok(count >= 0);

    assert.equal(lookupReasoning("call_clear_1", reasoningCacheContext), null);
    assert.equal(lookupReasoning("call_clear_2", reasoningCacheContext), null);
  });

  it("should delete one entry by tool_call_id", () => {
    clearReasoningCacheAll();

    cacheReasoning(
      "call_delete_1",
      "deepseek",
      "deepseek-chat",
      "Delete me",
      reasoningCacheContext
    );
    cacheReasoning("call_delete_2", "deepseek", "deepseek-chat", "Keep me", reasoningCacheContext);

    assert.equal(deleteReasoningCacheEntry("call_delete_1", reasoningCacheContext), 1);
    assert.equal(lookupReasoning("call_delete_1", reasoningCacheContext), null);
    assert.equal(lookupReasoning("call_delete_2", reasoningCacheContext), "Keep me");
  });

  it("should clear entries by provider only", () => {
    clearReasoningCacheAll();

    cacheReasoning(
      "call_provider_ds",
      "deepseek",
      "deepseek-chat",
      "DeepSeek reasoning",
      reasoningCacheContext
    );
    cacheReasoning(
      "call_provider_kimi",
      "kimi",
      "kimi-k2.5",
      "Kimi reasoning",
      reasoningCacheContext
    );

    assert.equal(clearReasoningCacheAll("deepseek"), 1);
    assert.equal(lookupReasoning("call_provider_ds", reasoningCacheContext), null);
    assert.equal(lookupReasoning("call_provider_kimi", reasoningCacheContext), "Kimi reasoning");
  });

  it("should cleanup expired reasoning (no-op when nothing expired)", () => {
    cacheReasoning(
      "call_cleanup_test",
      "deepseek",
      "deepseek-chat",
      "Not expired yet",
      reasoningCacheContext
    );
    const cleaned = cleanupReasoningCache();
    assert.equal(typeof cleaned, "number");
    // Entry should still be available since TTL is 2 hours
    assert.equal(lookupReasoning("call_cleanup_test", reasoningCacheContext), "Not expired yet");
  });

  it("should not return expired SQLite entries and cleanup should prune them", () => {
    clearReasoningCacheAll();
    setReasoningCache(
      storageKeyForTest("call_expired"),
      "deepseek",
      "deepseek-chat",
      "Expired reasoning",
      -1_000
    );

    assert.equal(lookupReasoning("call_expired", reasoningCacheContext), null);
    assert.equal(cleanupReasoningCache(), 1);
    assert.equal(getReasoningCacheServiceStats().dbEntries, 0);
  });

  it("should read v2 storage rows with legacy ISO expires_at values", () => {
    clearReasoningCacheAll();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    getDbInstance()
      .prepare(
        `INSERT INTO reasoning_cache
         (tool_call_id, provider, model, reasoning, char_count, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'), ?)`
      )
      .run(
        storageKeyForTest("call_v2_iso_active"),
        "deepseek",
        "deepseek-v4-pro",
        "V2 ISO reasoning",
        "V2 ISO reasoning".length,
        expiresAt
      );

    assert.equal(lookupReasoning("call_v2_iso_active", reasoningCacheContext), "V2 ISO reasoning");
    assert.equal(getReasoningCacheServiceStats().memoryEntries, 1);
    assert.equal(cleanupReasoningCache(), 0);
  });

  it("should ignore legacy raw ISO rows for replay and still prune expired rows", () => {
    clearReasoningCacheAll();

    const db = getDbInstance();
    const futureIso = new Date(Date.now() + 60_000).toISOString();
    const expiredIso = new Date(Date.now() - 60_000).toISOString();
    db.prepare(
      `INSERT INTO reasoning_cache
         (tool_call_id, provider, model, reasoning, char_count, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'), ?)`
    ).run(
      "call_legacy_iso_active",
      "deepseek",
      "deepseek-chat",
      "Legacy ISO reasoning",
      "Legacy ISO reasoning".length,
      futureIso
    );
    db.prepare(
      `INSERT INTO reasoning_cache
         (tool_call_id, provider, model, reasoning, char_count, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'), ?)`
    ).run(
      "call_legacy_iso_expired",
      "deepseek",
      "deepseek-chat",
      "Expired legacy ISO reasoning",
      "Expired legacy ISO reasoning".length,
      expiredIso
    );

    assert.equal(lookupReasoning("call_legacy_iso_active", reasoningCacheContext), null);
    assert.equal(getReasoningCache("call_legacy_iso_active")?.reasoning, "Legacy ISO reasoning");
    assert.equal(getReasoningCacheServiceStats().memoryEntries, 0);
    assert.equal(lookupReasoning("call_legacy_iso_expired", reasoningCacheContext), null);
    const entries = getReasoningCacheServiceEntries({ provider: "deepseek" }) as Array<{
      toolCallId: string;
      expiresAt: string;
    }>;
    assert.equal(
      entries.some((entry) => entry.expiresAt === futureIso),
      true
    );
    assert.equal(cleanupReasoningCache(), 1);
  });
});

describe("Reasoning Replay Cache — Provider Detection", () => {
  it("should detect deepseek as requiring replay", () => {
    assert.equal(requiresReasoningReplay({ provider: "deepseek", model: "deepseek-chat" }), true);
  });

  it("should detect opencode-go as requiring replay", () => {
    assert.equal(requiresReasoningReplay({ provider: "opencode-go", model: "some-model" }), true);
  });

  it("should not replay legacy deepseek-r1 even under replay providers", () => {
    assert.equal(requiresReasoningReplay({ provider: "siliconflow", model: "deepseek-r1" }), false);
  });

  it("should not replay deepseek-r1 model pattern", () => {
    assert.equal(
      requiresReasoningReplay({ provider: "unknown-provider", model: "deepseek-r1" }),
      false
    );
  });

  it("should detect deepseek-reasoner model pattern", () => {
    assert.equal(
      requiresReasoningReplay({ provider: "unknown-provider", model: "deepseek-reasoner" }),
      false
    );
  });

  it("should detect DeepSeek V4 model pattern", () => {
    assert.equal(
      requiresReasoningReplay({ provider: "unknown-provider", model: "deepseek/v4-pro" }),
      true
    );
  });

  it("should detect DeepSeek V4 thinking mode explicitly", () => {
    assert.equal(
      isDeepSeekReasoningModel({
        provider: "unknown-provider",
        model: "deepseek-v4.flash",
        thinkingEnabled: true,
      }),
      true
    );
  });

  it("should NOT detect DeepSeek V4 when thinking mode is disabled", () => {
    assert.equal(
      isDeepSeekReasoningModel({
        provider: "unknown-provider",
        model: "deepseek-v4.flash",
        thinkingEnabled: false,
      }),
      false
    );
  });

  it("should detect kimi-k2 model pattern", () => {
    assert.equal(
      requiresReasoningReplay({ provider: "unknown-provider", model: "kimi-k2.5" }),
      true
    );
  });

  it("should detect qwq model pattern", () => {
    assert.equal(
      requiresReasoningReplay({ provider: "unknown-provider", model: "qwq-32b-preview" }),
      true
    );
  });

  it("should detect qwen-thinking model pattern", () => {
    assert.equal(
      requiresReasoningReplay({ provider: "unknown-provider", model: "qwen3-thinking-235b" }),
      true
    );
  });

  it("should detect GLM thinking model pattern", () => {
    assert.equal(requiresReasoningReplay({ provider: "glm", model: "glm-5-thinking" }), true);
  });

  it("should detect xiaomi-mimo provider", () => {
    // MiMo enforces reasoning_content echo on subsequent turns; without
    // replay the upstream returns 400 "Param Incorrect: The reasoning_content
    // in the thinking mode must be passed back to the API."
    assert.equal(
      requiresReasoningReplay({ provider: "xiaomi-mimo", model: "mimo-v2.5-pro" }),
      true
    );
    assert.equal(requiresReasoningReplay({ provider: "XIAOMI-MIMO", model: "mimo-v2.5" }), true);
  });

  it("should detect mimo-v* model pattern under any provider id", () => {
    assert.equal(
      requiresReasoningReplay({ provider: "unknown-provider", model: "mimo-v2.5-pro" }),
      true
    );
    assert.equal(requiresReasoningReplay({ provider: "unknown-provider", model: "mimo-v3" }), true);
    assert.equal(
      requiresReasoningReplay({ provider: "unknown-provider", model: "MimoV2.5-pro" }),
      true
    );
  });

  it("should NOT detect a generic openai model", () => {
    assert.equal(requiresReasoningReplay({ provider: "openai", model: "gpt-4o" }), false);
  });

  it("should NOT detect claude as requiring replay", () => {
    assert.equal(requiresReasoningReplay({ provider: "anthropic", model: "claude-opus-4" }), false);
  });
});

describe("Reasoning Replay Cache — Translator Replay", () => {
  before(() => {
    clearReasoningCacheAll();
    clearModelsDevCapabilities();
  });

  after(() => {
    clearReasoningCacheAll();
    clearModelsDevCapabilities();
  });

  function translateWithToolHistory(provider: string, model: string, callId: string) {
    return translateRequest(
      FORMATS.OPENAI,
      FORMATS.OPENAI,
      model,
      {
        messages: [
          { role: "user", content: "use a tool" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: callId, type: "function", function: { name: "read_file", arguments: "{}" } },
            ],
          },
          { role: "tool", tool_call_id: callId, content: "tool result" },
        ],
      },
      false,
      null,
      provider,
      null,
      { reasoningCacheContext }
    );
  }

  it("should inject cached reasoning for DeepSeek instead of empty fallback", () => {
    clearReasoningCacheAll();
    clearModelsDevCapabilities();
    saveModelsDevCapabilities({
      deepseek: {
        "deepseek-reasoner": buildCapability({
          interleaved_field: "reasoning_content",
          reasoning: true,
          tool_call: true,
        }),
      },
    });
    cacheReasoning(
      "call_translate_ds",
      "deepseek",
      "deepseek-reasoner",
      "DeepSeek cached plan",
      reasoningCacheContext
    );

    const translated = translateWithToolHistory(
      "deepseek",
      "deepseek-reasoner",
      "call_translate_ds"
    );

    assert.equal(translated.messages[1].reasoning_content, "DeepSeek cached plan");
    assert.equal(getReasoningCacheServiceStats().replays, 1);
  });

  it("should replay cached DeepSeek reasoning before Chat converts to Responses input", () => {
    clearReasoningCacheAll();
    clearModelsDevCapabilities();
    const callId = "call_ds_chat_to_responses";
    cacheReasoning(
      callId,
      "deepseek",
      "deepseek-v4-flash",
      "Cached Chat continuation reasoning",
      reasoningCacheContext
    );

    const translated = translateRequest(
      FORMATS.OPENAI,
      FORMATS.OPENAI_RESPONSES,
      "deepseek-v4-flash",
      {
        reasoning_effort: "high",
        messages: [
          { role: "user", content: "Use the tool" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: callId,
                type: "function",
                function: { name: "read_file", arguments: "{}" },
              },
            ],
          },
          { role: "tool", tool_call_id: callId, content: "contents" },
        ],
      },
      false,
      null,
      "deepseek",
      null,
      { reasoningCacheContext }
    );

    assert.deepEqual(
      translated.input.find((item) => item.type === "reasoning"),
      {
        type: "reasoning",
        content: [{ type: "reasoning_text", text: "Cached Chat continuation reasoning" }],
        summary: [],
      }
    );
  });

  it("should preserve DeepSeek Responses reasoning before Chat conversion", () => {
    clearReasoningCacheAll();
    clearModelsDevCapabilities();
    cacheReasoning(
      "call_ds_responses",
      "deepseek",
      "deepseek-v4-flash",
      "Conflicting cached reasoning",
      reasoningCacheContext
    );
    const statsBeforeTranslation = getReasoningCacheServiceStats();

    const translated = translateRequest(
      FORMATS.OPENAI_RESPONSES,
      FORMATS.OPENAI,
      "deepseek-v4-flash",
      {
        reasoning: { effort: "high" },
        input: [
          {
            type: "reasoning",
            content: [{ type: "reasoning_text", text: "Client DeepSeek reasoning" }],
          },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "I will inspect" }],
          },
          {
            type: "function_call",
            call_id: "call_ds_responses",
            name: "read_file",
            arguments: "{}",
          },
          { type: "function_call_output", call_id: "call_ds_responses", output: "contents" },
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Continue" }],
          },
        ],
      },
      false,
      null,
      "deepseek",
      null,
      { reasoningCacheContext }
    );

    const assistant = translated.messages.find((message) => message.role === "assistant");
    assert.equal(assistant.reasoning_content, "Client DeepSeek reasoning");
    assert.equal(assistant.content[0].text, "I will inspect");
    assert.equal(assistant.tool_calls[0].id, "call_ds_responses");
    const statsAfterTranslation = getReasoningCacheServiceStats();
    assert.equal(statsAfterTranslation.hits, statsBeforeTranslation.hits);
    assert.equal(statsAfterTranslation.misses, statsBeforeTranslation.misses);
    assert.equal(statsAfterTranslation.replays, statsBeforeTranslation.replays);
  });

  it("should cache only authentic plaintext from nonstream Responses output", () => {
    clearReasoningCacheAll();
    const callId = "call_nonstream_authentic_reasoning";
    const translated = translateNonStreamingResponse(
      {
        object: "response",
        model: "deepseek-v4-flash",
        output: [
          {
            type: "reasoning",
            content: [{ type: "reasoning_text", text: "Authentic provider reasoning" }],
            summary: [{ type: "summary_text", text: "Display summary" }],
          },
          { type: "function_call", call_id: callId, name: "read_file", arguments: "{}" },
        ],
      },
      FORMATS.OPENAI_RESPONSES,
      FORMATS.OPENAI
    ) as { choices?: Array<{ message?: Record<string, unknown> }> };
    const message = translated.choices?.[0]?.message;

    assert.ok(message);
    assert.equal(message.reasoning_content, "Authentic provider reasoning");
    assert.equal(
      cacheReasoningFromAssistantMessage(
        message,
        "deepseek",
        "deepseek-v4-flash",
        reasoningCacheContext
      ),
      1
    );
    assert.equal(lookupReasoning(callId, reasoningCacheContext), "Authentic provider reasoning");
  });

  it("preserves plaintext reasoning from a mixed plaintext + encrypted_content item (#10949)", () => {
    clearReasoningCacheAll();
    const callId = "call_nonstream_mixed_reasoning";
    const translated = translateNonStreamingResponse(
      {
        object: "response",
        model: "deepseek-v4-flash",
        output: [
          {
            type: "reasoning",
            content: [
              {
                type: "reasoning_text",
                text: "Let me start by reading the directory to understand the structure of the corpus.",
              },
            ],
            encrypted_content: "<opaque state>",
            summary: [],
          },
          { type: "function_call", call_id: callId, name: "read_file", arguments: "{}" },
        ],
      },
      FORMATS.OPENAI_RESPONSES,
      FORMATS.OPENAI
    ) as { choices?: Array<{ message?: Record<string, unknown> }> };
    const message = translated.choices?.[0]?.message;

    assert.ok(message);
    assert.equal(
      message.reasoning_content,
      "Let me start by reading the directory to understand the structure of the corpus."
    );
    assert.equal(
      cacheReasoningFromAssistantMessage(
        message,
        "deepseek",
        "deepseek-v4-flash",
        reasoningCacheContext
      ),
      1
    );
    assert.equal(
      lookupReasoning(callId, reasoningCacheContext),
      "Let me start by reading the directory to understand the structure of the corpus."
    );
  });

  it("should never cache summary-only Responses reasoning", () => {
    clearReasoningCacheAll();
    const callId = "call_nonstream_summary_reasoning";
    const translated = translateNonStreamingResponse(
      {
        object: "response",
        model: "deepseek-v4-flash",
        output: [
          {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "Display-only summary" }],
          },
          { type: "function_call", call_id: callId, name: "read_file", arguments: "{}" },
        ],
      },
      FORMATS.OPENAI_RESPONSES,
      FORMATS.OPENAI
    ) as { choices?: Array<{ message?: Record<string, unknown> }> };
    const message = translated.choices?.[0]?.message;

    assert.ok(message);
    assert.equal(message.reasoning_content, undefined);
    assert.ok(Array.isArray(message.reasoning_summary));
    assert.equal(
      cacheReasoningFromAssistantMessage(
        message,
        "deepseek",
        "deepseek-v4-flash",
        reasoningCacheContext
      ),
      0
    );
    assert.equal(lookupReasoning(callId, reasoningCacheContext), null);
  });

  it("should preserve client-provided reasoning content", () => {
    clearReasoningCacheAll();
    clearModelsDevCapabilities();
    saveModelsDevCapabilities({
      deepseek: {
        "deepseek-reasoner": buildCapability({
          interleaved_field: "reasoning_content",
          reasoning: true,
          tool_call: true,
        }),
      },
    });
    cacheReasoning(
      "call_preserve",
      "deepseek",
      "deepseek-reasoner",
      "Cached reasoning",
      reasoningCacheContext
    );
    const statsBeforeTranslation = getReasoningCacheServiceStats();

    const translated = translateRequest(
      FORMATS.OPENAI,
      FORMATS.OPENAI,
      "deepseek-reasoner",
      {
        messages: [
          { role: "user", content: "use a tool" },
          {
            role: "assistant",
            content: null,
            reasoning_content: "Client reasoning",
            tool_calls: [
              {
                id: "call_preserve",
                type: "function",
                function: { name: "tool", arguments: "{}" },
              },
            ],
          },
        ],
      },
      false,
      null,
      "deepseek",
      null,
      { reasoningCacheContext }
    );

    assert.equal(translated.messages[1].reasoning_content, "Client reasoning");
    assert.equal(getReasoningCacheServiceStats().replays, 0);
    const statsAfterTranslation = getReasoningCacheServiceStats();
    assert.equal(statsAfterTranslation.hits, statsBeforeTranslation.hits);
    assert.equal(statsAfterTranslation.misses, statsBeforeTranslation.misses);
  });

  it("should inject cached reasoning for Qwen and GLM thinking models", () => {
    clearReasoningCacheAll();
    clearModelsDevCapabilities();
    saveModelsDevCapabilities({
      qwen: {
        "qwen3-thinking-235b": buildCapability({
          interleaved_field: "reasoning_content",
          reasoning: true,
          tool_call: true,
        }),
      },
      glm: {
        "glm-5-thinking": buildCapability({
          interleaved_field: "reasoning_content",
          reasoning: true,
          tool_call: true,
        }),
      },
    });
    cacheReasoning(
      "call_qwen_think",
      "qwen",
      "qwen3-thinking-235b",
      "Qwen cached plan",
      reasoningCacheContext
    );
    cacheReasoning(
      "call_glm_think",
      "glm",
      "glm-5-thinking",
      "GLM cached plan",
      reasoningCacheContext
    );

    const qwen = translateWithToolHistory("qwen", "qwen3-thinking-235b", "call_qwen_think");
    const glm = translateWithToolHistory("glm", "glm-5-thinking", "call_glm_think");

    assert.equal(qwen.messages[1].reasoning_content, "Qwen cached plan");
    assert.equal(glm.messages[1].reasoning_content, "GLM cached plan");
    assert.equal(getReasoningCacheServiceStats().replays, 2);
  });

  it("should not inject reasoning_content for generic non-reasoning providers", () => {
    clearReasoningCacheAll();
    clearModelsDevCapabilities();
    cacheReasoning("call_openai", "openai", "gpt-4o", "Should not replay", reasoningCacheContext);

    const translated = translateWithToolHistory("openai", "gpt-4o", "call_openai");

    assert.equal(translated.messages[1].reasoning_content, undefined);
    assert.equal(getReasoningCacheServiceStats().replays, 0);
  });

  it("should support the full capture then replay flow", () => {
    clearReasoningCacheAll();
    clearModelsDevCapabilities();
    saveModelsDevCapabilities({
      deepseek: {
        "deepseek-reasoner": buildCapability({
          interleaved_field: "reasoning_content",
          reasoning: true,
          tool_call: true,
        }),
      },
    });

    const captured = cacheReasoningFromAssistantMessage(
      {
        role: "assistant",
        reasoning_content: "Full flow cached plan",
        tool_calls: [{ id: "call_full_flow", type: "function" }],
      },
      "deepseek",
      "deepseek-reasoner",
      reasoningCacheContext
    );

    const translated = translateWithToolHistory("deepseek", "deepseek-reasoner", "call_full_flow");

    assert.equal(captured, 1);
    assert.equal(translated.messages[1].reasoning_content, "Full flow cached plan");
    assert.equal(getReasoningCacheServiceStats().replays, 1);
  });

  it("should strip reasoning_content when model has no interleaved replay signal", () => {
    clearReasoningCacheAll();
    clearModelsDevCapabilities();

    const translated = translateRequest(
      FORMATS.OPENAI,
      FORMATS.OPENAI,
      "deepseek-reasoner",
      {
        messages: [
          { role: "user", content: "hello" },
          {
            role: "assistant",
            content: "ok",
            reasoning_content: "should be stripped",
          },
        ],
      },
      false,
      null,
      "deepseek",
      null,
      { reasoningCacheContext }
    );

    assert.equal(translated.messages[1].reasoning_content, undefined);
  });

  it("should not inject reasoning_content when interleaved field is reasoning_details", () => {
    clearReasoningCacheAll();
    clearModelsDevCapabilities();
    saveModelsDevCapabilities({
      testprovider: {
        "test-reasoning-details": buildCapability({
          interleaved_field: "reasoning_details",
          reasoning: true,
          tool_call: true,
        }),
      },
    });
    cacheReasoning(
      "call_details",
      "testprovider",
      "test-reasoning-details",
      "cached",
      reasoningCacheContext
    );

    const translated = translateWithToolHistory(
      "testprovider",
      "test-reasoning-details",
      "call_details"
    );

    assert.equal(translated.messages[1].reasoning_content, undefined);
  });

  it("should drop empty-string reasoning_content on cache miss", async () => {
    // Regression: injectEmptyReasoningContentForToolCalls (schemaCoercion.ts) pre-sets
    // reasoning_content="" before the cache lookup, and DeepSeek V4+ rejects "" with a
    // 400 — so the empty string must not survive the miss. #9573/#9610 replaced the
    // former NON_ANTHROPIC_THINKING_PLACEHOLDER injection with omitting the field: the
    // placeholder was echoed back by the model as its own reasoning (empty stop) and
    // re-poisoned cache + client history, while an ABSENT field is accepted.
    clearReasoningCacheAll();
    clearModelsDevCapabilities();
    saveModelsDevCapabilities({
      deepseek: {
        "deepseek-v4-flash": buildCapability({
          interleaved_field: "reasoning_content",
          reasoning: true,
          tool_call: true,
        }),
      },
    });

    // No cache entry → cache miss
    const translated = translateRequest(
      FORMATS.OPENAI,
      FORMATS.OPENAI,
      "deepseek-v4-flash",
      {
        messages: [
          { role: "user", content: "use a tool" },
          {
            role: "assistant",
            content: null,
            reasoning_content: "",
            tool_calls: [
              {
                id: "call_empty_rc",
                type: "function",
                function: { name: "read_file", arguments: "{}" },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_empty_rc", content: "file contents" },
        ],
      },
      false,
      null,
      "deepseek",
      null,
      { reasoningCacheContext }
    );

    assert.equal(
      translated.messages[1].reasoning_content,
      undefined,
      "empty reasoning_content should be dropped (not placeholder-filled) on cache miss"
    );
  });

  it("should omit reasoning_content for a plain (non-tool-call) DeepSeek turn missing it (#1682)", async () => {
    // Regression (#1682): a multi-turn text conversation where the prior assistant
    // turn has NO tool calls and the client (e.g. Cursor) stripped reasoning_content
    // from history. #9573/#9610 established that DeepSeek's 400 is specific to an
    // EMPTY-STRING reasoning_content, not an absent field — so the field is now
    // omitted here instead of carrying the self-poisoning placeholder.
    clearReasoningCacheAll();
    clearModelsDevCapabilities();
    saveModelsDevCapabilities({
      deepseek: {
        "deepseek-v4-pro": buildCapability({
          interleaved_field: "reasoning_content",
          reasoning: true,
          tool_call: true,
        }),
      },
    });

    const translated = translateRequest(
      FORMATS.OPENAI,
      FORMATS.OPENAI,
      "deepseek-v4-pro",
      {
        messages: [
          { role: "user", content: "hi" },
          // Plain assistant turn, no tool_calls, reasoning_content stripped by client.
          { role: "assistant", content: "Hello! How can I help?" },
          { role: "user", content: "tell me more" },
        ],
      },
      false,
      null,
      "deepseek",
      null,
      { reasoningCacheContext }
    );

    assert.equal(
      translated.messages[1].reasoning_content,
      undefined,
      "plain DeepSeek assistant turn missing reasoning_content should keep the field absent"
    );
  });

  it("should replay cached reasoning for a plain DeepSeek turn when available", () => {
    clearReasoningCacheAll();
    clearModelsDevCapabilities();
    saveModelsDevCapabilities({
      deepseek: {
        "deepseek-v4-pro": buildCapability({
          interleaved_field: "reasoning_content",
          reasoning: true,
          tool_call: true,
        }),
      },
    });
    const scope = "api-key:test:session:plain";
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "Hello! How can I help?" },
      { role: "user", content: "tell me more" },
    ];
    const cacheKey = buildAssistantMessageCacheKey(scope, messages, 1);
    cacheReasoning(
      cacheKey,
      "deepseek",
      "deepseek-v4-pro",
      "Real cached plain-turn reasoning",
      reasoningCacheContext
    );

    const translated = translateRequest(
      FORMATS.OPENAI,
      FORMATS.OPENAI,
      "deepseek-v4-pro",
      { messages },
      false,
      null,
      "deepseek",
      null,
      { reasoningCacheContext, reasoningCacheScope: scope }
    );

    assert.equal(translated.messages[1].reasoning_content, "Real cached plain-turn reasoning");
    assert.equal(getReasoningCacheServiceStats().replays, 1);
  });

  it("writes and reads the same no-tool transcript key for Chat history", () => {
    clearReasoningCacheAll();
    clearModelsDevCapabilities();
    saveModelsDevCapabilities({
      deepseek: {
        "deepseek-v4-pro": buildCapability({
          interleaved_field: "reasoning_content",
          reasoning: true,
          tool_call: true,
        }),
      },
    });
    const scope = "api-key:test:session:chat";
    const historyMessages = [{ role: "user", content: "hi" }];
    cacheReasoningFromAssistantMessage(
      { role: "assistant", content: "Hello! How can I help?", reasoning_content: "real reasoning" },
      "deepseek",
      "deepseek-v4-pro",
      reasoningCacheContext,
      { scope, historyMessages }
    );

    const translated = translateRequest(
      FORMATS.OPENAI,
      FORMATS.OPENAI,
      "deepseek-v4-pro",
      {
        messages: [
          ...historyMessages,
          { role: "assistant", content: "Hello! How can I help?" },
          { role: "user", content: "tell me more" },
        ],
      },
      false,
      null,
      "deepseek",
      null,
      { reasoningCacheContext, reasoningCacheScope: scope }
    );

    assert.equal(translated.messages[1].reasoning_content, "real reasoning");
    assert.equal(getReasoningCacheServiceStats().replays, 1);
  });

  it("writes a Chat response and replays it from Responses history", () => {
    clearReasoningCacheAll();
    clearModelsDevCapabilities();
    saveModelsDevCapabilities({
      deepseek: {
        "deepseek-v4-pro": buildCapability({
          interleaved_field: "reasoning_content",
          reasoning: true,
          tool_call: true,
        }),
      },
    });
    const scope = "api-key:test:session:responses";
    const historyMessages = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
    cacheReasoningFromAssistantMessage(
      { role: "assistant", content: "Hello! How can I help?", reasoning_content: "real reasoning" },
      "deepseek",
      "deepseek-v4-pro",
      reasoningCacheContext,
      { scope, historyMessages }
    );

    const translated = translateRequest(
      FORMATS.OPENAI_RESPONSES,
      FORMATS.OPENAI,
      "deepseek-v4-pro",
      {
        reasoning: { effort: "high" },
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Hello! How can I help?" }],
          },
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "tell me more" }],
          },
        ],
      },
      false,
      null,
      "deepseek",
      null,
      { reasoningCacheContext, reasoningCacheScope: scope }
    );

    assert.equal(translated.messages[1].reasoning_content, "real reasoning");
    assert.equal(getReasoningCacheServiceStats().replays, 1);
  });
});

describe("Reasoning Replay Cache — API Route", () => {
  let managementApiKey: string;

  before(() => {
    clearReasoningCacheAll();
  });

  before(async () => {
    const created = await createApiKey("reasoning-cache-route-test", "machine-reasoning", [
      "manage",
    ]);
    managementApiKey = created.key;
  });

  after(() => {
    clearReasoningCacheAll();
  });

  function authedRequest(url: string): Request {
    return new Request(url, {
      headers: { authorization: `Bearer ${managementApiKey}` },
    });
  }

  it("should return stats and entries from GET", async () => {
    clearReasoningCacheAll();
    cacheReasoning(
      "call_api_get",
      "deepseek",
      "deepseek-reasoner",
      "API visible reasoning",
      reasoningCacheContext
    );

    const response = await GET(
      authedRequest("http://localhost/api/cache/reasoning?provider=deepseek") as never
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.stats.dbEntries, 1);
    assert.equal(body.entries.length, 1);
    assert.equal(body.entries[0].toolCallId, storageKeyForTest("call_api_get"));
    assert.match(body.entries[0].toolCallId, /^rc2h:[0-9a-f]{64}$/);
  });

  it("should delete a single entry by the opaque toolCallId returned by GET", async () => {
    clearReasoningCacheAll();
    cacheReasoning(
      "call_api_delete_1",
      "deepseek",
      "deepseek-reasoner",
      "Delete API",
      reasoningCacheContext
    );
    cacheReasoning(
      "call_api_delete_2",
      "deepseek",
      "deepseek-reasoner",
      "Keep API",
      reasoningCacheContext
    );

    const listResponse = await GET(authedRequest("http://localhost/api/cache/reasoning") as never);
    const listing = await listResponse.json();
    assert.equal(listResponse.status, 200);
    const entry = (listing.entries as Array<{ toolCallId: string }>).find(
      (item) => item.toolCallId === storageKeyForTest("call_api_delete_1")
    );
    assert.ok(entry);
    assert.match(entry.toolCallId, /^rc2h:[0-9a-f]{64}$/);
    const url = new URL("http://localhost/api/cache/reasoning");
    url.searchParams.set("toolCallId", entry.toolCallId);

    const response = await DELETE(authedRequest(url.toString()) as never);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.scope, "toolCallId");
    assert.equal(body.cleared, 1);
    assert.equal(lookupReasoning("call_api_delete_1", reasoningCacheContext), null);
    assert.equal(lookupReasoning("call_api_delete_2", reasoningCacheContext), "Keep API");
  });

  it("should reject raw and malformed storage IDs without deleting cached reasoning", async () => {
    clearReasoningCacheAll();
    cacheReasoning(
      "call_api_raw_delete",
      "deepseek",
      "deepseek-v4-pro",
      "Keep scoped reasoning",
      reasoningCacheContext
    );

    for (const id of ["call_api_raw_delete", "rc2h:123", `rc2h:${"A".repeat(64)}`]) {
      const url = new URL("http://localhost/api/cache/reasoning");
      url.searchParams.set("toolCallId", id);
      const response = await DELETE(authedRequest(url.toString()) as never);
      assert.equal(response.status, 400, id);
      assert.equal(
        lookupReasoning("call_api_raw_delete", reasoningCacheContext),
        "Keep scoped reasoning"
      );
    }
  });

  it("should reject an empty toolCallId without clearing the cache", async () => {
    clearReasoningCacheAll();
    cacheReasoning(
      "call_api_empty_delete",
      "deepseek",
      "deepseek-v4-pro",
      "Keep reasoning after empty delete",
      reasoningCacheContext
    );

    const response = await DELETE(
      authedRequest("http://localhost/api/cache/reasoning?toolCallId=") as never
    );

    assert.equal(response.status, 400);
    assert.equal(
      lookupReasoning("call_api_empty_delete", reasoningCacheContext),
      "Keep reasoning after empty delete"
    );
    assert.equal(getReasoningCacheServiceStats().dbEntries, 1);
  });

  it("should delete entries by provider", async () => {
    clearReasoningCacheAll();
    cacheReasoning(
      "call_api_provider_ds",
      "deepseek",
      "deepseek-reasoner",
      "Delete provider",
      reasoningCacheContext
    );
    cacheReasoning(
      "call_api_provider_kimi",
      "kimi",
      "kimi-k2.5",
      "Keep provider",
      reasoningCacheContext
    );

    const response = await DELETE(
      authedRequest("http://localhost/api/cache/reasoning?provider=deepseek") as never
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.scope, "provider");
    assert.equal(body.cleared, 1);
    assert.equal(lookupReasoning("call_api_provider_ds", reasoningCacheContext), null);
    assert.equal(lookupReasoning("call_api_provider_kimi", reasoningCacheContext), "Keep provider");
  });
});
