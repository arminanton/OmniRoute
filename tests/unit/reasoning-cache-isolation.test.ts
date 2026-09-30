import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReasoningCacheContext } from "../../open-sse/services/reasoningCacheContext.ts";

const dataDir = mkdtempSync(join(tmpdir(), "omniroute-reasoning-isolation-"));
process.env.DATA_DIR = dataDir;
Object.assign(process.env, { NODE_ENV: "test" });
process.env.API_KEY_SECRET = "reasoning-isolation-test-server-secret";
const cache = await import("../../open-sse/services/reasoningCache.ts");
const { createReasoningCacheKeyContext, createLocalReasoningCacheContext } =
  await import("../../open-sse/services/reasoningCacheContext.ts");
const dbCache = await import("../../src/lib/db/reasoningCache.ts");
const { getDbInstance, resetDbInstance } = await import("../../src/lib/db/core.ts");
const { createApiKey } = await import("../../src/lib/db/apiKeys.ts");
const keyA = await createApiKey("reasoning A", "reasoning-test");
const keyB = await createApiKey("reasoning B", "reasoning-test");
const a = createReasoningCacheKeyContext(keyA.key);
const b = createReasoningCacheKeyContext(keyB.key);
const local = createLocalReasoningCacheContext();
assert.ok(a && b && local);

