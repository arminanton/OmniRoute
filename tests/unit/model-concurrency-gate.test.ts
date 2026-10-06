import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, describe, it } from "node:test";
import {
  formatModelConcurrencyOverrides,
  withModelConcurrencyOverride,
} from "../../src/domain/types.ts";

const modalSource = readFileSync(
  new URL(
    "../../src/app/(dashboard)/dashboard/providers/[id]/components/modals/EditConnectionModal.tsx",
    import.meta.url
  ),
  "utf8"
);
const rateLimitManager = await import("../../open-sse/services/rateLimitManager.ts");
const { acquireMany, getStats, resetAll } =
  await import("../../open-sse/services/accountSemaphore.ts");
const chatCoreSource = readFileSync(
  new URL("../../open-sse/handlers/chatCore.ts", import.meta.url),
  "utf8"
);
const connectionId = "model-concurrency-gate-unit-test";
after(() => {
  rateLimitManager.refreshConnectionRateLimits(connectionId, null);
  resetAll();
});

describe("model concurrency overrides", () => {
  it("hydrates and saves existing per-model caps without dropping them", () => {
    const existing = { "gpt-4o": 3, "claude-sonnet-4": 2 };
    const formValue = formatModelConcurrencyOverrides(existing);
    const saved = withModelConcurrencyOverride({ rpm: 120 }, formValue);

    assert.deepEqual(saved, { rpm: 120, modelConcurrency: existing });
    assert.match(
      modalSource,
      /modelConcurrency:\s*formatModelConcurrencyOverrides\(\s*connection\.rateLimitOverrides\?\.modelConcurrency/
    );
    assert.match(
      modalSource,
      /withModelConcurrencyOverride\(scalarOverrides,\s*formData\.modelConcurrency\)/
    );
  });

  it("sets valid limits, clears on blank, and rejects out-of-range limits", () => {
    const set = withModelConcurrencyOverride({ rpm: 60 }, '{"gpt-4o": 4}');
    rateLimitManager.refreshConnectionRateLimits(connectionId, set);
    assert.equal(rateLimitManager.getModelConcurrencyLimit(connectionId, "gpt-4o"), 4);

    const cleared = withModelConcurrencyOverride({ rpm: 60 }, "");
    rateLimitManager.refreshConnectionRateLimits(connectionId, cleared);
    assert.equal(rateLimitManager.getModelConcurrencyLimit(connectionId, "gpt-4o"), null);

    for (const invalid of ['{"gpt-4o": 0}', '{"gpt-4o": 10001}', '{"gpt-4o": 1.5}']) {
      assert.throws(
        () => withModelConcurrencyOverride({}, invalid),
        /integer limits from 1 to 10,000/
      );
    }
  });
});

describe("model concurrency admission", () => {
  function requirements(model: string, modelLimit = 1) {
    return [
      { key: "global", maxConcurrency: 2 },
      { key: "provider:model-concurrency-test", maxConcurrency: 2 },
      { key: `account:${connectionId}`, maxConcurrency: 2 },
      {
        key: `model:${JSON.stringify([connectionId, model])}`,
        maxConcurrency: modelLimit,
      },
    ];
  }

  it("enforces the configured cap and admits queued work after release", async () => {
    const modelKey = `model:${JSON.stringify([connectionId, "gpt-4o"])}`;
    const firstRelease = await acquireMany(requirements("gpt-4o"), {
      timeoutMs: 500,
      maxQueueSize: 2,
    });
    const secondRequest = acquireMany(requirements("gpt-4o"), {
      timeoutMs: 500,
      maxQueueSize: 2,
    });
    assert.equal(getStats()[modelKey].running, 1);
    assert.equal(getStats()[modelKey].queued, 1);

    firstRelease();
    const secondRelease = await secondRequest;
    assert.equal(getStats()[modelKey].running, 1);
    secondRelease();
    assert.equal(getStats()[modelKey].running, 0);
  });

  it("keeps distinct model keys independent under shared global/provider/account caps", async () => {
    const firstRelease = await acquireMany(requirements("gpt-4o"), {
      timeoutMs: 500,
      maxQueueSize: 2,
    });
    const secondRelease = await acquireMany(requirements("claude-sonnet-4"), {
      timeoutMs: 500,
      maxQueueSize: 2,
    });
    assert.equal(getStats()[`model:${JSON.stringify([connectionId, "gpt-4o"])}`].running, 1);
    assert.equal(
      getStats()[`model:${JSON.stringify([connectionId, "claude-sonnet-4"])}`].running,
      1
    );
    firstRelease();
    secondRelease();
  });

  it("feeds the configured model limit into the request admission gates", () => {
    assert.match(chatCoreSource, /getModelConcurrencyLimit\(attemptConnectionId, modelToCall\)/);
    assert.match(
      chatCoreSource,
      /key: `model:\$\{JSON\.stringify\(\[attemptConnectionId, modelToCall\]\)\}`,\s*maxConcurrency: modelConcurrencyLimit/
    );
  });
});
