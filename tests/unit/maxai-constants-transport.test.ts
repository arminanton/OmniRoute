import test from "node:test";
import assert from "node:assert/strict";
import { fetchMaxaiConstants } from "../../open-sse/executors/maxai/constants.ts";

test("public signing bundle fetch explicitly rejects redirect and abort stops scanning", async () => {
  const controller = new AbortController();
  let calls = 0;
  const result = fetchMaxaiConstants({
    signal: controller.signal,
    fetchImpl: async (_url, init) => {
      calls++;
      assert.equal(init?.redirect, "error");
      controller.abort();
      return new Response("irrelevant");
    },
  });
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(calls, 1);
});

test("bundle size is bounded before consuming an unlimited response", async () => {
  let cancelled = false;
  let pulls = 0;
  const result = await fetchMaxaiConstants({
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          pull(c) {
            pulls++;
            c.enqueue(new Uint8Array(1024 * 1024));
          },
          cancel() {
            cancelled = true;
          },
        })
      ),
  });
  assert.equal(result, null);
  assert.equal(cancelled, true);
  assert.ok(pulls <= 6);
});
