import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-quota-fill-first-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const coreDb = await import("../../src/lib/db/core.ts");
const dbProviders = await import("../../src/lib/db/providers.ts");
const quotaCache = await import("../../src/domain/quotaCache.ts");
const auth = await import("../../src/sse/services/auth.ts");
const familyCooldown = await import(
  "@omniroute/open-sse/services/antigravityFamilyCooldown.ts"
);

test.after(() => {
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("isAntigravityFamilyUnavailable correctly discriminates Gemini vs Claude families", () => {
  const inFuture = new Date(Date.now() + 60_000).toISOString();
  const conn = {
    providerSpecificData: {
      antigravityFamilyRateLimitedUntil: {
        gemini: inFuture,
      },
    },
  };

  assert.equal(
    familyCooldown.isAntigravityFamilyUnavailable(conn, "agy/gemini-3.8-flash-high"),
    true,
    "Gemini Flash should be unavailable when gemini family is rate limited"
  );
  assert.equal(
    familyCooldown.isAntigravityFamilyUnavailable(conn, "antigravity/gemini-3.1-flash-lite"),
    true,
    "Gemini Lite should be unavailable when gemini family is rate limited"
  );
  assert.equal(
    familyCooldown.isAntigravityFamilyUnavailable(conn, "agy/claude-sonnet-4-6"),
    false,
    "Claude Sonnet should NOT be affected by Gemini family rate limit"
  );
  assert.equal(
    familyCooldown.isAntigravityFamilyUnavailable(conn, "agy/claude-opus-4-6-thinking"),
    false,
    "Claude Opus should NOT be affected by Gemini family rate limit"
  );
});

test("fill-first routes Gemini requests to Account 2 when Account 1 has <=5% Gemini quota, while routing Claude to Account 1", async () => {
  const db = coreDb.getDbInstance();

  // Create two Antigravity connections:
  // Account 1: Priority 1 (preferred in fill-first)
  // Account 2: Priority 2 (fallback in fill-first)
  const conn1Id = "conn-account-1";
  const conn2Id = "conn-account-2";

  db.prepare(`
    INSERT INTO provider_connections (id, provider, auth_type, priority, is_active, test_status, access_token, created_at, updated_at, provider_specific_data)
    VALUES (?, 'agy', 'oauth', 1, 1, 'active', 'tok-1', datetime('now'), datetime('now'), '{}'),
           (?, 'agy', 'oauth', 2, 1, 'active', 'tok-2', datetime('now'), datetime('now'), '{}')
  `).run(conn1Id, conn2Id);

  // Account 1: Gemini models depleted (4% left, weekly 4% left), Claude untouched (100% left)
  quotaCache.setQuotaCache(conn1Id, "agy", {
    "gemini-3.8-flash-high": { remainingPercentage: 4, resetAt: null },
    gemini_weekly: { remainingPercentage: 4, resetAt: null },
    "claude-sonnet-4-6": { remainingPercentage: 100, resetAt: null },
    claude_gpt_weekly: { remainingPercentage: 100, resetAt: null },
  });

  // Account 2: Gemini has 80% left, Claude has 100% left
  quotaCache.setQuotaCache(conn2Id, "agy", {
    "gemini-3.8-flash-high": { remainingPercentage: 80, resetAt: null },
    gemini_weekly: { remainingPercentage: 80, resetAt: null },
    "claude-sonnet-4-6": { remainingPercentage: 100, resetAt: null },
    claude_gpt_weekly: { remainingPercentage: 100, resetAt: null },
  });

  // Request Gemini 3.8 Flash High: Account 1 is exhausted (<5%), so fill-first selects Account 2
  const geminiCredentials = await auth.getProviderCredentials(
    "agy",
    null,
    null,
    "agy/gemini-3.8-flash-high",
    { strategy: "fill-first" }
  );
  assert.ok(geminiCredentials, "Credentials should be returned for Gemini");
  assert.equal(
    geminiCredentials.connectionId,
    conn2Id,
    "fill-first must route Gemini to Account 2 because Account 1 is exhausted"
  );

  // Request Claude Sonnet 4 6: Account 1 has 100% Claude quota, so fill-first selects Priority 1 (Account 1)
  const claudeCredentials = await auth.getProviderCredentials(
    "agy",
    null,
    null,
    "agy/claude-sonnet-4-6",
    { strategy: "fill-first" }
  );
  assert.ok(claudeCredentials, "Credentials should be returned for Claude");
  assert.equal(
    claudeCredentials.connectionId,
    conn1Id,
    "fill-first must route Claude to Account 1 because Account 1 has full Claude quota and higher priority"
  );
});

test("fill-first respects reactive family cooldown on Account 1 for Gemini while keeping Claude on Account 1", async () => {
  const conn1Id = "conn-account-1";
  const conn2Id = "conn-account-2";

  // Simulate a 429 on Gemini family by setting antigravityFamilyRateLimitedUntil
  const inFuture = new Date(Date.now() + 120_000).toISOString();
  await dbProviders.updateProviderConnection(conn1Id, {
    providerSpecificData: {
      antigravityFamilyRateLimitedUntil: {
        gemini: inFuture,
      },
    },
  });

  // Clear quotaCache to isolate this test strictly to the reactive cooldown
  quotaCache.__clearForTests();

  // Gemini request: Account 1 is cooling down for Gemini family -> routes to Account 2
  const geminiCredentials = await auth.getProviderCredentials(
    "agy",
    null,
    null,
    "agy/gemini-3.8-flash-high",
    { strategy: "fill-first" }
  );
  assert.ok(geminiCredentials);
  assert.equal(
    geminiCredentials.connectionId,
    conn2Id,
    "Reactive cooldown for Gemini family must route Gemini request to Account 2"
  );

  // Claude request: Account 1 has NO cooldown for Claude -> routes to Account 1 (fill-first priority 1)
  const claudeCredentials = await auth.getProviderCredentials(
    "agy",
    null,
    null,
    "agy/claude-sonnet-4-6",
    { strategy: "fill-first" }
  );
  assert.ok(claudeCredentials);
  assert.equal(
    claudeCredentials.connectionId,
    conn1Id,
    "Claude request must still route to Account 1 even when Gemini family is cooling down"
  );
});
