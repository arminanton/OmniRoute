import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-ocr-occupancy-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "ocr-occupancy-test-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const readCache = await import("../../src/lib/db/readCache.ts");
const occupancy = await import("../../open-sse/services/accountRequestOccupancy.ts");
const ocrRoute = await import("../../src/app/api/v1/ocr/route.ts");

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
  const controller = new AbortController();
  const firstPollStarted = deferred<void>();
  const firstPollResponse = deferred<Response>();
  let pollCount = 0;
  let settled = false;

  globalThis.fetch = (async (input, init = {}) => {
    const url = String(input);
    assert.equal(occupancy.getAccountRequestInFlightCount(azureConnectionId), 1);
    if (url.includes(":analyze?")) {
      assert.equal(init.signal, undefined, "caller abort must not cancel Azure submit");
      return new Response(null, {
        status: 202,
        headers: { "Operation-Location": "https://ocr-azure.example.test/operations/accepted-1" },
      });
    }
    if (url === "https://ocr-azure.example.test/operations/accepted-1") {
      pollCount += 1;
      assert.equal(init.signal, undefined, "caller abort must not cancel accepted-task polling");
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
});
