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

test("sibling strategy resolution respects agy fill-first override even when antigravity has least-used", async () => {
  const settingsDb = await import("../../src/lib/db/settings.ts");
  await settingsDb.updateSettings({
    providerStrategies: {
      antigravity: { fallbackStrategy: "least-used" },
      agy: { fallbackStrategy: "fill-first" },
    },
  });

  // Account 1 and Account 2 are both active with full quota
  const conn1Id = "conn-account-1";
  const conn2Id = "conn-account-2";
  await dbProviders.updateProviderConnection(conn1Id, {
    providerSpecificData: {},
    lastUsedAt: new Date(Date.now() - 1000).toISOString(),
  });
  await dbProviders.updateProviderConnection(conn2Id, {
    providerSpecificData: {},
    lastUsedAt: new Date(Date.now() - 50_000).toISOString(), // older lastUsedAt
  });

  // Calling with canonical provider "antigravity" on "agy" connections should resolve "fill-first" (Account 1 priority 1),
  // NOT "least-used" (which would have picked Account 2 because of older lastUsedAt).
  const creds = await auth.getProviderCredentials(
    "antigravity",
    null,
    null,
    "claude-opus-4-6-thinking"
  );
  assert.ok(creds);
  assert.equal(
    creds.connectionId,
    conn1Id,
    "Should resolve fill-first from agy connection/sibling and select Account 1"
  );
});

test("fill-first does not rotate sequential requests to Account 2 when reserveOAuthSession is set", async () => {
  const conn1Id = "conn-account-1";
  const conn2Id = "conn-account-2";

  for (let i = 0; i < 5; i++) {
    const creds = await auth.getProviderCredentials(
      "agy",
      null,
      null,
      "agy/claude-sonnet-4-6",
      {
        sessionKey: `request-uuid-${i}`,
        reserveOAuthSession: true,
      }
    );
    assert.ok(creds);
    assert.equal(
      creds.connectionId,
      conn1Id,
      `Sequential turn ${i + 1} must stay on Account 1 under fill-first`
    );
    creds.releaseOAuthSession?.();
  }
});

test("fill-first routes new sessions to Account 1 rather than round-robining via LRU", async () => {
  const conn1Id = "conn-account-1";
  const conn2Id = "conn-account-2";

  // Reset lastUsedAt to make Account 2 look older (LRU candidate)
  await dbProviders.updateProviderConnection(conn1Id, {
    lastUsedAt: new Date(Date.now() - 1_000).toISOString(),
  });
  await dbProviders.updateProviderConnection(conn2Id, {
    lastUsedAt: new Date(Date.now() - 600_000).toISOString(),
  });

  // Ensure full quota for both
  quotaCache.setQuotaCache(conn1Id, "agy", {
    "claude-sonnet-4-6": { remainingPercentage: 100, resetAt: null },
    claude_gpt_weekly: { remainingPercentage: 100, resetAt: null },
  });
  quotaCache.setQuotaCache(conn2Id, "agy", {
    "claude-sonnet-4-6": { remainingPercentage: 100, resetAt: null },
    claude_gpt_weekly: { remainingPercentage: 100, resetAt: null },
  });

  // 3 distinct sessions with sessionAffinityTtlMs=60000 under fill-first:
  // All 3 must pick Priority 1 (conn1Id) instead of LRU rotating to conn2Id!
  for (const sKey of ["session-test-alpha", "session-test-beta", "session-test-gamma"]) {
    const creds = await auth.getProviderCredentials(
      "agy",
      null,
      null,
      "agy/claude-sonnet-4-6",
      {
        sessionKey: sKey,
        sessionAffinityTtlMs: 60_000,
        strategy: "fill-first",
      }
    );
    assert.ok(creds);
    assert.equal(
      creds.connectionId,
      conn1Id,
      `New session ${sKey} must start on Account 1 under fill-first, not LRU`
    );
  }
});

