/** Provider error identifiers are untrusted data, not local transport provenance. */
const LOCAL_TRANSPORT_IDENTIFIERS = new Set([
  "PROXY_UNREACHABLE",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/** Keep ordinary upstream codes; discard every known local-network alias. */
export function projectProviderErrorIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  return LOCAL_TRANSPORT_IDENTIFIERS.has(value.trim().toUpperCase()) ? undefined : value;
}
