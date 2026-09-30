import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createHash } from "node:crypto";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const POLICY_FACADE = "src/shared/runtimePolicy.ts";
const CONFIG = "src/shared/runtimePolicyProxyConfig.ts";
const CORE = "scripts/build/runtime-policy.mjs";
const definitions = "src/shared/constants/featureFlagDefinitions.ts";
const profile = "omni-app-residential-direct-v1";

type Mode = "locked" | "standalone" | "invalid";
type Candidate = Readonly<Record<string, unknown>>;
interface FixtureState {
  effects: string[];
  settings: Record<string, unknown>;
  flags: Record<string, string>;
  legacy: Record<string, unknown>;
  assignments: unknown[];
  rows: unknown[];
}
interface Fixture {
  state: FixtureState;
  assertRuntimePolicyProxyConfig: (candidate: Candidate, env?: Record<string, string>) => void;
  assertRuntimePolicyConnectionProxyConfig: (candidate: Candidate) => void;
  isRuntimePolicyError: (error: unknown) => boolean;
  isRuntimePolicyResponse: (response: unknown) => boolean;
  [key: string]: unknown;
}

// The canonical authority is unchanged. Only its fs import is a private fixture.
// Never read/write /run, initialize SQLite, import a provider, or start a helper.
function filesystemFixture(mode: Mode): string {
  const policy = JSON.stringify({ schema: 1, profile, providers: [], helpers: [] });
  const marker = JSON.stringify({
    schema: 1,
    profile,
    policySha256: createHash("sha256").update(policy).digest("hex"),
  });
  return `
    const data = ${JSON.stringify({
      "/run/omni-runtime-policy/policy.json": policy,
      "/run/omni-runtime-policy/required-v1.json": marker,
    })};
    function stat(path) {
      if (${JSON.stringify(mode)} === "standalone") throw Object.assign(new Error("absent"), { code: "ENOENT" });
      if (${JSON.stringify(mode)} === "invalid") throw new Error("fixture unavailable");
      const file = Object.hasOwn(data, path);
      if (!file && !["/", "/run", "/run/omni-runtime-policy"].includes(path)) throw new Error("unexpected fixture path");
      return { uid: 0, gid: 0, dev: 1, ino: path, mode: file ? 0o444 : 0o555,
        nlink: 1, size: file ? Buffer.byteLength(data[path]) : 0,
        mtimeMs: 1, ctimeMs: 1, isFile: () => file,
        isDirectory: () => !file, isSymbolicLink: () => false };
    }
    export default { lstatSync: stat, fstatSync: stat, openSync: (path) => path,
      readFileSync: (path) => Buffer.from(data[path]), closeSync: () => {},
      constants: { O_RDONLY: 0, O_NOFOLLOW: 0, O_NONBLOCK: 0 } };
  `;
}

const stateSource = `
  export const state = { effects: [], settings: {}, flags: {}, legacy: {}, assignments: [], rows: [] };
  export function touched(name) { state.effects.push(name); throw new Error("Unexpected fixture effect: " + name); }
`;

function stubSource(importer: string, specifier: string): string {
  const source = readFileSync(importer, "utf8");
  const names = new Set<string>();
  for (const match of source.matchAll(
    /(?:import|export)\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g
  )) {
    if (match[2] !== specifier) continue;
    for (const part of match[1].split(",")) {
      const name = part.trim().split(/\s+/)[0];
      if (name && name !== "type") names.add(name);
    }
  }
  return (
    `import { touched } from "fixture:state";
` +
    [...names]
      .map(
        (name) =>
          `export const ${name} = (...args) => touched(${JSON.stringify(specifier + ":" + name)});`
      )
      .join("\n") +
    `\nexport default (...args) => touched(${JSON.stringify(specifier)});`
  );
}

