import {
  createPinnedFetch,
  defaultDnsLookup,
  resolveHostnameAddresses,
  type DnsLookup,
  type DnsLookupResult,
} from "@/shared/network/dnsPinnedFetch";
import {
  isCloudMetadataHost,
  isPrivateHost,
  OutboundUrlGuardError,
  parseOutboundUrl,
  PROVIDER_URL_BLOCKED_MESSAGE,
} from "@/shared/network/outboundUrlGuard";
import { arePrivateProviderUrlsAllowed } from "@/shared/network/outboundUrlGuardPolicy";
import { isIP } from "node:net";

/**
 * #12569 — DNS-resolve-then-pin fetch for webhook outbound calls (custom webhook delivery +
 * the webhook test-diagnostics endpoint). `parseAndValidateWebhookUrl` in
 * `outboundUrlGuardPolicy.ts` only classifies the literal hostname STRING, so a hostname an
 * attacker controls (DNS pointed at 169.254.169.254 / an RFC1918 address) passed that guard
 * and reached the real `fetch()` unmodified. This module checks the literal URL and every
 * resolved A/AAAA answer, pins a validated address at connection time, and rechecks every
 * redirect. Private destinations require an explicit operator opt-in (or an exact approved
 * hostname); metadata/link-local addresses are never allowed.
 */

const DEFAULT_MAX_REDIRECTS = 3;

export interface WebhookFetchOptions {
  /** DNS resolver override. Tests inject a fake resolver to avoid real network lookups. */
  lookup?: DnsLookup;
  /** Fake transport override for unit tests; production uses pinned Undici directly. */
  fetchImpl?: typeof fetch;
  maxRedirects?: number;
  signal?: AbortSignal;
}

export interface WebhookFetchResult {
  response: Response;
  finalUrl: string;
  /** True when a resolved hop is a private address explicitly allowed via opt-in — the
   * caller must not surface the upstream response body for such a target (#3269). */
  redactBody: boolean;
}

/**
 * An exact hostname approved by the operator may resolve to a private LAN/Tailscale IP.
 * No wildcards or suffix matches: an attacker-controlled subdomain must not inherit approval.
 * Existing private literals, .local and single-label Docker names retain the established
 * OMNIROUTE_ALLOW_PRIVATE_PROVIDER_URLS opt-in. Public-looking DNS names need this scoped
 * approval too, rather than making a provider-wide opt-in allow arbitrary DNS rebinding.
 */
const APPROVED_PRIVATE_HOSTS_ENV = "OMNIROUTE_ALLOWED_PRIVATE_WEBHOOK_HOSTS";

function isApprovedPrivateHostname(hostname: string): boolean {
  const exactHost = hostname.toLowerCase().replace(/\.$/, "");
  return (
    exactHost.length > 0 &&
    (process.env[APPROVED_PRIVATE_HOSTS_ENV] ?? "")
      .split(",")
      .some((entry) => entry.trim().toLowerCase() === exactHost)
  );
}

function isPrivateDestinationAllowed(url: URL): boolean {
  if (isApprovedPrivateHostname(url.hostname)) return true;
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  return arePrivateProviderUrlsAllowed() && (isPrivateHost(hostname) || !hostname.includes("."));
}

/** Link-local / multicast addresses have no valid webhook use even with private opt-in. */
function isForbiddenSpecialHost(hostname: string): boolean {
  const address = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isCloudMetadataHost(address)) return true;
  if (isIP(address) === 6) {
    const first = Number.parseInt(address.split(":", 1)[0], 16);
    return (first >= 0xfe80 && first <= 0xfebf) || (first >= 0xff00 && first <= 0xffff);
  }
  if (isIP(address) === 4) return Number(address.split(".", 1)[0]) >= 224;
  return false;
}

/** Reject the entire DNS answer set if any A or AAAA address is invalid or disallowed. */
function assertAddressesAllowed(addresses: DnsLookupResult[], url: URL): boolean {
  let sawPrivate = false;
  for (const { address, family } of addresses) {
    if (
      isIP(address) !== family ||
      isForbiddenSpecialHost(address) ||
      (isPrivateHost(address) && !isPrivateDestinationAllowed(url))
    ) {
      throw new OutboundUrlGuardError(PROVIDER_URL_BLOCKED_MESSAGE, {
        code: "OUTBOUND_URL_GUARD_BLOCKED",
        url: url.toString(),
        hostname: address,
      });
    }
    if (isPrivateHost(address)) sawPrivate = true;
  }
  return sawPrivate || isPrivateHost(url.hostname);
}

