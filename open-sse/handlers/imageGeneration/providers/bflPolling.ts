import { RemoteMediaFetchError } from "@/shared/network/remoteImageFetch";

// The checked-in BFL registry documents only this origin. Do not wildcard bfl.ai
// or infer regional origins: require official offline documentation/operator
// approval before widening the credential audience. No backend path grammar is
// assumed; existing same-origin GET result paths remain compatible.
const BFL_POLLING_ORIGIN = "https://api.bfl.ai";
const MAX_BFL_POLLING_URL_LENGTH = 4096;

export function validateBflPollingUrl(input: unknown): URL {
  try {
    if (
      typeof input !== "string" ||
      input.length > MAX_BFL_POLLING_URL_LENGTH ||
      /[\u0000-\u0020\u007f\\]/.test(input)
    )
      throw new Error("invalid URL");
    const authority = /^https:\/\/([^/?#]*)/i.exec(input)?.[1];
    if (!authority || authority.includes("@")) throw new Error("invalid authority");
    const url = new URL(input);
    if (
      url.origin !== BFL_POLLING_ORIGIN ||
      url.username ||
      url.password ||
      url.href.includes("#") ||
      url.href.length > MAX_BFL_POLLING_URL_LENGTH
    ) {
      throw new Error("unapproved polling origin");
    }
    return url;
  } catch {
    // Never include a returned URL/token or provider-controlled text in a public error.
    throw new RemoteMediaFetchError(new Error("Blocked BFL polling URL"));
  }
}

export function rejectBflRedirect(response: Response): void {
  if (response.status >= 300 && response.status < 400) {
    void response.body?.cancel().catch(() => {});
    throw new RemoteMediaFetchError(new Error("BFL credential-bearing redirect blocked"));
  }
}
