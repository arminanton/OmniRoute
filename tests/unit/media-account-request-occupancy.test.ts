import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-media-occupancy-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "media-occupancy-test-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const modelsDb = await import("../../src/lib/db/models.ts");
const combosDb = await import("../../src/lib/db/combos.ts");
const readCache = await import("../../src/lib/db/readCache.ts");
const callLogs = await import("../../src/lib/usage/callLogs.ts");
const occupancy = await import("../../open-sse/services/accountRequestOccupancy.ts");
const transcriptionsRoute = await import("../../src/app/api/v1/audio/transcriptions/route.ts");
const translationsRoute = await import("../../src/app/api/v1/audio/translations/route.ts");
const speechRoute = await import("../../src/app/api/v1/audio/speech/route.ts");
const musicRoute = await import("../../src/app/api/v1/music/generations/route.ts");
const videoRoute = await import("../../src/app/api/v1/videos/generations/route.ts");

const originalFetch = globalThis.fetch;
let audioConnectionId = "";
let musicConnectionId = "";
let videoConnectionId = "";

async function seedConnection(provider: string, name: string, providerSpecificData = {}) {
  const row = await providersDb.createProviderConnection({
    provider,
    authType: "apikey",
    name,
    apiKey: `${name}-key`,
    isActive: true,
    testStatus: "active",
    providerSpecificData: { quotaPreflightEnabled: false, ...providerSpecificData },
  });
  readCache.invalidateDbCache("connections");
  return (row as { id: string }).id;
}

function postJson(url: string, body: unknown, signal?: AbortSignal) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

