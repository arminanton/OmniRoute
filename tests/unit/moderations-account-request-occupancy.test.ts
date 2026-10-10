import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-moderations-occupancy-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "moderations-occupancy-test-secret";
const previousSharedAdmission = process.env.OMNI_SHARED_ADMISSION;
process.env.OMNI_SHARED_ADMISSION = "false";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const readCache = await import("../../src/lib/db/readCache.ts");
const occupancy = await import("../../open-sse/services/accountRequestOccupancy.ts");
const { acquireConfiguredSharedAccountAdmission } =
  await import("../../open-sse/services/accountRequestAdmission.ts");
const moderationRoute = await import("../../src/app/api/v1/moderations/route.ts");

const originalFetch = globalThis.fetch;
let connectionId = "";

async function seedConnection() {
  const row = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "moderations-occupancy",
    apiKey: "moderations-occupancy-key",
    isActive: true,
    testStatus: "active",
    maxConcurrent: 1,
    providerSpecificData: { quotaPreflightEnabled: false },
  });
  readCache.invalidateDbCache("connections");
  return (row as { id: string }).id;
}

function requestWith(signal: AbortSignal) {
  return new Request("http://localhost/v1/moderations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: "check this text" }),
    signal,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test.before(async () => {
  connectionId = await seedConnection();
});

test.beforeEach(() => {
  occupancy._clearAccountRequestOccupancyForTest();
  globalThis.fetch = originalFetch;
  readCache.invalidateDbCache("connections");
});

test.after(async () => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (previousSharedAdmission === undefined) delete process.env.OMNI_SHARED_ADMISSION;
  else process.env.OMNI_SHARED_ADMISSION = previousSharedAdmission;
});

test("moderation holds local and shared account slots until an aborted upstream call settles", async () => {
  const previousShared = process.env.OMNI_SHARED_ADMISSION;
  const previousDatabase = process.env.OMNI_COORDINATION_DB;
  const previousUnhealthy = process.env.OMNI_COORDINATION_UNHEALTHY;
  globalThis.__omniSharedCoordinator?.close();
  globalThis.__omniSharedCoordinator = undefined;
  delete process.env.OMNI_COORDINATION_UNHEALTHY;
  process.env.OMNI_SHARED_ADMISSION = "true";
  process.env.OMNI_COORDINATION_DB = path.join(TEST_DATA_DIR, "coordination.sqlite");
  try {
    const controller = new AbortController();
    const started = deferred<void>();
    let upstreamSignal: AbortSignal | undefined;
    globalThis.fetch = (async (_url: unknown, init: RequestInit = {}) => {
      assert.equal(occupancy.getAccountRequestInFlightCount(connectionId), 1);
      upstreamSignal = init.signal as AbortSignal | undefined;
      assert.ok(upstreamSignal, "the caller signal reaches the provider fetch");
      started.resolve();
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(upstreamSignal?.reason ?? new Error("aborted"));
        upstreamSignal?.addEventListener("abort", abort, { once: true });
        if (upstreamSignal?.aborted) abort();
      });
    }) as typeof fetch;

    const responsePromise = moderationRoute.POST(requestWith(controller.signal));
    await started.promise;
    assert.equal(occupancy.getAccountRequestInFlightCount(connectionId), 1);

    let secondAdmitted = false;
    const secondLeasePromise = acquireConfiguredSharedAccountAdmission({
      provider: "openai",
      credentials: {
        connectionId,
        maxConcurrent: 1,
        providerSpecificData: { quotaPreflightEnabled: false },
      },
    }).then((lease) => {
      secondAdmitted = true;
      return lease;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(secondAdmitted, false, "the second request waits for the first account lease");

    controller.abort(new Error("synthetic client disconnect"));
    const response = await responsePromise;
    const secondLease = await secondLeasePromise;

    assert.equal(response.status, 499);
    assert.equal(upstreamSignal?.aborted, true);
    assert.equal(occupancy.getAccountRequestInFlightCount(connectionId), 0);
    assert.equal(secondAdmitted, true, "cancellation releases the shared account lease");
    secondLease?.release();
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
});
