import test from "node:test";
import assert from "node:assert/strict";
import {
  ChatAdmissionController,
  releaseChatAdmissionAfterHandler,
  releaseChatAdmissionWhenDone,
} from "../../src/shared/middleware/chatBodyAdmission.ts";
import { withChatAdmission } from "../../src/shared/middleware/withChatAdmission.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

for (const preAborted of [false, true]) {
  test(`abort ${preAborted ? "before" : "while"} handler is pending cancels late body without freeing live ownership`, async () => {
    const controller = new ChatAdmissionController(1, undefined, 0);
    const lease = controller.tryAcquireHeavy()!;
    const abort = new AbortController();
    const handler = deferred<Response>();
    const cancellation = deferred<void>();
    let cancelled = 0;
    if (preAborted) abort.abort("gone");
    const result = releaseChatAdmissionAfterHandler(handler.promise, lease, {
      signal: abort.signal,
    });
    if (!preAborted) abort.abort("gone");
    await flush();
    assert.equal(controller.activeHeavy, 1, "noncooperative pending handler still owns capacity");
    handler.resolve(
      new Response(
        new ReadableStream({
          cancel() {
            cancelled++;
            return cancellation.promise;
          },
        }),
        { headers: { "content-type": "text/event-stream" } }
      )
    );
    await flush();
    assert.equal(cancelled, 1, "abort must cancel the late body even without a reader");
    assert.equal(controller.activeHeavy, 1, "cancel request is not cancel completion");
    cancellation.resolve();
    await result;
    await flush();
    assert.equal(controller.activeHeavy, 0);
  });
}

test("response cancellation holds the lease until asynchronous upstream cancel settles", async () => {
  const controller = new ChatAdmissionController(1);
  const cancellation = deferred<void>();
  const response = releaseChatAdmissionWhenDone(
    new Response(
      new ReadableStream({
        cancel() {
          return cancellation.promise;
        },
      }),
      { headers: { "content-type": "text/event-stream" } }
    ),
    controller.tryAcquireHeavy()
  );
  const cancelling = response.body!.cancel("gone");
  await flush();
  assert.equal(controller.activeHeavy, 1);
  cancellation.resolve();
  await cancelling;
  assert.equal(controller.activeHeavy, 0);
});

test("request abort cancels an unread returned SSE body and releases exactly once after cleanup", async () => {
  const controller = new ChatAdmissionController(1);
  const abort = new AbortController();
  const cancellation = deferred<void>();
  let cancelled = 0;
  const response = releaseChatAdmissionWhenDone(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled++;
          return cancellation.promise;
        },
      }),
      { headers: { "content-type": "text/event-stream" } }
    ),
    controller.tryAcquireHeavy(),
    { signal: abort.signal }
  );
  abort.abort("gone");
  await flush();
  assert.equal(cancelled, 1);
  assert.equal(controller.activeHeavy, 1);
  cancellation.resolve();
  await flush();
  assert.equal(controller.activeHeavy, 0);
  await response.body!.cancel();
  assert.equal(cancelled, 1);
});

test("route middleware passes abort through while the handler is pending", async () => {
  const controller = new ChatAdmissionController(1, undefined, 0);
  const abort = new AbortController();
  const entered = deferred<void>();
  const handler = deferred<Response>();
  const cancellation = deferred<void>();
  let cancelled = false;
  const wrapped = withChatAdmission(
    async () => {
      entered.resolve();
      return handler.promise;
    },
    { controller, largeBodyBytes: 1, hardMaxBytes: 1024, queueMs: 0 }
  );
  const result = wrapped(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      body: "{}",
      signal: abort.signal,
    })
  );
  await entered.promise;
  abort.abort("gone");
  assert.equal(controller.activeHeavy, 1);
  handler.resolve(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
          return cancellation.promise;
        },
      }),
      { headers: { "content-type": "text/event-stream" } }
    )
  );
  await flush();
  assert.equal(cancelled, true);
  assert.equal(controller.activeHeavy, 1);
  cancellation.resolve();
  await result;
  await flush();
  assert.equal(controller.activeHeavy, 0);
});

test("late rejection after abort releases once and preserves the handler failure", async () => {
  const controller = new ChatAdmissionController(1);
  const abort = new AbortController();
  const handler = deferred<Response>();
  const failure = new Error("handler failure");
  const result = releaseChatAdmissionAfterHandler(handler.promise, controller.tryAcquireHeavy(), {
    signal: abort.signal,
  });
  abort.abort();
  assert.equal(controller.activeHeavy, 1);
  handler.reject(failure);
  await assert.rejects(result, (error) => error === failure);
  assert.equal(controller.activeHeavy, 0);
});

