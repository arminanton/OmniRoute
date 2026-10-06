import test from "node:test";
import assert from "node:assert/strict";
import {
  calendarWeekWindowMs,
  isValidIanaTimeZone,
  isValidResetHour,
  nodeDailyResetConfigured,
  nextDailyResetAtMs,
  parseTpdLimitFromText,
} from "../../open-sse/services/dailyQuotaReset.ts";

test("IANA: Asia/Shanghai ok, garbage rejected", () => {
  assert.equal(isValidIanaTimeZone("Asia/Shanghai"), true);
  assert.equal(isValidIanaTimeZone("America/New_York"), true);
  assert.equal(isValidIanaTimeZone("Not/AZone"), false);
  assert.equal(isValidIanaTimeZone(""), false);
});

test("isValidResetHour accepts 0-23 integers only", () => {
  assert.equal(isValidResetHour(0), true);
  assert.equal(isValidResetHour(23), true);
  assert.equal(isValidResetHour(24), false);
  assert.equal(isValidResetHour(-1), false);
  assert.equal(isValidResetHour(1.5), false);
  assert.equal(isValidResetHour(null), false);
});

test("nodeDailyResetConfigured requires both fields", () => {
  assert.equal(nodeDailyResetConfigured("Asia/Shanghai", 0), true);
  assert.equal(nodeDailyResetConfigured("Asia/Shanghai", null), false);
  assert.equal(nodeDailyResetConfigured(null, 0), false);
  assert.equal(nodeDailyResetConfigured("Not/AZone", 0), false);
  assert.equal(nodeDailyResetConfigured("Asia/Shanghai", 24), false);
});

test("nextDailyResetAtMs locks to next local hour:00", () => {
  // 2026-09-02 15:30 in Asia/Shanghai = 2026-09-02 07:30 UTC
  const now = Date.parse("2026-09-02T07:30:00Z");
  const next = nextDailyResetAtMs("Asia/Shanghai", 0, now);
  // next calendar day 00:00 Shanghai = 2026-09-02 16:00 UTC
  assert.equal(next, Date.parse("2026-09-02T16:00:00Z"));
});

test("nextDailyResetAtMs at exact reset instant returns the following cycle", () => {
  const exactly = Date.parse("2026-09-02T16:00:00Z"); // 00:00 Shanghai
  const next = nextDailyResetAtMs("Asia/Shanghai", 0, exactly);
  assert.equal(next, Date.parse("2026-09-03T16:00:00Z"));
});

test("calendarWeekWindowMs uses Monday midnight boundaries in the configured timezone", () => {
  const monday = calendarWeekWindowMs("Asia/Shanghai", Date.parse("2026-09-20T16:00:00Z"));
  assert.deepEqual(
    [new Date(monday.startMs).toISOString(), new Date(monday.resetMs).toISOString()],
    ["2026-09-20T16:00:00.000Z", "2026-09-27T16:00:00.000Z"]
  );

  const sunday = calendarWeekWindowMs("Asia/Shanghai", Date.parse("2026-09-20T15:59:59Z"));
  assert.deepEqual(
    [new Date(sunday.startMs).toISOString(), new Date(sunday.resetMs).toISOString()],
    ["2026-09-13T16:00:00.000Z", "2026-09-20T16:00:00.000Z"]
  );
});

test("calendarWeekWindowMs preserves DST-aware 167h and 169h weeks", () => {
  const spring = calendarWeekWindowMs("America/New_York", Date.parse("2026-03-08T12:00:00Z"));
  const fall = calendarWeekWindowMs("America/New_York", Date.parse("2026-11-01T12:00:00Z"));
  assert.equal((spring.resetMs - spring.startMs) / 3_600_000, 167);
  assert.equal((fall.resetMs - fall.startMs) / 3_600_000, 169);
});

test("parseTpdLimitFromText reads limit: from live body", () => {
  const body = "request reached organization TPD rate limit, current: 1537190, limit: 1500000";
  assert.equal(parseTpdLimitFromText(body), 1_500_000);
  assert.equal(parseTpdLimitFromText("no numbers"), null);
});
