import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-maxai-stt-route-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const priorTlsEnabled = process.env.ENABLE_TLS_FINGERPRINT;
const priorTlsProviders = process.env.TLS_FINGERPRINT_PROVIDERS;
delete process.env.ENABLE_TLS_FINGERPRINT;
delete process.env.TLS_FINGERPRINT_PROVIDERS;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const proxiesDb = await import("../../src/lib/db/proxies.ts");
const { __setMaxaiConstantsForTest } =
  await import("../../open-sse/executors/maxai/constantsStore.ts");
const { MOCK_CONSTANTS } = await import("./helpers/maxaiMockConstants.ts");
const { setTlsClientForTest } = await import("../../open-sse/utils/proxyFetch.ts");
const route = await import("../../src/app/api/v1/audio/transcriptions/route.ts");

const WEBM_BYTES = new Uint8Array([
  ...Buffer.from("OggS"),
  ...new Uint8Array(24),
  ...Buffer.from("OpusHead"),
]);

function fakeJwt(exp: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  return `${header}.${payload}.sig`;
}

__setMaxaiConstantsForTest(MOCK_CONSTANTS);

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(resetStorage);

test.after(async () => {
  setTlsClientForTest(null);
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  if (priorTlsEnabled === undefined) delete process.env.ENABLE_TLS_FINGERPRINT;
  else process.env.ENABLE_TLS_FINGERPRINT = priorTlsEnabled;
  if (priorTlsProviders === undefined) delete process.env.TLS_FINGERPRINT_PROVIDERS;
  else process.env.TLS_FINGERPRINT_PROVIDERS = priorTlsProviders;
});

test("MaxAI transcription route preserves multipart data through scoped Firefox TLS transport", async () => {
  const connection = await providersDb.createProviderConnection({
    provider: "maxai",
    authType: "apikey",
    name: "MaxAI STT route test",
    apiKey: "access-token",
    isActive: true,
    testStatus: "active",
    providerSpecificData: {
      maxaiAccessToken: "access-token",
      maxaiDeviceId: "22222222-2222-4222-8222-222222222222",
      maxaiUserId: "11111111-1111-4111-8111-111111111111",
    },
  });
  assert.ok(connection?.id);
  const connectionId = String(connection.id);

  const proxy = await proxiesDb.createProxy({
    name: "MaxAI STT route proxy",
    type: "http",
    host: "proxy.maxai.test",
    port: 8080,
    username: "route-user",
    password: "route-pass",
  });
  assert.equal(typeof proxy?.id, "string");
  const proxyId = String(proxy?.id);
  await proxiesDb.assignProxyToScope("account", connectionId, proxyId);

  let tlsCalls = 0;
  let observedOptions: Record<string, unknown> | undefined;
  setTlsClientForTest({
    available: true,
    fetch: async (_url, options) => {
      tlsCalls += 1;
      observedOptions = options as unknown as Record<string, unknown>;
      const body = options?.body;
      assert.ok(body instanceof FormData, "TLS transport must receive the original FormData body");
      assert.equal(body.get("feature_name"), "immersive_chat");
      assert.equal(body.get("prompt_name"), "Use microphone");
      assert.equal(body.get("event_source"), "web");
      const audio = body.get("audio_file");
      assert.ok(audio instanceof Blob);
      assert.equal(audio.type, "audio/webm");
      assert.equal((audio as File).name, "audio.webm");
      assert.deepEqual(new Uint8Array(await audio.arrayBuffer()), WEBM_BYTES);
      return new Response(
        JSON.stringify({ status: "OK", data: { speech_text: "route transcription" } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    },
  });

  const formData = new FormData();
  formData.set("model", "maxai/speech-to-text");
  formData.set(
    "file",
    new Blob([WEBM_BYTES], { type: "audio/webm;codecs=opus" }),
    "route-capture.webm"
  );
  const response = await route.POST(
    new Request("http://localhost/v1/audio/transcriptions", { method: "POST", body: formData })
  );

  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), { text: "route transcription" });
  assert.equal(tlsCalls, 1);
  assert.equal(observedOptions?.browserProfile, "firefox_150");
  assert.equal(observedOptions?.os, "windows");
  assert.equal(observedOptions?.sessionScope, connectionId);
  assert.match(String(observedOptions?.proxy), /proxy\.maxai\.test:8080/);
});

test("MaxAI transcription route rejects assigned SOCKS before calling TLS client", async () => {
  const connection = await providersDb.createProviderConnection({
    provider: "maxai",
    authType: "apikey",
    name: "MaxAI SOCKS rejection",
    apiKey: "access-token",
    isActive: true,
    testStatus: "active",
    providerSpecificData: {
      maxaiAccessToken: "access-token",
      maxaiDeviceId: "22222222-2222-4222-8222-222222222222",
      maxaiUserId: "11111111-1111-4111-8111-111111111111",
    },
  });
  const connectionId = String(connection?.id);
  const proxy = await proxiesDb.createProxy({
    name: "MaxAI SOCKS proxy",
    type: "socks5",
    host: "socks.maxai.test",
    port: 1080,
  });
  await proxiesDb.assignProxyToScope("account", connectionId, String(proxy?.id));

  let tlsCalls = 0;
  setTlsClientForTest({
    available: true,
    fetch: async () => {
      tlsCalls += 1;
      throw new Error("TLS client must not be called");
    },
  });

  const formData = new FormData();
  formData.set("model", "maxai/speech-to-text");
  formData.set("file", new Blob([WEBM_BYTES], { type: "audio/webm" }), "capture.webm");
  const response = await route.POST(
    new Request("http://localhost/v1/audio/transcriptions", { method: "POST", body: formData })
  );

  assert.equal(response.ok, false);
  assert.equal(response.status, 502);
  assert.equal(tlsCalls, 0);
  assert.match(await response.text(), /does not support the assigned proxy/);
});

test("MaxAI transcription route propagates client cancellation to the TLS request", async () => {
  const connection = await providersDb.createProviderConnection({
    provider: "maxai",
    authType: "apikey",
    name: "MaxAI STT cancellation",
    apiKey: "access-token",
    isActive: true,
    testStatus: "active",
    providerSpecificData: {
      maxaiAccessToken: "access-token",
      maxaiDeviceId: "22222222-2222-4222-8222-222222222222",
      maxaiUserId: "11111111-1111-4111-8111-111111111111",
    },
  });
  assert.ok(connection?.id);

  const controller = new AbortController();
  let observedSignal: AbortSignal | null | undefined;
  setTlsClientForTest({
    available: true,
    fetch: async (_url, options) => {
      observedSignal = options?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        const signal = options?.signal;
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        controller.abort();
      });
    },
  });

  const formData = new FormData();
  formData.set("model", "maxai/speech-to-text");
  formData.set("file", new Blob([WEBM_BYTES], { type: "audio/webm" }), "capture.webm");
  const response = await route.POST(
    new Request("http://localhost/v1/audio/transcriptions", {
      method: "POST",
      body: formData,
      signal: controller.signal,
    })
  );

  assert.equal(observedSignal?.aborted, true);
  assert.equal(response.status, 499);
  assert.match(await response.text(), /aborted/i);
});

