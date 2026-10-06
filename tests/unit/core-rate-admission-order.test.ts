import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { useDecollidedMigrationsDir } from "./helpers/decollidedMigrationsDir.ts";
import { createChatPipelineHarness } from "../integration/_chatPipelineHarness.ts";
useDecollidedMigrationsDir();
const original = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error("unexpected network in private order fixture");
};
const harness = await createChatPipelineHarness("core-rate-admission-order");
const { updateProviderConnection } = await import("../../src/lib/db/providers.ts");
const rate = await import("../../open-sse/services/rateLimitManager.ts");
const {
  budgetedGenerationFetch,
  LogicalRetryBudget,
  runWithLogicalRetryBudget,
  getLogicalRetryBudget,
} = await import("../../open-sse/services/logicalRetryBudget.ts");
process.env.OMNI_SHARED_ADMISSION = "true";
process.env.OMNI_COORDINATION_DB = path.join(process.env.DATA_DIR!, "coordination.sqlite");
test.after(async () => {
  await rate.__resetRateLimitManagerForTests();
  globalThis.__omniSharedCoordinator?.close();
  globalThis.__omniSharedCoordinator = undefined;
  const { flushProxyLogsSync } = await import("../../src/lib/proxyLogger.ts");
  flushProxyLogsSync();
  await harness.cleanup();
  globalThis.fetch = original;
});

