import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { SignJWT } from "jose";
import { NextRequest } from "next/server";
import type { PolicyContext } from "../../../src/server/authz/context.ts";

// An isolated locked-reader fixture. Only storage/service boundaries are replaced;
// the management gates, JWT, access scopes, peer rules and CSRF pipeline are real.
// No activation mount, real database, provider, helper or network is used.
const state = {
  settings: {} as Record<string, unknown>,
  settingsReads: 0,
  settingsImports: 0,
  settingsWrites: [] as Record<string, unknown>[],
  onboardingReadEffects: 0,
  candidateReads: [] as Record<string, unknown>[],
  admittedCandidates: [] as Record<string, unknown>[],
  policyNamespaces: {} as Record<string, unknown>,
  configError: null as Error | null,
  keys: new Map<string, { id: string; scopes: string[] }>(),
  accessTokens: new Map<string, { id: string; name: string; scope: string }>(),
  keyError: false,
  requireApiKey: false,
  policyError: null as Error | null,
};
const symbol = Symbol.for("omniroute.test.runtime-policy-management");
Object.defineProperty(globalThis, symbol, { value: state, configurable: true });
const prelude = `const s = globalThis[Symbol.for("omniroute.test.runtime-policy-management")];`;
const policyModuleUrl = new URL("../../../scripts/build/runtime-policy.mjs", import.meta.url).href;
const stubs = new Map([
  [
    "/scripts/build/runtime-policy.mjs",
    `export * from ${JSON.stringify(policyModuleUrl)};
     export const requiresLockedManagementAuth = () => {
       if (s.policyError) throw s.policyError;
       return true;
     };`,
  ],
  [
    "/lib/db/settings",
    `export async function getSettings(options) {
       s.settingsReads++;
       if (options?.autoCompleteSetup !== false) s.onboardingReadEffects++;
       return s.settings;
     }
     export const getCachedSettings = getSettings;
     export async function getRuntimePolicySettingsCandidate(updates = {}) {
       s.candidateReads.push(updates);
       return { ...await getSettings({ autoCompleteSetup: false }), ...updates, ...s.policyNamespaces };
     }
     export async function updateSettings(update) {
       const candidate = { ...s.settings, ...update };
       if (candidate.requireLogin === false) {
         throw new Error("fixture writer rejected disabled authentication");
       }
       s.settingsWrites.push(update);
       s.settings = candidate;
       return s.settings;
     }`,
  ],
  ["/lib/db/readCache", "export async function getCachedSettings() { return s.settings; }"],
  [
    "/lib/db/apiKeys",
    `export async function validateApiKey(key) {
       if (s.keyError) throw new Error("fixture private DB detail");
       return s.keys.has(key);
     }
     export async function getApiKeyMetadata(key) { return s.keys.get(key) ?? null; }`,
  ],
  [
    "/sse/services/auth",
    `export function extractApiKey(request, options) {
       const token = /^Bearer\\s+(.+)$/i.exec(request.headers?.get("authorization") ?? "")?.[1];
       if (token) return token;
       if (options?.allowUrl === false || !request.url) return null;
       return new URL(request.url).searchParams.get("token");
     }
     export async function isValidApiKey(key) {
       if (s.keyError) throw new Error("fixture private DB detail");
       return s.keys.has(key);
     }`,
  ],
  [
    "/lib/db/accessTokens",
    "export const verifyAccessToken = (key) => s.accessTokens.get(key) ?? null;",
  ],
  [
    "/lib/machineToken",
    `export const getMachineTokenSync = () => "${"c".repeat(64)}";
     export const getLegacyCliTokenSync = () => "${"d".repeat(32)}";`,
  ],
  [
    "/shared/services/modelSyncScheduler",
    `export const isModelSyncInternalRequest = (request) =>
       request.headers.get("x-fixture-model-sync") === "fixture-model-sync-secret";`,
  ],
  [
    "/lib/config/runtimeSettings",
    'export const getAuthzBypassSnapshot = () => ({ enabled: true, prefixes: ["/api/mcp/"] });',
  ],
  ["/lib/gracefulShutdown", "export const isDraining = () => false;"],
  ["/services/ipFilter", "export const checkRequestIP = () => ({ allowed: true });"],
  [
    "/shared/utils/featureFlags",
    "export const isRequireApiKeyEnabled = () => s.requireApiKey; export const isFeatureFlagEnabled = () => false;",
  ],
  // Other slices test these DB-free projections. Keep this fixture on auth admission.
  [
    "/shared/runtimePolicyProxyConfig",
    `export const assertRuntimePolicyProxyConfig = (candidate) => {
       s.admittedCandidates.push(candidate);
       if (s.configError && candidate.featureFlags === s.policyNamespaces.featureFlags) throw s.configError;
     };`,
  ],
  ["/shared/runtimePolicyEntrypoints", "export const validateRuntimeHelperSettings = () => {};"],
]);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const clean = specifier.replace(/\.ts$/, "");
    if (
      clean.endsWith("/shared/runtimePolicy") &&
      context.parentURL?.includes("?standalone-auth-fixture")
    ) {
      return {
        url: `data:text/javascript,${encodeURIComponent(`
          export { RuntimePolicyError } from ${JSON.stringify(policyModuleUrl)};
          export const requiresLockedManagementAuth = () => false;
          export const assertLockedManagementAuthProvisioned = () => {};
        `)}`,
        shortCircuit: true,
      };
    }
    const resolved = nextResolve(specifier, context);
    const entry = [...stubs].find(
      ([suffix]) => clean.endsWith(suffix) || resolved.url.replace(/\.ts$/, "").endsWith(suffix)
    );
    // The fixture re-exports real error brands from the canonical module.
    // Do not intercept that data-module import recursively.
    if (
      entry &&
      !(entry[0] === "/scripts/build/runtime-policy.mjs" && context.parentURL?.startsWith("data:"))
    ) {
      if (entry[0] === "/lib/db/settings") state.settingsImports++;
      return {
        url: `data:text/javascript,${encodeURIComponent(prelude + entry[1])}`,
        shortCircuit: true,
      };
    }
    assert.ok(
      !resolved.url.includes("/src/lib/db/"),
      `no real DB module may load: ${resolved.url} from ${context.parentURL}`
    );
    return resolved;
  },
});
const { RuntimePolicyError, isRuntimePolicyResponse } =
  await import("../../../src/shared/runtimePolicy.ts");
