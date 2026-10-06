import assert from "node:assert/strict";
import { test } from "node:test";
import { createCreditsExtractionTransform } from "../../open-sse/executors/antigravity/streamingPassthrough.ts";
test("fragmented large frame preserves bytes and stream observation epoch", async () => {
  const observed: Array<{ balance: number; at: number }> = [];
  const start = Date.now();
  const tap = createCreditsExtractionTransform("a", (_id, balance, at) =>
    observed.push({ balance, at: at! })
  );
  const payload = `data: ${JSON.stringify({ padding: "x".repeat(600000), remainingCredits: [{ creditType: "GOOGLE_ONE_AI", creditAmount: "7" }] })}\n\n`;
  const bytes = new TextEncoder().encode(payload);
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (let n = 0; n < bytes.length; n += 16000) c.enqueue(bytes.slice(n, n + 16000));
      c.close();
    },
  });
  const result = await new Response(stream.pipeThrough(tap)).text();
  assert.equal(result, payload);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].balance, 7);
  assert.ok(observed[0].at >= start);
});
