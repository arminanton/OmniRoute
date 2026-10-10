import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-inference-occupancy-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "inference-occupancy-test-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const readCache = await import("../../src/lib/db/readCache.ts");
const callLogs = await import("../../src/lib/usage/callLogs.ts");
const accountOccupancy = await import("../../open-sse/services/accountRequestOccupancy.ts");
const { createEmbeddingResponse } = await import("../../src/lib/embeddings/service.ts");
const baseEmbeddingsRoute = await import("../../src/app/api/v1/embeddings/route.ts");
const providerEmbeddingsRoute =
  await import("../../src/app/api/v1/providers/[provider]/embeddings/route.ts");
const rerankRoute = await import("../../src/app/api/v1/rerank/route.ts");

const originalFetch = globalThis.fetch;
const seededConnectionIdsByProvider = new Map<string, string[]>();

async function seedConnection(provider: string, name: string) {
  const connection = await providersDb.createProviderConnection({
    provider,
    authType: "apikey",
    name,
    apiKey: `${name}-key`,
    isActive: true,
    testStatus: "active",
    providerSpecificData: { quotaPreflightEnabled: false },
  });
  readCache.invalidateDbCache("connections");
  const id = (connection as { id: string }).id;
  const ids = seededConnectionIdsByProvider.get(provider) ?? [];
  ids.push(id);
  seededConnectionIdsByProvider.set(provider, ids);
  return id;
}

function inFlightConnectionIds(provider: string): string[] {
  return (seededConnectionIdsByProvider.get(provider) ?? []).filter(
    (id) => accountOccupancy.getAccountRequestInFlightCount(id) > 0
  );
}

function embeddingPayload() {
  return {
    data: [{ object: "embedding", embedding: [0.1, 0.2], index: 0 }],
    usage: { prompt_tokens: 1, total_tokens: 1 },
  };
}

function rerankPayload() {
  return { results: [{ index: 0, relevance_score: 0.9 }] };
}

function postJson(url: string, body: unknown, signal?: AbortSignal): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

test.beforeEach(() => {
  accountOccupancy._clearAccountRequestOccupancyForTest();
  globalThis.fetch = originalFetch;
});

test.after(async () => {
  globalThis.fetch = originalFetch;
  await callLogs.waitForCallLogSaves(5000);
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("embedding service reserves through upstream completion, error, and pre-dispatch return", async () => {
  const successConnectionId = await seedConnection("mistral", "occupancy-embed-success");
  let finishFetch: (response: Response) => void = () => {};
  let fetchStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    fetchStarted = resolve;
  });
  const pendingResponse = new Promise<Response>((resolve) => {
    finishFetch = resolve;
  });

  globalThis.fetch = (async () => {
    assert.equal(accountOccupancy.getAccountRequestInFlightCount(successConnectionId), 1);
    fetchStarted();
    return pendingResponse;
  }) as typeof fetch;

  const embeddingPromise = createEmbeddingResponse({
    model: "mistral/mistral-embed",
    input: "occupancy success",
  });
  await started;
  assert.equal(accountOccupancy.getAccountRequestInFlightCount(successConnectionId), 1);
  finishFetch(new Response(JSON.stringify(embeddingPayload()), { status: 200 }));
  const embeddingResponse = await embeddingPromise;
  assert.equal(embeddingResponse.status, 200);
  assert.equal(accountOccupancy.getAccountRequestInFlightCount(successConnectionId), 0);

  const failedConnectionId = await seedConnection("upstage", "occupancy-embed-abort");
  globalThis.fetch = (async () => {
    assert.equal(accountOccupancy.getAccountRequestInFlightCount(failedConnectionId), 1);
    const error = new Error("fake upstream cancellation");
    error.name = "AbortError";
    throw error;
  }) as typeof fetch;
  const failedResponse = await createEmbeddingResponse({
    model: "upstage/embedding-query",
    input: "occupancy cancellation",
  });
  assert.equal(failedResponse.status, 502);
  assert.equal(accountOccupancy.getAccountRequestInFlightCount(failedConnectionId), 0);

  const earlyReturnConnectionId = await seedConnection("clova-studio", "occupancy-embed-early");
  let unexpectedFetches = 0;
  globalThis.fetch = (async () => {
    unexpectedFetches++;
    return new Response(JSON.stringify(embeddingPayload()), { status: 200 });
  }) as typeof fetch;
  const earlyResponse = await createEmbeddingResponse({
    model: "clova-studio/clova-embedding-v2",
    input: [],
  });
  assert.equal(earlyResponse.status, 400);
  assert.equal(unexpectedFetches, 0, "invalid CLOVA input must return before upstream fetch");
  assert.equal(accountOccupancy.getAccountRequestInFlightCount(earlyReturnConnectionId), 0);
});

