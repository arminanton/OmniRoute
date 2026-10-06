import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-pricing-catalog-"));
process.env.DATA_DIR = dataDir;
const core = await import("../../src/lib/db/core.ts");
const { enrichCatalogModelEntry } = await import("../../src/lib/modelMetadataRegistry.ts");
test.after(() => {
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("effective operator prices override upstream entry rates, including explicit zero", () => {
  const entry = enrichCatalogModelEntry(
    { id: "cx/gpt-5.5", owned_by: "codex", root: "gpt-5.5", pricing: { input: 999 } },
    undefined,
    {
      modelsDevPricing: null,
      effectivePricing: {
        cx: { "gpt-5.5": { input: 0, output: 7, cached: 0.25, cache_creation: 3 } },
      },
    }
  );
  assert.deepEqual(entry.pricing, { input: 0, output: 7, cached: 0.25, cache_creation: 3 });
});
test("no-thinking gateways inherit underlying output limits and billing rates", () => {
  const entry = enrichCatalogModelEntry(
    { id: "no-think/cx/gpt-5.5", owned_by: "codex", root: "no-think/gpt-5.5" },
    undefined,
    {
      modelsDevPricing: null,
      effectivePricing: { codex: { "gpt-5.5": { input: 2, output: 10 } } },
    }
  );
  assert.equal(entry.root, "no-think/gpt-5.5");
  assert.equal(entry.max_output_tokens, 128000);
  assert.deepEqual(entry.pricing, { input: 2, output: 10 });
});
test("unknown pricing is not synthesized as a free model", () => {
  const entry = enrichCatalogModelEntry(
    { id: "unknown/future", owned_by: "unknown", root: "future" },
    undefined,
    { modelsDevPricing: null, effectivePricing: {} }
  );
  assert.equal(entry.pricing, undefined);
});

test("GPT-6 output metadata preserves the discovered 872K context", () => {
  for (const model of [
    "gpt-6-astra",
    "gpt-6-sol-medium",
    "gpt-6-luna-xhigh",
    "gpt-6.1-sol-ultra",
  ]) {
    const entry = enrichCatalogModelEntry({
      id: `cx/${model}`,
      owned_by: "codex",
      root: model,
      context_length: 872000,
    });
    assert.equal(entry.context_length, 872000);
    assert.equal(entry.max_output_tokens, 128000);
  }
});
