import test from "node:test";
import assert from "node:assert/strict";
import {
  _clearAccountRequestOccupancyForTest,
  getAccountRequestInFlightCount,
  reserveAccountRequest,
  selectAvailableCapacityConnection,
} from "../../open-sse/services/accountRequestOccupancy.ts";

test.beforeEach(() => {
  _clearAccountRequestOccupancyForTest();
});

test("account request occupancy counts each reservation and releases exactly once", () => {
  const releaseA = reserveAccountRequest("account-a");
  const releaseB = reserveAccountRequest("account-a");
  const releaseOther = reserveAccountRequest("account-b");

  assert.equal(getAccountRequestInFlightCount("account-a"), 2);
  assert.equal(getAccountRequestInFlightCount("account-b"), 1);

  releaseA();
  releaseA();
  assert.equal(getAccountRequestInFlightCount("account-a"), 1);
  releaseB();
  releaseOther();
  assert.equal(getAccountRequestInFlightCount("account-a"), 0);
  assert.equal(getAccountRequestInFlightCount("account-b"), 0);
});

test("available-capacity selection scales load by configured account concurrency", () => {
  const candidates = [
    { id: "single-slot", priority: 1, maxConcurrent: 1 },
    { id: "two-slots", priority: 1, maxConcurrent: 2 },
  ];

  const first = selectAvailableCapacityConnection("codex", candidates)!;
  assert.equal(first.id, "single-slot");
  const releaseFirst = reserveAccountRequest(first.id);

  const second = selectAvailableCapacityConnection("codex", candidates)!;
  assert.equal(second.id, "two-slots");
  const releaseSecond = reserveAccountRequest(second.id);

  const third = selectAvailableCapacityConnection("codex", candidates)!;
  assert.equal(third.id, "two-slots");
  const releaseThird = reserveAccountRequest(third.id);

  releaseFirst();
  releaseSecond();
  releaseThird();
});

test("available-capacity rotates equal-idle peers without persistent writes", () => {
  const candidates = [
    { id: "a", priority: 2 },
    { id: "b", priority: 2 },
    { id: "c", priority: 2 },
  ];
  const selections = Array.from(
    { length: 6 },
    () => selectAvailableCapacityConnection("antigravity", candidates)?.id
  );

  assert.deepEqual(selections, ["a", "b", "c", "a", "b", "c"]);
});
