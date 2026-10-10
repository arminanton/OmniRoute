import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-ocr-occupancy-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "ocr-occupancy-test-secret";
const previousSharedAdmission = process.env.OMNI_SHARED_ADMISSION;
process.env.OMNI_SHARED_ADMISSION = "false";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const readCache = await import("../../src/lib/db/readCache.ts");
const occupancy = await import("../../open-sse/services/accountRequestOccupancy.ts");
const ocrRoute = await import("../../src/app/api/v1/ocr/route.ts");
const { getProviderConnectionById } = providersDb;

const originalFetch = globalThis.fetch;
let connectionId = "";
let azureConnectionId = "";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function configureSharedAdmissionFixture() {
  const previousDb = process.env.OMNI_COORDINATION_DB;
  const previousUnhealthy = process.env.OMNI_COORDINATION_UNHEALTHY;
  const runtime = globalThis as typeof globalThis & { __omniSharedCoordinator?: unknown };
  const previousCoordinator = runtime.__omniSharedCoordinator;
  const previousSetInterval = globalThis.setInterval;
  const previousClearInterval = globalThis.clearInterval;
  const stats = { releases: 0, renewals: 0, cancellations: 0 };
  let heartbeat: (() => void) | null = null;
  let lost = false;
  const lease = { id: "ocr-shared-test-lease" };

  process.env.OMNI_SHARED_ADMISSION = "true";
  process.env.OMNI_COORDINATION_DB = "ocr-shared-admission-test.sqlite";
  delete process.env.OMNI_COORDINATION_UNHEALTHY;
  runtime.__omniSharedCoordinator = {
    enqueue: () => "ocr-shared-admission-test-request",
    tryAcquire: () => lease,
    renew: () => {
      stats.renewals++;
      return !lost;
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
      assert.ok(heartbeat, "the shared account lease heartbeat should be active");
      lost = true;
      heartbeat();
    },
    restore() {
      if (previousDb === undefined) delete process.env.OMNI_COORDINATION_DB;
      else process.env.OMNI_COORDINATION_DB = previousDb;
      if (previousUnhealthy === undefined) delete process.env.OMNI_COORDINATION_UNHEALTHY;
      else process.env.OMNI_COORDINATION_UNHEALTHY = previousUnhealthy;
      runtime.__omniSharedCoordinator = previousCoordinator;
      globalThis.setInterval = previousSetInterval;
      globalThis.clearInterval = previousClearInterval;
      process.env.OMNI_SHARED_ADMISSION = "false";
    },
  };
}

function ocrRequest(signal?: AbortSignal, model = "mistral/mistral-ocr-latest") {
  return new Request("http://localhost/v1/ocr", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      document: { type: "document_url", document_url: "https://example.com/sample.pdf" },
    }),
    signal,
  });
}

test.before(async () => {
  const connection = await providersDb.createProviderConnection({
    provider: "mistral",
    authType: "apikey",
    name: "ocr-occupancy",
    apiKey: "ocr-occupancy-key",
    isActive: true,
    testStatus: "active",
    maxConcurrent: 1,
    providerSpecificData: { quotaPreflightEnabled: false },
  });
  connectionId = (connection as { id: string }).id;

  const azureConnection = await providersDb.createProviderConnection({
    provider: "azure-document-intelligence",
    authType: "apikey",
    name: "ocr-azure-occupancy",
    apiKey: "ocr-azure-occupancy-key",
    isActive: true,
    testStatus: "active",
    maxConcurrent: 1,
    providerSpecificData: {
      baseUrl: "https://ocr-azure.example.test",
      quotaPreflightEnabled: false,
    },
  });
  azureConnectionId = (azureConnection as { id: string }).id;
  readCache.invalidateDbCache("connections");
});

test.beforeEach(() => {
  globalThis.fetch = originalFetch;
  occupancy._clearAccountRequestOccupancyForTest();
  readCache.invalidateDbCache("connections");
});

test.after(() => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (previousSharedAdmission === undefined) delete process.env.OMNI_SHARED_ADMISSION;
  else process.env.OMNI_SHARED_ADMISSION = previousSharedAdmission;
});

test("OCR keeps the selected account occupied through upstream completion", async () => {
  const started = deferred<void>();
  const upstream = deferred<Response>();
  globalThis.fetch = (async () => {
    assert.equal(occupancy.getAccountRequestInFlightCount(connectionId), 1);
    started.resolve();
    return upstream.promise;
  }) as typeof fetch;

  const responsePromise = ocrRoute.POST(ocrRequest());
  await started.promise;
  assert.equal(occupancy.getAccountRequestInFlightCount(connectionId), 1);

  upstream.resolve(Response.json({ pages: [{ index: 0, markdown: "recognized" }] }));
  const response = await responsePromise;
  assert.equal(response.status, 200);
  assert.equal(occupancy.getAccountRequestInFlightCount(connectionId), 0);
});

