import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { type TestContext } from "node:test";
import {
  installPinnedTransport,
  type FakePinnedTransportOptions,
} from "../helpers/pinnedTransport.ts";

const moduleUrl = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
// Mock only persistence, configured policy, and poll waits. The returned-image
// guard, DNS pin, Undici fetch/connector, and body reader remain real.
const usageStub = moduleUrl("export async function saveCallLog() {}");
const settingsStub = moduleUrl(
  'export async function resolveProxyForConnection() { return {level:"direct",proxy:null}; }'
);
const proxyStub = moduleUrl(`
  export const resolveProxyForRequest = () => ({source:"direct",proxyUrl:null});
  export const hasAmbientProxyContext = () => false;
`);
const flagsStub = moduleUrl(`
  export const isFeatureFlagEnabled = () => false;
  export const resolveFeatureFlag = () => undefined;
`);
const sleepStub = moduleUrl("export async function sleep() {}");
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const replacement =
      specifier === "@/lib/usageDb"
        ? usageStub
        : specifier === "@/lib/db/settings"
          ? settingsStub
          : specifier === "@omniroute/open-sse/utils/proxyFetch.ts"
            ? proxyStub
            : specifier === "@/shared/utils/featureFlags"
              ? flagsStub
              : specifier === "../../../utils/sleep.ts"
                ? sleepStub
                : undefined;
    if (replacement) return { url: replacement, shortCircuit: true };
    const resolved = nextResolve(specifier, context);
    assert.ok(!resolved.url.includes("/src/lib/db/"), "real DB modules must not load");
    return resolved;
  },
});
const proxyEnv = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
];
const savedEnv = new Map(proxyEnv.map((key) => [key, process.env[key]]));
for (const key of proxyEnv) delete process.env[key];
test.after(() => {
  hooks.deregister();
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const { handleMagnificImageGeneration } =
  await import("../../open-sse/handlers/imageGeneration/providers/magnific.ts");
const { handleLeonardoImageGeneration } =
  await import("../../open-sse/handlers/imageGeneration/providers/leonardo.ts");
const { handleIdeogramImageGeneration } =
  await import("../../open-sse/handlers/imageGeneration/providers/ideogram.ts");
const { handleHaiperImageGeneration } =
  await import("../../open-sse/handlers/imageGeneration/providers/haiper.ts");

const { RemoteMediaFetchError, isRemoteMediaFailureResult } =
  await import("../../src/shared/network/remoteImageFetch.ts");
const duplicateModuleUrl = new URL(
  "../../src/shared/network/mediaFailure.ts?returned-image-provider-hmr",
  import.meta.url
);
const duplicateModule = (await import(
  duplicateModuleUrl.href
)) as typeof import("../../src/shared/network/mediaFailure.ts");

const prompt = "a fixture landscape";
const token = "fixture-api-key";
const publicAddress = { address: "93.184.216.34", family: 4 };
const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255]);
const imageUrl = "https://images.example:8443/result.png?fixture=1";
const providers = [
  {
    name: "magnific",
    model: "realism",
    handler: handleMagnificImageGeneration,
    authHeader: "x-magnific-api-key",
    authValue: token,
    request: { prompt, model: "realism", resolution: "1k", aspect_ratio: "square_1_1" },
    submit: { data: { task_id: "fixture-job" } },
    completed: (url: string) => ({ data: { status: "COMPLETED", generated: [url] } }),
  },
  {
    name: "leonardo",
    model: "phoenix",
    handler: handleLeonardoImageGeneration,
    authHeader: "authorization",
    authValue: `Bearer ${token}`,
    request: { modelId: "phoenix", prompt, width: 1024, height: 1024, num_images: 1 },
    submit: { sdGenerationJob: { generationId: "fixture-job" } },
    completed: (url: string) => ({
      generations_by_pk: { status: "COMPLETE", generated_images: [{ url }] },
    }),
  },
  {
    name: "ideogram",
    model: "V_3",
    handler: handleIdeogramImageGeneration,
    authHeader: "api-key",
    authValue: token,
    request: { prompt, aspect_ratio: "ASPECT_16_9", model: "V_3" },
    submit: null,
    completed: (url: string) => ({ data: [{ url }] }),
  },
  {
    name: "haiper",
    model: "fixture-model",
    handler: handleHaiperImageGeneration,
    authHeader: "haiper_key",
    authValue: token,
    request: { prompt, aspect_ratio: "16:9" },
    submit: { job_id: "fixture-job" },
    completed: (url: string) => ({ status: "completed", creation_url: url }),
  },
];
type Provider = (typeof providers)[number];
interface ImageResult {
  success: boolean;
  status?: number;
  error?: string;
  retryable?: boolean;
  data?: { created: number; data: { b64_json: string }[] };
}

