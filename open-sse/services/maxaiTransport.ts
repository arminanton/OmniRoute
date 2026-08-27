import { resolveProxyForConnection } from "@/lib/db/settings";
import {
  isTlsFingerprintActive,
  runWithProxyContext,
  runWithTlsTracking,
} from "../utils/proxyFetch.ts";
import { isWreqProxyCompatible } from "../utils/wreqProxyCompatibility.ts";

export class MaxaiTransportError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "MaxaiTransportError";
    this.status = status;
  }
}

interface MaxaiTransportDeps {
  resolveProxy?: typeof resolveProxyForConnection;
}

/** Apply the selected account proxy and required Windows Firefox 150 profile. */
export async function runMaxaiConnectionTransport<T>(
  connectionId: string,
  operation: () => T | Promise<T>,
  deps: MaxaiTransportDeps = {}
): Promise<Awaited<T>> {
  const resolveProxy = deps.resolveProxy ?? resolveProxyForConnection;
  let proxyInfo: Awaited<ReturnType<typeof resolveProxyForConnection>> | null;
  try {
    proxyInfo = await resolveProxy(connectionId);
  } catch {
    throw new MaxaiTransportError(502, "MaxAI connection transport could not be resolved");
  }

  const proxy = proxyInfo?.proxy || null;
  const tlsActive = isTlsFingerprintActive("maxai", Boolean(proxy));
  if (!tlsActive) {
    throw new MaxaiTransportError(
      503,
      "Required MaxAI Windows Firefox 150 transport is unavailable"
    );
  }
  if (proxy && !isWreqProxyCompatible(proxy)) {
    throw new MaxaiTransportError(
      502,
      "MaxAI Firefox TLS transport does not support the assigned proxy"
    );
  }

  const operationWithProxy = () => runWithProxyContext(proxy, operation);
  return (
    await runWithTlsTracking({ provider: "maxai", sessionScope: connectionId }, operationWithProxy)
  ).result;
}
