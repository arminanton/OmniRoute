import test from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns";
import { registerHooks } from "node:module";
import { Socket } from "node:net";
import type { PinnedTransportPolicyDependencies } from "../../src/shared/network/pinnedTransportPolicy.ts";

// Keep the real AsyncLocalStorage/context and environment resolver. Replace only
// its DB-backed feature flags and this gate's stored-policy boundary. No SQLite,
// temp database, proxy health probe, DNS query, or live socket is allowed here.
const settingsModuleUrl = `data:text/javascript,${encodeURIComponent(`
  let outcome = { level: "direct", proxy: null };
  let failure;
  export const calls = [];
  export function reset(value = { level: "direct", proxy: null }, error) {
    outcome = value;
    failure = error;
    calls.length = 0;
  }
  export async function resolveProxyForConnection(...args) {
    calls.push(args);
    if (failure !== undefined) throw failure;
    return outcome;
  }
`)}`;
const flagsModuleUrl = `data:text/javascript,${encodeURIComponent(`
  export const isControlPlaneProxyDirectFallbackEnabled = () => false;
  export const isFeatureFlagEnabled = () => false;
`)}`;
let settingsImports = 0;
let proxyImports = 0;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/db/settings") {
      settingsImports++;
      return { url: settingsModuleUrl, shortCircuit: true };
    }
    if (specifier === "@/shared/utils/featureFlags") {
      return { url: flagsModuleUrl, shortCircuit: true };
    }
    if (specifier.includes("proxyFetch")) proxyImports++;
    const resolved = nextResolve(specifier, context);
    assert.ok(!resolved.url.includes("/src/lib/db/"), "real DB modules must not load");
    return resolved;
  },
});

let socketAttempts = 0;
let dnsAttempts = 0;
let transportStarts = 0;
test.mock.method(Socket.prototype, "connect", () => {
  socketAttempts++;
  throw new Error("Unexpected socket or reachability probe");
});
test.mock.method(dns, "lookup", () => {
  dnsAttempts++;
  throw new Error("Unexpected DNS lookup");
});
test.mock.method(dns.promises, "lookup", async () => {
  dnsAttempts++;
  throw new Error("Unexpected DNS lookup");
});

const originalFetch = globalThis.fetch;
const { assertPinnedTransportAllowed } =
  await import("../../src/shared/network/pinnedTransportPolicy.ts");
const eagerImports = { settings: settingsImports, proxy: proxyImports };
const {
  hasAmbientProxyContext,
  resolveProxyForRequest,
  runWithDirectFetchContext,
  runWithProxyContext,
} = await import("../../open-sse/utils/proxyFetch.ts");
const settings = (await import(settingsModuleUrl)) as {
  calls: unknown[][];
  reset: (value?: unknown, error?: unknown) => void;
};

const ENV_NAMES = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
  "PROXY_FAIL_OPEN",
  "OMNIROUTE_PROXY_FETCH_DEBUG",
];
const originalEnv = new Map(ENV_NAMES.map((key) => [key, process.env[key]]));
const proxy = { type: "http", host: "127.0.0.2", port: 18888 };
const target = "https://provider.example/media";
const denied = { code: "PINNED_PROXY_UNSUPPORTED" };

