import "../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { BaseExecutor } from "../../open-sse/executors/base.ts";
import { markUncertainGenerationAcceptance } from "../../open-sse/services/generationReplay.ts";
import { handleAntigravityFallbackChainError } from "../../open-sse/executors/antigravity/proFallbackChain.ts";

test("an uncertain generation failure cannot retry another BaseExecutor host", async () => {
  class FixtureExecutor extends BaseExecutor {
    constructor() {
      super("codex", { baseUrls: ["https://fixture.invalid/one", "https://fixture.invalid/two"] });
    }
    assertOutboundUrlAllowed() {}
    transformRequest(_model: string, body: unknown) {
      return body;
    }
  }
  const executor = new FixtureExecutor();
  const original = globalThis.fetch;
  let sends = 0;
  const failure = markUncertainGenerationAcceptance(new Error("connection ended after sending"));
  globalThis.fetch = async () => {
    sends++;
    throw failure;
  };
  try {
    await assert.rejects(
      executor.execute({
        model: "gpt-6.1-sol",
        body: { input: "synthetic" },
        stream: true,
        credentials: { apiKey: "synthetic" },
      }),
      (error) => error === failure
    );
    assert.equal(sends, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("Antigravity's model fallback chain preserves uncertain acceptance as a terminal error", () => {
  const failure = markUncertainGenerationAcceptance(new Error("acceptance unknown"));
  const input = { model: "gemini-3.1-pro-low", body: {}, stream: true, credentials: {} };
  const outcome = handleAntigravityFallbackChainError(
    input,
    failure,
    "first",
    0,
    ["first", "second"],
    null,
    "first"
  );
  assert.equal(outcome.action, "throw");
  if (outcome.action === "throw") assert.equal(outcome.error, failure);
});
