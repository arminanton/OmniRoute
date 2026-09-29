import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-nous-proxy-isolation-"));
process.env.DATA_DIR = dataDir;
const coreDb = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const proxiesDb = await import("../../src/lib/db/proxies.ts");
const proxyDb = await import("../../src/lib/db/upstreamProxy.ts");
const { resolveExecutorWithProxy } =
  await import("../../open-sse/handlers/chatCore/executorProxy.ts");
const { clearUpstreamProxyConfigCache } =
  await import("../../open-sse/handlers/chatCore/comboContextCache.ts");
const { getExecutor } = await import("../../open-sse/executors/index.ts");
const { NOUS_OAUTH_INFERENCE_PSD_KEY } = await import("../../open-sse/config/nousOAuth.ts");
const originalFetch = globalThis.fetch;
const { executeChatWithBreaker, safeResolveProxy } =
  await import("../../src/sse/handlers/chatHelpers.ts");
const { runWithProxyContext, resolveProxyForRequest } =
  await import("../../open-sse/utils/proxyFetch.ts");
const { invalidateProxyHealth, __setProxyHealthTcpCheckForTesting } =
  await import("../../src/lib/proxyHealth.ts");

test.after(() => {
  globalThis.fetch = originalFetch;
  coreDb.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// Both explicit provider modes and per-connection deep modes used to substitute
// a configurable proxy executor and forward the user's OAuth bearer to it.
test("Nous OAuth/nso never substitute CLIProxyAPI or Dario, including fallback 503", async () => {
  const base = "https://inference-api.nousresearch.com/v1";
  const seen: Array<{ url: string; auth: string | null }> = [];
  globalThis.fetch = async (url, init) => {
    seen.push({
      url: String(url),
      auth: new Headers(init?.headers).get("authorization"),
    });
    // 503 would otherwise trigger the provider-level fallback backend.
    return Response.json({ error: { message: "unavailable" } }, { status: 503 });
  };

  for (const provider of ["nous-oauth", "nso"]) {
    for (const { mode, fallbackBackend } of [
      { mode: "native", fallbackBackend: "cliproxyapi" },
      { mode: "cliproxyapi", fallbackBackend: "cliproxyapi" },
      { mode: "dario", fallbackBackend: "dario" },
      { mode: "fallback", fallbackBackend: "cliproxyapi" },
      { mode: "fallback", fallbackBackend: "dario" },
    ] as const) {
      await proxyDb.upsertUpstreamProxyConfig({
        providerId: provider,
        enabled: true,
        mode,
        fallbackBackend,
      });
      clearUpstreamProxyConfigCache(provider);
      for (const deepMode of [null, "cliproxyapi", "dario", "both"]) {
        const psd: Record<string, unknown> = { [NOUS_OAUTH_INFERENCE_PSD_KEY]: base };
        if (deepMode === "cliproxyapi" || deepMode === "both") {
          psd.cliproxyapiMode = "claude-native";
        }
        if (deepMode === "dario" || deepMode === "both") {
          psd.darioMode = "claude-native";
        }
        const executor = await resolveExecutorWithProxy(provider, null, psd);
        assert.equal(executor, await getExecutor(provider));
        const before = seen.length;
        const result = await executor.execute({
          model: "Hermes-4-70B",
          stream: false,
          body: { model: "Hermes-4-70B", messages: [{ role: "user", content: "hi" }] },
          credentials: { accessToken: "oauth-sentinel-never-to-proxy", providerSpecificData: psd },
        });
        assert.ok(!(result instanceof Response));
        assert.equal(result.response.status, 503);
        assert.equal(seen.length, before + 1, "no retry or proxy backend fetch after 503");
        assert.deepEqual(seen[before], {
          url: `${base}/chat/completions`,
          auth: "Bearer oauth-sentinel-never-to-proxy",
        });
      }
    }
  }
  assert.equal(seen.length, 40);
});

test("opt-in skips orphaning health-probe race without bypassing assigned proxy", async () => {
  const proxyUrl = "http://127.0.0.1:19991";
  const targetUrl = "https://inference-api.nousresearch.com/v1/chat/completions";
  invalidateProxyHealth(proxyUrl);
  let probes = 0;
  __setProxyHealthTcpCheckForTesting(async () => {
    probes++;
    return false;
  });
  let finish!: (result: string) => void;
  try {
    const pending = runWithProxyContext(
      proxyUrl,
      async () => {
        const selected = resolveProxyForRequest(targetUrl);
        assert.equal(selected.source, "context");
        assert.equal(selected.proxyUrl, proxyUrl);
        return new Promise<string>((resolve) => {
          finish = resolve;
        });
      },
      { skipUnreachableProbe: true }
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(probes, 0, "no background probe can reject an in-flight OAuth POST");
    finish("response observed");
    assert.equal(await pending, "response observed");
  } finally {
    __setProxyHealthTcpCheckForTesting(null);
    invalidateProxyHealth(proxyUrl);
  }
});

test("assigned Vercel/Deno/Cloudflare relays and inherited relay context never see OAuth bearer", async () => {
  const { getExecutor } = await import("../../open-sse/executors/index.ts");
  const credentials = {
    connectionId: "relay-guard-fixture",
    accessToken: "oauth-relay-sentinel-secret",
    providerSpecificData: {
      [NOUS_OAUTH_INFERENCE_PSD_KEY]: "https://inference-api.nousresearch.com/v1",
    },
  };
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches++;
    throw new Error("No relay or direct inference fetch is allowed");
  };
  const logs: string[] = [];
  const logger = Object.fromEntries(
    ["info", "warn", "error", "debug"].map((name) => [
      name,
      (...args: unknown[]) => logs.push(`${name}:${args.join(" ")}`),
    ])
  );
  for (const type of ["vercel", "deno", "cloudflare"] as const) {
    const proxy = { type, host: "untrusted-relay.example", relayAuth: "relay-key" };
    const result = await runWithProxyContext(proxy, () =>
      getExecutor("nous-oauth").then((executor) =>
        executor.execute({
          model: "Hermes-4-70B",
          stream: false,
          body: { messages: [{ role: "user", content: "hi" }] },
          credentials,
          log: logger,
        })
      )
    );
    assert.ok(!(result instanceof Response));
    assert.equal(result.response.status, 503, `ambient ${type} relay must fail closed`);

    // The handler sees the assigned proxy BEFORE creating the context.
    const options = {
      bypassCircuitBreaker: true,
      breaker: null,
      body: { model: "nso/Hermes-4-70B", messages: [{ role: "user", content: "hi" }] },
      provider: "nous-oauth",
      model: "Hermes-4-70B",
      refreshedCredentials: credentials,
      proxyInfo: { proxy },
      log: logger,
      clientRawRequest: { endpoint: "/v1/chat/completions", headers: new Headers(), body: {} },
      credentials,
      apiKeyInfo: null,
      userAgent: "unit-test",
      comboName: null,
      comboStrategy: null,
      isCombo: false,
      extendedContext: false,
      comboStepId: null,
      comboExecutionKey: null,
    };
    const handled = await executeChatWithBreaker(options as never);
    assert.equal(handled.result.status, 503);
    // No explicit proxyInfo: an outer runWithProxyContext can still be inherited.
    // The executor must inspect that effective context, not just handler input.
    const inherited = await runWithProxyContext(proxy, () =>
      executeChatWithBreaker({ ...options, proxyInfo: null } as never)
    );
    assert.equal(inherited.result.status, 503);
    assert.equal(fetches, 0, `${type} relay never receives a token`);
  }
  assert.equal(
    logs.some((line) => line.includes("oauth-relay-sentinel-secret")),
    false
  );
});

test("dead assigned OAuth proxy cannot fail open to direct with PROXY_FAIL_OPEN=true", async () => {
  const previous = process.env.PROXY_FAIL_OPEN;
  process.env.PROXY_FAIL_OPEN = "true";
  const saved = await providersDb.createProviderConnection({
    provider: "nous-oauth",
    authType: "oauth",
    name: "dead assigned proxy oauth",
    accessToken: "dead-proxy-sentinel-secret",
    isActive: true,
    providerSpecificData: {
      [NOUS_OAUTH_INFERENCE_PSD_KEY]: "https://inference-api.nousresearch.com/v1",
    },
  });
  const dead = await proxiesDb.createProxy({
    name: "assigned dead oauth proxy",
    type: "http",
    host: "127.0.0.1",
    port: 9001,
  });
  await proxiesDb.updateProxy(dead!.id, { status: "inactive" });
  await proxiesDb.assignProxyToScope("account", saved.id, dead!.id);
  assert.equal(proxiesDb.hasBlockingProxyAssignment(saved.id, "nous-oauth"), true);
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("Must not send OAuth bearer direct or to dead proxy");
  };
  try {
    await assert.rejects(
      () => safeResolveProxy(saved.id, undefined, "nous-oauth"),
      /PROXY_ASSIGNED_UNAVAILABLE/
    );
    // Defense-in-depth if a caller obtained null proxyInfo through another
    // compatibility path: executeChatWithBreaker still refuses direct egress.
    const credentials = {
      connectionId: saved.id,
      accessToken: "dead-proxy-sentinel-secret",
      providerSpecificData: saved.providerSpecificData,
    };
    const execution = await executeChatWithBreaker({
      bypassCircuitBreaker: true,
      breaker: null,
      body: { model: "nso/Hermes-4-70B", messages: [{ role: "user", content: "hi" }] },
      provider: "nous-oauth",
      model: "Hermes-4-70B",
      refreshedCredentials: credentials,
      proxyInfo: null,
      log: { debug() {}, info() {}, warn() {}, error() {} },
      clientRawRequest: { endpoint: "/v1/chat/completions", headers: new Headers(), body: {} },
      credentials,
      apiKeyInfo: null,
      userAgent: "unit-test",
      comboName: null,
      comboStrategy: null,
      isCombo: false,
      extendedContext: false,
      comboStepId: null,
      comboExecutionKey: null,
    } as never);
    assert.equal(execution.result.status, 503);
    assert.equal(calls, 0);

    // A configured healthy HTTP CONNECT proxy must remain eligible. Mock the
    // actual inference fetch while asserting its authorization is unchanged.
    const healthy = await proxiesDb.createProxy({
      name: "assigned healthy oauth CONNECT proxy",
      type: "http",
      host: "127.0.0.1",
      port: 9002,
    });
    await proxiesDb.assignProxyToScope("account", saved.id, healthy!.id);
    const proxyInfo = await safeResolveProxy(saved.id, undefined, "nous-oauth");
    assert.equal(proxyInfo?.proxy?.type, "http");
    globalThis.fetch = async (url, init) => {
      calls++;
      assert.equal(String(url), "https://inference-api.nousresearch.com/v1/chat/completions");
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer dead-proxy-sentinel-secret"
      );
      return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] });
    };
    const { getExecutor } = await import("../../open-sse/executors/index.ts");
    const healthyResult = await runWithProxyContext(
      proxyInfo.proxy,
      () =>
        getExecutor("nous-oauth").then((executor) =>
          executor.execute({
            model: "Hermes-4-70B",
            stream: false,
            body: { messages: [{ role: "user", content: "hi" }] },
            credentials,
            log: { debug() {}, info() {}, warn() {}, error() {} },
          })
        ),
      { skipUnreachableProbe: true }
    );
    assert.ok(!(healthyResult instanceof Response));
    assert.equal(healthyResult.response.status, 200);
    assert.equal(calls, 1);
  } finally {
    if (previous === undefined) delete process.env.PROXY_FAIL_OPEN;
    else process.env.PROXY_FAIL_OPEN = previous;
  }
});