/** Stop awaiting a hung DNS lookup as soon as the delivery deadline fires. */
async function resolveWithAbort(hostname: string, lookup: DnsLookup, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!signal) return resolveHostnameAddresses(hostname, lookup);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([resolveHostnameAddresses(hostname, lookup), aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

async function resolveHop(
  currentUrl: string | URL,
  lookup: DnsLookup,
  signal?: AbortSignal
): Promise<{ url: URL; addresses: DnsLookupResult[]; redactBody: boolean }> {
  const url = parseOutboundUrl(currentUrl);
  // Preserve the existing literal-hostname block on every hop, not only the resolved-IP
  // block. In particular, metadata.google.internal stays forbidden even if DNS returns
  // a public address. Exact operator-approved private hosts may bypass the old opt-in.
  if (
    isForbiddenSpecialHost(url.hostname) ||
    (isPrivateHost(url.hostname) && !isPrivateDestinationAllowed(url))
  ) {
    throw new OutboundUrlGuardError(PROVIDER_URL_BLOCKED_MESSAGE, {
      code: "OUTBOUND_URL_GUARD_BLOCKED",
      url: url.toString(),
      hostname: url.hostname,
    });
  }
  let addresses: DnsLookupResult[];
  try {
    addresses = await resolveWithAbort(url.hostname, lookup, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new OutboundUrlGuardError("Webhook host could not be resolved (blocked)", {
      code: "OUTBOUND_URL_GUARD_BLOCKED",
      url: url.toString(),
      hostname: url.hostname || null,
    });
  }
  signal?.throwIfAborted();
  const redactBody = assertAddressesAllowed(addresses, url);
  return { url, addresses, redactBody };
}

function pickFetchImpl(
  fetchImpl: typeof fetch | undefined,
  addresses: DnsLookupResult[]
): typeof fetch {
  // Production never falls back to an unpinned fetch. The override is only for fake
  // transports in tests; production callers cannot pass it via WebhookDeliveryOptions.
  if (fetchImpl) return fetchImpl;
  return createPinnedFetch(addresses[0].address, addresses[0].family);
}

function nextRedirectUrl(
  response: Response,
  currentUrl: URL,
  redirectCount: number,
  maxRedirects: number
): URL {
  const location = response.headers.get("location");
  if (!location) {
    throw new OutboundUrlGuardError("Webhook redirect missing Location header", {
      code: "OUTBOUND_URL_INVALID",
      url: currentUrl.toString(),
    });
  }
  if (redirectCount >= maxRedirects) {
    throw new OutboundUrlGuardError(`Webhook exceeded ${maxRedirects} redirect limit`, {
      code: "OUTBOUND_URL_GUARD_BLOCKED",
      url: currentUrl.toString(),
    });
  }
  try {
    return new URL(location, currentUrl);
  } catch {
    throw new OutboundUrlGuardError("Webhook redirect has invalid Location header", {
      code: "OUTBOUND_URL_INVALID",
      url: currentUrl.toString(),
    });
  }
}

function redirectRequest(init: RequestInit, response: Response, from: URL, to: URL): RequestInit {
  const headers = new Headers(init.headers);
  const method = (init.method ?? "GET").toUpperCase();
  const rewriteToGet =
    (response.status === 303 && method !== "GET" && method !== "HEAD") ||
    (method === "POST" && (response.status === 301 || response.status === 302));
  if (rewriteToGet) {
    for (const name of ["content-type", "content-length", "transfer-encoding"]) {
      headers.delete(name);
    }
  }
  if (rewriteToGet || from.origin !== to.origin) {
    // Do not send an HMAC or credentials to a different service, even if a webhook
    // destination (or a public redirect) chooses the redirect Location.
    for (const name of [
      "x-webhook-signature",
      "x-webhook-event",
      "x-webhook-timestamp",
      "authorization",
      "cookie",
      "proxy-authorization",
    ])
      headers.delete(name);
  }
  return {
    ...init,
    method: rewriteToGet ? "GET" : init.method,
    body: rewriteToGet ? undefined : init.body,
    headers,
  };
}

/**
 * DNS-resolve-then-pin POST/GET for a webhook URL, following redirects manually and
 * revalidating DNS at every hop. Throws `OutboundUrlGuardError` when the target (or a
 * redirect target) resolves to a blocked address.
 */
export async function fetchWebhookUrl(
  input: string,
  init: RequestInit,
  options: WebhookFetchOptions = {}
): Promise<WebhookFetchResult> {
  const lookup = options.lookup ?? defaultDnsLookup;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  let currentUrl: string | URL = input;
  let currentInit = init;
  let redactBody = false;

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
    const hop = await resolveHop(currentUrl, lookup, options.signal ?? init.signal ?? undefined);
    redactBody = redactBody || hop.redactBody;
    const fetchImpl = pickFetchImpl(options.fetchImpl, hop.addresses);
    const response = await fetchImpl(hop.url.toString(), {
      ...currentInit,
      redirect: "manual",
      signal: options.signal ?? currentInit.signal,
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      try {
        const next = nextRedirectUrl(response, hop.url, redirectCount, maxRedirects);
        currentInit = redirectRequest(currentInit, response, hop.url, next);
        currentUrl = next;
      } finally {
        try {
          await response.body?.cancel();
        } catch {
          /* preserve redirect/guard failure */
        }
      }
      continue;
    }

    return { response, finalUrl: hop.url.toString(), redactBody };
  }

  throw new OutboundUrlGuardError(`Webhook exceeded ${maxRedirects} redirect limit`, {
    code: "OUTBOUND_URL_GUARD_BLOCKED",
    url: String(input),
  });
}
