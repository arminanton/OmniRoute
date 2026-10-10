import test from "node:test";
import assert from "node:assert/strict";
import { createChatPipelineHarness } from "../integration/_chatPipelineHarness.ts";

const harness = await createChatPipelineHarness("terminal-network-response");
const {
  BaseExecutor,
  buildRequest,
  combosDb,
  handleChat,
  resetStorage,
  seedConnection,
  settingsDb,
} = harness;
const { handleComboChat } = await import("../../open-sse/services/combo.ts");
const { isExhaustedNetworkResponse, markExhaustedNetworkResponse } =
  await import("../../open-sse/services/exhaustedNetworkResponse.ts");
const { isAcceptedTaskTimeoutResponse, markAcceptedTaskTimeoutResponse } =
  await import("../../open-sse/services/exhaustedNetworkResponse.ts");
const { isUnsafeToReplayResponse, markUnsafeToReplayResponse } =
  await import("../../open-sse/services/exhaustedNetworkResponse.ts");
const { proxyFetch } = await import("../../open-sse/utils/proxyFetch.ts");
const { isFallbackDecision, resetEmergencyFallbackEnvCache, shouldUseFallback } =
  await import("../../open-sse/services/emergencyFallback.ts");
const originalNoProxy = process.env.NO_PROXY;
const originalEmergencyFallback = process.env.OMNIROUTE_EMERGENCY_FALLBACK;

test.beforeEach(async () => {
  BaseExecutor.RETRY_CONFIG.delayMs = 0;
  process.env.NO_PROXY = "*";
  process.env.OMNIROUTE_EMERGENCY_FALLBACK = "true";
  resetEmergencyFallbackEnvCache();
  await resetStorage();
});

const noop = () => {};
const log = { info: noop, warn: noop, debug: noop, error: noop };

function makeFailure(contentType: string): Response {
  return new Response(
    contentType === "text/event-stream"
      ? 'data: {"error":{"code":"proxy_unreachable"}}\n\n'
      : JSON.stringify({ error: { code: "proxy_unreachable" } }),
    { status: 503, headers: { "content-type": contentType } }
  );
}

for (const contentType of ["application/json", "text/event-stream"]) {
  test(`marker covers ${contentType} without classifying an ordinary provider 503`, () => {
    const exhausted = makeFailure(contentType);
    const providerFailure = makeFailure(contentType);

    assert.equal(isExhaustedNetworkResponse(exhausted), false);
    assert.equal(markExhaustedNetworkResponse(exhausted), exhausted);
    assert.equal(isExhaustedNetworkResponse(exhausted), true);
    assert.equal(isExhaustedNetworkResponse(providerFailure), false);
  });
}

for (const strategy of ["priority", "round-robin"]) {
  test(`${strategy} returns a marked exhausted-network response without advancing targets`, async () => {
    const terminal = markExhaustedNetworkResponse(makeFailure("application/json"));
    const calls: string[] = [];
    const result = await handleComboChat({
      body: { messages: [{ role: "user", content: "hello" }] },
      combo: {
        name: `terminal-network-${strategy}`,
        strategy,
        models: ["openai/first", "anthropic/second"],
        config: { maxRetries: 2, concurrencyPerModel: 1, queueTimeoutMs: 100 },
      },
      handleSingleModel: async (_body: unknown, modelStr: string) => {
        calls.push(modelStr);
        return terminal;
      },
      isModelAvailable: async () => true,
      log,
      settings: null,
      allCombos: null,
      relayOptions: null,
    });

    assert.equal(result, terminal, "the original terminal response must be preserved");
    assert.equal(isExhaustedNetworkResponse(result), true);
    assert.deepEqual(calls, ["openai/first"]);
  });
}

