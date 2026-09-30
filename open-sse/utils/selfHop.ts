/** Process-local proof for HTTP hops to this listener. Never an API credential. */
import { randomBytes, timingSafeEqual } from "node:crypto";

export const SELF_HOP_HEADER = "x-omniroute-self-hop";
const TOKEN_SLOT = Symbol.for("omniroute.own-listener-self-hop.v1");
const processState = globalThis as typeof globalThis & { [TOKEN_SLOT]?: string };

export function ownListenerSelfHopToken(): string {
  // Share across server bundles in this process, not across processes/listeners.
  return (processState[TOKEN_SLOT] ??= randomBytes(32).toString("hex"));
}

export function listenPort(): string {
  const value = process.env.PORT || process.env.DASHBOARD_PORT || process.env.API_PORT || "20128";
  if (!/^\d+$/.test(value)) return "";
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? String(port) : "";
}

export function isOwnListenerUrl(raw: string): boolean {
  try {
    // Reject URL parser aliases (integer/hex IPv4, userinfo, encoded hosts).
    if (!/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?(?:[/?#]|$)/i.test(raw))
      return false;
    const url = new URL(raw);
    // Next's in-process listener is HTTP. TLS terminates outside this listener.
    if (url.protocol !== "http:" || url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    const loopback = host === "127.0.0.1" || host === "localhost" || host === "[::1]";
    return loopback && (url.port || "80") === listenPort();
  } catch {
    return false;
  }
}

const OWN_API_PATHS = new Set([
  "/v1/chat/completions",
  "/api/v1/chat/completions",
  "/v1/audio/transcriptions",
  "/api/v1/audio/transcriptions",
]);

export function isOwnListenerApiUrl(raw: string): boolean {
  return isOwnListenerUrl(raw) && OWN_API_PATHS.has(new URL(raw).pathname);
}

export function isOwnListenerSelfHop(value: string | null | undefined): boolean {
  if (!value || !/^[a-f0-9]{64}$/.test(value)) return false;
  const got = Buffer.from(value);
  const expected = Buffer.from(ownListenerSelfHopToken());
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/** Stamp only the owned listener; strip forwarded proof everywhere else. */
export function stampOwnListenerSelfHop(
  input: RequestInfo | URL,
  options: { headers?: HeadersInit; redirect?: RequestRedirect }
): boolean {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const headers = new Headers(
    options.headers ?? (input instanceof Request ? input.headers : undefined)
  );
  const ownListener = isOwnListenerApiUrl(raw);
  if (ownListener) {
    // Always replace untrusted forwarded headers. Never leak proof through a redirect.
    headers.set(SELF_HOP_HEADER, ownListenerSelfHopToken());
    options.redirect = "manual";
  } else {
    headers.delete(SELF_HOP_HEADER);
  }
  options.headers = headers;
  return ownListener;
}

/** Validate explicit opt-in at the transport boundary. This never mints proof. */
export function prepareOwnListenerSelfHop(
  input: RequestInfo | URL,
  options: { headers?: HeadersInit; redirect?: RequestRedirect }
): boolean {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const headers = new Headers(
    options.headers ?? (input instanceof Request ? input.headers : undefined)
  );
  const proof = headers.get(SELF_HOP_HEADER);
  const legacyBypass = headers.has("x-omniroute-admission-bypass");
  const ownHop = isOwnListenerApiUrl(raw) && isOwnListenerSelfHop(proof);
  if (ownHop) {
    options.redirect = "manual";
  } else {
    headers.delete(SELF_HOP_HEADER);
  }
  // Legacy in-process proof must not travel as provider auth either.
  const bearer = /^bearer\s+(\S+)$/i.exec((headers.get("authorization") || "").trim());
  const legacyProof = !!bearer && isOwnListenerSelfHop(bearer[1]);
  if (!ownHop && legacyProof) headers.delete("authorization");
  if (!ownHop) headers.delete("x-omniroute-admission-bypass");
  if (proof !== null || legacyProof || legacyBypass) {
    options.headers = headers;
  }
  return ownHop;
}
