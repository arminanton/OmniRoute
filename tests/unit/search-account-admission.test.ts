import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_DATA_DIR = mkdtempSync(join(tmpdir(), "omniroute-search-admission-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "search-admission-test-secret";

const { handleSearch } = await import("../../open-sse/handlers/search.ts");
const { computeCacheKey, getOrCoalesce, getCacheStats } =
  await import("../../open-sse/services/searchCache.ts");
const occupancy = await import("../../open-sse/services/accountRequestOccupancy.ts");
const { resolveQuotaIdentity } = await import("../../open-sse/services/quotaIdentity.ts");
const core = await import("../../src/lib/db/core.ts");
const callLogs = await import("../../src/lib/usage/callLogs.ts");

const originalFetch = globalThis.fetch;
const originalAdmissionEnv = process.env.OMNI_SHARED_ADMISSION;
const originalCoordinationDb = process.env.OMNI_COORDINATION_DB;
const originalCoordinationUnhealthy = process.env.OMNI_COORDINATION_UNHEALTHY;
process.env.OMNI_SHARED_ADMISSION = "false";
delete process.env.OMNI_COORDINATION_DB;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function searchOptions(options: {
  query: string;
  provider: string;
  credentials: Record<string, unknown>;
  alternateProvider?: string;
  alternateCredentials?: Record<string, unknown>;
  signal?: AbortSignal;
}) {
  return {
    query: options.query,
    provider: options.provider,
    maxResults: 1,
    searchType: "web",
    credentials: options.credentials,
    alternateProvider: options.alternateProvider,
    alternateCredentials: options.alternateCredentials,
    signal: options.signal,
    log: null,
  };
}

function pendingCount(connectionId: string): number {
  return occupancy.getAccountRequestInFlightCount(connectionId);
}

function sharedResources() {
  const filename = process.env.OMNI_COORDINATION_DB;
  assert.ok(filename, "shared admission fixture must set a coordination database");
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const rows = db
      .prepare("SELECT resource, cap FROM coordination_resources ORDER BY resource")
      .all() as Array<{
      resource: string;
      cap: number;
    }>;
    return rows.map((row) => ({ resource: String(row.resource), cap: Number(row.cap) }));
  } finally {
    db.close();
  }
}

function resetSharedCoordinator() {
  globalThis.__omniSharedCoordinator?.close();
  globalThis.__omniSharedCoordinator = undefined;
}

async function withSharedAdmission(run: () => Promise<void>) {
  resetSharedCoordinator();
  delete process.env.OMNI_COORDINATION_UNHEALTHY;
  process.env.OMNI_SHARED_ADMISSION = "true";
  process.env.OMNI_COORDINATION_DB = join(TEST_DATA_DIR, "coordination.sqlite");
  try {
    await run();
  } finally {
    resetSharedCoordinator();
    if (originalAdmissionEnv === undefined) delete process.env.OMNI_SHARED_ADMISSION;
    else process.env.OMNI_SHARED_ADMISSION = originalAdmissionEnv;
    if (originalCoordinationDb === undefined) delete process.env.OMNI_COORDINATION_DB;
    else process.env.OMNI_COORDINATION_DB = originalCoordinationDb;
    if (originalCoordinationUnhealthy === undefined) delete process.env.OMNI_COORDINATION_UNHEALTHY;
    else process.env.OMNI_COORDINATION_UNHEALTHY = originalCoordinationUnhealthy;
  }
}

test.before(async () => {
  await core.ensureDbInitialized();
});

test.beforeEach(() => {
  occupancy._clearAccountRequestOccupancyForTest();
  globalThis.fetch = originalFetch;
});

test.after(async () => {
  globalThis.fetch = originalFetch;
  await callLogs.waitForCallLogSaves(5000);
  const { flushProxyLogsSync } = await import("../../src/lib/proxyLogger.ts");
  flushProxyLogsSync();
  resetSharedCoordinator();
  core.resetDbInstance();
  rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("coalesced searches own one account reservation and keep it after one waiter cancels", async () => {
  const accountId = "coalesced-search-account";
  const credentials = {
    id: accountId,
    provider: "linkup-search",
    apiKey: "linkup-test-key",
    maxConcurrent: 1,
    providerSpecificData: {},
  };
  const query = `coalesced admission ${Date.now()}`;
  const key = computeCacheKey(query, "linkup-search", "web", 1);
  const firstWaiter = new AbortController();
  const secondWaiter = new AbortController();
  const upstreamStarted = deferred<AbortSignal>();
  const upstreamResult = deferred<Response>();
  let fetchCalls = 0;

  globalThis.fetch = (async (_url: unknown, init: RequestInit = {}) => {
    fetchCalls++;
    assert.equal(pendingCount(accountId), 1, "the producer reserves its selected account");
    const signal = init.signal as AbortSignal;
    upstreamStarted.resolve(signal);
    return upstreamResult.promise;
  }) as typeof fetch;

  const load = (signal: AbortSignal) =>
    handleSearch(searchOptions({ query, provider: "linkup-search", credentials, signal })).then(
      (result) => {
        if (!result.success || !result.data) throw new Error(result.error || "search failed");
        return result.data;
      }
    );
  const first = getOrCoalesce(key, 60_000, load, { signal: firstWaiter.signal });
  const upstreamSignal = await upstreamStarted.promise;
  const hitsBeforeJoin = getCacheStats().hits;
  const second = getOrCoalesce(key, 60_000, load, { signal: secondWaiter.signal });
  await waitForCacheHit(hitsBeforeJoin);

  firstWaiter.abort();
  await assert.rejects(first, { name: "AbortError" });
  assert.equal(upstreamSignal.aborted, false, "one cancelled waiter must not abort the producer");
  assert.equal(pendingCount(accountId), 1, "the remaining waiter keeps the account occupied");

  upstreamResult.resolve(
    Response.json({
      results: [{ name: "Shared", url: "https://example.com/shared", content: "ok" }],
    })
  );
  const result = await second;
  assert.equal(result.cached, true);
  assert.equal(fetchCalls, 1, "the coalesced query makes one upstream attempt");
  assert.equal(pendingCount(accountId), 0, "the reservation releases after completion");
});

test("a primary 429 releases its account before alternate-provider admission, using credential owner aliases", async () => {
  await withSharedAdmission(async () => {
    const primary = {
      id: "jina-search-shared-account",
      provider: "jina-ai",
      apiKey: "jina-test-key",
      maxConcurrent: 1,
      providerSpecificData: {},
    };
    const alternate = {
      id: "brave-search-shared-account",
      provider: "brave-search",
      apiKey: "brave-test-key",
      maxConcurrent: 1,
      providerSpecificData: {},
    };
    const expectedPrimaryResource = resolveQuotaIdentity("jina-ai", primary.id, primary);
    const wrongAliasResource = resolveQuotaIdentity("jina-search", primary.id, primary);
    const expectedAlternateResource = resolveQuotaIdentity("brave-search", alternate.id, alternate);
    assert.ok(expectedPrimaryResource);
    assert.ok(expectedAlternateResource);
    assert.notEqual(expectedPrimaryResource, wrongAliasResource);

    const attempts: Array<{
      url: string;
      primaryInFlight: number;
      alternateInFlight: number;
      resources: ReturnType<typeof sharedResources>;
    }> = [];
    globalThis.fetch = (async (url: unknown) => {
      const target = String(url);
      attempts.push({
        url: target,
        primaryInFlight: pendingCount(primary.id),
        alternateInFlight: pendingCount(alternate.id),
        resources: sharedResources(),
      });
      if (target.includes("s.jina.ai")) {
        return new Response("quota exhausted", { status: 429 });
      }

      return Response.json({
        web: { results: [{ title: "Fallback", url: "https://example.com" }] },
      });
    }) as typeof fetch;

    const result = await handleSearch(
      searchOptions({
        query: "fallback admission",
        provider: "jina-search",
        credentials: primary,
        alternateProvider: "brave-search",
        alternateCredentials: alternate,
      })
    );

    assert.equal(
      result.success,
      true,
      `fallback result status=${result.status} error=${result.error}; attempts=${JSON.stringify(attempts)}`
    );
    assert.equal(result.data?.provider, "brave-search");
    assert.equal(attempts.length, 2);
    assert.ok(attempts[0].url.includes("s.jina.ai"));
    assert.equal(attempts[0].primaryInFlight, 1);
    assert.equal(attempts[0].alternateInFlight, 0);
    assert.deepEqual(attempts[0].resources, [{ resource: expectedPrimaryResource, cap: 1 }]);
    assert.ok(attempts[1].url.includes("api.search.brave.com"));
    assert.equal(attempts[1].primaryInFlight, 0);
    assert.equal(attempts[1].alternateInFlight, 1);
    assert.deepEqual(attempts[1].resources, [{ resource: expectedAlternateResource, cap: 1 }]);
    assert.equal(pendingCount(primary.id), 0);
    assert.equal(pendingCount(alternate.id), 0);
    assert.deepEqual(sharedResources(), [], "all terminal/fallback paths release shared permits");
  });
});

test("admission-unavailable is a terminal 503 and releases local occupancy without contacting upstream", async () => {
  resetSharedCoordinator();
  process.env.OMNI_SHARED_ADMISSION = "true";
  delete process.env.OMNI_COORDINATION_DB;
  const accountId = "unavailable-search-account";
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    return Response.json({ results: [] });
  }) as typeof fetch;

  try {
    const result = await handleSearch(
      searchOptions({
        query: "admission unavailable",
        provider: "linkup-search",
        credentials: {
          id: accountId,
          provider: "linkup-search",
          apiKey: "linkup-test-key",
          maxConcurrent: 1,
          providerSpecificData: {},
        },
        alternateProvider: "brave-search",
        alternateCredentials: {
          id: "must-not-fallback",
          provider: "brave-search",
          apiKey: "brave-test-key",
          maxConcurrent: 1,
          providerSpecificData: {},
        },
      })
    );

    assert.equal(result.success, false);
    assert.equal(result.status, 503);
    assert.equal(result.terminal, true);
    assert.equal(fetchCalls, 0, "admission failure must not dispatch or fallback upstream");
    assert.equal(pendingCount(accountId), 0);
    assert.equal(pendingCount("must-not-fallback"), 0);
  } finally {
    if (originalAdmissionEnv === undefined) delete process.env.OMNI_SHARED_ADMISSION;
    else process.env.OMNI_SHARED_ADMISSION = originalAdmissionEnv;
    if (originalCoordinationDb === undefined) delete process.env.OMNI_COORDINATION_DB;
    else process.env.OMNI_COORDINATION_DB = originalCoordinationDb;
    if (originalCoordinationUnhealthy === undefined) delete process.env.OMNI_COORDINATION_UNHEALTHY;
    else process.env.OMNI_COORDINATION_UNHEALTHY = originalCoordinationUnhealthy;
  }
});

test("a terminal upstream transport error releases both process-local and shared reservations", async () => {
  await withSharedAdmission(async () => {
    const accountId = "failed-search-account";
    const credentials = {
      id: accountId,
      provider: "linkup-search",
      apiKey: "linkup-test-key",
      maxConcurrent: 1,
      providerSpecificData: {},
    };
    globalThis.fetch = (async () => {
      assert.equal(pendingCount(accountId), 1);
      assert.equal(sharedResources().length, 1);
      throw new Error("synthetic search transport failure");
    }) as typeof fetch;

    const result = await handleSearch(
      searchOptions({
        query: "terminal transport failure",
        provider: "linkup-search",
        credentials,
      })
    );

    assert.equal(result.success, false);
    assert.equal(pendingCount(accountId), 0);
    assert.deepEqual(sharedResources(), []);
  });
});

async function waitForCacheHit(previous: number) {
  const deadline = Date.now() + 2_000;
  while (getCacheStats().hits === previous && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.ok(
    getCacheStats().hits > previous,
    "the second waiter should join the in-flight producer"
  );
}
