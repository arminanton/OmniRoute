import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RequestTransportTelemetry,
  runWithRequestTransportTelemetry,
  runWithTransportAttempt,
  tapTelemetryBody,
} from "../../../open-sse/utils/transportTelemetry.ts";
import { observeFetchDispatcher } from "../../../open-sse/utils/fetchDispatchObserver.ts";
import {
  budgetedGenerationFetch,
  runGenerationDispatch,
  runWithLogicalRetryBudget,
  LogicalRetryBudget,
  withLogicalRetryBudget,
  backoffGenerationRetry,
} from "../../../open-sse/services/logicalRetryBudget.ts";
import { bindGenerationResponse } from "../../../open-sse/services/generationLifetime.ts";
import type { Dispatcher } from "undici";
const encoder = new TextEncoder();

function fixture() {
  let now = 0;
  const saved: unknown[] = [];
  const telemetry = new RequestTransportTelemetry(
    () => now,
    (snapshot) => saved.push(snapshot)
  );
  return {
    telemetry,
    saved,
    tick: (ms: number) => {
      now += ms;
    },
  };
}

test("slow admission and dispatcher queue measured separately; unknown network phases remain null", () => {
  const f = fixture();
  const end = f.telemetry.wait("admission");
  f.tick(20);
  end();
  end();
  const a = f.telemetry.attempt("http");
  let callback: (() => void) | undefined;
  const dispatcher = runWithTransportAttempt(a, () =>
    observeFetchDispatcher({
      dispatch(_options: unknown, handler: { onRequestStart: () => void }) {
        callback = () => handler.onRequestStart();
        return true;
      },
    } as unknown as Dispatcher)
  );
  runWithTransportAttempt(a, () =>
    dispatcher.dispatch({} as Dispatcher.DispatchOptions, {} as Dispatcher.DispatchHandler)
  );
  f.tick(35);
  callback!();
  f.tick(15);
  a.headers(200);
  const record = f.telemetry.snapshot();
  assert.equal(record.admissionWaitMs, 20);
  assert.equal(record.admissionCount, 1);
  assert.equal(record.attempts[0].queuedMs, 20);
  assert.equal(record.attempts[0].dispatchedMs, 55);
  assert.equal(record.attempts[0].headersMs, 70);
  for (const field of ["dnsMs", "tcpMs", "tlsMs", "uploadMs"] as const)
    assert.equal(record.attempts[0][field], null);
});

test("fragmented SSE comment is a byte, not a semantic event; CRLF data event completes once", () => {
  const f = fixture();
  const a = f.telemetry.attempt("http");
  a.chunk(encoder.encode(": heartbeat\r\n\r\n"), true);
  assert.equal(a.record.firstByteMs, 0);
  assert.equal(a.record.firstEventMs, null);
  f.tick(100);
  a.chunk(encoder.encode("da"), true);
  a.chunk(encoder.encode("ta: secret-private-text\r"), true);
  assert.equal(a.record.firstEventMs, null);
  f.tick(20);
  a.chunk(encoder.encode("\n\r\n"), true);
  assert.equal(a.record.firstEventMs, 120);
  assert.equal(a.record.maxObservedIdleMs, 100);
  assert.ok(!JSON.stringify(f.telemetry.snapshot()).includes("secret-private-text"));
});

test("empty data field and oversized comments do not allocate retained payload or invent event", () => {
  const a = fixture().telemetry.attempt("http");
  a.chunk(encoder.encode(":" + "x".repeat(100000) + "\n\ndata:\n\n"), true);
  assert.equal(a.record.firstEventMs, null);
  a.chunk(encoder.encode("data:x\n\n"), true);
  assert.equal(a.record.firstEventMs, 0);
});

