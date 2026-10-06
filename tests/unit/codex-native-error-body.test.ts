import "../_setup/isolateDataDir.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { CodexExecutor, filterNonstandardCodexSse } from "../../open-sse/executors/codex.ts";
function nativeErrorResponse() {
  let touched = 0;
  const target = new Response('{"detail":"Too many concurrent requests"}', { status: 429 });
  const response = new Proxy(target, {
    get(object, key) {
      if (key === "body") touched++;
      if (key === "text")
        return () => {
          if (touched) throw new Error("native response body was disturbed");
          return object.text();
        };
      const value = Reflect.get(object, key, object);
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
  return { response, touched: () => touched };
}
test("SSE filtering never touches a non-SSE native error body", async () => {
  const { response, touched } = nativeErrorResponse();
  assert.equal(filterNonstandardCodexSse(response), response);
  assert.equal(touched(), 0);
  assert.match(await response.text(), /concurrent/);
});
test("Codex HTTP execution leaves native 429 JSON readable by error handling", async () => {
  const original = globalThis.fetch;
  const { response, touched } = nativeErrorResponse();
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls++;
    return response;
  };
  try {
    const result = await new CodexExecutor().execute({
      model: "gpt-6-luna",
      body: { instructions: "Reply OK", input: "OK" },
      stream: true,
      skipUpstreamRetry: false,
      credentials: { accessToken: "synthetic", connectionId: "synthetic-native-error" },
      log: { debug() {}, warn() {} },
    });
    assert.equal(result.response.status, 429);
    assert.equal(upstreamCalls, 1, "Codex account orchestration owns throttling retries");
    assert.equal(touched(), 0);
    assert.match(await result.response.text(), /concurrent/);
  } finally {
    globalThis.fetch = original;
  }
});
