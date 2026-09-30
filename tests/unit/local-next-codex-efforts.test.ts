import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCodexModelsResponse,
  normalizeCodexReasoningLevels,
  buildCodexDiscoveryCatalog,
  reconcileCuratedCodexCatalog,
} from "../../src/app/api/providers/[id]/models/discovery/codex.ts";
import { splitCodexReasoningSuffix } from "../../open-sse/executors/codex/reasoningSuffix.ts";
import { CodexExecutor } from "../../open-sse/executors/codex.ts";
import { openaiToOpenAIResponsesRequest } from "../../open-sse/translator/request/openai-responses/toResponses.ts";

const fixture = { models: [{
  slug: "gpt-6-astra", display_name: "Astra",
  supported_reasoning_levels: ["low", { effort: "medium" }, { effort: "max" }, "ultra", "low", {}, "bogus"],
}] };

test("Codex efforts normalize object/string metadata and cached expansion is idempotent", () => {
  assert.deepEqual(normalizeCodexReasoningLevels(fixture.models[0].supported_reasoning_levels), ["low", "medium", "max", "ultra"]);
  const parsed = normalizeCodexModelsResponse(fixture);
  const first = buildCodexDiscoveryCatalog(parsed, []);
  const second = buildCodexDiscoveryCatalog(first, []);
  assert.deepEqual(second, first);
  assert.deepEqual(first.map((m) => m.id), ["gpt-6-astra", "gpt-6-astra-low", "gpt-6-astra-medium", "gpt-6-astra-max", "gpt-6-astra-ultra"]);
  assert.equal(first.some((m) => m.id.includes("low-low")), false);
});

test("Codex excluded/hidden/future rows cannot seed aliases and candidates stay separate", () => {
  const parsed = normalizeCodexModelsResponse({ models: [
    ...fixture.models,
    { slug: "hidden", visibility: "hide", supported_reasoning_levels: ["low"] },
    { slug: "unsupported", supported_in_api: false, supported_reasoning_levels: ["low"] },
    { slug: "future", minimal_client_version: "9999.0.0", supported_reasoning_levels: ["low"] },
    { slug: "gpt-5.4", supported_reasoning_levels: ["low"] },
  ] });
  assert.deepEqual(parsed.map((m) => m.id), ["gpt-6-astra", "gpt-5.4"]);
  assert.equal(buildCodexDiscoveryCatalog(parsed, []).some((m) => m.id.startsWith("gpt-5.4")), false);
  assert.deepEqual(buildCodexDiscoveryCatalog(parsed, [], [() => false]), []);
  const curated = reconcileCuratedCodexCatalog(normalizeCodexModelsResponse(fixture), []);
  assert.deepEqual(curated.models, []);
  assert.equal(curated.candidateModels.length, 5);
});

test("Astra max/ultra suffixes and explicit efforts dispatch wire max, not xhigh", () => {
  const executor = new CodexExecutor();
  for (const suffix of ["-max", "-ultra", "(max)", "(ultra)"]) {
    const model = `gpt-6-astra${suffix}`;
    assert.equal(splitCodexReasoningSuffix(model).baseModel, "gpt-6-astra");
    const result = executor.transformRequest(model, { model, input: [] }, false, { requestEndpointPath: "/responses" });
    assert.equal(result.model, "gpt-6-astra");
    assert.equal(result.reasoning.effort, "max");
  }
  for (const effort of ["max", "ultra"]) {
    const result = executor.transformRequest("gpt-6-astra", { input: [], reasoning_effort: effort }, false, { requestEndpointPath: "/responses" });
    assert.equal(result.reasoning.effort, "max");
  }
});


test("Astra Chat→Responses translation retains native max before executor", () => {
  const model = "gpt-6-astra";
  const translated = openaiToOpenAIResponsesRequest(model, {
    model, messages: [{ role: "user", content: "test" }], reasoning_effort: "max",
  }, true, {});
  const result = new CodexExecutor().transformRequest(model, translated, true, {
    requestEndpointPath: "/chat/completions",
  });
  assert.equal(result.reasoning.effort, "max");
});
