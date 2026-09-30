/** Branded remote-media failures must not become provider fallback or stub text. */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { installPinnedTransport } from "../../helpers/pinnedTransport.ts";
import type { GuardrailContext } from "../../../src/lib/guardrails/base.ts";
import type { VisionModelConfig } from "../../../src/lib/guardrails/visionBridgeHelpers.ts";

// Replace only unrelated DB/catalog boundaries. URL policy, proxy context, DNS
// pinning, Undici fetch/connector, and stream reads all remain production code.
const moduleUrl = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
const settingsUrl = moduleUrl(`
  export async function getSettings() { return {}; }
  export async function resolveProxyForConnection() { return { level: "direct", proxy: null }; }
`);
const capabilitiesUrl = moduleUrl(`
  export function getResolvedModelCapabilities(model) {
    return { supportsVision: String(model).startsWith("anthropic/") || String(model).startsWith("openai/gpt-4o") };
  }
`);
const catalogUrl = moduleUrl(`
  export async function getActiveSyncedCatalog() { return { authoritative: false, models: [] }; }
`);
const flagsUrl = moduleUrl(`
  export const isControlPlaneProxyDirectFallbackEnabled = () => false;
  export const isFeatureFlagEnabled = () => false;
`);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/db/settings") return { url: settingsUrl, shortCircuit: true };
    if (specifier === "@/lib/modelCapabilities")
      return { url: capabilitiesUrl, shortCircuit: true };
    if (specifier === "@/lib/db/models/activeSyncedCatalog")
      return { url: catalogUrl, shortCircuit: true };
    if (specifier === "@/shared/utils/featureFlags") return { url: flagsUrl, shortCircuit: true };
    const resolved = nextResolve(specifier, context);
    assert.ok(!resolved.url.includes("/src/lib/db/"), "no real DB module may load");
    return resolved;
  },
});
const originalFetch = globalThis.fetch;
const { callVisionModel, ensureBase64ImagesForClaudeWire } =
  await import("../../../src/lib/guardrails/visionBridgeHelpers.ts");
const { VisionBridgeGuardrail } = await import("../../../src/lib/guardrails/visionBridge.ts");
const { RemoteMediaFetchError } = await import("../../../src/shared/network/remoteImageFetch.ts");
const { runWithProxyContext } = await import("../../../open-sse/utils/proxyFetch.ts");
const { clearSelectionCache, getFallbackModels } =
  await import("../../../src/lib/guardrails/visionBridgeRouter.ts");

