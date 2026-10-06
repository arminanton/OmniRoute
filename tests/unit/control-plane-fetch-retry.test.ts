import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { proxyFetch } from "../../open-sse/utils/proxyFetch.ts";
import {
  LogicalRetryBudget,
  runWithLogicalRetryBudget,
  runGenerationDispatch,
} from "../../open-sse/services/logicalRetryBudget.ts";
import { acquireSharedSemaphore } from "../../open-sse/services/coordination/sharedSemaphore.ts";
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omni-control-retry-"));
process.env.OMNI_COORDINATION_DB = path.join(directory, "coordination.sqlite");
process.env.OMNI_SHARED_ADMISSION = "true";
process.env.ENABLE_TLS_FINGERPRINT = "false";
for (const key of [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
])
  delete process.env[key];
const queue = () =>
  acquireSharedSemaphore([{ key: "synthetic-ag-account", maxConcurrency: 2 }], {
    timeoutMs: 200,
    onLeaseLost() {},
  });
const transportFailure = () => new TypeError("fetch failed: synthetic metadata DNS failure");
test.after(() => {
  globalThis.__omniSharedCoordinator?.close();
  globalThis.__omniSharedCoordinator = undefined;
  fs.rmSync(directory, { recursive: true });
});

for (const method of ["GET", "POST"])
  test(`control-plane ${method} retries cannot consume an exhausted generation budget or admission hooks`, async () => {
    const budget = new LogicalRetryBudget(1, Date.now() + 5000);
    budget.consumeAttempt();
    let calls = 0,
      hooks = 0;
    const response = await runWithLogicalRetryBudget(budget, () =>
      runGenerationDispatch(
        () =>
          proxyFetch(
            "https://metadata.invalid/release",
            { method },
            {
              undiciFetch: async () => {
                calls++;
                if (calls === 1) throw transportFailure();
                return new Response("metadata");
              },
              nativeFetch: async () => {
                throw new Error("unexpected native fallback");
              },
            }
          ),
        {
          withPermitReleased: async (wait) => {
            hooks++;
            await wait();
          },
        }
      )
    );
    assert.equal(await response.text(), "metadata");
    assert.equal(calls, 2);
    assert.equal(hooks, 0);
    assert.equal(budget.snapshot().attempts, 1);
  });

test(
  "actual shared SQLite singleflight metadata owner cannot release/reacquire behind followers holding its slots",
  { timeout: 5000 },
  async () => {
    let ownerRelease = await queue(),
      followerRelease: (() => void) | undefined,
      intruderRelease: (() => void) | undefined;
    let permitHooks = 0,
      sends = 0,
      followerReady: () => void = () => {};
    const follower = new Promise<void>((resolve) => {
      followerReady = resolve;
    });
    let metadata: Promise<Response>;
    try {
      metadata = runWithLogicalRetryBudget(new LogicalRetryBudget(12, Date.now() + 5000), () =>
        runGenerationDispatch(
          () =>
            proxyFetch(
              "https://metadata.invalid/release",
              { method: "GET" },
              {
                undiciFetch: async () => {
                  sends++;
                  if (sends === 1) {
                    await follower;
                    throw transportFailure();
                  }
                  return new Response("version");
                },
                nativeFetch: async () => {
                  throw new Error("unexpected native fallback");
                },
              }
            ),
          {
            withPermitReleased: async (wait) => {
              permitHooks++;
              ownerRelease();
              intruderRelease = await queue();
              await wait();
              ownerRelease = await queue();
            },
          }
        )
      );
      followerRelease = await queue();
      followerReady();
      const response = await metadata;
      assert.equal(await response.text(), "version");
      assert.equal(permitHooks, 0);
      assert.equal(sends, 2);
    } finally {
      followerRelease?.();
      intruderRelease?.();
      ownerRelease();
    }
    assert.equal(globalThis.__omniSharedCoordinator?.runtimeCounts().activeGeneration, 0);
    assert.equal(globalThis.__omniSharedCoordinator?.runtimeCounts().queuedGeneration, 0);
  }
);

test("known generation POST pre-send queue backoff still releases and reacquires real shared permits", async () => {
  const { waitForFetchRetry } = await import("../../open-sse/utils/fetchRetryBackoff.ts");
  const { noteGenerationDispatchPhase, canReplayGenerationDispatch } =
    await import("../../open-sse/services/generationReplay.ts");
  const failure = new Error("known queued before send");
  noteGenerationDispatchPhase(failure, "transport_queue", false);
  let release = await queue();
  const events: string[] = [];
  try {
    await runWithLogicalRetryBudget(new LogicalRetryBudget(3, Date.now() + 2000), () =>
      runGenerationDispatch(
        async () => {
          assert.equal(
            canReplayGenerationDispatch(
              "https://fixture.invalid/responses",
              { method: "POST" },
              failure
            ),
            true
          );
          await waitForFetchRetry("https://fixture.invalid/responses", { method: "POST" }, 0);
        },
        {
          withPermitReleased: async (wait) => {
            events.push("release");
            release();
            assert.equal(globalThis.__omniSharedCoordinator?.runtimeCounts().activeGeneration, 0);
            await wait();
            release = await queue();
            events.push("reacquire");
          },
        }
      )
    );
    assert.deepEqual(events, ["release", "reacquire"]);
  } finally {
    release();
  }
  assert.equal(globalThis.__omniSharedCoordinator?.runtimeCounts().activeGeneration, 0);
});

test("non-generation delay is cancellable and emits no generation telemetry", async () => {
  const { waitForFetchRetry } = await import("../../open-sse/utils/fetchRetryBackoff.ts");
  const { RequestTransportTelemetry, runWithRequestTransportTelemetry } =
    await import("../../open-sse/utils/transportTelemetry.ts");
  const telemetry = new RequestTransportTelemetry(undefined, () => {}),
    controller = new AbortController(),
    reason = new Error("metadata caller cancelled");
  const waiting = runWithRequestTransportTelemetry(telemetry, () =>
    runWithLogicalRetryBudget(new LogicalRetryBudget(1, Date.now() - 1), () =>
      runGenerationDispatch(
        () =>
          waitForFetchRetry(
            "https://fixture.invalid/oauth/token",
            { method: "POST" },
            1000,
            controller.signal
          ),
        {
          withPermitReleased: async () => {
            throw new Error("must not touch generation lease");
          },
        }
      )
    )
  );
  controller.abort(reason);
  await assert.rejects(waiting, (error) => error === reason);
  assert.equal(telemetry.snapshot().backoffCount, 0);
  assert.equal(telemetry.snapshot().backoffMs, 0);
});