test("body tap does not pre-pull and forwards cancellation once with terminal snapshot", async () => {
  const f = fixture();
  let pulls = 0,
    cancelled = 0;
  const source = new ReadableStream<Uint8Array>(
    {
      pull(c) {
        pulls++;
        c.enqueue(encoder.encode("x"));
      },
      cancel() {
        cancelled++;
      },
    },
    { highWaterMark: 0 }
  );
  const body = tapTelemetryBody(
    source,
    (bytes) => f.telemetry.forward(bytes.byteLength),
    (reason) => f.telemetry.finish(reason)
  );
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(pulls, 0);
  const reader = body.getReader();
  assert.equal((await reader.read()).value?.byteLength, 1);
  await reader.cancel("private-reason");
  f.telemetry.finish("error");
  assert.equal(cancelled, 1);
  assert.equal(f.saved.length, 1);
  assert.equal(f.telemetry.snapshot().closure, "cancel");
  assert.ok(!JSON.stringify(f.saved).includes("private-reason"));
});

test("EOF and read failure terminal observations preserve stream outcome", async () => {
  for (const fail of [false, true]) {
    const f = fixture();
    const error = new Error("secret-error");
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(c) {
          if (fail) c.error(error);
          else c.close();
        },
      },
      { highWaterMark: 0 }
    );
    const body = tapTelemetryBody(
      stream,
      () => {},
      (reason) => f.telemetry.finish(reason)
    );
    if (fail) await assert.rejects(body.getReader().read(), error);
    else assert.equal((await body.getReader().read()).done, true);
    assert.equal(f.telemetry.snapshot().closure, fail ? "error" : "eof");
    assert.ok(!JSON.stringify(f.saved).includes("secret-error"));
  }
});

test("bounded ledger and reused websocket do not invent a new physical connection", () => {
  const f = fixture();
  const ws = f.telemetry.attempt("websocket");
  ws.queued();
  f.tick(10);
  ws.connected(true);
  ws.dispatched();
  ws.bytes(12);
  f.tick(5);
  ws.firstEvent();
  ws.close("eof");
  assert.equal(ws.record.connectedMs, null);
  assert.equal(ws.record.reused, true);
  assert.equal(ws.record.bytes, 12);
  for (let i = 0; i < 99; i++) f.telemetry.attempt("http");
  const snapshot = f.telemetry.snapshot();
  assert.equal(snapshot.attempts.length, 24);
  assert.equal(snapshot.droppedAttempts, 76);
  assert.ok(JSON.stringify(snapshot).length < 16000);
});

test("real generation wrapper captures failure before headers without touching native error bodies", async () => {
  const f = fixture();
  const budget = new LogicalRetryBudget(4, Date.now() + 10000);
  await runWithRequestTransportTelemetry(f.telemetry, () =>
    runWithLogicalRetryBudget(budget, () =>
      runGenerationDispatch(async () => {
        const failure = budgetedGenerationFetch(async () => {
          throw new Error("private-upstream");
        });
        await assert.rejects(failure("https://private.invalid/responses", { method: "POST" }));
        const foreign = {
          status: 429,
          ok: false,
          headers: new Headers(),
          get body(): never {
            throw new Error("must not touch");
          },
        };
        const native = budgetedGenerationFetch(async () => foreign);
        assert.equal(
          await native("https://private.invalid/responses", { method: "POST" }),
          foreign
        );
      })
    )
  );
  assert.equal(f.telemetry.snapshot().attempts[0].headersMs, null);
  assert.equal(f.telemetry.snapshot().attempts[0].closure, "error");
  assert.equal(f.telemetry.snapshot().attempts[1].status, 429);
  assert.ok(!JSON.stringify(f.telemetry.snapshot()).includes("private.invalid"));
});

test("generation wrapper observes upstream bytes and semantic first event on owned reads", async () => {
  const f = fixture();
  const budget = new LogicalRetryBudget(2, Date.now() + 10000);
  const response = await runWithRequestTransportTelemetry(f.telemetry, () =>
    runWithLogicalRetryBudget(budget, () =>
      runGenerationDispatch(() =>
        budgetedGenerationFetch(
          async () =>
            new Response("data: x\n\n", { headers: { "content-type": "text/event-stream" } })
        )("https://example.invalid/responses", { method: "POST" })
      )
    )
  );
  assert.equal(await response.text(), "data: x\n\n");
  assert.equal(f.telemetry.snapshot().attempts[0].bytes, 9);
  assert.equal(f.telemetry.snapshot().attempts[0].closure, "eof");
  assert.notEqual(f.telemetry.snapshot().attempts[0].firstEventMs, null);
});