test("MaxAI transcription route refreshes and persists rotated credentials on the selected connection", async () => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const oldAccess = fakeJwt(nowSeconds + 60);
  const newAccess = fakeJwt(nowSeconds + 86_400);
  const oldRefresh = "old-route-refresh";
  const newRefresh = "new-route-refresh";
  const connection = await providersDb.createProviderConnection({
    provider: "maxai",
    authType: "apikey",
    name: "MaxAI refresh persistence",
    apiKey: oldAccess,
    accessToken: oldAccess,
    isActive: true,
    testStatus: "active",
    providerSpecificData: {
      maxaiAccessToken: oldAccess,
      maxaiRefreshToken: oldRefresh,
      maxaiDeviceId: "22222222-2222-4222-8222-222222222222",
      maxaiUserId: "11111111-1111-4111-8111-111111111111",
    },
  });
  const connectionId = String(connection?.id);
  const sessions: string[] = [];
  setTlsClientForTest({
    available: true,
    fetch: async (url, options) => {
      sessions.push(String(options?.sessionScope));
      if (url.endsWith("/oauth/refresh_access_token")) {
        return new Response(
          JSON.stringify({ data: { access_token: newAccess, refresh_token: newRefresh } })
        );
      }
      if (url.endsWith("/gpt/speech_to_text")) {
        assert.equal(
          (options?.headers as Record<string, string>).Authorization,
          `Bearer ${newAccess}`
        );
        return new Response(JSON.stringify({ status: "OK", data: { speech_text: "refreshed" } }));
      }
      return new Response("not a MaxAI bundle", { status: 404 });
    },
  });

  const formData = new FormData();
  formData.set("model", "maxai/speech-to-text");
  formData.set("file", new Blob([WEBM_BYTES], { type: "audio/webm" }), "capture.webm");
  const response = await route.POST(
    new Request("http://localhost/v1/audio/transcriptions", { method: "POST", body: formData })
  );

  assert.equal(response.status, 200, await response.clone().text());
  assert.ok(sessions.length >= 2);
  assert.ok(sessions.every((session) => session === connectionId));
  const persisted = await providersDb.getProviderConnectionById(connectionId);
  const persistedData = persisted?.providerSpecificData as Record<string, unknown> | undefined;
  assert.equal(persisted?.apiKey, newAccess);
  assert.equal(persisted?.accessToken, newAccess);
  assert.equal(persistedData?.maxaiAccessToken, newAccess);
  assert.equal(persistedData?.maxaiRefreshToken, newRefresh);
});

test("MaxAI transcription transport fails cleanly when proxy resolution throws", async () => {
  let transcribeCalls = 0;
  const response = await route.runMaxaiTranscriptionTransport("selected-connection", {
    resolveProxy: async () => {
      throw new Error("database unavailable");
    },
    transcribe: async () => {
      transcribeCalls += 1;
      return new Response("unexpected");
    },
  });

  assert.equal(response.status, 502);
  assert.equal(transcribeCalls, 0);
  assert.match(await response.text(), /transport could not be resolved/);
});
