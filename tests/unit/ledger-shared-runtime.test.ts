import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireSharedSemaphore } from "../../open-sse/services/coordination/sharedSemaphore.ts";
import {
  runFencedTask,
  getFencedTaskContext,
} from "../../open-sse/services/coordination/fencedTask.ts";

test("shared runtime cancellation/deadline remove waiters; task owner spans operation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "omni-shared-runtime-"));
  process.env.OMNI_COORDINATION_DB = join(directory, "leases.sqlite");
  const abort = new AbortController();
  const release = await acquireSharedSemaphore([{ key: "a", maxConcurrency: 1 }], {
    onLeaseLost: () => {},
    timeoutMs: 1000,
  });
  const pending = acquireSharedSemaphore([{ key: "a", maxConcurrency: 1 }], {
    signal: abort.signal,
    onLeaseLost: () => {},
    timeoutMs: 1000,
  });
  setTimeout(() => abort.abort(new Error("cancel")), 20);
  await assert.rejects(pending, /cancel/);
  await assert.rejects(
    acquireSharedSemaphore([{ key: "a", maxConcurrency: 1 }], {
      onLeaseLost: () => {},
      timeoutMs: 30,
    }),
    /deadline/
  );
  release();
  const lease = await acquireSharedSemaphore([{ key: "a", maxConcurrency: 1 }], {
    onLeaseLost: () => {},
    timeoutMs: 1000,
  });
  lease();
  await runFencedTask("refresh:a", async ({ signal, assertOwner }) => {
    assert.ok(getFencedTaskContext());
    assert.equal(signal.aborted, false);
    assertOwner();
  });
  rmSync(directory, { recursive: true, force: true });
  delete process.env.OMNI_COORDINATION_DB;
});
