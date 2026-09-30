import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { installPinnedTransport } from "../helpers/pinnedTransport.ts";
import {
  RemoteMediaFetchError,
  createRemoteMediaFailureResult,
  isRemoteMediaFailureResult,
} from "../../src/shared/network/remoteImageFetch.ts";

process.env.ADOBE_FIREFLY_BROWSER_REFRESH = "0";
const TOKEN = `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(
  JSON.stringify({
    user_id: "combo-boundary@AdobeID",
    type: "access_token",
    client_id: "clio-playground-web",
    exp: 4102444800,
  })
).toString("base64url")}.${"sig".padEnd(40, "x")}`;
const state = {
  credentials: { apiKey: TOKEN, authType: "apikey", connectionId: "test-adobe-combo" },
  selected: [] as string[],
  dispatched: [] as { kind: string; model: string; signal: AbortSignal | null }[],
  override: null as Record<string, unknown> | null,
  results: [] as unknown[],
};
const key = "omniroute.test.media-combo-boundary";
Object.defineProperty(globalThis, Symbol.for(key), { value: state, configurable: true });
const moduleUrl = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
const authUrl = new URL("../../src/sse/services/auth.ts", import.meta.url).href;
const authSpy = moduleUrl(`
  export * from ${JSON.stringify(authUrl)};
  const state = globalThis[Symbol.for(${JSON.stringify(key)})];
  export async function getProviderCredentialsWithQuotaPreflight(provider) { state.selected.push(provider); return state.credentials; }
  export async function clearRecoveredProviderState() {}
`);
function dispatchSpy(kind: string, filename: string, name: string) {
  const actual = new URL(filename, import.meta.url).href;
  return moduleUrl(`
    export * from ${JSON.stringify(actual)};
    import { ${name} as real } from ${JSON.stringify(actual)};
    const state = globalThis[Symbol.for(${JSON.stringify(key)})];
    export async function ${name}(opts) {
      state.dispatched.push({kind:${JSON.stringify(kind)},model:opts.body.model,signal:opts.signal});
      const result = state.override || await real(opts);
      state.results.push(result);
      return result;
    }
  `);
}
const imageSpy = dispatchSpy(
  "image",
  "../../open-sse/handlers/imageGeneration.ts",
  "handleImageGeneration"
);
const videoSpy = dispatchSpy(
  "video",
  "../../open-sse/handlers/videoGeneration.ts",
  "handleVideoGeneration"
);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const replacement =
      specifier === "@/sse/services/auth"
        ? authSpy
        : specifier === "@omniroute/open-sse/handlers/imageGeneration.ts"
          ? imageSpy
          : specifier === "@omniroute/open-sse/handlers/videoGeneration.ts"
            ? videoSpy
            : undefined;
    return replacement ? { url: replacement, shortCircuit: true } : nextResolve(specifier, context);
  },
});
const { createCombo } = await import("../../src/lib/db/combos.ts");
const { closeDbInstance } = await import("../../src/lib/db/core.ts");
const { executeImageCombo } = await import("../../open-sse/services/imageCombo.ts");
const { executeVideoCombo } = await import("../../open-sse/services/videoCombo.ts");
const { executeImageWithCredentialFallback } =
  await import("../../src/sse/services/imageCredentialRetry.ts");
const videoRoute = await import("../../src/app/api/v1/videos/generations/route.ts");
const logger = await import("../../src/sse/utils/logger.ts");
const originalFetch = globalThis.fetch;
let paid = 0;
test.beforeEach(() => {
  state.selected.length = 0;
  state.dispatched.length = 0;
  state.override = null;
  state.results.length = 0;
  paid = 0;
  globalThis.fetch = async () => {
    paid++;
    return Response.json({ error: "unexpected paid request" }, { status: 502 });
  };
});
test.afterEach(() => {
  globalThis.fetch = originalFetch;
});
test.after(() => {
  hooks.deregister();
  closeDbInstance();
  Reflect.deleteProperty(globalThis, Symbol.for(key));
});

for (const kind of ["image", "video"] as const) {
  const targets =
    kind === "image"
      ? ["adobe-firefly/gemini-flash-nano-banana-2", "ideogram/V_3"]
      : ["adobe-firefly/sora-2", "comfyui/animatediff"];
  const execute = kind === "image" ? executeImageCombo : executeVideoCombo;
  for (const reason of ["abort", "deadline", "later-invalid"] as const) {
    test(`${kind} combo stops local ${reason} before a next model/account or any upload/generation`, async (t) => {
      const name = `source-${kind}-${reason}`;
      await createCombo({ name, strategy: "priority", models: targets });
      if (reason === "deadline") t.mock.timers.enable({ apis: ["setTimeout"] });
      const wire = installPinnedTransport(t.mock, {
        dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
        connectImmediately: false,
      });
      t.after(wire.restore);
      const controller = new AbortController();
      const request = new Request("http://localhost/v1/media", { signal: controller.signal });
      const body = {
        model: name,
        prompt: "test",
        image_urls:
          reason === "later-invalid"
            ? ["data:image/png;base64,iVBORw==", "http://169.254.169.254/latest"]
            : ["https://source.example/image"],
      };
      const pending = execute(name, body, { request, policy: {} }, Date.now(), logger);
      if (reason !== "later-invalid") {
        await Promise.race([
          wire.dialed,
          pending.then(() => {
            throw new Error("combo returned before source dial");
          }),
        ]);
        if (reason === "abort") controller.abort();
        else t.mock.timers.tick(15_001);
      }
      const response = await pending;
      assert.equal(response.status, reason === "abort" ? 499 : reason === "deadline" ? 504 : 400);
      assert.match(JSON.stringify(await response.json()), /Remote image could not be loaded/);
      assert.equal(state.dispatched.length, 1, "must not dispatch a second combo model");
      assert.equal(state.selected.length, 1, "must not select a second model/account credential");
      assert.equal(state.dispatched[0].signal, request.signal);
      assert.equal(paid, 0, "no upload or paid generation may precede source validation");
      await Promise.all(wire.sockets.map((socket) => socket.closedPromise));
    });
  }

  test(`${kind} combo keeps existing fallback for unbranded provider504 even if it says retryable:false`, async () => {
    const name = `ordinary-${kind}-timeout`;
    await createCombo({ name, strategy: "priority", models: targets });
    state.override = {
      success: false,
      status: 504,
      error: "provider timeout",
      retryable: false,
      code: "REMOTE_MEDIA_FAILURE",
    };
    const response = await execute(
      name,
      { model: name, prompt: "test" },
      { request: new Request("http://localhost/v1/media"), policy: {} },
      Date.now(),
      logger
    );
    assert.equal(response.status, 504);
    assert.equal(state.dispatched.length, 2);
    assert.equal(paid, 0);
  });
}