test("HTTPS_PROXY plus NO_PROXY bypass cannot silently send OAuth bearer direct", async () => {
  const prior = Object.fromEntries(
    ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"].map((name) => [
      name,
      process.env[name],
    ])
  );
  delete process.env.https_proxy;
  delete process.env.ALL_PROXY;
  delete process.env.all_proxy;
  delete process.env.no_proxy;
  process.env.HTTPS_PROXY = "http://127.0.0.1:8123";
  process.env.NO_PROXY = "inference-api.nousresearch.com";
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("NO_PROXY must not expose OAuth bearer directly");
  };
  try {
    const { getExecutor } = await import("../../open-sse/executors/index.ts");
    const result = await (
      await getExecutor("nous-oauth")
    ).execute({
      model: "Hermes-4-70B",
      stream: false,
      body: { messages: [{ role: "user", content: "hi" }] },
      credentials: {
        connectionId: "no-proxy-bypass-fixture",
        accessToken: "no-proxy-sentinel-secret",
        providerSpecificData: {
          [NOUS_OAUTH_INFERENCE_PSD_KEY]: "https://inference-api.nousresearch.com/v1",
        },
      },
      log: { debug() {}, info() {}, warn() {}, error() {} },
    });
    assert.ok(!(result instanceof Response));
    assert.equal(result.response.status, 503);
    assert.equal(calls, 0);
  } finally {
    for (const [name, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
