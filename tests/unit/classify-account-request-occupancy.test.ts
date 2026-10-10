import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-classify-occupancy-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "classify-occupancy-test-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const readCache = await import("../../src/lib/db/readCache.ts");
const callLogs = await import("../../src/lib/usage/callLogs.ts");
const occupancy = await import("../../open-sse/services/accountRequestOccupancy.ts");
const classifyRoute = await import("../../src/app/api/v1/classify/route.ts");

const originalFetch = globalThis.fetch;
let connectionId = "";

async function seedConnection() {
  const row = await providersDb.createProviderConnection({
    provider: "jina-ai",
    authType: "apikey",
    name: "classify-occupancy",
    apiKey: "classify-occupancy-key",
    isActive: true,
    testStatus: "active",
    maxConcurrent: 1,
    providerSpecificData: { quotaPreflightEnabled: false },
  });
  readCache.invalidateDbCache("connections");
  return (row as { id: string }).id;
}

function classifyRequest(signal?: AbortSignal) {
  return new Request("http://localhost/v1/classify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: ["A small test sentence."], labels: ["test", "other"] }),
    ...(signal ? { signal } : {}),
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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
  await callLogs.waitForCallLogSaves(5000);
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("classify reserves the selected account through upstream completion", async () => {
  const started = deferred<void>();
  const upstream = deferred<Response>();
  globalThis.fetch = (async (_url: unknown, init: RequestInit = {}) => {
    assert.equal(occupancy.getAccountRequestInFlightCount(connectionId), 1);
    assert.ok(init.signal, "the request signal reaches the upstream fetch");
    started.resolve();
    return upstream.promise;
  }) as typeof fetch;

  const responsePromise = classifyRoute.POST(classifyRequest());
  await started.promise;
  assert.equal(occupancy.getAccountRequestInFlightCount(connectionId), 1);

  upstream.resolve(Response.json({ data: [{ label: "test", score: 0.99 }] }));
  const response = await responsePromise;
  assert.equal(response.status, 200);
  assert.equal(occupancy.getAccountRequestInFlightCount(connectionId), 0);
});

test("classify releases its account reservation after an upstream failure", async () => {
  const started = deferred<void>();
  const upstream = deferred<Response>();
  globalThis.fetch = (async () => {
    assert.equal(occupancy.getAccountRequestInFlightCount(connectionId), 1);
    started.resolve();
    return upstream.promise;
  }) as typeof fetch;

  const responsePromise = classifyRoute.POST(classifyRequest());
  await started.promise;
  assert.equal(occupancy.getAccountRequestInFlightCount(connectionId), 1);

  upstream.reject(new Error("synthetic upstream transport failure"));
  const response = await responsePromise;
  assert.equal(response.status, 500);
  assert.equal(occupancy.getAccountRequestInFlightCount(connectionId), 0);
});

test("classify aborts upstream work and releases occupancy on client cancellation", async () => {
  const caller = new AbortController();
  const started = deferred<void>();
  let upstreamSignal: AbortSignal | undefined;
  globalThis.fetch = (async (_url: unknown, init: RequestInit = {}) => {
    upstreamSignal = init.signal as AbortSignal | undefined;
    assert.equal(occupancy.getAccountRequestInFlightCount(connectionId), 1);
    started.resolve();
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(upstreamSignal?.reason ?? new Error("aborted"));
      upstreamSignal?.addEventListener("abort", abort, { once: true });
      if (upstreamSignal?.aborted) abort();
    });
  }) as typeof fetch;

  const responsePromise = classifyRoute.POST(classifyRequest(caller.signal));
  await started.promise;
  assert.equal(occupancy.getAccountRequestInFlightCount(connectionId), 1);
  assert.ok(upstreamSignal);

  caller.abort(new Error("synthetic client disconnect"));
  const response = await responsePromise;
  assert.equal(response.status, 499);
  assert.equal(upstreamSignal.aborted, true);
  assert.equal(occupancy.getAccountRequestInFlightCount(connectionId), 0);
});
