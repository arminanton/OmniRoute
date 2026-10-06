import { resolveProxyForRequest, isTlsFingerprintActive } from "../proxyFetch.ts";
import { ProviderHttp2Pool } from "./providerHttp2.ts";
import { prepareZstdUpload } from "./zstdUpload.ts";

const pools = new Map<string, ProviderHttp2Pool>();
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const bounded = (value: unknown, fallback: number, max: number) =>
  typeof value === "number" && Number.isInteger(value) && value > 0
    ? Math.min(value, max)
    : fallback;

/** Credentials-owned endpoint proofs, never request-body/provider-wide assumptions. Default off. */
export async function fetchProviderRequestTransport(
  provider: string,
  providerSpecificData: unknown,
  url: string,
  init: RequestInit,
  streaming: boolean,
  fetcher: (url: string, init: RequestInit) => Promise<Response>
) {
  const transport = record(record(providerSpecificData).upstreamTransport);
  const http2Origins = strings(transport.http2VerifiedOrigins);
  const zstdEndpoints = strings(transport.zstdVerifiedEndpoints);
  if (!http2Origins.length && !zstdEndpoints.length) return fetcher(url, init);
  const hasApplicationProxy = Boolean(resolveProxyForRequest(url).proxyUrl);
  const requiresTlsFingerprint = isTlsFingerprintActive(provider, hasApplicationProxy);
  // Preserve proxy/relay and TLS-fingerprint body/dispatcher contracts unchanged.
  if (hasApplicationProxy || requiresTlsFingerprint || "dispatcher" in init)
    return fetcher(url, init);
  const upload = await prepareZstdUpload(url, init, { verifiedEndpoints: zstdEndpoints });
  const terminalEvents = strings(transport.terminalEvents);
  if (!streaming || !http2Origins.length || !terminalEvents.length)
    return fetcher(url, upload.init);
  const concurrency = bounded(transport.maxConcurrentRequests, 16, 256);
  const maxQueued = bounded(transport.maxQueuedRequests, 128, 512);
  const queueTimeout = bounded(transport.queueTimeoutMs, 30000, 120000);
  const key = JSON.stringify([
    provider,
    [...http2Origins].sort(),
    [...terminalEvents].sort(),
    concurrency,
    maxQueued,
    queueTimeout,
  ]);
  let pool = pools.get(key);
  if (!pool) {
    if (pools.size >= 32) return fetcher(url, upload.init);
    pool = new ProviderHttp2Pool({
      verifiedOrigins: { [provider]: http2Origins },
      terminalEvents,
      maxConcurrentRequests: concurrency,
      maxQueuedRequests: maxQueued,
      queueTimeoutMs: queueTimeout,
    });
    pools.set(key, pool);
  }
  return pool.fetch(
    url,
    upload.init,
    { provider, hasApplicationProxy, requiresTlsFingerprint },
    fetcher
  );
}

export async function closeProviderRequestTransports(force = false) {
  await Promise.all([...pools.values()].map((pool) => pool.close(force)));
  pools.clear();
}

/** Bind trusted executor credentials while retaining the guarded ambient fetcher. */
export function providerFetch(
  provider: string,
  credentials: { providerSpecificData?: unknown },
  streaming: boolean,
  fetcher: (url: string, init: RequestInit) => Promise<Response> = globalThis.fetch
) {
  return (url: string, init: RequestInit) =>
    fetchProviderRequestTransport(
      provider,
      credentials.providerSpecificData,
      url,
      init,
      streaming,
      fetcher
    );
}
