import assert from "node:assert/strict";
import { test } from "node:test";
import { Response as UndiciResponse } from "undici";
import {
  getPhysicalGenerationCount,
  beginGenerationLifetime,
  bindGenerationResponse,
} from "../../open-sse/services/generationLifetime.ts";
import {
  budgetedGenerationFetch,
  runGenerationDispatch,
  runWithLogicalRetryBudget,
  LogicalRetryBudget,
} from "../../open-sse/services/logicalRetryBudget.ts";

test("successful foreign Undici body remains owned until EOF and excludes management reads", async () => {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const call = budgetedGenerationFetch(
    async () => new UndiciResponse(body, { headers: { "content-type": "text/event-stream" } })
  );
  const budget = new LogicalRetryBudget(4, Date.now() + 10000);
  const response = await runWithLogicalRetryBudget(budget, () =>
    runGenerationDispatch(() => call("https://fixture/v1/responses", { method: "POST" }))
  );
  assert.equal(getPhysicalGenerationCount(), 1);
  const reader = response.body!.getReader();
  const read = reader.read();
  controller!.enqueue(new TextEncoder().encode("data: done\n\n"));
  await read;
  assert.equal(getPhysicalGenerationCount(), 1);
  controller!.close();
  await reader.read();
  assert.equal(getPhysicalGenerationCount(), 0);
  const management = budgetedGenerationFetch(async () => new Response("{}"));
  await runWithLogicalRetryBudget(budget, () =>
    runGenerationDispatch(() => management("https://fixture/oauth/token", { method: "POST" }))
  );
  assert.equal(getPhysicalGenerationCount(), 0);
});
test("native failure headers never access the error body getter", () => {
  let touched = false;
  const error = {
    status: 429,
    ok: false,
    headers: new Headers(),
    get body() {
      touched = true;
      throw new Error("disturbed");
    },
  } as unknown as Response;
  const finish = beginGenerationLifetime("http");
  assert.equal(bindGenerationResponse(error, finish), error);
  assert.equal(touched, false);
  assert.equal(getPhysicalGenerationCount(), 0);
});
test("cancel owns upstream cancellation and ends exactly once", async () => {
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      canceled = true;
    },
  });
  const response = bindGenerationResponse(new Response(body), beginGenerationLifetime("http"));
  assert.equal(getPhysicalGenerationCount(), 1);
  await response.body!.cancel();
  assert.equal(canceled, true);
  assert.equal(getPhysicalGenerationCount(), 0);
});
test("dispatch exceptions release physical lifetime and explicit WebSocket terminal closure is idempotent", async () => {
  const call = budgetedGenerationFetch(async () => {
    throw new Error("transport");
  });
  await assert.rejects(
    runGenerationDispatch(() => call("https://fixture/v1/responses", { method: "POST" })),
    /transport/
  );
  assert.equal(getPhysicalGenerationCount(), 0);
  const finish = beginGenerationLifetime("websocket");
  assert.equal(getPhysicalGenerationCount(), 1);
  finish();
  finish();
  assert.equal(getPhysicalGenerationCount(), 0);
});