test("OCR releases selected account occupancy after an upstream failure", async () => {
  const started = deferred<void>();
  const upstream = deferred<Response>();
  globalThis.fetch = (async () => {
    assert.equal(occupancy.getAccountRequestInFlightCount(connectionId), 1);
    started.resolve();
    return upstream.promise;
  }) as typeof fetch;

  const responsePromise = ocrRoute.POST(ocrRequest());
  await started.promise;
  assert.equal(occupancy.getAccountRequestInFlightCount(connectionId), 1);

  upstream.resolve(new Response('{"error":"busy"}', { status: 503 }));
  const response = await responsePromise;
  assert.equal(response.status, 503);
  assert.equal(occupancy.getAccountRequestInFlightCount(connectionId), 0);
});

test("cancelled synchronous Mistral OCR aborts upstream and releases its account slot", async () => {
  const controller = new AbortController();
  const started = deferred<AbortSignal | null | undefined>();
  globalThis.fetch = (async (_url, init = {}) => {
    assert.equal(occupancy.getAccountRequestInFlightCount(connectionId), 1);
    started.resolve(init.signal);
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("The operation was aborted", "AbortError")),
        { once: true }
      );
    });
  }) as typeof fetch;

  const responsePromise = ocrRoute.POST(ocrRequest(controller.signal));
  const upstreamSignal = await started.promise;
  assert.ok(upstreamSignal, "the synchronous provider fetch receives a cancellation signal");
  assert.equal(upstreamSignal.aborted, false);
  controller.abort();

  const response = await responsePromise;
  assert.equal(response.status, 499);
  assert.equal(occupancy.getAccountRequestInFlightCount(connectionId), 0);
});

test("shared OCR admission returns 499 for caller abort and releases both account reservations", async () => {
  const fixture = configureSharedAdmissionFixture();
  const controller = new AbortController();
  const started = deferred<AbortSignal>();
  globalThis.fetch = (async (_url, init = {}) => {
    assert.equal(occupancy.getAccountRequestInFlightCount(connectionId), 1);
    const signal = init.signal as AbortSignal;
    started.resolve(signal);
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  }) as typeof fetch;

  try {
    const responsePromise = ocrRoute.POST(ocrRequest(controller.signal));
    const upstreamSignal = await started.promise;
    controller.abort(new Error("synthetic client disconnect"));
    const response = await responsePromise;

    assert.equal(response.status, 499);
    assert.equal(upstreamSignal.aborted, true);
    assert.equal(fixture.stats.releases, 1, "caller cancellation releases the shared lease");
    assert.equal(fixture.stats.cancellations, 1);
    assert.equal(occupancy.getAccountRequestInFlightCount(connectionId), 0);
  } finally {
    controller.abort();
    fixture.restore();
  }
});

test("shared OCR lease loss returns terminal 503 without fallback or provider cooldown", async () => {
  const fixture = configureSharedAdmissionFixture();
  const started = deferred<AbortSignal>();
  let upstreamCalls = 0;
  globalThis.fetch = (async (_url, init = {}) => {
    upstreamCalls++;
    assert.equal(occupancy.getAccountRequestInFlightCount(connectionId), 1);
    const signal = init.signal as AbortSignal;
    started.resolve(signal);
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  }) as typeof fetch;

  try {
    const responsePromise = ocrRoute.POST(ocrRequest());
    const upstreamSignal = await started.promise;
    fixture.loseLease();
    const response = await responsePromise;

    assert.equal(response.status, 503);
    assert.equal(upstreamSignal.aborted, true);
    assert.equal(upstreamCalls, 1, "lease loss must not dispatch a fallback request");
    assert.equal(fixture.stats.renewals, 1);
    assert.equal(fixture.stats.releases, 0, "a lost lease remains fenced until its TTL");
    assert.equal(fixture.stats.cancellations, 1);
    assert.equal(occupancy.getAccountRequestInFlightCount(connectionId), 0);
    assert.equal((await getProviderConnectionById(connectionId))?.testStatus, "active");
  } finally {
    fixture.restore();
  }

  // A later request can still use the same connection; admission loss is not a
  // provider failure and must not set a provider cooldown or account health flag.
  globalThis.fetch = (async () =>
    Response.json({ pages: [{ index: 0, markdown: "ok" }] })) as typeof fetch;
  const recovered = await ocrRoute.POST(ocrRequest());
  assert.equal(recovered.status, 200);
  assert.equal(occupancy.getAccountRequestInFlightCount(connectionId), 0);
});