test("model family lanes maintain separate session affinity pins without clobbering each other", async () => {
  const { clearAllModelLockouts } = await import(
    "@omniroute/open-sse/services/accountFallback.ts"
  );
  clearAllModelLockouts();

  const conn1Id = "conn-account-1";
  const conn2Id = "conn-account-2";

  await dbProviders.updateProviderConnection(conn1Id, {
    providerSpecificData: {},
    rateLimitedUntil: null,
  });
  await dbProviders.updateProviderConnection(conn2Id, {
    providerSpecificData: {},
    rateLimitedUntil: null,
  });

  // Account 1 has Gemini quota (90%), but Claude quota exhausted (3%)
  quotaCache.setQuotaCache(conn1Id, "agy", {
    "gemini-3.8-flash-high": { remainingPercentage: 90, resetAt: null },
    gemini_weekly: { remainingPercentage: 90, resetAt: null },
    "claude-sonnet-4-6": { remainingPercentage: 3, resetAt: null },
    claude_gpt_weekly: { remainingPercentage: 3, resetAt: null },
  });

  // Account 2 has full quota on both
  quotaCache.setQuotaCache(conn2Id, "agy", {
    "gemini-3.8-flash-high": { remainingPercentage: 100, resetAt: null },
    gemini_weekly: { remainingPercentage: 100, resetAt: null },
    "claude-sonnet-4-6": { remainingPercentage: 100, resetAt: null },
    claude_gpt_weekly: { remainingPercentage: 100, resetAt: null },
  });

  const sessionKey = "session-mixed-lanes-123";

  // 1. Send Gemini request in session-mixed-lanes-123
  // Account 1 has Gemini quota -> routes to Account 1 and pins gemini lane
  const geminiTurn1 = await auth.getProviderCredentials(
    "agy",
    null,
    null,
    "agy/gemini-3.8-flash-high",
    {
      sessionKey,
      sessionAffinityTtlMs: 60_000,
      strategy: "fill-first",
    }
  );
  assert.ok(geminiTurn1);
  assert.equal(geminiTurn1.connectionId, conn1Id, "Gemini turn 1 must route to Account 1");

  // 2. Send Claude request in the SAME session-mixed-lanes-123
  // Account 1 has Claude quota exhausted -> routes to Account 2 and pins claude lane
  const claudeTurn1 = await auth.getProviderCredentials(
    "agy",
    null,
    null,
    "agy/claude-sonnet-4-6",
    {
      sessionKey,
      sessionAffinityTtlMs: 60_000,
      strategy: "fill-first",
    }
  );
  assert.ok(claudeTurn1);
  assert.equal(claudeTurn1.connectionId, conn2Id, "Claude turn 1 must route to Account 2");

  // 3. Send Gemini request again in the SAME session-mixed-lanes-123
  // Must STILL route to Account 1 (Gemini pin preserved, not overwritten by Claude!)
  const geminiTurn2 = await auth.getProviderCredentials(
    "agy",
    null,
    null,
    "agy/gemini-3.8-flash-high",
    {
      sessionKey,
      sessionAffinityTtlMs: 60_000,
      strategy: "fill-first",
    }
  );
  assert.ok(geminiTurn2);
  assert.equal(
    geminiTurn2.connectionId,
    conn1Id,
    "Gemini turn 2 must STILL route to Account 1 via gemini affinity pin"
  );

  // 4. Send Claude request again in the SAME session-mixed-lanes-123
  // Must STILL route to Account 2 (Claude pin preserved, not overwritten by Gemini!)
  const claudeTurn2 = await auth.getProviderCredentials(
    "agy",
    null,
    null,
    "agy/claude-sonnet-4-6",
    {
      sessionKey,
      sessionAffinityTtlMs: 60_000,
      strategy: "fill-first",
    }
  );
  assert.ok(claudeTurn2);
  assert.equal(
    claudeTurn2.connectionId,
    conn2Id,
    "Claude turn 2 must STILL route to Account 2 via claude affinity pin"
  );
});

test("gpt models in Antigravity are classified under the Claude/GPT family quota lane", async () => {
  const { getAntigravityQuotaFamily } = await import(
    "@omniroute/open-sse/services/antigravityQuotaFamily.ts"
  );

  assert.equal(getAntigravityQuotaFamily("gpt-4o"), "claude");
  assert.equal(getAntigravityQuotaFamily("gpt-oss-120b-medium"), "claude");
  assert.equal(getAntigravityQuotaFamily("agy/gpt-4o"), "claude");
  assert.equal(getAntigravityQuotaFamily("antigravity/o1-preview"), "claude");
  assert.equal(getAntigravityQuotaFamily("o3-mini"), "claude");
  assert.equal(getAntigravityQuotaFamily("gemini-2.5-pro"), "gemini");
});
