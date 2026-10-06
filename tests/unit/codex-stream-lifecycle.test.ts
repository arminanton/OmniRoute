import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const root = process.env.OMNIROUTE_TEST_REPO_ROOT
  ? pathToFileURL(`${process.env.OMNIROUTE_TEST_REPO_ROOT}/`)
  : new URL("../../", import.meta.url);
const {
  CodexExecutor,
  peekCodexSseTransientError,
  encodeResponseSseEvent,
  __setCodexWebSocketTransportForTesting,
} = await import(new URL("open-sse/executors/codex.ts", root).href);
test.afterEach(() => __setCodexWebSocketTransportForTesting(undefined));

test("SSE creation reaches the client without waiting for reasoning or visible text", async () => {
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"response.created"}\n\n'));
      },
    }),
    { headers: { "content-type": "text/event-stream" } }
  );
  const peek = await peekCodexSseTransientError(response, 100);
  assert.equal(peek.timedOut ?? false, false);
  assert.ok(peek.replacementBody);
  await peek.replacementBody.cancel();
});

test("generated capacity text is passed through instead of retried", async () => {
  const text =
    'data: {"type":"response.output_text.delta","delta":"Selected model is at capacity."}\n\n';
  const response = new Response(text, { headers: { "content-type": "text/event-stream" } });
  const peek = await peekCodexSseTransientError(response, 100);
  assert.equal(peek.matched, null);
  assert.equal(await new Response(peek.replacementBody).text(), text);
});

test("premature upstream WebSocket close emits a failure event", async () => {
  const ws = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    onerror: null as ((event: { message?: string }) => void) | null,
    onclose: null as (() => void) | null,
    send() {
      queueMicrotask(() => ws.onclose?.());
    },
    close() {},
  };
  __setCodexWebSocketTransportForTesting(async () => ws);
  const result = await new CodexExecutor().execute({
    model: "gpt-6-astra",
    body: { input: [{ role: "user", content: "hello" }] },
    stream: true,
    credentials: {
      accessToken: "synthetic-test-token",
      providerSpecificData: { codexTransport: "websocket", codexFingerprintMode: "off" },
    },
  });
  assert.match(await result.response.text(), /response.failed/);
});

test("an incomplete response is terminal and each speed tier retains its wire value", () => {
  assert.equal(
    encodeResponseSseEvent('{"type":"response.incomplete","response":{"status":"incomplete"}}')
      .terminal,
    true
  );
  for (const tier of ["priority", "fast", "ultrafast"]) {
    const body = new CodexExecutor().transformRequest(
      "gpt-6-astra",
      { input: [], service_tier: tier },
      true,
      {}
    );
    assert.equal(body.service_tier, tier);
  }
});