async function fixture(
  entry = CONFIG,
  mode: Mode = "locked",
  mocks: Record<string, string> = {},
  env: Record<string, string> = {}
): Promise<Fixture> {
  const allowed = new Set([entry, CONFIG, POLICY_FACADE, CORE, definitions]);
  const output = await build({
    stdin: {
      contents: `export * from "./${entry}"; export { state } from "fixture:state";
        export { isRuntimePolicyError, isRuntimePolicyResponse } from "./${POLICY_FACADE}";`,
      resolveDir: ROOT,
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    logLevel: "silent",
    define: {
      "process.env": JSON.stringify(env),
      setTimeout: "__fixtureTimer",
      setInterval: "__fixtureTimer",
    },
    banner: { js: 'const __fixtureTimer = () => { throw new Error("Fixture created a timer"); };' },
    plugins: [
      {
        name: "isolated-policy-fixture",
        setup(plugin) {
          plugin.onResolve({ filter: /.*/ }, (args) => {
            if (args.path === "node:fs") return { path: "fs", namespace: "fixture" };
            if (args.path === "fixture:state") return { path: "state", namespace: "fixture" };
            if (Object.hasOwn(mocks, args.path)) return { path: args.path, namespace: "mock" };
            if (args.path.startsWith("node:")) return { path: args.path, external: true };
            const absolute = args.path.startsWith("@/")
              ? resolve(ROOT, "src", args.path.slice(2))
              : resolve(args.resolveDir || ROOT, args.path);
            const relative = absolute.slice(ROOT.length + 1);
            const file = allowed.has(relative)
              ? relative
              : allowed.has(relative + ".ts")
                ? relative + ".ts"
                : null;
            if (file) return { path: resolve(ROOT, file) };
            return { path: args.path, namespace: "stub", pluginData: args.importer };
          });
          plugin.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
            contents: args.path === "fs" ? filesystemFixture(mode) : stateSource,
            loader: "js",
          }));
          plugin.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({
            contents: mocks[args.path],
            loader: "js",
          }));
          plugin.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
            contents: stubSource(args.pluginData as string, args.path),
            loader: "js",
          }));
        },
      },
    ],
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}#${Math.random()}`
  );
}

function denied(fn: () => void, api: Fixture): void {
  assert.throws(fn, (error) => api.isRuntimePolicyError(error));
}

test("permission toggles alone are direct; dormant configuration remains untouched", async () => {
  const api = await fixture();
  const dormant = Object.freeze({
    proxyEnabled: false,
    proxyConfig: Object.freeze({ global: "http://fixture-proxy.invalid:8080" }),
    proxyAssignments: Object.freeze([{ proxyId: "fixture-proxy" }]),
  });
  assert.doesNotThrow(() => api.assertRuntimePolicyProxyConfig({}, {}));
  assert.doesNotThrow(() => api.assertRuntimePolicyConnectionProxyConfig({ proxyEnabled: true }));
  assert.doesNotThrow(() => api.assertRuntimePolicyProxyConfig(dormant, {}));
  assert.equal(dormant.proxyConfig.global, "http://fixture-proxy.invalid:8080");
});

test("populated selected legacy/registry/connection sources deny before use", async () => {
  const api = await fixture();
  for (const proxyConfig of [
    { global: "http://fixture-proxy.invalid:8080" },
    { providers: { fixture: { host: "fixture-proxy.invalid", port: 8080 } } },
    { combos: { fixture: "http://fixture-proxy.invalid:8080" } },
    { keys: { fixture: "http://fixture-proxy.invalid:8080" } },
  ])
    denied(() => api.assertRuntimePolicyProxyConfig({ proxyConfig }, {}), api);
  denied(
    () => api.assertRuntimePolicyProxyConfig({ proxyAssignments: [{ proxyId: "fixture" }] }, {}),
    api
  );
  denied(
    () =>
      api.assertRuntimePolicyConnectionProxyConfig({ proxy: { host: "fixture-proxy.invalid" } }),
    api
  );
  assert.doesNotThrow(() =>
    api.assertRuntimePolicyProxyConfig({ proxyConfig: { global: null, keys: {} } }, {})
  );
});

test("feature flags use DB > nonempty env > definition default with exact truth values", async () => {
  const api = await fixture();
  for (const value of ["false", "", "TRUE", "on"]) {
    api.assertRuntimePolicyProxyConfig(
      { featureFlags: { PROXY_AUTO_SELECT_ENABLED: value } },
      { PROXY_AUTO_SELECT_ENABLED: "true" }
    );
  }
  for (const value of ["true", "1", "yes"]) {
    denied(
      () =>
        api.assertRuntimePolicyProxyConfig(
          { featureFlags: { PROXY_AUTO_SELECT_ENABLED: value } },
          { PROXY_AUTO_SELECT_ENABLED: "false" }
        ),
      api
    );
  }
  denied(
    () =>
      api.assertRuntimePolicyProxyConfig(
        { featureFlags: {} },
        { PROXY_AUTO_SELECT_ENABLED: "true" }
      ),
    api
  );
  api.assertRuntimePolicyProxyConfig({ featureFlags: {} }, { PROXY_AUTO_SELECT_ENABLED: "" });
});

test("all transport env variants deny independently of settings and NO_PROXY", async () => {
  const api = await fixture();
  for (const key of [
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
  ]) {
    denied(
      () =>
        api.assertRuntimePolicyProxyConfig(
          { proxyEnabled: false },
          { [key]: "http://fixture-proxy.invalid:8080", NO_PROXY: "*" }
        ),
      api
    );
  }
});

