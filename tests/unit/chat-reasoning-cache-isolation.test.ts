import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createChatPipelineHarness } from "../integration/_chatPipelineHarness.ts";

// Isolate both durable storage and every possible provider CLI home lookup before
// the harness imports the application. No request may reach a real network.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-chat-reasoning-home-"));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.XDG_CONFIG_HOME = path.join(TEST_HOME, "config");
Object.assign(process.env, { NODE_ENV: "test" });
process.env.API_KEY_SECRET = "fabricated-handler-reasoning-cache-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.OMNIROUTE_DISABLE_REDIS_AUTH_CACHE = "1";
process.env.REDIS_URL = "";
delete process.env.OMNIROUTE_API_KEY;
delete process.env.ROUTER_API_KEY;
delete process.env.DEFAULT_RATE_LIMIT_PER_DAY;

globalThis.fetch = async () => {
  throw new Error("Unexpected network call in isolated reasoning replay handler test");
};

const harness = await createChatPipelineHarness("chat-reasoning-cache-isolation");
const { handleChat, buildRequest, seedConnection, seedApiKey, combosDb } = harness;
const { cacheReasoning, clearReasoningCacheAll, getReasoningCacheServiceEntries, lookupReasoning } =
  await import("../../open-sse/services/reasoningCache.ts");
const { createLocalReasoningCacheContext } =
  await import("../../open-sse/services/reasoningCacheContext.ts");
const MODEL = "xiaomi-mimo/mimo-v1";
const PROVIDER_KEY = "fabricated-shared-provider-key";
const TOOL_ID = "call_same_id_for_all_principals";

function toolCall() {
  return {
    id: TOOL_ID,
    type: "function",
    function: { name: "lookup", arguments: "{}" },
  };
}

function initialMessages() {
  return [{ role: "user", content: "Use lookup to answer this question" }];
}

function continuationMessages() {
  return [
    ...initialMessages(),
    { role: "assistant", content: null, tool_calls: [toolCall()] },
    { role: "tool", tool_call_id: TOOL_ID, content: "synthetic tool result" },
    { role: "user", content: "Continue after the tool result" },
  ];
}

