/**
 * Tests for speech combo strategy execution
 *
 * Mirrors tests/unit/combo/image-combo.test.ts. executeSpeechCombo takes no
 * logger argument — the speech handler returns a Response directly rather than
 * a result object, so there is nothing for the strategy to log through.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-speech-combo-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.JWT_SECRET = "test-jwt-secret-for-speech-combo-tests";

fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

const core = await import("@/lib/db/core.ts");
const { createCombo } = await import("@/lib/db/combos");
const { createProviderConnection } = await import("@/lib/db/providers");
const { executeSpeechCombo } = await import("@omniroute/open-sse/services/speechCombo");
const { acquireConfiguredSharedAccountAdmission } =
  await import("@omniroute/open-sse/services/accountRequestAdmission.ts");

async function cleanupTestDataDir() {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      core.resetDbInstance();
      fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      return;
    } catch (error: unknown) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (lastError) throw lastError;
}

async function withSharedAdmission(databasePath: string, run: () => Promise<void>) {
  const previousShared = process.env.OMNI_SHARED_ADMISSION;
  const previousDatabase = process.env.OMNI_COORDINATION_DB;
  const previousUnhealthy = process.env.OMNI_COORDINATION_UNHEALTHY;
  globalThis.__omniSharedCoordinator?.close();
  globalThis.__omniSharedCoordinator = undefined;
  delete process.env.OMNI_COORDINATION_UNHEALTHY;
  process.env.OMNI_SHARED_ADMISSION = "true";
  process.env.OMNI_COORDINATION_DB = databasePath;
  try {
    await run();
  } finally {
    globalThis.__omniSharedCoordinator?.close();
    globalThis.__omniSharedCoordinator = undefined;
    if (previousShared === undefined) delete process.env.OMNI_SHARED_ADMISSION;
    else process.env.OMNI_SHARED_ADMISSION = previousShared;
    if (previousDatabase === undefined) delete process.env.OMNI_COORDINATION_DB;
    else process.env.OMNI_COORDINATION_DB = previousDatabase;
    if (previousUnhealthy === undefined) delete process.env.OMNI_COORDINATION_UNHEALTHY;
    else process.env.OMNI_COORDINATION_UNHEALTHY = previousUnhealthy;
  }
}

test.beforeEach(async () => {
  await cleanupTestDataDir();
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

test.after(async () => {
  process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  await cleanupTestDataDir();
});

test("returns 400 when combo is not found", async () => {
  const response = await executeSpeechCombo(
    "nonexistent-combo",
    { model: "nonexistent-combo", input: "hello there" },
    Date.now()
  );
  assert.equal(response.status, 400);
  const bodyStr = JSON.stringify(await response.json());
  assert.ok(!bodyStr.includes("at "), "Error response does not leak stack traces");
});

test("returns 400 when combo has no speech-capable targets", async () => {
  await createCombo({
    name: "chat-only-combo",
    strategy: "priority",
    models: ["openai/gpt-4o"],
  });

  const response = await executeSpeechCombo(
    "chat-only-combo",
    { model: "chat-only-combo", input: "hello there" },
    Date.now()
  );
  assert.equal(response.status, 400);
  const bodyStr = JSON.stringify(await response.json());
  assert.ok(bodyStr.includes("No speech-capable targets"), "Tells user no speech targets");
  assert.ok(!bodyStr.includes("at "), "Error response does not leak stack traces");
});

test("does not select retired EdgeTTS targets as speech-capable", async () => {
  await createCombo({
    name: "retired-edgetts-combo",
    strategy: "priority",
    models: ["edgetts/en-US-AriaNeural"],
  });

  const response = await executeSpeechCombo(
    "retired-edgetts-combo",
    { model: "retired-edgetts-combo", input: " " },
    Date.now()
  );
  const bodyStr = JSON.stringify(await response.json());

  assert.equal(response.status, 400);
  assert.ok(bodyStr.includes("No speech-capable targets"));
  assert.ok(!bodyStr.includes("at "), "Error response does not leak stack traces");
});

test("returns 400 when combo has no usable targets", async () => {
  await createCombo({ name: "empty-combo", strategy: "priority", models: [] });

  const response = await executeSpeechCombo(
    "empty-combo",
    { model: "empty-combo", input: "hello there" },
    Date.now()
  );
  assert.equal(response.status, 400);
});

test("fails cleanly when speech targets exist but no provider connection does", async () => {
  await createCombo({
    name: "spc-no-conn",
    strategy: "fill-first",
    models: ["deepgram/aura-asteria-en"],
  });

  const response = await executeSpeechCombo(
    "spc-no-conn",
    { model: "spc-no-conn", input: "hello there" },
    Date.now()
  );
  assert.ok(response.status >= 400, "Surfaces a failure rather than a fake success");
  const bodyStr = JSON.stringify(await response.json());
  assert.ok(!bodyStr.includes("at "), "Error response does not leak stack traces");
});

test("shared speech combo lease spans the successful audio stream and releases on cancel", async () => {
  const connection = await createProviderConnection({
    provider: "openai",
    authType: "apikey",
    apiKey: "combo-speech-key",
    name: "speech-combo-shared-admission",
    isActive: true,
    testStatus: "active",
    maxConcurrent: 1,
    providerSpecificData: {},
  });
  await createCombo({
    name: "speech-shared-admission",
    strategy: "priority",
    models: ["openai/tts-1"],
  });

  await withSharedAdmission(path.join(TEST_DATA_DIR, "coordination-speech.sqlite"), async () => {
    const originalFetch = globalThis.fetch;
    let upstreamCancelled = false;
    let upstreamSignal: AbortSignal | undefined;
    globalThis.fetch = async (_url, init = {}) => {
      upstreamSignal = init.signal as AbortSignal | undefined;
      return new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            upstreamCancelled = true;
          },
        }),
        { headers: { "content-type": "audio/mpeg" } }
      );
    };

    try {
      const response = await executeSpeechCombo(
        "speech-shared-admission",
        { model: "speech-shared-admission", input: "hello" },
        Date.now()
      );
      assert.equal(response.status, 200);
      assert.ok(upstreamSignal, "combo target passes its shared lease signal to TTS");

      let nextAcquired = false;
      const next = acquireConfiguredSharedAccountAdmission({
        provider: "openai",
        credentials: { connectionId: connection.id, maxConcurrent: 1, providerSpecificData: {} },
      }).then((lease) => {
        nextAcquired = true;
        return lease;
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(nextAcquired, false, "combo holds its account slot while audio is unread");

      await response.body!.cancel("downstream cancelled");
      const lease = await next;
      assert.equal(upstreamCancelled, true);
      lease?.release();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("combo caller abort stops fallback after the first provider attempt", async () => {
  await createProviderConnection({
    provider: "openai",
    authType: "apikey",
    apiKey: "combo-speech-abort-key",
    name: "speech-combo-abort",
    isActive: true,
    testStatus: "active",
    maxConcurrent: 1,
    providerSpecificData: {},
  });
  await createCombo({
    name: "speech-abort-fallback",
    strategy: "priority",
    models: ["openai/tts-1", "deepgram/aura-asteria-en"],
  });

  await withSharedAdmission(path.join(TEST_DATA_DIR, "coordination-abort.sqlite"), async () => {
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    let calls = 0;
    let startRequest!: () => void;
    const started = new Promise<void>((resolve) => (startRequest = resolve));
    globalThis.fetch = async (_url, init = {}) => {
      calls++;
      const signal = init.signal as AbortSignal;
      startRequest();
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(signal.reason ?? new Error("aborted"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    };

    try {
      const responsePromise = executeSpeechCombo(
        "speech-abort-fallback",
        { model: "speech-abort-fallback", input: "hello" },
        Date.now(),
        controller.signal
      );
      await started;
      controller.abort(new Error("synthetic client abort"));
      const response = await responsePromise;
      assert.equal(response.status, 499);
      assert.equal(calls, 1, "the fallback provider must not be dispatched after abort");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("combo stops fallback when shared coordinator admission is unavailable", async () => {
  await createProviderConnection({
    provider: "openai",
    authType: "apikey",
    apiKey: "combo-speech-coordinator-key",
    name: "speech-combo-coordinator-failure",
    isActive: true,
    testStatus: "active",
    maxConcurrent: 1,
    providerSpecificData: {},
  });
  await createCombo({
    name: "speech-coordinator-fallback",
    strategy: "priority",
    models: ["openai/tts-1", "deepgram/aura-asteria-en"],
  });

  await withSharedAdmission(
    path.join(TEST_DATA_DIR, "missing-directory", "coordination.sqlite"),
    async () => {
      const originalFetch = globalThis.fetch;
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        return new Response(new Uint8Array([1]), { headers: { "content-type": "audio/mpeg" } });
      };
      try {
        const response = await executeSpeechCombo(
          "speech-coordinator-fallback",
          { model: "speech-coordinator-fallback", input: "hello" },
          Date.now()
        );
        assert.equal(response.status, 503);
        assert.equal(calls, 0, "coordinator failure must fail closed before provider dispatch");
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  );
});
