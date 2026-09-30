import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-compatible-egress-"));
process.env.DATA_DIR = dir;
process.env.API_KEY_SECRET = "compatible-egress-test-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
const core = await import("../../src/lib/db/core.ts");
const providers = await import("../../src/lib/db/providers.ts");
const cache = await import("../../src/lib/db/readCache.ts");
const auth = await import("../../src/sse/services/auth.ts");
const { DefaultExecutor } = await import("../../open-sse/executors/default.ts");
const { BaseExecutor } = await import("../../open-sse/executors/base.ts");
const realFetch = globalThis.fetch;
let sends = 0;
test.beforeEach(() => {
  sends = 0;
  globalThis.fetch = (async () => {
    sends++;
    return Response.json({ choices: [] });
  }) as typeof fetch;
});
test.afterEach(() => {
  globalThis.fetch = realFetch;
});
test.after(() => {
  core.resetDbInstance();
  fs.rmSync(dir, { recursive: true, force: true });
});

for (const provider of ["openai-compatible-chat-missing", "anthropic-compatible-missing"]) {
  for (const baseUrl of [
    undefined,
    "",
    "  ",
    "not-a-url",
    "ftp://custom.example.test/v1",
    "https://user:secret@custom.example.test/v1",
  ]) {
    test(`${provider} refuses invalid/missing baseUrl ${JSON.stringify(baseUrl)} before fetch`, async () => {
      const executor = new DefaultExecutor(provider);
      await assert.rejects(
        executor.execute({
          model: "fixture",
          body: { messages: [] },
          stream: false,
          credentials: { apiKey: "private-custom-key", providerSpecificData: { baseUrl } },
        }),
        /baseUrl/
      );
      assert.equal(sends, 0, "custom credentials must not reach any fallback provider");
    });
  }
}

test("BaseExecutor cannot substitute the native OpenAI base for a custom node", () => {
  const executor = new BaseExecutor("openai-compatible-chat-missing", {});
  assert.throws(
    () => executor.buildUrl("fixture", false, 0, { apiKey: "private-custom-key" }),
    /baseUrl/
  );
  assert.equal(sends, 0);
});

test("BaseExecutor cannot substitute its config URL for an Anthropic-compatible node", () => {
  const executor = new BaseExecutor("anthropic-compatible-missing", {
    baseUrl: "https://api.openai.com/v1",
  });
  assert.throws(
    () => executor.buildUrl("fixture", false, 0, { apiKey: "private-custom-key" }),
    /baseUrl/
  );
  assert.equal(sends, 0);
});

test("invalid custom chatPath cannot change the credential destination authority", async () => {
  const executor = new DefaultExecutor("openai-compatible-chat-path-fixture");
  const credentials = {
    apiKey: "private-custom-key",
    providerSpecificData: {
      baseUrl: "https://configured.example.test",
      chatPath: "@api.openai.com/v1/chat/completions",
    },
  };
  assert.equal(
    new URL(executor.buildUrl("fixture", false, 0, credentials)).hostname,
    "configured.example.test"
  );
  assert.equal(sends, 0);
});

let sequence = 0;
async function fixture(type: string, psd: Record<string, unknown> = {}) {
  const id = `${type}-00000000-0000-0000-0000-${String(++sequence).padStart(12, "0")}`;
  await providers.createProviderNode({
    id,
    type: type.startsWith("openai") ? "openai-compatible" : "anthropic-compatible",
    name: "trusted fixture",
    prefix: `fixture${sequence}`,
    baseUrl: "https://configured.example.test/v1",
    apiType: type.includes("responses") ? "responses" : "chat",
    chatPath: type.startsWith("anthropic") ? "/messages" : "/custom/chat",
    customHeaders: { "X-Node": "trusted" },
  });
  const connection = await providers.createProviderConnection({
    provider: id,
    authType: "apikey",
    apiKey: "private-custom-key",
    name: id,
    isActive: true,
    testStatus: "active",
    providerSpecificData: psd,
  });
  return { id, connection };
}

