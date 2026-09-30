import { randomBytes } from "node:crypto";
export const SOCKET = "/run/omniroute-browser-login/control.sock";
export const STATE = "/var/lib/omniroute-browser-login";
export const LOGINS = Object.freeze({
  "gemini-web": "https://gemini.google.com/",
  "chatgpt-web": "https://chatgpt.com/",
  "chatgpt-web-codex": "https://chatgpt.com/",
});
export const SESSION_ID = /^[a-f0-9]{64}$/;
export function assetPath(path) {
  return /^(core|vendor)\/[a-zA-Z0-9_./-]+\.js$/.test(path) &&
    !path.split("/").some((p) => p === ".." || p === ".")
    ? path
    : null;
}
export function owns(session, owner, connection) {
  return (
    !!session &&
    session.owner === owner &&
    session.connection === connection &&
    session.expires > Date.now()
  );
}

/** Reserve synchronously before any process or filesystem await. */
export function reserveLogin(sessions, input, now = Date.now()) {
  if (sessions.size >= 2 || [...sessions.values()].some((s) => s.connection === input.connection))
    throw new Error("Busy");
  const slot = [...sessions.values()].some((s) => s.slot === 0) ? 1 : 0;
  const session = {
    ...input,
    id: randomBytes(32).toString("hex"),
    slot,
    display: `:${90 + slot}`,
    rfbSocket: `${STATE}/.rfb-${slot}.sock`,
    expires: now + 10 * 60 * 1000,
    children: [],
    viewers: new Set(),
    initializing: true,
  };
  sessions.set(session.id, session);
  return session;
}

export function createSchemas(z) {
  const identity = z
    .object({
      owner: z.string().regex(SESSION_ID),
      connection: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    })
    .strict();
  return { identity, start: identity.extend({ provider: z.enum(Object.keys(LOGINS)) }).strict() };
}
