import "../_setup/isolateDataDir.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.ts";
import {
  buildSsePassthroughResult,
  createCreditsExtractionTransform,
} from "../../open-sse/executors/antigravity/streamingPassthrough.ts";
import {
  sendAntigravityRequest,
  toSafeAntigravityLog,
} from "../../open-sse/executors/antigravity/executeAttempt.ts";
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("100 unread streams have bounded byte queues and abort releases their sources", async () => {
  let pulled = 0,
    cancelled = 0;
  const streams = Array.from({ length: 100 }, (_, i) => {
    let n = 0;
    const abort = new AbortController();
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (n++ < 10) {
          pulled++;
          controller.enqueue(new Uint8Array(65536));
        } else return new Promise(() => {});
      },
      cancel() {
        cancelled++;
      },
    });
    const result = buildSsePassthroughResult(
      source,
      { status: 200, statusText: "OK", headers: new Headers() },
      String(i),
      () => {},
      "https://mock.invalid",
      {},
      {},
      abort.signal
    );
    return { abort, body: result.response.body! };
  });
  await tick();
  await tick();
  const before = pulled;
  streams.forEach(({ abort }) => abort.abort());
  await tick();
  await tick();
  const after = cancelled;
  await Promise.all(streams.map(({ body }) => body.cancel().catch(() => {})));
  assert.ok(before <= 400, `read ${before} chunks without downstream demand`);
  assert.equal(after, 100, "caller abort must cancel already-piped upstream sources");
});

test("credits from a complete large frame are extracted before stream close", async () => {
  const credits: number[] = [];
  const transform = createCreditsExtractionTransform(
    "mock",
    (_id, balance) => credits.push(balance),
    16384
  );
  const writer = transform.writable.getWriter(),
    reader = transform.readable.getReader();
  const read = reader.read();
  await writer.write(
    new TextEncoder().encode(
      `data: ${JSON.stringify({ padding: "x".repeat(20000), remainingCredits: [{ creditType: "GOOGLE_ONE_AI", creditAmount: "17" }] })}\n\n`
    )
  );
  await read;
  const before = [...credits];
  await writer.close();
  await reader.read();
  assert.deepEqual(before, [17]);
});

test("non-streaming read failure and in-band errors never become successful completions", async () => {
  const executor = new AntigravityExecutor();
  const broken = new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new Error("socket reset"));
      },
    })
  );
  const result = await executor.collectStreamToResponse(
    broken,
    "mock",
    "https://mock.invalid",
    {},
    {},
    null,
    null
  );
  assert.equal(result.response.status, 502);
  assert.ok((await result.response.json()).error);
  const inBand = await executor.collectStreamToResponse(
    new Response('data: {"error":{"code":429,"message":"RESOURCE_EXHAUSTED"}}\n\n'),
    "mock",
    "https://mock.invalid",
    {},
    {},
    null,
    null
  );
  assert.equal(inBand.response.status, 429);
});

test("abort during a stalled body read promptly returns cancellation", async () => {
  const executor = new AntigravityExecutor();
  const abort = new AbortController();
  let cancelled = false;
  const upstream = new Response(
    new ReadableStream({
      pull() {
        return new Promise(() => {});
      },
      cancel() {
        cancelled = true;
      },
    })
  );
  const pending = executor.collectStreamToResponse(
    upstream,
    "mock",
    "https://mock.invalid",
    {},
    {},
    null,
    abort.signal
  );
  abort.abort(new DOMException("disconnected", "AbortError"));
  const result = await Promise.race([
    pending,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("abort did not interrupt reader")), 250)
    ),
  ]);
  assert.equal(result.response.status, 499);
  assert.equal(cancelled, true);
});

test("403 retry cancels abandoned upstream body before opening replacement", async () => {
  const original = globalThis.fetch;
  let calls = 0,
    cancelled = false;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1)
      return new Response(
        new ReadableStream({
          pull() {
            return new Promise(() => {});
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 403 }
      );
    assert.equal(cancelled, true);
    return new Response("data: {}\n\n");
  };
  try {
    await sendAntigravityRequest(
      "antigravity",
      "https://mock.invalid",
      "mock",
      {},
      { project: "mock-project", request: {} },
      { accessToken: "synthetic" },
      true,
      null,
      toSafeAntigravityLog(null),
      0
    );
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(calls, 2);
});

test("caller abort interrupts Retry-After backoff instead of scheduling another attempt", async () => {
  const executor = new AntigravityExecutor();
  const abort = new AbortController();
  const pending = executor.handleAntigravityRateLimit({
    response: new Response("{}", { status: 429, headers: { "Retry-After": "1" } }),
    log: toSafeAntigravityLog(null),
    urlIndex: 0,
    retryAttemptsByUrl: { 0: 0 },
    fallbackCount: 1,
    signal: abort.signal,
  } as never);
  abort.abort(new DOMException("disconnected", "AbortError"));
  await assert.rejects(pending, { name: "AbortError" });
});

test("a credits retry burst limit does not mark account credits exhausted", async () => {
  const { tryCreditsRetry, isCreditsExhausted } =
    await import("../../open-sse/executors/antigravity/executeAttempt.ts");
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response('{"error":{"message":"too many requests per minute"}}', { status: 429 });
  try {
    await tryCreditsRetry(
      "antigravity",
      "https://mock.invalid",
      {},
      { project: "synthetic-project", request: {} },
      { accessToken: "synthetic-burst-credits" },
      true,
      null,
      toSafeAntigravityLog(null),
      "synthetic-burst-account",
      () => {}
    );
    assert.equal(isCreditsExhausted("synthetic-burst-account"), false);
  } finally {
    globalThis.fetch = original;
  }
});

test("valid partial native SSE followed by EOF is an interrupted response", async () => {
  const partial =
    'data: {"response":{"candidates":[{"content":{"parts":[{"text":"partial answer"}]}}]}}\n\n';
  const executor = new AntigravityExecutor();
  const result = await executor.collectStreamToResponse(
    new Response(partial),
    "mock",
    "https://mock.invalid",
    {},
    {},
    null,
    null
  );
  assert.equal(result.response.status, 502);
  const streamed = buildSsePassthroughResult(
    new Response(partial).body!,
    { status: 200, statusText: "OK", headers: new Headers() },
    "mock",
    () => {},
    "https://mock.invalid",
    {},
    {},
    null
  );
  await assert.rejects(streamed.response.text(), /before completion/);
});