test(
  "real Core max1 sharedSQLite+Bottleneck queued follower cannot block known429 generation retry reacquisition",
  { timeout: 15000 },
  async () => {
    await harness.resetStorage();
    await harness.settingsDb.updateSettings({
      compression: { enabled: false },
      resilienceSettings: {
        quotaPreflight: { enabled: false },
        waitForCooldown: { enabled: false },
        requestQueue: { maxWaitMs: 400, maxQueueDepth: 256, globalConcurrentRequests: 0 },
      },
    });
    const connection = await harness.seedConnection("openai", {
      name: "synthetic-max1",
      apiKey: "synthetic",
      providerSpecificData: { quotaAdaptiveAdmission: false },
    });
    await updateProviderConnection(connection.id, { maxConcurrent: 1 });
    globalThis.fetch = async () => harness.buildOpenAIResponse("warm");
    const request = (name: string) =>
      harness.buildRequest({
        headers: { "x-omniroute-connection": connection.id },
        body: {
          model: "openai/gpt-4.1",
          stream: false,
          messages: [{ role: "user", content: name }],
        },
      });
    await (await harness.handleChat(request("warm"))).text();
    rate.enableRateLimitProtection(connection.id);
    rate.refreshConnectionRateLimits(connection.id, { maxConcurrent: 1, minTime: 0 });
    harness.BaseExecutor.RETRY_CONFIG.delayMs = 1;
    const ownerBudget = new LogicalRetryBudget(3, Date.now() + 5000),
      followerBudget = new LogicalRetryBudget(1, Date.now() + 5000);
    let first = true,
      sends = 0,
      entered: () => void = () => {},
      releaseRejected: () => void = () => {};
    const firstEntered = new Promise<void>((r) => {
        entered = r;
      }),
      releaseFirst = new Promise<void>((r) => {
        releaseRejected = r;
      });
    globalThis.fetch = budgetedGenerationFetch(async () => {
      sends++;
      assert.equal(
        getLogicalRetryBudget(),
        sends <= 2 ? ownerBudget : followerBudget,
        "scheduled callbacks preserve the submitting request budget"
      );
      if (first) {
        first = false;
        entered();
        await releaseFirst;
        return new Response(
          JSON.stringify({
            error: {
              message: "known concurrency rejection",
              type: "rate_limit_error",
              code: "rate_limit_exceeded",
            },
          }),
          { status: 429, headers: { "content-type": "application/json", "retry-after": "0" } }
        );
      }
      return harness.buildOpenAIResponse("success after known rejection");
    });
    const db = new DatabaseSync(process.env.OMNI_COORDINATION_DB!, { readOnly: true });
    let owner: Promise<Response> | undefined, follower: Promise<Response> | undefined;
    try {
      owner = runWithLogicalRetryBudget(ownerBudget, () => harness.handleChat(request("owner")));
      await firstEntered;
      follower = runWithLogicalRetryBudget(followerBudget, () =>
        harness.handleChat(request("follower"))
      );
      let queued = false;
      const start = Date.now();
      while (Date.now() - start < 1500) {
        const waits = Number(
          db.prepare("SELECT COUNT(*) n FROM coordination_waiters").get()?.n ?? 0
        );
        const queuedRate = rate.getAllRateLimitStatus()[`openai:${connection.id}`]?.queued ?? 0;
        if (waits > 0 || queuedRate > 0) {
          queued = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      assert.ok(queued, "second actual request must queue before first rejection resolves");
      releaseRejected();
      const responses = await Promise.all([owner, follower]);
      for (const response of responses) {
        const body = await response.text();
        assert.equal(response.status, 200, body);
        assert.match(body, /success after known rejection/);
      }
      assert.equal(sends, 3, "first rejected send plus its retry and follower send");
      assert.equal(globalThis.__omniSharedCoordinator?.runtimeCounts().activeGeneration, 0);
      assert.equal(globalThis.__omniSharedCoordinator?.runtimeCounts().queuedGeneration, 0);
    } finally {
      releaseRejected();
      await Promise.allSettled(
        [owner, follower].filter(Boolean).map(async (pending) => {
          const response = await pending!;
          if (!response.bodyUsed) await response.body?.cancel();
        })
      );
      db.close();
    }
  }
);

for (const mode of ["abort", "deadline"] as const)
  test(
    `queued legacy rate job ${mode} makes no late SQL claim or generation send`,
    { timeout: 15000 },
    async () => {
      await rate.__resetRateLimitManagerForTests();
      await harness.resetStorage();
      await harness.settingsDb.updateSettings({
        compression: { enabled: false },
        resilienceSettings: {
          quotaPreflight: { enabled: false },
          waitForCooldown: { enabled: false },
          requestQueue: { maxWaitMs: 400, maxQueueDepth: 256, globalConcurrentRequests: 0 },
        },
      });
      const connection = await harness.seedConnection("openai", {
        name: `synthetic-queued-${mode}`,
        apiKey: "synthetic",
        providerSpecificData: { quotaAdaptiveAdmission: false },
      });
      await updateProviderConnection(connection.id, { maxConcurrent: 1 });
      globalThis.fetch = async () => harness.buildOpenAIResponse("warm");
      const request = (name: string) =>
        harness.buildRequest({
          headers: { "x-omniroute-connection": connection.id },
          body: {
            model: "openai/gpt-4.1",
            stream: false,
            messages: [{ role: "user", content: name }],
          },
        });
      await (await harness.handleChat(request("warm"))).text();
      rate.enableRateLimitProtection(connection.id);
      rate.refreshConnectionRateLimits(connection.id, { maxConcurrent: 1, minTime: 0 });
      let releaseOwner: () => void = () => {},
        entered: () => void = () => {},
        sends = 0;
      const holding = new Promise<void>((resolve) => {
          releaseOwner = resolve;
        }),
        firstEntered = new Promise<void>((resolve) => {
          entered = resolve;
        });
      globalThis.fetch = budgetedGenerationFetch(async () => {
        sends++;
        if (sends === 1) {
          entered();
          await holding;
        }
        return harness.buildOpenAIResponse("owner completed");
      });
      const ownerBudget = new LogicalRetryBudget(3, Date.now() + 5000),
        controller = new AbortController();
      const owner = runWithLogicalRetryBudget(ownerBudget, () =>
        harness.handleChat(request("owner"))
      );
      await firstEntered;
      const followerBudget = new LogicalRetryBudget(3, Date.now() + 500);
      const follower = runWithLogicalRetryBudget(followerBudget, () =>
        harness.handleChat(new Request(request("follower"), { signal: controller.signal }))
      );
      try {
        const start = Date.now();
        while (
          (rate.getAllRateLimitStatus()[`openai:${connection.id}`]?.queued ?? 0) < 1 &&
          Date.now() - start < 1500
        )
          await new Promise((resolve) => setTimeout(resolve, 5));
        assert.equal(rate.getAllRateLimitStatus()[`openai:${connection.id}`]?.queued, 1);
        assert.equal(
          globalThis.__omniSharedCoordinator?.runtimeCounts().activeGeneration,
          1,
          "only running owner holds SQL capacity"
        );
        assert.equal(
          globalThis.__omniSharedCoordinator?.runtimeCounts().queuedGeneration,
          0,
          "legacy queued follower does not wait for SQL while occupying legacy queue"
        );
        if (mode === "abort")
          controller.abort(new DOMException("queued caller cancelled", "AbortError"));
        const response = await follower;
        assert.equal(response.status, mode === "abort" ? 499 : 503);
        await response.text();
        releaseOwner();
        await (await owner).text();
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(sends, 1);
        assert.equal(followerBudget.snapshot().attempts, 0);
        assert.equal(globalThis.__omniSharedCoordinator?.runtimeCounts().activeGeneration, 0);
        assert.equal(globalThis.__omniSharedCoordinator?.runtimeCounts().queuedGeneration, 0);
      } finally {
        releaseOwner();
        await Promise.allSettled(
          [owner, follower].map(async (pending) => {
            const r = await pending;
            if (!r.bodyUsed) await r.body?.cancel();
          })
        );
      }
    }
  );
