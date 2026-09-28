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

// Only proxyFetch's final transport failure is trusted: provider text and error
// codes alone cannot mint this marker. Exercise the handler instead of looking
// for a specific predicate name or statement order in its source.
function installExhaustedTransport() {
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
  test(`direct ${stream ? "SSE" : "JSON"} exhaustion stops before account and emergency fallback`, async () => {
    await seedConnection("openai", { apiKey: "sk-first-terminal", priority: 1 });
    await seedConnection("openai", { apiKey: "sk-second-unused", priority: 2 });
    await seedConnection("nvidia", { apiKey: "sk-emergency-unused" });
    await settingsDb.updateSettings({ requestRetry: 0, maxRetryIntervalSec: 0 });
    assert.equal(
      isFallbackDecision(shouldUseFallback(502, "fetch failed: billing limit exceeded", false)),
      true,
      "this failure would trigger emergency fallback if the terminal guard were late"
    );
    const transport = installExhaustedTransport();

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
    // The public SSE admission wrapper rebuilds the Response after routing, so
    // its final object need not retain the in-process marker.
    if (!stream) assert.equal(isExhaustedNetworkResponse(response), true);
    assert.equal(transport.calls.length, 1, "no second account or emergency model dispatch");
    assert.ok(
      ["Bearer sk-first-terminal", "Bearer sk-second-unused"].includes(transport.calls[0]),
      "the only upstream dispatch must use one of the original provider accounts"
    );
    assert.equal(transport.dispatcherAttempts, 2, "proxyFetch retries with a fresh dispatcher");
    assert.equal(transport.nativeAttempts, 1, "proxyFetch tries native fetch before marking");
    assert.match(await response.text(), /fetch failed: billing limit exceeded/);
  });

  test(`combo ${stream ? "SSE" : "JSON"} exhaustion stops before other targets and global fallback`, async () => {
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
    const transport = installExhaustedTransport();

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
    if (!stream) assert.equal(isExhaustedNetworkResponse(response), true);
    assert.deepEqual(transport.calls, ["Bearer sk-first-terminal"]);
    assert.equal(transport.dispatcherAttempts, 2);
    assert.equal(transport.nativeAttempts, 1);
    assert.match(await response.text(), /fetch failed: billing limit exceeded/);
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
