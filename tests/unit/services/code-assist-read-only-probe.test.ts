import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import {
  probeCodeAssistCountTokens,
  CodeAssistProbeError,
} from "../../../open-sse/services/codeAssistReadOnlyProbe.ts";

const input = { contents: [{ role: "user", parts: [{ text: "fixture" }] }] };

test("opt-in CCPA CountTokens uses exact native envelope through reviewed transport", async (t) => {
  let requests = 0;
  const server = http.createServer(async (request, response) => {
    requests++;
    let raw = "";
    for await (const bytes of request) raw += bytes.toString();
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1internal:countTokens");
    assert.equal(request.headers.authorization, "Bearer fake-native-probe-token");
    assert.deepEqual(JSON.parse(raw), { request: { ...input, model: "gemini-3.8-flash" } });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end('{"totalTokens":42}');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  const fetchImpl = (url: string, init: RequestInit) => {
    assert.equal(url, "https://daily-cloudcode-pa.googleapis.com/v1internal:countTokens");
    return fetch(`http://127.0.0.1:${address.port}/v1internal:countTokens`, init);
  };
  assert.deepEqual(
    await probeCodeAssistCountTokens("gemini-3.8-flash", input, {
      enabled: true,
      provider: "agy",
      accessToken: "fake-native-probe-token",
      profile: "cli",
      fetchImpl,
    }),
    { totalTokens: 42, source: "cloud-code-count-tokens" }
  );
  assert.equal(requests, 1);
});

test("disabled, cancelled and bad credentials never dispatch", async () => {
  let dispatched = 0;
  const options = {
    enabled: false,
    provider: "agy" as const,
    accessToken: "fixture",
    profile: "cli" as const,
    fetchImpl: async () => {
      dispatched++;
      return new Response('{"totalTokens":0}');
    },
  };
  await assert.rejects(
    probeCodeAssistCountTokens("gemini-a", input, options),
    (error: CodeAssistProbeError) => error.category === "disabled"
  );
  await assert.rejects(
    probeCodeAssistCountTokens("gemini-a", input, {
      ...options,
      enabled: true,
      signal: AbortSignal.abort(),
    })
  );
  await assert.rejects(
    probeCodeAssistCountTokens("gemini-a", input, {
      ...options,
      enabled: true,
      accessToken: "bad\r\nheader",
    })
  );
  assert.equal(dispatched, 0);
});

test("429, invalid JSON and oversized bodies stay redacted and are never retried", async () => {
  for (const response of [
    new Response("private-provider-error", { status: 429 }),
    new Response("private-provider-error"),
    new Response("x".repeat(20000)),
  ]) {
    let calls = 0;
    await assert.rejects(
      probeCodeAssistCountTokens("gemini-a", input, {
        enabled: true,
        provider: "antigravity",
        profile: "ide",
        accessToken: "private-test-token",
        fetchImpl: async () => {
          calls++;
          return response;
        },
      }),
      (error: CodeAssistProbeError) => {
        assert(!error.message.includes("private-provider-error"));
        assert(!error.message.includes("private-test-token"));
        return true;
      }
    );
    assert.equal(calls, 1);
  }
});

test("caller abort cancels owned pending response reader", async () => {
  const controller = new AbortController();
  let cancelled = 0;
  const pending = new Response(
    new ReadableStream<Uint8Array>({
      cancel() {
        cancelled++;
      },
    })
  );
  const timer = setTimeout(() => controller.abort(), 10);
  try {
    await assert.rejects(
      probeCodeAssistCountTokens("gemini-a", input, {
        enabled: true,
        provider: "agy",
        profile: "cli",
        accessToken: "fixture",
        signal: controller.signal,
        fetchImpl: async () => pending,
      }),
      (error: CodeAssistProbeError) => error.category === "cancelled-or-timeout"
    );
    assert.equal(cancelled, 1);
  } finally {
    clearTimeout(timer);
  }
});