test("standalone permits existing proxy behavior; invalid authority never becomes direct", async () => {
  const ordinary = await fixture(CONFIG, "standalone");
  ordinary.assertRuntimePolicyProxyConfig(
    {
      proxyConfig: { global: "http://fixture-proxy.invalid" },
      featureFlags: { PROXY_AUTO_SELECT_ENABLED: "true" },
    },
    { HTTPS_PROXY: "http://fixture-proxy.invalid" }
  );
  const invalid = await fixture(CONFIG, "invalid");
  denied(() => invalid.assertRuntimePolicyProxyConfig({}, {}), invalid);
});

const dbMock = `
  import { state } from "fixture:state";
  export function getDbInstance() {
    return { transaction: (fn) => fn, prepare: (sql) => ({
      all: (namespace) => {
        if (namespace === "feature_flags") return Object.entries(state.flags).map(([key, value]) => ({ key, value }));
        if (sql.includes("namespace = 'settings'")) return Object.entries(state.settings).map(([key, value]) => ({ key, value: JSON.stringify(value) }));
        if (sql.includes("namespace = 'proxyConfig'")) return Object.entries(state.legacy).map(([key, value]) => ({ key, value: JSON.stringify(value) }));
        if (sql.includes("proxy_assignments")) return state.assignments;
        return state.rows;
      },
      get: (...args) => {
        if (sql.includes("feature_flags") || args[0] === "feature_flags") {
          const value = state.flags[args[1]];
          return value === undefined ? undefined : { value };
        }
        if (sql.includes("_settingsRevision") || args[0] === "_settingsRevision") return undefined;
        if (sql.includes("proxyEnabled")) return { value: JSON.stringify(state.settings.proxyEnabled ?? true) };
        if (sql.includes("COUNT") || sql.includes("count")) return { cnt: state.rows.length };
        if (sql.includes("proxy_registry")) return state.rows[0];
        return undefined;
      },
      run: (...args) => {
        state.effects.push("write");
        if (args[0] === "feature_flags") {
          if (sql.startsWith("INSERT")) state.flags[args[1]] = args[2];
          else if (args.length > 1) delete state.flags[args[1]];
          else state.flags = {};
        }
        return { changes: 1 };
      },
    }) };
  }
`;

function fn<T>(api: Fixture, name: string): T {
  return api[name] as T;
}

test("flag write and deletion validate resulting DB-over-env values before writes", async () => {
  const api = await fixture(
    "src/lib/db/featureFlags.ts",
    "locked",
    { "./core": dbMock },
    { PROXY_AUTO_SELECT_ENABLED: "true" }
  );
  const set = fn<(key: string, value: string) => void>(api, "setFeatureFlagOverride");
  const remove = fn<(key: string) => void>(api, "removeFeatureFlagOverride");
  const clear = fn<() => void>(api, "clearAllFeatureFlagOverrides");
  set("PROXY_AUTO_SELECT_ENABLED", "false");
  assert.equal(api.state.flags.PROXY_AUTO_SELECT_ENABLED, "false");
  api.state.effects.length = 0;
  denied(() => set("PROXY_AUTO_SELECT_ENABLED", "yes"), api);
  denied(() => remove("PROXY_AUTO_SELECT_ENABLED"), api);
  denied(clear, api);
  assert.deepEqual(api.state.effects, []);
  assert.equal(api.state.flags.PROXY_AUTO_SELECT_ENABLED, "false");
  const ordinary = await fixture("src/lib/db/featureFlags.ts", "standalone", { "./core": dbMock });
  fn<(key: string, value: string) => void>(ordinary, "setFeatureFlagOverride")(
    "PROXY_AUTO_SELECT_ENABLED",
    "true"
  );
  assert.equal(ordinary.state.flags.PROXY_AUTO_SELECT_ENABLED, "true");
});

