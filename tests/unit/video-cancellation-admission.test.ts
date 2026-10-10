import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-video-admission-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "video-admission-test-secret";
process.env.JWT_SECRET = process.env.JWT_SECRET || "video-admission-jwt-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const modelsDb = await import("../../src/lib/db/models.ts");
const combosDb = await import("../../src/lib/db/combos.ts");
const readCache = await import("../../src/lib/db/readCache.ts");
const callLogs = await import("../../src/lib/usage/callLogs.ts");
const occupancy = await import("../../open-sse/services/accountRequestOccupancy.ts");
const admission = await import("../../open-sse/services/accountRequestAdmission.ts");
const videoRoute = await import("../../src/app/api/v1/videos/generations/route.ts");
const { handleOpenAIVideoGeneration } =
  await import("../../open-sse/handlers/videoGeneration/openai.ts");
const { handleDeepinfraVideoGeneration } =
  await import("../../open-sse/handlers/videoGeneration/deepinfraHandler.ts");
const { handleVideoGeneration } = await import("../../open-sse/handlers/videoGeneration.ts");

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
let directConnectionId = "";
let acceptedJobConnectionId = "";

async function seedConnection(
  provider: string,
  name: string,
  baseUrl: string,
  maxConcurrent?: number
) {
  const row = await providersDb.createProviderConnection({
    provider,
    authType: "apikey",
    name,
    apiKey: `${name}-key`,
    isActive: true,
    testStatus: "active",
    maxConcurrent,
    providerSpecificData: { baseUrl, quotaPreflightEnabled: false },
  });
  readCache.invalidateDbCache("connections");
  return (row as { id: string }).id;
}

function postVideo(model: string, signal?: AbortSignal) {
  return new Request("http://localhost/v1/videos/generations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, prompt: "a small paper boat" }),
    ...(signal ? { signal } : {}),
  });
}

function immediateVideoPolls(
  callback: (...args: unknown[]) => void,
  ms?: number,
  ...args: unknown[]
) {
  if (ms === 2_000) return originalSetTimeout(callback as TimerHandler, 0, ...args);
  return originalSetTimeout(callback as TimerHandler, ms, ...args);
}

