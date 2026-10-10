import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-music-admission-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "music-admission-test-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const readCache = await import("../../src/lib/db/readCache.ts");
const callLogs = await import("../../src/lib/usage/callLogs.ts");
const occupancy = await import("../../open-sse/services/accountRequestOccupancy.ts");
const musicRoute = await import("../../src/app/api/v1/music/generations/route.ts");

const originalFetch = globalThis.fetch;
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;
let minimaxConnectionId = "";
let kieConnectionId = "";

async function seedConnection(provider: string, name: string, maxConcurrent = 1) {
  const row = await providersDb.createProviderConnection({
    provider,
    authType: "apikey",
    name,
    apiKey: `${name}-key`,
    isActive: true,
    testStatus: "active",
    maxConcurrent,
    providerSpecificData: { quotaPreflightEnabled: false },
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

function configureSharedAdmissionFixture() {
  const priorEnabled = process.env.OMNI_SHARED_ADMISSION;
  const priorDb = process.env.OMNI_COORDINATION_DB;
  const priorUnhealthy = process.env.OMNI_COORDINATION_UNHEALTHY;
  const runtime = globalThis as any;
  const priorCoordinator = runtime.__omniSharedCoordinator;
  const stats = { releases: 0, renewals: 0, cancellations: 0 };
  let heartbeat: (() => void) | null = null;
  let leaseLost = false;
  const lease = { musicTestLease: true };

  process.env.OMNI_SHARED_ADMISSION = "true";
  process.env.OMNI_COORDINATION_DB = path.join(TEST_DATA_DIR, "music-coordination.sqlite");
  delete process.env.OMNI_COORDINATION_UNHEALTHY;
  runtime.__omniSharedCoordinator = {
    enqueue: () => "music-test-admission-request",
    tryAcquire: () => lease,
    renew: () => {
      stats.renewals++;
      return !leaseLost;
    },
    release: () => {
      stats.releases++;
    },
    cancel: () => {
      stats.cancellations++;
    },
  };
  globalThis.setInterval = ((callback: () => void) => {
    heartbeat = callback;
    return { unref() {} } as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;

  return {
    stats,
    loseLease() {
      assert.ok(heartbeat, "shared account lease heartbeat should be active");
      leaseLost = true;
      heartbeat();
    },
    restore() {
      if (priorEnabled === undefined) delete process.env.OMNI_SHARED_ADMISSION;
      else process.env.OMNI_SHARED_ADMISSION = priorEnabled;
      if (priorDb === undefined) delete process.env.OMNI_COORDINATION_DB;
      else process.env.OMNI_COORDINATION_DB = priorDb;
      if (priorUnhealthy === undefined) delete process.env.OMNI_COORDINATION_UNHEALTHY;
      else process.env.OMNI_COORDINATION_UNHEALTHY = priorUnhealthy;
      runtime.__omniSharedCoordinator = priorCoordinator;
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    },
  };
}

test.before(async () => {
  minimaxConnectionId = await seedConnection("minimax", "music-minimax-admission");
  kieConnectionId = await seedConnection("kie", "music-kie-admission");
});

test.beforeEach(() => {
  occupancy._clearAccountRequestOccupancyForTest();
  globalThis.fetch = originalFetch;
  readCache.invalidateDbCache("connections");
});

test.after(async () => {
  globalThis.fetch = originalFetch;
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
  await callLogs.waitForCallLogSaves(5000);
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function assertMinimaxCancellation(kind: "caller" | "lease-loss") {
  const fixture = configureSharedAdmissionFixture();
  const caller = new AbortController();
  let announceUpstream!: (signal: AbortSignal) => void;
  const upstreamStarted = new Promise<AbortSignal>((resolve) => (announceUpstream = resolve));
  let upstreamCalls = 0;
  globalThis.fetch = (async (_url: unknown, init: RequestInit = {}) => {
    upstreamCalls++;
    assert.equal(occupancy.getAccountRequestInFlightCount(minimaxConnectionId), 1);
    const upstreamSignal = init.signal as AbortSignal;
    announceUpstream(upstreamSignal);
    return new Promise<Response>((_resolve, reject) => {
      const abort = () =>
        reject(upstreamSignal.reason ?? new DOMException("Aborted", "AbortError"));
      if (upstreamSignal.aborted) abort();
      else upstreamSignal.addEventListener("abort", abort, { once: true });
    });
  }) as typeof fetch;

  // Keep a fixture regression from leaving the fake upstream promise pending
  // forever if a lease-loss callback is not wired correctly.
  const watchdog = setTimeout(
    () => caller.abort(new Error("music admission test watchdog")),
    10_000
  );
  try {
    const responsePromise = musicRoute.POST(
      postJson(
        "http://localhost/v1/music/generations",
        { model: "minimax/music-3.0", prompt: "a cancellation test" },
        caller.signal
      )
    );
    const upstreamSignal = await upstreamStarted;
    if (kind === "caller") caller.abort(new Error("synthetic client disconnect"));
    else fixture.loseLease();

    const response = await responsePromise;
    assert.equal(response.status, kind === "caller" ? 499 : 503);
    assert.equal(upstreamSignal.aborted, true);
    assert.equal(upstreamCalls, 1, "a cancellation must not retry or dispatch to another provider");
    assert.equal(occupancy.getAccountRequestInFlightCount(minimaxConnectionId), 0);
    if (kind === "caller") {
      assert.equal(fixture.stats.releases, 1, "caller cancellation releases the shared slot");
    } else {
      assert.equal(fixture.stats.renewals, 1);
      assert.equal(
        fixture.stats.releases,
        0,
        "a lost shared lease remains fenced until its durable TTL expires"
      );
    }
  } finally {
    clearTimeout(watchdog);
    caller.abort();
    globalThis.fetch = originalFetch;
    fixture.restore();
  }
}

test("music returns 499 for a caller abort and does not retry", async () => {
  await assertMinimaxCancellation("caller");
});

test("music returns 503 for shared lease loss and does not retry", async () => {
  await assertMinimaxCancellation("lease-loss");
});

test("music fails closed with 503 when shared admission is unavailable", async () => {
  const priorEnabled = process.env.OMNI_SHARED_ADMISSION;
  const priorDb = process.env.OMNI_COORDINATION_DB;
  const priorUnhealthy = process.env.OMNI_COORDINATION_UNHEALTHY;
  process.env.OMNI_SHARED_ADMISSION = "true";
  process.env.OMNI_COORDINATION_DB = path.join(TEST_DATA_DIR, "music-unhealthy.sqlite");
  process.env.OMNI_COORDINATION_UNHEALTHY = "true";
  let upstreamCalls = 0;
  globalThis.fetch = (async () => {
    upstreamCalls++;
    return Response.json({ data: { status: 2, audio: "https://example.test/track.mp3" } });
  }) as typeof fetch;

  try {
    const response = await musicRoute.POST(
      postJson("http://localhost/v1/music/generations", {
        model: "minimax/music-3.0",
        prompt: "must not dispatch",
      })
    );
    assert.equal(response.status, 503);
    assert.equal(upstreamCalls, 0);
    assert.equal(occupancy.getAccountRequestInFlightCount(minimaxConnectionId), 0);
  } finally {
    if (priorEnabled === undefined) delete process.env.OMNI_SHARED_ADMISSION;
    else process.env.OMNI_SHARED_ADMISSION = priorEnabled;
    if (priorDb === undefined) delete process.env.OMNI_COORDINATION_DB;
    else process.env.OMNI_COORDINATION_DB = priorDb;
    if (priorUnhealthy === undefined) delete process.env.OMNI_COORDINATION_UNHEALTHY;
    else process.env.OMNI_COORDINATION_UNHEALTHY = priorUnhealthy;
    globalThis.fetch = originalFetch;
  }
});

async function assertAcceptedKieTaskSettles(kind: "caller" | "lease-loss") {
  const fixture = configureSharedAdmissionFixture();
  const caller = new AbortController();
  let creates = 0;
  let polls = 0;
  globalThis.fetch = (async (url: unknown, init: RequestInit = {}) => {
    const upstreamUrl = String(url);
    assert.equal(occupancy.getAccountRequestInFlightCount(kieConnectionId), 1);
    if (upstreamUrl === "https://api.kie.ai/api/v1/generate") {
      creates++;
      if (kind === "caller") caller.abort(new Error("client disconnected after remote acceptance"));
      else fixture.loseLease();
      return Response.json({ code: 200, data: { taskId: "accepted-music-task" } });
    }
    if (upstreamUrl.startsWith("https://api.kie.ai/api/v1/generate/record-info")) {
      polls++;
      const pollSignal = init.signal as AbortSignal | undefined;
      assert.equal(
        pollSignal,
        undefined,
        "accepted task polling must continue after caller disconnect or lease loss"
      );
      return Response.json({
        code: 200,
        data: {
          status: "SUCCESS",
          response: { sunoData: [{ audioUrl: "https://example.test/accepted.mp3" }] },
        },
      });
    }
    throw new Error(`Unexpected music upstream URL: ${upstreamUrl}`);
  }) as typeof fetch;

  try {
    const response = await musicRoute.POST(
      postJson(
        "http://localhost/v1/music/generations",
        { model: "kie/suno-v4.0", prompt: "accepted asynchronous task", poll_interval_ms: 1 },
        caller.signal
      )
    );
    assert.equal(
      response.status,
      kind === "caller" ? 499 : 503,
      "report cancellation/lease loss only after the accepted remote task settles"
    );
    assert.equal(creates, 1, "the accepted generation must never be resubmitted");
    assert.equal(polls, 1, "the task must be polled to a terminal state before releasing capacity");
    assert.equal(occupancy.getAccountRequestInFlightCount(kieConnectionId), 0);
    assert.equal(
      fixture.stats.releases,
      kind === "caller" ? 1 : 0,
      "release a valid shared lease after settle; a lost lease remains TTL-fenced"
    );
  } finally {
    caller.abort();
    globalThis.fetch = originalFetch;
    fixture.restore();
  }
}

test("accepted KIE music jobs keep capacity through polling after client abort", async () => {
  await assertAcceptedKieTaskSettles("caller");
});

test("accepted KIE music jobs keep local occupancy through polling after lease loss", async () => {
  await assertAcceptedKieTaskSettles("lease-loss");
});
