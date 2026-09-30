import { createHash } from "node:crypto";
export const PROVIDERS = Object.freeze({
  "gemini-web": "https://gemini.google.com/app",
  "chatgpt-web": "https://chatgpt.com/",
  "chatgpt-web-codex": "https://chatgpt.com/",
});
export function validateIdentity(value) {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.connectionId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(value.connectionId) ||
    !Object.hasOwn(PROVIDERS, value.providerId) ||
    typeof value.owner !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.owner)
  ) {
    throw new Error("Invalid browser login identity");
  }
  return { connectionId: value.connectionId, providerId: value.providerId, owner: value.owner };
}
export function profileSegment(identity) {
  return createHash("sha256")
    .update(identity.providerId)
    .update("\0")
    .update(identity.connectionId)
    .digest("hex");
}
export function filterStorageState(providerId, state) {
  const domain = providerId === "gemini-web" ? "google.com" : "chatgpt.com";
  const origin = providerId === "gemini-web" ? "https://gemini.google.com" : "https://chatgpt.com";
  return {
    cookies: state.cookies.filter((cookie) => {
      const host = cookie.domain.replace(/^\./, "");
      return host === domain || host.endsWith(`.${domain}`);
    }),
    origins: state.origins.filter((entry) => entry.origin === origin),
  };
}
