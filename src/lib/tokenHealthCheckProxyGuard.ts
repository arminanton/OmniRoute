import { resolveProxyForConnection, getProxyForLevel } from "@/lib/db/settings";
import { resolveProxyForScopeFromRegistry } from "@/lib/db/proxies";
import { getRefreshProxyAssignmentState } from "@/lib/db/proxies/guards";
import { proxyConfigToUrl } from "@omniroute/open-sse/utils/proxyDispatcher.ts";
import { runWithProxyContext } from "@omniroute/open-sse/utils/proxyFetch.ts";

/**
 * No PROXY_FAIL_OPEN exception: resolution uncertainty must not release OAuth
 * secrets to direct/env egress. Null with no assignment preserves the existing
 * transport context; the deployment's residential namespace remains mandatory.
 * Sweep callers skip this connection. Request-time refresh callers throw a
 * fixed, secret-free error. No connection health/lease state is mutated here.
 */
export async function resolveGuardedProxyConfig(
  connectionId?: string,
  provider?: string
): Promise<{ proxyConfig: unknown; blocked: boolean }> {
  try {
    const assignment = getRefreshProxyAssignmentState(connectionId, provider);
    if (assignment.blocked) return { proxyConfig: null, blocked: true };
    const resolved = connectionId
      ? await resolveProxyForConnection(connectionId, undefined, provider, {
          fresh: true,
          skipFallback: true,
        })
      : null;
    if (
      connectionId &&
      assignment.assigned &&
      (resolved?.level !== assignment.level ||
        resolved?.levelId !== assignment.levelId ||
        Boolean(resolved && "source" in resolved && resolved.source === "registry") !==
          (assignment.source === "registry"))
    ) {
      return { proxyConfig: null, blocked: true };
    }
    let proxyConfig: unknown = resolved?.proxy ?? null;
    if (!connectionId && assignment.assigned) {
      const level = assignment.level;
      if (!level) return { proxyConfig: null, blocked: true };
      proxyConfig =
        assignment.source === "registry"
          ? ((await resolveProxyForScopeFromRegistry(level, assignment.levelId))?.proxy ?? null)
          : await getProxyForLevel(level, assignment.levelId);
    }
    // Empty/partial objects are normalized to null by the transport. Do not
    // mistake them for a usable assigned proxy (and silently refresh directly).
    if (proxyConfig && !proxyConfigToUrl(proxyConfig)) {
      return { proxyConfig: null, blocked: true };
    }
    return { proxyConfig, blocked: !proxyConfig && assignment.assigned };
  } catch {
    return { proxyConfig: null, blocked: true };
  }
}

/**
 * Keep the assignment mandatory through the actual fetch, not just lookup.
 * Nested provider helpers inherit this policy. It cannot be relaxed by
 * NO_PROXY, local-address heuristics, or an opt-in direct fallback. Skip the
 * optimistic probe: a single-use grant must not race an unrelated TCP check.
 */
export async function withRequiredRefreshProxy<T>(
  proxyConfig: unknown,
  refresh: () => Promise<T>
): Promise<T> {
  if (!proxyConfig) return refresh();
  return runWithProxyContext(proxyConfig, refresh, {
    requireProxy: true,
    skipUnreachableProbe: true,
  });
}