function fixture(
  t: TestContext,
  provider: Provider,
  url = imageUrl,
  options: FakePinnedTransportOptions = {}
) {
  const transport = installPinnedTransport(t.mock, {
    dnsLookup: async () => [publicAddress],
    reply: (socket) => socket.respond({ body: imageBytes }),
    ...options,
  });
  t.after(transport.restore);
  const providerUrl = `https://${provider.name}.provider.example/generate`;
  const calls: { url: string; method: string }[] = [];
  let expectedSignal: AbortSignal | undefined;
  t.mock.method(globalThis, "fetch", async (input: string | URL, init: RequestInit = {}) => {
    const target = String(input);
    const method = init.method || "GET";
    calls.push({ url: target, method });
    assert.equal(init.signal, expectedSignal, "provider transport must retain caller cancellation");
    assert.equal(new Headers(init.headers).get(provider.authHeader), provider.authValue);
    if (target === providerUrl && method === "POST") {
      assert.deepEqual(JSON.parse(String(init.body)), provider.request);
      return Response.json(provider.submit || provider.completed(url));
    }
    assert.notEqual(provider.name, "ideogram", "synchronous provider must not poll");
    assert.equal(target, `${providerUrl}/fixture-job`, "no alternate/raw media fetch allowed");
    return Response.json(provider.completed(url));
  });
  return {
    transport,
    calls,
    async run(signal?: AbortSignal): Promise<ImageResult> {
      expectedSignal = signal;
      return provider.handler({
        model: provider.model,
        provider: provider.name,
        providerConfig: { baseUrl: providerUrl, statusUrl: providerUrl },
        body: { prompt },
        credentials: { apiKey: token },
        log: undefined,
        signal,
      });
    },
    assertNoExtraSends() {
      assert.deepEqual(calls, [
        { url: providerUrl, method: "POST" },
        ...(provider.submit ? [{ url: `${providerUrl}/fixture-job`, method: "GET" }] : []),
      ]);
    },
  };
}

function assertTerminal(result: ImageResult, status = 400) {
  assert.equal(result.success, false);
  assert.equal(result.status, status);
  assert.equal(result.retryable, false, "download failure must not invite paid/account fallback");
  assert.equal(result.error, "Remote image could not be loaded");
  assert.equal(isRemoteMediaFailureResult(result), true, "local result must stop combo fallback");
  assert.equal(isRemoteMediaFailureResult(JSON.parse(JSON.stringify(result))), false);
  assert.equal(isRemoteMediaFailureResult({ ...result }), false, "brand must not be enumerable");
}

