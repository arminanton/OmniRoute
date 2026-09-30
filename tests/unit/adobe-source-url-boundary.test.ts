import test from "node:test";
import assert from "node:assert/strict";
import "../../open-sse/utils/proxyFetch.ts";
import { resolveAdobeSourceImageIds } from "../../open-sse/services/adobeFireflyUpload.ts";
import { handleAdobeFireflyImageGeneration } from "../../open-sse/handlers/imageGeneration/providers/adobeFirefly.ts";
import { handleAdobeFireflyImageUpscale } from "../../open-sse/handlers/imageUpscale/adobeFirefly.ts";
import { handleAdobeFireflyVideoGeneration } from "../../open-sse/handlers/videoGeneration/adobeFireflyHandler.ts";
import { executeImageWithCredentialFallback } from "../../src/sse/services/imageCredentialRetry.ts";
import { installPinnedTransport } from "../helpers/pinnedTransport.ts";

const oldBrowserRefresh = process.env.ADOBE_FIREFLY_BROWSER_REFRESH;
process.env.ADOBE_FIREFLY_BROWSER_REFRESH = "0";
test.after(() => {
  if (oldBrowserRefresh === undefined) delete process.env.ADOBE_FIREFLY_BROWSER_REFRESH;
  else process.env.ADOBE_FIREFLY_BROWSER_REFRESH = oldBrowserRefresh;
});
const PUBLIC = [{ address: "93.184.216.34", family: 4 }];
const UUID = "123e4567-e89b-12d3-a456-426614174000";
const DATA = "data:image/png;base64,iVBORw==";
const TOKEN = `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(
  JSON.stringify({
    user_id: "source-boundary@AdobeID",
    type: "access_token",
    client_id: "clio-playground-web",
    exp: 4102444800,
  })
).toString("base64url")}.${"sig".padEnd(40, "x")}`;
const credentials = { apiKey: TOKEN, authType: "apikey", connectionId: "test-adobe-only" };

for (const image of [
  "http://127.1/image",
  "https://[::ffff:10.1.2.3]/image",
  "http://169.254.169.254/latest",
  "https://[fe90::1]/image",
  "https://user:pass@public.example/image",
]) {
  test(`Adobe denies caller source before any upload or generation: ${image}`, async (t) => {
    const wire = installPinnedTransport(t.mock);
    t.after(wire.restore);
    let sends = 0;
    const providerFetch: typeof fetch = async () => {
      sends++;
      throw new Error("unexpected provider send");
    };
    await assert.rejects(
      resolveAdobeSourceImageIds({
        accessToken: TOKEN,
        body: { image_urls: [DATA, image] },
        fetchImpl: providerFetch,
      }),
      { name: "RemoteMediaFetchError", status: 400, retryable: false }
    );
    assert.equal(sends, 0, "all source validation must finish before even the first upload");
    assert.equal(wire.dials.length, 0);
  });
}

test("Adobe rejects a mixed public/private DNS answer without upload or dial", async (t) => {
  const wire = installPinnedTransport(t.mock, {
    dnsLookup: async () => [...PUBLIC, { address: "10.0.0.2", family: 4 }],
  });
  t.after(wire.restore);
  let sends = 0;
  await assert.rejects(
    resolveAdobeSourceImageIds({
      accessToken: TOKEN,
      body: { image: "https://source.example/image" },
      fetchImpl: async () => {
        sends++;
        throw new Error("unexpected provider send");
      },
    }),
    { name: "RemoteMediaFetchError", status: 400 }
  );
  assert.equal(sends, 0);
  assert.equal(wire.dials.length, 0);
});

