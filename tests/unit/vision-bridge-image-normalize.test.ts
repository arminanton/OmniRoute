/**
 * Task B2: the vision bridge self-loop fetches a remote image and hands it
 * to the vision model as a data URI (`fetchRemoteImageAsDataUri`,
 * `src/lib/guardrails/visionBridgeHelpers.ts`). That fetched image must be
 * normalized (long-edge cap 2048, `@omniroute/open-sse/utils/imageNormalize`)
 * before being embedded — the same treatment `normalizeDataUri` already
 * gives any other image, now applied to remote fetches performed by the
 * bridge itself. Scope: ONLY this self-call path, never the user's raw
 * passthrough payload (HR#20 opt-in principle).
 *
 * `ensureBase64ImagesForClaudeWire` is the exported entry point that reaches
 * the private `fetchRemoteImageAsDataUri` — it resolves every non-data-URI
 * image part of a claude-wire-format request via that same fetch helper, so
 * it is the smallest public surface to exercise the fetch → normalize path
 * with production URL validation and pinning over fake native DNS/sockets.
 * The provider/self-hop `fetchImpl` must never supply the remote media bytes.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import "../../open-sse/utils/proxyFetch.ts";
import { installPinnedTransport } from "../helpers/pinnedTransport.ts";

import { ensureBase64ImagesForClaudeWire } from "../../src/lib/guardrails/visionBridgeHelpers.ts";

// zai speaks the claude wire format (open-sse/config/providers/registry/zai/index.ts),
// so `isClaudeWireFormatModel` routes it through the base64 self-fetch path.
const CLAUDE_WIRE_MODEL = "zai/glm-4.6";

function bodyWithRemoteImage(url: string) {
  return {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "describe this" },
          { type: "image_url", image_url: { url } },
        ],
      },
    ],
  };
}

function imageTransport(
  t: TestContext,
  pathname: string,
  bytes: Uint8Array,
  contentType: string
) {
  const transport = installPinnedTransport(t.mock, {
    dnsLookup: async (hostname) => {
      assert.equal(hostname, "example.com");
      return [{ address: "93.184.216.34", family: 4 }];
    },
    reply(socket, dial) {
      assert.equal(dial.protocol, "https:");
      assert.equal(dial.options.host, "example.com");
      assert.equal(socket.request.split("\r\n")[0], `GET ${pathname} HTTP/1.1`);
      assert.doesNotMatch(
        socket.request,
        /\r\n(?:authorization|proxy-authorization|cookie|x-api-key|apikey):/i
      );
      socket.respond({ headers: { "content-type": contentType }, body: bytes });
    },
  });
  t.after(transport.restore);
  const providerFetch = t.mock.fn(async () => {
    assert.fail("media must not use the provider/self-hop fetch");
  });
  t.mock.method(globalThis, "fetch", providerFetch);
  return { transport, providerFetch };
}

test("remote image fetched for the claude-wire self-call is downscaled to the long-edge cap", async (t) => {
  let sharp: (typeof import("sharp"))["default"];
  try {
    sharp = (await import("sharp")).default;
  } catch {
    t.skip("sharp not installed");
    return;
  }
  const big = await sharp({ create: { width: 4096, height: 100, channels: 3, background: "#fff" } })
    .png()
    .toBuffer();

  assert.equal((await sharp(big).metadata()).width, 4096);
  const { transport, providerFetch } = imageTransport(t, "/big.png", big, "image/png");
  const body = bodyWithRemoteImage("https://example.com/big.png");
  const originalBody = structuredClone(body);
  const result = await ensureBase64ImagesForClaudeWire(body, CLAUDE_WIRE_MODEL, providerFetch);

  const imagePart = (result.messages?.[0]?.content as Array<{ image_url?: { url: string } }>)[1];
  const dataUri = imagePart?.image_url?.url ?? "";
  assert.match(dataUri, /^data:image\/png;base64,/);

  const b64 = dataUri.split(",")[1] ?? "";
  const decoded = Buffer.from(b64, "base64");
  const meta = await sharp(decoded).metadata();
  assert.ok((meta.width ?? 0) <= 2048, `expected width <= 2048, got ${meta.width}`);
  assert.notEqual(meta.width, 4096, "image must have been downscaled, not left at 4096");
  assert.deepEqual(body, originalBody);
  assert.equal(providerFetch.mock.callCount(), 0);
  assert.equal(transport.resolutions.length, 1);
  assert.equal(transport.dials.length, 1);
  assert.deepEqual(transport.lookups, [
    { hostname: "example.com", all: true, address: "93.184.216.34", family: 4 },
  ]);
  await transport.sockets[0].closedPromise;
  assert.equal(transport.sockets[0].destroyed, true);
});

test("remote non-image bytes pass through untouched (fail-open, no normalization)", async (t) => {
  const junk = Buffer.from("not-an-image-at-all");

  // Retrieval succeeds. Only optional image normalization passes these bytes through.
  const { transport, providerFetch } = imageTransport(
    t,
    "/junk.bin",
    junk,
    "application/octet-stream"
  );
  const body = bodyWithRemoteImage("https://example.com/junk.bin");
  const originalBody = structuredClone(body);
  const result = await ensureBase64ImagesForClaudeWire(body, CLAUDE_WIRE_MODEL, providerFetch);

  const imagePart = (result.messages?.[0]?.content as Array<{ image_url?: { url: string } }>)[1];
  const dataUri = imagePart?.image_url?.url ?? "";
  assert.equal(dataUri, `data:application/octet-stream;base64,${junk.toString("base64")}`);
  assert.deepEqual(body, originalBody);
  assert.equal(providerFetch.mock.callCount(), 0);
  assert.equal(transport.resolutions.length, 1);
  assert.equal(transport.dials.length, 1);
  assert.deepEqual(transport.lookups, [
    { hostname: "example.com", all: true, address: "93.184.216.34", family: 4 },
  ]);
  await transport.sockets[0].closedPromise;
  assert.equal(transport.sockets[0].destroyed, true);
});
