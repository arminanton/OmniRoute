import assert from "node:assert/strict";
import test from "node:test";
import * as zlib from "node:zlib";
import {
  fetchProviderRequestTransport,
  closeProviderRequestTransports,
} from "../../open-sse/utils/transport/providerRequestTransport.ts";
import { SseCompletionAudit } from "../../open-sse/utils/transport/sseCompletionAudit.ts";
const decode = (zlib as unknown as { zstdDecompressSync(input: Buffer): Buffer })
  .zstdDecompressSync;

test("provider transport remains unchanged without credentials-owned endpoint proofs", async () => {
  const init = { method: "POST", body: "fixture" };
  await fetchProviderRequestTransport(
    "codex",
    {},
    "https://example.org/responses",
    init,
    true,
    async (_url, actual) => {
      assert.equal(actual, init);
      assert.ok(!("dispatcher" in actual));
      return new Response("default");
    }
  );
});

test("configured compression reaches executor transport with lossless bytes, H2 stays off for nonstream", async () => {
  const url = "http://127.0.0.1:9876/responses";
  const body = JSON.stringify({
    input: Array.from(
      { length: 10000 },
      (_, i) => `${i.toString(16)} unchanged tool output ${Math.imul(i, 2654435761).toString(16)}`
    ).join("\n"),
  });
  let calls = 0;
  await fetchProviderRequestTransport(
    "fixture",
    {
      upstreamTransport: {
        zstdVerifiedEndpoints: [url],
        http2VerifiedOrigins: ["http://127.0.0.1:9876"],
      },
    },
    url,
    { method: "POST", body },
    false,
    async (_url, init) => {
      calls++;
      assert.equal(new Headers(init.headers).get("content-encoding"), "zstd");
      assert.equal(decode(Buffer.from(init.body as Uint8Array)).toString("utf8"), body);
      assert.ok(!("dispatcher" in init));
      return new Response("okay");
    }
  );
  assert.equal(calls, 1);
});

test("existing explicit dispatcher is never replaced by provider transport settings", async () => {
  const url = "http://127.0.0.1:9876/responses";
  const init = { body: "fixture".repeat(10000), dispatcher: {} };
  await fetchProviderRequestTransport(
    "fixture",
    { upstreamTransport: { zstdVerifiedEndpoints: [url] } },
    url,
    init,
    true,
    async (_url, actual) => {
      assert.equal(actual, init);
      return new Response("existing transport");
    }
  );
});

test("terminal SSE audit accepts real terminal types, bounds frames and rejects incomplete marker fragments", () => {
  for (const type of ["response.completed", "response.failed", "response.incomplete"]) {
    const audit = new SseCompletionAudit([type]);
    const frame = new TextEncoder().encode(`data: ${JSON.stringify({ type })}\r\n\r\n`);
    for (const byte of frame) audit.write(new Uint8Array([byte]));
    audit.finish();
  }
  const partial = new SseCompletionAudit(["response.completed"]);
  partial.write(new TextEncoder().encode("event: response.completed\n\n"));
  assert.throws(() => partial.finish(), /interrupted/);
  const bounded = new SseCompletionAudit(["[DONE]"], 16);
  assert.throws(() => bounded.write(new TextEncoder().encode("x".repeat(17))), /bounded audit/);
});

test.after(() => closeProviderRequestTransports(true));
