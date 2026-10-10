import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { useDecollidedMigrationsDir } from "./helpers/decollidedMigrationsDir.ts";
import { createChatPipelineHarness } from "../integration/_chatPipelineHarness.ts";
useDecollidedMigrationsDir();
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error("unexpected network in queued AG fixture");
};
const originalPostUsageDelay = process.env.PROVIDER_LIMITS_POST_USAGE_REFRESH_DELAY_MS;
process.env.PROVIDER_LIMITS_POST_USAGE_REFRESH_DELAY_MS = String(60 * 60 * 1000);
const harness = await createChatPipelineHarness("agy-queued-cooldown");
const { updateProviderConnection } = await import("../../src/lib/db/providers.ts");
const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.ts");
const { buildAntigravityModelCooldownKey } =
  await import("../../open-sse/services/coordination/antigravityModelCooldown.ts");
const { clearAllModelLockouts } = await import("../../open-sse/services/accountFallback.ts");
const rate = await import("../../open-sse/services/rateLimitManager.ts");
process.env.OMNI_SHARED_ADMISSION = "true";
process.env.OMNI_COORDINATION_DB = path.join(process.env.DATA_DIR!, "coordination.sqlite");
test.after(async () => {
  try {
    await rate.__resetRateLimitManagerForTests();
    clearAllModelLockouts();
    globalThis.__omniSharedCoordinator?.close();
    globalThis.__omniSharedCoordinator = undefined;
    const { flushProxyLogsSync } = await import("../../src/lib/proxyLogger.ts");
    flushProxyLogsSync();
    await harness.cleanup();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalPostUsageDelay === undefined)
      delete process.env.PROVIDER_LIMITS_POST_USAGE_REFRESH_DELAY_MS;
    else process.env.PROVIDER_LIMITS_POST_USAGE_REFRESH_DELAY_MS = originalPostUsageDelay;
  }
});

test(
  "already-selected AG follower does not send after owner publishes exact-model429 cooldown",
  { timeout: 12000 },
  async (t) => {
    await harness.resetStorage();
    await harness.settingsDb.updateSettings({
      compression: { enabled: false },
      resilienceSettings: {
        quotaPreflight: { enabled: false },
        waitForCooldown: { enabled: false },
        requestQueue: { maxWaitMs: 3000, maxQueueDepth: 16, globalConcurrentRequests: 0 },
      },
    });
    const connection = await harness.seedConnection("antigravity", {
      name: "synthetic-AG-max1",
      apiKey: "synthetic",
      providerSpecificData: { projectId: "synthetic-project", quotaAdaptiveAdmission: false },
    });
    await updateProviderConnection(connection.id, { maxConcurrent: 1 });
    const request = (name: string, model = "antigravity/gemini-3.8-flash-high") =>
      harness.buildRequest({
        headers: { "x-omniroute-connection": connection.id },
        body: {
          model,
          stream: false,
          messages: [{ role: "user", content: name }],
        },
      });
    let warm = true,
      sends = 0,
      entered: () => void = () => {},
      releaseOwner: () => void = () => {};
    const enteredOwner = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      release = new Promise<void>((resolve) => {
        releaseOwner = resolve;
      });
    t.mock.method(AntigravityExecutor.prototype, "execute", async () => {
      if (warm)
        return {
          response: harness.buildGeminiResponse("warm"),
          url: "https://synthetic.invalid",
          headers: {},
          transformedBody: {},
        };
      sends++;
      if (sends === 1) {
        entered();
        await release;
        return {
          response: Response.json(
            {
              error: {
                code: 429,
                status: "RESOURCE_EXHAUSTED",
                message: "Individual quota reached",
              },
            },
            { status: 429, headers: { "retry-after": "60" } }
          ),
          url: "https://synthetic.invalid",
          headers: {},
          transformedBody: {},
        };
      }
      return {
        response: harness.buildGeminiResponse("follower incorrectly sent"),
        url: "https://synthetic.invalid",
        headers: {},
        transformedBody: {},
      };
    });
    const warmed = await harness.handleChat(request("warm"));
    await warmed.text();
    assert.equal(warmed.status, 200);
    warm = false;
    rate.enableRateLimitProtection(connection.id);
    rate.refreshConnectionRateLimits(connection.id, { maxConcurrent: 1, minTime: 0 });
    const db = new DatabaseSync(process.env.OMNI_COORDINATION_DB!, { readOnly: true });
    let owner: Promise<Response> | undefined, follower: Promise<Response> | undefined;
    try {
      owner = harness.handleChat(request("owner"));
      await enteredOwner;
      follower = harness.handleChat(request("follower"));
      const start = Date.now();
      let queued = false;
      let queueEvidence = { sharedWaiters: 0, bottleneckQueued: 0, bottleneckKey: "" };
      while (Date.now() - start < 1500) {
        const count = Number(
          db.prepare("SELECT COUNT(*) n FROM coordination_waiters").get()?.n ?? 0
        );
        const limiter = await rate.__getLimiterStateForTests(
          "antigravity",
          connection.id,
          "gemini-3.8-flash-high"
        );
        const rateQueued = limiter?.queued ?? 0;
        queueEvidence = {
          sharedWaiters: count,
          bottleneckQueued: rateQueued,
          bottleneckKey: limiter?.key ?? "",
        };
        if (count > 0 || rateQueued > 0) {
          queued = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.ok(
        queued,
        `follower must already be selected/queued before owner429: ${JSON.stringify(queueEvidence)}`
      );
      releaseOwner();
      const responses = await Promise.all([owner, follower]);
      const bodies = await Promise.all(responses.map((response) => response.text()));
      assert.equal(responses[0].status, 429);
      assert.equal(
        sends,
        1,
        `queued same-model follower must not send during known cooldown: ${JSON.stringify(queueEvidence)}`
      );
      assert.equal(globalThis.__omniSharedCoordinator?.runtimeCounts().activeGeneration, 0);
      assert.equal(globalThis.__omniSharedCoordinator?.runtimeCounts().queuedGeneration, 0);
      const activeCooldownKey = buildAntigravityModelCooldownKey(
        connection.id,
        "gemini-3.8-flash-high",
        "active"
      );
      assert.ok(activeCooldownKey);
      const activeCooldown = db
        .prepare("SELECT until_ms FROM coordination_blocks WHERE resource=?")
        .get(activeCooldownKey);
      assert.ok(Number(activeCooldown?.until_ms) > Date.now());
      assert.equal(responses[1].status, 429, bodies[1]);

      // Exact-model cooldown must not freeze healthy siblings on the same account.
      const sibling = await harness.handleChat(
        request("healthy sibling", "antigravity/claude-sonnet-4-6")
      );
      assert.equal(sibling.status, 200, await sibling.text());
      assert.equal(sends, 2);
    } finally {
      releaseOwner();
      const settled = await Promise.allSettled(
        [owner, follower].filter((x): x is Promise<Response> => !!x)
      );
      for (const result of settled) {
        if (result.status === "fulfilled") await result.value.text().catch(() => {});
      }
      db.close();
    }
  }
);
