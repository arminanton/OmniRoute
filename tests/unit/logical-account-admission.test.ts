import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireMany } from "../../open-sse/services/accountSemaphore.ts";
import { acquireLogicalConcurrencyGates } from "../../open-sse/handlers/chatCore/logicalAccountAdmission.ts";
import { getRuntimeCoordinationCounts } from "../../open-sse/services/coordination/sharedSemaphore.ts";
import {
  LogicalRetryBudget,
  runWithLogicalRetryBudget,
  isLogicalRetryBudgetError,
} from "../../open-sse/services/logicalRetryBudget.ts";

async function sharedFixture(run: () => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "omni-admission-deadline-"));
  const priorShared = process.env.OMNI_SHARED_ADMISSION,
    priorDb = process.env.OMNI_COORDINATION_DB;
  process.env.OMNI_SHARED_ADMISSION = "true";
  process.env.OMNI_COORDINATION_DB = join(dir, "c.sqlite");
  try {
    await run();
  } finally {
    globalThis.__omniSharedCoordinator?.close();
    globalThis.__omniSharedCoordinator = undefined;
    if (priorShared === undefined) delete process.env.OMNI_SHARED_ADMISSION;
    else process.env.OMNI_SHARED_ADMISSION = priorShared;
    if (priorDb === undefined) delete process.env.OMNI_COORDINATION_DB;
    else process.env.OMNI_COORDINATION_DB = priorDb;
    rmSync(dir, { recursive: true, force: true });
  }
}
const requirement = [{ key: "codex:queued-account", maxConcurrency: 1 }];
const options = { timeoutMs: 1000, onLeaseLost: () => {} };

test("actual shared account queue ends at the short logical budget and leaves no waiter", async () => {
  await sharedFixture(async () => {
    const held = await acquireMany(requirement, options);
    try {
      const began = Date.now();
      await assert.rejects(
        runWithLogicalRetryBudget(new LogicalRetryBudget(12, Date.now() + 35), () =>
          acquireLogicalConcurrencyGates(requirement, options)
        ),
        isLogicalRetryBudgetError
      );
      assert.ok(
        Date.now() - began < 400,
        "configured1000ms wait must not override35ms logical deadline"
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(getRuntimeCoordinationCounts()?.queuedGeneration, 0);
      assert.equal(getRuntimeCoordinationCounts()?.activeGeneration, 1);
    } finally {
      held();
    }
    const next = await acquireLogicalConcurrencyGates(requirement, options);
    next();
    assert.equal(getRuntimeCoordinationCounts()?.activeGeneration, 0);
  });
});
test("caller cancellation keeps its exact reason while queued", async () => {
  await sharedFixture(async () => {
    const held = await acquireMany(requirement, options);
    const caller = new AbortController(),
      reason = new Error("synthetic caller cancel");
    try {
      const pending = runWithLogicalRetryBudget(new LogicalRetryBudget(12, Date.now() + 500), () =>
        acquireLogicalConcurrencyGates(requirement, { ...options, signal: caller.signal })
      );
      setTimeout(() => caller.abort(reason), 20);
      await assert.rejects(pending, (error) => error === reason);
    } finally {
      held();
    }
  });
});
test("late acquisition after deadline releases exactly once even if implementation ignores abort", async () => {
  let releases = 0;
  const late = async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    return () => {
      releases++;
    };
  };
  await assert.rejects(
    runWithLogicalRetryBudget(new LogicalRetryBudget(12, Date.now() + 15), () =>
      acquireLogicalConcurrencyGates(requirement, options, late)
    ),
    isLogicalRetryBudgetError
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(releases, 1);
});
test("an acquired permit outlives the pre-output timer until its caller releases it", async () => {
  await sharedFixture(async () => {
    const release = await runWithLogicalRetryBudget(
      new LogicalRetryBudget(12, Date.now() + 35),
      () => acquireLogicalConcurrencyGates(requirement, options)
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(getRuntimeCoordinationCounts()?.activeGeneration, 1);
    release();
    assert.equal(getRuntimeCoordinationCounts()?.activeGeneration, 0);
  });
});

test("a delayed event-loop timer cannot hand an expired permit to provider dispatch", async () => {
  let releases = 0;
  const blocked = async () => {
    const until = Date.now() + 45;
    while (Date.now() < until) {
      /* represent synchronous reservation work */
    }
    return () => {
      releases++;
    };
  };
  await assert.rejects(
    runWithLogicalRetryBudget(new LogicalRetryBudget(12, Date.now() + 15), () =>
      acquireLogicalConcurrencyGates(requirement, options, blocked)
    ),
    isLogicalRetryBudgetError
  );
  assert.equal(releases, 1);
});
