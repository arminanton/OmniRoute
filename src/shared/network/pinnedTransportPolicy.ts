import { assertNoApplicationProxy, isRuntimePolicyError } from "@/shared/runtimePolicy";

type MaybePromise<T> = T | Promise<T>;

type RequestProxyPolicy = { source: string; proxyUrl: unknown };
type StoredProxyPolicy = { level: string; proxy: unknown };

/** Trusted dependency seam. Overrides never change the production proxy context. */
export interface PinnedTransportPolicyDependencies {
  resolveProxyForRequest: (
    url: string | URL
  ) => MaybePromise<RequestProxyPolicy | null | undefined>;
  hasAmbientProxyContext: () => MaybePromise<boolean>;
  hasConfiguredEnvironmentProxy: () => MaybePromise<boolean>;
  resolveProxyForConnection: (
    connectionId: string,
    apiKeyId: string | undefined,
    providerId: string,
    options: { fresh: true; skipFallback: true }
  ) => Promise<StoredProxyPolicy | null | undefined>;
}

// Supply BOTH identifiers: a missing providerId scans unrelated no-auth providers.
// This reserved, input-independent scope has no provider/account route to inherit.
const PINNED_TRANSPORT_SCOPE = "__pinned_transport_policy__";
const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
] as const;

// Importing this helper performs no environment or database reads. The defaults
// load/read policy only when called, and the stored resolver runs only if needed.
const defaultDependencies: PinnedTransportPolicyDependencies = {
  async resolveProxyForRequest(url) {
    const { resolveProxyForRequest } = await import("@omniroute/open-sse/utils/proxyFetch.ts");
    return resolveProxyForRequest(url);
  },
  async hasAmbientProxyContext() {
    const { hasAmbientProxyContext } = await import("@omniroute/open-sse/utils/proxyFetch.ts");
    return hasAmbientProxyContext();
  },
  hasConfiguredEnvironmentProxy() {
    return PROXY_ENV_KEYS.some((key) => Boolean(process.env[key]));
  },
  async resolveProxyForConnection(connectionId, apiKeyId, providerId, options) {
    const { resolveProxyForConnection } = await import("@/lib/db/settings");
    return resolveProxyForConnection(connectionId, apiKeyId, providerId, options);
  },
};

function denied(): Error & { code: string } {
  // Never include target URLs, proxy credentials, database errors, or causes.
  return Object.assign(new Error("Pinned direct transport is blocked by proxy policy"), {
    code: "PINNED_PROXY_UNSUPPORTED",
  });
}

/**
 * Admit a direct, DNS-pinned transport only when policy explicitly resolves direct.
 * Call before creating/dialing the transport, for every URL including redirects.
 * This is not URL/DNS validation and does not claim that a proxy can preserve a pin.
 *
 * Deliberately stricter than general proxy routing: configured proxy env vars
 * block this feature even under NO_PROXY, local-address rules, or a non-strict
 * direct sentinel. None of these override ambient, explicit, or stored proxies.
 * Null/undefined explicit config is NOT an override; every other value (even a
 * malformed/empty config) is conservatively denied.
 */
export async function assertPinnedTransportAllowed(
  url: string | URL,
  explicitProxyConfig?: unknown,
  overrides: Partial<PinnedTransportPolicyDependencies> = {}
): Promise<void> {
  const dependencies = { ...defaultDependencies, ...overrides };
  let requestPolicy: RequestProxyPolicy | null | undefined;
  try {
    // FIRST: preserve inherited requireProxy errors for NO_PROXY/local targets.
    requestPolicy = await dependencies.resolveProxyForRequest(url);
  } catch (error) {
    if (isRuntimePolicyError(error)) throw error;
    if (error instanceof Error && "code" in error && error.code === "PROXY_REQUIRED_EGRESS") {
      throw error;
    }
    assertNoApplicationProxy("opaque");
    throw denied();
  }
  try {
    const ambient = await dependencies.hasAmbientProxyContext();
    assertNoApplicationProxy(
      ambient !== false || (explicitProxyConfig !== undefined && explicitProxyConfig !== null)
        ? "opaque"
        : requestPolicy?.proxyUrl != null
          ? "configured"
          : requestPolicy?.source === "direct"
            ? "none"
            : "opaque"
    );
    if (
      ambient !== false ||
      requestPolicy?.source !== "direct" ||
      requestPolicy.proxyUrl !== null ||
      (explicitProxyConfig !== undefined && explicitProxyConfig !== null)
    ) {
      throw denied();
    }
    if ((await dependencies.hasConfiguredEnvironmentProxy()) !== false) {
      assertNoApplicationProxy("configured");
      throw denied();
    }

    const storedPolicy = await dependencies.resolveProxyForConnection(
      PINNED_TRANSPORT_SCOPE,
      undefined,
      PINNED_TRANSPORT_SCOPE,
      { fresh: true, skipFallback: true }
    );
    // Require affirmative direct policy, not just a falsey/partial proxy config.
    if (storedPolicy?.level !== "direct" || storedPolicy.proxy !== null) {
      assertNoApplicationProxy(storedPolicy?.proxy != null ? "configured" : "opaque");
      throw denied();
    }
  } catch (error) {
    if (isRuntimePolicyError(error)) throw error;
    assertNoApplicationProxy("opaque");
    throw denied();
  }
}
