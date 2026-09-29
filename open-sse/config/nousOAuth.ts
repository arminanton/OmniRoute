/** Trusted Nous OAuth inference URLs; never infer these from user-supplied endpoints. */
export const NOUS_OAUTH_INFERENCE_PSD_KEY = "nousInferenceBaseUrl";
/** Issuer-registered public device-flow client, not an operator-supplied credential. */
export const NOUS_OAUTH_PUBLIC_CLIENT_ID = "hermes-cli";

export const NOUS_OAUTH_INFERENCE_BASE_URLS = [
  "https://inference-api.nousresearch.com/v1",
  "https://welcome-api.nousresearch.com/v1",
] as const;

/**
 * Accept only the two literal first-party inference bases. Exact matching rejects
 * URL-parser normalization tricks (userinfo, explicit ports, query/fragment,
 * escaped paths, trailing slash) rather than trying to repair unsafe values.
 */
export function validateNousOAuthInferenceBaseUrl(value: unknown): string {
  if (
    typeof value === "string" &&
    (NOUS_OAUTH_INFERENCE_BASE_URLS as readonly string[]).includes(value)
  ) {
    return value;
  }
  throw new Error("Invalid or missing Nous OAuth inference base URL");
}

/**
 * OAuth secrets may use direct egress or an HTTP(S) CONNECT proxy only.
 * Edge relays (Vercel/Deno/Cloudflare) terminate the request at their own
 * configurable host and would receive Authorization as a regular HTTP header.
 * A malformed assigned proxy must not silently become a direct connection.
 */
export function isNousOAuthDirectOrConnectProxy(proxy: unknown): boolean {
  if (proxy == null) return true;
  if (typeof proxy === "string") {
    try {
      const url = new URL(proxy);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }
  if (!proxy || typeof proxy !== "object" || Array.isArray(proxy)) return false;
  const config = proxy as { type?: unknown; host?: unknown };
  if (typeof config.host !== "string" || !config.host.trim()) return false;
  const type = typeof config.type === "string" ? config.type.toLowerCase() : "http";
  return type === "http" || type === "https";
}
