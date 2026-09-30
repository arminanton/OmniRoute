import test from "node:test";
import assert from "node:assert/strict";
import {
  createMaxaiTransport,
  maxaiFetch,
  type MaxaiEgressAttestation,
} from "../../open-sse/services/maxaiTransport.ts";

const proxy = "http://mock-user:mock-password@proxy.invalid:8080";
function fixture(options: { proxy?: unknown; trusted?: boolean; supported?: boolean } = {}) {
  const calls: Array<{ url: string; options: Record<string, unknown> }> = [];
  const proofs: MaxaiEgressAttestation[] = [];
  let resolutions = 0;
  const transport = createMaxaiTransport({
    bootNow: () => 1_000,
    resolve: async () => {
      resolutions++;
      return { proxyConfig: options.proxy === undefined ? proxy : options.proxy, blocked: false };
    },
    verify: async (route) => {
      if (options.trusted === false) return null;
      const proof: MaxaiEgressAttestation = {
        ...route,
        kind: route.proxyFingerprint ? "proxy" : "namespace",
        bootId: "fixture-boot",
        namespaceId: "fixture-ns",
        generation: "fixture-generation",
        expiresAt: Date.now() + 30_000,
        expiresBootMs: 16_000,
      };
      proofs.push(proof);
      return proof;
    },
    profileSupported: () => options.supported !== false,
    tlsFetch: async (url, init) => {
      calls.push({ url, options: init as Record<string, unknown> });
      return new Response("ok");
    },
  });
  return { transport, calls, proofs, resolutions: () => resolutions };
}

test("MaxAI has no ambient/native default fetch", async () => {
  let unsafe = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    unsafe++;
    return new Response("unsafe");
  };
  try {
    await assert.rejects(
      maxaiFetch("https://api.maxai.me/gpt/cwc/chat", { method: "POST" }),
      /MaxAI.*transport/i
    );
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(unsafe, 0);
});

test("exact connection proxy, Firefox session scope, no redirect or reselection", async () => {
  const { transport, calls, resolutions } = fixture();
  const oldNoProxy = process.env.NO_PROXY;
  process.env.NO_PROXY = "*";
  try {
    await transport.run("conn-a", async () => {
      await transport.fetch("https://www.maxai.co/app/");
      await transport.fetch("https://api.maxai.me/gpt/cwc/chat", { method: "POST", body: "{}" });
    });
  } finally {
    if (oldNoProxy === undefined) delete process.env.NO_PROXY;
    else process.env.NO_PROXY = oldNoProxy;
  }
  assert.equal(resolutions(), 1);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.options.proxy, proxy);
    assert.match(String(call.options.sessionScope), /^maxai:conn-a:/);
    assert.equal(call.options.redirect, "error");
  }
});

test("unknown residential route, unavailable profile, missing scope and incompatible proxies do not send", async () => {
  for (const options of [
    { trusted: false },
    { supported: false },
    { proxy: "socks5://proxy.invalid:1080" },
    { proxy: "http://proxy.invalid:8080?family=ipv4" },
    { proxy: { type: "vercel", host: "relay.invalid" } },
  ]) {
    const { transport, calls } = fixture(options);
    await assert.rejects(
      transport.run("conn-a", () => transport.fetch("https://www.maxai.co/app/"))
    );
    assert.equal(calls.length, 0);
  }
  const { transport, calls } = fixture();
  await assert.rejects(transport.run("", () => transport.fetch("https://www.maxai.co/app/")));
  assert.equal(calls.length, 0);
});

test("independently attested namespace accepted without env proxy; untrusted null rejected", async () => {
  const a = fixture({ proxy: null });
  await a.transport.run("conn-a", () => a.transport.fetch("https://www.maxai.co/app/"));
  assert.equal(a.calls[0].options.proxy, null);
  const b = fixture({ proxy: null, trusted: false });
  await assert.rejects(
    b.transport.run("conn-a", () => b.transport.fetch("https://www.maxai.co/app/"))
  );
  assert.equal(b.calls.length, 0);
});

test("unsupported request shapes/origin/redirect/extra options fail before TLS", async () => {
  const { transport, calls } = fixture();
  await transport.run("conn-a", async () => {
    const invalid: Array<[RequestInfo | URL, RequestInit | undefined]> = [
      [new Request("https://www.maxai.co/app/"), undefined],
      ["https://evil.invalid/app/", undefined],
      ["https://api.maxai.me/unknown", { method: "POST" }],
      ["https://www.maxai.co/app/", { redirect: "follow" }],
      ["https://www.maxai.co/app/", { dispatcher: {} } as RequestInit],
      ["https://api.maxai.me/gpt/cwc/chat", { method: "POST", body: new ReadableStream() }],
      ["https://www.maxai.co/app/", { headers: { Authorization: "Bearer mock" } }],
    ];
    for (const [url, init] of invalid) await assert.rejects(transport.fetch(url, init));
  });
  assert.equal(calls.length, 0);
});

test("nested connection switch and cancellation cannot dispatch", async () => {
  const { transport, calls } = fixture();
  const controller = new AbortController();
  controller.abort();
  await transport.run("conn-a", async () => {
    await assert.rejects(
      transport.run("conn-b", () => transport.fetch("https://www.maxai.co/app/"))
    );
    await assert.rejects(
      transport.fetch("https://www.maxai.co/app/", { signal: controller.signal }),
      { name: "AbortError" }
    );
  });
  assert.equal(calls.length, 0);
});

