import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-quota-read-result-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const coreDb = await import("../../src/lib/db/core.ts");
const { getProviderQuota, getProviderQuotaReadResult } =
  await import("../../src/lib/quota/providerQuotaState");
const { getDbInstance } = coreDb;

async function resetStorage() {
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

function seedQuotaState(input: {
  connectionId?: string;
  model?: string;
  tokensUsed?: number;
  tokenLimit?: number;
  windowStart?: number;
  windowReset?: number;
}) {
  getDbInstance()
    .prepare(
      `INSERT OR REPLACE INTO provider_quota_state
       (connection_id, model, tokens_used, token_limit, window_start, window_reset, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.connectionId ?? "read-result-connection",
      input.model ?? "read-result-model",
      input.tokensUsed ?? 25,
      input.tokenLimit ?? 100,
      input.windowStart ?? 1_000,
      input.windowReset ?? 2_000,
      new Date().toISOString()
    );
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(() => {
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("getProviderQuotaReadResult distinguishes a missing row from a read failure", () => {
  const result = getProviderQuotaReadResult("read-result-connection", "missing-model");
  assert.deepEqual(result, { status: "unconfigured", reason: "missing_row" });
  assert.equal(getProviderQuota("read-result-connection", "missing-model"), null);
});

test("getProviderQuotaReadResult reports an expired window when now is after windowReset", () => {
  const originalNow = Date.now;
  const now = 2_001;
  try {
    Date.now = () => now;
    seedQuotaState({ windowReset: 2_000 });

    const result = getProviderQuotaReadResult("read-result-connection", "read-result-model");
    assert.equal(result.status, "expired");
    if (result.status !== "expired") return;
    assert.deepEqual(result.snapshot, {
      known: false,
      tokensUsed: 0,
      tokenLimit: 0,
      tokensRemaining: 0,
      remainingRatio: 1,
      windowReset: 2_000,
    });
    assert.deepEqual(
      getProviderQuota("read-result-connection", "read-result-model"),
      result.snapshot
    );
  } finally {
    Date.now = originalNow;
  }
});

test("getProviderQuotaReadResult treats now equal to windowReset as fresh", () => {
  const originalNow = Date.now;
  try {
    Date.now = () => 2_000;
    seedQuotaState({ windowReset: 2_000 });

    const result = getProviderQuotaReadResult("read-result-connection", "read-result-model");
    assert.equal(result.status, "known");
    if (result.status !== "known") return;
    assert.equal(result.snapshot.known, true);
    assert.equal(result.snapshot.windowReset, 2_000);
    assert.equal(getProviderQuota("read-result-connection", "read-result-model")?.known, true);
  } finally {
    Date.now = originalNow;
  }
});

test("getProviderQuotaReadResult returns the known snapshot for a configured budget", () => {
  const originalNow = Date.now;
  try {
    Date.now = () => 1_500;
    seedQuotaState({ tokensUsed: 25, tokenLimit: 100, windowReset: 2_000 });

    const result = getProviderQuotaReadResult("read-result-connection", "read-result-model");
    assert.deepEqual(result, {
      status: "known",
      snapshot: {
        known: true,
        tokensUsed: 25,
        tokenLimit: 100,
        tokensRemaining: 75,
        remainingRatio: 0.75,
        windowReset: 2_000,
      },
    });
    assert.deepEqual(
      getProviderQuota("read-result-connection", "read-result-model"),
      result.status === "known" ? result.snapshot : null
    );
  } finally {
    Date.now = originalNow;
  }
});

test("getProviderQuotaReadResult reports a bounded read-error code without exception details", () => {
  getDbInstance().prepare("DROP TABLE provider_quota_state").run();

  const result = getProviderQuotaReadResult("read-result-connection", "read-result-model");
  assert.deepEqual(result, {
    status: "read-error",
    errorCode: "provider_quota_read_failed",
  });
  assert.equal("message" in result, false);
});

test("getProviderQuotaReadResult labels a row without a token limit as unconfigured", () => {
  const originalNow = Date.now;
  try {
    Date.now = () => 1_500;
    seedQuotaState({ tokenLimit: 0, windowReset: 2_000 });

    assert.deepEqual(getProviderQuotaReadResult("read-result-connection", "read-result-model"), {
      status: "unconfigured",
      reason: "no_token_limit",
    });
    assert.deepEqual(getProviderQuota("read-result-connection", "read-result-model"), {
      known: true,
      tokensUsed: 25,
      tokenLimit: 0,
      tokensRemaining: 0,
      remainingRatio: 1,
      windowReset: 2_000,
    });
  } finally {
    Date.now = originalNow;
  }
});
