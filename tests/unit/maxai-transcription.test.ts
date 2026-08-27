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

// Firefox 150 records Ogg Opus but MaxAI wraps it as audio.webm/audio/webm.
const WEBM_BYTES = new Uint8Array([
  ...Buffer.from("OggS"),
  ...new Uint8Array(24),
  ...Buffer.from("OpusHead"),
]);

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

  const file = new Blob([WEBM_BYTES], { type: "audio/webm" }) as Blob & { name?: string };
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
  const audioFile = body.get("audio_file");
  assert.ok(audioFile instanceof Blob);
  assert.equal((audioFile as File).name, "audio.webm");
  assert.equal(audioFile.type, "audio/webm");
  assert.deepEqual(new Uint8Array(await audioFile.arrayBuffer()), WEBM_BYTES);
  assert.equal(body.get("feature_name"), "immersive_chat");
  assert.equal(body.get("prompt_name"), "Use microphone");
  assert.equal(body.get("event_source"), "web");
});

test("transcribeMaxaiAudio rejects incomplete credentials and failed upstream status", async () => {
  const file = new Blob([WEBM_BYTES], { type: "audio/webm" });
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

test("transcribeMaxaiAudio accepts WebM codec parameters and an empty-MIME .webm upload", async () => {
  const observed: FormData[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    observed.push(init?.body as FormData);
    return new Response(JSON.stringify({ status: "OK", data: { speech_text: "ok" } }));
  }) as unknown as typeof fetch;

  const withCodecs = new Blob([WEBM_BYTES], { type: "audio/webm; codecs=opus" }) as Blob & {
    name?: string;
  };
  withCodecs.name = "recording.webm";
  const emptyMime = new Blob([WEBM_BYTES]) as Blob & { name?: string };
  emptyMime.name = "recording.webm";

  assert.equal(
    (
      await transcribeMaxaiAudio({
        file: withCodecs,
        providerSpecificData: PROVIDER_SPECIFIC_DATA,
        fetchImpl,
      })
    ).ok,
    true
  );
  assert.equal(
    (
      await transcribeMaxaiAudio({
        file: emptyMime,
        providerSpecificData: PROVIDER_SPECIFIC_DATA,
        fetchImpl,
      })
    ).ok,
    true
  );
  assert.equal(observed.length, 2);
  assert.ok(observed.every((body) => body.get("audio_file") instanceof Blob));
});

test("transcribeMaxaiAudio rejects explicit non-WebM media before any fetch", async () => {
  let fetchCalls = 0;
  const explicitMp3 = new Blob([WEBM_BYTES], { type: "audio/mpeg" }) as Blob & { name?: string };
  explicitMp3.name = "misleading.webm";

  const result = await transcribeMaxaiAudio({
    file: explicitMp3,
    providerSpecificData: PROVIDER_SPECIFIC_DATA,
    fetchImpl: (async () => {
      fetchCalls += 1;
      throw new Error("must not fetch");
    }) as unknown as typeof fetch,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 415);
  assert.match(result.error ?? "", /WebM audio only/);
  assert.equal(fetchCalls, 0);
});

test("transcribeMaxaiAudio enforces the official client's 30 second timeout policy", async () => {
  let observedSignal: AbortSignal | null | undefined;
  const result = await transcribeMaxaiAudio({
    file: new Blob([WEBM_BYTES], { type: "audio/webm" }),
    providerSpecificData: PROVIDER_SPECIFIC_DATA,
    timeoutMs: 5,
    fetchImpl: (async (_url: string, init?: RequestInit) => {
      observedSignal = init?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }) as unknown as typeof fetch,
  });

  assert.equal(observedSignal?.aborted, true);
  assert.equal(result.ok, false);
  assert.equal(result.status, 504);
  assert.match(result.error ?? "", /timed out/i);
});

test("MaxAI is exposed through the OpenAI audio transcription facade", async () => {
  assert.deepEqual(AUDIO_TRANSCRIPTION_PROVIDERS.maxai.models, [
    { id: "speech-to-text", name: "MaxAI Speech to Text" },
  ]);
  assert.equal(AUDIO_TRANSCRIPTION_PROVIDERS.maxai.format, "maxai-stt");
  assert.deepEqual(AUDIO_TRANSCRIPTION_PROVIDERS.maxai.supportedFormats, ["webm"]);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ status: "OK", data: { speech_text: "The blue notebook." } }), {
      status: 200,
    })) as unknown as typeof fetch;
  try {
    const formData = new FormData();
    formData.set("model", "maxai/speech-to-text");
    formData.set("file", new Blob([WEBM_BYTES], { type: "audio/webm" }), "sample.webm");
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

test("transcribeMaxaiAudio rejects mislabeled bytes before any network call", async () => {
  let fetchCalls = 0;
  const file = new Blob(["not-webm"], { type: "audio/webm" }) as Blob & { name?: string };
  file.name = "fake.webm";
  const result = await transcribeMaxaiAudio({
    file,
    providerSpecificData: PROVIDER_SPECIFIC_DATA,
    fetchImpl: (async () => {
      fetchCalls += 1;
      throw new Error("must not fetch");
    }) as unknown as typeof fetch,
  });
  assert.equal(result.status, 415);
  assert.match(result.error ?? "", /WebM or captured Ogg Opus/);
  assert.equal(fetchCalls, 0);
});

test("transcribeMaxaiAudio rejects an Ogg stream without the captured Opus header", async () => {
  let fetchCalls = 0;
  const file = new Blob([Buffer.from("OggS"), new Uint8Array(128)], {
    type: "audio/webm",
  });
  const result = await transcribeMaxaiAudio({
    file,
    providerSpecificData: PROVIDER_SPECIFIC_DATA,
    fetchImpl: (async () => {
      fetchCalls += 1;
      throw new Error("must not fetch");
    }) as unknown as typeof fetch,
  });
  assert.equal(result.status, 415);
  assert.match(result.error ?? "", /captured Ogg Opus/);
  assert.equal(fetchCalls, 0);
});

test("transcribeMaxaiAudio refreshes, persists, and uses rotated MaxAI tokens", async () => {
  const refreshedAccess = "fresh-access-token";
  const rotatedRefresh = "rotated-refresh-token";
  const persisted: Array<Record<string, unknown>> = [];
  let transcriptionAuthorization = "";
  const result = await transcribeMaxaiAudio({
    file: new Blob([WEBM_BYTES], { type: "audio/webm" }),
    providerSpecificData: {
      ...PROVIDER_SPECIFIC_DATA,
      maxaiRefreshToken: "old-refresh-token",
    },
    refreshAccessToken: async () => ({
      ok: true,
      status: 200,
      accessToken: refreshedAccess,
      refreshToken: rotatedRefresh,
    }),
    onCredentialsRefreshed: async (credentials) => {
      persisted.push(credentials);
    },
    fetchImpl: (async (_url: string, init?: RequestInit) => {
      transcriptionAuthorization = (init?.headers as Record<string, string>).Authorization;
      return new Response(JSON.stringify({ status: "OK", data: { speech_text: "fresh" } }));
    }) as unknown as typeof fetch,
  });

  assert.equal(result.ok, true);
  assert.equal(transcriptionAuthorization, `Bearer ${refreshedAccess}`);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0]?.accessToken, refreshedAccess);
  assert.equal(
    (persisted[0]?.providerSpecificData as Record<string, unknown>).maxaiRefreshToken,
    rotatedRefresh
  );
});