test("TLS errors do not retry or fall back and redirect responses are cancelled", async () => {
  let attempts = 0,
    cancelled = false;
  const transport = createMaxaiTransport({
    bootNow: () => 1_000,
    resolve: async () => ({ proxyConfig: proxy, blocked: false }),
    profileSupported: () => true,
    verify: async (route) => ({
      ...route,
      kind: "proxy",
      bootId: "boot",
      namespaceId: "ns",
      generation: "gen",
      expiresAt: Date.now() + 15_000,
      expiresBootMs: 16_000,
    }),
    tlsFetch: async () => {
      attempts++;
      throw new Error("mock secret proxy password");
    },
  });
  await assert.rejects(
    transport.run("conn-a", () =>
      transport.fetch("https://api.maxai.me/gpt/cwc/chat", { method: "POST" })
    ),
    (error) => {
      assert.doesNotMatch(String(error), /password/);
      return true;
    }
  );
  assert.equal(attempts, 1);
  const redirect = createMaxaiTransport({
    bootNow: () => 1_000,
    resolve: async () => ({ proxyConfig: proxy, blocked: false }),
    profileSupported: () => true,
    verify: async (route) => ({
      ...route,
      kind: "proxy",
      bootId: "boot",
      namespaceId: "ns",
      generation: "gen",
      expiresAt: Date.now() + 15_000,
      expiresBootMs: 16_000,
    }),
    tlsFetch: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { status: 302, headers: { location: "https://evil.invalid/" } }
      ),
  });
  await assert.rejects(redirect.run("conn-a", () => redirect.fetch("https://www.maxai.co/app/")));
  assert.equal(cancelled, true);
});

test("proof renewal keeps same scope but generation change prevents second send", async () => {
  let generation = "a",
    calls = 0;
  const transport = createMaxaiTransport({
    bootNow: () => 1_000,
    resolve: async () => ({ proxyConfig: proxy, blocked: false }),
    profileSupported: () => true,
    verify: async (route) => ({
      ...route,
      kind: "proxy",
      bootId: "boot",
      namespaceId: "ns",
      generation,
      expiresAt: Date.now() + 15_000,
      expiresBootMs: 16_000,
    }),
    tlsFetch: async () => {
      calls++;
      return new Response("ok");
    },
  });
  await transport.run("conn-a", async () => {
    await transport.fetch("https://www.maxai.co/app/");
    generation = "b";
    await assert.rejects(transport.fetch("https://www.maxai.co/app/"));
  });
  assert.equal(calls, 1);
});

test("Firefox identity rejects Chrome client hints or mismatched user-agent", async () => {
  const { transport, calls } = fixture();
  await transport.run("conn-a", async () => {
    for (const headers of [{ "user-agent": "Chrome mock" }, { "sec-ch-ua": "Chrome mock" }])
      await assert.rejects(
        transport.fetch("https://api.maxai.me/gpt/cwc/chat", { method: "POST", headers })
      );
  });
  assert.equal(calls.length, 0);
});

test("installed wreq profile introspection agrees with fail-closed Firefox gate (no sockets)", async () => {
  const { maxaiFirefoxProfileSupported } =
    await import("../../open-sse/services/maxaiTransport.ts");
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  let runtime: {
    getProfiles: () => string[];
    getOperatingSystems: () => string[];
    getEmulationHeaders: (browser: string, os: string) => { get: (name: string) => string | null };
  };
  try {
    runtime = require("wreq-js");
  } catch {
    assert.equal(maxaiFirefoxProfileSupported(), false);
    return;
  }
  const supported =
    runtime.getProfiles().includes("firefox_150") &&
    runtime.getOperatingSystems().includes("windows");
  assert.equal(maxaiFirefoxProfileSupported(), supported);
  if (supported)
    assert.equal(
      runtime.getEmulationHeaders("firefox_150", "windows").get("user-agent"),
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0"
    );
});

test("dedicated native adapter gets Windows Firefox and isolates exact connection/proxy sessions", async () => {
  const { createMaxaiTlsClient } = await import("../../open-sse/services/maxaiTransport.ts");
  const sessions: Array<Record<string, unknown>> = [];
  let requests = 0;
  const client = createMaxaiTlsClient(
    async (options) => {
      sessions.push(options);
      return {
        fetch: async (_url, init) => {
          requests++;
          assert.equal(init.redirect, "error");
          return new Response("ok");
        },
        close: async () => {},
        getCookies: () => ({}),
      };
    },
    () => {}
  );
  const url = "https://api.maxai.me/gpt/cwc/chat";
  try {
    await client.fetch(url, { method: "POST", sessionScope: "conn-a", proxy, redirect: "error" });
    await client.fetch(url, { method: "POST", sessionScope: "conn-a", proxy, redirect: "error" });
    await client.fetch(url, { method: "POST", sessionScope: "conn-b", proxy, redirect: "error" });
    await client.fetch(url, {
      method: "POST",
      sessionScope: "conn-a",
      proxy: "http://other.invalid:8080",
      redirect: "error",
    });
    assert.equal(sessions.length, 3);
    assert.equal(requests, 4);
    for (const options of sessions) {
      assert.equal(options.browser, "firefox_150");
      assert.equal(options.os, "windows");
    }
    assert.equal(sessions[0].proxy, proxy);
    assert.equal(sessions[2].proxy, "http://other.invalid:8080");
  } finally {
    await client.closeAll();
  }
});
