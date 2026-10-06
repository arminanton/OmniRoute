import "../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.ts";

for (const status of [429, 503]) {
  test(`stalled ${status} classifier promptly cancels body without retry`, async () => {
    const executor = new AntigravityExecutor();
    const abort = new AbortController();
    const reason = new Error("caller cancellation");
    let cancelled = 0;
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"error":'));
        },
        cancel() {
          cancelled++;
        },
      }),
      { status }
    );
    const attempts = { 0: 0 };
    const pending = executor.handleAntigravityRateLimit({
      response,
      signal: abort.signal,
      url: "https://fixture.invalid/streamGenerateContent",
      model: "fixture",
      headers: {},
      finalHeaders: {},
      transformedBody: {},
      credentials: { accessToken: "fixture" },
      stream: true,
      accountId: "fixture",
      creditsMode: "off",
      creditsRetryState: { attempted: false },
      urlIndex: 0,
      retryAttemptsByUrl: attempts,
      fallbackCount: 2,
      log: { debug() {}, info() {}, warn() {}, error() {} },
    } as Parameters<AntigravityExecutor["handleAntigravityRateLimit"]>[0]);
    const started = Date.now();
    setTimeout(() => abort.abort(reason), 10);
    await assert.rejects(pending, (error) => error === reason);
    assert.ok(Date.now() - started < 1000, "must not await the30s error-body cap");
    assert.equal(cancelled, 1);
    assert.equal(response.body?.locked, false);
    assert.equal(attempts[0], 0);
  });
}

test("transient503 probe propagates caller cancellation rather than ignoring it", async () => {
  const abort = new AbortController();
  const reason = new Error("stop transient probe");
  let cancelled = 0;
  const response = new Response(
    new ReadableStream({
      cancel() {
        cancelled++;
      },
    }),
    { status: 503 }
  );
  const executor = new AntigravityExecutor() as unknown as {
    shouldAutoRetryTransient(response: Response, signal: AbortSignal): Promise<boolean>;
  };
  const pending = executor.shouldAutoRetryTransient(response, abort.signal);
  setTimeout(() => abort.abort(reason), 10);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(cancelled, 1);
  assert.equal(response.body?.locked, false);
});
