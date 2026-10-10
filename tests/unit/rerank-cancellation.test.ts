import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-rerank-cancel-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "rerank-cancel-test-secret";
const previousNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = "test";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const readCache = await import("../../src/lib/db/readCache.ts");
const callLogs = await import("../../src/lib/usage/callLogs.ts");
const occupancy = await import("../../open-sse/services/accountRequestOccupancy.ts");
const rerankRoute = await import("../../src/app/api/v1/rerank/route.ts");

const LOCAL_NODE_ID = "rerank-cancel-local-node";
const originalFetch = globalThis.fetch;
let cloudConnectionId = "";
let localConnectionId = "";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitForStart(promise: Promise<void>, description: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${description} did not reach fetch`)), 5000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function request(model: string, signal: AbortSignal) {
  return new Request("http://localhost/v1/rerank", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, query: "find relevant", documents: ["first", "second"] }),
    signal,
  });
}

async function seedConnection(provider: string, name: string) {
  const connection = await providersDb.createProviderConnection({
    provider,
    authType: "apikey",
    name,
    apiKey: `${name}-key`,
    isActive: true,
    testStatus: "active",
    maxConcurrent: 1,
    providerSpecificData: { quotaPreflightEnabled: false },
  });
  return (connection as { id: string }).id;
}

test.before(async () => {
  await providersDb.createProviderNode({
    id: LOCAL_NODE_ID,
    type: "openai-compatible",
    name: "Rerank cancellation fixture",
    prefix: "rerank-cancel-local",
    apiType: "rerank",
    baseUrl: "http://127.0.0.1:8099/v1",
  });
  cloudConnectionId = await seedConnection("voyage", "rerank-cancel-cloud");
  localConnectionId = await seedConnection(LOCAL_NODE_ID, "rerank-cancel-local");
  readCache.invalidateDbCache("connections");
  readCache.invalidateDbCache("nodes");
});

test.beforeEach(() => {
  globalThis.fetch = originalFetch;
  occupancy._clearAccountRequestOccupancyForTest();
  readCache.invalidateDbCache("connections");
  readCache.invalidateDbCache("nodes");
});

test.after(async () => {
  globalThis.fetch = originalFetch;
  await callLogs.waitForCallLogSaves(5000);
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
});

test("cloud rerank propagates caller abort and releases selected account occupancy", async () => {
  const controller = new AbortController();
  const started = deferred<void>();
  let upstreamSignal: AbortSignal | undefined;
  globalThis.fetch = (async (_url: unknown, init: RequestInit = {}) => {
    upstreamSignal = init.signal as AbortSignal | undefined;
    assert.ok(upstreamSignal, "the caller signal reaches the cloud provider fetch");
    started.resolve();
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(upstreamSignal?.reason ?? new Error("aborted"));
      upstreamSignal?.addEventListener("abort", abort, { once: true });
      if (upstreamSignal?.aborted) abort();
    });
  }) as typeof fetch;

  const responsePromise = rerankRoute.POST(request("voyage/rerank-2", controller.signal));
  await waitForStart(started.promise, "cloud rerank");
  assert.equal(occupancy.getAccountRequestInFlightCount(cloudConnectionId), 1);

  controller.abort(new Error("synthetic client disconnect"));
  const response = await responsePromise;

  assert.equal(response.status, 499);
  assert.equal(upstreamSignal?.aborted, true);
  assert.equal(occupancy.getAccountRequestInFlightCount(cloudConnectionId), 0);
});

test("local rerank does not swallow a caller abort during the /rerank fallback", async () => {
  const controller = new AbortController();
  const fallbackStarted = deferred<void>();
  const urls: string[] = [];
  let upstreamSignal: AbortSignal | undefined;
  globalThis.fetch = (async (url: unknown, init: RequestInit = {}) => {
    urls.push(String(url));
    upstreamSignal = init.signal as AbortSignal | undefined;
    assert.ok(upstreamSignal, "the caller signal reaches the local provider fetch");
    if (urls.length === 1) return Response.json({ error: "use alternate path" }, { status: 404 });

    fallbackStarted.resolve();
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(upstreamSignal?.reason ?? new Error("aborted"));
      upstreamSignal?.addEventListener("abort", abort, { once: true });
      if (upstreamSignal?.aborted) abort();
    });
  }) as typeof fetch;

  const responsePromise = rerankRoute.POST(
    request("rerank-cancel-local/model-a", controller.signal)
  );
  await waitForStart(fallbackStarted.promise, "local rerank fallback");
  assert.equal(occupancy.getAccountRequestInFlightCount(localConnectionId), 1);

  controller.abort(new Error("synthetic client disconnect"));
  const response = await responsePromise;

  assert.equal(response.status, 499);
  assert.equal(urls.length, 2, "the alternate path is the only fallback attempt");
  assert.equal(upstreamSignal?.aborted, true);
  assert.equal(occupancy.getAccountRequestInFlightCount(localConnectionId), 0);
});

test("local rerank abort on the primary endpoint does not start a fallback request", async () => {
  const controller = new AbortController();
  const primaryStarted = deferred<void>();
  const urls: string[] = [];
  let upstreamSignal: AbortSignal | undefined;
  globalThis.fetch = (async (url: unknown, init: RequestInit = {}) => {
    urls.push(String(url));
    upstreamSignal = init.signal as AbortSignal | undefined;
    assert.ok(upstreamSignal, "the caller signal reaches the local provider fetch");
    primaryStarted.resolve();
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(upstreamSignal?.reason ?? new Error("aborted"));
      upstreamSignal?.addEventListener("abort", abort, { once: true });
      if (upstreamSignal?.aborted) abort();
    });
  }) as typeof fetch;

  const responsePromise = rerankRoute.POST(
    request("rerank-cancel-local/model-a", controller.signal)
  );
  await waitForStart(primaryStarted.promise, "local rerank primary");
  assert.equal(occupancy.getAccountRequestInFlightCount(localConnectionId), 1);

  controller.abort(new Error("synthetic client disconnect"));
  const response = await responsePromise;

  assert.equal(response.status, 499);
  assert.equal(urls.length, 1, "an aborted primary must not fall through to /rerank");
  assert.equal(upstreamSignal?.aborted, true);
  assert.equal(occupancy.getAccountRequestInFlightCount(localConnectionId), 0);
});