for (const type of [
  "openai-compatible-chat",
  "openai-compatible-responses",
  "anthropic-compatible",
  "anthropic-compatible-cc",
]) {
  test(`${type} rehydrates the configured node, not stale copied routing data`, async () => {
    const { id } = await fixture(type, {
      baseUrl: "https://stale.example.test/v1",
      chatPath: "/stale",
      customHeaders: { "X-Node": "stale" },
      accountTag: "keep",
    });
    const credentials = await auth.getProviderCredentials(id);
    assert.ok(credentials && "providerSpecificData" in credentials);
    assert.ok(
      credentials.providerSpecificData && typeof credentials.providerSpecificData === "object"
    );
    assert.equal(credentials.providerSpecificData.baseUrl, "https://configured.example.test/v1");
    assert.equal(
      credentials.providerSpecificData.chatPath,
      type.startsWith("anthropic") ? "/messages" : "/custom/chat"
    );
    assert.deepEqual(credentials.providerSpecificData.customHeaders, { "X-Node": "trusted" });
    assert.equal(credentials.providerSpecificData.accountTag, "keep");
    assert.equal(credentials.apiKey, "private-custom-key");
    assert.equal(sends, 0);
  });
}

test("deleted node fails closed even with a populated five-second node cache and stale copied URL", async () => {
  const { id } = await fixture("openai-compatible-chat", {
    baseUrl: "https://stale.example.test/v1",
  });
  await cache.getCachedProviderNodes();
  // A different process would not invalidate this process's five-second cache.
  core.getDbInstance().prepare("DELETE FROM provider_nodes WHERE id = ?").run(id);
  const credentials = await auth.getProviderCredentials(id);
  assert.ok(credentials && "providerSpecificData" in credentials);
  await assert.rejects(
    new DefaultExecutor(id).execute({
      model: "fixture",
      body: { messages: [] },
      stream: false,
      credentials,
    }),
    /baseUrl/
  );
  assert.equal(sends, 0);
});

test("invalid current node cannot be rescued by a stale connection baseUrl", async () => {
  const { id } = await fixture("anthropic-compatible", {
    baseUrl: "https://stale.example.test/v1",
  });
  await providers.updateProviderNode(id, { baseUrl: " " });
  const credentials = await auth.getProviderCredentials(id);
  assert.ok(credentials && "providerSpecificData" in credentials);
  await assert.rejects(
    new DefaultExecutor(id).execute({
      model: "fixture",
      body: { messages: [] },
      stream: false,
      credentials,
    }),
    /baseUrl/
  );
  assert.equal(sends, 0);
});

test("missing copied baseUrl is restored from its exact stored node and sent only there", async () => {
  const { id } = await fixture("openai-compatible-responses");
  const credentials = await auth.getProviderCredentials(id);
  assert.ok(credentials && "providerSpecificData" in credentials);
  globalThis.fetch = (async (url, init) => {
    sends++;
    assert.equal(String(url), "https://configured.example.test/v1/custom/chat");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer private-custom-key");
    return Response.json({ choices: [] });
  }) as typeof fetch;
  await new DefaultExecutor(id).execute({
    model: "fixture",
    body: { messages: [] },
    stream: false,
    credentials,
  });
  assert.equal(sends, 1);
});

test("missing concrete node never adopts a different surviving node of the same type", async () => {
  const { id } = await fixture("anthropic-compatible-cc");
  await fixture("anthropic-compatible-cc");
  core.getDbInstance().prepare("DELETE FROM provider_nodes WHERE id = ?").run(id);
  const credentials = await auth.getProviderCredentials(id);
  assert.ok(credentials && "providerSpecificData" in credentials);
  assert.throws(
    () => new DefaultExecutor(id).buildUrl("fixture", false, 0, credentials),
    /baseUrl/
  );
  assert.equal(sends, 0);
});

test("legacy generic node type is accepted only while unambiguous", async () => {
  const { hydrateCompatibleNodeBaseUrl } =
    await import("../../src/sse/services/compatibleNodeBaseUrl.ts");
  const unique = "openai-compatible-chat-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const other = "openai-compatible-chat-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  // Use a transaction-like fixture reset for only this node type (no external state).
  core
    .getDbInstance()
    .prepare("DELETE FROM provider_nodes WHERE id LIKE 'openai-compatible-chat-%'")
    .run();
  await providers.createProviderNode({
    id: unique,
    name: "unique fixture",
    type: "openai-compatible",
    baseUrl: "https://unique.example.test/v1",
  });
  const hydrated = await hydrateCompatibleNodeBaseUrl("openai-compatible-chat", {});
  assert.equal(hydrated.baseUrl, "https://unique.example.test/v1");
  await providers.createProviderNode({
    id: other,
    name: "other fixture",
    type: "openai-compatible",
    baseUrl: "https://other.example.test/v1",
  });
  assert.equal(
    (await hydrateCompatibleNodeBaseUrl("openai-compatible-chat", hydrated)).baseUrl,
    undefined
  );
  assert.equal(sends, 0);
});

