/**
 * Opt-in live catalog contract. This file is outside the unit-test globs.
 * It contacts https://models.dev/api.json. It does not start periodic sync or write catalog data.
 *
 * Run only when live network access is separately approved, from the project root:
 * RUN_MODELS_DEV_LIVE=1 DISABLE_SQLITE_AUTO_BACKUP=true node --import tsx/esm \
 *   --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts \
 *   --test --test-concurrency=1 tests/live/models-dev-catalog.live.test.ts
 *
 * An invocation without opt-in fails before importing the catalog fetcher; it is not a skip.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

if (process.env.RUN_MODELS_DEV_LIVE !== "1") {
  throw new Error(
    "Live models.dev catalog checks require RUN_MODELS_DEV_LIVE=1 and explicit network approval. " +
      "Run only tests/live/models-dev-catalog.live.test.ts with the command above."
  );
}

const { fetchModelsDev } = await import("../../src/lib/modelsDevSync.ts");

describe("modelsDevSync — fetchModelsDev (live API)", () => {
  it("fetches data from models.dev API", async () => {
    const data = await fetchModelsDev();
    assert.ok(typeof data === "object", "data should be an object");

    const providerCount = Object.keys(data).length;
    assert.ok(providerCount >= 100, `should have 100+ providers, got ${providerCount}`);

    let modelCount = 0;
    for (const provider of Object.values(data)) {
      const p = provider;
      if (p.models) {
        modelCount += Object.keys(p.models).length;
      }
    }
    assert.ok(modelCount >= 4000, `should have 4000+ models, got ${modelCount}`);
  });

  it("returns cached data on second call", async () => {
    const data1 = await fetchModelsDev();
    const data2 = await fetchModelsDev();
    assert.strictEqual(data1, data2, "should return same cached reference");
  });

  it("has openai provider with gpt-4o model", async () => {
    const data = await fetchModelsDev();
    assert.ok(data.openai, "openai provider should exist");
    assert.ok(data.openai.models["gpt-4o"], "gpt-4o model should exist");
  });

  it("has anthropic provider with claude models", async () => {
    const data = await fetchModelsDev();
    assert.ok(data.anthropic, "anthropic provider should exist");
    const claudeModels = Object.keys(data.anthropic.models).filter((m) => m.includes("claude"));
    assert.ok(claudeModels.length > 0, "should have claude models");
  });
});