for (const strategy of ["priority", "round-robin"]) {
  test(`${strategy} stops on an unsafe-to-replay 502 while preserving its public response`, async () => {
    const terminal = markUnsafeToReplayResponse(
      new Response(JSON.stringify({ error: { type: "upstream_acceptance_uncertain" } }), {
        status: 502,
        headers: { "content-type": "application/json" },
      })
    );
    const calls: string[] = [];
    const result = await handleComboChat({
      body: { messages: [{ role: "user", content: "do not duplicate uncertain work" }] },
      combo: {
        name: `unsafe-replay-${strategy}`,
        strategy,
        models: ["openai/first", "anthropic/second"],
        config: { maxRetries: 0, retryDelayMs: 0, concurrencyPerModel: 1, queueTimeoutMs: 100 },
      },
      handleSingleModel: async (_body: unknown, modelStr: string) => {
        calls.push(modelStr);
        return terminal;
      },
      isModelAvailable: async () => true,
      log,
      settings: null,
      allCombos: null,
      relayOptions: null,
    });

    assert.equal(result, terminal);
    assert.equal(result.status, 502);
    assert.equal(isUnsafeToReplayResponse(result), true);
    assert.deepEqual(calls, ["openai/first"]);
  });

  test(`${strategy} stops on accepted-task timeout without changing its external 504`, async () => {
    const terminal = markAcceptedTaskTimeoutResponse(
      new Response(JSON.stringify({ error: { message: "Transcription timed out", code: 504 } }), {
        status: 504,
        headers: { "content-type": "application/json" },
      })
    );
    const calls: string[] = [];
    const result = await handleComboChat({
      body: { messages: [{ role: "user", content: "transcribe once" }] },
      combo: {
        name: `accepted-task-timeout-${strategy}`,
        strategy,
        models: ["openai/first", "anthropic/second"],
        config: { maxRetries: 0, retryDelayMs: 0, concurrencyPerModel: 1, queueTimeoutMs: 100 },
      },
      handleSingleModel: async (_body: unknown, modelStr: string) => {
        calls.push(modelStr);
        return terminal;
      },
      isModelAvailable: async () => true,
      log,
      settings: null,
      allCombos: null,
      relayOptions: null,
    });

    assert.equal(result, terminal);
    assert.equal(result.status, 504);
    assert.equal(isAcceptedTaskTimeoutResponse(result), true);
    assert.deepEqual(calls, ["openai/first"], "do not dispatch another provider after timeout");
  });
}

for (const strategy of ["priority", "round-robin"]) {
  test(`${strategy} still falls back after an ordinary unmarked provider 504`, async () => {
    const ordinaryTimeout = new Response(
      JSON.stringify({ error: { message: "provider gateway timeout", code: 504 } }),
      { status: 504, headers: { "content-type": "application/json" } }
    );
    const calls: string[] = [];
    const result = await handleComboChat({
      body: { messages: [{ role: "user", content: "ordinary provider timeout" }] },
      combo: {
        name: `ordinary-504-fallback-${strategy}`,
        strategy,
        models: ["openai/first", "anthropic/second"],
        config: { maxRetries: 0, retryDelayMs: 0, concurrencyPerModel: 1, queueTimeoutMs: 100 },
      },
      handleSingleModel: async (_body: unknown, modelStr: string) => {
        calls.push(modelStr);
        return modelStr === "openai/first"
          ? ordinaryTimeout
          : Response.json({ ok: true, text: "fallback succeeded" });
      },
      isModelAvailable: async () => true,
      log,
      settings: null,
      allCombos: null,
      relayOptions: null,
    });

    assert.equal(result.status, 200);
    assert.equal(isAcceptedTaskTimeoutResponse(ordinaryTimeout), false);
    assert.deepEqual(calls, ["openai/first", "anthropic/second"]);
  });
}

// The fake throws without dispatching through its observed dispatcher, so an
// unsafe POST has no proof it was still queued. It must remain terminally
// ambiguous instead of being replayed on another account, model, or transport.
function installAmbiguousTransport() {
  const calls: string[] = [];
  let dispatcherAttempts = 0;
  let nativeAttempts = 0;
  const transportError = () =>
    Object.assign(new Error("fetch failed: billing limit exceeded"), { code: "EAI_AGAIN" });

  globalThis.fetch = (input, init) => {
    calls.push(new Headers(init?.headers).get("authorization") ?? "");
    return proxyFetch(input, init, {
      undiciFetch: async () => {
        dispatcherAttempts++;
        throw transportError();
      },
      nativeFetch: async () => {
        nativeAttempts++;
        throw transportError();
      },
    });
  };
  return {
    calls,
    get dispatcherAttempts() {
      return dispatcherAttempts;
    },
    get nativeAttempts() {
      return nativeAttempts;
    },
  };
}

