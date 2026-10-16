// Polyfill worker_threads.markAsUncloneable for Node.js < 21 compatibility (specifically Node 20.20.2)
import worker_threads from "node:worker_threads";
import { AsyncLocalStorage } from "node:async_hooks";
import { WebSocket } from "ws";

// Next 16 reads AsyncLocalStorage from globalThis in its server runtime. Node
// provides that global, while Bun exposes the implementation through
// node:async_hooks only.
if (typeof globalThis.AsyncLocalStorage === "undefined") {
  Object.defineProperty(globalThis, "AsyncLocalStorage", {
    configurable: true,
    value: AsyncLocalStorage,
    writable: true,
  });
}

if (worker_threads && !worker_threads.markAsUncloneable) {
  (worker_threads as any).markAsUncloneable = function (obj: any) {
    if (worker_threads.markAsUntransferable) {
      try {
        worker_threads.markAsUntransferable(obj);
      } catch {
        // no-op
      }
    }
  };
}

// Polyfill Promise.withResolvers for Node.js < 22 compatibility (specifically Node 20.20.2)
if (typeof Promise.withResolvers === "undefined") {
  Promise.withResolvers = function <T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: any) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  } as any;
}

// Polyfill WebSocket for Node.js < 22 compatibility (specifically Node 20.20.2)
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as any).WebSocket = WebSocket;
}

// In-process resilient DNS resolver fallback. If glibc getaddrinfo encounters EAI_AGAIN,
// loopback stub-resolver issues (e.g. 127.0.0.53 in network namespaces), or transient timeouts,
// transparently query public upstream resolvers (1.1.1.1, 8.8.8.8) via c-ares so outbound
// provider requests never fail at DNS lookup.
import dns from "node:dns";
import dnsPromises from "node:dns/promises";

try {
  const current = dns.getServers();
  const publicFallback = ["1.1.1.1", "1.0.0.1", "8.8.8.8", "9.9.9.9"];
  const nonLocal = current.filter((s) => s !== "127.0.0.53" && s !== "127.0.0.1" && s !== "::1");
  const merged = Array.from(new Set([...nonLocal, ...publicFallback]));
  if (merged.length > 0) {
    dns.setServers(merged);
  }
} catch {
  // Ignore in environments where setServers is restricted
}

const originalLookup = dns.lookup;
const isTransientDnsError = (err: any) =>
  err && (err.code === "EAI_AGAIN" || err.code === "ENOTFOUND" || err.code === "ECONNREFUSED" || err.code === "ETIMEDOUT");

(dns as any).lookup = function (
  hostname: string,
  options: any,
  callback?: (err: NodeJS.ErrnoException | null, address: any, family?: number) => void
) {
  let cb = callback;
  let opts = options;
  if (typeof opts === "function") {
    cb = opts;
    opts = {};
  }
  if (!cb) return;

  originalLookup(hostname, opts, (err, address, family) => {
    if (!err || !isTransientDnsError(err) || !hostname || typeof hostname !== "string" || hostname === "localhost") {
      return cb!(err, address, family);
    }
    dns.resolve4(hostname, (resErr, addresses) => {
      if (!resErr && addresses && addresses.length > 0) {
        if (opts && opts.all) {
          return cb!(null, addresses.map((a) => ({ address: a, family: 4 })));
        }
        return cb!(null, addresses[0], 4);
      }
      cb!(err, address, family);
    });
  });
};

const originalPromisesLookup = dnsPromises.lookup;
dnsPromises.lookup = async function (hostname: string, options?: any) {
  try {
    return await originalPromisesLookup(hostname, options);
  } catch (err: any) {
    if (isTransientDnsError(err) && hostname && typeof hostname === "string" && hostname !== "localhost") {
      try {
        const addresses = await dnsPromises.resolve4(hostname);
        if (addresses && addresses.length > 0) {
          if (options && options.all) {
            return addresses.map((a) => ({ address: a, family: 4 })) as any;
          }
          return { address: addresses[0], family: 4 } as any;
        }
      } catch {
        // Fall through to original error
      }
    }
    throw err;
  }
};

