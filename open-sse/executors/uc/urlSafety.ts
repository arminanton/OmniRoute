/** HTTPS-only destinations UC supplies for later server-side requests. */
export type UcRemoteUrlPurpose = "upload" | "image-result" | "video-result" | "direct-status";

const HOST_BY_PURPOSE: Record<UcRemoteUrlPurpose, string> = {
  upload: "d.moveinwater.com",
  "image-result": "gen.moveinwater.com",
  "video-result": "videogen.moveinwater.com",
  "direct-status": "api.uncensored.com",
};

/** Validate the exact destination before using a returned URL with fetch. */
export function validateUcRemoteUrl(raw: string, purpose: UcRemoteUrlPurpose): URL {
  // URL normalizes tabs, backslashes, credentials and the default :443 port.
  // Reject these in the original authority rather than trusting that normalization.
  const authority = /^https:\/\/([^/?#]+)/i.exec(raw)?.[1];
  if (!authority || /[\\:@\s\x00-\x1f\x7f]/.test(authority) || /[\\\s\x00-\x1f\x7f]/.test(raw)) {
    throw new Error(`UC ${purpose} URL must be credential-free HTTPS without a port`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`UC ${purpose} URL is invalid`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) {
    throw new Error(`UC ${purpose} URL must be credential-free HTTPS without a port or fragment`);
  }
  if (url.hostname !== HOST_BY_PURPOSE[purpose]) {
    throw new Error(`UC ${purpose} URL host is not allowed`);
  }
  // URL normalizes /./, /../ and encoded dot segments before pathname checks.
  // Reject those in the raw path, and keep percent escapes out of blob paths.
  const rawPath = raw.slice("https://".length + authority.length).split(/[?#]/, 1)[0];
  if (rawPath.includes("%") || rawPath.split("/").some((part) => part === "." || part === "..")) {
    throw new Error(`UC ${purpose} URL path is not allowed`);
  }
  // A blob/result is one file; direct job status may have nested path segments.
  const segment = "[A-Za-z0-9._~-]+";
  const pathPattern =
    purpose === "upload"
      ? new RegExp(`^/up/${segment}$`)
      : purpose === "direct-status"
        ? new RegExp(`^/api/v1/videos/${segment}(?:/${segment})*$`)
        : new RegExp(`^/${segment}$`);
  if (
    !pathPattern.test(url.pathname) ||
    url.pathname.split("/").some((part) => part === ".." || part === ".")
  ) {
    throw new Error(`UC ${purpose} URL path is not allowed`);
  }
  return url;
}

/** Blob names are path components, not URLs or paths. */
export function validateUcBlobName(value: string): string {
  if (!/^[A-Za-z0-9._-]{1,512}$/.test(value) || value === "." || value === "..") {
    throw new Error("UC blob name is invalid");
  }
  return value;
}