const password = await import("../../../src/lib/auth/managementPassword.ts");
const passwordImportSettingsCount = state.settingsImports;
const apiAuth = await import("../../../src/shared/utils/apiAuth.ts");
const requireLoginRoute = await import("../../../src/app/api/settings/require-login/route.ts");
const { requireManagementAuth } = await import("../../../src/lib/api/requireManagementAuth.ts");
const { managementPolicy } = await import("../../../src/server/authz/policies/management.ts");
const { classifyRoute } = await import("../../../src/server/authz/classify.ts");
const { runAuthzPipeline } = await import("../../../src/server/authz/pipeline.ts");
const { issueDashboardCsrfToken } = await import("../../../src/server/authz/csrf.ts");
const { DASHBOARD_CSRF_HEADER } = await import("../../../src/shared/constants/dashboardCsrf.ts");
const { buildVideoBridgeBrokerHeaders } =
  await import("../../../src/lib/guardrails/videoBridgeBrokerAuth.ts");
const { ownListenerSelfHopToken, SELF_HOP_HEADER } =
  await import("../../../open-sse/utils/selfHop.ts");

const envNames = [
  "JWT_SECRET",
  "INITIAL_PASSWORD",
  "OMNIROUTE_INTERNAL_SERVICE_TOKEN",
  "OMNIROUTE_INTERNAL_SERVICE_TOKEN_FILE",
  "OMNIROUTE_WS_BRIDGE_SECRET",
  "INSPECTOR_INTERNAL_INGEST_TOKEN",
  "OMNIROUTE_DISABLE_CLI_TOKEN",
  "OMNIROUTE_PEER_STAMP_TOKEN",
  "OMNIROUTE_PUBLIC_BASE_URL",
  "NEXT_PUBLIC_BASE_URL",
  "NEXT_PUBLIC_APP_URL",
  "CORS_ALLOW_ALL",
  "CORS_ORIGIN",
  "CORS_ALLOWED_ORIGINS",
];
const originalEnv = new Map(envNames.map((name) => [name, process.env[name]]));
test.beforeEach(() => {
  for (const name of envNames) delete process.env[name];
  process.env.JWT_SECRET = "synthetic-runtime-management-jwt-secret";
  state.settings = { requireLogin: false, password: "", setupComplete: false };
  state.settingsReads = 0;
  state.settingsWrites = [];
  state.onboardingReadEffects = 0;
  state.candidateReads = [];
  state.admittedCandidates = [];
  state.policyNamespaces = {
    featureFlags: {},
    proxyConfig: { global: null, providers: {}, combos: {}, keys: {} },
    proxyAssignments: [],
    proxyApiKeyAssignments: [],
    proxyPerKeyConnectionEnabled: false,
  };
  state.configError = null;
  state.keys.clear();
  state.accessTokens.clear();
  state.keyError = false;
  state.requireApiKey = false;
  state.policyError = null;
});
test.after(() => {
  hooks.deregister();
  test.mock.restoreAll();
  Reflect.deleteProperty(globalThis, symbol);
  for (const [name, value] of originalEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});
test.mock.method(globalThis, "fetch", async () => {
  assert.fail("locked auth fixtures must not send any network request");
});

function request(path = "/api/providers", headers: HeadersInit = {}, method = "GET") {
  return new Request(`http://localhost:20128${path}`, { headers, method });
}
function ctx(req: Request, peer = "127.0.0.1"): PolicyContext {
  return {
    request: Object.assign(req, { socket: { remoteAddress: peer } }),
    classification: classifyRoute(new URL(req.url).pathname, req.method),
    requestId: "fixture-request",
  };
}
async function cookie(): Promise<string> {
  const token = await new SignJWT({ authenticated: true })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  return `auth_token=${token}`;
}
function key(scopes: string[], token = "fixture-api-key") {
  state.keys.set(token, { id: `fixture-${scopes.join("-")}`, scopes });
  return { authorization: `Bearer ${token}` };
}
async function assertDenied(req: Request, status = 401, peer = "127.0.0.1") {
  const decision = await managementPolicy.evaluate(ctx(req, peer));
  assert.equal(decision.allow, false);
  if (!decision.allow) assert.equal(decision.status, status);
  const response = await requireManagementAuth(req);
  assert.equal(response?.status, status);
  assert.equal(await apiAuth.isAuthenticated(req), false);
  assert.notEqual(await apiAuth.verifyAuth(req), null);
  if (response) {
    assert.doesNotMatch(await response.text(), /fixture private|at \/|\/run\//);
  }
}

test("locked management ignores requireLogin=false, empty bootstrap, loopback and LAN", async () => {
  for (const settings of [
    { requireLogin: false, password: "" },
    { requireLogin: true, password: "", setupComplete: false },
    { requireLogin: false, password: "fixture-password", setupComplete: true },
  ]) {
    state.settings = settings;
    for (const peer of ["127.0.0.1", "192.168.1.10", "100.64.0.2", "198.51.100.2"]) {
      const req = request();
      assert.equal(await apiAuth.isAuthRequired(req), true);
      await assertDenied(req, 401, peer);
    }
  }
  assert.equal(
    state.settingsReads,
    0,
    "locked management must not consult mutable bypass settings"
  );
});

test("locked management requires auth without a Request, not a trusted in-process bypass", async () => {
  assert.equal(await apiAuth.isAuthRequired(), true);
  assert.equal((await requireManagementAuth())?.status, 401);
  assert.equal((await requireManagementAuth(null))?.status, 401);
});

test("locked fresh onboarding/security-write guards cannot use bootstrap exceptions", async () => {
  state.settings = { requireLogin: true, password: "", setupComplete: false };
  for (const path of ["/dashboard/onboarding", "/api/settings/require-login"]) {
    assert.equal(await apiAuth.isAuthRequired(request(path, {}, "POST")), true);
    assert.equal(await apiAuth.isAuthenticated(request(path, {}, "POST")), false);
  }
});

test("guarded public OAuth writes require management credentials, not an inference key", async () => {
  const req = request("/api/oauth/fixture/paste-credentials", key(["read:models"]), "POST");
  assert.equal(await apiAuth.isAuthRequired(req), true);
  assert.equal(await apiAuth.isAuthenticated(req), false);
  assert.notEqual(await apiAuth.verifyAuth(req), null);
});

test("admission self-hop proof, local host and forged subject stamps are not management auth", async () => {
  const headers = {
    [SELF_HOP_HEADER]: ownListenerSelfHopToken(),
    "x-omniroute-admission-bypass": "internal",
    host: "127.0.0.1:20128",
  };
  await assertDenied(request("/api/providers", headers));
  await assertDenied(
    request("/api/providers", {
      ...headers,
      authorization: `Bearer ${ownListenerSelfHopToken()}`,
    }),
    403
  );
  const forged = new NextRequest("http://localhost:20128/api/providers", {
    headers: {
      ...headers,
      "x-omniroute-auth-kind": "management_key",
      "x-omniroute-auth-label": "local-cli-token",
      "x-omniroute-peer-locality": "loopback",
    },
  });
  assert.equal((await runAuthzPipeline(forged, { enforce: true })).status, 401);
});

test("locked auth accepts actual JWT and manage/admin keys, never inference-only or URL keys", async () => {
  for (const headers of [
    { cookie: await cookie() },
    key(["manage"]),
    key(["admin"], "fixture-admin"),
  ]) {
    const req = request("/api/providers", headers);
    assert.equal((await managementPolicy.evaluate(ctx(req))).allow, true);
    assert.equal(await requireManagementAuth(req), null);
    assert.equal(await apiAuth.isAuthenticated(req), true);
    assert.equal(await apiAuth.verifyAuth(req), null);
  }
  await assertDenied(request("/api/providers", key(["read:models"], "fixture-inference")), 403);
  await assertDenied(request("/dashboard", key(["read:models"], "fixture-inference")), 403);
  await assertDenied(request("/api/providers?token=fixture-admin"));
});

test("invalid required policy propagates before valid credentials or bootstrap", async () => {
  const req = request("/api/providers", { cookie: await cookie() });
  const failure = new RuntimePolicyError("bootstrap-invalid");
  state.policyError = failure;
  for (const invoke of [
    () => apiAuth.isAuthRequired(req),
    () => apiAuth.isAuthenticated(req),
    () => apiAuth.verifyAuth(req),
    () => requireManagementAuth(req),
    () => requireManagementAuth(),
    () => managementPolicy.evaluate(ctx(req)),
  ]) {
    await assert.rejects(invoke(), (error) => error === failure);
  }
  assert.throws(
    () => password.assertLockedManagementAuthProvisioned({ password: "fixture" }),
    (error) => error === failure
  );
  assert.equal(state.settingsReads, 0);
});

test("real credential errors fail closed without leaking backend details", async () => {
  state.keyError = true;
  const req = request("/api/providers", { authorization: "Bearer fixture-unknown" });
  const decision = await managementPolicy.evaluate(ctx(req));
  assert.equal(decision.allow, false);
  if (!decision.allow) assert.equal(decision.status, 503);
  const response = await requireManagementAuth(req);
  assert.equal(response?.status, 503);
  assert.doesNotMatch(await response!.text(), /fixture private|at \//);
});

test("scoped access tokens retain method and admin restrictions", async () => {
  state.accessTokens.set("oma_fixture_read", { id: "fixture-read", name: "read", scope: "read" });
  const headers = { authorization: "Bearer oma_fixture_read" };
  assert.equal(
    (await managementPolicy.evaluate(ctx(request("/api/providers", headers)))).allow,
    true
  );
  assert.equal(await requireManagementAuth(request("/api/providers", headers)), null);
  assert.equal(
    (await requireManagementAuth(request("/api/providers", headers, "POST")))?.status,
    403
  );
  assert.equal(
    (await requireManagementAuth(request("/api/cli/tokens", headers, "POST")))?.status,
    403
  );
});

test("LOCAL_ONLY remains a locality gate even with a valid management key", async () => {
  const req = request("/api/cli-tools/runtime/status", key(["manage"]));
  const denied = await managementPolicy.evaluate(ctx(req, "198.51.100.2"));
  assert.equal(denied.allow, false);
  if (!denied.allow) assert.equal(denied.code, "LOCAL_ONLY");
  assert.equal((await managementPolicy.evaluate(ctx(req))).allow, true);
});

test("narrow MCP scope does not become a general management credential", async () => {
  const headers = key(["mcp:connect"]);
  assert.equal(
    (await managementPolicy.evaluate(ctx(request("/api/mcp/status", headers)))).allow,
    true
  );
  assert.equal(
    await requireManagementAuth(request("/api/mcp/status", headers), {
      acceptMcpConnectScope: true,
    }),
    null
  );
  assert.equal((await requireManagementAuth(request("/api/providers", headers)))?.status, 403);
});

test("internal model sync and WS bridge credentials keep exact path limits", async () => {
  const syncHeaders = { "x-fixture-model-sync": "fixture-model-sync-secret" };
  assert.equal(
    (
      await managementPolicy.evaluate(
        ctx(request("/api/providers/fixture/sync-models", syncHeaders))
      )
    ).allow,
    true
  );
  assert.equal(
    (await managementPolicy.evaluate(ctx(request("/api/providers", syncHeaders)))).allow,
    false
  );
  process.env.OMNIROUTE_WS_BRIDGE_SECRET = "fixture-ws-bridge-secret";
  const wsHeaders = { "x-omniroute-ws-bridge-secret": process.env.OMNIROUTE_WS_BRIDGE_SECRET };
  assert.equal(
    (await managementPolicy.evaluate(ctx(request("/api/internal/codex-responses-ws", wsHeaders))))
      .allow,
    true
  );
  assert.equal(
    (await managementPolicy.evaluate(ctx(request("/api/providers", wsHeaders)))).allow,
    false
  );
});

test("internal service and CLI credentials still require trusted loopback locality", async () => {
  process.env.OMNIROUTE_INTERNAL_SERVICE_TOKEN = "fixture-internal-service-token";
  const credentials: Record<string, string>[] = [
    { "x-omniroute-internal-service-token": process.env.OMNIROUTE_INTERNAL_SERVICE_TOKEN },
    { "x-omniroute-cli-token": "c".repeat(64) },
  ];
  for (const headers of credentials) {
    assert.equal(
      (await managementPolicy.evaluate(ctx(request("/api/providers", headers)))).allow,
      true
    );
    assert.equal(
      (await managementPolicy.evaluate(ctx(request("/api/providers", headers), "198.51.100.2")))
        .allow,
      false
    );
    assert.equal(
      await requireManagementAuth(
        request("/api/providers", {
          ...headers,
          "x-omniroute-peer-locality": "loopback",
        })
      ),
      null
    );
    assert.equal((await requireManagementAuth(request("/api/providers", headers)))?.status, 401);
  }
});

test("Video Bridge process token remains scoped to broker paths and loopback", async () => {
  const headers = buildVideoBridgeBrokerHeaders();
  for (const path of [
    "/api/modality-bridge/video/extract",
    "/api/modality-bridge/video/drilldown",
  ]) {
    assert.equal((await managementPolicy.evaluate(ctx(request(path, headers)))).allow, true);
    assert.equal(
      (await managementPolicy.evaluate(ctx(request(path, headers), "198.51.100.2"))).allow,
      false
    );
  }
  assert.equal(
    (await managementPolicy.evaluate(ctx(request("/api/providers", headers)))).allow,
    false
  );
});

test("locked inspector ingest must authenticate its own token, not loopback alone", async () => {
  const path = "/api/tools/traffic-inspector/internal/ingest";
  assert.equal((await managementPolicy.evaluate(ctx(request(path, {}, "POST")))).allow, false);
  process.env.INSPECTOR_INTERNAL_INGEST_TOKEN = "fixture-inspector-ingest-token";
  const headers = { authorization: `Bearer ${process.env.INSPECTOR_INTERNAL_INGEST_TOKEN}` };
  assert.equal((await managementPolicy.evaluate(ctx(request(path, headers, "POST")))).allow, true);
  assert.equal(
    (await managementPolicy.evaluate(ctx(request("/api/providers", headers)))).allow,
    false
  );
  assert.equal(
    (await managementPolicy.evaluate(ctx(request(path, headers), "198.51.100.2"))).allow,
    false
  );
});

test("real login and public routes still pass the central policy without credentials", async () => {
  for (const [path, method] of [
    ["/api/auth/login", "POST"],
    ["/api/auth/status", "GET"],
    ["/api/auth/oidc/login", "GET"],
    ["/api/health/ping", "GET"],
  ]) {
    assert.equal(classifyRoute(path, method).routeClass, "PUBLIC");
    const response = await runAuthzPipeline(
      new NextRequest(`http://localhost:20128${path}`, { method }),
      { enforce: true }
    );
    assert.equal(response.status, 200);
  }
});

test("locked policy does not widen inference key defaults or alias behavior", async () => {
  for (const path of [
    "/api/v1/models",
    "/api/v1beta/models",
    "/v1/models",
    "/responses",
    "/codex",
  ]) {
    assert.equal(await apiAuth.isAuthRequired(request(path)), false);
    const req = new NextRequest(`http://localhost:20128${path}`);
    state.requireApiKey = false;
    assert.equal((await runAuthzPipeline(req, { enforce: true })).status, 200);
    state.requireApiKey = true;
    assert.equal((await runAuthzPipeline(req, { enforce: true })).status, 401);
  }
});

test("locked dashboard sessions still require browser origin/CSRF protection", async () => {
  const headers = { cookie: await cookie(), origin: "https://untrusted.example.invalid" };
  const req = new NextRequest("http://localhost:20128/api/providers", { method: "POST", headers });
  assert.equal((await runAuthzPipeline(req, { enforce: true })).status, 403);
  const csrf = issueDashboardCsrfToken(req);
  assert.ok(csrf);
  const authorized = new NextRequest(req.url, {
    method: "POST",
    headers: { ...headers, [DASHBOARD_CSRF_HEADER]: csrf.token },
  });
  assert.equal((await runAuthzPipeline(authorized, { enforce: true })).status, 200);
});

test("management provisioning module does not import the DB at load time", () => {
  assert.equal(passwordImportSettingsCount, 0);
});

test("locked provisioning rejects missing/default passwords and incomplete OIDC", () => {
  for (const settings of [
    {},
    { requireLogin: false },
    { password: "" },
    { password: "   " },
    { password: "CHANGEME" },
    { oidcEnabled: true, oidcIssuer: "https://idp.example.invalid" },
  ]) {
    assert.throws(() => password.assertLockedManagementAuthProvisioned(settings), {
      code: "OMNI_RUNTIME_POLICY_DENIED",
      reason: "management-auth-required",
    });
  }
  assert.throws(() => password.assertLockedManagementAuthProvisioned({}, "CHANGEME"), {
    reason: "management-auth-required",
  });
});

test("locked provisioning accepts migration inputs/full OIDC without reads or writes", () => {
  const settings = Object.freeze({ password: "fixture-password", requireLogin: false });
  password.assertLockedManagementAuthProvisioned(settings);
  password.assertLockedManagementAuthProvisioned({}, "fixture-initial-password");
  password.assertLockedManagementAuthProvisioned({
    oidcEnabled: true,
    oidcIssuer: "https://idp.example.invalid",
    oidcClientId: "fixture-client",
    oidcClientSecret: "fixture-secret",
  });
  assert.equal(state.settingsReads, 0);
  assert.deepEqual(settings, { password: "fixture-password", requireLogin: false });
});

test("provisioning follows migration precedence and never reads INITIAL_PASSWORD implicitly", () => {
  process.env.INITIAL_PASSWORD = "fixture-initial-password";
  assert.throws(() => password.assertLockedManagementAuthProvisioned({}), {
    reason: "management-auth-required",
  });
  assert.throws(
    () =>
      password.assertLockedManagementAuthProvisioned(
        { password: "CHANGEME" },
        "fixture-initial-password"
      ),
    { reason: "management-auth-required" }
  );
  password.assertLockedManagementAuthProvisioned(
    { password: "fixture-stored-password" },
    "CHANGEME"
  );
});

test("raw locked password hashing rejects placeholders without env/stored/OIDC fallback", async (t) => {
  const bcrypt = (await import("bcryptjs")).default;
  const hash = t.mock.method(bcrypt, "hash");
  process.env.INITIAL_PASSWORD = "fixture-env-password";
  state.settings = {
    password: "fixture-stored-password",
    oidcEnabled: true,
    oidcIssuer: "https://idp.example.invalid",
    oidcClientId: "fixture-client",
    oidcClientSecret: "fixture-secret",
  };
  for (const raw of ["CHANGEME", " CHANGEME ", "", "   ", "\t\n"]) {
    await assert.rejects(password.hashManagementPassword(raw), {
      code: "OMNI_RUNTIME_POLICY_DENIED",
      reason: "management-auth-required",
    });
  }
  assert.equal(state.settingsReads, 0);
  assert.equal(state.settingsWrites.length, 0);
  assert.equal(hash.mock.callCount(), 0, "reject raw placeholders before bcrypt");
});

test("provisioning accepts the actual persisted bcrypt form without password or DB mutation", async () => {
  const hash = await password.hashManagementPassword("fixture-persisted-password");
  const candidate = Object.freeze({ password: hash, requireLogin: false });
  password.assertLockedManagementAuthProvisioned(candidate);
  assert.equal(candidate.password, hash);
  assert.equal(state.settingsReads, 0);
});

test("locked password migration normalizes requireLogin before merged-write admission", async () => {
  for (const storedPassword of ["fixture-legacy-password", ""]) {
    state.settings = { password: storedPassword, requireLogin: false, setupComplete: false };
    const result = await password.ensurePersistentManagementPasswordHash({
      settings: state.settings,
      initialPassword: "fixture-env-password",
    });
    assert.equal(result.migrated, true);
    assert.equal(result.source, storedPassword ? "stored_plaintext" : "env");
    assert.equal(result.settings.requireLogin, true);
    assert.equal(result.settings.setupComplete, true);
    assert.equal(state.settingsWrites.at(-1)?.requireLogin, true);
    assert.ok(result.hash);
    assert.equal(
      await password.verifyManagementPassword(
        storedPassword || "fixture-env-password",
        result.hash
      ),
      true
    );
  }
  assert.equal(state.settingsWrites.length, 2);
});

test("locked stored bcrypt normalizes disabled login without rehashing or bypassing admission", async () => {
  const hash = await password.hashManagementPassword("fixture-stored-bcrypt-password");
  state.settings = { password: hash, requireLogin: false, setupComplete: false };
  const result = await password.ensurePersistentManagementPasswordHash({
    settings: state.settings,
  });
  assert.equal(result.hash, hash);
  assert.equal(result.migrated, false);
  assert.equal(result.source, "stored_hash");
  assert.equal(result.settings.password, hash);
  assert.equal(result.settings.requireLogin, true);
  assert.deepEqual(state.settingsWrites, [{ requireLogin: true }]);

  const { updateSettings } = await import("../../../src/lib/db/settings.ts");
  const updated = await updateSettings({ theme: "dark" });
  assert.equal(updated.password, hash);
  assert.equal(updated.requireLogin, true);
  assert.equal(
    updated.setupComplete,
    false,
    "normalization does not trigger setup/catalog effects"
  );
  assert.equal(state.settingsWrites.length, 2, "later ordinary writes still run admission");
});

test("standalone stored bcrypt keeps disabled login and performs no write", async () => {
  const standalone = (await import(
    new URL("../../../src/lib/auth/managementPassword.ts?standalone-auth-fixture", import.meta.url)
      .href
  )) as typeof password;
  const bcrypt = (await import("bcryptjs")).default;
  for (const raw of ["fixture-standalone-bcrypt-password", "CHANGEME"]) {
    const hash = await bcrypt.hash(raw, 4);
    const settings = { password: hash, requireLogin: false, setupComplete: true };
    state.settings = settings;
    const result = await standalone.ensurePersistentManagementPasswordHash({ settings });
    assert.equal(result.hash, hash);
    assert.equal(result.migrated, false);
    assert.equal(result.settings, settings);
    assert.equal(result.settings.requireLogin, false);
    assert.deepEqual(state.settingsWrites, []);
  }
});

function requireLoginPost(body: unknown, headers: HeadersInit = {}) {
  return new Request("http://localhost:20128/api/settings/require-login", {
    method: "POST",
    headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) },
    body: JSON.stringify(body),
  });
}

test("require-login GET reports the effective locked requirement for either stored toggle", async () => {
  for (const requireLogin of [false, true]) {
    state.settings = { requireLogin, password: "fixture-password", setupComplete: true };
    const response = await requireLoginRoute.GET();
    assert.equal(response.status, 200);
    assert.equal((await response.json()).requireLogin, true);
  }
  assert.equal(state.onboardingReadEffects, 0, "public status reads must not complete onboarding");
});

test("require-login direct POST authenticates before bootstrap reads, body, hashing or writes", async (t) => {
  const bcrypt = (await import("bcryptjs")).default;
  const hash = t.mock.method(bcrypt, "hash");
  for (const password of ["", "fixture-existing-password"]) {
    state.settings = { requireLogin: false, password, setupComplete: false };
    const req = requireLoginPost({ password: "fixture-replacement-password" });
    const bodyRead = t.mock.method(req, "json");
    const response = await requireLoginRoute.POST(req);
    assert.equal(response.status, 401);
    assert.equal(bodyRead.mock.callCount(), 0);
  }
  assert.equal(hash.mock.callCount(), 0);
  assert.equal(state.settingsReads, 0);
  assert.deepEqual(state.settingsWrites, []);
});

test("require-login rejects raw placeholders and explicit disable before any hash/write", async (t) => {
  const bcrypt = (await import("bcryptjs")).default;
  const hash = t.mock.method(bcrypt, "hash");
  process.env.INITIAL_PASSWORD = "fixture-env-password";
  state.settings = {
    requireLogin: true,
    password: "fixture-existing-password",
    oidcEnabled: true,
    oidcIssuer: "https://idp.example.invalid",
    oidcClientId: "fixture-client",
    oidcClientSecret: "fixture-secret",
  };
  const headers = { cookie: await cookie() };
  for (const body of [
    { password: "CHANGEME" },
    { password: "    " },
    { password: "" },
    { requireLogin: false, password: "fixture-valid-replacement" },
  ]) {
    const response = await requireLoginRoute.POST(requireLoginPost(body, headers));
    assert.equal(response.status, 403);
    assert.equal(isRuntimePolicyResponse(response), true);
    assert.doesNotMatch(await response.text(), /CHANGEME|fixture-|at \/|\/run\//);
  }
  assert.equal(hash.mock.callCount(), 0);
  assert.deepEqual(state.settingsWrites, []);
  assert.equal(state.onboardingReadEffects, 0, "pre-admission reads cannot complete onboarding");
});

test("require-login valid locked password uses real bcrypt and the ordinary writer", async () => {
  state.settings = { requireLogin: false, password: "", setupComplete: false };
  const response = await requireLoginRoute.POST(
    requireLoginPost({ password: "fixture-rotated-password" }, key(["manage"]))
  );
  assert.equal(response.status, 200);
  assert.equal(state.settingsWrites.length, 1);
  assert.equal(state.settingsWrites[0].requireLogin, true);
  assert.equal(
    state.settings.setupComplete,
    false,
    "auth changes do not trigger setup/catalog effects"
  );
  assert.equal(
    await password.verifyManagementPassword(
      "fixture-rotated-password",
      state.settings.password as string
    ),
    true
  );
});

test("require-login policy load failures return safe branded denials without storage", async () => {
  state.policyError = new RuntimePolicyError("bootstrap-invalid");
  for (const response of [
    await requireLoginRoute.GET(),
    await requireLoginRoute.POST(requireLoginPost({ requireLogin: true })),
  ]) {
    assert.equal(response.status, 403);
    assert.equal(isRuntimePolicyResponse(response), true);
    assert.doesNotMatch(await response.text(), /at \/|\/run\//);
  }
  assert.equal(state.settingsReads, 0);
  assert.deepEqual(state.settingsWrites, []);
});

test("locked startup rejects an exact legacy bcrypt(CHANGEME) before normalization", async () => {
  const bcrypt = (await import("bcryptjs")).default;
  const hash = await bcrypt.hash("CHANGEME", 4);
  state.settings = { password: hash, requireLogin: false, setupComplete: true };
  await assert.rejects(
    password.ensurePersistentManagementPasswordHash({
      settings: state.settings,
      initialPassword: "fixture-stronger-env-password",
    }),
    { code: "OMNI_RUNTIME_POLICY_DENIED", reason: "management-auth-required" }
  );
  assert.equal(state.settings.password, hash);
  assert.equal(state.settings.requireLogin, false);
  assert.deepEqual(state.settingsWrites, []);
});

test("require-login hydrates authoritative policy namespaces before hashing a password", async (t) => {
  const bcrypt = (await import("bcryptjs")).default;
  const hash = t.mock.method(bcrypt, "hash");
  state.settings = { requireLogin: true, password: "fixture-old-password", featureFlags: {} };
  state.policyNamespaces.featureFlags = { fixturePolicyViolation: true };
  state.configError = new RuntimePolicyError("proxy-forbidden");
  const response = await requireLoginRoute.POST(
    requireLoginPost({ password: "fixture-new-password" }, key(["manage"]))
  );
  assert.equal(response.status, 403);
  assert.equal(isRuntimePolicyResponse(response), true);
  assert.equal(state.candidateReads.length, 1);
  assert.equal(state.candidateReads[0].password, "fixture-new-password");
  assert.equal(state.candidateReads[0].requireLogin, true);
  for (const name of Object.keys(state.policyNamespaces)) {
    assert.equal(state.admittedCandidates[0][name], state.policyNamespaces[name]);
  }
  assert.equal(hash.mock.callCount(), 0);
  assert.equal(state.onboardingReadEffects, 0);
  assert.deepEqual(state.settingsWrites, []);
});
