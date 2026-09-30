import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { registerHooks } from "node:module";
import { Socket } from "node:net";
import dns from "node:dns";

// The canonical reader sees a complete synthetic RO revision. No activation
// files, database, external DNS, native TLS request or socket are used here.
const policyBytes = JSON.stringify({
  schema: 1,
  profile: "omni-app-residential-direct-v1",
  providers: [],
  helpers: [],
});
const markerBytes = JSON.stringify({
  schema: 1,
  profile: "omni-app-residential-direct-v1",
  policySha256: createHash("sha256").update(policyBytes).digest("hex"),
});
const moduleUrl = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
const fsUrl = moduleUrl(`
  import fs from "node:fs";
  const files = new Map([
    ["/run/omni-runtime-policy/required-v1.json", Buffer.from(${JSON.stringify(markerBytes)})],
    ["/run/omni-runtime-policy/policy.json", Buffer.from(${JSON.stringify(policyBytes)})],
  ]);
  const paths = [...files.keys()];
  function stat(path) {
    const file = files.has(path);
    return { uid:0,gid:0,mode:file?0o100444:0o40555,nlink:1,size:file?files.get(path).length:1,
      dev:1,ino:file?paths.indexOf(path)+10:1,mtimeMs:1,ctimeMs:1,
      isFile:()=>file,isDirectory:()=>!file,isSymbolicLink:()=>false };
  }
  export default { ...fs,lstatSync:stat,openSync:(path)=>paths.indexOf(path),
    fstatSync:(fd)=>stat(paths[fd]),readFileSync:(fd)=>files.get(paths[fd]),closeSync:()=>{} };
`);
const settingsUrl = moduleUrl(`
  export let selected = {level:"direct",proxy:null};
  export let legacy = {global:null,providers:{}};
  export let failure;
  export const calls = [];
  export function reset(value={level:"direct",proxy:null}, config={global:null,providers:{}}, error) {
    selected=value;legacy=config;failure=error;calls.length=0;
  }
  export async function resolveProxyForConnection(...args) {
    calls.push(args);if(failure)throw failure;return selected;
  }
  export async function getProxyConfig() {if(failure)throw failure;return legacy;}
`);
const flagsUrl = moduleUrl(`
  export let auto=false;
  export function setAuto(value){auto=value;}
  export const isControlPlaneProxyDirectFallbackEnabled=()=>true;
  export const isFeatureFlagEnabled=(key)=>key==="PROXY_AUTO_SELECT_ENABLED"&&auto;
`);
const healthUrl = moduleUrl(`
  export let probes=0;
  export async function isProxyReachable(){probes++;throw new Error("unexpected probe");}
`);
const registryUrl = moduleUrl(`
  export let reads=0;
  export async function resolveProxyForScopeFromRegistry(){reads++;throw new Error("unexpected read");}
  export async function listProxies(){reads++;throw new Error("unexpected read");}
  export async function listOneproxyProxies(){reads++;throw new Error("unexpected read");}
`);
const undiciUrl = moduleUrl(`
  export {Agent,buildConnector} from ${JSON.stringify(import.meta.resolve("undici"))};
  export const calls=[];
  export async function fetch(input,init){calls.push({input,init});return new Response("pinned");}
`);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "node:fs" && context.parentURL?.includes("runtime-policy.mjs")) {
      return { url: fsUrl, shortCircuit: true };
    }
    if (specifier === "@/lib/db/settings") return { url: settingsUrl, shortCircuit: true };
    if (specifier === "@/shared/utils/featureFlags") return { url: flagsUrl, shortCircuit: true };
    if (specifier === "@/lib/proxyHealth") return { url: healthUrl, shortCircuit: true };
    if (["@/lib/db/proxies", "@/lib/db/oneproxy"].includes(specifier)) {
      return { url: registryUrl, shortCircuit: true };
    }
    if (specifier === "undici" && context.parentURL?.includes("dnsPinnedFetch")) {
      return { url: undiciUrl, shortCircuit: true };
    }
    const resolved = nextResolve(specifier, context);
    assert.ok(!resolved.url.includes("/src/lib/db/"), "real database modules must not load");
    return resolved;
  },
});
let socketAttempts = 0;
let dnsAttempts = 0;
let nativeSends = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  nativeSends++;
  return new Response("native-direct");
};
test.mock.method(Socket.prototype, "connect", () => {
  socketAttempts++;
  throw new Error("Unexpected socket");
});
test.mock.method(dns, "lookup", () => {
  dnsAttempts++;
  throw new Error("Unexpected DNS");
});
test.mock.method(dns.promises, "lookup", async () => {
  dnsAttempts++;
  throw new Error("Unexpected DNS");
});
const policy = await import("../../../src/shared/runtimePolicy.ts");
const proxy = await import("../../../open-sse/utils/proxyFetch.ts");
const dispatchers = await import("../../../open-sse/utils/proxyDispatcher.ts");
const cache = await import("../../../open-sse/utils/proxyDispatcherCache.ts");
const fallback = await import("../../../open-sse/utils/proxyFallback.ts");
const legacy = await import("../../../open-sse/utils/networkProxy.ts");
const healthPrimitive = await import("../../../src/lib/proxyHealth.ts");
const { TlsClient, createWreqTransportClient } =
  await import("../../../open-sse/utils/tlsClient.ts");
