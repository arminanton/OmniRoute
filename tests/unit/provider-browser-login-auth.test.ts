import { test } from "node:test";
import assert from "node:assert/strict";
import { SignJWT } from "jose";
import { z } from "zod";
import { browserLoginOwner } from "../../src/lib/providerBrowserLogin/auth.ts";
import {
  assetPath,
  owns,
  reserveLogin,
  createSchemas,
  LOGINS,
} from "../../scripts/deploy/residential/browser-login/policy.mjs";
import {
  browserLoginWsPath,
  handleBrowserLoginUpgrade,
} from "../../scripts/dev/browser-login-ws.mjs";
const origin = "https://dashboard.example.test";
test("browser login requires exact origin and an authenticated dashboard JWT, never API keys", async () => {
  const previous = {
    secret: process.env.JWT_SECRET,
    origin: process.env.OMNIROUTE_BROWSER_LOGIN_ORIGIN,
  };
  process.env.JWT_SECRET = "browser-login-test-only-signing-key";
  process.env.OMNIROUTE_BROWSER_LOGIN_ORIGIN = origin;
  try {
    const key = new TextEncoder().encode(process.env.JWT_SECRET);
    const token = await new SignJWT({ authenticated: true })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("5m")
      .sign(key);
    const request = (headers = {}, method = "POST") =>
      new Request(origin + "/api/providers/test/browser-login/start", {
        method,
        headers: { origin, cookie: `auth_token=${token}`, ...headers },
      });
    const owner = await browserLoginOwner(request());
    assert.match(owner!, /^[a-f0-9]{64}$/);
    assert.equal(
      await browserLoginOwner(request({ authorization: "Bearer manage-key", cookie: "" })),
      null
    );
    for (const bad of ["null", "", "https://evil.test", origin + ".evil.test", origin + "/"])
      assert.equal(await browserLoginOwner(request({ origin: bad })), null);
    assert.equal(await browserLoginOwner(request({ "sec-fetch-site": "cross-site" })), null);
    assert.equal(
      await browserLoginOwner(request({ cookie: `auth_token=${token}; auth_token=${token}` })),
      null
    );
    const bad = await new SignJWT({ authenticated: false })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("5m")
      .sign(key);
    assert.equal(await browserLoginOwner(request({ cookie: `auth_token=${bad}` })), null);
    const expired = await new SignJWT({ authenticated: true })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime(1)
      .sign(key);
    assert.equal(await browserLoginOwner(request({ cookie: `auth_token=${expired}` })), null);
    assert.equal(
      await browserLoginOwner(request({ origin: "", referer: origin + "/dashboard" }, "GET")),
      owner
    );
    assert.equal(
      await browserLoginOwner(request({ origin: "", referer: "https://evil.test/" }, "GET")),
      null
    );
    process.env.OMNIROUTE_BROWSER_LOGIN_ORIGIN = "";
    assert.equal(await browserLoginOwner(request()), null);
  } finally {
    if (previous.secret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previous.secret;
    if (previous.origin === undefined) delete process.env.OMNIROUTE_BROWSER_LOGIN_ORIGIN;
    else process.env.OMNIROUTE_BROWSER_LOGIN_ORIGIN = previous.origin;
  }
});
test("GUI assets and WebSocket paths cannot escape approved namespaces", () => {
  assert.equal(assetPath("core/rfb.js"), "core/rfb.js");
  assert.equal(assetPath("vendor/pako/lib/inflate.js"), "vendor/pako/lib/inflate.js");
  for (const path of [
    "core/../server.js",
    "core/./rfb.js",
    "core/%2e%2e/server.js",
    "/etc/passwd",
    "vnc.html",
    "core/rfb.js?token=x",
  ])
    assert.equal(assetPath(path), null);
  const base = `/api/providers/account-1/browser-login/${"a".repeat(64)}/ws`;
  assert.ok(browserLoginWsPath(base));
  for (const path of [base + "?token=x", base + "/", base.replace("account-1", "%2f")])
    assert.equal(browserLoginWsPath(path), null);
});
test("session ownership includes connection, owner and TTL", () => {
  const session = { owner: "one", connection: "a", expires: Date.now() + 60000 };
  assert.equal(owns(session, "one", "a"), true);
  assert.equal(owns(session, "two", "a"), false);
  assert.equal(owns(session, "one", "b"), false);
  assert.equal(owns({ ...session, expires: 0 }, "one", "a"), false);
  assert.equal(owns(undefined, "one", "a"), false);
});
test("WebSocket rejects unsupported browser-login upgrades without fallthrough", async () => {
  let destroyed = false;
  const socket = {
    destroy() {
      destroyed = true;
    },
  };
  assert.equal(
    await handleBrowserLoginUpgrade({ url: "/other", headers: {} }, socket, Buffer.alloc(0), {
      port: 1,
      secret: "test",
    }),
    false
  );
  assert.equal(
    await handleBrowserLoginUpgrade(
      { url: "/api/providers/a/browser-login/b/ws", headers: {} },
      socket,
      Buffer.alloc(0),
      { port: 1, secret: "test" }
    ),
    true
  );
  assert.equal(destroyed, true);
});

test("helper reserves at most two isolated slots and locks each account until cleanup", () => {
  const sessions = new Map();
  const one = reserveLogin(
    sessions,
    { connection: "a", owner: "one", provider: "gemini-web" },
    100
  );
  assert.equal(one.expires, 600100);
  assert.match(one.id, /^[a-f0-9]{64}$/);
  assert.throws(() =>
    reserveLogin(sessions, { connection: "a", owner: "other", provider: "chatgpt-web" })
  );
  const two = reserveLogin(sessions, { connection: "b", owner: "one", provider: "chatgpt-web" });
  assert.notEqual(one.slot, two.slot);
  assert.notEqual(one.id, two.id);
  assert.throws(() =>
    reserveLogin(sessions, { connection: "c", owner: "one", provider: "chatgpt-web" })
  );
  // Marking a session closing must not release its slot/profile before process exit.
  one.closing = true;
  assert.throws(() =>
    reserveLogin(sessions, { connection: "a", owner: "one", provider: "gemini-web" })
  );
  sessions.delete(one.id);
  assert.equal(
    reserveLogin(sessions, { connection: "c", owner: "one", provider: "chatgpt-web" }).slot,
    one.slot
  );
});

test("helper schema accepts fixed provider/account identity only, never commands or URLs", () => {
  const schemas = createSchemas(z);
  const valid = { owner: "a".repeat(64), connection: "account-1", provider: "gemini-web" };
  assert.deepEqual(schemas.start.parse(valid), valid);
  assert.deepEqual(Object.keys(LOGINS).sort(), ["chatgpt-web", "chatgpt-web-codex", "gemini-web"]);
  for (const field of ["url", "args", "argv", "path", "port", "command", "executable", "profile"])
    assert.equal(schemas.start.safeParse({ ...valid, [field]: "untrusted" }).success, false);
  for (const provider of ["__proto__", "constructor", "https://evil.test", "codex"])
    assert.equal(schemas.start.safeParse({ ...valid, provider }).success, false);
  assert.equal(schemas.start.safeParse({ ...valid, connection: "../other" }).success, false);
  assert.equal(schemas.start.safeParse({ ...valid, owner: "" }).success, false);
  assert.equal(
    schemas.identity.safeParse({
      owner: valid.owner,
      connection: valid.connection,
      url: "https://evil.test",
    }).success,
    false
  );
});

test("WS authorization revalidates session through a fixed internal route and never trusts owner headers", async () => {
  const oldOrigin = process.env.OMNIROUTE_BROWSER_LOGIN_ORIGIN;
  const oldSocket = process.env.OMNIROUTE_BROWSER_LOGIN_SOCKET;
  process.env.OMNIROUTE_BROWSER_LOGIN_ORIGIN = origin;
  process.env.OMNIROUTE_BROWSER_LOGIN_SOCKET = "/run/omniroute-browser-login/control.sock";
  let destroyed = false;
  let checked = false;
  try {
    const handled = await handleBrowserLoginUpgrade(
      {
        url: `/api/providers/account-1/browser-login/${"a".repeat(64)}/ws`,
        headers: {
          origin,
          host: "evil.test",
          authorization: "Bearer manage-key",
          "x-login-owner": "forged",
          "x-browser-login-bridge": "forged",
        },
      },
      {
        destroy() {
          destroyed = true;
        },
      },
      Buffer.alloc(0),
      {
        port: 1234,
        secret: "internal-test-only",
        fetchImpl: async (url: string, options: { headers: Record<string, string> }) => {
          checked = true;
          assert.equal(
            url,
            `http://127.0.0.1:1234/api/providers/account-1/browser-login/${"a".repeat(64)}/authorize`
          );
          assert.equal(options.headers["x-browser-login-bridge"], "internal-test-only");
          assert.equal(options.headers.authorization, undefined);
          assert.equal(options.headers["x-login-owner"], undefined);
          assert.equal(options.headers.cookie, "");
          return Response.json({}, { status: 403 });
        },
        requestImpl: () => {
          throw new Error("Denied requests must never touch the helper");
        },
      }
    );
    assert.equal(handled, true);
    assert.equal(checked, true);
    assert.equal(destroyed, true);
  } finally {
    if (oldOrigin === undefined) delete process.env.OMNIROUTE_BROWSER_LOGIN_ORIGIN;
    else process.env.OMNIROUTE_BROWSER_LOGIN_ORIGIN = oldOrigin;
    if (oldSocket === undefined) delete process.env.OMNIROUTE_BROWSER_LOGIN_SOCKET;
    else process.env.OMNIROUTE_BROWSER_LOGIN_SOCKET = oldSocket;
  }
});