test("unavailable shared OCR admission returns 503 before dispatch and releases local occupancy", async () => {
  const previousDb = process.env.OMNI_COORDINATION_DB;
  const previousUnhealthy = process.env.OMNI_COORDINATION_UNHEALTHY;
  process.env.OMNI_SHARED_ADMISSION = "true";
  process.env.OMNI_COORDINATION_UNHEALTHY = "true";
  delete process.env.OMNI_COORDINATION_DB;
  let upstreamCalls = 0;
  globalThis.fetch = (async () => {
    upstreamCalls++;
    return Response.json({ pages: [] });
  }) as typeof fetch;

  try {
    const response = await ocrRoute.POST(ocrRequest());
    assert.equal(response.status, 503);
    assert.equal(upstreamCalls, 0, "fail-closed admission must not dispatch provider work");
    assert.equal(occupancy.getAccountRequestInFlightCount(connectionId), 0);
    assert.equal((await getProviderConnectionById(connectionId))?.testStatus, "active");
  } finally {
    if (previousDb === undefined) delete process.env.OMNI_COORDINATION_DB;
    else process.env.OMNI_COORDINATION_DB = previousDb;
    if (previousUnhealthy === undefined) delete process.env.OMNI_COORDINATION_UNHEALTHY;
    else process.env.OMNI_COORDINATION_UNHEALTHY = previousUnhealthy;
    process.env.OMNI_SHARED_ADMISSION = "false";
  }
});

test("a pre-aborted OCR request is rejected before provider dispatch or account reservation", async () => {
  const controller = new AbortController();
  controller.abort();
  let upstreamCalls = 0;
  globalThis.fetch = (async () => {
    upstreamCalls += 1;
    return Response.json({ pages: [] });
  }) as typeof fetch;

  const response = await ocrRoute.POST(ocrRequest(controller.signal));

  assert.equal(response.status, 499);
  assert.equal(upstreamCalls, 0);
  assert.equal(occupancy.getAccountRequestInFlightCount(connectionId), 0);
});

test("Azure OCR finishes polling an accepted operation after disconnect, then releases its slot", async () => {
  const previousDb = process.env.OMNI_COORDINATION_DB;
  const previousUnhealthy = process.env.OMNI_COORDINATION_UNHEALTHY;
  const runtime = globalThis as typeof globalThis & { __omniSharedCoordinator?: unknown };
  const previousCoordinator = runtime.__omniSharedCoordinator;
  process.env.OMNI_SHARED_ADMISSION = "true";
  delete process.env.OMNI_COORDINATION_DB;
  delete process.env.OMNI_COORDINATION_UNHEALTHY;
  const controller = new AbortController();
  const firstPollStarted = deferred<void>();
  const firstPollResponse = deferred<Response>();
  let pollCount = 0;
  let settled = false;

  globalThis.fetch = (async (input, init = {}) => {
    const url = String(input);
    assert.equal(occupancy.getAccountRequestInFlightCount(azureConnectionId), 1);
    if (url.includes(":analyze?")) {
      assert.ok(init.signal, "Azure submit receives a server-owned deadline signal");
      assert.notEqual(init.signal, controller.signal, "caller abort must not cancel Azure submit");
      assert.equal(init.signal.aborted, false);
      return new Response(null, {
        status: 202,
        headers: { "Operation-Location": "https://ocr-azure.example.test/operations/accepted-1" },
      });
    }
    if (url === "https://ocr-azure.example.test/operations/accepted-1") {
      pollCount += 1;
      assert.ok(init.signal, "Azure polling receives a server-owned deadline signal");
      assert.notEqual(
        init.signal,
        controller.signal,
        "caller abort must not cancel accepted polling"
      );
      assert.equal(init.signal.aborted, false);
      if (pollCount === 1) {
        firstPollStarted.resolve();
        return firstPollResponse.promise;
      }
      return Response.json({
        status: "succeeded",
        analyzeResult: { content: "recognized after disconnect", pages: [{}] },
      });
    }
    throw new Error(`Unexpected Azure OCR URL: ${url}`);
  }) as typeof fetch;

  try {
    const responsePromise = ocrRoute
      .POST(ocrRequest(controller.signal, "azure-document-intelligence/prebuilt-read"))
      .then((response) => {
        settled = true;
        return response;
      });
    await firstPollStarted.promise;
    assert.equal(occupancy.getAccountRequestInFlightCount(azureConnectionId), 1);

    controller.abort();
    assert.equal(settled, false, "the accepted task remains owned until polling settles");
    firstPollResponse.resolve(Response.json({ status: "running" }));

    const response = await responsePromise;
    assert.equal(response.status, 499);
    assert.equal(pollCount, 2, "polling continues until Azure reports a terminal state");
    assert.equal(occupancy.getAccountRequestInFlightCount(azureConnectionId), 0);
  } finally {
    controller.abort();
    runtime.__omniSharedCoordinator = previousCoordinator;
    if (previousDb === undefined) delete process.env.OMNI_COORDINATION_DB;
    else process.env.OMNI_COORDINATION_DB = previousDb;
    if (previousUnhealthy === undefined) delete process.env.OMNI_COORDINATION_UNHEALTHY;
    else process.env.OMNI_COORDINATION_UNHEALTHY = previousUnhealthy;
    process.env.OMNI_SHARED_ADMISSION = "false";
  }
});