const { resolveTlsClientProxyUrl } = await import("../../../open-sse/services/tlsClientProxy.ts");
const { assertPinnedTransportAllowed } =
  await import("../../../src/shared/network/pinnedTransportPolicy.ts");
const { createPinnedFetch } = await import("../../../src/shared/network/dnsPinnedFetch.ts");
const { safeOutboundFetch } = await import("../../../src/shared/network/safeOutboundFetch.ts");
const settings = (await import(settingsUrl)) as {
  reset: (value?: unknown, config?: unknown, error?: unknown) => void;
  calls: unknown[][];
};
const flags = (await import(flagsUrl)) as { setAuto: (value: boolean) => void };
const health = (await import(healthUrl)) as { probes: number };
const registry = (await import(registryUrl)) as { reads: number };
const pinned = (await import(undiciUrl)) as { calls: Array<{ input: unknown; init: RequestInit }> };
const ENV_KEYS = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
  "ENABLE_TLS_FINGERPRINT",
  "TLS_FINGERPRINT_PROVIDERS",
  "PROXY_FAIL_OPEN",
];
const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
const target = "https://fixture-provider.example.invalid/v1/request";
const proxyConfig = { type: "http", host: "fixture-proxy.example.invalid", port: 8080 };
const denied = (error: unknown) =>
  policy.isRuntimePolicyError(error) && error.reason === "proxy-forbidden";

