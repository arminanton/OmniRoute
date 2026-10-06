import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { useDecollidedMigrationsDir } from "./helpers/decollidedMigrationsDir.ts";
import { createChatPipelineHarness } from "../integration/_chatPipelineHarness.ts";
useDecollidedMigrationsDir();
const original = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error("unexpected network in private settings fixture");
};
const harness = await createChatPipelineHarness("direct-model-settings");
const { updateProviderConnection } = await import("../../src/lib/db/providers.ts");
const { acquireSharedSemaphore } =
  await import("../../open-sse/services/coordination/sharedSemaphore.ts");
process.env.OMNI_SHARED_ADMISSION = "true";
process.env.OMNI_COORDINATION_DB = path.join(process.env.DATA_DIR!, "coordination.sqlite");
test.after(async () => {
  globalThis.__omniSharedCoordinator?.close();
  globalThis.__omniSharedCoordinator = undefined;
  const { flushProxyLogsSync } = await import("../../src/lib/proxyLogger.ts");
  flushProxyLogsSync();
  await harness.cleanup();
  globalThis.fetch = original;
});

test(
  "actual direct model dispatch forwards configured90s queue settings to Core rather than default15s",
  { timeout: 15000 },
  async () => {
    await harness.resetStorage();
    await harness.settingsDb.updateSettings({
      compression: { enabled: false },
      resilienceSettings: {
        quotaPreflight: { enabled: false },
        waitForCooldown: { enabled: false },
        requestQueue: { maxWaitMs: 90000, maxQueueDepth: 256, globalConcurrentRequests: 0 },
      },
    });
    const connection = await harness.seedConnection("openai", {
      name: "synthetic-direct-settings",
      apiKey: "synthetic",
      providerSpecificData: { quotaAdaptiveAdmission: false },
    });
    await updateProviderConnection(connection.id, { maxConcurrent: 1 });
    let sends = 0;
    globalThis.fetch = async () => {
      sends++;
      return harness.buildOpenAIResponse("synthetic settings response");
    };
    const request = () =>
      harness.buildRequest({
        body: {
          model: "openai/gpt-4.1",
          stream: false,
          messages: [{ role: "user", content: "private settings fixture" }],
        },
      });
    // Warm lazy modules before holding a shared permit. Subsequent JSON differs to avoid dedup/cache.
    await (
      await harness.handleChat(
        harness.buildRequest({
          body: {
            model: "openai/gpt-4.1",
            stream: false,
            messages: [{ role: "user", content: "warm private fixture" }],
          },
        })
      )
    ).text();
    sends = 0;
    const release = await acquireSharedSemaphore(
      [{ key: `openai:${connection.id}`, maxConcurrency: 1 }],
      { timeoutMs: 1000, onLeaseLost() {} }
    );
    const db = new DatabaseSync(process.env.OMNI_COORDINATION_DB!, { readOnly: true });
    let pending: Promise<Response> | undefined;
    try {
      const started = Date.now();
      pending = harness.handleChat(request());
      let expires = 0;
      while (Date.now() - started < 3000) {
        const rows = db
          .prepare("SELECT resources,expires FROM coordination_waiters")
          .all() as Array<{ resources: string; expires: number }>;
        const row = rows.find((item) =>
          JSON.parse(item.resources).some(
            (requirement: { key: string }) => requirement.key === `openai:${connection.id}`
          )
        );
        if (row) {
          expires = row.expires;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(expires, "Core must actually enqueue behind the held account permit");
      assert.ok(
        expires - started >= 89000 && expires - started < 93000,
        `actual Core queue expiry must reflect operator90s, observed${expires - started}`
      );
      release();
      const response = await pending;
      assert.equal(response.status, 200);
      assert.match(await response.text(), /synthetic settings response/);
      assert.equal(sends, 1);
    } finally {
      release();
      await pending?.then(
        (response) => (!response.bodyUsed ? response.body?.cancel() : undefined),
        () => {}
      );
      db.close();
    }
  }
);