for (const provider of providers) {
  test(`${provider.name}: an already-aborted caller cannot submit a paid generation`, async (t) => {
    const controller = new AbortController();
    controller.abort("fixture caller stopped");
    const f = fixture(t, provider);
    assertTerminal(await f.run(controller.signal), 499);
    assert.deepEqual(f.calls, []);
    assert.equal(f.transport.resolutions.length, 0);
    assert.equal(f.transport.dials.length, 0);
  });

  test(`${provider.name}: caller abort at submission is terminal without another send`, async (t) => {
    const controller = new AbortController();
    const f = fixture(t, provider);
    let sends = 0;
    t.mock.method(globalThis, "fetch", async (_input: string | URL, init: RequestInit) => {
      sends++;
      assert.equal(init.signal, controller.signal);
      controller.abort();
      throw controller.signal.reason;
    });
    assertTerminal(await f.run(controller.signal), 499);
    assert.equal(sends, 1);
    assert.equal(f.transport.resolutions.length, 0);
    assert.equal(f.transport.dials.length, 0);
  });

  test(`${provider.name}: returned bytes use the native DNS pin, without provider credentials`, async (t) => {
    const f = fixture(t, provider);
    const result = await f.run();
    assert.equal(result.success, true);
    assert.equal(isRemoteMediaFailureResult(result), false);
    assert.deepEqual(result.data?.data, [{ b64_json: imageBytes.toString("base64") }]);
    assert.equal(typeof result.data?.created, "number");
    assert.equal(f.transport.resolutions.length, 1);
    assert.equal(f.transport.dials.length, 1);
    assert.equal(f.transport.dials[0].options.servername, "images.example");
    assert.equal(Number(f.transport.dials[0].options.port), 8443);
    assert.deepEqual(f.transport.lookups, [
      { hostname: "images.example", all: true, ...publicAddress },
    ]);
    const wire = f.transport.sockets[0].request;
    assert.match(wire, /^GET \/result.png\?fixture=1 HTTP\/1.1\r\n/);
    assert.match(wire, /\r\nhost: images.example:8443\r\n/i);
    assert.doesNotMatch(wire, /authorization:|cookie:|api-key:|haiper_key:|fixture-api-key/i);
    f.assertNoExtraSends();
  });

  for (const url of [
    "http://127.0.0.1/private",
    "http://169.254.169.254/latest/meta-data",
    "http://2130706433/private",
    "http://[::ffff:127.0.0.1]/private",
    "http://[fe80::1]/private",
    "file:///etc/passwd",
    "https://user:password@images.example/image",
  ]) {
    test(`${provider.name}: denies returned literal ${url} before any dial`, async (t) => {
      const f = fixture(t, provider, url);
      assertTerminal(await f.run());
      assert.equal(f.transport.resolutions.length, 0);
      assert.equal(f.transport.dials.length, 0);
      f.assertNoExtraSends();
    });
  }

  for (const answer of [
    { address: "127.0.0.1", family: 4 },
    { address: "169.254.169.254", family: 4 },
    { address: "fd00::1", family: 6 },
    { address: "93.184.216.34", family: 6 },
  ]) {
    test(`${provider.name}: rejects every DNS answer including ${answer.address}/${answer.family}`, async (t) => {
      const f = fixture(t, provider, imageUrl, {
        dnsLookup: async () => [publicAddress, answer],
      });
      assertTerminal(await f.run());
      assert.equal(f.transport.resolutions.length, 1);
      assert.equal(f.transport.dials.length, 0);
      f.assertNoExtraSends();
    });
  }

  test(`${provider.name}: DNS lookup errors are terminal without a dial`, async (t) => {
    const f = fixture(t, provider, imageUrl, {
      dnsLookup: async () => {
        throw new Error("fixture DNS failure");
      },
    });
    assertTerminal(await f.run());
    assert.equal(f.transport.resolutions.length, 1);
    assert.equal(f.transport.dials.length, 0);
    f.assertNoExtraSends();
  });

  test(`${provider.name}: native connection failures do not start another generation`, async (t) => {
    const f = fixture(t, provider, imageUrl, {
      connectError: new Error("fixture connect failure"),
    });
    assertTerminal(await f.run());
    assert.equal(f.transport.dials.length, 1);
    await f.transport.sockets[0].closedPromise;
    f.assertNoExtraSends();
  });

  test(`${provider.name}: a same-origin redirect rechecks rebound DNS before another dial`, async (t) => {
    let lookups = 0;
    const f = fixture(t, provider, imageUrl, {
      dnsLookup: async () => [++lookups === 1 ? publicAddress : { address: "10.0.0.1", family: 4 }],
      reply(socket) {
        socket.push("HTTP/1.1 302 Found\r\nLocation: /rebound\r\nContent-Length: 1000\r\n\r\nx");
      },
    });
    assertTerminal(await f.run());
    assert.equal(f.transport.resolutions.length, 2);
    assert.equal(f.transport.dials.length, 1);
    assert.equal(f.transport.lookups[0].address, publicAddress.address);
    await Promise.all(f.transport.sockets.map((socket) => socket.closedPromise));
    f.assertNoExtraSends();
  });

  test(`${provider.name}: a private redirect cannot cause a second dial`, async (t) => {
    const f = fixture(t, provider, imageUrl, {
      reply: (socket) =>
        socket.respond({ status: 307, headers: { location: "http://169.254.169.254/private" } }),
    });
    assertTerminal(await f.run());
    assert.equal(f.transport.dials.length, 1);
    f.assertNoExtraSends();
  });

  test(`${provider.name}: relative public redirects preserve the successful base64 contract`, async (t) => {
    let replies = 0;
    const f = fixture(t, provider, imageUrl, {
      reply: (socket) =>
        socket.respond(
          ++replies === 1
            ? { status: 302, headers: { location: "/final.png" } }
            : { body: imageBytes }
        ),
    });
    assert.deepEqual((await f.run()).data?.data, [{ b64_json: imageBytes.toString("base64") }]);
    assert.equal(f.transport.resolutions.length, 2);
    assert.equal(f.transport.dials.length, 2);
    assert.match(f.transport.sockets[1].request, /^GET \/final.png HTTP\/1.1/);
    f.assertNoExtraSends();
  });

  test(`${provider.name}: the redirect limit is terminal without more paid sends`, async (t) => {
    const f = fixture(t, provider, imageUrl, {
      reply: (socket) => socket.respond({ status: 302, headers: { location: "/again" } }),
    });
    assertTerminal(await f.run());
    assert.equal(f.transport.dials.length, 4);
    assert.equal(f.transport.resolutions.length, 4);
    f.assertNoExtraSends();
  });

  for (const chunked of [false, true]) {
    test(`${provider.name}: ${chunked ? "streamed" : "declared"} body limit cancels the socket`, async (t) => {
      const f = fixture(t, provider, imageUrl, {
        reply(socket) {
          if (!chunked) {
            socket.push("HTTP/1.1 200 OK\r\nContent-Length: 20971521\r\n\r\n");
            return;
          }
          socket.push("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n");
          const chunk = Buffer.alloc(1024 * 1024, 1);
          for (let i = 0; i < 21; i++) {
            socket.push("100000\r\n");
            socket.push(chunk);
            socket.push("\r\n");
          }
          // No EOF: the reader must cancel, not wait for the rest of the body.
        },
      });
      assertTerminal(await f.run());
      assert.equal(f.transport.dials.length, 1);
      await f.transport.sockets[0].closedPromise;
      f.assertNoExtraSends();
    });
  }

  test(`${provider.name}: HTTP media errors are terminal rather than provider retries`, async (t) => {
    const f = fixture(t, provider, imageUrl, {
      reply: (socket) => socket.respond({ status: 503, body: "media unavailable" }),
    });
    assertTerminal(await f.run());
    assert.equal(f.transport.dials.length, 1);
    f.assertNoExtraSends();
  });

  test(`${provider.name}: caller abort during DNS prevents the returned-image dial`, async (t) => {
    const controller = new AbortController();
    const f = fixture(t, provider, imageUrl, {
      dnsLookup: async () => {
        controller.abort();
        return [publicAddress];
      },
    });
    assertTerminal(await f.run(controller.signal), 499);
    assert.equal(f.transport.dials.length, 0);
    f.assertNoExtraSends();
  });

  test(`${provider.name}: caller abort tears down a pending native media connection`, async (t) => {
    const controller = new AbortController();
    const f = fixture(t, provider, imageUrl, { connectImmediately: false });
    const pending = f.run(controller.signal);
    await f.transport.dialed;
    controller.abort();
    assertTerminal(await pending, 499);
    assert.equal(f.transport.dials.length, 1);
    await f.transport.sockets[0].closedPromise;
    f.assertNoExtraSends();
  });

  test(`${provider.name}: caller abort tears down a streaming media response`, async (t) => {
    const controller = new AbortController();
    const f = fixture(t, provider, imageUrl, {
      reply(socket) {
        socket.push("HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\nx");
        setImmediate(() => controller.abort());
      },
    });
    assertTerminal(await f.run(controller.signal), 499);
    assert.equal(f.transport.dials.length, 1);
    await f.transport.sockets[0].closedPromise;
    f.assertNoExtraSends();
  });

  for (const phase of ["DNS", "body"]) {
    test(`${provider.name}: the shared ${phase} deadline returns terminal 504`, async (t) => {
      const realSetTimeout = globalThis.setTimeout;
      t.mock.method(globalThis, "setTimeout", (callback: () => void, delay?: number) =>
        realSetTimeout(callback, delay === 15000 ? 25 : delay)
      );
      const f = fixture(t, provider, imageUrl, {
        ...(phase === "DNS" ? { dnsLookup: () => new Promise<never>(() => {}) } : {}),
        reply: (socket) => socket.push("HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\nx"),
      });
      assertTerminal(await f.run(), 504);
      assert.equal(f.transport.dials.length, phase === "DNS" ? 0 : 1);
      await Promise.all(f.transport.sockets.map((socket) => socket.closedPromise));
      f.assertNoExtraSends();
    });
  }

  test(`${provider.name}: duplicate-module media errors retain their local terminal brand`, async (t) => {
    assert.notEqual(duplicateModule.RemoteMediaFetchError, RemoteMediaFetchError);
    const failure = new duplicateModule.RemoteMediaFetchError(
      new Error("media failed\n    at /srv/private/image.ts:1:1"),
      504
    );
    const f = fixture(t, provider);
    let sends = 0;
    t.mock.method(globalThis, "fetch", async () => {
      sends++;
      throw failure;
    });
    const result = await f.run();
    assertTerminal(result, 504);
    assert.ok(!result.error?.includes("/srv/private/image.ts"));
    assert.equal(sends, 1);
    assert.equal(f.transport.dials.length, 0);
  });

  test(`${provider.name}: provider errors cannot spoof the local media failure brand`, async (t) => {
    const f = fixture(t, provider);
    let sends = 0;
    t.mock.method(globalThis, "fetch", async () => {
      sends++;
      throw Object.assign(new Error("provider error"), {
        name: "RemoteMediaFetchError",
        status: 499,
        retryable: false,
        code: "OUTBOUND_URL_GUARD_BLOCKED",
      });
    });
    const result = await f.run();
    assert.equal(result.success, false);
    assert.equal(result.status, 502);
    assert.notEqual(result.retryable, false);
    assert.equal(isRemoteMediaFailureResult(result), false);
    assert.equal(sends, 1);
    assert.equal(f.transport.dials.length, 0);
  });
}