const probeMock = `
  export const resolveProbeTarget = () => "https://probe.example.invalid";
  export const resolveProbeConcurrency = () => 1;
  export const resolveProbeStaggerMs = () => 0;
  export const waitForProbeSlot = () => { throw new Error("Unexpected probe"); };
`;
const zodMock = `
  const chain = new Proxy(() => chain, { get: () => chain });
  export const z = chain;
`;
const routeMocks = {
  "@/lib/api/requireManagementAuth": "export const requireManagementAuth = async () => null;",
  "@omniroute/open-sse/utils/error":
    "export const sanitizeErrorMessage = () => 'Runtime policy denied this operation.';",
  "next/server": "export const NextResponse = Response;",
  zod: zodMock,
  "@/lib/proxyHealth/probeTarget": probeMock,
};
const effectRoutes = [
  "settings/proxy/test",
  "settings/proxy/cloudflare-deploy",
  "settings/proxy/deno-deploy",
  "settings/proxy/vercel-deploy",
  "settings/proxies/[id]/repair-relay",
  "settings/proxies/auto-test",
  "settings/proxies/egress",
  "settings/free-proxies/sync",
  "settings/oneproxy/rotate",
  "v1/management/proxy-subscriptions/[id]/refresh",
];
for (const route of effectRoutes) {
  test(`${route}: branded safe denial precedes DB/network/probe/body effects`, async () => {
    const api = await fixture(`src/app/api/${route}/route.ts`, "locked", routeMocks);
    for (const method of route.endsWith("/egress") ? ["GET", "POST"] : ["POST"]) {
      const response = await fn<(request: Request, context: unknown) => Promise<Response>>(
        api,
        method
      )(new Request("http://fixture.invalid/api", { method }), {
        params: Promise.resolve({ id: "fixture" }),
      });
      assert.equal(response.status, 403);
      assert.equal(api.isRuntimePolicyResponse(response), true);
      assert.doesNotMatch(await response.text(), /at \/|fixture-proxy|token|password/);
    }
    assert.deepEqual(api.state.effects, []);
  });
}

for (const [entry, init, force] of [
  ["src/lib/freeProxyProviders/scheduler.ts", "initFreeProxyAutoSync", "forceFreeProxySyncCycle"],
  ["src/lib/proxyHealth/scheduler.ts", "initProxyHealthCheck", "forceProxyHealthSweep"],
]) {
  test(`${entry}: locked import/init has no timers; forced work denies without effects`, async () => {
    const api = await fixture(
      entry,
      "locked",
      { "./probeTarget.ts": probeMock },
      {
        FREE_PROXY_AUTO_SYNC_ENABLED: "true",
        PROXY_HEALTH_ENABLED: "true",
      }
    );
    fn<() => void>(api, init)();
    await assert.rejects(fn<() => Promise<void>>(api, force), (error) =>
      api.isRuntimePolicyError(error)
    );
    assert.deepEqual(api.state.effects, []);
  });
}

test("free proxy cycle rejects before invoking even a supplied provider or persisting errors", async () => {
  const api = await fixture("src/lib/freeProxyProviders/syncCycle.ts");
  let called = 0;
  const provider = {
    id: "fixture",
    sync: () => {
      called++;
      return {};
    },
  };
  await assert.rejects(
    fn<(providers: unknown[]) => Promise<void>>(api, "runFreeProxySyncCycle")([provider]),
    (error) => api.isRuntimePolicyError(error)
  );
  assert.equal(called, 0);
  assert.deepEqual(api.state.effects, []);
});

test("resolved values and malformed namespaces never become direct via falsey coercion", async () => {
  const api = await fixture();
  for (const proxy of [false, 0, "", undefined, [], {}]) {
    denied(() => api.assertRuntimePolicyConnectionProxyConfig({ proxyEnabled: false, proxy }), api);
  }
  api.assertRuntimePolicyConnectionProxyConfig({ proxyEnabled: false, proxy: null });
  for (const proxyConfig of [
    [],
    "opaque",
    false,
    { providers: [] },
    { global: false },
    { keys: { fixture: 0 } },
  ]) {
    denied(() => api.assertRuntimePolicyProxyConfig({ proxyEnabled: false, proxyConfig }, {}), api);
  }
  denied(() => api.assertRuntimePolicyProxyConfig({ featureFlags: [] }, {}), api);
  denied(() => api.assertRuntimePolicyProxyConfig({ proxyAssignments: {} }, {}), api);
});

const settingsMocks = {
  "./core": dbMock,
  "./encryption": "export const encrypt = (x) => x; export const decrypt = (x) => x;",
  "./settings/shared": "export const toRecord = (x) => x && typeof x === 'object' ? x : {};",
  "@omniroute/open-sse/config/providerModels.ts": "export const PROVIDER_ID_TO_ALIAS = {};",
  "@/shared/constants/bodySize": "export const requestBodyLimitMbFromEnv = () => 20;",
  "./featureFlags": `import { state } from "fixture:state"; export const getFeatureFlagOverrides = () => ({ ...state.flags });`,
  "./proxies": `import { state, touched } from "fixture:state";
    export const getProxyAssignments = async () => state.assignments;
    export const getProxyRegistryGeneration = () => 0;
    export const resolveProxyForScopeFromRegistry = async () => null;`,
  "@/shared/runtimePolicySettings": `
    import { assertRuntimePolicyProxyConfig } from "@/shared/runtimePolicyProxyConfig";
    import { RuntimePolicyError } from "@/shared/runtimePolicy";
    export function assertRuntimePolicySettings(candidate) {
      if (candidate.requireLogin === false) throw new RuntimePolicyError("management-auth-required");
      assertRuntimePolicyProxyConfig(candidate);
    }`,
};

