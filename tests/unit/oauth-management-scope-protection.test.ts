/**
 * OAuth credential mutation routes must require management scope even though
 * `/api/oauth/` is classified as a public prefix for browser callback flows.
 * These handler-level probes use malformed input or unknown sessions so a
 * management credential can clear the auth gate without calling providers.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-oauth-manage-scope-"));
const TEST_HOME = path.join(TEST_DATA_DIR, "home");
const TEST_CLIPROXY_DIR = path.join(TEST_HOME, ".cli-proxy-api");
fs.mkdirSync(TEST_CLIPROXY_DIR, { recursive: true });
const ORIGINALS = {
  DATA_DIR: process.env.DATA_DIR,
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CLIPROXYAPI_CONFIG_DIR: process.env.CLIPROXYAPI_CONFIG_DIR,
  API_KEY_SECRET: process.env.API_KEY_SECRET,
  INITIAL_PASSWORD: process.env.INITIAL_PASSWORD,
  JWT_SECRET: process.env.JWT_SECRET,
  DISABLE_SQLITE_AUTO_BACKUP: process.env.DISABLE_SQLITE_AUTO_BACKUP,
  OMNIROUTE_DISABLE_REDIS_AUTH_CACHE: process.env.OMNIROUTE_DISABLE_REDIS_AUTH_CACHE,
};

process.env.DATA_DIR = TEST_DATA_DIR;
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.CLIPROXYAPI_CONFIG_DIR = TEST_CLIPROXY_DIR;
process.env.API_KEY_SECRET = "oauth-manage-scope-test-api-key-secret";
process.env.INITIAL_PASSWORD = "oauth-manage-scope-test-password";
process.env.JWT_SECRET = "oauth-manage-scope-test-jwt-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.OMNIROUTE_DISABLE_REDIS_AUTH_CACHE = "1";

const core = await import("../../src/lib/db/core.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const kiroApiKeyRoute = await import("../../src/app/api/oauth/kiro/api-key/route.ts");
const kiroSocialAuthorizeRoute =
  await import("../../src/app/api/oauth/kiro/social-authorize/route.ts");
const kiroSocialExchangeRoute =
  await import("../../src/app/api/oauth/kiro/social-exchange/route.ts");
const cursorLoginStartRoute = await import("../../src/app/api/oauth/cursor/login/start/route.ts");
const cursorLoginPollRoute = await import("../../src/app/api/oauth/cursor/login/poll/route.ts");
const cursorLoginCancelRoute = await import("../../src/app/api/oauth/cursor/login/cancel/route.ts");
const cursorLoginService = await import("../../src/lib/oauth/services/cursorLogin.ts");
const cursorAutoImportRoute = await import("../../src/app/api/oauth/cursor/auto-import/route.ts");
const cursorImportRoute = await import("../../src/app/api/oauth/cursor/import/route.ts");
const kiroAutoImportRoute = await import("../../src/app/api/oauth/kiro/auto-import/route.ts");
const kiroImportRoute = await import("../../src/app/api/oauth/kiro/import/route.ts");
const codexImportTokenRoute = await import("../../src/app/api/oauth/codex/import-token/route.ts");
const codexImportRoute = await import("../../src/app/api/oauth/codex/import/route.ts");
const cliProxyImportRoute = await import("../../src/app/api/oauth/cliproxy-import/route.ts");
const traeImportRoute = await import("../../src/app/api/oauth/trae/import/route.ts");
const pasteCredentialsRoute =
  await import("../../src/app/api/oauth/[provider]/paste-credentials/route.ts");
const oauthActionRoute = await import("../../src/app/api/oauth/[provider]/[action]/route.ts");

type Handler = (request: Request) => Promise<Response>;
type Probe = { label: string; handler: Handler; url: string; body?: unknown; passStatus: number };

function makeRequest(url: string, method: string, body: unknown, key?: string): Request {
  const headers = new Headers();
  if (key) headers.set("authorization", `Bearer ${key}`);
  if (body !== undefined) headers.set("content-type", "application/json");
  return new Request(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test.before(async () => {
  await settingsDb.updateSettings({ requireLogin: true });
  await apiKeysDb.resetApiKeyState();
});

test.after(() => {
  cursorLoginService.clearCursorLoginSessions();
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  for (const [key, value] of Object.entries(ORIGINALS)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("OAuth credential handlers require a manage key and stop before provider calls", async (t) => {
  const inferenceKey = await apiKeysDb.createApiKey("inference-only", "machine-inference", []);
  const manageKey = await apiKeysDb.createApiKey("management", "machine-management", ["manage"]);

  const probes: Probe[] = [
    {
      label: "POST /api/oauth/kiro/api-key",
      handler: (request) => kiroApiKeyRoute.POST(request),
      url: "http://localhost/api/oauth/kiro/api-key",
      body: {},
      passStatus: 400,
    },
    {
      label: "GET /api/oauth/kiro/social-authorize",
      handler: (request) => kiroSocialAuthorizeRoute.GET(request),
      url: "http://localhost/api/oauth/kiro/social-authorize",
      passStatus: 400,
    },
    {
      label: "POST /api/oauth/kiro/social-exchange",
      handler: (request) => kiroSocialExchangeRoute.POST(request),
      url: "http://localhost/api/oauth/kiro/social-exchange",
      body: {},
      passStatus: 400,
    },
    {
      label: "POST /api/oauth/cursor/login/start",
      handler: (request) => cursorLoginStartRoute.POST(request),
      url: "http://localhost/api/oauth/cursor/login/start",
      passStatus: 200,
    },
    {
      label: "POST /api/oauth/cursor/login/poll",
      handler: (request) => cursorLoginPollRoute.POST(request),
      url: "http://localhost/api/oauth/cursor/login/poll",
      body: { sessionId: "missing-cursor-login-session" },
      passStatus: 410,
    },
    {
      label: "POST /api/oauth/cursor/login/cancel",
      handler: (request) => cursorLoginCancelRoute.POST(request),
      url: "http://localhost/api/oauth/cursor/login/cancel",
      body: { sessionId: "missing-cursor-login-session" },
      passStatus: 200,
    },
    {
      label: "GET /api/oauth/cursor/auto-import",
      handler: (request) => cursorAutoImportRoute.GET(request),
      url: "http://localhost/api/oauth/cursor/auto-import",
      passStatus: 200,
    },
    {
      label: "GET /api/oauth/cursor/import",
      handler: (request) => cursorImportRoute.GET(request),
      url: "http://localhost/api/oauth/cursor/import",
      passStatus: 200,
    },
    {
      label: "POST /api/oauth/cursor/import",
      handler: (request) => cursorImportRoute.POST(request),
      url: "http://localhost/api/oauth/cursor/import",
      body: {},
      passStatus: 400,
    },
    {
      label: "GET /api/oauth/kiro/auto-import",
      handler: (request) => kiroAutoImportRoute.GET(request),
      url: "http://localhost/api/oauth/kiro/auto-import",
      passStatus: 200,
    },
    {
      label: "POST /api/oauth/kiro/import",
      handler: (request) => kiroImportRoute.POST(request),
      url: "http://localhost/api/oauth/kiro/import",
      body: {},
      passStatus: 400,
    },
    {
      label: "POST /api/oauth/codex/import-token",
      handler: (request) => codexImportTokenRoute.POST(request),
      url: "http://localhost/api/oauth/codex/import-token",
      body: { session: {} },
      passStatus: 400,
    },
    {
      label: "POST /api/oauth/codex/import",
      handler: (request) => codexImportRoute.POST(request),
      url: "http://localhost/api/oauth/codex/import",
      body: { accounts: [] },
      passStatus: 400,
    },
    {
      label: "GET /api/oauth/cliproxy-import",
      handler: (request) => cliProxyImportRoute.GET(request),
      url: "http://localhost/api/oauth/cliproxy-import",
      passStatus: 200,
    },
    {
      label: "POST /api/oauth/cliproxy-import",
      handler: (request) => cliProxyImportRoute.POST(request),
      url: "http://localhost/api/oauth/cliproxy-import",
      passStatus: 200,
    },
    {
      label: "GET /api/oauth/trae/import",
      handler: (request) => traeImportRoute.GET(request),
      url: "http://localhost/api/oauth/trae/import",
      passStatus: 200,
    },
    {
      label: "POST /api/oauth/trae/import",
      handler: (request) => traeImportRoute.POST(request),
      url: "http://localhost/api/oauth/trae/import",
      body: {},
      passStatus: 400,
    },
    {
      label: "POST /api/oauth/{provider}/paste-credentials",
      handler: (request) =>
        pasteCredentialsRoute.POST(request, {
          params: Promise.resolve({ provider: "antigravity" }),
        }),
      url: "http://localhost/api/oauth/antigravity/paste-credentials",
      body: {},
      passStatus: 400,
    },
    {
      label: "POST /api/oauth/{provider}/exchange",
      handler: (request) =>
        oauthActionRoute.POST(request, {
          params: Promise.resolve({ provider: "grok-cli", action: "exchange" }),
        }),
      url: "http://localhost/api/oauth/grok-cli/exchange",
      body: {},
      passStatus: 400,
    },
    {
      label: "POST /api/oauth/{provider}/poll",
      handler: (request) =>
        oauthActionRoute.POST(request, {
          params: Promise.resolve({ provider: "grok-cli", action: "poll" }),
        }),
      url: "http://localhost/api/oauth/grok-cli/poll",
      body: {},
      passStatus: 400,
    },
    {
      label: "POST /api/oauth/{provider}/import-token",
      handler: (request) =>
        oauthActionRoute.POST(request, {
          params: Promise.resolve({ provider: "openai", action: "import-token" }),
        }),
      url: "http://localhost/api/oauth/openai/import-token",
      body: { token: "test-token" },
      passStatus: 400,
    },
    {
      label: "POST /api/oauth/{provider}/device-complete",
      handler: (request) =>
        oauthActionRoute.POST(request, {
          params: Promise.resolve({ provider: "codex", action: "device-complete" }),
        }),
      url: "http://localhost/api/oauth/codex/device-complete",
      body: {},
      passStatus: 400,
    },
  ];

  let fetchCalls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetchCalls += 1;
    throw new Error("External provider calls are forbidden in this auth-gate test");
  });

  for (const probe of probes) {
    const method = probe.label.startsWith("GET ") ? "GET" : "POST";
    const noCredential = await probe.handler(makeRequest(probe.url, method, probe.body));
    assert.equal(noCredential.status, 401, `${probe.label}: missing credential`);

    const ordinaryKey = await probe.handler(
      makeRequest(probe.url, method, probe.body, inferenceKey.key)
    );
    assert.equal(ordinaryKey.status, 403, `${probe.label}: inference-only key`);

    const managementKey = await probe.handler(
      makeRequest(probe.url, method, probe.body, manageKey.key)
    );
    assert.equal(
      managementKey.status,
      probe.passStatus,
      `${probe.label}: management key must pass auth and reach safe validation/session handling`
    );

    if (probe.label === "POST /api/oauth/cursor/login/start") {
      const { sessionId } = (await managementKey.json()) as { sessionId: string };
      cursorLoginService.cancelCursorLoginSession(sessionId);
    }
  }

  assert.equal(fetchCalls, 0, "no OAuth provider endpoint should be contacted");
});