test("backoff observes awaited interval including cancellation without changing retry policy", async () => {
  const f = fixture();
  await runWithRequestTransportTelemetry(f.telemetry, async () => {
    const promise = backoffGenerationRetry(15);
    f.tick(15);
    await promise;
  });
  assert.equal(f.telemetry.snapshot().backoffMs, 15);
  assert.equal(f.telemetry.snapshot().backoffCount, 1);
});

test("lifetime binding has single upstream close observation and cancels reader ownership", async () => {
  const closed: string[] = [];
  let cancelled = 0,
    finished = 0;
  const response = bindGenerationResponse(
    new Response(
      new ReadableStream(
        {
          cancel() {
            cancelled++;
          },
        },
        { highWaterMark: 0 }
      )
    ),
    () => finished++,
    {
      chunk() {},
      close(reason) {
        closed.push(reason);
      },
    }
  );
  await response.body!.cancel();
  assert.equal(cancelled, 1);
  assert.equal(finished, 1);
  assert.deepEqual(closed, ["cancel"]);
});

test("actual ingress wrapper emits one redacted terminal record on cancellation or pre-header failure", async () => {
  const saved: string[] = [];
  const original = console.info;
  console.info = (...args: unknown[]) => {
    saved.push(args.join(" "));
  };
  try {
    const response = await withLogicalRetryBudget(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(c) {
                c.enqueue(encoder.encode("secret-body"));
              },
            },
            { highWaterMark: 0 }
          )
        )
    )();
    await response.body!.cancel("secret-cancel");
    assert.equal(saved.length, 1);
    assert.ok(saved[0].includes('"closure":"cancel"'));
    await assert.rejects(
      withLogicalRetryBudget(async () => {
        throw new Error("secret-error");
      })()
    );
    assert.equal(saved.length, 2);
    assert.ok(saved[1].includes('"closure":"error"'));
    assert.ok(saved.every((line) => !line.includes("secret")));
  } finally {
    console.info = original;
  }
});

test("documented Undici sent callbacks capture bytes and completion timestamp, not inferred upload duration", () => {
  const f = fixture();
  const attempt = f.telemetry.attempt("http");
  let handler: Dispatcher.DispatchHandler;
  const dispatcher = runWithTransportAttempt(attempt, () =>
    observeFetchDispatcher({
      dispatch(_options: unknown, actual: Dispatcher.DispatchHandler) {
        handler = actual;
        return true;
      },
    } as unknown as Dispatcher)
  );
  runWithTransportAttempt(attempt, () =>
    dispatcher.dispatch({} as Dispatcher.DispatchOptions, {} as Dispatcher.DispatchHandler)
  );
  handler!.onBodySent!(Buffer.from("private-upload"));
  f.tick(40);
  handler!.onRequestSent!();
  assert.equal(attempt.record.observedUploadBytes, 14);
  assert.equal(attempt.record.requestSentMs, 40);
  assert.equal(attempt.record.uploadMs, null);
  assert.ok(!JSON.stringify(f.telemetry.snapshot()).includes("private-upload"));
});

test("terminal stall is observed at close, while never-received bytes stays unknown", () => {
  const f = fixture();
  const a = f.telemetry.attempt("http");
  a.bytes(10);
  f.tick(15000);
  a.close("error");
  assert.equal(a.record.terminalObservedIdleMs, 15000);
  assert.equal(a.record.maxObservedIdleMs, 15000);
  const untouched = f.telemetry.attempt("http");
  f.tick(2000);
  untouched.close("cancel");
  assert.equal(untouched.record.terminalObservedIdleMs, null);
});
