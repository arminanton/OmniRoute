import "../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { waitForCooldownAwareRetryWithinLogicalDeadline as wait } from "../../src/sse/services/cooldownAwareRetry.ts";
import {
  LogicalRetryBudget,
  runWithLogicalRetryBudget,
  runGenerationDispatch,
  budgetedGenerationFetch,
} from "../../open-sse/services/logicalRetryBudget.ts";

for (const proposedWait of [50, 2500]) {
  test(`outer ${proposedWait}ms retry wait cannot fit5ms logical time: no timer or generation`, async (t) => {
    let timers = 0,
      sends = 0;
    const actualSetTimeout = globalThis.setTimeout;
    t.mock.method(globalThis, "setTimeout", ((
      callback: (...args: unknown[]) => void,
      _ms?: number,
      ...args: unknown[]
    ) => {
      timers++;
      return actualSetTimeout(callback, 0, ...args);
    }) as typeof setTimeout);
    const budget = new LogicalRetryBudget(3, 5, () => 0);
    const fetch = budgetedGenerationFetch(async () => {
      sends++;
      return Response.json({ ok: true });
    });
    await runWithLogicalRetryBudget(budget, () =>
      runGenerationDispatch(async () => {
        const completed = await wait(proposedWait);
        assert.equal(completed, null, "skip must differ from client abort");
        if (completed === true)
          await fetch("https://fixture.invalid/v1/responses", { method: "POST" });
      })
    );
    assert.equal(timers, 0);
    assert.equal(sends, 0);
    assert.equal(budget.snapshot().attempts, 0);
  });
}

test("enough logical time allows the existing bounded wait and one generation", async () => {
  let sends = 0;
  const budget = new LogicalRetryBudget(3, Date.now() + 5000);
  const fetch = budgetedGenerationFetch(async () => {
    sends++;
    return Response.json({ ok: true });
  });
  await runWithLogicalRetryBudget(budget, () =>
    runGenerationDispatch(async () => {
      assert.equal(await wait(1), true);
      const response = await fetch("https://fixture.invalid/v1/responses", { method: "POST" });
      await response.json();
    })
  );
  assert.equal(sends, 1);
  assert.equal(budget.snapshot().attempts, 1);
});

test("event-loop-delayed completion after the deadline cannot schedule a retry", async (t) => {
  let now = 0,
    sends = 0;
  const budget = new LogicalRetryBudget(3, 100, () => now);
  const actualSetTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", ((
    callback: (...args: unknown[]) => void,
    _ms?: number,
    ...args: unknown[]
  ) =>
    actualSetTimeout(() => {
      now = 101;
      callback(...args);
    }, 0)) as typeof setTimeout);
  await runWithLogicalRetryBudget(budget, async () => {
    const completed = await wait(1);
    assert.equal(completed, null);
    if (completed === true) sends++;
  });
  assert.equal(sends, 0);
});

test("caller abort remains false, including when no logical time remains", async () => {
  const abort = new AbortController();
  abort.abort(new DOMException("fixture disconnect", "AbortError"));
  await runWithLogicalRetryBudget(new LogicalRetryBudget(3, 0, () => 0), async () => {
    assert.equal(await wait(20, abort.signal), false);
  });
  const pendingAbort = new AbortController();
  const result = runWithLogicalRetryBudget(new LogicalRetryBudget(3, Date.now() + 5000), () =>
    wait(100, pendingAbort.signal)
  );
  pendingAbort.abort(new DOMException("fixture disconnect", "AbortError"));
  assert.equal(await result, false);
});