test("provider-specific embeddings route releases its selected account after the response", async () => {
  const connectionId = await seedConnection("openai", "occupancy-provider-embedding-route");
  globalThis.fetch = (async () => {
    assert.equal(accountOccupancy.getAccountRequestInFlightCount(connectionId), 1);
    return new Response(JSON.stringify(embeddingPayload()), { status: 200 });
  }) as typeof fetch;

  const response = await providerEmbeddingsRoute.POST(
    postJson("http://localhost/v1/providers/openai/embeddings", {
      model: "text-embedding-3-small",
      input: "route occupancy",
    }),
    { params: Promise.resolve({ provider: "openai" }) }
  );

  assert.equal(response.status, 200);
  assert.equal(accountOccupancy.getAccountRequestInFlightCount(connectionId), 0);

  globalThis.fetch = (async () => {
    assert.equal(accountOccupancy.getAccountRequestInFlightCount(connectionId), 1);
    const error = new Error("fake provider request cancelled");
    error.name = "AbortError";
    throw error;
  }) as typeof fetch;
  const cancelledResponse = await providerEmbeddingsRoute.POST(
    postJson("http://localhost/v1/providers/openai/embeddings", {
      model: "text-embedding-3-small",
      input: "cancelled route occupancy",
    }),
    { params: Promise.resolve({ provider: "openai" }) }
  );
  assert.equal(cancelledResponse.status, 502);
  assert.equal(accountOccupancy.getAccountRequestInFlightCount(connectionId), 0);
});

test("both embedding routes forward caller aborts and release account occupancy without cooldown", async () => {
  const cases = [
    {
      provider: "mistral",
      name: "cancel-base-embeddings",
      model: "mistral/mistral-embed",
      call: (request: Request) => baseEmbeddingsRoute.POST(request),
    },
    {
      provider: "openai",
      name: "cancel-provider-embeddings",
      model: "openai/text-embedding-3-small",
      call: (request: Request) =>
        providerEmbeddingsRoute.POST(request, {
          params: Promise.resolve({ provider: "openai" }),
        }),
    },
  ] as const;

  for (const current of cases) {
    await seedConnection(current.provider, current.name);
    const controller = new AbortController();
    let fetchStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      fetchStarted = resolve;
    });
    let observedSignal: AbortSignal | null | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      observedSignal = init?.signal;
      assert.equal(inFlightConnectionIds(current.provider).length, 1);
      fetchStarted();
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(signal.reason ?? new DOMException("Request aborted", "AbortError"));
          return;
        }
        signal?.addEventListener(
          "abort",
          () => reject(signal.reason ?? new DOMException("Request aborted", "AbortError")),
          { once: true }
        );
      });
    }) as typeof fetch;

    const pending = current.call(
      postJson(
        `http://localhost/v1/${current.provider === "mistral" ? "embeddings" : "providers/openai/embeddings"}`,
        { model: current.model, input: "abort me" },
        controller.signal
      )
    );
    await started;
    const selectedConnectionIds = inFlightConnectionIds(current.provider);
    controller.abort();

    const response = await pending;
    assert.ok(observedSignal, "upstream fetch receives a signal");
    assert.equal(observedSignal?.aborted, true, "caller abort must reach upstream fetch");
    assert.equal(selectedConnectionIds.length, 1);
    assert.equal(response.status, 499, `${current.name} should report caller cancellation`);
    assert.equal(inFlightConnectionIds(current.provider).length, 0);
    const connection = await providersDb.getProviderConnectionById(selectedConnectionIds[0]);
    assert.equal(connection.testStatus, "active", "caller cancellation must not cool the account");
  }
});