beforeEach(() => cache.clearReasoningCacheAll());
after(() => {
  cache.clearReasoningCacheAll();
  resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

function put(id: string, reasoning: string, context: ReasoningCacheContext | null = a) {
  cache.cacheReasoning(id, "deepseek", "deepseek-v4-pro", reasoning, context);
}
function storedId(reasoning: string) {
  const entry = dbCache
    .getReasoningCacheEntries({ limit: 200 })
    .find((entry) => entry.reasoning === reasoning);
  assert.ok(entry);
  assert.match(entry.toolCallId, /^rc2h:[a-f0-9]{64}$/);
  return entry.toolCallId;
}

// Force genuine SQLite fallback without adding a service-facing raw-key API.
function evictHotEntries() {
  for (let i = 0; i < 205; i++) put(`evict-${i}`, `filler-${i}`);
  assert.equal(cache.getReasoningCacheServiceStats().memoryEntries, 200);
}

describe("reasoning cache principal isolation", () => {
  it("isolates two DB keys with the same tool ID in memory and after eviction", () => {
    put("shared-tool", "A private reasoning", a);
    assert.equal(cache.lookupReasoning("shared-tool", b), null);
    put("shared-tool", "B private reasoning", b);
    assert.equal(cache.lookupReasoning("shared-tool", a), "A private reasoning");
    assert.equal(cache.lookupReasoning("shared-tool", b), "B private reasoning");
    assert.equal(cache.lookupReasoning("shared-tool", local), null);
    assert.equal(dbCache.getReasoningCache("shared-tool"), null);
    evictHotEntries();
    assert.equal(cache.lookupReasoning("shared-tool", a), "A private reasoning");
    assert.equal(cache.lookupReasoning("shared-tool", b), "B private reasoning");
    assert.equal(cache.getReasoningCacheServiceStats().memoryEntries, 200);
    assert.equal(cache.deleteReasoningCacheEntry("shared-tool", b), 1);
    assert.equal(cache.lookupReasoning("shared-tool", a), "A private reasoning");
    assert.equal(cache.lookupReasoning("shared-tool", b), null);
  });

  it("separates explicit no-key local mode and actual credential rotations", () => {
    put("shared-tool", "local-only", local);
    assert.equal(cache.lookupReasoning("shared-tool", a), null);
    put("shared-tool", "key-only", a);
    assert.equal(cache.lookupReasoning("shared-tool", local), "local-only");
    const sameKey = createReasoningCacheKeyContext(keyA.key);
    assert.equal(cache.lookupReasoning("shared-tool", sameKey), "key-only");
    const oldEnv = createReasoningCacheKeyContext("synthetic-env-key-before");
    const newEnv = createReasoningCacheKeyContext("synthetic-env-key-after");
    put("rotated", "former env credential", oldEnv);
    assert.equal(cache.lookupReasoning("rotated", newEnv), null);
  });

  it("isolates storage across server-secret rotation without migrating old reasoning", () => {
    put("secret-rotation", "old server secret reasoning", a);
    const secret = process.env.API_KEY_SECRET;
    try {
      process.env.API_KEY_SECRET = "second-fabricated-server-secret";
      const rotated = createReasoningCacheKeyContext(keyA.key);
      assert.ok(rotated);
      assert.equal(cache.lookupReasoning("secret-rotation", rotated), null);
      assert.equal(cache.lookupReasoning("secret-rotation", a), null);
      put("secret-rotation", "new server secret reasoning", rotated);
      assert.equal(
        cache.lookupReasoning("secret-rotation", rotated),
        "new server secret reasoning"
      );
    } finally {
      process.env.API_KEY_SECRET = secret;
    }
    assert.equal(cache.lookupReasoning("secret-rotation", a), "old server secret reasoning");
    assert.equal(dbCache.getReasoningCacheEntries().length, 2);
  });

  it("fails closed for absent, disabled and forged contexts on every service API", () => {
    put("known", "private");
    const forged = { kind: "key", fingerprint: a.kind === "key" ? a.fingerprint : "" };
    for (const context of [null, undefined, forged, { kind: "local" }]) {
      const untrusted = context as ReasoningCacheContext | null;
      assert.equal(cache.lookupReasoning("known", untrusted), null);
      cache.cacheReasoning("known", "deepseek", "model", "poison", untrusted);
      cache.cacheReasoningByKey("known", "deepseek", "model", "poison", untrusted);
      cache.cacheReasoningBatch(["known"], "deepseek", "model", "poison", untrusted);
      assert.equal(
        cache.cacheReasoningFromAssistantMessage(
          { role: "assistant", reasoning_content: "poison", tool_calls: [{ id: "known" }] },
          "deepseek",
          "model",
          untrusted
        ),
        0
      );
      assert.equal(cache.deleteReasoningCacheEntry("known", untrusted), 0);
      assert.equal(cache.lookupReasoning("known", a), "private");
    }
    const secret = process.env.API_KEY_SECRET;
    try {
      delete process.env.API_KEY_SECRET;
      assert.equal(cache.lookupReasoning("known", a), null);
      put("known", "missing-secret poison");
      assert.equal(cache.deleteReasoningCacheEntry("known", a), 0);
      assert.equal(createLocalReasoningCacheContext(), null);
      assert.equal(createReasoningCacheKeyContext(keyA.key), null);
    } finally {
      process.env.API_KEY_SECRET = secret;
    }
    assert.equal(cache.lookupReasoning("known", a), "private");
  });

  it("never uses client text as a raw or precomputed storage key", () => {
    put("known", "victim reasoning");
    const opaque = storedId("victim reasoning");
    for (const id of [
      opaque,
      "rc2h:" + "a".repeat(64),
      "conversation:arbitrary",
      "api-key:local",
      "a\x1fb:c",
      "a:b\x1fc",
      "工具-🧠",
      "x".repeat(20_000),
      " spaced ",
      "spaced",
    ]) {
      assert.equal(cache.lookupReasoning(id, b), null);
      put(id, "attacker-controlled", b);
      assert.equal(cache.lookupReasoning(id, b), "attacker-controlled");
      assert.equal(cache.lookupReasoning(id, a), null);
    }
    assert.equal(cache.lookupReasoning("known", a), "victim reasoning");
    assert.equal(cache.lookupReasoning(opaque, a), null);
    assert.equal(cache.deleteReasoningCacheEntry(opaque, a), 0);
    // B may delete B's logical ID with this spelling, but never A's storage row.
    assert.equal(cache.deleteReasoningCacheEntry(opaque, b), 1);
    assert.equal(cache.lookupReasoning("known", a), "victim reasoning");
    assert.equal(cache.deleteReasoningCacheStorageEntryForAdmin("known"), 0);
    assert.equal(cache.deleteReasoningCacheStorageEntryForAdmin(opaque), 1);
    assert.equal(cache.lookupReasoning("known", a), null);
  });

  it("ignores live legacy raw rows for keys and local and still sweeps expired rows", () => {
    dbCache.setReasoningCache("legacy-id", "deepseek", "model", "legacy secret");
    for (const context of [a, b, local]) {
      assert.equal(cache.lookupReasoning("legacy-id", context), null);
      assert.equal(cache.deleteReasoningCacheEntry("legacy-id", context), 0);
    }
    assert.equal(dbCache.getReasoningCache("legacy-id")?.reasoning, "legacy secret");
    dbCache.setReasoningCache("expired-legacy", "deepseek", "model", "expired", -1_000);
    assert.equal(cache.cleanupReasoningCache(), 1);
    assert.equal(cache.clearReasoningCacheAll("deepseek"), 1);
  });

  it("scopes no-tool transcripts to principal and session without fallback", () => {
    const history = [{ role: "user", content: "hello" }];
    const message = { role: "assistant", content: "answer", reasoning_content: "plain private" };
    assert.equal(
      cache.cacheReasoningFromAssistantMessage(message, "deepseek", "model", a, {
        scope: "session-one",
        historyMessages: history,
      }),
      1
    );
    const logical = cache.buildAssistantMessageCacheKey("session-one", [...history, message], 1);
    assert.equal(cache.lookupReasoning(logical, a), "plain private");
    assert.equal(cache.lookupReasoning(logical, b), null);
    const other = cache.buildAssistantMessageCacheKey("session-two", [...history, message], 1);
    assert.equal(cache.lookupReasoning(other, a), null);
    assert.equal(cache.cacheReasoningFromAssistantMessage(message, "deepseek", "model", a), 0);
  });

  it("keeps short persisted TTL on promotion and refuses expired/placeholder DB rows", () => {
    put("ttl", "short-lived");
    const opaque = storedId("short-lived");
    evictHotEntries();
    dbCache.setReasoningCache(opaque, "deepseek", "model", "short-lived", 3_000);
    assert.equal(cache.lookupReasoning("ttl", a), "short-lived");
    dbCache.deleteReasoningCache(opaque);
    const realNow = Date.now;
    try {
      const later = realNow() + 4_000;
      Date.now = () => later;
      assert.equal(cache.lookupReasoning("ttl", a), null);
    } finally {
      Date.now = realNow;
    }
    dbCache.setReasoningCache(opaque, "deepseek", "model", "expired", -1_000);
    assert.equal(cache.lookupReasoning("ttl", a), null);
    dbCache.setReasoningCache(opaque, "deepseek", "model", "temporarily valid");
    getDbInstance()
      .prepare("UPDATE reasoning_cache SET reasoning = ? WHERE tool_call_id = ?")
      .run("(prior reasoning summary unavailable)", opaque);
    assert.equal(cache.lookupReasoning("ttl", a), null);
    assert.equal(cache.getReasoningCacheServiceStats().memoryEntries, 199);
  });
});

it("translator management preview never reads inference or local replay", async () => {
  const { POST } = await import("../../src/app/api/translator/translate/route.ts");
  put("preview-id", "key-only-preview-private", a);
  put("preview-id", "local-only-preview-private", local);
  const body = {
    model: "deepseek-v4-pro",
    reasoningCacheContext: a,
    messages: [
      { role: "user", content: "use tool" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "preview-id", type: "function", function: { name: "lookup", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "preview-id", content: "ok" },
    ],
  };
  for (const step of ["direct", 2, 3]) {
    const response = await POST(
      new Request("http://localhost/api/translator/translate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          step,
          provider: "deepseek",
          sourceFormat: "openai",
          targetFormat: "openai",
          body,
        }),
      })
    );
    assert.equal(response.status, 200);
    const result = await response.text();
    assert.ok(!result.includes("key-only-preview-private"));
    assert.ok(!result.includes("local-only-preview-private"));
  }
});

it("GLM secondary Anthropic conversion never restores cached reasoning", async () => {
  const { GlmExecutor } = await import("../../open-sse/executors/glm.ts");
  put("glm-secondary-id", "glm-key-private", a);
  put("glm-secondary-id", "glm-local-private", local);
  const executor = new GlmExecutor("glm");
  const transformed = executor.transformForTransport(
    "glm-5-thinking",
    {
      reasoningCacheContext: a,
      messages: [
        { role: "user", content: "use tool" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "glm-secondary-id",
              type: "function",
              function: { name: "lookup", arguments: "{}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "glm-secondary-id", content: "ok" },
      ],
    },
    false,
    { apiKey: "synthetic-upstream-key" },
    "anthropic"
  );
  const serialized = JSON.stringify(transformed);
  assert.ok(!serialized.includes("glm-key-private"));
  assert.ok(!serialized.includes("glm-local-private"));
});