test("Adobe downloads through real pinned TLS once, without credentials, then preserves upload auth and bytes", async (t) => {
  let resolutions = 0;
  const wire = installPinnedTransport(t.mock, {
    dnsLookup: async () => (++resolutions === 1 ? PUBLIC : [{ address: "127.0.0.1", family: 4 }]),
    reply(socket) {
      assert.doesNotMatch(
        socket.request,
        /authorization:|cookie:|x-api-key:|x-arp-session-id:|x-nonce:/i
      );
      socket.respond({
        headers: { "content-type": "image/jpeg; charset=binary" },
        body: new Uint8Array([255, 216, 255, 217]),
      });
    },
  });
  t.after(wire.restore);
  let uploads = 0;
  const controller = new AbortController();
  const ids = await resolveAdobeSourceImageIds({
    accessToken: TOKEN,
    body: { image_urls: [UUID, "https://source.example/image"] },
    signal: controller.signal,
    arpSessionId: "test-arp",
    sessionCookie: "session=test-secret",
    prompt: "test",
    fetchImpl: async (input, init) => {
      uploads++;
      assert.equal(String(input), "https://firefly-3p.ff.adobe.io/v2/storage/image");
      assert.equal(init?.signal, controller.signal);
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${TOKEN}`);
      assert.equal(new Headers(init?.headers).get("x-arp-session-id"), "test-arp");
      assert.equal(new Headers(init?.headers).get("content-type"), "image/jpeg");
      assert.equal(new Headers(init?.headers).get("cookie"), null);
      assert.deepEqual(init?.body, new Uint8Array([255, 216, 255, 217]));
      return Response.json({ images: [{ id: "uploaded" }] });
    },
  });
  assert.deepEqual(ids, [UUID, "uploaded"]);
  assert.equal(uploads, 1);
  assert.equal(resolutions, 1);
  assert.equal(wire.lookups[0].address, "93.184.216.34");
  assert.equal(wire.dials[0].options.servername, "source.example");
});

for (const failure of [
  "private-redirect",
  "redirect-limit",
  "declared-body-limit",
  "streamed-body-limit",
] as const) {
  test(`Adobe source ${failure} cancels before upload or generation`, async (t) => {
    const wire = installPinnedTransport(t.mock, {
      dnsLookup: async () => PUBLIC,
      reply(socket) {
        if (failure === "private-redirect")
          socket.respond({ status: 302, headers: { location: "http://169.254.169.254/latest" } });
        else if (failure === "redirect-limit")
          socket.respond({ status: 302, headers: { location: "https://source.example/again" } });
        else if (failure === "declared-body-limit")
          socket.push("HTTP/1.1 200 OK\r\nContent-Length: 20971521\r\n\r\n");
        else {
          const bytes = Buffer.alloc(20 * 1024 * 1024 + 1, 1);
          socket.push("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n");
          socket.push(bytes.length.toString(16) + "\r\n");
          socket.push(bytes);
          socket.push("\r\n0\r\n\r\n");
        }
      },
    });
    t.after(wire.restore);
    let sends = 0;
    await assert.rejects(
      resolveAdobeSourceImageIds({
        accessToken: TOKEN,
        body: { image: "https://source.example/image" },
        fetchImpl: async () => {
          sends++;
          throw new Error("unexpected provider send");
        },
      }),
      { name: "RemoteMediaFetchError", status: 400 }
    );
    assert.equal(sends, 0);
    assert.equal(wire.dials.length, failure === "redirect-limit" ? 4 : 1);
    await Promise.all(wire.sockets.map((socket) => socket.closedPromise));
    assert.ok(wire.sockets.every((socket) => socket.destroyed));
  });
}

test("Adobe source abort destroys the pending native socket with zero uploads", async (t) => {
  const wire = installPinnedTransport(t.mock, {
    dnsLookup: async () => PUBLIC,
    connectImmediately: false,
  });
  t.after(wire.restore);
  const controller = new AbortController();
  let sends = 0;
  const pending = resolveAdobeSourceImageIds({
    accessToken: TOKEN,
    body: { image: "https://source.example/image" },
    signal: controller.signal,
    fetchImpl: async () => {
      sends++;
      throw new Error("unexpected provider send");
    },
  });
  await wire.dialed;
  controller.abort();
  await assert.rejects(pending, { name: "RemoteMediaFetchError", status: 499 });
  await wire.sockets[0].closedPromise;
  assert.equal(sends, 0);
  assert.equal(wire.sockets[0].destroyed, true);
});

test("Adobe keeps literal UUID/data/raw-base64 source contracts without DNS or remote media", async (t) => {
  const wire = installPinnedTransport(t.mock);
  t.after(wire.restore);
  let uploads = 0;
  const raw = Buffer.alloc(60, 1).toString("base64");
  const ids = await resolveAdobeSourceImageIds({
    accessToken: TOKEN,
    body: { image_urls: [UUID, DATA, raw] },
    fetchImpl: async () => Response.json({ images: [{ id: `blob-${++uploads}` }] }),
  });
  assert.deepEqual(ids, [UUID, "blob-1", "blob-2"]);
  assert.equal(wire.resolutions.length, 0);
  assert.equal(wire.dials.length, 0);
});

for (const kind of ["image", "upscale", "video"] as const) {
  test(`Adobe ${kind} handler makes source denial terminal before any provider send`, async (t) => {
    const wire = installPinnedTransport(t.mock);
    t.after(wire.restore);
    let sends = 0;
    let selections = 0;
    const fetchImpl: typeof fetch = async () => {
      sends++;
      throw new Error("unexpected upload or paid generation");
    };
    const body = { prompt: "test", image_url: "http://169.254.169.254/latest" };
    const call = () =>
      kind === "image"
        ? handleAdobeFireflyImageGeneration({
            model: "nano-banana-pro",
            provider: "adobe-firefly",
            body,
            credentials,
            fetchImpl,
          })
        : kind === "video"
          ? handleAdobeFireflyVideoGeneration({
              model: "sora-2",
              provider: "adobe-firefly",
              body,
              credentials,
              fetchImpl,
            })
          : handleAdobeFireflyImageUpscale({
              model: "topaz-standard",
              provider: "adobe-firefly",
              body,
              credentials,
              fetchImpl,
            });
    const { result } = await executeImageWithCredentialFallback({
      provider: "adobe-firefly",
      requestedModel: kind,
      credentials,
      execute: call,
      selectNextCredentials: async () => {
        selections++;
        return null;
      },
    });
    assert.equal(result.success, false);
    assert.equal(result.status, 400);
    assert.notEqual(result.retryable, true);
    assert.equal(sends, 0);
    assert.equal(selections, 0);
    assert.equal(wire.dials.length, 0);
  });
}

test("Adobe whole-source deadline cancels the native connector before any upload", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const wire = installPinnedTransport(t.mock, {
    dnsLookup: async () => PUBLIC,
    connectImmediately: false,
  });
  t.after(wire.restore);
  let sends = 0;
  const pending = resolveAdobeSourceImageIds({
    accessToken: TOKEN,
    body: { image: "https://source.example/image" },
    fetchImpl: async () => {
      sends++;
      throw new Error("unexpected provider send");
    },
  });
  await wire.dialed;
  t.mock.timers.tick(15_001);
  await assert.rejects(pending, { name: "RemoteMediaFetchError", status: 504, retryable: false });
  await wire.sockets[0].closedPromise;
  assert.equal(sends, 0);
  assert.equal(wire.sockets[0].destroyed, true);
});

for (const kind of ["image", "upscale", "video"] as const) {
  test(`Adobe ${kind} pre-aborted caller cannot start auth, upload, or generation`, async (t) => {
    const wire = installPinnedTransport(t.mock);
    t.after(wire.restore);
    const controller = new AbortController();
    controller.abort();
    let sends = 0;
    const opts = {
      provider: "adobe-firefly",
      body: { prompt: "test", image: DATA },
      credentials,
      signal: controller.signal,
      fetchImpl: (async () => {
        sends++;
        throw new Error("unexpected provider send");
      }) as typeof fetch,
    };
    const result =
      kind === "image"
        ? await handleAdobeFireflyImageGeneration({ ...opts, model: "nano-banana-pro" })
        : kind === "upscale"
          ? await handleAdobeFireflyImageUpscale({ ...opts, model: "topaz-standard" })
          : await handleAdobeFireflyVideoGeneration({ ...opts, model: "sora-2" });
    assert.equal(result.success, false);
    assert.equal("status" in result && result.status, 499);
    assert.equal(sends, 0);
    assert.equal(wire.dials.length, 0);
  });
}
