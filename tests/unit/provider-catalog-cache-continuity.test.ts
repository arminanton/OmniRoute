import "../_setup/isolateDataDir.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitCodexReasoningSuffix } from "../../open-sse/config/codexReasoningSuffix.ts";
import { buildCodexDiscoveryCatalog } from "../../src/app/api/providers/[id]/models/discovery/codex.ts";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.ts";

test("GPT-6.1 effort aliases expand only from advertised capabilities and decode correctly", () => {
  const catalog = buildCodexDiscoveryCatalog(
    [
      {
        id: "gpt-6.1-sol",
        name: "Sol",
        owned_by: "codex",
        apiFormat: "responses",
        supportedEndpoints: ["responses"],
        supportedThinkingEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        inputTokenLimit: 872000,
      },
    ],
    []
  );
  for (const effort of ["low", "medium", "high", "xhigh", "max", "ultra"]) {
    assert.ok(catalog.some((x) => x.id === `gpt-6.1-sol-${effort}`));
    assert.equal(splitCodexReasoningSuffix(`gpt-6.1-sol-${effort}`).baseModel, "gpt-6.1-sol");
  }
  assert.ok(!catalog.some((x) => x.id === "gpt-6.1-sol-none"));
  assert.equal(splitCodexReasoningSuffix("gpt-5.1-codex-max").baseModel, "gpt-5.1-codex-max");
});

test("Antigravity non-streaming usage preserves real cache hits and thinking tokens", async () => {
  const result = await new AntigravityExecutor().collectStreamToResponse(
    new Response(
      `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "OK" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 80, candidatesTokenCount: 7, thoughtsTokenCount: 3, totalTokenCount: 110 } } })}\n\n`
    ),
    "mock",
    "https://mock.invalid",
    {},
    {}
  );
  const usage = (await result.response.json()).usage;
  assert.equal(usage.prompt_tokens_details.cached_tokens, 80);
  assert.equal(usage.completion_tokens_details.reasoning_tokens, 3);
  assert.equal(usage.prompt_tokens, 100);
  assert.equal(usage.completion_tokens, 10);
  assert.equal(usage.total_tokens, 110);
});

test("newly discovered Codex model effort limits override legacy name-based clamps", async () => {
  const { replaceSyncedAvailableModelsForConnection } = await import("../../src/lib/db/models.ts");
  const { CodexExecutor } = await import("../../open-sse/executors/codex.ts");
  await replaceSyncedAvailableModelsForConnection("codex", "synthetic-new-model", [
    { id: "gpt-6.2-sol", name: "Future fixture", supportedThinkingEfforts: ["low", "high", "max"] },
  ]);
  const original = globalThis.fetch;
  let sent: Record<string, unknown> = {};
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(String(init?.body));
    return new Response(
      'event: response.created\ndata: {"type":"response.created","response":{"id":"synthetic","status":"in_progress","output":[]}}\n\n',
      { headers: { "content-type": "text/event-stream" } }
    );
  };
  try {
    const result = await new CodexExecutor().execute({
      model: "gpt-6.2-sol-max",
      body: { input: "OK", instructions: "Reply OK" },
      stream: true,
      credentials: { connectionId: "synthetic-new-model", accessToken: "synthetic" },
    });
    await result.response.text();
    assert.equal(sent.model, "gpt-6.2-sol");
    assert.equal((sent.reasoning as Record<string, unknown>).effort, "max");
  } finally {
    globalThis.fetch = original;
  }
});
