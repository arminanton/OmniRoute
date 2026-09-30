import { RemoteMediaFetchError } from "@/shared/network/remoteImageFetch";

const FIXED_POLL_ORIGIN = "https://firefly-3p.ff.adobe.io";
const EPO_RESULT_ORIGIN = "https://firefly-epo855232.adobe.io";
const BKS_POLL_ORIGIN = "https://bks-epo8552.adobe.io";
const EPO_RESULT_PREFIX = "/jobs/result/";
const BKS_ROUTING_QUERY = "?host=firefly-epo855232.adobe.io";
const MAX_POLL_URL_LENGTH = 4096;

function rejectPollUrl(): never {
  // Do not echo a provider-controlled URL, query, or credential in a boundary error.
  throw new RemoteMediaFetchError(
    new Error("Adobe Firefly poll URL is not supported by the local safety policy")
  );
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((char) => {
    const code = char.charCodeAt(0);
    return code < 32 || (code >= 127 && code <= 159);
  });
}

function parsePollUrl(rawUrl: string): { parsed: URL; rawPath: string } {
  if (
    typeof rawUrl !== "string" ||
    !rawUrl ||
    rawUrl.length > MAX_POLL_URL_LENGTH ||
    /[\s\\]/.test(rawUrl) ||
    hasControlCharacters(rawUrl) ||
    rawUrl.includes("#")
  ) {
    rejectPollUrl();
  }
  const authority = /^https:\/\/([^/?#]+)/i.exec(rawUrl);
  if (!authority) rejectPollUrl();
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    rejectPollUrl();
  }
  // Reject parser repairs, encoded authorities and even an empty userinfo marker.
  // Explicit default HTTPS port is allowed; other ports and authority aliases are not.
  const rawAuthority = authority[1].toLowerCase();
  if (
    parsed.protocol !== "https:" ||
    parsed.href.length > MAX_POLL_URL_LENGTH ||
    parsed.username ||
    parsed.password ||
    (rawAuthority !== parsed.hostname && rawAuthority !== `${parsed.hostname}:443`)
  ) {
    rejectPollUrl();
  }
  return {
    parsed,
    rawPath: rawUrl.slice(authority[0].length).split("?", 1)[0] || "/",
  };
}

/**
 * Conservative compatibility/live-use gate, not a complete Adobe endpoint inventory.
 * Only fixed3p and the evidenced BKS shard are supported. Other shards/override origins
 * need contract evidence before admission. BKS supports only its exact routing query;
 * raw EPO query parameters are unsupported rather than silently discarded.
 *
 * Preserve the checked-in /jobs/result/<opaque suffix> EPO -> BKS mapping. The suffix
 * is opaque: do not infer a UUID, numeric shard derivation, or generic job-ID grammar.
 */
export function normalizeAdobePollUrl(rawUrl: string): string {
  const { parsed, rawPath } = parsePollUrl(rawUrl);
  let target = rawUrl;
  if (parsed.origin === EPO_RESULT_ORIGIN) {
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(rawPath);
    } catch {
      rejectPollUrl();
    }
    if (
      rawUrl.includes("?") ||
      !rawPath.startsWith(EPO_RESULT_PREFIX) ||
      rawPath.length === EPO_RESULT_PREFIX.length ||
      rawPath !== parsed.pathname ||
      hasControlCharacters(decodedPath) ||
      decodedPath.includes("\\") ||
      decodedPath.split("/").some((part) => part === "." || part === "..")
    ) {
      rejectPollUrl();
    }
    target = `${BKS_POLL_ORIGIN}/v2${rawPath}${BKS_ROUTING_QUERY}`;
  }

  // Revalidate the mapped destination too. Never map an unapproved raw origin into trust.
  const destination = parsePollUrl(target).parsed;
  if (destination.origin === FIXED_POLL_ORIGIN) return target;
  if (destination.origin === BKS_POLL_ORIGIN && destination.search === BKS_ROUTING_QUERY) {
    return target;
  }
  rejectPollUrl();
}
