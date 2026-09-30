import { assertNoApplicationProxy, isRuntimePolicyError } from "@/shared/runtimePolicy";

type ResolveProxyForRequest = (
  targetUrl: string
) => { source: string; proxyUrl: string | null } | null;

/**
 * Fail-closed proxy resolution for the impersonation TLS clients.
 * - per-call override wins.
 * - resolution returning a proxy → use it.
 * - resolution returning direct/null → undefined (direct is legitimate: no proxy set).
 * - resolution THROWING → rethrow. A configured-but-unusable proxy (e.g. socks5 with
 *   ENABLE_SOCKS5_PROXY=false) MUST NOT silently leak the real IP via a direct connection.
 */
export function resolveTlsClientProxyUrl(
  targetUrl: string,
  perCall: string | undefined,
  resolveProxyForRequest: ResolveProxyForRequest
): string | undefined {
  assertNoApplicationProxy(
    perCall == null || perCall === ""
      ? "none"
      : typeof perCall === "string"
        ? "configured"
        : "opaque"
  );
  if (perCall && perCall.length > 0) {
    assertNoApplicationProxy("configured");
    return perCall;
  }
  let info: { source: string; proxyUrl: string | null } | null;
  try {
    info = resolveProxyForRequest(targetUrl);
  } catch (err) {
    if (isRuntimePolicyError(err)) throw err;
    throw new Error(
      `[TlsClient] Proxy resolution failed for ${targetUrl}; refusing direct connection (fail-closed): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  assertNoApplicationProxy(
    info?.proxyUrl
      ? "configured"
      : info?.source === "direct" && info.proxyUrl === null
        ? "none"
        : "opaque"
  );
  return info && info.proxyUrl ? info.proxyUrl : undefined;
}
