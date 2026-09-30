import { createPinnedFetch, type DnsLookup } from "./dnsPinnedFetch";
import { type OutboundUrlGuardMode } from "./outboundUrlGuard";
import { assertPinnedTransportAllowed } from "./pinnedTransportPolicy";
import {
  validateGuardedUrl,
  createOutboundDeadline,
  withOutboundAbort,
  resolveGuardedAddresses,
  cancelOutboundBody,
  readBoundedOutboundBody,
} from "./guardedPinnedFetch";

export { createPinnedFetch };
export type RemoteImageLookup = DnsLookup;

import { RemoteMediaFetchError } from "./mediaFailure";
export {
  RemoteMediaFetchError,
  createRemoteMediaFailureResult,
  isRemoteMediaFailureResult,
} from "./mediaFailure";
export type { RemoteMediaFailureResult } from "./mediaFailure";

const DEFAULT_MAX_REMOTE_IMAGE_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 15000;

export interface RemoteImageFetchOptions {
  enforceHttps?: boolean;
  /** Fake transport seam for tests only. Production must not reuse provider/global fetch. */
  fetchImpl?: typeof fetch;
  /** Compatibility option: guarded media always pins DNS, even when false is supplied. */
  pinDns?: boolean;
  /** Untrusted media defaults to public-only; admin provider flags cannot relax it. */
  guard?: OutboundUrlGuardMode;
  maxBytes?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  lookup?: RemoteImageLookup;
}

export interface RemoteImageFetchResult {
  buffer: Buffer<ArrayBuffer>;
  contentType: string;
  url: string;
}
export type RemoteMediaFetchOptions = RemoteImageFetchOptions;
export type RemoteMediaFetchResult = RemoteImageFetchResult;

function requireHttps(url: URL, enabled: boolean): URL {
  if (enabled && url.protocol !== "https:") {
    throw new Error("Remote media requires HTTPS at every redirect hop");
  }
  return url;
}

async function fetchRemoteMediaPinned(
  input: string | URL,
  options: RemoteMediaFetchOptions = {}
): Promise<RemoteMediaFetchResult> {
  const guard = options.guard ?? "public-only";
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_REMOTE_IMAGE_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 10) {
    throw new Error("Invalid remote media redirect limit");
  }
  const deadline = createOutboundDeadline(options.signal, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const { signal } = deadline;
  try {
    let currentUrl = requireHttps(validateGuardedUrl(input, guard), options.enforceHttps === true);
    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
      // A generic proxy may resolve the hostname elsewhere. It cannot preserve our pin.
      // No direct/fail-open fallback: refuse that transport before a request is sent.
      if (!options.fetchImpl) {
        await withOutboundAbort(() => assertPinnedTransportAllowed(currentUrl), signal);
      }
      const addresses = await resolveGuardedAddresses(currentUrl, guard, signal, options.lookup);
      const fetchImpl =
        options.fetchImpl ?? createPinnedFetch(addresses[0].address, addresses[0].family);
      const response = await withOutboundAbort(
        () =>
          fetchImpl(currentUrl.toString(), {
            method: "GET",
            redirect: "manual",
            signal,
            headers: { "user-agent": "omniroute-remote-media" },
          }),
        signal,
        cancelOutboundBody
      );
      if (response.status >= 300 && response.status < 400) {
        cancelOutboundBody(response);
        const location = response.headers.get("location");
        if (!location) throw new Error("Remote image redirect missing Location header");
        if (redirectCount >= maxRedirects)
          throw new Error(`Remote image exceeded ${maxRedirects} redirect limit`);
        const next = requireHttps(
          validateGuardedUrl(new URL(location, currentUrl), guard),
          options.enforceHttps === true
        );
        currentUrl = next;
        continue;
      }
      if (!response.ok) {
        cancelOutboundBody(response);
        throw new Error(`Remote image fetch error ${response.status}`);
      }
      return {
        buffer: await readBoundedOutboundBody(response, maxBytes, signal),
        contentType: response.headers.get("content-type") || "application/octet-stream",
        url: currentUrl.toString(),
      };
    }
    throw new Error(`Remote image exceeded ${maxRedirects} redirect limit`);
  } catch (error) {
    throw error instanceof RemoteMediaFetchError
      ? error
      : new RemoteMediaFetchError(error, options.signal?.aborted ? 499 : undefined);
  } finally {
    deadline.dispose();
  }
}

export async function fetchRemoteMedia(
  input: string | URL,
  options: RemoteMediaFetchOptions = {}
): Promise<RemoteMediaFetchResult> {
  try {
    return await fetchRemoteMediaPinned(input, options);
  } catch (error) {
    throw error instanceof RemoteMediaFetchError ? error : new RemoteMediaFetchError(error);
  }
}

export async function fetchRemoteImage(
  input: string | URL,
  options: RemoteImageFetchOptions = {}
): Promise<RemoteImageFetchResult> {
  return fetchRemoteMedia(input, options);
}