function transcriptionRequest(model: string) {
  const form = new FormData();
  form.set("model", model);
  form.set("file", new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" }), "clip.wav");
  return new Request("http://localhost/v1/audio/transcriptions", { method: "POST", body: form });
}

test.before(async () => {
  audioConnectionId = await seedConnection("openai", "media-audio");
  musicConnectionId = await seedConnection("minimax", "media-music");
  await modelsDb.addCustomModel(
    "media-video-provider",
    "video-v1",
    "Video v1",
    "manual",
    "chat-completions",
    ["videos"]
  );
  videoConnectionId = await seedConnection("media-video-provider", "media-video", {
    baseUrl: "https://media-video.example/v1/videos/generations",
  });
});

test.beforeEach(() => {
  occupancy._clearAccountRequestOccupancyForTest();
  globalThis.fetch = originalFetch;
  readCache.invalidateDbCache("connections");
});

test.after(async () => {
  globalThis.fetch = originalFetch;
  await callLogs.waitForCallLogSaves(5000);
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("transcription and translation reserve through upstream completion and release on errors", async () => {
  globalThis.fetch = (async (_url: unknown) => {
    assert.equal(occupancy.getAccountRequestInFlightCount(audioConnectionId), 1);
    return new Response(JSON.stringify({ text: "recognized" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const transcription = await transcriptionsRoute.POST(transcriptionRequest("openai/whisper-1"));
  assert.equal(transcription.status, 200);
  assert.equal(occupancy.getAccountRequestInFlightCount(audioConnectionId), 0);

  const translationForm = new FormData();
  translationForm.set("model", "openai/whisper-1");
  translationForm.set("file", new Blob([new Uint8Array([4, 5, 6])]), "clip.wav");
  const translation = await translationsRoute.POST(
    new Request("http://localhost/v1/audio/translations", { method: "POST", body: translationForm })
  );
  assert.equal(translation.status, 200);
  assert.equal(occupancy.getAccountRequestInFlightCount(audioConnectionId), 0);

  globalThis.fetch = (async () => {
    assert.equal(occupancy.getAccountRequestInFlightCount(audioConnectionId), 1);
    throw new Error("synthetic upstream transport failure");
  }) as typeof fetch;
  const failed = await transcriptionsRoute.POST(transcriptionRequest("openai/whisper-1"));
  assert.equal(failed.status, 500);
  assert.equal(occupancy.getAccountRequestInFlightCount(audioConnectionId), 0);
});

test("speech holds its reservation until the audio stream ends or is cancelled", async () => {
  let upstreamCancelled = false;
  globalThis.fetch = (async () => {
    assert.equal(occupancy.getAccountRequestInFlightCount(audioConnectionId), 1);
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
        },
        cancel() {
          upstreamCancelled = true;
        },
      }),
      { status: 200, headers: { "content-type": "audio/mpeg" } }
    );
  }) as typeof fetch;

  const response = await speechRoute.POST(
    postJson("http://localhost/v1/audio/speech", {
      model: "openai/tts-1",
      input: "stream cancellation test",
    })
  );
  assert.equal(response.status, 200);
  assert.equal(occupancy.getAccountRequestInFlightCount(audioConnectionId), 1);
  await response.body?.cancel("test client disconnected");
  assert.equal(upstreamCancelled, true);
  assert.equal(occupancy.getAccountRequestInFlightCount(audioConnectionId), 0);

  globalThis.fetch = (async () => {
    assert.equal(occupancy.getAccountRequestInFlightCount(audioConnectionId), 1);
    return new Response(new Uint8Array([7, 8, 9]), {
      status: 200,
      headers: { "content-type": "audio/mpeg" },
    });
  }) as typeof fetch;
  const completed = await speechRoute.POST(
    postJson("http://localhost/v1/audio/speech", {
      model: "openai/tts-1",
      input: "stream completion test",
    })
  );
  assert.equal(occupancy.getAccountRequestInFlightCount(audioConnectionId), 1);
  assert.deepEqual([...new Uint8Array(await completed.arrayBuffer())], [7, 8, 9]);
  assert.equal(occupancy.getAccountRequestInFlightCount(audioConnectionId), 0);
});

test("music and video reserve while their upstream generation handlers run", async () => {
  globalThis.fetch = (async () => {
    assert.equal(occupancy.getAccountRequestInFlightCount(musicConnectionId), 1);
    return new Response(
      JSON.stringify({
        data: { status: 2, audio: "https://media.example/generated.mp3" },
        base_resp: { status_code: 0 },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const music = await musicRoute.POST(
    postJson("http://localhost/v1/music/generations", {
      model: "minimax/music-3.0",
      prompt: "a short synth loop",
    })
  );
  assert.equal(music.status, 200);
  assert.equal(occupancy.getAccountRequestInFlightCount(musicConnectionId), 0);

  globalThis.fetch = (async () => {
    assert.equal(occupancy.getAccountRequestInFlightCount(musicConnectionId), 1);
    return new Response(JSON.stringify({ error: { message: "music upstream unavailable" } }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const failedMusic = await musicRoute.POST(
    postJson("http://localhost/v1/music/generations", {
      model: "minimax/music-3.0",
      prompt: "a failed synth loop",
    })
  );
  assert.equal(failedMusic.status, 503);
  assert.equal(occupancy.getAccountRequestInFlightCount(musicConnectionId), 0);

  globalThis.fetch = (async (_url: unknown) => {
    assert.equal(occupancy.getAccountRequestInFlightCount(videoConnectionId), 1);
    return new Response(
      JSON.stringify({ created: 1, data: [{ url: "https://media.example/generated.mp4" }] }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const video = await videoRoute.POST(
    postJson("http://localhost/v1/videos/generations", {
      model: "media-video-provider/video-v1",
      prompt: "a short orbit shot",
    })
  );
  assert.equal(video.status, 200);
  assert.equal(occupancy.getAccountRequestInFlightCount(videoConnectionId), 0);

  globalThis.fetch = (async () => {
    assert.equal(occupancy.getAccountRequestInFlightCount(videoConnectionId), 1);
    return new Response(JSON.stringify({ error: { message: "video upstream unavailable" } }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const failedVideo = await videoRoute.POST(
    postJson("http://localhost/v1/videos/generations", {
      model: "media-video-provider/video-v1",
      prompt: "a failed orbit shot",
    })
  );
  assert.equal(failedVideo.status, 503);
  assert.equal(occupancy.getAccountRequestInFlightCount(videoConnectionId), 0);
});

test("speech and video combo targets reserve their selected account through execution", async () => {
  await combosDb.createCombo({
    name: "media-speech-combo",
    strategy: "priority",
    models: ["openai/tts-1"],
  });
  globalThis.fetch = (async () => {
    assert.equal(occupancy.getAccountRequestInFlightCount(audioConnectionId), 1);
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "audio/mpeg" },
    });
  }) as typeof fetch;

  const speech = await speechRoute.POST(
    postJson("http://localhost/v1/audio/speech", {
      model: "media-speech-combo",
      input: "combo stream",
    })
  );
  assert.equal(speech.status, 200);
  assert.equal(occupancy.getAccountRequestInFlightCount(audioConnectionId), 1);
  await speech.arrayBuffer();
  assert.equal(occupancy.getAccountRequestInFlightCount(audioConnectionId), 0);

  await combosDb.createCombo({
    name: "media-video-combo",
    strategy: "priority",
    models: ["media-video-provider/video-v1"],
  });
  globalThis.fetch = (async () => {
    assert.equal(occupancy.getAccountRequestInFlightCount(videoConnectionId), 1);
    return new Response(
      JSON.stringify({ created: 1, data: [{ url: "https://media.example/combo.mp4" }] }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const video = await videoRoute.POST(
    postJson("http://localhost/v1/videos/generations", {
      model: "media-video-combo",
      prompt: "a short orbit shot",
    })
  );
  assert.equal(video.status, 200);
  assert.equal(occupancy.getAccountRequestInFlightCount(videoConnectionId), 0);
});

test("invalid media requests return before reserving an account", async () => {
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches++;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  const missingPrompt = await musicRoute.POST(
    postJson("http://localhost/v1/music/generations", { model: "minimax/music-3.0" })
  );
  assert.equal(missingPrompt.status, 400);
  assert.equal(fetches, 0);
  assert.equal(occupancy.getAccountRequestInFlightCount(musicConnectionId), 0);

  const invalidModel = await transcriptionsRoute.POST(transcriptionRequest("not-a-model"));
  assert.equal(invalidModel.status, 400);
  assert.equal(fetches, 0);
  assert.equal(occupancy.getAccountRequestInFlightCount(audioConnectionId), 0);
});