test("transcribeMaxaiAudio shares one refresh across concurrent requests for a connection", async () => {
  let refreshCalls = 0;
  let releaseRefresh: (() => void) | undefined;
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  const refreshAccessToken = async () => {
    refreshCalls += 1;
    await refreshGate;
    return {
      ok: true as const,
      status: 200,
      accessToken: "shared-fresh-access",
      refreshToken: "shared-rotated-refresh",
    };
  };
  const authorizations: string[] = [];
  const run = () =>
    transcribeMaxaiAudio({
      file: new Blob([WEBM_BYTES], { type: "audio/webm" }),
      providerSpecificData: {
        ...PROVIDER_SPECIFIC_DATA,
        maxaiRefreshToken: "old-refresh-token",
      },
      refreshScope: "connection-1",
      refreshAccessToken,
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        authorizations.push((init?.headers as Record<string, string>).Authorization);
        return new Response(JSON.stringify({ status: "OK", data: { speech_text: "fresh" } }));
      }) as unknown as typeof fetch,
    });

  const first = run();
  const second = run();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(refreshCalls, 1);
  releaseRefresh?.();
  const results = await Promise.all([first, second]);
  assert.ok(results.every((result) => result.ok));
  assert.equal(refreshCalls, 1);
  assert.deepEqual(authorizations, ["Bearer shared-fresh-access", "Bearer shared-fresh-access"]);
});

test("transcribeMaxaiAudio maps MaxAI upstream 418 to public 401", async () => {
  const result = await transcribeMaxaiAudio({
    file: new Blob([WEBM_BYTES], { type: "audio/webm" }),
    providerSpecificData: PROVIDER_SPECIFIC_DATA,
    fetchImpl: (async () =>
      new Response("masked auth rejection", { status: 418 })) as unknown as typeof fetch,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
});
