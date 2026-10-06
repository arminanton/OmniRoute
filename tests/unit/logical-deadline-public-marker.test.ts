import test from "node:test";
import assert from "node:assert/strict";
import { useDecollidedMigrationsDir } from "./helpers/decollidedMigrationsDir.ts";
import { createChatPipelineHarness } from "../integration/_chatPipelineHarness.ts";
import {
  LogicalRetryBudget,
  runWithLogicalRetryBudget,
  budgetedGenerationFetch,
  isLogicalRetryBudgetError,
} from "../../open-sse/services/logicalRetryBudget.ts";
import { isUncertainGenerationAcceptance } from "../../open-sse/services/generationReplay.ts";
useDecollidedMigrationsDir();
const original = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error("Unexpected network in private deadline fixture");
};
const harness = await createChatPipelineHarness("logical-deadline-public");
const { getProviderConnectionById } = await import("../../src/lib/db/providers.ts");
test.after(async () => {
  const { flushProxyLogsSync } = await import("../../src/lib/proxyLogger.ts");
  flushProxyLogsSync();
  await harness.cleanup();
  globalThis.fetch = original;
});

for (const stream of [false, true])
  test(`actual ChatCore ${stream ? "SSE" : "JSON"} deadline after unknown POST acceptance stays terminal to clients`, async () => {
    await harness.resetStorage();
    const first = await harness.seedConnection("openai", {
      name: "synthetic-first",
      apiKey: "synthetic-first",
    });
    const second = await harness.seedConnection("openai", {
      name: "synthetic-second",
      apiKey: "synthetic-second",
    });
    // Load lazy pipeline modules before starting the deliberately short request deadline.
    globalThis.fetch = async () => harness.buildOpenAIResponse("private fixture warmup");
    await (
      await harness.handleChat(
        harness.buildRequest({
          body: {
            model: "openai/gpt-4.1",
            messages: [{ role: "user", content: "private warmup fixture" }],
            stream: false,
          },
        })
      )
    ).text();
    let sends = 0;
    globalThis.fetch = budgetedGenerationFetch(async (_input, options) => {
      sends++;
      return new Promise<Response>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
          once: true,
        });
      });
    });
    const budget = new LogicalRetryBudget(12, Date.now() + 500);
    const response = await runWithLogicalRetryBudget(budget, () =>
      harness.handleChat(
        harness.buildRequest({
          body: {
            model: "openai/gpt-4.1",
            messages: [{ role: "user", content: "synthetic benign fixture" }],
            stream,
          },
        })
      )
    );
    assert.equal(sends, 1);
    for (const id of [first.id, second.id]) {
      const connection = await getProviderConnectionById(id);
      assert.equal(connection?.lastError ?? null, null);
      assert.equal(connection?.rateLimitedUntil ?? null, null);
    }
    assert.equal(response.status, 502);
    const raw = await response.text();
    assert.match(raw, /upstream_acceptance_uncertain/);
    assert.doesNotMatch(raw, /logical_retry_budget|server_is_overloaded/);
    assert.throws(
      () => budget.consumeAttempt(),
      (error) => isLogicalRetryBudgetError(error) && isUncertainGenerationAcceptance(error)
    );
  });