for (const status of [499, 504]) {
  test(`local media${status} result cannot select another image account`, async () => {
    let selections = 0;
    const result = createRemoteMediaFailureResult(
      new RemoteMediaFetchError(new Error("fixture"), status)
    );
    const execution = await executeImageWithCredentialFallback({
      provider: "adobe-firefly",
      requestedModel: "nano-banana-pro",
      credentials: state.credentials,
      execute: async () => result,
      selectNextCredentials: async () => {
        selections++;
        return null;
      },
    });
    assert.equal(execution.result, result);
    assert.equal(selections, 0);
    assert.equal(isRemoteMediaFailureResult(result), true);
  });
}

test("local result provenance survives duplicate module detection, not JSON or provider error text", async () => {
  const duplicate = await import(
    new URL("../../src/shared/network/mediaFailure.ts?combo-result-hmr", import.meta.url).href
  );
  const result = duplicate.createRemoteMediaFailureResult(
    new duplicate.RemoteMediaFetchError(new Error("fixture"), 504)
  );
  assert.equal(isRemoteMediaFailureResult(result), true);
  assert.equal(isRemoteMediaFailureResult(JSON.parse(JSON.stringify(result))), false);
  assert.equal(isRemoteMediaFailureResult({ ...result }), false);
  assert.throws(
    () =>
      createRemoteMediaFailureResult({
        name: "RemoteMediaFetchError",
        status: 504,
        retryable: false,
      }),
    TypeError
  );
});

test("direct video route propagates caller abort to Adobe before upload or generation", async (t) => {
  const wire = installPinnedTransport(t.mock);
  t.after(wire.restore);
  const controller = new AbortController();
  controller.abort();
  const request = new Request("http://localhost/api/v1/videos/generations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: controller.signal,
    body: JSON.stringify({
      model: "adobe-firefly/sora-2",
      prompt: "test",
      image: "data:image/png;base64,iVBORw==",
    }),
  });
  const response = await videoRoute.POST(request);
  assert.equal(response.status, 499);
  assert.equal(state.dispatched.length, 1);
  assert.equal(state.dispatched[0].signal, request.signal);
  assert.equal(paid, 0);
  assert.equal(wire.dials.length, 0);
});

for (const kind of ["image", "video"] as const) {
  for (const pollFailure of ["initial-target", "redirect"] as const) {
    test(`Adobe ${kind} ${pollFailure} poll failure stops the combo after one paid dispatch`, async (t) => {
      const wire = installPinnedTransport(t.mock);
      t.after(wire.restore);
      const name = `adobe-${kind}-poll-${pollFailure}`;
      const targets =
        kind === "image"
          ? ["adobe-firefly/gemini-flash-nano-banana-2", "ideogram/V_3"]
          : ["adobe-firefly/sora-2", "comfyui/animatediff"];
      await createCombo({ name, strategy: "priority", models: targets });
      let polls = 0;
      globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (url.includes("generate-async")) {
          paid++;
          return Response.json({
            links: {
              result:
                pollFailure === "initial-target"
                  ? "https://bks-epo8552.adobe.io/v2/jobs/result/job?host=169.254.169.254"
                  : "https://firefly-epo855232.adobe.io/jobs/result/job",
            },
          });
        }
        polls++;
        assert.equal(
          url,
          "https://bks-epo8552.adobe.io/v2/jobs/result/job?host=firefly-epo855232.adobe.io"
        );
        assert.equal(init?.redirect, "manual");
        return new Response(null, {
          status: 307,
          headers: { location: "https://unknown.example/steal" },
        });
      };
      const execute = kind === "image" ? executeImageCombo : executeVideoCombo;
      const response = await execute(
        name,
        { model: name, prompt: "test" },
        { request: new Request("http://localhost/v1/media"), policy: {} },
        Date.now(),
        logger
      );
      assert.equal(response.status, 400);
      assert.equal(state.dispatched.length, 1);
      assert.equal(state.selected.length, 1);
      assert.equal(isRemoteMediaFailureResult(state.results[0]), true);
      assert.equal(paid, 1);
      assert.equal(polls, pollFailure === "initial-target" ? 0 : 1);
      assert.equal(wire.dials.length, 0);
    });
  }
}