for (const stream of [false, true]) {
  test(`direct ${stream ? "SSE" : "JSON"} ambiguous dispatch stops before account and emergency fallback`, async () => {
    await seedConnection("openai", { apiKey: "sk-first-terminal", priority: 1 });
    await seedConnection("openai", { apiKey: "sk-second-unused", priority: 2 });
    await seedConnection("nvidia", { apiKey: "sk-emergency-unused" });
    await settingsDb.updateSettings({ requestRetry: 0, maxRetryIntervalSec: 0 });
    assert.equal(
      isFallbackDecision(shouldUseFallback(502, "fetch failed: billing limit exceeded", false)),
      true,
      "this failure would trigger emergency fallback if the terminal guard were late"
    );
    const transport = installAmbiguousTransport();

    const response = await handleChat(
      buildRequest({
        body: {
          model: "openai/gpt-4.1",
          stream,
          messages: [{ role: "user", content: "stop at final local transport failure" }],
        },
      })
    );

    assert.equal(response.status, 502);
    // Public handlers may rebuild the Response, so assert the error envelope
    // and the observed absence of retries/fallbacks rather than its private marker.
    assert.equal(transport.calls.length, 1, "no second account or emergency model dispatch");
    assert.ok(
      ["Bearer sk-first-terminal", "Bearer sk-second-unused"].includes(transport.calls[0]),
      "the only upstream dispatch must use one of the original provider accounts"
    );
    assert.equal(
      transport.dispatcherAttempts,
      1,
      "the fake transport supplied no proof that this unsafe POST was still queued"
    );
    assert.equal(
      transport.nativeAttempts,
      0,
      "ambiguous dispatch must not replay through native fetch"
    );
    assert.match(await response.text(), /upstream_acceptance_uncertain/);
  });

  test(`combo ${stream ? "SSE" : "JSON"} ambiguous dispatch stops before other targets and global fallback`, async () => {
    await seedConnection("openai", { apiKey: "sk-first-terminal" });
    await seedConnection("claude", { apiKey: "sk-next-unused" });
    await seedConnection("nvidia", { apiKey: "sk-global-unused" });
    await combosDb.createCombo({
      name: `terminal-network-route-${stream ? "sse" : "json"}`,
      strategy: "priority",
      config: { maxRetries: 2, retryDelayMs: 0 },
      models: ["openai/gpt-4.1", "claude/claude-sonnet-4.6"],
    });
    await settingsDb.updateSettings({
      globalFallbackModel: "nvidia/openai/gpt-oss-120b",
      requestRetry: 0,
      maxRetryIntervalSec: 0,
    });
    const transport = installAmbiguousTransport();

    const response = await handleChat(
      buildRequest({
        body: {
          model: `terminal-network-route-${stream ? "sse" : "json"}`,
          stream,
          messages: [{ role: "user", content: "do not redispatch after local exhaustion" }],
        },
      })
    );

    assert.equal(response.status, 502);
    assert.deepEqual(transport.calls, ["Bearer sk-first-terminal"]);
    assert.equal(transport.dispatcherAttempts, 1);
    assert.equal(transport.nativeAttempts, 0);
    assert.match(await response.text(), /upstream_acceptance_uncertain/);
  });
}

test("an ordinary unmarked combo 503 can still use global fallback", async () => {
  await seedConnection("openai", { apiKey: "sk-provider-503" });
  await seedConnection("nvidia", { apiKey: "sk-global-allowed" });
  await combosDb.createCombo({
    name: "terminal-network-ordinary-503",
    strategy: "priority",
    config: { maxRetries: 0, retryDelayMs: 0 },
    models: ["openai/gpt-4.1"],
  });
  await settingsDb.updateSettings({
    globalFallbackModel: "nvidia/openai/gpt-oss-120b",
    requestRetry: 0,
    maxRetryIntervalSec: 0,
  });
  const calls: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    calls.push(auth);
    if (auth === "Bearer sk-provider-503") return makeFailure("application/json");
    assert.equal(auth, "Bearer sk-global-allowed");
    return harness.buildOpenAIResponse("global fallback still works", "openai/gpt-oss-120b");
  };

  const response = await handleChat(
    buildRequest({
      body: {
        model: "terminal-network-ordinary-503",
        stream: false,
        messages: [{ role: "user", content: "ordinary provider outage" }],
      },
    })
  );

  assert.equal(response.status, 200);
  assert.equal(isExhaustedNetworkResponse(response), false);
  assert.deepEqual(calls, ["Bearer sk-provider-503", "Bearer sk-global-allowed"]);
  assert.match(await response.text(), /global fallback still works/);
});

test.after(async () => {
  if (originalNoProxy === undefined) delete process.env.NO_PROXY;
  else process.env.NO_PROXY = originalNoProxy;
  if (originalEmergencyFallback === undefined) delete process.env.OMNIROUTE_EMERGENCY_FALLBACK;
  else process.env.OMNIROUTE_EMERGENCY_FALLBACK = originalEmergencyFallback;
  resetEmergencyFallbackEnvCache();
  await harness.cleanup();
});
