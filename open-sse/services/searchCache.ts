/**
 * Search Cache — in-memory TTL cache with request coalescing
 *
 * Bounded at MAX_CACHE_ENTRIES to prevent OOM.
 * Request coalescing deduplicates concurrent identical queries
 * to prevent cache stampede (critical for agentic tools).
 */

import { createHash } from "crypto";

const MAX_CACHE_ENTRIES = 500;
const DEFAULT_TTL_MS = parseInt(process.env.SEARCH_CACHE_TTL_MS || String(60 * 1000), 10);

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

interface InflightEntry<T> {
  controller: AbortController;
  promise: Promise<T>;
  waiters: number;
  settled: boolean;
}

const cache = new Map<string, CacheEntry<unknown>>();
const inflight = new Map<string, InflightEntry<unknown>>();

let hits = 0;
let misses = 0;

/**
 * Normalize a query for cache key computation.
 * NFKC normalization, trim, and collapse whitespace. Preserve case because
 * provider operators or quoted/code searches may treat it as meaningful.
 */
function normalizeQuery(query: string): string {
  return query.normalize("NFKC").trim().replace(/\s+/g, " ");
}

/**
 * Compute a deterministic cache key from search parameters.
 */
export function computeCacheKey(
  query: string,
  provider: string,
  searchType: string,
  maxResults: number,
  country?: string,
  language?: string,
  filters?: unknown,
  executionScope?: {
    apiKeyId?: string | null;
    connectionId?: string | null;
    alternateProvider?: string | null;
    alternateConnectionId?: string | null;
  }
): string {
  const normalized = normalizeQuery(query);
  const payload = JSON.stringify({
    q: normalized,
    p: provider,
    t: searchType,
    n: maxResults,
    c: country || null,
    l: language || null,
    f: filters || null,
    ...(executionScope
      ? {
          s: {
            apiKeyId: executionScope.apiKeyId || null,
            connectionId: executionScope.connectionId || null,
            alternateProvider: executionScope.alternateProvider || null,
            alternateConnectionId: executionScope.alternateConnectionId || null,
          },
        }
      : {}),
  });
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * Evict expired entries and enforce size bound.
 * Called lazily on writes. O(n) worst case but amortized O(1).
 */
function evictIfNeeded(): void {
  const now = Date.now();

  // Remove expired entries first
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) {
      cache.delete(key);
    }
  }

  // FIFO eviction if still over limit
  while (cache.size >= MAX_CACHE_ENTRIES) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) {
      cache.delete(firstKey);
    } else {
      break;
    }
  }
}

/**
 * Get or coalesce: return cached data, join an inflight request,
 * or execute the fetch function and cache the result.
 *
 * @param key - Cache key from computeCacheKey()
 * @param ttlMs - TTL in milliseconds (0 to bypass cache AND coalescing)
 * @param fetchFn - Function to execute on cache miss; receives the producer signal
 * @param options.signal - This caller's cancellation signal. For coalesced work,
 *   it detaches only this waiter and aborts the producer after the last waiter leaves.
 * @returns The cached or freshly fetched data
 */
export async function getOrCoalesce<T>(
  key: string,
  ttlMs: number,
  fetchFn: (signal: AbortSignal) => Promise<T>,
  options: { signal?: AbortSignal } = {}
): Promise<{ data: T; cached: boolean }> {
  const waiterSignal = options.signal;
  if (waiterSignal?.aborted) {
    throw getAbortReason(waiterSignal);
  }

  // When ttlMs === 0 the caller explicitly wants to bypass the cache.
  // Skip both the cache lookup AND the inflight-coalescing step so every
  // concurrent call gets its own independent upstream fetch.  Without this
  // guard, ttlMs=0 callers still get coalesced results and receive
  // { cached: true } even though caching was explicitly disabled.
  if (ttlMs <= 0) {
    misses++;
    // There is no shared producer for this path, so the caller's signal can
    // be passed straight through. Keep an inert signal for legacy callers.
    const signal = waiterSignal ?? new AbortController().signal;
    const data = await fetchFn(signal);
    return { data, cached: false };
  }

  // 1. Check cache
  const cached = cache.get(key) as CacheEntry<T> | undefined;
  if (cached && cached.expiresAt > Date.now()) {
    hits++;
    return { data: cached.data, cached: true };
  }

  // 2. Join inflight request if one exists (request coalescing)
  const existing = inflight.get(key) as InflightEntry<T> | undefined;
  if (existing) {
    hits++;
    return await waitForEntry(key, existing, waiterSignal, true);
  }

  // 3. Cache miss — execute fetch
  misses++;
  const controller = new AbortController();
  const entry: InflightEntry<T> = {
    controller,
    promise: Promise.resolve().then(() => fetchFn(controller.signal)),
    waiters: 0,
    settled: false,
  };

  // Install the entry before any producer continuation runs. An abandoned,
  // abort-ignoring producer may finish after a fresh retry has replaced it;
  // only this exact entry may cache or remove itself.
  inflight.set(key, entry as InflightEntry<unknown>);
  entry.promise = entry.promise.then(
    (data) => {
      entry.settled = true;
      if (!controller.signal.aborted) {
        evictIfNeeded();
        cache.set(key, { data, expiresAt: Date.now() + ttlMs });
      }
      if (inflight.get(key) === entry) {
        inflight.delete(key);
      }
      return data;
    },
    (error: unknown) => {
      entry.settled = true;
      if (inflight.get(key) === entry) {
        inflight.delete(key);
      }
      throw error;
    }
  );

  return await waitForEntry(key, entry, waiterSignal, false);
}

function waitForEntry<T>(
  key: string,
  entry: InflightEntry<T>,
  signal: AbortSignal | undefined,
  cached: boolean
): Promise<{ data: T; cached: boolean }> {
  return new Promise((resolve, reject) => {
    let finished = false;
    entry.waiters++;

    const detach = () => {
      entry.waiters--;
      if (entry.waiters === 0 && !entry.settled) {
        // Remove synchronously so a new caller starts a fresh producer even
        // if this producer ignores AbortSignal and takes time to settle.
        if (inflight.get(key) === entry) {
          inflight.delete(key);
        }
        entry.controller.abort();
      }
    };

    const settle = (callback: () => void) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", onAbort);
      detach();
      callback();
    };

    const onAbort = () => {
      settle(() => reject(getAbortReason(signal)));
    };

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
      // Cover an abort that races with listener registration.
      if (signal.aborted) {
        onAbort();
      }
    }

    entry.promise.then(
      (data) => settle(() => resolve({ data, cached })),
      (error: unknown) => settle(() => reject(error))
    );
  });
}

function getAbortReason(signal: AbortSignal | undefined): unknown {
  if (signal?.reason !== undefined) {
    return signal.reason;
  }
  if (typeof DOMException !== "undefined") {
    return new DOMException("The operation was aborted", "AbortError");
  }
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

/**
 * Get cache statistics for monitoring.
 */
export function getCacheStats(): { size: number; hits: number; misses: number } {
  return { size: cache.size, hits, misses };
}

/**
 * Default TTL for search cache entries.
 */
export const SEARCH_CACHE_DEFAULT_TTL_MS = DEFAULT_TTL_MS;