test("embedding combo forwards caller signal to its selected child request", async () => {
  await seedConnection("mistral", "cancel-combo-embedding-child");
  const { createCombo } = await import("../../src/lib/db/combos.ts");
  await createCombo({
    name: "cancel-embedding-child-combo",
    strategy: "priority",
    models: ["mistral/mistral-embed"],
  });
  const controller = new AbortController();
  let fetchStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    fetchStarted = resolve;
  });
  let observedSignal: AbortSignal | null | undefined;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    observedSignal = init?.signal;
    assert.equal(inFlightConnectionIds("mistral").length, 1);
    fetchStarted();
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(init.signal?.reason ?? new DOMException("Request aborted", "AbortError")),
        { once: true }
      );
    });
  }) as typeof fetch;

  const pending = createEmbeddingResponse(
    { model: "cancel-embedding-child-combo", input: "abort combo child" },
    { signal: controller.signal }
  );
  await started;
  assert.equal(observedSignal, controller.signal);
  const selectedConnectionIds = inFlightConnectionIds("mistral");
  assert.equal(selectedConnectionIds.length, 1);
  controller.abort();

  const response = await pending;
  assert.equal(response.status, 499);
  assert.equal(inFlightConnectionIds("mistral").length, 0);
  const connection = await providersDb.getProviderConnectionById(selectedConnectionIds[0]);
  assert.equal(connection.testStatus, "active", "aborted child must not cool its account");
});

test("cloud rerank route releases its account after a fake upstream response", async () => {
  const connectionId = await seedConnection("cohere", "occupancy-cloud-rerank");
  globalThis.fetch = (async () => {
    assert.equal(accountOccupancy.getAccountRequestInFlightCount(connectionId), 1);
    return new Response(JSON.stringify(rerankPayload()), { status: 200 });
  }) as typeof fetch;

  const response = await rerankRoute.POST(
    postJson("http://localhost/v1/rerank", {
      model: "cohere/rerank-v3.5",
      query: "occupancy query",
      documents: ["document"],
    }),
    {}
  );

  assert.equal(response.status, 200);
  assert.equal(accountOccupancy.getAccountRequestInFlightCount(connectionId), 0);
});

test("local rerank fallback keeps one reservation across both fetches and releases on error return", async () => {
  const now = new Date().toISOString();
  await providersDb.createProviderNode({
    id: "occupancy-local-rerank",
    name: "Occupancy local reranker",
    type: "openai-compatible",
    prefix: "occupancy-local-rerank",
    apiType: "chat",
    baseUrl: "http://127.0.0.1:8199/v1",
    createdAt: now,
    updatedAt: now,
  });
  readCache.invalidateDbCache("nodes");
  const connectionId = await seedConnection("occupancy-local-rerank", "occupancy-local-rerank");

  const urls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    urls.push(String(url));
    assert.equal(accountOccupancy.getAccountRequestInFlightCount(connectionId), 1);
    if (String(url).endsWith("/v1/rerank")) return new Response("missing", { status: 404 });
    return new Response(JSON.stringify({ detail: "fake rerank failure" }), { status: 500 });
  }) as typeof fetch;

  const response = await rerankRoute.POST(
    postJson("http://localhost/v1/rerank", {
      model: "occupancy-local-rerank/test-model",
      query: "occupancy query",
      documents: ["document"],
    }),
    {}
  );

  assert.equal(response.status, 500);
  assert.deepEqual(urls, ["http://127.0.0.1:8199/v1/rerank", "http://127.0.0.1:8199/rerank"]);
  assert.equal(accountOccupancy.getAccountRequestInFlightCount(connectionId), 0);
});
