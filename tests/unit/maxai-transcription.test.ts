import test from "node:test";
import assert from "node:assert/strict";

import { AUDIO_TRANSCRIPTION_PROVIDERS } from "../../open-sse/config/audioRegistry.ts";
import { handleAudioTranscription } from "../../open-sse/handlers/audioTranscription.ts";
import {
  MAXAI_STT_PATH,
  transcribeMaxaiAudio,
} from "../../open-sse/executors/maxai/transcription.ts";
import { __setMaxaiConstantsForTest } from "../../open-sse/executors/maxai/constantsStore.ts";
import { MOCK_CONSTANTS } from "./helpers/maxaiMockConstants.ts";

__setMaxaiConstantsForTest(MOCK_CONSTANTS);

const PROVIDER_SPECIFIC_DATA = {
  maxaiAccessToken: "access-token",
  maxaiDeviceId: "22222222-2222-4222-8222-222222222222",
  maxaiUserId: "11111111-1111-4111-8111-111111111111",
};

test("transcribeMaxaiAudio sends the captured multipart fields and signed headers", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedInit = init;
    return new Response(JSON.stringify({ status: "OK", data: { speech_text: "blue notebook" } }), {
      status: 200,
    });
  }) as unknown as typeof fetch;

  const file = new Blob(["audio"], { type: "audio/webm" }) as Blob & { name?: string };
  file.name = "sample.webm";
  const result = await transcribeMaxaiAudio({
    file,
    providerSpecificData: PROVIDER_SPECIFIC_DATA,
    fetchImpl,
  });

  assert.equal(result.ok, true);
  assert.equal(result.text, "blue notebook");
  assert.ok(capturedUrl.endsWith(MAXAI_STT_PATH));
  assert.equal(capturedInit?.method, "POST");
  const headers = capturedInit?.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer access-token");
  assert.ok(headers["X-Authorization"]);
  assert.equal(headers["Content-Type"], undefined);

  const body = capturedInit?.body as FormData;
  assert.ok(body.get("audio_file") instanceof Blob);
  assert.equal(body.get("feature_name"), "immersive_chat");
  assert.equal(body.get("prompt_name"), "Use microphone");
  assert.equal(body.get("event_source"), "web");
});

test("transcribeMaxaiAudio rejects incomplete credentials and failed upstream status", async () => {
  const file = new Blob(["audio"], { type: "audio/webm" });
  const missing = await transcribeMaxaiAudio({ file, providerSpecificData: {} });
  assert.equal(missing.status, 401);

  const failed = await transcribeMaxaiAudio({
    file,
    providerSpecificData: PROVIDER_SPECIFIC_DATA,
    fetchImpl: (async () =>
      new Response(JSON.stringify({ status: "ERROR", detail: "audio rejected" }), {
        status: 200,
      })) as unknown as typeof fetch,
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.status, 502);
  assert.match(failed.error ?? "", /audio rejected/);
});

test("MaxAI is exposed through the OpenAI audio transcription facade", async () => {
  assert.deepEqual(AUDIO_TRANSCRIPTION_PROVIDERS.maxai.models, [
    { id: "speech-to-text", name: "MaxAI Speech to Text" },
  ]);
  assert.equal(AUDIO_TRANSCRIPTION_PROVIDERS.maxai.format, "maxai-stt");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ status: "OK", data: { speech_text: "The blue notebook." } }), {
      status: 200,
    })) as unknown as typeof fetch;
  try {
    const formData = new FormData();
    formData.set("model", "maxai/speech-to-text");
    formData.set("file", new Blob(["audio"], { type: "audio/webm" }), "sample.webm");
    const response = await handleAudioTranscription({
      formData,
      credentials: {
        accessToken: "access-token",
        providerSpecificData: PROVIDER_SPECIFIC_DATA,
      },
      resolvedProvider: AUDIO_TRANSCRIPTION_PROVIDERS.maxai,
      resolvedModel: "speech-to-text",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { text: "The blue notebook." });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