test.beforeEach(() => {
  ENV_KEYS.forEach((key) => delete process.env[key]);
  settings.reset();
  flags.setAuto(false);
  legacy.invalidateProxyCache();
  nativeSends = 0;
  pinned.calls.length = 0;
});
test.afterEach(() => {
  assert.equal(socketAttempts, 0);
  assert.equal(dnsAttempts, 0);
  assert.equal(health.probes, 0, "no health probe may start");
  assert.equal(registry.reads, 0, "no fallback inventory may load");
});
test.after(() => {
  dispatchers.clearDispatcherCache();
  proxy.setTlsClientForTest(null);
  fallback.__setProxyFallbackTestHooks(null);
  hooks.deregister();
  test.mock.restoreAll();
  globalThis.fetch = originalFetch;
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("synthetic locked policy rejects context/relay/opaque selection before callbacks or probes", async () => {
  assert.equal(policy.getRuntimePolicy().mode, "locked");
  for (const selected of [
    proxyConfig,
    "http://fixture.invalid:8080",
    false,
    0,
    [],
    {},
    { type: "cloudflare", host: "fixture.invalid", relayAuth: "fixture" },
  ]) {
    let sends = 0;
    await assert.rejects(
      proxy.runWithProxyContext(
        selected,
        () => {
          sends++;
        },
        {
          directFallbackOnUnreachable: true,
        }
      ),
      denied
    );
    assert.equal(sends, 0);
  }
});

test("env effective selections cannot send, retry or select a fallback (including invalid URL)", async () => {
  for (const selected of ["http://fixture.invalid:8080", "not-a-proxy-url"]) {
    process.env.HTTPS_PROXY = selected;
    let sends = 0;
    await assert.rejects(
      proxy.proxyFetch(
        target,
        {},
        {
          undiciFetch: async () => {
            sends++;
            return new Response();
          },
          nativeFetch: async () => {
            sends++;
            return new Response();
          },
          findWorkingProxy: async () => {
            sends++;
            return null;
          },
        }
      ),
      denied
    );
    assert.equal(sends, 0);
  }
});

test("cached and opaque dispatchers cannot be laundered by class names or direct flags", async () => {
  const fake = {
    dispatch() {},
    close: async () => {},
    direct: true,
    constructor: { name: "Agent" },
  };
  cache.__cacheProxyDispatcherForTest("http://fixture.invalid:8080", fake as never);
  assert.throws(() => dispatchers.createProxyDispatcher("http://fixture.invalid:8080"), denied);
  assert.throws(() => dispatchers.getProxyRetryDispatcher("http://fixture.invalid:8080"), denied);
  cache.setDefaultCachedDispatcher(fake as never);
  assert.throws(() => dispatchers.getDefaultDispatcher(), denied);
  dispatchers.clearDispatcherCache();
  let sends = 0;
  await assert.rejects(
    proxy.proxyFetch(target, { dispatcher: fake } as RequestInit, {
      undiciFetch: async () => {
        sends++;
        return new Response();
      },
    }),
    denied
  );
  assert.equal(sends, 0);
});

test("reviewed direct factories and the native factory remain usable", async () => {
  for (const dispatcher of [dispatchers.getDefaultDispatcher(), dispatchers.getRetryDispatcher()]) {
    assert.equal(dispatchers.isKnownDirectDispatcher(dispatcher), true);
    let sends = 0;
    const response = await proxy.proxyFetch(target, { dispatcher } as RequestInit, {
      undiciFetch: async () => {
        sends++;
        return new Response("direct");
      },
    });
    assert.equal(await response.text(), "direct");
    assert.equal(sends, 1);
  }
  assert.equal(await (await proxy.getOriginalFetch()(target)).text(), "native-direct");
  assert.equal(nativeSends, 1);
});

test("duplicate module copies accept only direct factory identity, never a class lookalike", async () => {
  const duplicateUrl = new URL(
    "../../../open-sse/utils/proxyDispatcher.ts?runtime-policy-duplicate",
    import.meta.url
  );
  const duplicated = (await import(duplicateUrl.href)) as typeof dispatchers;
  const dispatcher = dispatchers.getDefaultDispatcher();
  assert.equal(duplicated.isKnownDirectDispatcher(dispatcher), true);
  assert.equal(duplicated.isKnownDirectDispatcher({ constructor: dispatcher.constructor }), false);
});

test("native factory and explicit direct context cannot erase an env proxy", async () => {
  process.env.HTTPS_PROXY = "http://fixture.invalid:8080";
  assert.throws(() => proxy.runWithDirectFetchContext(() => {}), denied);
  await assert.rejects(proxy.getOriginalFetch()(target), denied);
  assert.equal(nativeSends, 0);
});

test("TLS per-call/resolved selections and native pool deny before session/runtime creation", async () => {
  assert.throws(
    () => resolveTlsClientProxyUrl(target, "http://fixture.invalid:8080", () => null),
    denied
  );
  assert.throws(
    () =>
      resolveTlsClientProxyUrl(target, undefined, () => ({
        source: "db",
        proxyUrl: "http://fixture.invalid:8080",
      })),
    denied
  );
  const error = new policy.RuntimePolicyError("proxy-forbidden");
  assert.throws(
    () =>
      resolveTlsClientProxyUrl(target, undefined, () => {
        throw error;
      }),
    (e) => e === error
  );
  let creates = 0;
  const client = new TlsClient(async () => {
    creates++;
    throw new Error("unexpected session");
  });
  await assert.rejects(client.fetch(target, { proxy: "http://fixture.invalid:8080" }), denied);
  let loads = 0;
  const native = createWreqTransportClient({
    browser: "fixture",
    os: "linux",
    runtimeLoader: async () => {
      loads++;
      throw new Error("unexpected native load");
    },
  });
  await assert.rejects(native.request(target, { proxyUrl: "http://fixture.invalid:8080" }), denied);
  assert.equal(creates, 0);
  assert.equal(loads, 0);
});

test("direct native TLS pool remains usable with account-independent ephemeral cookies", async () => {
  let creates = 0,
    sends = 0;
  const native = createWreqTransportClient({
    browser: "fixture",
    os: "linux",
    runtimeLoader: async () => ({
      createTransport: async (options) => {
        creates++;
        assert.deepEqual(options, { browser: "fixture", os: "linux" });
        return { close() {} };
      },
      fetch: async (_url, options) => {
        sends++;
        assert.equal(options.cookieMode, "ephemeral");
        return new Response("tls-direct");
      },
    }),
  });
  const request = native.request(target, { method: "GET" });
  const response = await request;
  request.releaseTransport();
  assert.equal(response.status, 200);
  assert.equal(creates, 1);
  assert.equal(sends, 1);
});

test("local policy failures keep identity and do not change TLS circuit health", async () => {
  const error = new policy.RuntimePolicyError("proxy-forbidden");
  const client = new TlsClient(async () => ({
    fetch: async () => {
      throw error;
    },
    close() {},
  }));
  await assert.rejects(client.fetch(target, { proxy: null }), (e) => e === error);
  assert.equal(client.getCircuitState(null).failureCount, 0);
  await client.closeAll();
});

test("policy failure from dispatcher/TLS never reaches retry/native/auto fallback", async () => {
  const error = new policy.RuntimePolicyError("proxy-forbidden");
  let sends = 0,
    fallbacks = 0;
  await assert.rejects(
    proxy.proxyFetch(
      target,
      {},
      {
        undiciFetch: async () => {
          sends++;
          throw error;
        },
        nativeFetch: async () => {
          fallbacks++;
          return new Response();
        },
        findWorkingProxy: async () => {
          fallbacks++;
          return null;
        },
      }
    ),
    (e) => e === error
  );
  assert.equal(sends, 1);
  assert.equal(fallbacks, 0);
  process.env.ENABLE_TLS_FINGERPRINT = "true";
  proxy.setTlsClientForTest({
    available: true,
    fetch: async () => {
      throw error;
    },
  });
  await assert.rejects(
    proxy.proxyFetch(
      target,
      {},
      {
        undiciFetch: async () => {
          fallbacks++;
          return new Response();
        },
      }
    ),
    (e) => e === error
  );
  assert.equal(fallbacks, 0);
  proxy.setTlsClientForTest(null);
});

test("smart fallback roots reject before cached candidates, probes or negative cache", async () => {
  let probes = 0;
  fallback.__setProxyFallbackTestHooks({
    getProxyCandidates: async () => {
      probes++;
      return ["http://fixture.invalid:8080"];
    },
  });
  await assert.rejects(fallback.findWorkingProxy("fixture.invalid", target), denied);
  await assert.rejects(fallback.getProxyCandidates(target), denied);
  await assert.rejects(fallback.testSingleProxy("http://fixture.invalid:8080", target), denied);
  await assert.rejects(
    fallback.testProxiesAgainstTarget(target, ["http://fixture.invalid:8080"]),
    denied
  );
  flags.setAuto(true);
  await assert.rejects(fallback.selectWorkingProxyFallback(), denied);
  assert.equal(probes, 0);
});

test("proxy TCP health primitive denies before probe or cache, while passive cleanup stays usable", async () => {
  let probes = 0;
  healthPrimitive.__setProxyHealthTcpCheckForTesting(async () => {
    probes++;
    return true;
  });
  try {
    for (const url of ["http://fixture.invalid:8080", "invalid-proxy"]) {
      await assert.rejects(healthPrimitive.isProxyReachable(url), denied);
      assert.equal(healthPrimitive.getCachedProxyHealth(url), null);
      healthPrimitive.invalidateProxyHealth(url);
    }
    assert.equal(await healthPrimitive.isProxyReachable(""), false);
    healthPrimitive.invalidateProxyHealth("");
    assert.deepEqual(healthPrimitive.getAllProxyHealthStatuses(), []);
    assert.equal(probes, 0);
  } finally {
    healthPrimitive.__setProxyHealthTcpCheckForTesting(null);
  }
});

test("legacy DB wins over env, cached/imported values deny, and unreadable DB is opaque", async () => {
  process.env.HTTPS_PROXY = "http://env.invalid:8080";
  settings.reset(undefined, { global: "http://db.invalid:8080", providers: {} });
  await assert.rejects(legacy.resolveProxy("fixture"), denied);
  settings.reset();
  delete process.env.HTTPS_PROXY;
  await assert.rejects(legacy.resolveProxy("fixture"), denied); // cached DB selection
  legacy.invalidateProxyCache();
  settings.reset(undefined, undefined, new Error("fixture DB unavailable"));
  await assert.rejects(legacy.resolveProxy("fixture"), denied);
});

test("pinned direct factory admits reviewed pin and keeps manual redirect behavior", async () => {
  const response = await createPinnedFetch("203.0.113.42", 4)(target, { redirect: "follow" });
  assert.equal(await response.text(), "pinned");
  assert.equal(pinned.calls.length, 1);
  assert.equal(pinned.calls[0].init.redirect, "manual");
  assert.ok(settings.calls.length > 0);
});

test("pinned and bypass adapters deny imported DB/env/config before any send", async () => {
  settings.reset({ level: "global", proxy: proxyConfig });
  await assert.rejects(createPinnedFetch("203.0.113.42", 4)(target), denied);
  await assert.rejects(assertPinnedTransportAllowed(target), denied);
  assert.equal(pinned.calls.length, 0);
  await assert.rejects(proxy.getOriginalFetch()(target), denied);
  await assert.rejects(
    safeOutboundFetch(target, { bypassProxyPatch: true, retry: { attempts: 3 } }),
    denied
  );
  assert.equal(nativeSends, 0);
  settings.reset();
  await assert.rejects(
    safeOutboundFetch(target, { bypassProxyPatch: true, proxyConfig, retry: { attempts: 3 } }),
    denied
  );
  process.env.HTTPS_PROXY = "http://fixture.invalid:8080";
  await assert.rejects(
    safeOutboundFetch(target, { bypassProxyPatch: true, retry: { attempts: 3 } }),
    denied
  );
  assert.equal(nativeSends, 0);
});

test("pinned safe outbound rejects opaque dispatcher before its first DNS lookup", async () => {
  let lookups = 0;
  await assert.rejects(
    safeOutboundFetch(target, {
      pinDns: true,
      guard: "public-only",
      dispatcher: { dispatch() {} },
      lookup: async () => {
        lookups++;
        return [{ address: "203.0.113.42", family: 4 }];
      },
    } as Parameters<typeof safeOutboundFetch>[1]),
    denied
  );
  assert.equal(lookups, 0);
  assert.equal(pinned.calls.length, 0);
});

test("public code/name/message lookalikes do not acquire local provenance", () => {
  assert.equal(
    policy.isRuntimePolicyError({
      name: "RuntimePolicyError",
      code: "OMNI_RUNTIME_POLICY_DENIED",
      reason: "proxy-forbidden",
    }),
    false
  );
  assert.equal(
    proxy.isVerifiedProxyFetchExhaustedError(new policy.RuntimePolicyError("proxy-forbidden")),
    false
  );
});