const ENV_KEYS = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
];
const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
test.beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  clearSelectionCache();
});
test.after(() => {
  hooks.deregister();
  globalThis.fetch = originalFetch;
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const PRIMARY = "anthropic/claude-3-haiku";
const FALLBACK = "openai/gpt-4o-mini";
const PUBLIC_URL = "https://images.example/vision.png";
const routerDeps: import("../../../src/lib/guardrails/visionBridgeRouter.ts").VisionBridgeRouterDeps =
  {
    hasUsableCredentials: async (model: string) => model === PRIMARY || model === FALLBACK,
    getActiveSyncedCatalog: async () => ({ authoritative: false, models: [] }),
  };
const config = (
  fetchImpl: typeof fetch,
  overrides: Partial<VisionModelConfig> = {}
): VisionModelConfig => ({
  model: PRIMARY,
  prompt: "Describe",
  timeoutMs: 1000,
  maxImages: 1,
  fetchImpl,
  ...overrides,
});
const payload = (url = PUBLIC_URL) => ({
  model: "auto",
  messages: [{ role: "user", content: [{ type: "image_url" as const, image_url: { url } }] }],
});
const blockMessage = "Vision image could not be fetched safely";

function transportFor(t: TestContext, options: Parameters<typeof installPinnedTransport>[1] = {}) {
  const transport = installPinnedTransport(t.mock, {
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    ...options,
  });
  t.after(transport.restore);
  return transport;
}

for (const routeThroughOmniRoute of [false, true]) {
  for (const scenario of [
    "private",
    "mixed-DNS",
    "proxy",
    "redirect-rebind",
    "timeout",
    "abort",
  ] as const) {
    test(
      `media ${scenario} stops ${routeThroughOmniRoute ? "self-hop" : "provider"} and paid fallback`,
      { timeout: 2000 },
      async (t) => {
        const controller = new AbortController();
        let dnsCalls = 0;
        const transport = transportFor(t, {
          dnsLookup: async () => {
            dnsCalls++;
            if (scenario === "mixed-DNS")
              return [
                { address: "93.184.216.34", family: 4 },
                { address: "127.0.0.1", family: 4 },
              ];
            if (scenario === "redirect-rebind" && dnsCalls > 1)
              return [{ address: "127.0.0.1", family: 4 }];
            return [{ address: "93.184.216.34", family: 4 }];
          },
          reply(socket) {
            if (scenario === "redirect-rebind") {
              socket.respond({ status: 302, headers: { location: PUBLIC_URL + "?next" } });
            } else if (scenario === "timeout" || scenario === "abort") {
              socket.push("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nopen\r\n");
              if (scenario === "abort") queueMicrotask(() => controller.abort());
            } else {
              socket.respond({ body: "unexpected" });
            }
          },
        });
        let providerSends = 0;
        const providerFetch: typeof fetch = async () => {
          providerSends++;
          return Response.json({
            choices: [{ message: { content: "paid fallback description" } }],
          });
        };
        assert.ok(
          (await getFallbackModels(PRIMARY, {}, routerDeps)).includes(FALLBACK),
          "a paid fallback must be available"
        );
        const invoke = () =>
          callVisionModel(
            scenario === "private" ? "http://127.0.0.1/private.png" : PUBLIC_URL,
            config(providerFetch, {
              routeThroughOmniRoute,
              timeoutMs: scenario === "timeout" ? 30 : 1000,
              signal: controller.signal,
            }),
            "synthetic-test-key",
            { maxFallbackAttempts: 3 },
            routerDeps
          );
        await assert.rejects(
          scenario === "proxy"
            ? runWithProxyContext({ type: "http", host: "proxy.invalid", port: 8080 }, invoke, {
                skipUnreachableProbe: true,
              })
            : invoke(),
          (error) => error instanceof RemoteMediaFetchError
        );
        assert.equal(providerSends, 0);
        const expectedDials = ["redirect-rebind", "timeout", "abort"].includes(scenario) ? 1 : 0;
        assert.equal(transport.dials.length, expectedDials);
        assert.equal(
          dnsCalls,
          scenario === "private" || scenario === "proxy"
            ? 0
            : scenario === "redirect-rebind"
              ? 2
              : 1,
          "a denial must not retry DNS or fall back to another model"
        );
        await Promise.all(transport.sockets.map((socket) => socket.closedPromise));
        assert.ok(transport.sockets.every((socket) => socket.destroyed));
      }
    );
  }
}

test("reroute base64 preparation propagates a denied URL rather than retaining it", async (t) => {
  const transport = transportFor(t);
  let sends = 0;
  const fetchImpl: typeof fetch = async () => {
    sends++;
    return Response.json({});
  };
  const body = payload("http://127.0.0.1/private.png");
  await assert.rejects(
    ensureBase64ImagesForClaudeWire(body, PRIMARY, fetchImpl),
    RemoteMediaFetchError
  );
  assert.equal(sends, 0);
  assert.equal(transport.dials.length, 0);
  assert.equal(body.messages[0].content[0].image_url.url, "http://127.0.0.1/private.png");
});

test(
  "reroute base64 preparation passes a caller abort to the active image fetch",
  { timeout: 1500 },
  async (t) => {
    const controller = new AbortController();
    const transport = transportFor(t, {
      reply(socket) {
        socket.push("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n");
        controller.abort();
      },
    });
    const fetchImpl: typeof fetch = async () =>
      assert.fail("provider fetch must not download URLs");
    await assert.rejects(
      ensureBase64ImagesForClaudeWire(payload(), PRIMARY, fetchImpl, controller.signal),
      RemoteMediaFetchError
    );
    await transport.sockets[0].closedPromise;
    assert.equal(transport.dials.length, 1);
  }
);

function guardrail(
  mode: "describe" | "reroute",
  callVision?: (url: string, config: VisionModelConfig) => Promise<string>
) {
  return new VisionBridgeGuardrail({
    deps: {
      getSettings: async () => ({
        modalityBridgeVisionEnabled: true,
        modalityBridgeVisionMode: mode,
        modalityBridgeVisionModel: PRIMARY,
        modalityBridgeCacheEnabled: false,
      }),
      hasUsableCredentials: routerDeps.hasUsableCredentials,
      checkModelHasComboMapping: async () => true,
      callVisionModel: callVision,
    },
  });
}

for (const mode of ["describe", "reroute"] as const) {
  test(`${mode} returns an explicit block for URL failure, never a reroute/stub payload`, async (t) => {
    const transport = transportFor(t);
    let providerSends = 0;
    const providerFetch: typeof fetch = async () => {
      providerSends++;
      return Response.json({});
    };
    const bridge = guardrail(mode, (url, inheritedConfig) =>
      callVisionModel(
        url,
        { ...inheritedConfig, fetchImpl: providerFetch },
        "synthetic-test-key",
        {},
        routerDeps
      )
    );
    const result = await bridge.preCall(payload("http://127.0.0.1/private.png"), { model: "auto" });
    assert.equal(result.block, true);
    assert.equal(result.message, blockMessage);
    assert.equal(result.modifiedPayload, undefined);
    assert.equal(result.meta?.code, "REMOTE_MEDIA_FETCH_FAILED");
    assert.equal(providerSends, 0);
    assert.equal(transport.dials.length, 0);
  });
}

test("a partial describe failure with a media brand blocks instead of replacing only some images", async (t) => {
  const transport = transportFor(t);
  const body = payload("http://127.0.0.1/private.png");
  body.messages[0].content.push({
    type: "image_url",
    image_url: { url: "data:image/png;base64,eA==" },
  });
  const bridge = guardrail("describe", async (url) => {
    if (url.startsWith("data:")) return "Already processed";
    await ensureBase64ImagesForClaudeWire(payload(url), PRIMARY);
    return "must not reach";
  });
  const result = await bridge.preCall(body, { model: "text/combo" });
  assert.equal(result.block, true);
  assert.equal(result.modifiedPayload, undefined);
  assert.equal(transport.dials.length, 0);
});

test("ordinary provider failure retains the existing describe-stub behavior", async (t) => {
  const transport = transportFor(t);
  const bridge = guardrail("describe", async () => {
    throw new Error("ordinary provider failure");
  });
  const result = await bridge.preCall(payload(), { model: "text/combo" });
  assert.equal(result.block, false);
  assert.match(JSON.stringify(result.modifiedPayload), /unavailable/);
  assert.equal(transport.dials.length, 0);
});

test("pre-aborted image bridge blocks before any describe or reroute dispatch", async (t) => {
  const transport = transportFor(t);
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const bridge = guardrail("describe", async () => {
    calls++;
    return "must not run";
  });
  const result = await bridge.preCall(payload(), { model: "auto", signal: controller.signal });
  assert.equal(result.block, true);
  assert.equal(result.modifiedPayload, undefined);
  assert.equal(calls, 0);
  assert.equal(transport.dials.length, 0);
});

test("describe propagates caller abort and blocks even an unbranded cancellation result", async (t) => {
  const transport = transportFor(t);
  const controller = new AbortController();
  const context: GuardrailContext = { model: "auto", signal: controller.signal };
  const bridge = guardrail("describe", async (_url, received) => {
    assert.equal(received.signal, controller.signal);
    controller.abort();
    throw new Error("Vision model call aborted");
  });
  const result = await bridge.preCall(payload(), context);
  assert.equal(result.block, true);
  assert.equal(result.modifiedPayload, undefined);
  assert.equal(transport.dials.length, 0);
});

test("duplicate-module media brands still block, while serialized lookalikes do not", async (t) => {
  const transport = transportFor(t);
  const reloadedModuleUrl = new URL(
    "../../../src/shared/network/mediaFailure.ts?vision-hmr",
    import.meta.url
  ).href;
  const { RemoteMediaFetchError: ReloadedError } = (await import(reloadedModuleUrl)) as {
    RemoteMediaFetchError: typeof RemoteMediaFetchError;
  };
  assert.notEqual(ReloadedError, RemoteMediaFetchError);
  const failure = new ReloadedError(new Error("fixture URL denied"));
  assert.ok(failure instanceof RemoteMediaFetchError);
  const denied = guardrail("describe", async () => {
    throw failure;
  });
  const blocked = await denied.preCall(payload(), { model: "text/combo" });
  assert.equal(blocked.block, true);
  assert.equal(blocked.modifiedPayload, undefined);
  const serialized = JSON.parse(JSON.stringify(failure)) as unknown;
  assert.equal(serialized instanceof RemoteMediaFetchError, false);
  const legacy = guardrail("describe", async () => {
    throw serialized;
  });
  assert.equal((await legacy.preCall(payload(), { model: "text/combo" })).block, false);
  assert.equal(transport.dials.length, 0);
});

test("ordinary provider failure still retries the configured paid fallback", async (t) => {
  const transport = transportFor(t);
  let sends = 0;
  const providerFetch: typeof fetch = async (input) => {
    sends++;
    if (String(input).includes("/messages"))
      return new Response("upstream failed", { status: 503 });
    return Response.json({ choices: [{ message: { content: "normal fallback result" } }] });
  };
  assert.equal(
    await callVisionModel(
      "data:image/png;base64,eA==",
      config(providerFetch),
      "synthetic-test-key",
      {},
      routerDeps
    ),
    "normal fallback result"
  );
  assert.equal(sends, 2);
  assert.equal(transport.dials.length, 0);
});

test(
  "reroute forwards the caller signal and blocks an in-flight media abort",
  { timeout: 1500 },
  async (t) => {
    const controller = new AbortController();
    const transport = transportFor(t, {
      reply(socket) {
        socket.push("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n");
        controller.abort();
      },
    });
    let describeCalls = 0;
    const bridge = guardrail("reroute", async () => {
      describeCalls++;
      return "must not run";
    });
    const result = await bridge.preCall(payload(), { model: "auto", signal: controller.signal });
    assert.equal(result.block, true);
    assert.equal(result.modifiedPayload, undefined);
    assert.equal(describeCalls, 0);
    await transport.sockets[0].closedPromise;
    assert.equal(transport.dials.length, 1);
  }
);
