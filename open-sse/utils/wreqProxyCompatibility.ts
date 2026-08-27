import { proxyConfigToUrl } from "./proxyDispatcher.ts";

export function isWreqProxyUrlSupported(proxyUrl: string): boolean {
  try {
    const parsed = new URL(proxyUrl);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      !parsed.searchParams.has("family")
    );
  } catch {
    return false;
  }
}

/** Return whether an assigned proxy can be represented by wreq's TLS transport. */
export function isWreqProxyCompatible(proxyConfig: unknown): boolean {
  try {
    const proxyUrl = proxyConfigToUrl(proxyConfig, { allowSocks5: true });
    return typeof proxyUrl === "string" && isWreqProxyUrlSupported(proxyUrl);
  } catch {
    return false;
  }
}
