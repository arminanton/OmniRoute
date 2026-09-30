import test from "node:test";
import assert from "node:assert/strict";
import {
  expandAntigravityClaudeEffortModels,
  getAntigravityClaudeThinkingLevel,
} from "../../open-sse/config/antigravityClaudeEffort.ts";
import { normalizeAntigravityModelsResponse, mapAntigravityModelForClient } from "../../src/app/api/providers/[id]/models/discovery/normalizers.ts";
import { normalizeDiscoveredModels } from "../../src/lib/providerModels/modelDiscovery.ts";
import { normalizeSyncedAvailableModels } from "../../src/lib/db/models/synced.ts";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.ts";
import { openaiToAntigravityRequest } from "../../open-sse/translator/request/openai-to-gemini.ts";

class AccountFixtureExecutor extends AntigravityExecutor {
  protected async supportsAdaptiveClaudeForConnection(model: string, connectionId?: string) {
    return connectionId === "adaptive-account" && model.includes("claude-sonnet-4-6");
  }
}
const message = { messages: [{ role: "user", content: "test" }] };
const credentials = { projectId: "fixture-project", connectionId: "adaptive-account" };

test("authenticated ModelDetails capability survives discovery/mapping/persistence; no generic inference", () => {
  for (const value of [true, false, "true", undefined]) {
    const models = normalizeAntigravityModelsResponse({ models: {
      "claude-sonnet-4-6": { displayName: "Sonnet", supportsAdaptiveThinking: value, supportedThinkingEfforts: ["low", "medium", "high"] },
    } }).map((m) => mapAntigravityModelForClient(m, "agy"));
    const expanded = expandAntigravityClaudeEffortModels(models);
    const normalized = normalizeDiscoveredModels(expanded, "agy");
    const persisted = normalizeSyncedAvailableModels(normalized, "agy");
    assert.equal(persisted.length, value === true ? 4 : 1);
    assert.equal(persisted[0].supportsAdaptiveThinking, value === true ? true : undefined);
    assert.deepEqual(expandAntigravityClaudeEffortModels(expanded), expanded);
  }
  const custom = normalizeDiscoveredModels([{ id: "claude-sonnet-4-6", supportsAdaptiveThinking: true }], "openai");
  assert.equal(custom[0].supportsAdaptiveThinking, undefined);
});

test("selected Claude low/medium/high aliases serialize actual level-only wire config", async () => {
  for (const effort of ["low", "medium", "high"]) {
    const model = `claude-sonnet-4-6-${effort}`;
    const translated = openaiToAntigravityRequest(model, message, true, credentials);
    const result = await new AccountFixtureExecutor().transformRequest(model, translated, true, credentials);
    assert.ok(!(result instanceof Response));
    assert.equal(result.model, "claude-sonnet-4-6");
    const config = result.request.generationConfig as Record<string, unknown>;
    assert.deepEqual(config.thinkingConfig, { thinkingLevel: effort.toUpperCase() });
    assert.equal(result.output_config, undefined);
    assert.equal(result.reasoning_effort, undefined);
  }
});

test("explicit caller effort wins over alias before base mapping", async () => {
  const model = "claude-sonnet-4-6-high";
  const translated = openaiToAntigravityRequest(model, { ...message, reasoning_effort: "low" }, true, credentials);
  const result = await new AccountFixtureExecutor().transformRequest(model, translated, true, credentials);
  assert.ok(!(result instanceof Response));
  assert.deepEqual((result.request.generationConfig as Record<string, unknown>).thinkingConfig, { thinkingLevel: "LOW" });
  assert.equal(getAntigravityClaudeThinkingLevel(model, { reasoning: { effort: "medium" } }), "MEDIUM");
  assert.equal(getAntigravityClaudeThinkingLevel(model, { reasoning_effort: "unsupported" }), null);
});

test("missing/different-account capability rejects aliases but preserves ordinary Claude stripping", async () => {
  const executor = new AccountFixtureExecutor();
  const model = "claude-sonnet-4-6-low";
  const translated = openaiToAntigravityRequest(model, message, true, credentials);
  const rejected = await executor.transformRequest(model, translated, true, { ...credentials, connectionId: "other-account" });
  assert.ok(rejected instanceof Response);
  assert.equal(rejected.status, 400);
  for (const base of ["claude-sonnet-4-6", "claude-sonnet-4-5"]) {
    const result = await executor.transformRequest(base, {
      output_config: { effort: "high" }, reasoning_effort: "high",
      request: { contents: [{ role: "user", parts: [{ text: "test" }] }], generationConfig: { thinkingConfig: { thinkingLevel: "HIGH" } } },
    }, true, { ...credentials, connectionId: "other-account" });
    assert.ok(!(result instanceof Response));
    assert.equal((result.request.generationConfig as Record<string, unknown>).thinkingConfig, undefined);
    assert.equal(result.output_config, undefined);
  }
});

test("Claude effort propagation does not alter tool pairing/signatures; Gemini tier identity stays native", () => {
  const tools = { messages: [
    { role: "user", content: "use tool" },
    { role: "assistant", tool_calls: [{ id: "a", type: "function", function: { name: "terminal", arguments: "{}" }, thought_signature: "fixture-signature" }] },
    { role: "tool", tool_call_id: "a", name: "terminal", content: "" },
  ], tools: [{ type: "function", function: { name: "terminal", parameters: { type: "object", properties: {} } } }] };
  const base = openaiToAntigravityRequest("claude-sonnet-4-6", tools, true, credentials);
  const tier = openaiToAntigravityRequest("claude-sonnet-4-6-low", tools, true, credentials);
  assert.deepEqual(tier.request.contents, base.request.contents);
  assert.deepEqual(tier.request.tools, base.request.tools);
  assert.deepEqual(expandAntigravityClaudeEffortModels([{ id: "gemini-3.7-flash-low", name: "Gemini", supportsAdaptiveThinking: true }]).map((m) => m.id), ["gemini-3.7-flash-low"]);
});


test("unsupported explicit caller effort never falls back silently to alias effort", async () => {
  const model = "claude-sonnet-4-6-high";
  const translated = openaiToAntigravityRequest(model, { ...message, reasoning_effort: "unsupported" }, true, credentials);
  const result = await new AccountFixtureExecutor().transformRequest(model, translated, true, credentials);
  assert.ok(result instanceof Response);
  assert.equal(result.status, 400);
});