test("EOF and read failures detach the abort listener; later abort does not cancel again", async () => {
  const { getEventListeners } = await import("node:events");
  for (const fail of [false, true]) {
    const controller = new ChatAdmissionController(1);
    const abort = new AbortController();
    let cancelled = 0;
    const response = releaseChatAdmissionWhenDone(
      new Response(
        new ReadableStream({
          pull(stream) {
            if (fail) stream.error(new Error("source failed"));
            else stream.close();
          },
          cancel() {
            cancelled++;
          },
        }),
        { headers: { "content-type": "text/event-stream" } }
      ),
      controller.tryAcquireHeavy(),
      { signal: abort.signal }
    );
    assert.equal(getEventListeners(abort.signal, "abort").length, 1);
    if (fail) await assert.rejects(response.text(), /source failed/);
    else await response.text();
    assert.equal(controller.activeHeavy, 0);
    assert.equal(getEventListeners(abort.signal, "abort").length, 0);
    abort.abort();
    assert.equal(cancelled, 0);
  }
});

test("layered adaptive and heavyweight leases both await the actual source cancellation", async () => {
  const { createAdaptiveAdmissionRuntime } =
    await import("../../open-sse/services/admission/runtime.ts");
  const runtime = createAdaptiveAdmissionRuntime({ checkResourcePressure: () => null });
  const controller = new ChatAdmissionController(1);
  const sourceCancelled = deferred<void>();
  const admitted = await runtime.acquire({ tenantKey: "test", body: {}, streaming: true });
  assert.equal(admitted.status, "admitted");
  if (admitted.status !== "admitted") throw new Error("expected admitted");
  try {
    const inner = runtime.attachResponseLifecycle(
      new Response(
        new ReadableStream({
          cancel() {
            return sourceCancelled.promise;
          },
        }),
        { headers: { "content-type": "text/event-stream" } }
      ),
      admitted.lease,
      { admittedAtMs: admitted.admittedAtMs }
    );
    const outer = releaseChatAdmissionWhenDone(inner, controller.tryAcquireHeavy());
    const cancelling = outer.body!.cancel();
    await flush();
    assert.equal(
      runtime.snapshot().activeCount,
      1,
      "adaptive wrapper cannot acknowledge cancel early"
    );
    assert.equal(controller.activeHeavy, 1, "heavy wrapper must see real cleanup completion");
    sourceCancelled.resolve();
    await cancelling;
    assert.equal(runtime.snapshot().activeCount, 0);
    assert.equal(controller.activeHeavy, 0);
  } finally {
    sourceCancelled.resolve();
    runtime.dispose();
  }
});

test("an aborted buffered rejection remains readable once handler work has terminated", async () => {
  const controller = new ChatAdmissionController(1);
  const abort = new AbortController();
  abort.abort();
  const response = await releaseChatAdmissionAfterHandler(
    Promise.resolve(Response.json({ error: { code: "admission_aborted" } }, { status: 499 })),
    controller.tryAcquireHeavy(),
    { signal: abort.signal }
  );
  assert.equal(controller.activeHeavy, 0);
  assert.equal((await response.json()).error.code, "admission_aborted");
});

for (const rejectCleanup of [false, true]) {
  test(`abort during pending handler retains both layered leases until late cancel ${rejectCleanup ? "rejects" : "fulfills"}`, async () => {
    const { createAdaptiveAdmissionRuntime } =
      await import("../../open-sse/services/admission/runtime.ts");
    const runtime = createAdaptiveAdmissionRuntime({ checkResourcePressure: () => null });
    const controller = new ChatAdmissionController(1);
    const abort = new AbortController();
    const handler = deferred<Response>();
    const cleanup = deferred<void>();
    const admitted = await runtime.acquire({ tenantKey: "test", body: {}, streaming: true });
    assert.equal(admitted.status, "admitted");
    if (admitted.status !== "admitted") throw new Error("expected admitted");
    let cancelCount = 0;
    try {
      const result = releaseChatAdmissionAfterHandler(
        handler.promise,
        controller.tryAcquireHeavy(),
        { signal: abort.signal }
      );
      abort.abort("gone");
      assert.equal(runtime.snapshot().activeCount, 1);
      assert.equal(controller.activeHeavy, 1);
      handler.resolve(
        runtime.attachResponseLifecycle(
          new Response(
            new ReadableStream({
              cancel() {
                cancelCount++;
                return cleanup.promise;
              },
            }),
            { headers: { "content-type": "text/event-stream" } }
          ),
          admitted.lease,
          { admittedAtMs: admitted.admittedAtMs, signal: abort.signal }
        )
      );
      await flush();
      assert.equal(cancelCount, 1);
      assert.equal(runtime.snapshot().activeCount, 1);
      assert.equal(controller.activeHeavy, 1);
      if (rejectCleanup) cleanup.reject(new Error("cleanup terminated with error"));
      else cleanup.resolve();
      await result;
      assert.equal(runtime.snapshot().activeCount, 0);
      assert.equal(controller.activeHeavy, 0);
      assert.equal(cancelCount, 1);
    } finally {
      cleanup.resolve();
      runtime.dispose();
    }
  });
}
