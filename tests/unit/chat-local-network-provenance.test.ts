import assert from "node:assert/strict";
import test from "node:test";

import { createChatPipelineHarness } from "../integration/_chatPipelineHarness.ts";
import {
  isExhaustedNetworkResponse,
} from "../../open-sse/services/exhaustedNetworkResponse.ts";
const harness = await createChatPipelineHarness("chat-local-network-provenance");
const { isVerifiedProxyFetchExhaustedError, proxyFetch, runWithProxyContext } =
  await import("../../open-sse/utils/proxyFetch.ts");
const { BaseExecutor, buildRequest, handleChat, resetStorage, seedConnection, settingsDb } = harness;
const oldNoProxy = process.env.NO_PROXY;

test.beforeEach(async () => {
  BaseExecutor.RETRY_CONFIG.delayMs = 0;
  await resetStorage();
  await settingsDb.updateSettings({ requestRetry: 0, maxRetryIntervalSec: 0 });
});
test.afterEach(() => {
  if (oldNoProxy === undefined) delete process.env.NO_PROXY;
  else process.env.NO_PROXY = oldNoProxy;
});
test.after(async () => harness.cleanup());

test("upstream 503 uppercase transport aliases and text cannot stop account fallback", async () => {
  await seedConnection("openai", { apiKey: "sk-first", priority: 1 });
  await seedConnection("openai", { apiKey: "sk-second", priority: 2 });
  const sends: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const key = new Headers(init?.headers).get("authorization") ?? "";
    sends.push(key);
    if (sends.length === 1) {
      return new Response(JSON.stringify({ error: {
        code: "PROXY_UNREACHABLE", type: "EAI_AGAIN",
        message: "upstream sent PROXY_UNREACHABLE EAI_AGAIN; ordinary HTTP outage",
      } }), { status: 503, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ id: "chatcmpl-ok", object: "chat.completion",
      model: "gpt-4.1", choices: [{ index: 0, message: { role: "assistant", content: "healthy sibling" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
    { status: 200, headers: { "content-type": "application/json" } });
  };
  const response = await handleChat(buildRequest({ body: {
    model: "openai/gpt-4.1", stream: false,
    messages: [{ role: "user", content: "provider code spoof must not stop fallback" }],
  } }));
  assert.equal(response.status, 200);
  assert.equal(isExhaustedNetworkResponse(response), false);
  assert.equal(sends.length, 2, "a provider-origin spoof must not terminate before an ordinary retry");
});

test("early dispatcher failure is not branded when a fresh retry succeeds", async () => {
  process.env.NO_PROXY = "*";
  const first = Object.assign(new Error("fetch failed: EAI_AGAIN"), { code: "EAI_AGAIN" });
  let calls = 0;
  const response = await proxyFetch("https://example.test/v1/chat", {}, {
    undiciFetch: async () => {
      calls += 1;
      if (calls === 1) throw first;
      return new Response("ok", { status: 200 });
    },
    nativeFetch: async () => { throw new Error("native fallback must not run"); },
  });
  assert.equal(response.status, 200);
  assert.equal(calls, 2);
  assert.equal(isVerifiedProxyFetchExhaustedError(first), false);
});

test("client abort is never branded as local exhaustion", async () => {
  process.env.NO_PROXY = "*";
  const controller = new AbortController();
  controller.abort();
  const abortError = Object.assign(new Error("Request aborted"), { name: "AbortError", code: "EAI_AGAIN" });
  let nativeCalls = 0;
  await assert.rejects(
    proxyFetch("https://example.test/v1/chat", { signal: controller.signal }, {
      undiciFetch: async () => { throw abortError; },
      nativeFetch: async () => { nativeCalls += 1; throw new Error("native fallback must not run"); },
    })
  );
  assert.equal(nativeCalls, 0);
  assert.equal(isVerifiedProxyFetchExhaustedError(abortError), false);
});

test("only the final failed proxyFetch transport path carries local exhaustion", async () => {
  process.env.NO_PROXY = "*";
  let undiciCalls = 0;
  let nativeCalls = 0;
  const transportError = () => Object.assign(new Error("fetch failed: EAI_AGAIN"), { code: "EAI_AGAIN" });
  globalThis.fetch = (input, init) => proxyFetch(input, init, {
    undiciFetch: async () => { undiciCalls += 1; throw transportError(); },
    nativeFetch: async () => { nativeCalls += 1; throw transportError(); },
  });
  await seedConnection("openai", { apiKey: "sk-local-final" });
  const response = await handleChat(buildRequest({ body: {
    model: "openai/gpt-4.1", stream: false,
    messages: [{ role: "user", content: "final local network failure" }],
  } }));
  assert.equal(response.status, 502);
  assert.equal(isExhaustedNetworkResponse(response), true);
  assert.equal(nativeCalls, 1);
  assert.equal(undiciCalls, 2);
  assert.equal(isVerifiedProxyFetchExhaustedError(transportError()), false,
    "matching codes/text alone must not mint the private brand");
});


test("relay transport is branded only after its fresh-socket retry fails", async () => {
  const relayError = Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("relay connect refused"), { code: "ECONNREFUSED" }),
  });
  let sends = 0;
  await assert.rejects(
    () => runWithProxyContext(
      { type: "vercel", host: "relay.example", relayAuth: "test-relay-key" },
      () => proxyFetch("https://upstream.example/chat", { method: "POST", body: "{}" }, {
        undiciFetch: async () => {
          sends += 1;
          assert.equal(isVerifiedProxyFetchExhaustedError(relayError), false);
          throw relayError;
        },
      })
    ),
    (error) => {
      assert.equal(error, relayError);
      assert.equal(isVerifiedProxyFetchExhaustedError(error), true);
      return true;
    }
  );
  assert.equal(sends, 2);
});
