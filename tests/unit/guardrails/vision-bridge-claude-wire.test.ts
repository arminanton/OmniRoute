/**
 * Regression: claude-wire format vision targets (MiniMax, Z.AI, Kimi, …)
 * reject remote image URLs (MiniMax 403 code 2013). The vision bridge must
 * normalize remote URLs to base64 data URIs for these targets.
 */
import test from "node:test";
import assert from "node:assert/strict";
import "../../../open-sse/utils/proxyFetch.ts";
import { installPinnedTransport } from "../../helpers/pinnedTransport.ts";

const {
  isClaudeWireFormatModel,
  ensureBase64ImagesForClaudeWire,
} = await import("../../../src/lib/guardrails/visionBridgeHelpers.ts");
const { RemoteMediaFetchError } = await import("../../../src/shared/network/remoteImageFetch.ts");

test("isClaudeWireFormatModel: true for anthropic and claude-format registry providers", () => {
  assert.strictEqual(isClaudeWireFormatModel("anthropic/claude-sonnet-4"), true);
  assert.strictEqual(isClaudeWireFormatModel("zai/glm-5"), true);
  assert.strictEqual(isClaudeWireFormatModel("claude/claude-opus"), true);
  assert.strictEqual(isClaudeWireFormatModel("wafer/wafer-model"), true);
});

test("isClaudeWireFormatModel: false for openai-format providers", () => {
  assert.strictEqual(isClaudeWireFormatModel("openai/gpt-4o-mini"), false);
  // minimax deliberately moved claude→openai format so images work (#9463).
  assert.strictEqual(isClaudeWireFormatModel("minimax/MiniMax-M3"), false);
  assert.strictEqual(isClaudeWireFormatModel("kiro/minimax-m2.5"), false);
  assert.strictEqual(isClaudeWireFormatModel("auto/best-vision"), false);
  assert.strictEqual(isClaudeWireFormatModel(null), false);
});

test("ensureBase64ImagesForClaudeWire: passthrough for non-claude-wire models", async () => {
  const body = {
    model: "openai/gpt-4o-mini",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "hi" },
          { type: "image_url", image_url: { url: "https://example.com/a.png" } },
        ],
      },
    ],
  };
  const out = await ensureBase64ImagesForClaudeWire(body, "openai/gpt-4o-mini");
  assert.strictEqual(out, body, "non-claude-wire body must be returned untouched");
});

test("ensureBase64ImagesForClaudeWire: keeps data-URI images as-is", async () => {
  const dataUri = "data:image/png;base64,iVBORw0KGgo=";
  const body = {
    model: "zai/glm-5",
    messages: [
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: dataUri } }],
      },
    ],
  };
  const out = await ensureBase64ImagesForClaudeWire(body, "zai/glm-5");
  const part = out.messages[0].content[0];
  assert.strictEqual(part.image_url.url, dataUri);
});

test("ensureBase64ImagesForClaudeWire: resolves remote URLs to base64 for claude-wire targets", async (t) => {
  const pngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const transport = installPinnedTransport(t.mock, {
    dnsLookup: async (hostname) => {
      assert.equal(hostname, "example.com");
      return [{ address: "93.184.216.34", family: 4 }];
    },
    reply(socket, dial) {
      assert.equal(dial.protocol, "https:");
      assert.equal(dial.options.host, "example.com");
      assert.match(socket.request, /^GET \/cat\.png HTTP\/1\.1\r\n/);
      assert.doesNotMatch(
        socket.request,
        /\r\n(?:authorization|proxy-authorization|cookie|x-api-key|apikey):/i
      );
      socket.respond({
        headers: { "content-type": "image/png" },
        body: Buffer.from(pngBase64, "base64"),
      });
    },
  });
  t.after(transport.restore);
  let providerSends = 0;
  const providerFetch: typeof fetch = async () => {
    providerSends++;
    assert.fail("media must not use the provider/self-hop fetch");
  };
  t.mock.method(globalThis, "fetch", providerFetch);

  const body = {
    model: "zai/glm-5",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "What is this?" },
          { type: "image_url", image_url: { url: "https://example.com/cat.png" } },
        ],
      },
    ],
  };
  const originalBody = structuredClone(body);
  const out = await ensureBase64ImagesForClaudeWire(body, "zai/glm-5", providerFetch);
  const part = out.messages[0].content[1];
  assert.ok(
    part.image_url.url.startsWith("data:image/png;base64,"),
    "remote URL must be resolved to a base64 data URI"
  );
  assert.ok(part.image_url.url.includes(pngBase64));
  assert.deepEqual(body, originalBody);
  assert.equal(providerSends, 0);
  assert.equal(transport.resolutions.length, 1);
  assert.equal(transport.dials.length, 1);
  assert.deepEqual(transport.lookups, [
    { hostname: "example.com", all: true, address: "93.184.216.34", family: 4 },
  ]);
  await transport.sockets[0].closedPromise;
  assert.equal(transport.sockets[0].destroyed, true);
});

test("ensureBase64ImagesForClaudeWire: fails closed on remote fetch failure without provider dispatch", async (t) => {
  const transport = installPinnedTransport(t.mock, {
    dnsLookup: async (hostname) => {
      assert.equal(hostname, "example.com");
      return [{ address: "93.184.216.34", family: 4 }];
    },
    connectError: new Error("fixture media connection failed"),
  });
  t.after(transport.restore);
  let providerSends = 0;
  const providerFetch: typeof fetch = async () => {
    providerSends++;
    assert.fail("failed media must not reach provider/self-hop fetch");
  };
  t.mock.method(globalThis, "fetch", providerFetch);

  const body = {
    model: "zai/glm-5",
    messages: [
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "https://example.com/cat.png" } }],
      },
    ],
  };
  const originalBody = structuredClone(body);
  await assert.rejects(
    ensureBase64ImagesForClaudeWire(body, "zai/glm-5", providerFetch),
    (error: unknown) => {
      assert.ok(error instanceof RemoteMediaFetchError);
      assert.equal(error.retryable, false);
      assert.equal(error.status, 400);
      return true;
    }
  );
  assert.deepEqual(body, originalBody);
  assert.equal(providerSends, 0);
  assert.equal(transport.resolutions.length, 1);
  assert.equal(transport.dials.length, 1);
  await transport.sockets[0].closedPromise;
  assert.equal(transport.sockets[0].destroyed, true);
});
