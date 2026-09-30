import test from "node:test";
import assert from "node:assert/strict";
import { handleImageGeneration } from "../../open-sse/handlers/imageGeneration.ts";
import { resolveUpscaleImageSource } from "../../open-sse/handlers/imageUpscale/shared.ts";
import { installPinnedTransport } from "../helpers/pinnedTransport.ts";

const originalFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("image input and upscale callers reject local URLs before provider auth or a socket", async (t) => {
  const transport = installPinnedTransport(t.mock);
  t.after(transport.restore);
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls++;
    throw new Error("unexpected provider request");
  };
  for (const image of [
    "http://127.1/image",
    "http://[::ffff:10.1.2.3]/image",
    "http://[fe90::1]/image",
  ]) {
    const result = await handleImageGeneration({
      body: { model: "topaz/topaz-enhance", image_url: image },
      credentials: { apiKey: "private-provider-token" },
      log: null,
    });
    assert.equal(result.success, false);
    await assert.rejects(resolveUpscaleImageSource(image), /blocked/i);
  }
  assert.equal(providerCalls, 0);
  assert.equal(transport.dials.length, 0);
});

test("upscale resolves all answers and pins the lower connector without a second DNS query", async (t) => {
  let resolutions = 0;
  const transport = installPinnedTransport(t.mock, {
    dnsLookup: async () => [
      { address: ++resolutions === 1 ? "93.184.216.34" : "127.0.0.1", family: 4 },
    ],
    reply(socket) {
      assert.doesNotMatch(socket.request, /authorization:|x-api-key:/i);
      socket.respond({
        headers: { "content-type": "image/png" },
        body: new Uint8Array([137, 80, 78, 71]),
      });
    },
  });
  t.after(transport.restore);
  const result = await resolveUpscaleImageSource("https://untrusted.example/image");
  assert.equal(result.base64, "iVBORw==");
  assert.equal(resolutions, 1);
  assert.equal(transport.lookups[0].address, "93.184.216.34");
  assert.equal(transport.dials[0].options.servername, "untrusted.example");
});

test("upscale caller cancellation destroys the lower pending socket", async (t) => {
  const transport = installPinnedTransport(t.mock, {
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    connectImmediately: false,
  });
  t.after(transport.restore);
  const controller = new AbortController();
  const pending = resolveUpscaleImageSource("https://untrusted.example/image", controller.signal);
  await transport.dialed;
  controller.abort(new DOMException("Caller stopped", "AbortError"));
  await assert.rejects(pending, { name: "RemoteMediaFetchError", status: 499 });
  await transport.sockets[0].closedPromise;
  assert.equal(transport.sockets[0].destroyed, true);
});

test("NanoBanana returned URL is untrusted; metadata pointer cannot receive a socket", async (t) => {
  const transport = installPinnedTransport(t.mock);
  t.after(transport.restore);
  const providerCalls: string[] = [];
  globalThis.fetch = async (url) => {
    providerCalls.push(String(url));
    if (String(url).includes("/generate"))
      return Response.json({ code: 200, data: { taskId: "task" } });
    if (String(url).includes("/record-info"))
      return Response.json({
        code: 200,
        data: {
          successFlag: 1,
          response: { resultImageUrl: "http://169.254.169.254/latest" },
        },
      });
    throw new Error("unexpected provider request");
  };
  const result = await handleImageGeneration({
    body: { model: "nanobanana/nanobanana-flash", prompt: "test", response_format: "b64_json" },
    credentials: { apiKey: "private-provider-token" },
    log: null,
  });
  assert.equal(result.success, false);
  assert.equal(providerCalls.length, 2);
  assert.equal(transport.dials.length, 0);
});

test("image source abort cannot start a paid provider request or an account fallback", async (t) => {
  const transport = installPinnedTransport(t.mock, {
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    connectImmediately: false,
  });
  t.after(transport.restore);
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls++;
    throw new Error("unexpected paid request");
  };
  const controller = new AbortController();
  const pending = handleImageGeneration({
    body: { model: "topaz/topaz-enhance", image_url: "https://input.example/image" },
    credentials: { apiKey: "private-provider-token" },
    log: null,
    signal: controller.signal,
  });
  await transport.dialed;
  controller.abort();
  const result = await pending;
  assert.equal(result.success, false);
  assert.ok("status" in result);
  assert.equal(result.status, 499);
  assert.equal("retryable" in result && result.retryable, false);
  assert.equal(providerCalls, 0);
  await transport.sockets[0].closedPromise;
});

test("invalid returned image is terminal for account fallback after the single paid generation", async (t) => {
  const { executeImageWithCredentialFallback } =
    await import("../../src/sse/services/imageCredentialRetry.ts");
  const transport = installPinnedTransport(t.mock);
  t.after(transport.restore);
  let generations = 0;
  let selections = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/generate")) {
      generations++;
      return Response.json({ code: 200, data: { taskId: "task" } });
    }
    if (String(url).includes("/record-info"))
      return Response.json({
        code: 200,
        data: {
          successFlag: 1,
          response: { resultImageUrl: "http://169.254.169.254/latest" },
        },
      });
    throw new Error("unexpected request");
  };
  const { result } = await executeImageWithCredentialFallback({
    provider: "nanobanana",
    requestedModel: "nanobanana/nanobanana-flash",
    credentials: { apiKey: "private-token", connectionId: "fake-account", authType: "apikey" },
    execute: (credentials) =>
      handleImageGeneration({
        body: { model: "nanobanana/nanobanana-flash", prompt: "test", response_format: "b64_json" },
        credentials,
        log: null,
      }),
    selectNextCredentials: async () => {
      selections++;
      return null;
    },
  });
  assert.equal(result.success, false);
  assert.equal(result.retryable, false);
  assert.equal(generations, 1);
  assert.equal(selections, 0);
  assert.equal(transport.dials.length, 0);
});
