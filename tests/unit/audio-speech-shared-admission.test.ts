import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleAudioSpeech } from "../../open-sse/handlers/audioSpeech.ts";
import { releaseAccountRequestAfterResponseBody } from "../../open-sse/services/accountRequestLease.ts";
import { acquireConfiguredSharedAccountAdmission } from "../../open-sse/services/accountRequestAdmission.ts";

async function sharedFixture(run: () => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "omni-speech-admission-"));
  const previousShared = process.env.OMNI_SHARED_ADMISSION;
  const previousDb = process.env.OMNI_COORDINATION_DB;
  const originalFetch = globalThis.fetch;
  globalThis.__omniSharedCoordinator?.close();
  globalThis.__omniSharedCoordinator = undefined;
  process.env.OMNI_SHARED_ADMISSION = "true";
  process.env.OMNI_COORDINATION_DB = join(directory, "coordination.sqlite");
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__omniSharedCoordinator?.close();
    globalThis.__omniSharedCoordinator = undefined;
    if (previousShared === undefined) delete process.env.OMNI_SHARED_ADMISSION;
    else process.env.OMNI_SHARED_ADMISSION = previousShared;
    if (previousDb === undefined) delete process.env.OMNI_COORDINATION_DB;
    else process.env.OMNI_COORDINATION_DB = previousDb;
    rmSync(directory, { recursive: true, force: true });
  }
}

const credentials = {
  connectionId: "speech-account",
  maxConcurrent: 1,
  apiKey: "test-key",
  providerSpecificData: {},
};
const provider = {
  id: "openai",
  format: "openai-compatible",
  authType: "apikey",
  authHeader: "bearer",
  baseUrl: "https://speech.invalid/v1/audio/speech",
};

async function startSpeech(signal: AbortSignal) {
  return handleAudioSpeech({
    body: { model: "openai/tts-1", input: "test speech" },
    credentials,
    resolvedProvider: provider,
    resolvedModel: "tts-1",
    signal,
  });
}

test("TTS shared permit remains owned until the audio stream is cancelled", async () => {
  await sharedFixture(async () => {
    let upstreamCancelled = false;
    let fetchSignal: AbortSignal | undefined;
    globalThis.fetch = async (_url, init = {}) => {
      fetchSignal = init.signal as AbortSignal | undefined;
      return new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            upstreamCancelled = true;
          },
        }),
        { headers: { "content-type": "audio/mpeg" } }
      );
    };

    const first = await acquireConfiguredSharedAccountAdmission({
      provider: "openai",
      credentials,
    });
    assert.ok(first);
    const upstreamResponse = await startSpeech(first.signal);
    assert.equal(fetchSignal, first.signal, "lease fence must reach the upstream fetch");
    const response = releaseAccountRequestAfterResponseBody(upstreamResponse, first.release);

    let secondAcquired = false;
    const second = acquireConfiguredSharedAccountAdmission({
      provider: "openai",
      credentials,
    }).then((lease) => {
      secondAcquired = true;
      return lease;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(secondAcquired, false, "the account slot must remain held while audio is unread");

    await response.body!.cancel("downstream cancelled");
    const next = await second;
    assert.equal(upstreamCancelled, true, "downstream cancellation must cancel the upstream body");
    next?.release();
  });
});

test("TTS shared permit releases only after the audio stream reaches EOF", async () => {
  await sharedFixture(async () => {
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
            controller.close();
          },
        }),
        { headers: { "content-type": "audio/mpeg" } }
      );

    const first = await acquireConfiguredSharedAccountAdmission({
      provider: "openai",
      credentials,
    });
    assert.ok(first);
    const upstreamResponse = await startSpeech(first.signal);
    const response = releaseAccountRequestAfterResponseBody(upstreamResponse, first.release);
    let secondAcquired = false;
    const second = acquireConfiguredSharedAccountAdmission({
      provider: "openai",
      credentials,
    }).then((lease) => {
      secondAcquired = true;
      return lease;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(secondAcquired, false, "the cap remains held until the client drains the stream");

    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3]);
    const next = await second;
    assert.equal(secondAcquired, true);
    next?.release();
  });
});

test("TTS request cancellation aborts provider fetch and releases after stream failure", async () => {
  await sharedFixture(async () => {
    const caller = new AbortController();
    let fetchSignal: AbortSignal | undefined;
    globalThis.fetch = async (_url, init = {}) => {
      fetchSignal = init.signal as AbortSignal | undefined;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            fetchSignal?.addEventListener("abort", () => controller.error(fetchSignal?.reason), {
              once: true,
            });
          },
        }),
        { headers: { "content-type": "audio/mpeg" } }
      );
    };

    const first = await acquireConfiguredSharedAccountAdmission({
      provider: "openai",
      credentials,
      signal: caller.signal,
    });
    assert.ok(first);
    const upstreamResponse = await startSpeech(first.signal);
    const response = releaseAccountRequestAfterResponseBody(upstreamResponse, first.release);
    const read = response.body!.getReader().read();

    caller.abort(new Error("client disconnected"));
    assert.equal(fetchSignal?.aborted, true, "request abort must reach provider fetch signal");
    await assert.rejects(read, /client disconnected/);

    const next = await acquireConfiguredSharedAccountAdmission({
      provider: "openai",
      credentials,
    });
    next?.release();
  });
});