test("settings write validates authoritative merged namespaces before onboarding/write/backup/hot reload", async () => {
  const api = await fixture("src/lib/db/settings.ts", "locked", settingsMocks, {
    INITIAL_PASSWORD: "fixture-only",
  });
  api.state.legacy = { global: "http://fixture-proxy.invalid:8080" };
  api.state.flags = { PROXY_AUTO_SELECT_ENABLED: "false" };
  const candidate = await fn<() => Promise<Record<string, unknown>>>(
    api,
    "getRuntimePolicySettingsCandidate"
  )();
  assert.equal(candidate.setupComplete, undefined);
  assert.deepEqual(api.state.effects, []);
  await assert.rejects(
    fn<(candidate: Record<string, unknown>) => Promise<unknown>>(
      api,
      "updateSettings"
    )({
      setupComplete: true,
      proxyConfig: {},
      proxyAssignments: [],
      featureFlags: {},
    }),
    (error) => api.isRuntimePolicyError(error)
  );
  assert.deepEqual(api.state.effects, []);
  assert.equal(api.state.legacy.global, "http://fixture-proxy.invalid:8080");
});

test("settings proxy resolution rejects selected legacy proxies and read errors without fallback effects", async () => {
  const api = await fixture("src/lib/db/settings.ts", "locked", settingsMocks);
  api.state.legacy = { keys: { fixture: "http://fixture-proxy.invalid:8080" } };
  const resolveProxy = fn<(id: string) => Promise<unknown>>(api, "resolveProxyForConnection");
  await assert.rejects(resolveProxy("fixture"), (error) => api.isRuntimePolicyError(error));
  assert.deepEqual(api.state.effects, []);
  const broken = await fixture("src/lib/db/settings.ts", "locked", {
    ...settingsMocks,
    "./core": "export const getDbInstance = () => { throw new Error('fixture read failed'); };",
  });
  await assert.rejects(
    fn<(id: string) => Promise<unknown>>(broken, "resolveProxyForConnection")("fixture"),
    (error) => broken.isRuntimePolicyError(error)
  );
  assert.deepEqual(broken.state.effects, []);
});

test("legacy cleanup cannot expose a lower proxy; dormant cleanup is allowed after disabling global", async () => {
  const api = await fixture("src/lib/db/settings.ts", "locked", {
    ...settingsMocks,
    "./backup": `import { state } from "fixture:state"; export const backupDbFile = () => state.effects.push("backup");`,
  });
  api.state.legacy = {
    global: "http://fallback.example.invalid:8080",
    providers: { fixture: "http://selected.example.invalid:8080" },
  };
  const clear = fn<(level: string, id: string) => Promise<unknown>>(api, "deleteProxyForLevel");
  await assert.rejects(clear("provider", "fixture"), (error) => api.isRuntimePolicyError(error));
  assert.deepEqual(api.state.effects, []);
  api.state.settings.proxyEnabled = false;
  await clear("provider", "fixture");
  assert.deepEqual(api.state.effects, ["write", "backup"]);
});

test("registry rotation denies before any cursor change, while empty pools remain direct", async () => {
  const api = await fixture("src/lib/db/proxies/rotation.ts", "locked", {
    "../core": dbMock,
    "./mappers": `export const normalizeScope = (x) => x;
      export const normalizeAssignmentScopeId = (scope, id) => scope === "global" ? "__global__" : id;
      export const toRegistryProxyResolution = () => { throw new Error("Unexpected selection"); };
      export const mapAssignmentRow = (x) => x;`,
  });
  const resolvePool = fn<(scope: string) => Promise<unknown>>(
    api,
    "resolveProxyForScopeFromRegistry"
  );
  assert.equal(await resolvePool("global"), null);
  api.state.assignments = [{ id: "fixture-a" }, { id: "fixture-b" }];
  await assert.rejects(resolvePool("global"), (error) => api.isRuntimePolicyError(error));
  assert.deepEqual(api.state.effects, []);
});

