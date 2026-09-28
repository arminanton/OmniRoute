/** UC persona identity must agree across registry, model routing, UI, and credentials. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-uc-identity-"));
process.env.DATA_DIR = dataDir;

const { REGISTRY, getRegistryEntry } = await import("../../open-sse/config/providerRegistry.ts");
const { parseModel, getModelInfoCore } = await import("../../open-sse/services/model.ts");
const { getModelInfo } = await import("../../src/sse/services/model.ts");
const { getExecutor, hasSpecializedExecutor } = await import("../../open-sse/executors/index.ts");
const { UcExecutor } = await import("../../open-sse/executors/uc.ts");
const {
  getProviderById,
  getProviderByAlias,
  getProviderConnectionFamilyIds,
  providerAllowsOptionalApiKey,
} = await import("../../src/shared/constants/providers.ts");
const { isReservedProviderPrefix } =
  await import("../../src/shared/constants/reservedProviderPrefixes.ts");
const { createProviderSchema } = await import("../../src/shared/validation/schemas/provider.ts");
const core = await import("../../src/lib/db/core.ts");
const { createProviderConnection } = await import("../../src/lib/db/providers.ts");
const { getProviderCredentials } = await import("../../src/sse/services/auth.ts");

function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(dataDir, { recursive: true });
}

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("registry map keys equal entry IDs, including UC Persona", () => {
  const mismatches = Object.entries(REGISTRY)
    .filter(([key, entry]) => key !== entry.id)
    .map(([key, entry]) => `${key} -> ${entry.id}`);
  assert.deepEqual(mismatches, []);
  assert.equal(REGISTRY.uc?.id, "uc");
  for (const prefix of ["uc", "ucn", "uc-persona"]) {
    assert.equal(getRegistryEntry(prefix), REGISTRY.uc);
    assert.equal(isReservedProviderPrefix(prefix), true);
  }
});

test("UC prefixes canonicalize to the specialized provider before model lookup", async () => {
  for (const prefix of ["uc", "ucn", "uc-persona"]) {
    const parsed = parseModel(`${prefix}/deepseek-r1`);
    assert.equal(parsed.provider, "uc", prefix);
    assert.equal(parsed.providerAlias, prefix);
    assert.equal(parsed.model, "deepseek-r1");
    assert.deepEqual(await getModelInfoCore(`${prefix}/deepseek-r1`, {}), {
      provider: "uc",
      model: "deepseek-r1",
      extendedContext: false,
    });
    const runtime = await getModelInfo(`${prefix}/deepseek-r1`);
    assert.equal(runtime.provider, "uc", prefix);
    assert.equal(runtime.model, "deepseek-r1", prefix);
    assert.equal(hasSpecializedExecutor(runtime.provider), true);
  }
  assert.equal(parseModel("ucd/claude-opus-5").provider, "uc-direct");
});

test("UC card and no-key schema use the same canonical connection ID", () => {
  assert.equal(getProviderById("uc")?.id, "uc");
  assert.equal(getProviderByAlias("ucn")?.id, "uc");
  assert.equal(getProviderByAlias("uc-persona")?.id, "uc");
  assert.deepEqual(getProviderConnectionFamilyIds("uc"), ["uc", "uc-persona"]);
  assert.equal(providerAllowsOptionalApiKey("uc"), true);
  assert.equal(
    createProviderSchema.safeParse({ provider: "uc", name: "UC Persona" }).success,
    true
  );
});

test("canonical UC selects its specialized executor, not OpenAI default", async () => {
  assert.equal(hasSpecializedExecutor("uc"), true);
  for (const prefix of ["uc", "ucn", "uc-persona"]) {
    assert.equal(hasSpecializedExecutor(prefix), true, prefix);
    assert.ok((await getExecutor(prefix)) instanceof UcExecutor, prefix);
  }
});

test("active legacy UC connection can be selected without an API key", async () => {
  resetStorage();
  const row = await createProviderConnection({
    provider: "uc",
    authType: "apikey",
    name: "UC legacy",
    apiKey: null,
    providerSpecificData: {
      ucClientCookie: "test-client-cookie",
      ucSid: "test-session",
      ucUid: "test-user",
    },
    isActive: true,
    testStatus: "active",
  });
  for (const prefix of ["uc", "ucn"]) {
    const credentials = await getProviderCredentials(prefix, null, null, "deepseek-r1");
    assert.equal(credentials?.connectionId, row.id, prefix);
  }
});

test("transitional uc-persona rows remain reachable through canonical UC", async () => {
  resetStorage();
  const row = await createProviderConnection({
    provider: "uc-persona",
    authType: "apikey",
    name: "UC transitional",
    apiKey: null,
    providerSpecificData: {
      ucClientCookie: "test-client-cookie",
      ucSid: "test-session",
      ucUid: "test-user",
    },
    isActive: true,
    testStatus: "active",
  });
  const credentials = await getProviderCredentials("uc", null, null, "deepseek-r1");
  assert.equal(credentials?.connectionId, row.id);
});

test("ucn model and active legacy row dispatch through UC WebSocket, never OpenAI", async (t) => {
  resetStorage();
  const uid = "b03dd963-d0c1-4193-99c9-f5a9d0c66b7f";
  const sid = "sess_3EyqBpAa2C25iB8eJzZ2fwdsqLM-identity";
  const cookie = "test-client-cookie";
  const row = await createProviderConnection({
    provider: "uc",
    authType: "apikey",
    name: "UC route integration",
    apiKey: null,
    providerSpecificData: {
      ucClientCookie: cookie,
      ucSid: sid,
      ucUid: uid,
      ucCookies: { __client: cookie },
    },
    isActive: true,
    testStatus: "active",
  });
  const originalFetch = globalThis.fetch;
  const mintedUrls: string[] = [];
  const socketUrls: string[] = [];
  const frames: Record<string, unknown>[] = [];
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const jwt = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    uid,
    sid,
    exp: Math.floor(Date.now() / 1000) + 120,
  })}.sig`;
  globalThis.fetch = (async (url: string | URL | Request) => {
    mintedUrls.push(String(url));
    assert.match(String(url), /^https:\/\/.*\/v1\/client\/sessions\/sess_/);
    return new Response(JSON.stringify({ object: "token", jwt }), { status: 200 });
  }) as typeof fetch;
  class FakeWs {
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    readyState = 1;
    constructor(url: string) {
      socketUrls.push(url);
      setTimeout(() => this.onopen?.(), 0);
    }
    send(data: string) {
      frames.push(JSON.parse(data) as Record<string, unknown>);
      setTimeout(() => {
        this.onmessage?.({
          data: JSON.stringify({
            message_type: "text",
            end_of_stream: true,
            raw_text: "UC_ROUTE_OK",
          }),
        });
        this.onclose?.();
      }, 0);
    }
    close() {}
  }
  const { __setUcWebSocketForTesting } = await import("../../open-sse/executors/uc/ws.ts");
  const restoreSocket = __setUcWebSocketForTesting(
    FakeWs as unknown as typeof import("ws").default
  );
  t.after(() => {
    restoreSocket();
    globalThis.fetch = originalFetch;
  });
  const info = await getModelInfo("ucn/deepseek-r1");
  assert.equal(info.provider, "uc");
  const credentials = await getProviderCredentials(info.provider, null, null, info.model);
  assert.equal(credentials?.connectionId, row.id);
  const executor = await getExecutor(info.provider);
  assert.ok(executor instanceof UcExecutor);
  const result = await executor.execute({
    model: info.model,
    stream: false,
    credentials,
    body: { messages: [{ role: "user", content: "ping" }] },
  } as never);
  const response = (result as { response?: Response }).response ?? (result as Response);
  assert.equal(response.status, 200);
  const completion = await response.json();
  assert.equal(completion.choices?.[0]?.message?.content, "UC_ROUTE_OK");
  assert.equal(mintedUrls.length, 1);
  assert.equal(socketUrls.length, 1);
  assert.match(socketUrls[0], /^wss:\/\/internal-6\.pubyar\.com\/ws\//);
  assert.equal(frames[0]?.model, "deepseek-r1");
  assert.ok(mintedUrls.every((url) => !url.includes("api.openai.com")));
});