function providerResponse(stream: boolean, privateReasoning?: string): Response {
  const message = privateReasoning
    ? {
        role: "assistant",
        content: null,
        reasoning_content: privateReasoning,
        tool_calls: [toolCall()],
      }
    : { role: "assistant", content: "synthetic final response" };
  const finishReason = privateReasoning ? "tool_calls" : "stop";
  if (stream) {
    const delta = privateReasoning
      ? { ...message, tool_calls: [{ index: 0, ...toolCall() }] }
      : message;
    const chunk = {
      id: "synthetic-reasoning-stream",
      object: "chat.completion.chunk",
      model: "mimo-v1",
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }
  return new Response(
    JSON.stringify({
      id: "synthetic-reasoning-json",
      object: "chat.completion",
      model: "mimo-v1",
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function mockProviderResponses(stream: boolean, reasoningByRequest: Array<string | undefined>) {
  const outgoing: string[] = [];
  globalThis.fetch = async (_url, init) => {
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      `Bearer ${PROVIDER_KEY}`,
      "only the fabricated provider connection may dispatch"
    );
    const index = outgoing.length;
    assert.ok(index < reasoningByRequest.length, "unexpected additional upstream dispatch");
    outgoing.push(String(init?.body ?? ""));
    return providerResponse(stream, reasoningByRequest[index]);
  };
  return outgoing;
}

type ClientRequestOverrides = {
  bare?: boolean;
  url?: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
};

async function sendChat(
  apiKey: string | null,
  model: string,
  stream: boolean,
  continuation: boolean,
  overrides: ClientRequestOverrides = {}
): Promise<void> {
  const request = buildRequest({
    authKey: apiKey,
    url: overrides.url,
    headers: overrides.bare
      ? {}
      : {
          "X-OmniRoute-No-Cache": "true",
          "X-OmniRoute-Session-Id": "same-client-session-for-all-principals",
          ...overrides.headers,
        },
    body: {
      model,
      stream,
      temperature: 0.7,
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
      messages: continuation ? continuationMessages() : initialMessages(),
      ...overrides.body,
    },
  });
  if (overrides.bare) {
    request.headers.delete("content-type");
    assert.equal([...request.headers].length, 0, "the no-key regression must have zero headers");
  }
  const response = await handleChat(request);
  const body = await response.text(); // Drains SSE and completes streaming capture.
  assert.equal(response.status, 200, body);
}

function assertOutgoingReasoning(body: string, expected: string | null, forbidden: string): void {
  assert.ok(body.includes(TOOL_ID), "continuation must send the colliding tool call ID");
  assert.equal(body.includes(forbidden), false, "another principal's reasoning must not replay");
  const parsed = JSON.parse(body) as {
    messages: Array<{ role?: string; reasoning_content?: string }>;
  };
  const assistant = parsed.messages.find((message) => message.role === "assistant");
  assert.ok(assistant);
  if (expected !== null) assert.equal(assistant.reasoning_content, expected);
}

test.beforeEach(async () => {
  process.env.REQUIRE_API_KEY = "false";
  await harness.resetStorage();
  clearReasoningCacheAll();
});

test.after(async () => {
  clearReasoningCacheAll();
  await harness.cleanup();
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

for (const route of ["direct", "combo"] as const) {
  for (const stream of [false, true]) {
    test(
      `authenticated handler keeps A/B reasoning separate (${route}, stream=${stream})`,
      { timeout: 20_000 },
      async () => {
        await seedConnection("xiaomi-mimo", { apiKey: PROVIDER_KEY });
        const first = await seedApiKey({ name: "Synthetic principal A", noLog: true });
        const second = await seedApiKey({ name: "Synthetic principal B", noLog: true });
        let model = MODEL;
        if (route === "combo") {
          model = `reasoning-cache-combo-${stream}`;
          await combosDb.createCombo({
            name: model,
            strategy: "priority",
            config: { maxRetries: 0 },
            models: [MODEL],
          });
        }
        const reasoningA = `SYNTHETIC_PRIVATE_REASONING_A_${route}_${stream}`;
        const reasoningB = `SYNTHETIC_PRIVATE_REASONING_B_${route}_${stream}`;
        const outgoing = mockProviderResponses(stream, [
          reasoningA,
          reasoningB,
          undefined,
          undefined,
        ]);

        // No manual context construction or service seeding: capture must come
        // through API-key policy -> handler -> core -> actual response capture.
        await sendChat(first.key, model, stream, false);
        assert.equal(outgoing.length, 1);

        // B's byte-identical history cannot read A. B then captures its own text
        // under that same tool ID, proving that writes do not overwrite A either.
        await sendChat(second.key, model, stream, true);
        assert.equal(outgoing.length, 2);
        assertOutgoingReasoning(outgoing[1], null, reasoningA);

        await sendChat(first.key, model, stream, true);
        assert.equal(outgoing.length, 3);
        assertOutgoingReasoning(outgoing[2], reasoningA, reasoningB);

        await sendChat(second.key, model, stream, true);
        assert.equal(outgoing.length, 4);
        assertOutgoingReasoning(outgoing[3], reasoningB, reasoningA);
      }
    );
  }
}

test(
  "no-key HTTP and unresolved bearers cannot access or populate the trusted-local cache",
  {
    timeout: 20_000,
  },
  async () => {
    await seedConnection("xiaomi-mimo", { apiKey: PROVIDER_KEY });
    const unknownKey = "synthetic-unresolved-client-key";
    const unresolvedReasoning = "SYNTHETIC_UNRESOLVED_KEY_REASONING";
    const noKeyReasoning = "SYNTHETIC_NO_KEY_HTTP_REASONING";
    const spoofedReasoning = "SYNTHETIC_SPOOFED_LOCAL_REASONING";
    const trustedLocalReasoning = "SYNTHETIC_TRUSTED_LOCAL_REASONING";
    const localContext = createLocalReasoningCacheContext();
    assert.ok(localContext);
    cacheReasoning(TOOL_ID, "xiaomi-mimo", "mimo-v1", trustedLocalReasoning, localContext);
    const outgoing = mockProviderResponses(false, [
      unresolvedReasoning,
      noKeyReasoning,
      undefined,
      undefined,
      undefined,
      undefined,
      spoofedReasoning,
    ]);

    await sendChat(unknownKey, MODEL, false, false);
    await sendChat(null, MODEL, false, false, { bare: true });
    assert.equal(lookupReasoning(TOOL_ID, localContext), trustedLocalReasoning);
    assert.equal(getReasoningCacheServiceEntries().length, 1, "HTTP must not capture any entries");

    await sendChat(null, MODEL, false, true, { bare: true });
    await sendChat(unknownKey, MODEL, false, true);
    const spoofed: ClientRequestOverrides = {
      headers: {
        "x-forwarded-for": "127.0.0.1",
        "x-real-ip": "127.0.0.1",
        forwarded: "for=127.0.0.1;host=localhost;proto=http",
        "x-forwarded-host": "localhost",
        "x-omniroute-auth-kind": "client_api_key",
        "x-omniroute-auth-id": "local",
        "x-omniroute-session-id": "chosen-trusted-local-session",
      },
      body: {
        reasoningCacheContext: { kind: "local" },
        principal: { kind: "local" },
        local: true,
        apiKeyInfo: { id: "local" },
        reasoningCacheScope: "local",
        sessionId: "chosen-trusted-local-session",
      },
    };
    for (const host of ["localhost", "127.0.0.1"]) {
      await sendChat(null, MODEL, false, true, {
        ...spoofed,
        url: `http://${host}/v1/chat/completions`,
      });
    }
    assert.equal(outgoing.length, 6);
    for (const body of outgoing.slice(2)) {
      assertOutgoingReasoning(body, null, trustedLocalReasoning);
      assert.equal(body.includes(unresolvedReasoning), false);
      assert.equal(body.includes(noKeyReasoning), false);
    }
    await sendChat(null, MODEL, false, false, spoofed);
    assert.equal(outgoing.length, 7);
    assert.equal(lookupReasoning(TOOL_ID, localContext), trustedLocalReasoning);
    assert.equal(getReasoningCacheServiceEntries().length, 1);
  }
);
