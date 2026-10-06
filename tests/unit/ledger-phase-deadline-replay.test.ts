import assert from "node:assert/strict";
import { test } from "node:test";
import { withFetchDispatchObserver } from "../../open-sse/utils/fetchDispatchObserver.ts";
import {
  resolveDirectHeadersTimeoutMs,
  directFetchWithBoundedResponseStart,
} from "../../open-sse/utils/directResponseStartTimeout.ts";
import {
  LogicalRetryBudget,
  runWithLogicalRetryBudget,
  runGenerationDispatch,
} from "../../open-sse/services/logicalRetryBudget.ts";
import {
  getGenerationDispatchPhase,
  canReplayGenerationDispatch,
  noteGenerationDispatchPhase,
} from "../../open-sse/services/generationReplay.ts";

test("owned executor header budget preserves explicit operator timeout precedence", () => {
  withFetchDispatchObserver({ queued() {}, started() {}, responseStartTimeoutMs: 110000 }, () => {
    assert.equal(resolveDirectHeadersTimeoutMs({}), 110000);
    assert.equal(
      resolveDirectHeadersTimeoutMs({ OMNIROUTE_DIRECT_HEADERS_TIMEOUT_MS: "45000" }),
      45000
    );
    assert.equal(resolveDirectHeadersTimeoutMs({ OMNIROUTE_DIRECT_HEADERS_TIMEOUT_MS: "0" }), 0);
  });
  assert.equal(resolveDirectHeadersTimeoutMs({}), 30000);
});
test("per-attempt header wait cannot outlive the shared request deadline", async () => {
  const budget = new LogicalRetryBudget(12, Date.now() + 30);
  const fake = async (_input: RequestInfo | URL, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    });
  const start = Date.now();
  let caught: unknown;
  try {
    await runWithLogicalRetryBudget(budget, () =>
      directFetchWithBoundedResponseStart(
        "https://fixture/v1/responses",
        { method: "POST" },
        fake,
        1000
      )
    );
  } catch (error) {
    caught = error;
  }
  assert.ok(Date.now() - start < 500);
  assert.equal(getGenerationDispatchPhase(caught)?.phase, "unknown");
  assert.ok(!String(caught).includes("retrying on a fresh socket"));
});
test("only actual pre-dispatch queue proof permits a generation POST replay", () => {
  const options = { method: "POST" };
  const queued = new Error("queue"),
    started = new Error("headers"),
    unknown = new Error("socket");
  noteGenerationDispatchPhase(queued, "transport_queue", false);
  noteGenerationDispatchPhase(started, "headers", true);
  runGenerationDispatch(() => {
    assert.equal(
      canReplayGenerationDispatch("https://fixture/v1/responses", options, queued),
      true
    );
    assert.equal(
      canReplayGenerationDispatch("https://fixture/v1/responses", options, started),
      false
    );
    assert.equal(
      canReplayGenerationDispatch("https://fixture/v1/responses", options, unknown),
      false
    );
    assert.equal(
      canReplayGenerationDispatch("https://fixture/models", { method: "GET" }, unknown),
      true
    );
  });
});
