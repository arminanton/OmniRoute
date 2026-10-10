import test from "node:test";
import assert from "node:assert/strict";

import { DefaultExecutor } from "../../open-sse/executors/default.ts";
import { getExecutor, hasSpecializedExecutor } from "../../open-sse/executors/index.ts";
import { KieExecutor } from "../../open-sse/executors/kie.ts";

test("KIE chat traffic uses the default executor while media keeps its task executor", async () => {
  assert.equal(hasSpecializedExecutor("kie"), false);
  assert.ok((await getExecutor("kie")) instanceof DefaultExecutor);
  assert.equal(typeof KieExecutor, "function");
});

test("KIE polling aborts its pending-task delay and sends no further poll", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let calls = 0;
  let capturedSignal: AbortSignal | undefined;
  let signalFirstFetch!: () => void;
  const firstFetch = new Promise<void>((resolve) => (signalFirstFetch = resolve));
  globalThis.fetch = async (_url, init = {}) => {
    calls++;
    capturedSignal = init.signal as AbortSignal | undefined;
    signalFirstFetch();
    return new Response(JSON.stringify({ data: { status: "PENDING" } }), {
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const reason = new Error("cancel KIE polling");
    const polling = new KieExecutor().pollTask({
      statusUrl: "https://kie.invalid/status",
      taskId: "fake-task",
      token: "fake-token",
      timeoutMs: 5000,
      pollIntervalMs: 1000,
      signal: controller.signal,
    });
    await firstFetch;
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(calls, 1, "the fake KIE task should be waiting between polls");
    assert.equal(capturedSignal, controller.signal);

    controller.abort(reason);
    await assert.rejects(polling, (error) => error === reason);
    assert.equal(calls, 1, "abort during the pending delay must prevent another upstream poll");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
