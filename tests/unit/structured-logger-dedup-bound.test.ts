import test from "node:test";
import assert from "node:assert/strict";

const { __structuredLoggerInternals } = await import("../../src/shared/utils/structuredLogger.ts");

test("pruneRecentErrors enforces a hard cap during a unique-message burst", () => {
  const { recentErrors, pruneRecentErrors, makeRoomForRecentError, MAX_TRACKED_ERRORS } =
    __structuredLoggerInternals;
  recentErrors.clear();

  const now = Date.now();
  // Simulate a burst of unique messages within a single dedup window (all firstSeen = now,
  // so the age-based cleanup removes none of them).
  for (let i = 0; i < MAX_TRACKED_ERRORS * 2; i++) {
    pruneRecentErrors(now);
    makeRoomForRecentError();
    recentErrors.set(`unique-error-${i}`, { count: 1, firstSeen: now });
  }
  pruneRecentErrors(now);

  assert.ok(
    recentErrors.size <= MAX_TRACKED_ERRORS,
    `map should be bounded by ${MAX_TRACKED_ERRORS}, got ${recentErrors.size}`
  );

  // The cap evicts the OLDEST entries, so the most recent ones survive.
  assert.ok(
    recentErrors.has(`unique-error-${MAX_TRACKED_ERRORS * 2 - 1}`),
    "the newest entry should be retained"
  );

  recentErrors.clear();
});

test("pruneRecentErrors removes entries older than the dedup window", () => {
  const { recentErrors, pruneRecentErrors } = __structuredLoggerInternals;
  recentErrors.clear();

  const base = Date.now();
  // 150 entries (>100 so the age cleanup runs), all old.
  for (let i = 0; i < 150; i++) {
    recentErrors.set(`old-${i}`, { count: 1, firstSeen: base });
  }
  // Advance well past the 5s dedup window.
  pruneRecentErrors(base + 60_000);

  assert.equal(recentErrors.size, 0, "all expired entries should be cleaned up");
  recentErrors.clear();
});

test("error dedup is scoped by severity and component and carries the suppressed count forward", () => {
  const { shouldSuppressError, resetRecentErrorsForTests } = __structuredLoggerInternals;
  const base = 1_800_000_000_000;
  resetRecentErrorsForTests(base);

  assert.equal(shouldSuppressError("error", "antigravity", "upstream 429", base).suppress, false);
  assert.equal(
    shouldSuppressError("error", "antigravity", "upstream 429", base + 1).suppress,
    true
  );
  assert.equal(shouldSuppressError("error", "codex", "upstream 429", base + 2).suppress, false);
  assert.equal(
    shouldSuppressError("fatal", "antigravity", "upstream 429", base + 3).suppress,
    false
  );

  const nextWindow = shouldSuppressError("error", "antigravity", "upstream 429", base + 5_000);
  assert.equal(nextWindow.suppress, false);
  assert.deepEqual(nextWindow.summary, {
    deduplicatedErrorGroups: 1,
    deduplicatedErrorCount: 1,
    rateLimitedErrorCount: 0,
  });
  resetRecentErrorsForTests();
});

test("rate-limited errors are counted on the next emitted error and long messages are not retained", () => {
  const { shouldSuppressError, resetRecentErrorsForTests, recentErrors, MAX_TRACKED_ERRORS } =
    __structuredLoggerInternals;
  const base = 1_800_000_001_000;
  resetRecentErrorsForTests(base);

  for (let index = 0; index < 50; index++) {
    assert.equal(shouldSuppressError("error", "gateway", `unique-${index}`, base).suppress, false);
  }
  assert.equal(shouldSuppressError("error", "gateway", "rate-limited", base).suppress, true);
  const afterWindow = shouldSuppressError("error", "gateway", "recovered", base + 1_001);
  assert.equal(afterWindow.suppress, false);
  assert.equal(afterWindow.summary?.rateLimitedErrorCount, 1);

  resetRecentErrorsForTests(base + 2_000);
  const longMessage = "x".repeat(8_192);
  assert.equal(shouldSuppressError("error", "gateway", longMessage, base + 2_000).suppress, false);
  assert.equal(recentErrors.size, 0, "oversized error strings must not be retained as map keys");

  for (let index = 0; index < MAX_TRACKED_ERRORS + 20; index++) {
    shouldSuppressError("error", "gateway", `bounded-${index}`, base + 2_001 + index);
  }
  assert.ok(recentErrors.size <= MAX_TRACKED_ERRORS);
  resetRecentErrorsForTests();
});