test("subscription service denies create/sync/apply and stays timer-free", async () => {
  const api = await fixture("src/lib/proxySubscription/subscriptionService.ts");
  for (const [name, input] of [
    [
      "createSubscription",
      { name: "fixture", url: "https://subscription.example.invalid", enabled: true },
    ],
    ["syncSubscription", "fixture"],
    ["applySubscription", "fixture"],
  ] as const) {
    await assert.rejects(fn<(value: unknown) => Promise<unknown>>(api, name)(input), (error) =>
      api.isRuntimePolicyError(error)
    );
  }
  fn<() => void>(api, "startSubscriptionScheduler")();
  fn<() => void>(api, "stopSubscriptionScheduler")();
  assert.deepEqual(api.state.effects, []);
});

test("subscription update rejects auto-sync activation before writing the subscription", async () => {
  const api = await fixture("src/lib/proxySubscription/subscriptionService.ts", "locked", {
    "../db/core": dbMock.replace(
      'if (sql.includes("proxy_registry")) return state.rows[0];',
      'if (sql.includes("proxy_registry") || sql.includes("proxy_subscriptions")) return state.rows[0];'
    ),
  });
  api.state.rows = [
    {
      id: "fixture",
      name: "fixture",
      url: "https://subscription.example.invalid",
      enabled: 1,
      mode: "global",
    },
  ];
  await assert.rejects(
    fn<(id: string, value: unknown) => Promise<unknown>>(api, "updateSubscription")("fixture", {
      url: "https://changed.example.invalid",
    }),
    (error) => api.isRuntimePolicyError(error)
  );
  assert.deepEqual(api.state.effects, []);
});

const registryMocks = {
  "./core": dbMock,
  crypto: "export const randomUUID = () => 'fixture-created';",
  "./proxies/mappers": `
    export const mapProxyRow = (x) => x;
    export const mapAssignmentRow = (x) => x;
    export const normalizeScope = (x) => x;
    export const normalizeAssignmentScopeId = (scope, id) => scope === "global" ? "__global__" : id;
    export const toLegacyProxyLevel = (x) => x;
    export const coerceProxyPayload = (x) => x;
    export const redactProxySecrets = (x) => x;
    export const extractRelayAuth = () => undefined;
  `,
  "./backup": `import { state } from "fixture:state"; export const backupDbFile = () => state.effects.push("backup");`,
  "./proxies/registryGeneration": `import { state } from "fixture:state";
    export const bumpProxyRegistryGeneration = () => state.effects.push("generation");
    export const getProxyRegistryGeneration = () => 0;`,
  "./settings": `import { state } from "fixture:state";
    export const bumpProxyConfigGeneration = () => state.effects.push("generation");
    export const getRuntimePolicySettingsCandidate = async () => ({
      ...state.settings, featureFlags: state.flags, proxyConfig: state.legacy,
      proxyAssignments: state.assignments,
    });`,
};

test("registry activation denies before writes; dormant row metadata/disable remains editable", async () => {
  const api = await fixture("src/lib/db/proxies.ts", "locked", registryMocks);
  const payload = { name: "fixture", type: "http", host: "proxy.example.invalid", port: 8080 };
  await assert.rejects(
    fn<(payload: unknown) => Promise<unknown>>(api, "createProxy")(payload),
    (error) => api.isRuntimePolicyError(error)
  );
  await assert.rejects(
    fn<(payload: unknown, assignment: unknown) => Promise<unknown>>(api, "createProxyAndAssign")(
      { ...payload, status: "disabled" },
      { scope: "global" }
    ),
    (error) => api.isRuntimePolicyError(error)
  );
  await assert.rejects(
    fn<(scope: string, id: null, proxyId: string) => Promise<unknown>>(api, "assignProxyToScope")(
      "global",
      null,
      "fixture"
    ),
    (error) => api.isRuntimePolicyError(error)
  );
  assert.deepEqual(api.state.effects, []);
  api.state.rows = [{ ...payload, id: "fixture", status: "active" }];
  api.state.settings.proxyEnabled = false;
  await fn<(id: string, payload: unknown) => Promise<unknown>>(api, "updateProxy")("fixture", {
    name: "renamed",
    status: "disabled",
  });
  assert.deepEqual(api.state.effects, ["write", "backup", "generation"]);
});

