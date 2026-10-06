import type { Dispatcher } from "undici";

const DISPATCHER_CACHE_KEY = Symbol.for("omniroute.proxyDispatcher.cache");
const DEFAULT_DISPATCHER_KEY = Symbol.for("omniroute.proxyDispatcher.default");
const RETRY_DISPATCHER_KEY = Symbol.for("omniroute.proxyDispatcher.retry");

/** Upper bound on cached per-URL proxy dispatchers; oldest entries are evicted first. */
const MAX_DISPATCHER_CACHE_ENTRIES = 512;

type DispatcherCache = Map<string, Dispatcher>;
type GlobalWithDispatcherCache = typeof globalThis & {
  [DISPATCHER_CACHE_KEY]?: DispatcherCache;
  [DEFAULT_DISPATCHER_KEY]?: Dispatcher;
  [RETRY_DISPATCHER_KEY]?: Dispatcher;
};

/**
 * Direct upstream fan-out dispatcher.
 *
 * A single Undici Agent configured with `connections > 1` should be enough in
 * theory, but real Codex `/backend-api/codex/responses` streams on Node 24 have
 * still been observed queuing every subsequent same-origin request until the
 * previous stream emits trailers. Using several one-connection Agents gives
 * each long SSE stream an independent pool/client and prevents one stream from
 * monopolizing the effective queue. Occupancy is tracked per origin, so a
 * busy stream never receives another request while another slot is idle.
 */
class CapacityAwareDispatcher {
  private readonly dispatchers: Dispatcher[];
  private nextIndex = 0;
  private readonly occupancy = new Map<string, number[]>();

  constructor(dispatchers: Dispatcher[]) {
    this.dispatchers = dispatchers;
  }

  dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    const origin = String(options.origin);
    const counts = this.occupancy.get(origin) ?? this.dispatchers.map(() => 0);
    this.occupancy.set(origin, counts);
    let index = this.nextIndex % this.dispatchers.length;
    for (let offset = 1; offset < this.dispatchers.length; offset++) {
      const candidate = (this.nextIndex + offset) % this.dispatchers.length;
      if (counts[candidate] < counts[index]) index = candidate;
    }
    this.nextIndex = (index + 1) % this.dispatchers.length;
    counts[index]++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      counts[index]--;
      if (counts.every((count) => count === 0)) this.occupancy.delete(origin);
    };
    // Delegate with the original receiver: fetch handlers may carry private fields.
    const tracked = new Proxy(handler, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (["onResponseEnd", "onResponseError", "onRequestUpgrade"].includes(String(property))) {
          return (...args: unknown[]) => {
            release();
            if (typeof value === "function") return Reflect.apply(value, target, args);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    try {
      return this.dispatchers[index].dispatch(options, tracked);
    } catch (error) {
      release();
      throw error;
    }
  }

  close(callback?: () => void): Promise<void> | void {
    const done = Promise.all(this.dispatchers.map((dispatcher) => dispatcher.close())).then(
      () => undefined
    );
    if (callback) {
      done.then(callback);
      return;
    }
    return done;
  }

  destroy(
    errorOrCallback?: Error | null | (() => void),
    callback?: () => void
  ): Promise<void> | void {
    const callbackFn = typeof errorOrCallback === "function" ? errorOrCallback : callback;
    const error = typeof errorOrCallback === "function" ? null : (errorOrCallback ?? null);
    const done = Promise.all(this.dispatchers.map((dispatcher) => dispatcher.destroy(error))).then(
      () => undefined
    );
    if (callbackFn) {
      done.then(callbackFn);
      return;
    }
    return done;
  }
}

export function createRoundRobinDispatcher(dispatchers: Dispatcher[]): Dispatcher {
  // Retain the internal factory name for existing callers; ties rotate in
  // order, but current transport occupancy always takes precedence.
  return new CapacityAwareDispatcher(dispatchers) as unknown as Dispatcher;
}

export function getDispatcherCache(): DispatcherCache {
  const globalWithCache = globalThis as GlobalWithDispatcherCache;
  if (!globalWithCache[DISPATCHER_CACHE_KEY]) {
    globalWithCache[DISPATCHER_CACHE_KEY] = new Map();
  }
  return globalWithCache[DISPATCHER_CACHE_KEY];
}

export function getDefaultCachedDispatcher(): Dispatcher | undefined {
  return (globalThis as GlobalWithDispatcherCache)[DEFAULT_DISPATCHER_KEY];
}

export function setDefaultCachedDispatcher(dispatcher: Dispatcher): void {
  (globalThis as GlobalWithDispatcherCache)[DEFAULT_DISPATCHER_KEY] = dispatcher;
}

export function getRetryCachedDispatcher(): Dispatcher | undefined {
  return (globalThis as GlobalWithDispatcherCache)[RETRY_DISPATCHER_KEY];
}

export function setRetryCachedDispatcher(dispatcher: Dispatcher): void {
  (globalThis as GlobalWithDispatcherCache)[RETRY_DISPATCHER_KEY] = dispatcher;
}

function closeDispatcher(dispatcher: Dispatcher | undefined): void {
  if (!dispatcher) return;
  try {
    const result = dispatcher.close();
    if (result && typeof (result as Promise<void>).catch === "function") {
      void (result as Promise<void>).catch(() => {});
    }
  } catch {}
}

/**
 * Clear all cached proxy dispatchers.
 * Call this when proxy configuration changes to avoid stale connections.
 */
export function clearDispatcherCache(): void {
  const cache = getDispatcherCache();
  for (const dispatcher of cache.values()) {
    closeDispatcher(dispatcher);
  }
  cache.clear();

  const globalWithCache = globalThis as GlobalWithDispatcherCache;
  closeDispatcher(globalWithCache[DEFAULT_DISPATCHER_KEY]);
  closeDispatcher(globalWithCache[RETRY_DISPATCHER_KEY]);
  delete globalWithCache[DEFAULT_DISPATCHER_KEY];
  delete globalWithCache[RETRY_DISPATCHER_KEY];
}

export function __cacheProxyDispatcherForTest(key: string, dispatcher: Dispatcher): void {
  getDispatcherCache().set(key, dispatcher);
}

/**
 * Insert a dispatcher into the per-URL cache, evicting the oldest entry (and
 * closing it) first when the cache is at capacity. This keeps the cache bounded
 * on proxies that rotate through many URLs while guaranteeing that
 * `clearDispatcherCache()` can still close every registered dispatcher.
 */
export function setDispatcherCacheEntry(key: string, dispatcher: Dispatcher): void {
  const cache = getDispatcherCache();
  if (cache.size >= MAX_DISPATCHER_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      const evicted = cache.get(oldest);
      cache.delete(oldest);
      closeDispatcher(evicted);
    }
  }
  cache.set(key, dispatcher);
}
