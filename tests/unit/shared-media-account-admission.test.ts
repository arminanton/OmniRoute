import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withConfiguredSharedAccountAdmission } from "../../open-sse/services/accountRequestAdmission.ts";

async function sharedFixture(run: () => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "omni-media-admission-"));
  const previousShared = process.env.OMNI_SHARED_ADMISSION;
  const previousDb = process.env.OMNI_COORDINATION_DB;
  globalThis.__omniSharedCoordinator?.close();
  globalThis.__omniSharedCoordinator = undefined;
  process.env.OMNI_SHARED_ADMISSION = "true";
  process.env.OMNI_COORDINATION_DB = join(directory, "coordination.sqlite");
  try {
    await run();
  } finally {
    globalThis.__omniSharedCoordinator?.close();
    globalThis.__omniSharedCoordinator = undefined;
    if (previousShared === undefined) delete process.env.OMNI_SHARED_ADMISSION;
    else process.env.OMNI_SHARED_ADMISSION = previousShared;
    if (previousDb === undefined) delete process.env.OMNI_COORDINATION_DB;
    else process.env.OMNI_COORDINATION_DB = previousDb;
    rmSync(directory, { recursive: true, force: true });
  }
}

const credentials = {
  connectionId: "upscale-account",
  maxConcurrent: 1,
  providerSpecificData: {},
};

test("shared media account lease covers fake upstream work and releases at completion", async () => {
  await sharedFixture(async () => {
    let startFirst!: () => void;
    let finishFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => (startFirst = resolve));
    const firstWork = new Promise<void>((resolve) => (finishFirst = resolve));
    let secondStarted = false;
    const options = {
      provider: "topaz",
      credentials,
    };

    const first = withConfiguredSharedAccountAdmission(options, async () => {
      startFirst();
      await firstWork;
      return "first";
    });
    await firstStarted;
    const second = withConfiguredSharedAccountAdmission(options, async () => {
      secondStarted = true;
      return "second";
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(secondStarted, false, "the configured account cap must cover upstream work");
    finishFirst();
    assert.equal(await first, "first");
    assert.equal(await second, "second");
    assert.equal(secondStarted, true);
  });
});

test("caller cancellation aborts fake upstream work and releases the shared slot", async () => {
  await sharedFixture(async () => {
    const caller = new AbortController();
    let upstreamStarted!: () => void;
    const started = new Promise<void>((resolve) => (upstreamStarted = resolve));
    const options = {
      provider: "topaz",
      credentials,
    };
    const first = withConfiguredSharedAccountAdmission(
      { ...options, signal: caller.signal },
      async (signal) => {
        upstreamStarted();
        await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
    );
    await started;
    let secondStarted = false;
    const second = withConfiguredSharedAccountAdmission(options, async () => {
      secondStarted = true;
      return "second";
    });
    caller.abort(new Error("synthetic downstream cancel"));
    await assert.rejects(first, /synthetic downstream cancel/);
    assert.equal(await second, "second");
    assert.equal(secondStarted, true);
  });
});

test("unset and nonpositive account caps bypass shared admission", async () => {
  await sharedFixture(async () => {
    const started: string[] = [];
    const base = { provider: "topaz" };
    const responses = await Promise.all(
      [undefined, null, 0, -1].map((maxConcurrent, index) =>
        withConfiguredSharedAccountAdmission(
          {
            ...base,
            credentials: { connectionId: `unlimited-${index}`, maxConcurrent },
          },
          async () => {
            started.push(String(index));
            return index;
          }
        )
      )
    );
    assert.deepEqual(responses, [0, 1, 2, 3]);
    assert.deepEqual(started.sort(), ["0", "1", "2", "3"]);
    assert.equal(globalThis.__omniSharedCoordinator, undefined);
  });
});
