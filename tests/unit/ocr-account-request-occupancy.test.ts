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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function ocrRequest() {
  return new Request("http://localhost/v1/ocr", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "mistral/mistral-ocr-latest",
      document: { type: "document_url", document_url: "https://example.com/sample.pdf" },
    }),
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