async function withSharedAdmission(run: () => Promise<void>) {
  const previousShared = process.env.OMNI_SHARED_ADMISSION;
  const previousDatabase = process.env.OMNI_COORDINATION_DB;
  const previousUnhealthy = process.env.OMNI_COORDINATION_UNHEALTHY;
  globalThis.__omniSharedCoordinator?.close();
  globalThis.__omniSharedCoordinator = undefined;
  delete process.env.OMNI_COORDINATION_UNHEALTHY;
  process.env.OMNI_SHARED_ADMISSION = "true";
  process.env.OMNI_COORDINATION_DB = path.join(TEST_DATA_DIR, "video-coordination.sqlite");
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

test.before(async () => {
  await modelsDb.addCustomModel(
    "video-direct-provider",
    "direct-v1",
    "Direct video",
    "manual",
    "chat-completions",
    ["videos"]
  );
  directConnectionId = await seedConnection(
    "video-direct-provider",
    "video-direct",
    "https://video-direct.example/v1/videos/generations",
    1
  );

  await modelsDb.addCustomModel(
    "video-accepted-job-provider",
    "job-v1",
    "Async video job",
    "manual",
    "chat-completions",
    ["videos"],
    undefined,
    {},
    undefined,
    { preset: "agnes-video-job" }
  );
  await modelsDb.addCustomModel(
    "video-fallback-provider",
    "fallback-v1",
    "Fallback video",
    "manual",
    "chat-completions",
    ["videos"]
  );
  acceptedJobConnectionId = await seedConnection(
    "video-accepted-job-provider",
    "video-accepted-job",
    "https://video-job.example"
  );
  await seedConnection(
    "video-fallback-provider",
    "video-fallback",
    "https://video-fallback.example/v1/videos/generations"
  );
});

test.beforeEach(() => {
  occupancy._clearAccountRequestOccupancyForTest();
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  readCache.invalidateDbCache("connections");
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
});

test.after(async () => {
  globalThis.__omniSharedCoordinator?.close();
  globalThis.__omniSharedCoordinator = undefined;
  await callLogs.waitForCallLogSaves(5000);
  core.closeDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("direct video aborts caller transport, returns 499, and releases local/shared occupancy", async () => {
  await withSharedAdmission(async () => {
    const controller = new AbortController();
    let providerSignal: AbortSignal | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => (markStarted = resolve));

    globalThis.fetch = (async (_url: unknown, init: RequestInit = {}) => {
      assert.equal(occupancy.getAccountRequestInFlightCount(directConnectionId), 1);
      providerSignal = init.signal as AbortSignal | undefined;
      markStarted();
      return new Promise<Response>((_resolve, reject) => {
        const onAbort = () => {
          const error = new Error("upstream request aborted");
          error.name = "AbortError";
          reject(error);
        };
        providerSignal?.addEventListener("abort", onAbort, { once: true });
        if (providerSignal?.aborted) onAbort();
      });
    }) as typeof fetch;

    const responsePromise = videoRoute.POST(
      postVideo("video-direct-provider/direct-v1", controller.signal)
    );
    await started;
    assert.ok(providerSignal, "the direct provider fetch receives a cancellation signal");

    let nextAcquired = false;
    const nextPromise = admission
      .acquireConfiguredSharedAccountAdmission({
        provider: "video-direct-provider",
        credentials: {
          provider: "video-direct-provider",
          connectionId: directConnectionId,
          maxConcurrent: 1,
          providerSpecificData: { quotaPreflightEnabled: false },
        },
      })
      .then((lease) => {
        nextAcquired = true;
        return lease;
      });
    await new Promise((resolve) => originalSetTimeout(resolve, 25));
    assert.equal(nextAcquired, false, "the configured account cap stays held during the fetch");

    controller.abort(new Error("synthetic client disconnect"));
    const response = await responsePromise;
    assert.equal(response.status, 499);
    assert.equal(providerSignal.aborted, true);
    assert.equal(occupancy.getAccountRequestInFlightCount(directConnectionId), 0);
    const nextLease = await nextPromise;
    assert.equal(nextAcquired, true, "caller cancellation releases the shared account slot");
    nextLease?.release();
  });
});

test("direct video distinguishes shared lease loss from caller cancellation", async () => {
  const caller = new AbortController();
  const lease = new AbortController();
  globalThis.fetch = (async (_url: unknown, init: RequestInit = {}) => {
    return new Promise<Response>((_resolve, reject) => {
      const activeSignal = init.signal as AbortSignal;
      activeSignal.addEventListener(
        "abort",
        () => {
          const error = new Error("lease lost");
          error.name = "AbortError";
          reject(error);
        },
        { once: true }
      );
    });
  }) as typeof fetch;

  const resultPromise = handleOpenAIVideoGeneration({
    model: "direct-v1",
    provider: "video-direct-provider",
    providerConfig: {
      baseUrl: "https://video-direct.example/v1/videos/generations",
      authHeader: "bearer",
    },
    body: { model: "video-direct-provider/direct-v1", prompt: "a small paper boat" },
    credentials: { apiKey: "test", baseUrl: "https://video-direct.example/v1" },
    signal: lease.signal,
    callerSignal: caller.signal,
    admissionSignal: lease.signal,
  });
  await new Promise((resolve) => originalSetTimeout(resolve, 0));
  lease.abort(new Error("shared lease lost"));

  const result = (await resultPromise) as {
    success: boolean;
    status: number;
    terminal?: boolean;
  };
  assert.equal(result.success, false);
  assert.equal(result.status, 503);
  assert.equal(result.terminal, true);
});

test("DeepInfra and SD WebUI direct video fetches return 503 on shared lease loss", async () => {
  const executeCases: Array<(signal: AbortSignal, callerSignal: AbortSignal) => Promise<unknown>> =
    [
      (signal, callerSignal) =>
        handleDeepinfraVideoGeneration({
          model: "Wan-AI/Wan2.2-T2V-A14B",
          provider: "deepinfra",
          providerConfig: { baseUrl: "https://api.deepinfra.example/v1/inference" },
          body: { prompt: "a test video" },
          credentials: { apiKey: "deepinfra-test" },
          signal,
          callerSignal,
          admissionSignal: signal,
        }),
      (signal, callerSignal) =>
        handleVideoGeneration({
          body: { model: "sdwebui/animatediff-webui", prompt: "a test video" },
          credentials: {},
          signal,
          callerSignal,
          admissionSignal: signal,
        }),
    ];

  for (const execute of executeCases) {
    const caller = new AbortController();
    const lease = new AbortController();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => (markStarted = resolve));
    let providerSignal: AbortSignal | undefined;
    globalThis.fetch = (async (_url: unknown, init: RequestInit = {}) => {
      providerSignal = init.signal as AbortSignal | undefined;
      markStarted();
      return new Promise<Response>((_resolve, reject) => {
        const onAbort = () => {
          const error = new Error("shared lease lost");
          error.name = "AbortError";
          reject(error);
        };
        providerSignal?.addEventListener("abort", onAbort, { once: true });
        if (providerSignal?.aborted) onAbort();
      });
    }) as typeof fetch;

    const resultPromise = execute(lease.signal, caller.signal);
    await started;
    assert.ok(providerSignal, "the direct provider fetch receives the lease signal");
    lease.abort(new Error("shared lease lost"));

    const result = (await resultPromise) as {
      success: boolean;
      status: number;
      terminal?: boolean;
    };
    assert.equal(result.success, false);
    assert.equal(result.status, 503);
    assert.equal(result.terminal, true);
    assert.equal(providerSignal.aborted, true);
  }
});

test("accepted async video job retains occupancy and does not submit combo fallback on uncertain poll", async () => {
  globalThis.setTimeout = immediateVideoPolls as typeof setTimeout;
  await combosDb.createCombo({
    name: "video-uncertain-accepted-job",
    strategy: "priority",
    config: { maxRetries: 0, retryDelayMs: 0, fallbackDelayMs: 0 },
    models: ["video-accepted-job-provider/job-v1", "video-fallback-provider/fallback-v1"],
  });

  const controller = new AbortController();
  const calls: string[] = [];
  globalThis.fetch = (async (url: unknown) => {
    const target = String(url);
    calls.push(target);
    if (target === "https://video-job.example/v1/videos") {
      assert.equal(occupancy.getAccountRequestInFlightCount(acceptedJobConnectionId), 1);
      // The provider accepted the job. A caller disconnect cannot cancel it.
      // Defer disconnect until after fetchJson has consumed the successful
      // submit body and obtained the job id; a synchronous abort here would
      // model an ambiguous submit response instead.
      originalSetTimeout(() => {
        controller.abort(new Error("caller disconnected after acceptance"));
      }, 0);
      return Response.json({ video_id: "accepted-video-job" });
    }
    if (target === "https://video-job.example/agnesapi?video_id=accepted-video-job") {
      assert.equal(occupancy.getAccountRequestInFlightCount(acceptedJobConnectionId), 1);
      return Response.json({ error: "status service unavailable" }, { status: 500 });
    }
    if (target.startsWith("https://video-fallback.example/")) {
      throw new Error("an uncertain accepted job must not dispatch another provider");
    }
    throw new Error(`unexpected fake upstream: ${target}`);
  }) as typeof fetch;

  const response = await videoRoute.POST(
    postVideo("video-uncertain-accepted-job", controller.signal)
  );

  // The accepted provider task is still polled after disconnect. Once the
  // observation fails, report the caller cancellation while keeping the
  // outcome terminal so combo cannot replay the accepted request.
  assert.equal(response.status, 499);
  assert.deepEqual(calls, [
    "https://video-job.example/v1/videos",
    "https://video-job.example/agnesapi?video_id=accepted-video-job",
  ]);
  assert.equal(occupancy.getAccountRequestInFlightCount(acceptedJobConnectionId), 0);
  assert.equal(
    globalThis.__omniSharedCoordinator,
    undefined,
    "accepted asynchronous video jobs are not treated as cancellable shared leases"
  );
});
