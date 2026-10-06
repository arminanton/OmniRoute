import assert from "node:assert/strict";
import test from "node:test";

import { anthropicProvider } from "../../open-sse/config/providers/registry/anthropic/index.ts";
import { bedrockProvider } from "../../open-sse/config/providers/registry/bedrock/index.ts";
import { vertexProvider } from "../../open-sse/config/providers/registry/vertex/index.ts";
import { MODEL_SPECS } from "../../src/shared/constants/modelSpecs.ts";
import { DEFAULT_PRICING_FRONTIER } from "../../src/shared/constants/pricing/frontier-labs.ts";

const MODEL_ID = "claude-opus-5-5";

test("Claude Opus 5.5 catalogs use verified IDs and token limits", () => {
  for (const [provider, id] of [
    [anthropicProvider, MODEL_ID],
    [bedrockProvider, `anthropic.${MODEL_ID}`],
    [vertexProvider, MODEL_ID],
  ] as const) {
    const model = provider.models.find((entry) => entry.id === id);
    assert.ok(model, `${provider.id} must expose ${id}`);
    assert.equal(model.contextLength, 1_000_000);
    assert.equal(model.maxOutputTokens, 128_000);
  }

  assert.equal(
    vertexProvider.models.find((entry) => entry.id === MODEL_ID)?.targetFormat,
    "claude"
  );
});

test("Claude Opus 5.5 model spec reflects documented adaptive reasoning", () => {
  const spec = MODEL_SPECS[MODEL_ID];
  assert.equal(spec.contextWindow, 1_000_000);
  assert.equal(spec.maxOutputTokens, 128_000);
  assert.equal(spec.defaultReasoningEffort, "medium");
  assert.equal(spec.adaptiveThinkingOnly, true);
  assert.equal(spec.rejectsThinkingDisabled, true);
  assert.equal(spec.rejectsForcedToolChoice, true);
  assert.ok(spec.aliases?.includes("au.anthropic.claude-opus-5-5"));
  assert.ok(spec.aliases?.includes("jp.anthropic.claude-opus-5-5"));
});

test("Claude Opus 5.5 pricing includes only verified provider rates", () => {
  const anthropicPricing = DEFAULT_PRICING_FRONTIER.anthropic[MODEL_ID];
  assert.equal(anthropicPricing.input, 4);
  assert.equal(anthropicPricing.output, 20);
  assert.equal(DEFAULT_PRICING_FRONTIER.vertex?.[MODEL_ID], undefined);
  assert.equal(Object.hasOwn(DEFAULT_PRICING_FRONTIER, "bedrock"), false);
});
