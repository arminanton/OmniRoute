import assert from "node:assert/strict";
import { test } from "node:test";
import { LogicalRetryBudget } from "../../open-sse/services/logicalRetryBudget.ts";
test("nested attempts share one bound and output permanently forbids replay", () => {
  const budget = new LogicalRetryBudget(3, 100, () => 0);
  budget.consumeAttempt();
  budget.consumeAttempt();
  budget.consumeAttempt();
  assert.throws(() => budget.consumeAttempt(), /exhausted/);
  const delivered = new LogicalRetryBudget(3, 100, () => 0);
  delivered.consumeAttempt();
  delivered.markOutputOrToolDelivered();
  assert.throws(() => delivered.consumeAttempt(), /exhausted/);
});
test("retry hints are minima and deadlines/cancellation bound backoff", async () => {
  const b = new LogicalRetryBudget(3, 1000, () => 0);
  b.consumeAttempt();
  const start = Date.now();
  await b.backoff(30, undefined, () => 0);
  assert.ok(Date.now() - start >= 25);
  const c = new AbortController();
  const waiting = b.backoff(900, c.signal, () => 0);
  c.abort(new Error("cancel"));
  await assert.rejects(waiting, /cancel/);
  const expired = new LogicalRetryBudget(3, 10, () => 0);
  await assert.rejects(expired.backoff(10), /deadline/);
});

test("generation dispatch consumes nested transport retries but excludes control-plane", async () => {
  const { runWithLogicalRetryBudget, runGenerationDispatch, budgetedGenerationFetch } =
    await import("../../open-sse/services/logicalRetryBudget.ts");
  const b = new LogicalRetryBudget(2, Date.now() + 1000);
  let calls = 0;
  const fetch = budgetedGenerationFetch(async () => {
    calls++;
    return new Response("ok");
  });
  await runWithLogicalRetryBudget(b, () =>
    runGenerationDispatch(async () => {
      await fetch("https://x/oauth/token", { method: "POST" });
      await fetch("https://x/models", { method: "GET" });
      await fetch("https://x/v1/responses", { method: "POST" });
      await fetch("https://y/v1/messages", { method: "POST" });
      await assert.rejects(fetch("https://x/v1/responses", { method: "POST" }), /exhausted/);
    })
  );
  assert.equal(calls, 4);
  assert.equal(b.snapshot().attempts, 2);
});

test("transport backoff releases then reacquires request permit and cancellation prevents reacquisition", async () => {
  const { runGenerationDispatch, backoffGenerationRetry } =
    await import("../../open-sse/services/logicalRetryBudget.ts");
  const events: string[] = [];
  await runGenerationDispatch(() => backoffGenerationRetry(5), {
    withPermitReleased: async (sleep) => {
      events.push("release");
      await sleep();
      events.push("reacquire");
    },
  });
  assert.deepEqual(events, ["release", "reacquire"]);
  const abort = new AbortController();
  events.length = 0;
  const pending = runGenerationDispatch(() => backoffGenerationRetry(1000, abort.signal), {
    withPermitReleased: async (sleep) => {
      events.push("release");
      await sleep();
      events.push("reacquire");
    },
  });
  abort.abort(new Error("stop"));
  await assert.rejects(pending, /stop/);
  assert.deepEqual(events, ["release"]);
});

test("budget exhaustion is branded and does not classify as retryable account transport failure", async () => {
  const { LogicalRetryBudgetError, isLogicalRetryBudgetError } =
    await import("../../open-sse/services/logicalRetryBudget.ts");
  const { shouldRetrySameAccountTransport } =
    await import("../../src/sse/services/sameAccountTransportRetry.ts");
  assert.equal(isLogicalRetryBudgetError(new LogicalRetryBudgetError("bounded")), true);
  assert.equal(
    isLogicalRetryBudgetError(
      Object.assign(new Error("provider"), { code: "RETRY_BUDGET_EXHAUSTED" })
    ),
    false
  );
  assert.equal(
    shouldRetrySameAccountTransport({ status: 503, errorType: "logical_retry_budget", attempt: 0 }),
    false
  );
});

test("stream finalization reports completion separately from cancellation/error", async () => {
  const { wrapReadableStreamWithFinalize } =
    await import("../../open-sse/handlers/chatCore/streamFinalize.ts");
  const success: boolean[] = [];
  const source = new ReadableStream<string>({
    start(c) {
      c.enqueue("done");
      c.close();
    },
  });
  const reader = wrapReadableStreamWithFinalize(source, (value) =>
    success.push(!!value)
  ).getReader();
  await reader.read();
  await reader.read();
  assert.deepEqual(success, [true]);
  assert.equal(source.locked, false);
  const canceled: boolean[] = [];
  const second = new ReadableStream<string>({ start() {} });
  await wrapReadableStreamWithFinalize(second, (value) => canceled.push(!!value)).cancel();
  assert.deepEqual(canceled, [false]);
});
