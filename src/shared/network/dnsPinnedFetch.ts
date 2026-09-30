import { isIP } from "node:net";
import dns from "node:dns";
import { Agent, buildConnector, fetch as undiciFetch } from "undici";
import { getRuntimePolicy } from "@/shared/runtimePolicy";
import { assertRuntimePolicyDispatcher } from "@omniroute/open-sse/utils/proxyDispatcher.ts";
import { assertPinnedTransportAllowed } from "./pinnedTransportPolicy";

/**
 * Shared DNS-resolve-then-pin primitives (#12569). Extracted from remoteImageFetch.ts
 * so the webhook outbound-URL guard uses the exact same tested pinned transport.
 * remoteImageFetch.ts re-exports createPinnedFetch for its existing importers.
 */

export interface DnsLookupResult {
  address: string;
  family: number;
}

/**
 * Minimal DNS lookup contract — matches the shape returned by
 * `node:dns/promises`.lookup(host, { all: true }). Exposed as an option so
 * tests can inject a fake resolver without touching real DNS.
 */
export type DnsLookup = (hostname: string) => Promise<DnsLookupResult[]>;

export const defaultDnsLookup: DnsLookup = (hostname) =>
  dns.promises.lookup(hostname, { all: true });

/** Strip literal IPv6 brackets: "[::1]" -> "::1". */
export function bareHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/**
 * Resolve every DNS answer for a hostname, short-circuiting for an IP literal (which needs no
 * lookup — it already IS the connect-time address). Fails closed: a lookup error or an empty
 * answer set throws rather than being treated as "no restriction applies".
 */
export async function resolveHostnameAddresses(
  hostname: string,
  lookup: DnsLookup = defaultDnsLookup
): Promise<DnsLookupResult[]> {
  const bare = bareHostname(hostname);
  if (!bare) return [];
  const literalFamily = isIP(bare);
  if (literalFamily) return [{ address: bare, family: literalFamily }];
  const resolved = await lookup(bare);
  if (!resolved.length) {
    throw new Error(`Host "${bare}" could not be resolved`);
  }
  return resolved;
}

/**
 * Build a fetch bound to an already-approved IP address. This is a transport
 * primitive, not an SSRF or proxy-policy gate: callers must validate every DNS
 * answer and the active proxy policy before calling it, including each redirect.
 * Redirects are always manual unless the caller asks to reject them outright.
 */
export function createPinnedFetch(address: string, family: number): typeof fetch {
  if (
    typeof address !== "string" ||
    (family !== 4 && family !== 6) ||
    isIP(address) !== family ||
    address.includes("%")
  ) {
    throw new TypeError("Invalid pinned IP address or family");
  }
  // URL parsing gives equivalent IPv6 spellings the same representation.
  const canonicalAddress = (value: string) =>
    isIP(value) === 6 ? bareHostname(new URL(`http://[${value}]/`).hostname) : value;
  const pinnedAddress = canonicalAddress(address);

  return (async (input, init) => {
    if (getRuntimePolicy().mode === "locked") {
      assertRuntimePolicyDispatcher((init as RequestInit & { dispatcher?: unknown })?.dispatcher);
      const target = typeof input === "object" && "url" in input ? input.url : String(input);
      // Reviewed pin factory only; never classify a caller dispatcher by its name.
      await assertPinnedTransportAllowed(target);
    }
    const inputRequest = typeof input === "object" && "signal" in input ? input : undefined;
    const signal = init?.signal === undefined ? inputRequest?.signal : init.signal;
    const connector = buildConnector({
      // Agent.destroy alone cannot interrupt a socket still being connected.
      // Native net/tls sockets must receive the request signal too.
      signal: signal ?? undefined,
      lookup: (_hostname, options, callback) => {
        // Happy Eyeballs requires the array shape; older/single-family callers
        // require the address/family shape. Neither branch performs DNS.
        if (options && typeof options === "object" && "all" in options && options.all) {
          callback(null, [{ address, family }]);
          return;
        }
        callback(null, address, family);
      },
    });
    // One dispatcher per invocation makes this fetch reusable, without retaining
    // an idle pool or allowing one call's cancellation to affect another call.
    const dispatcher = new Agent({
      connections: 1,
      connect: (options, callback) => {
        // A cancelled response can otherwise trigger an idle reconnect while
        // Undici drains its queue. This dispatcher owns only one request.
        if (dispatcher.closed || dispatcher.destroyed) {
          callback(new TypeError("Pinned request is already closed"), null);
          return;
        }
        // Node skips lookup for literal hosts, so lookup alone is not a pin.
        const literalFamily = isIP(options.hostname);
        if (
          literalFamily &&
          (literalFamily !== family || canonicalAddress(options.hostname) !== pinnedAddress)
        ) {
          callback(new TypeError("Request IP address does not match the approved pin"), null);
          return;
        }
        connector(options, callback);
      },
    });
    try {
      return (await undiciFetch(input as string | URL, {
        ...(init as Parameters<typeof undiciFetch>[1]),
        redirect: (init?.redirect ?? inputRequest?.redirect) === "error" ? "error" : "manual",
        dispatcher,
      })) as unknown as Response;
    } catch (error) {
      void dispatcher.destroy().catch(() => {});
      throw error;
    } finally {
      // Do not await close: the caller must receive headers before consuming or
      // cancelling a slow/infinite body. Undici closes after EOF/cancel/abort.
      void dispatcher
        .close()
        .catch(() => dispatcher.destroy())
        .catch(() => {});
    }
  }) as typeof fetch;
}
