import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMaintenanceRuntime } from "../../scripts/deploy/canary/maintenance-entry.ts";
import { getFencedTaskContext } from "../../open-sse/services/coordination/fencedTask.ts";
import { SqliteCoordinator } from "../../open-sse/services/coordination/sqliteCoordinator.ts";
import {
  installPeriodicOwnershipAuthority,
  periodicServicesAllowed,
} from "../../src/lib/periodicServices.ts";

const data = mkdtempSync(join(tmpdir(), "omni-maint-runtime-"));
process.env.OMNI_SHARED_ADMISSION = "true";
process.env.OMNI_COORDINATION_PROCESS_ROLE = "maintenance";
process.env.OMNI_COORDINATION_DB = join(data, "coordination.sqlite");
after(() => {
  globalThis.__omniSharedCoordinator?.close();
  globalThis.__omniSharedCoordinator = null;
  rmSync(data, { recursive: true, force: true });
});

test("real maintenance owner context reaches runtime and blocks a competing owner until stop", async () => {
  const stop = new AbortController();
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const running = runMaintenanceRuntime(async () => {
    const owner = getFencedTaskContext();
    assert.equal(owner?.key, "maintenance");
    installPeriodicOwnershipAuthority(() => owner!.assertOwner());
    assert.equal(periodicServicesAllowed("actual-maintenance-callback"), true);
    entered();
  }, stop.signal);
  await ready;
  const competitor = new SqliteCoordinator(process.env.OMNI_COORDINATION_DB!, "independent-owner");
  const queued = competitor.enqueue([{ key: "task:maintenance", limit: 1 }], Date.now() + 30_000);
  assert.equal(competitor.tryAcquire(queued, 30_000), null);
  stop.abort(new Error("test stop"));
  await assert.rejects(running, /test stop/);
  assert.equal(periodicServicesAllowed("actual-maintenance-callback"), false);
  const next = competitor.tryAcquire(queued, 30_000);
  assert.ok(next);
  competitor.release(next!);
  competitor.close();
});

test("failed actual runtime startup releases the owner and does not invent readiness", async () => {
  const stop = new AbortController();
  await assert.rejects(
    runMaintenanceRuntime(async () => {
      throw new Error("startup failed");
    }, stop.signal),
    /startup failed/
  );
  assert.equal(globalThis.__omniSharedCoordinator?.hasLiveResource("task:maintenance"), false);
});

test("wrong or generation role cannot launch maintenance", async () => {
  process.env.OMNI_COORDINATION_PROCESS_ROLE = "generation";
  try {
    await assert.rejects(
      runMaintenanceRuntime(async () => {
        assert.fail("must not boot");
      }, new AbortController().signal),
      /fixed shared coordination role/
    );
  } finally {
    process.env.OMNI_COORDINATION_PROCESS_ROLE = "maintenance";
  }
});