test("registry cleanup checks exposed lower selections; disable-global-first permits cleanup", async () => {
  const api = await fixture("src/lib/db/proxies.ts", "locked", registryMocks);
  api.state.assignments = [
    { scope: "account", scopeId: "fixture-connection", proxyId: "fixture-selected" },
    { scope: "global", scopeId: null, proxyId: "fixture-fallback" },
  ];
  const clear = fn<(scope: string, id: string, proxyId: null) => Promise<unknown>>(
    api,
    "assignProxyToScope"
  );
  await assert.rejects(clear("account", "fixture-connection", null), (error) =>
    api.isRuntimePolicyError(error)
  );
  assert.deepEqual(api.state.effects, []);
  api.state.settings.proxyEnabled = false;
  // A stub rotation cleanup records no SQL or network beyond this tested write.
  const allowed = await fixture("src/lib/db/proxies.ts", "locked", {
    ...registryMocks,
    "./proxies/rotation": `
      export const normalizeRotationScopeId = () => "fixture";
      export const clearRotationState = () => {};
      export const resetRotationCursor = () => {};
      export const normalizeRotationStrategy = (x) => x;
      export const getScopeProxyPool = () => [];
      export const getScopeRotationStrategy = () => "round-robin";
      export const resolveProxyForConnectionFromRegistry = () => null;
      export const resolveProxyForScopeFromRegistry = () => null;
    `,
  });
  allowed.state.assignments = api.state.assignments;
  allowed.state.settings.proxyEnabled = false;
  await fn<typeof clear>(allowed, "assignProxyToScope")("account", "fixture-connection", null);
  assert.deepEqual(allowed.state.effects, ["write", "backup", "generation"]);
});

test("batched proxy pool attachment denies at its DB primitive before writes", async () => {
  const api = await fixture("src/lib/db/proxySubscriptions.ts", "locked", {
    "./proxies/mappers": registryMocks["./proxies/mappers"],
  });
  await assert.rejects(
    fn<(scope: string, id: null, ids: string[]) => Promise<unknown>>(api, "addProxiesToScopePool")(
      "global",
      null,
      ["fixture"]
    ),
    (error) => api.isRuntimePolicyError(error)
  );
  assert.equal(
    await fn<(scope: string, id: null, ids: string[]) => Promise<unknown>>(
      api,
      "addProxiesToScopePool"
    )("global", null, []),
    0
  );
  assert.deepEqual(api.state.effects, []);
});

test("per-key admission requires populated bindings and honors both global and connection gates", async () => {
  const api = await fixture();
  const candidate = {
    proxyEnabled: true,
    perKeyProxyEnabled: true,
    proxyApiKeyAssignments: [{ id: "fixture-key", proxy_id: "fixture-proxy" }],
    proxyPerKeyConnectionEnabled: true,
  };
  denied(() => api.assertRuntimePolicyProxyConfig(candidate, {}), api);
  for (const direct of [
    { ...candidate, proxyEnabled: false },
    { ...candidate, perKeyProxyEnabled: false },
    { ...candidate, proxyPerKeyConnectionEnabled: false },
    { ...candidate, proxyApiKeyAssignments: [] },
  ])
    api.assertRuntimePolicyProxyConfig(direct, {});
  denied(
    () =>
      api.assertRuntimePolicyProxyConfig({ ...candidate, proxyApiKeyAssignments: "opaque" }, {}),
    api
  );
});

test("settings writer cannot spoof trusted per-key binding/connection facts before activation", async () => {
  const api = await fixture("src/lib/db/settings.ts", "locked", {
    ...settingsMocks,
    "./core": dbMock.replace(
      'if (sql.includes("COUNT")',
      'if (sql.includes("per_key_proxy_enabled = 1")) return { enabled: 1 }; if (sql.includes("COUNT")'
    ),
  });
  api.state.rows = [{ id: "fixture-key", proxy_id: "fixture-proxy" }];
  await assert.rejects(
    fn<(candidate: Record<string, unknown>) => Promise<unknown>>(
      api,
      "updateSettings"
    )({
      perKeyProxyEnabled: true,
      proxyApiKeyAssignments: [],
      proxyPerKeyConnectionEnabled: false,
    }),
    (error) => api.isRuntimePolicyError(error)
  );
  assert.deepEqual(api.state.effects, []);
});

test("setup completion never schedules the optional Codex catalog in locked mode; standalone still does", async () => {
  const mocks = {
    ...settingsMocks,
    "./backup": `import { state } from "fixture:state";
      export const backupDbFile = () => state.effects.push("backup");`,
    "./readCache": `import { state } from "fixture:state";
      export const invalidateDbCache = () => state.effects.push("invalidate");
      export const getCachedSettings = async () => state.settings;`,
    "@/lib/config/runtimeSettings": `import { state } from "fixture:state";
      export const applyRuntimeSettings = async () => state.effects.push("reload");`,
    "@/shared/services/codexCatalogRevalidation": `import { state } from "fixture:state";
      state.effects.push("catalog-import");
      export const scheduleCodexCatalogRevalidationAfterInit = () => state.effects.push("catalog-schedule");`,
  };
  for (const mode of ["locked", "standalone"] as const) {
    const api = await fixture("src/lib/db/settings.ts", mode, mocks);
    await fn<(candidate: Record<string, unknown>) => Promise<unknown>>(
      api,
      "updateSettings"
    )({ setupComplete: true });
    // Drain the existing fire-and-forget dynamic import chain, without timers.
    await Promise.resolve();
    await Promise.resolve();
    const expected = ["write", "write", "backup", "invalidate", "reload"];
    if (mode === "standalone") expected.push("catalog-import", "catalog-schedule");
    assert.deepEqual(api.state.effects, expected);
  }
});

