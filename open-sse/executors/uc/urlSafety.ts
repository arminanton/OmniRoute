/**
 * Strict allow-list for URLs UC returns and OmniRoute subsequently fetches.
 *
 * These URLs are server-supplied, but blindly following them would turn a
 * compromised/malformed upstream response into an SSRF primitive. Keep each
 * purpose tied to the exact HTTPS host captured for that flow.
 */

export type UcRemoteUrlPurpose = "upload" | "image-result" | "video-result" | "direct-status";

const HOST_BY_PURPOSE: Record<UcRemoteUrlPurpose, string> = {
  upload: "d.moveinwater.com",
  "image-result": "gen.moveinwater.com",
  "video-result": "videogen.moveinwater.com",
  "direct-status": "api.uncensored.com",
};

export function validateUcRemoteUrl(raw: string, purpose: UcRemoteUrlPurpose): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`UC ${purpose} URL is invalid`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new Error(`UC ${purpose} URL must be credential-free HTTPS`);
  }
  if (url.hostname.toLowerCase() !== HOST_BY_PURPOSE[purpose]) {
    throw new Error(`UC ${purpose} URL host is not allowed`);
  }
  if (purpose === "upload" && !url.pathname.startsWith("/up/")) {
    throw new Error("UC upload URL path is not allowed");
  }
  if (purpose === "direct-status" && !url.pathname.startsWith("/api/v1/videos/")) {
    throw new Error("UC direct status URL path is not allowed");
  }
  return url;
}

export function validateUcBlobName(value: string): string {
  const name = value.trim();
  if (!/^[A-Za-z0-9._-]{1,512}$/.test(name)) {
    throw new Error("UC blob name is invalid");
  }
  return name;
}
