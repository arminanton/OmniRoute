/** Captured c303fca645/801fb15757 protocol, adapted to local-next safety boundaries. */
import test from "node:test";
import assert from "node:assert/strict";
import { transcribeMaxaiAudio, MAXAI_STT_PATH } from "../../open-sse/executors/maxai/transcription.ts";
import { __setMaxaiConstantsForTest } from "../../open-sse/executors/maxai/constantsStore.ts";
import { MOCK_CONSTANTS } from "./helpers/maxaiMockConstants.ts";
import { RuntimePolicyError } from "../../src/shared/runtimePolicy.ts";
import { getTranscriptionProvider, parseTranscriptionModel, AUDIO_SPEECH_PROVIDERS, UC_TTS_POLICY_DISABLED, getAllAudioModels } from "../../open-sse/config/audioRegistry.ts";

const token = `synthetic.${Buffer.from(JSON.stringify({ sub: "user", exp: 4102444800 })).toString("base64url")}.signature`;
const webm = () => new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0])], { type: "audio/webm" });
const base = () => ({
  connectionId: "selected-account",
  accessToken: token,
  providerSpecificData: { maxaiDeviceId: "device", maxaiUserId: "user" },
  file: webm(),
});
test.beforeEach(() => __setMaxaiConstantsForTest(MOCK_CONSTANTS));
test.after(() => __setMaxaiConstantsForTest(null));

test("captured signed multipart has exact audio fields and no JSON content type", async () => {
  let calls = 0;
  const result = await transcribeMaxaiAudio({ ...base(), fetchImpl: async (url, init) => {
    calls++;
    assert.equal(String(url), "https://api.maxai.me" + MAXAI_STT_PATH);
    assert.equal(init?.redirect, "error");
    assert.equal(init?.method, "POST");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), `Bearer ${token}`);
    assert.ok(headers.get("x-authorization"));
    assert.equal(headers.has("content-type"), false);
    const body = init?.body as FormData;
    const audio = body.get("audio_file") as File;
    assert.equal(audio.name, "audio.webm");
    assert.equal(audio.type, "audio/webm");
    assert.equal(body.get("feature_name"), "immersive_chat");
    assert.equal(body.get("prompt_name"), "Use microphone");
    assert.equal(body.get("event_source"), "web");
    return Response.json({ status: "OK", data: { speech_text: "captured text" } });
  } });
  assert.deepEqual(result, { ok: true, status: 200, text: "captured text" });
  assert.equal(calls, 1);
});

test("captured Ogg Opus is accepted only under captured WebM presentation", async () => {
  const file = new Blob(["OggS", new Uint8Array(24), "OpusHead"], { type: "audio/webm" });
  const result = await transcribeMaxaiAudio({ ...base(), file,
    fetchImpl: async () => Response.json({ status: "OK", data: { speech_text: "" } }) });
  assert.equal(result.ok, true);
});

test("missing account, invalid media and expired bearer never dispatch", async () => {
  const wire: typeof fetch = async () => { throw new Error("must not dispatch"); };
  assert.equal((await transcribeMaxaiAudio({ ...base(), connectionId: "", fetchImpl: wire })).status, 400);
  assert.equal((await transcribeMaxaiAudio({ ...base(), file: new Blob(["bad"], { type: "audio/wav" }), fetchImpl: wire })).status, 415);
  assert.equal((await transcribeMaxaiAudio({ ...base(), file: new Blob(["fake webm"], { type: "audio/webm" }), fetchImpl: wire })).status, 415);
  assert.equal((await transcribeMaxaiAudio({ ...base(), accessToken: "expired", fetchImpl: wire })).status, 401);
});

test("errors and invalid upstream shape never disclose provider secrets", async () => {
  for (const response of [new Response("SECRET at /private/file", { status: 418 }),
    Response.json({ status: "NO", detail: "SECRET at /private/file" }),
    Response.json({ status: "OK", data: {} }), Response.json(null)]) {
    const result = await transcribeMaxaiAudio({ ...base(), fetchImpl: async () => response });
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.error ?? "", /SECRET|at \/private/);
  }
});

test("caller cancellation and timeout settle even when the wire ignores abort", async () => {
  const controller = new AbortController();
  const result = await transcribeMaxaiAudio({ ...base(), signal: controller.signal,
    fetchImpl: async () => { controller.abort("SECRET"); return new Promise(() => {}); } });
  assert.equal(result.status, 499);
  assert.doesNotMatch(result.error ?? "", /SECRET/);
  const timed = await transcribeMaxaiAudio({ ...base(), timeoutMs: 5,
    fetchImpl: async () => new Promise(() => {}) });
  assert.equal(timed.status, 504);
});

test("policy errors remain terminal and retain identity", async () => {
  const denied = new RuntimePolicyError("proxy-forbidden");
  await assert.rejects(transcribeMaxaiAudio({ ...base(), fetchImpl: async () => { throw denied; } }),
    (error) => error === denied);
});

test("registry exposes MaxAI STT only and keeps UC speech disabled", () => {
  assert.equal(getTranscriptionProvider("maxai")?.format, "maxai-stt");
  assert.equal(parseTranscriptionModel("mx/speech-to-text").provider, "maxai");
  assert.equal(UC_TTS_POLICY_DISABLED, true);
  assert.ok(AUDIO_SPEECH_PROVIDERS.uc, "explicit UC speech requests retain their policy error");
  assert.equal(getAllAudioModels().some((model) => model.id === "uc/jade"), false);
  assert.equal(AUDIO_SPEECH_PROVIDERS.maxai, undefined);
});