test("compatible-node hydration preserves resolved account proxy references and unrelated metadata", async () => {
  const proxies = await import("../../src/lib/db/proxies.ts");
  const proxy = await proxies.createProxy({
    name: "fixture",
    type: "http",
    host: "127.0.0.1",
    port: 9416,
  });
  const { id } = await fixture("openai-compatible-responses", {
    accountProxies: [{ fingerprint: "fixture", proxyId: proxy!.id }],
    accountTag: "keep",
  });
  const credentials = await auth.getProviderCredentials(id);
  assert.ok(credentials && "providerSpecificData" in credentials);
  assert.ok(
    credentials.providerSpecificData && typeof credentials.providerSpecificData === "object"
  );
  assert.deepEqual(credentials.providerSpecificData.accountProxies, [
    { fingerprint: "fixture", proxy: { type: "http", host: "127.0.0.1", port: 9416 } },
  ]);
  assert.equal(credentials.providerSpecificData.accountTag, "keep");
  assert.equal(sends, 0);
});

test("node lookup failure invalidates copied baseUrl without throwing during managed credential selection", async () => {
  const { hydrateCompatibleNodeBaseUrl } =
    await import("../../src/sse/services/compatibleNodeBaseUrl.ts");
  core
    .getDbInstance()
    .prepare("ALTER TABLE provider_nodes RENAME TO unavailable_fixture_nodes")
    .run();
  try {
    const hydrated = await hydrateCompatibleNodeBaseUrl("openai-compatible-chat-missing", {
      baseUrl: "https://stale.example.test/v1",
    });
    assert.equal(hydrated.baseUrl, undefined);
    assert.equal(sends, 0);
  } finally {
    core
      .getDbInstance()
      .prepare("ALTER TABLE unavailable_fixture_nodes RENAME TO provider_nodes")
      .run();
  }
});

test("provider URL helper refuses native defaults for both compatible families", async () => {
  const { buildProviderUrl } = await import("../../open-sse/services/provider.ts");
  for (const provider of [
    "openai-compatible-chat-missing",
    "anthropic-compatible-missing",
    "anthropic-compatible-cc-missing",
  ]) {
    assert.throws(() => buildProviderUrl(provider, "fixture", false, {}), /baseUrl/);
    const url = buildProviderUrl(provider, "fixture", false, {
      providerSpecificData: { baseUrl: "https://configured.example.test/v1" },
    });
    assert.equal(new URL(url).origin, "https://configured.example.test");
  }
  assert.equal(sends, 0);
});

test("custom URL assembly retains scheme/authority for hostile and valid custom paths", async () => {
  const { guardCompatibleUrl } = await import("../../open-sse/config/providerRegistry.ts");
  for (const baseUrl of [
    "https://configured.example.test",
    "http://configured.example.test:8123/v1",
  ]) {
    for (const provider of [
      "openai-compatible-chat-paths",
      "anthropic-compatible-paths",
      "anthropic-compatible-cc-paths",
    ]) {
      for (const executor of [new DefaultExecutor(provider), new BaseExecutor(provider, {})]) {
        for (const chatPath of [
          "@api.openai.com/v1",
          "//api.openai.com/v1",
          "/\\api.openai.com/v1",
          "/bad\u0001path",
          "/bad\npath",
          "/messages#fragment",
          "/messages?api-version=fixture",
        ]) {
          const url = executor.buildUrl("fixture", false, 0, {
            apiKey: "fixture-secret",
            providerSpecificData: { baseUrl, chatPath },
          });
          assert.equal(new URL(url).origin, new URL(baseUrl).origin);
          assert.equal(new URL(url).hash, "");
        }
      }
    }
    assert.throws(
      () => guardCompatibleUrl(baseUrl, "https://other.example.test/messages"),
      /invalid endpoint path/
    );
    assert.throws(
      () => guardCompatibleUrl(baseUrl, "https://user:secret@configured.example.test/messages"),
      /invalid endpoint path/
    );
  }
  assert.equal(sends, 0);
});