test("locked requireLogin normalization with INITIAL_PASSWORD preserves stored setup and password", async () => {
  const settingsWriteDb = dbMock.replace(
    'state.effects.push("write");',
    `if (sql.startsWith("INSERT") && sql.includes("VALUES ('settings'")) {
      const key = args[0] ?? (sql.includes("'setupComplete'") ? "setupComplete" : "requireLogin");
      state.settings[key] = args.length ? JSON.parse(args[1]) : true;
      state.effects.push("write:" + key);
    } else state.effects.push("write");`
  );
  const api = await fixture(
    "src/lib/db/settings.ts",
    "locked",
    {
      ...settingsMocks,
      "./core": settingsWriteDb,
      "./backup": `import { state } from "fixture:state";
      export const backupDbFile = () => state.effects.push("backup");`,
      "./readCache": `import { state } from "fixture:state";
      export const invalidateDbCache = () => state.effects.push("invalidate");
      export const getCachedSettings = async () => state.settings;`,
      "@/lib/config/runtimeSettings": `import { state } from "fixture:state";
      export const applyRuntimeSettings = async () => state.effects.push("reload");`,
      "@/shared/services/codexCatalogRevalidation": `import { state } from "fixture:state";
      state.effects.push("catalog-import");
      export const scheduleCodexCatalogRevalidationAfterInit = () => state.effects.push("catalog-schedule");`,
    },
    { INITIAL_PASSWORD: "fixture-unused-bootstrap-password" }
  );
  const stored = {
    password: "$2b$12$" + "a".repeat(53),
    requireLogin: false,
    setupComplete: false,
    operatorNote: "fixture-preserved",
  };
  api.state.settings = { ...stored };
  // This is the exact write requested by stored-hash locked auth normalization.
  const result = await fn<(candidate: Record<string, unknown>) => Promise<Record<string, unknown>>>(
    api,
    "updateSettings"
  )({ requireLogin: true });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(api.state.settings, { ...stored, requireLogin: true, _settingsRevision: 1 });
  assert.equal(result.password, stored.password);
  assert.equal(result.setupComplete, false);
  assert.equal(result.requireLogin, true);
  assert.equal(result.operatorNote, stored.operatorNote);
  assert.deepEqual(api.state.effects, [
    "write:requireLogin",
    "write:_settingsRevision",
    "backup",
    "invalidate",
    "reload",
  ]);

  // Explicit setup completion is still a normal admitted write, without a
  // pre-write settings read injecting implicit setup/auth mutations.
  api.state.effects.length = 0;
  await fn<(candidate: Record<string, unknown>) => Promise<unknown>>(
    api,
    "updateSettings"
  )({ setupComplete: true });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(api.state.settings.password, stored.password);
  assert.equal(api.state.settings.operatorNote, stored.operatorNote);
  assert.deepEqual(api.state.effects, [
    "write:setupComplete",
    "write:_settingsRevision",
    "backup",
    "invalidate",
    "reload",
  ]);
});

test("default getSettings reads never auto-write onboarding in locked mode; standalone keeps bootstrap", async () => {
  for (const mode of ["locked", "standalone"] as const) {
    const api = await fixture("src/lib/db/settings.ts", mode, settingsMocks, {
      INITIAL_PASSWORD: "fixture-unused-bootstrap-password",
    });
    const original = {
      password: "$2b$12$" + "a".repeat(53),
      requireLogin: false,
      setupComplete: false,
      operatorNote: "fixture-preserved",
    };
    api.state.settings = { ...original };
    const result = await fn<() => Promise<Record<string, unknown>>>(api, "getSettings")();
    assert.equal(result.password, original.password);
    assert.equal(result.operatorNote, original.operatorNote);
    assert.equal(result.setupComplete, mode === "standalone");
    assert.equal(result.requireLogin, mode === "standalone");
    assert.deepEqual(api.state.effects, mode === "standalone" ? ["write", "write"] : []);
  }
});
