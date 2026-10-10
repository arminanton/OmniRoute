import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getOrCoalesce, computeCacheKey } from "../../open-sse/services/searchCache.ts";

let nextKey = 0;

function makeKey() {
  nextKey++;
  return computeCacheKey(`cancellation-test-${nextKey}`, "test", "search", 10);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("getOrCoalesce waiter cancellation", () => {
  it("detaches one aborted waiter while another receives and caches the producer result", async () => {
    const key = makeKey();
    const firstWaiter = new AbortController();
    const secondWaiter = new AbortController();
    const started = deferred<AbortSignal>();
    const result = deferred<{ value: string }>();
    let fetchCalls = 0;

    const fetchFn = (signal: AbortSignal) => {
      fetchCalls++;
      started.resolve(signal);
      return result.promise;
    };

    const first = getOrCoalesce(key, 60_000, fetchFn, { signal: firstWaiter.signal });
    const producerSignal = await started.promise;
    const second = getOrCoalesce(key, 60_000, fetchFn, { signal: secondWaiter.signal });

    firstWaiter.abort(new DOMException("first waiter left", "AbortError"));
    await assert.rejects(first, { name: "AbortError", message: "first waiter left" });
    assert.equal(producerSignal.aborted, false, "one waiter leaving must not cancel shared work");

    result.resolve({ value: "shared result" });
    assert.deepEqual(await second, { data: { value: "shared result" }, cached: true });
    assert.equal(fetchCalls, 1);

    const cached = await getOrCoalesce(key, 60_000, async () => ({ value: "unexpected" }));
    assert.deepEqual(cached, { data: { value: "shared result" }, cached: true });
  });

  it("aborts the producer after the last waiter leaves and lets a fresh retry own the key", async () => {
    const key = makeKey();
    const abandonedWaiter = new AbortController();
    const abandonedResult = deferred<string>();
    const retryResult = deferred<string>();
    const abandonedStarted = deferred<AbortSignal>();
    const retryStarted = deferred<void>();
    let fetchCalls = 0;

    const first = getOrCoalesce(
      key,
      60_000,
      (signal) => {
        fetchCalls++;
        abandonedStarted.resolve(signal);
        // Deliberately ignore abort to exercise stale producer completion.
        return abandonedResult.promise;
      },
      { signal: abandonedWaiter.signal }
    );
    const abandonedProducerSignal = await abandonedStarted.promise;

    abandonedWaiter.abort();
    await assert.rejects(first, { name: "AbortError" });
    assert.equal(abandonedProducerSignal.aborted, true, "last waiter leaving must abort producer");

    const retry = getOrCoalesce(key, 60_000, () => {
      fetchCalls++;
      retryStarted.resolve();
      return retryResult.promise;
    });
    await retryStarted.promise;

    // The old producer can finish late. It must neither cache over the retry
    // nor delete the retry's in-flight map entry.
    abandonedResult.resolve("abandoned result");
    await Promise.resolve();
    await Promise.resolve();

    const joinedRetry = getOrCoalesce(key, 60_000, async () => {
      fetchCalls++;
      return "unexpected second retry";
    });
    assert.equal(fetchCalls, 2, "late abandoned work must not displace the fresh producer");

    retryResult.resolve("fresh result");
    assert.deepEqual(await retry, { data: "fresh result", cached: false });
    assert.deepEqual(await joinedRetry, { data: "fresh result", cached: true });
    assert.deepEqual(
      await getOrCoalesce(key, 60_000, async () => "unexpected cached replacement"),
      { data: "fresh result", cached: true },
      "aborted work must never populate or overwrite the cache"
    );
  });

  it("caches a normally completed coalesced producer exactly once", async () => {
    const key = makeKey();
    let fetchCalls = 0;
    const fetchFn = async () => {
      fetchCalls++;
      return "done";
    };

    const result = await getOrCoalesce(key, 60_000, fetchFn);
    assert.deepEqual(result, { data: "done", cached: false });
    assert.equal(fetchCalls, 1);
    assert.deepEqual(await getOrCoalesce(key, 60_000, fetchFn), { data: "done", cached: true });
    assert.equal(fetchCalls, 1);
  });

  it("keeps TTL=0 calls independent and uncached", async () => {
    const key = makeKey();
    const firstWaiter = new AbortController();
    const secondWaiter = new AbortController();
    const firstResult = deferred<string>();
    const secondResult = deferred<string>();
    let fetchCalls = 0;

    const first = getOrCoalesce(
      key,
      0,
      () => {
        fetchCalls++;
        return firstResult.promise;
      },
      { signal: firstWaiter.signal }
    );
    const second = getOrCoalesce(
      key,
      0,
      () => {
        fetchCalls++;
        return secondResult.promise;
      },
      { signal: secondWaiter.signal }
    );

    assert.equal(fetchCalls, 2, "TTL=0 must continue to bypass in-flight coalescing");
    firstResult.resolve("first");
    secondResult.resolve("second");
    assert.deepEqual(await first, { data: "first", cached: false });
    assert.deepEqual(await second, { data: "second", cached: false });
    assert.deepEqual(await getOrCoalesce(key, 0, async () => "third"), {
      data: "third",
      cached: false,
    });
    assert.equal(fetchCalls, 2, "TTL=0 results must not be cached");
  });
});