test.beforeEach(() => {
  for (const key of ENV_NAMES) delete process.env[key];
  settings.reset();
  transportStarts = 0;
});
test.afterEach(() => {
  assert.equal(socketAttempts, 0, "no direct/proxy socket or probe may dial");
  assert.equal(dnsAttempts, 0, "policy must not resolve DNS");
});
test.after(() => {
  hooks.deregister();
  test.mock.restoreAll();
  globalThis.fetch = originalFetch;
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function admitThenStart(
  url: string | URL = target,
  explicitProxyConfig?: unknown,
  dependencies?: Partial<PinnedTransportPolicyDependencies>
) {
  await assertPinnedTransportAllowed(url, explicitProxyConfig, dependencies);
  transportStarts++;
}

async function expectDenied(
  url: string | URL = target,
  explicitProxyConfig?: unknown,
  dependencies?: Partial<PinnedTransportPolicyDependencies>
) {
  const startsBefore = transportStarts;
  await assert.rejects(admitThenStart(url, explicitProxyConfig, dependencies), denied);
  assert.equal(transportStarts, startsBefore, "denial must precede transport creation");
}

test("helper import does not load/read proxy or stored policy", () => {
  assert.deepEqual(eagerImports, { settings: 0, proxy: 0 });
  assert.equal(settingsImports, 0);
  assert.deepEqual(settings.calls, []);
});

test("unconfigured direct allows string and URL inputs and reads fresh policy every call", async () => {
  for (const url of [target, new URL(target)]) await admitThenStart(url);
  assert.equal(transportStarts, 2);
  assert.equal(settings.calls.length, 2);
  for (const args of settings.calls) {
    assert.deepEqual(args, [
      "__pinned_transport_policy__",
      undefined,
      "__pinned_transport_policy__",
      { fresh: true, skipFallback: true },
    ]);
  }
  settings.reset({ level: "global", proxy });
  await expectDenied();
  assert.equal(settings.calls.length, 1, "must not cache a prior direct decision");
});

test("request resolution runs first and propagates strict egress failure unchanged", async () => {
  const calls: string[] = [];
  const strictError = Object.assign(new Error("A required proxy route is unavailable"), {
    code: "PROXY_REQUIRED_EGRESS",
  });
  await assert.rejects(
    admitThenStart(target, proxy, {
      resolveProxyForRequest: () => {
        calls.push("request");
        throw strictError;
      },
      hasAmbientProxyContext: () => {
        calls.push("ambient");
        return true;
      },
      resolveProxyForConnection: async () => {
        calls.push("stored");
        return { level: "direct", proxy: null };
      },
    }),
    (error) => error === strictError
  );
  assert.deepEqual(calls, ["request"]);
  assert.equal(transportStarts, 0);
});

for (const url of [
  target,
  "http://127.0.0.1:20128/token",
  "http://192.168.10.1/token",
  "http://[::1]:20128/token",
  "http://service.internal/token",
]) {
  test(`inherited requireProxy denies NO_PROXY/local target without a dial: ${url}`, async () => {
    process.env.NO_PROXY = "provider.example";
    await runWithProxyContext(
      proxy,
      () =>
        runWithProxyContext(
          null,
          async () => {
            await assert.rejects(admitThenStart(url, null), { code: "PROXY_REQUIRED_EGRESS" });
            assert.equal(hasAmbientProxyContext(), true);
            assert.throws(() => resolveProxyForRequest(url), { code: "PROXY_REQUIRED_EGRESS" });
          },
          { requireProxy: false, skipUnreachableProbe: true }
        ),
      { requireProxy: true, skipUnreachableProbe: true }
    );
    assert.equal(transportStarts, 0);
    assert.deepEqual(settings.calls, []);
  });
}

for (const [label, url, noProxy] of [
  ["public", target, ""],
  ["NO_PROXY", target, "*"],
  ["local", "http://127.0.0.1/media", ""],
]) {
  test(`configured ambient route cannot bypass through ${label}`, async () => {
    process.env.NO_PROXY = noProxy;
    await runWithProxyContext(
      proxy,
      async () => {
        await expectDenied(url, null);
        assert.equal(hasAmbientProxyContext(), true, "gate must not replace the context");
      },
      { skipUnreachableProbe: true }
    );
    assert.deepEqual(settings.calls, []);
  });
}

test("even a malformed ambient config blocks a pinned direct transport", async () => {
  await runWithProxyContext({}, () => expectDenied(), { skipUnreachableProbe: true });
  assert.deepEqual(settings.calls, []);
});

test("explicit proxy/relay and malformed configs deny even under NO_PROXY", async () => {
  process.env.NO_PROXY = "*";
  for (const config of [
    proxy,
    { type: "cloudflare", host: "relay.example" },
    "http://fixture-user:fixture-password@proxy.example:8080",
    {},
    [],
    false,
    0,
    "",
  ]) {
    await expectDenied(target, config);
  }
  assert.deepEqual(settings.calls, []);
});

for (const [key, url] of [
  ["HTTPS_PROXY", target],
  ["https_proxy", target],
  ["HTTP_PROXY", "http://provider.example/media"],
  ["http_proxy", "http://provider.example/media"],
  ["ALL_PROXY", target],
  ["all_proxy", target],
]) {
  test(`effective ${key} proxy denies without fallback`, async () => {
    process.env[key] = "http://fixture-user:fixture-password@proxy.example:8080";
    process.env.PROXY_FAIL_OPEN = "true";
    await expectDenied(url);
    assert.deepEqual(settings.calls, []);
  });
}

test("environment policy is read on each invocation, not at helper import", async () => {
  await admitThenStart();
  process.env.HTTPS_PROXY = "http://proxy.example:8080";
  await expectDenied();
  assert.equal(transportStarts, 1);
});

for (const key of ENV_NAMES.slice(0, 6)) {
  test(`configured ${key} still denies NO_PROXY/local/direct-sentinel requests`, async () => {
    process.env[key] = "http://proxy.example:8080";
    process.env.NO_PROXY = "provider.example";
    for (const url of [target, "http://127.0.0.1/media", "http://[::1]/media"]) {
      assert.deepEqual(resolveProxyForRequest(url), { source: "direct", proxyUrl: null });
      await expectDenied(url, null);
      await runWithDirectFetchContext(() => expectDenied(url, null));
    }
    assert.deepEqual(settings.calls, []);
  });
}

test("an env proxy for the other protocol still denies the pinned-only feature", async () => {
  process.env.HTTP_PROXY = "http://proxy.example:8080";
  assert.deepEqual(resolveProxyForRequest(target), { source: "direct", proxyUrl: null });
  await expectDenied(target);
  assert.deepEqual(settings.calls, []);
});

test("NO_PROXY/local cannot bypass a stored proxy even without configured proxy env", async () => {
  process.env.NO_PROXY = "*";
  settings.reset({ level: "global", proxy });
  for (const url of [target, "http://127.0.0.1/media"]) await expectDenied(url, null);
});

test("a non-strict direct sentinel allows only when env and stored policy are direct", async () => {
  await runWithProxyContext(
    proxy,
    () =>
      runWithDirectFetchContext(async () => {
        assert.equal(hasAmbientProxyContext(), false);
        await admitThenStart(target, null);
        process.env.HTTPS_PROXY = "http://proxy.example:8080";
        await expectDenied(target, null);
        delete process.env.HTTPS_PROXY;
        settings.reset({ level: "global", proxy });
        await expectDenied(target, null);
        assert.deepEqual(resolveProxyForRequest(target), { source: "direct", proxyUrl: null });
      }),
    { skipUnreachableProbe: true }
  );
  assert.equal(transportStarts, 1);
});

test("empty proxy env vars are unconfigured but whitespace remains conservatively blocked", async () => {
  for (const key of ENV_NAMES.slice(0, 6)) process.env[key] = "";
  await admitThenStart(target);
  process.env.NO_PROXY = "*";
  process.env.HTTPS_PROXY = " ";
  await expectDenied(target);
});

test("configured-environment dependency denies both configured and unreadable policy", async () => {
  await expectDenied(target, undefined, { hasConfiguredEnvironmentProxy: () => true });
  await expectDenied(target, undefined, {
    hasConfiguredEnvironmentProxy: () => {
      throw new Error("fixture environment policy failure");
    },
  });
  assert.deepEqual(settings.calls, []);
});

test("stored registry/legacy/relay routes deny without normalizing away partial configs", async () => {
  for (const route of [
    { level: "global", proxy, source: "registry" },
    { level: "global", proxy: "http://proxy.example:8080" },
    { level: "global", proxy: { type: "vercel", host: "relay.example" } },
    { level: "global", proxy: {} },
    { level: "global", proxy: null },
    { level: "direct", proxy },
    { level: "direct", proxy: undefined },
    { level: "direct", proxy: false },
    { level: "unknown", proxy: null },
  ]) {
    settings.reset(route);
    await expectDenied();
    assert.equal(settings.calls.length, 1);
  }
});

test("absent stored resolution and database errors fail closed without disclosing details", async () => {
  for (const failure of [new Error("fixture DB password must remain private"), "fixture failure"]) {
    settings.reset(undefined, failure);
    await assert.rejects(admitThenStart(), (error) => {
      assert.ok(error instanceof Error);
      assert.equal(Reflect.get(error, "code"), denied.code);
      assert.equal(error.message, "Pinned direct transport is blocked by proxy policy");
      assert.equal(error.cause, undefined);
      return true;
    });
  }
  for (const result of [null, undefined]) {
    await expectDenied(target, undefined, { resolveProxyForConnection: async () => result });
  }
  assert.equal(transportStarts, 0);
});

test("request/ambient resolution errors and non-direct shapes fail closed", async () => {
  for (const result of [
    null,
    undefined,
    { source: "env", proxyUrl: null },
    { source: "context", proxyUrl: null },
    { source: "direct", proxyUrl: undefined },
    { source: "direct", proxyUrl: "http://proxy.example:8080" },
  ]) {
    await expectDenied(target, undefined, { resolveProxyForRequest: () => result });
  }
  for (const dependencies of [
    {
      resolveProxyForRequest: () => {
        throw new Error("fixture sensitive request policy detail");
      },
    },
    {
      hasAmbientProxyContext: () => {
        throw new Error("fixture sensitive ambient policy detail");
      },
    },
  ]) {
    await assert.rejects(admitThenStart(target, undefined, dependencies), {
      ...denied,
      message: "Pinned direct transport is blocked by proxy policy",
    });
  }
  assert.equal(transportStarts, 0);
  assert.deepEqual(settings.calls, []);
});
