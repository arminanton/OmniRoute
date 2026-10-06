import assert from "node:assert/strict";
import test from "node:test";
import {
  getCodexBillingMetadata,
  getCodexLifecycleNotice,
} from "../../src/lib/codexBillingMetadata.ts";
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

test("generated Claude effort routes inherit their base rate but exact overrides win", () => {
  const row = { id: "gh/claude-opus-4.6-high", owned_by: "github", root: "claude-opus-4.6-high" };
  const base = { input: 5, output: 25, cached: 0.5 };
  assert.deepEqual(
    enrichCatalogModelEntry(row, undefined, {
      modelsDevPricing: null,
      effectivePricing: { github: { "claude-opus-4.6": base } },
    }).pricing,
    base
  );
  assert.deepEqual(
    enrichCatalogModelEntry(row, undefined, {
      modelsDevPricing: null,
      effectivePricing: {
        github: { "claude-opus-4.6": base },
        gh: { "claude-opus-4.6-high": { input: 0, output: 1 } },
      },
    }).pricing,
    { input: 0, output: 1 }
  );
});

test("arbitrary suffixes do not invent billing identities", () => {
  assert.equal(
    enrichCatalogModelEntry(
      { id: "unknown/custom-high", owned_by: "unknown", root: "custom-high" },
      undefined,
      {
        modelsDevPricing: null,
        effectivePricing: { unknown: { custom: { input: 1, output: 2 } } },
      }
    ).pricing,
    undefined
  );
});

test("Codex catalog separates paid credits, allowance metering and dollar token-value estimates", () => {
  const entry = enrichCatalogModelEntry({
    id: "cx/gpt-6-astra-high",
    owned_by: "codex",
    root: "gpt-6-astra-high",
    context_length: 872000,
  });
  const billing = entry.billing_metadata as NonNullable<ReturnType<typeof getCodexBillingMetadata>>;
  assert.equal(billing.credit_rates.unit, "credits_per_million_tokens");
  assert.equal(billing.credit_rates.input, 250);
  assert.equal(billing.speed_metering.fast.included_allowance_multiplier, 2.5);
  assert.equal(billing.speed_metering.fast.purchased_credit_multiplier, 2);
  assert.equal(billing.speed_metering.ultrafast.included_allowance_multiplier, 8);
  assert.equal(billing.speed_metering.ultrafast.purchased_credit_multiplier, 6);
  assert.match(billing.dollar_pricing_basis, /not_subscription_invoice/);
  assert.equal(entry.context_length, 872000);
});

test("public retirement notices label but never remove account-discovered Codex routes", () => {
  const entry = enrichCatalogModelEntry({
    id: "cx/gpt-5.3-codex-spark",
    owned_by: "codex",
    root: "gpt-5.3-codex-spark",
  });
  assert.equal(entry.id, "cx/gpt-5.3-codex-spark");
  assert.equal(
    (entry.lifecycle_notice as NonNullable<ReturnType<typeof getCodexLifecycleNotice>>)
      .chatgpt_retirement_date,
    "2026-09-14"
  );
  assert.equal(
    (entry.lifecycle_notice as NonNullable<ReturnType<typeof getCodexLifecycleNotice>>).authority,
    "public_notice_not_account_entitlement"
  );
  assert.equal(entry.max_output_tokens, undefined);
});
