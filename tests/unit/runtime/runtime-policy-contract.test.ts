import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { registerHooks } from "node:module";
import {
  parseLockedPolicy,
  parseActivation,
  RuntimePolicyError,
  isRuntimePolicyError,
} from "../../../scripts/build/runtime-policy.mjs";

const DIRECTORY = "/run/omni-runtime-policy";
const MARKER = `${DIRECTORY}/required-v1.json`;
const POLICY = `${DIRECTORY}/policy.json`;
const PROFILE = "omni-app-residential-direct-v1";
const emptyPolicy = () => ({ schema: 1, profile: PROFILE, providers: [], helpers: [] });
const builtin = { kind: "builtin", providerId: "fixture-builtin" };
const configured = {
  kind: "configured",
  binding: { kind: "node", providerId: "fixture-compatible", nodeId: "fixture-node" },
  adapter: "compatible-node-base-url-v1",
  endpoint: "https://provider.example.invalid/v1",
};
const helper = { role: "browser-cdp", endpoint: "http://127.0.0.1:19222" };
const synthetic = () => ({ ...emptyPolicy(), providers: [builtin, configured], helpers: [helper] });
let sequence = 0;

function metadata(directory: boolean, size = 1) {
  return {
    dev: 1,
    ino: 2,
    uid: 0,
    gid: 0,
    mode: directory ? 0o40555 : 0o100444,
    nlink: directory ? 2 : 1,
    size,
    mtimeMs: 1,
    ctimeMs: 1,
    isDirectory: () => directory,
    isFile: () => !directory,
    isSymbolicLink: () => false,
  };
}

// Mock only the reserved reader boundary. Never writes /run, never touches a DB,
// never adds a production path override or singleton setter.
function fixture(t: TestContext, policy = synthetic()) {
  const bytes = Buffer.from(JSON.stringify(policy));
  const marker = Buffer.from(
    JSON.stringify({
      schema: 1,
      profile: PROFILE,
      policySha256: createHash("sha256").update(bytes).digest("hex"),
    })
  );
  const files = new Map([
    [MARKER, marker],
    [POLICY, bytes],
  ]);
  const stats = new Map([
    ["/", metadata(true)],
    ["/run", metadata(true)],
    [DIRECTORY, metadata(true)],
    [MARKER, metadata(false, marker.length)],
    [POLICY, metadata(false, bytes.length)],
  ]);
  const descriptors = new Map<number, string>();
  const originals = {
    lstatSync: fs.lstatSync,
    openSync: fs.openSync,
    fstatSync: fs.fstatSync,
    readFileSync: fs.readFileSync,
    closeSync: fs.closeSync,
  };
  let reads = 0;
  t.mock.method(fs, "lstatSync", (path: string, ...args: unknown[]) => {
    if (path === "/" || path === "/run" || String(path).startsWith(DIRECTORY)) {
      if (!stats.has(path))
        throw Object.assign(new Error("private path absent"), { code: "ENOENT" });
      return stats.get(path);
    }
    return Reflect.apply(originals.lstatSync, fs, [path, ...args]);
  });
  t.mock.method(fs, "openSync", (path: string, flags: number, ...args: unknown[]) => {
    if (!String(path).startsWith(DIRECTORY))
      return Reflect.apply(originals.openSync, fs, [path, flags, ...args]);
    assert.ok(flags & fs.constants.O_NOFOLLOW);
    if (!files.has(path)) throw Object.assign(new Error("private file absent"), { code: "ENOENT" });
    const fd = 40000 + descriptors.size;
    descriptors.set(fd, path);
    return fd;
  });
  t.mock.method(fs, "fstatSync", (fd: number, ...args: unknown[]) =>
    descriptors.has(fd)
      ? stats.get(descriptors.get(fd)!)
      : Reflect.apply(originals.fstatSync, fs, [fd, ...args])
  );
  t.mock.method(fs, "readFileSync", (fd: number, ...args: unknown[]) => {
    if (!descriptors.has(fd)) return Reflect.apply(originals.readFileSync, fs, [fd, ...args]);
    reads++;
    return files.get(descriptors.get(fd)!);
  });
  t.mock.method(fs, "closeSync", (fd: number) => {
    if (!descriptors.has(fd)) return originals.closeSync(fd);
    descriptors.delete(fd);
  });
  return {
    stats,
    files,
    descriptors,
    get reads() {
      return reads;
    },
  };
}

async function reader() {
  return import(`../../../scripts/build/runtime-policy.mjs?fixture=${sequence++}`) as Promise<
    typeof import("../../../scripts/build/runtime-policy.mjs")
  >;
}

function denied(reason = "bootstrap-invalid") {
  return (error: unknown) => {
    assert.ok(isRuntimePolicyError(error));
    assert.equal(error.code, "OMNI_RUNTIME_POLICY_DENIED");
    assert.equal(error.reason, reason);
    assert.ok(!error.message.includes("/run"));
    assert.ok(!error.message.includes("ENOENT"));
    assert.equal("cause" in error, false);
    return true;
  };
}

test("strict policy schema normalizes and deeply freezes only synthetic grants", () => {
  const parsed = parseLockedPolicy(synthetic());
  assert.equal(parsed.providers[0].kind, "builtin");
  assert.equal(parsed.helpers[0].endpoint, "http://127.0.0.1:19222/");
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.providers));
  assert.ok(Object.isFrozen(parsed.providers[1]));
  if (parsed.providers[1].kind === "configured")
    assert.ok(Object.isFrozen(parsed.providers[1].binding));
  assert.equal(Reflect.set(parsed, "profile", "other"), false);
  assert.deepEqual(parseLockedPolicy(emptyPolicy()), emptyPolicy());
});

for (const [name, value] of [
  ["unknown profile", { ...emptyPolicy(), profile: "unlocked" }],
  ["extra field", { ...emptyPolicy(), requireAuth: false }],
  ["invalid version", { ...emptyPolicy(), schema: "1" }],
  ["unknown adapter", { ...emptyPolicy(), providers: [{ ...configured, adapter: "wildcard" }] }],
  ["duplicate builtin", { ...emptyPolicy(), providers: [builtin, builtin] }],
  [
    "duplicate binding",
    {
      ...emptyPolicy(),
      providers: [configured, { ...configured, endpoint: "https://different.invalid" }],
    },
  ],
  [
    "extra binding key",
    {
      ...emptyPolicy(),
      providers: [{ ...configured, binding: { ...configured.binding, connectionId: "other" } }],
    },
  ],
  ["grant wildcard", { ...emptyPolicy(), providers: [{ kind: "wildcard", providerId: "*" }] }],
  ["duplicate helper role", { ...emptyPolicy(), helpers: [helper, helper] }],
  [
    "unknown helper role",
    { ...emptyPolicy(), helpers: [{ role: "proxy", endpoint: helper.endpoint }] },
  ],
] as const) {
  test(`schema rejects ${name}`, () => assert.throws(() => parseLockedPolicy(value), denied()));
}

for (const endpoint of [
  "https://u:p@provider.invalid/v1",
  "https://@provider.invalid/v1",
  "https:///provider.invalid/v1",
  "https://provider.invalid/v1?",
  "https://provider.invalid/v1#",
  "file:///tmp/x",
  "https://provider.invalid/space here",
]) {
  test(`rejects unsafe approval URL ${endpoint}`, () =>
    assert.throws(
      () =>
        parseLockedPolicy({
          ...emptyPolicy(),
          providers: [{ ...configured, endpoint }],
        }),
      denied()
    ));
}
for (const endpoint of [
  "http://localhost:19222",
  "http://remote.invalid:19222",
  "http://127.1:19222",
  "http://2130706433:19222",
  "http://0x7f000001:19222",
  "http://127.0.0.1:0",
  "http://127.0.0.1:19222/#x",
]) {
  test(`rejects nonliteral or invalid helper ${endpoint}`, () =>
    assert.throws(
      () =>
        parseLockedPolicy({
          ...emptyPolicy(),
          helpers: [{ ...helper, endpoint }],
        }),
      denied()
    ));
}

test("marker requires exact lowercase digest, schema/profile and no enable/path fields", () => {
  const marker = { schema: 1, profile: PROFILE, policySha256: "a".repeat(64) };
  assert.deepEqual(parseActivation(marker), marker);
  for (const bad of [
    { ...marker, policySha256: "A".repeat(64) },
    { ...marker, path: "/tmp/policy" },
    { ...marker, enabled: false },
  ]) {
    assert.throws(() => parseActivation(bad), denied());
  }
});

test("absent activation directory retains standalone assertions and cannot satisfy required bootstrap", async (t) => {
  const f = fixture(t);
  f.stats.delete(DIRECTORY);
  const r = await reader();
  assert.deepEqual(r.getRuntimePolicy(), { mode: "standalone" });
  r.assertNoApplicationProxy("configured");
  r.assertProviderEntrypoint({ kind: "builtin", providerId: "not-approved" });
  r.assertLocalHelper({
    role: "browser-cdp",
    endpoint: "https://remote.invalid",
    phase: "connect",
  });
  r.assertNotLockedCapability("arbitrary-launcher");
  assert.equal(r.requiresLockedManagementAuth(), false);
  assert.equal(f.reads, 0);
  assert.throws(() => r.requireLockedBootstrap(), denied());
  assert.throws(() => r.getRuntimePolicy(), denied());
});

test("valid protected revision is cached, immutable and independent in each bundled reader", async (t) => {
  const f = fixture(t);
  const r = await reader();
  const state = r.requireLockedBootstrap();
  assert.equal(state.mode, "locked");
  assert.equal(r.requiresLockedManagementAuth(), true);
  assert.ok(Object.isFrozen(state.policy.helpers));
  r.assertNoApplicationProxy("none");
  r.assertProviderEntrypoint(builtin as Parameters<typeof r.assertProviderEntrypoint>[0]);
  r.assertProviderEntrypoint(configured as Parameters<typeof r.assertProviderEntrypoint>[0]);
  r.assertLocalHelper({ ...helper, role: "browser-cdp", phase: "connect" });
  r.assertLocalHelper({
    role: "browser-cdp",
    endpoint: "ws://127.0.0.1:19222/devtools/browser/fixture-id",
    phase: "advertised-cdp-websocket",
  });
  assert.throws(() => r.assertNoApplicationProxy("opaque"), denied("proxy-forbidden"));
  assert.throws(() => r.assertNotLockedCapability("installer"), denied("capability-disabled"));
  assert.throws(
    () => r.assertProviderEntrypoint({ kind: "builtin", providerId: "other" }),
    denied("entrypoint-unapproved")
  );
  for (const endpoint of [
    "ws://127.0.0.1:19223/devtools/browser/id",
    "ws://localhost:19222/devtools/browser/id",
    "ws://127.0.0.1:19222/not-devtools",
    "wss://127.0.0.1:19222/devtools/browser/id",
  ]) {
    assert.throws(
      () =>
        r.assertLocalHelper({ role: "browser-cdp", endpoint, phase: "advertised-cdp-websocket" }),
      denied("helper-unapproved")
    );
  }
  f.files.delete(POLICY);
  assert.equal(r.getRuntimePolicy(), state);
  assert.equal(f.reads, 2);
  const otherBundle = await reader();
  assert.throws(() => otherBundle.getRuntimePolicy(), denied());
});

for (const missing of [MARKER, POLICY]) {
  test(`torn directory missing ${missing.split("/").pop()} is sticky wrapped failure`, async (t) => {
    const f = fixture(t);
    const saved = f.stats.get(missing)!;
    f.stats.delete(missing);
    const r = await reader();
    assert.throws(() => r.getRuntimePolicy(), denied());
    f.stats.set(missing, saved);
    assert.throws(() => r.getRuntimePolicy(), denied());
    assert.throws(() => r.assertNoApplicationProxy("none"), denied());
  });
}
for (const [name, path, change] of [
  ["activation directory writable", DIRECTORY, { mode: 0o40755 }],
  ["untrusted ancestry", "/run", { mode: 0o40777 }],
  ["wrong directory owner", DIRECTORY, { uid: 10001 }],
  ["wrong file owner", POLICY, { uid: 10001 }],
  ["wrong file group", MARKER, { gid: 10001 }],
  ["writable file", POLICY, { mode: 0o100644 }],
  ["hard linked file", POLICY, { nlink: 2 }],
  ["oversized policy", POLICY, { size: 262145 }],
  ["symlink file", POLICY, { isSymbolicLink: () => true }],
  ["nonregular file", POLICY, { isFile: () => false }],
] as const) {
  test(`provenance rejects ${name}`, async (t) => {
    const f = fixture(t);
    Object.assign(f.stats.get(path)!, change);
    const r = await reader();
    assert.throws(() => r.getRuntimePolicy(), denied());
    assert.equal(f.descriptors.size, 0);
  });
}
test("digest mismatch and file size race deny without raw filesystem errors", async (t) => {
  const f = fixture(t);
  const bytes = f.files.get(POLICY)!;
  f.files.set(POLICY, Buffer.from(bytes.toString().replace("fixture-builtin", "fixture-replace")));
  const r = await reader();
  assert.throws(() => r.getRuntimePolicy(), denied());
});

test("error and response brands survive duplicate readers but cannot come from public JSON/headers", async () => {
  const a = await reader();
  const b = await reader();
  const error = new a.RuntimePolicyError("proxy-forbidden");
  assert.equal(b.isRuntimePolicyError(error), true);
  assert.equal(b.isRuntimePolicyError(JSON.parse(JSON.stringify(error))), false);
  assert.equal(
    b.isRuntimePolicyError({ code: "OMNI_RUNTIME_POLICY_DENIED", reason: "proxy-forbidden" }),
    false
  );
  const response = a.markRuntimePolicyResponse(new Response(null, { status: 403 }));
  assert.equal(b.isRuntimePolicyResponse(response), true);
  assert.equal(
    b.isRuntimePolicyResponse(new Response(null, { headers: { "x-runtime-policy": "true" } })),
    false
  );
  assert.equal(isRuntimePolicyError(new RuntimePolicyError("management-auth-required")), true);
});

test("proxy module rejects torn activation synchronously before optional DB warmup", async (t) => {
  const f = fixture(t);
  f.stats.delete(POLICY);
  let warms = 0;
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.endsWith("server/authz/pipeline"))
        return {
          shortCircuit: true,
          url: "data:text/javascript,export const runAuthzPipeline=()=>{}",
        };
      if (specifier.endsWith("lib/db/readCache")) {
        warms++;
        return {
          shortCircuit: true,
          url: "data:text/javascript,export const getCachedSettings=async()=>({})",
        };
      }
      return nextResolve(specifier, context);
    },
  });
  try {
    await assert.rejects(import("../../../src/proxy.ts"), denied());
    assert.equal(warms, 0);
  } finally {
    hooks.deregister();
  }
});

function moduleData(code: string): string {
  return `data:text/javascript,${encodeURIComponent(code)}`;
}
const coreUrl = new URL("../../../scripts/build/runtime-policy.mjs", import.meta.url).href;

// Loader fixtures replace only dependencies in fresh module copies. They never
// change/reset the canonical reader or create a real activation directory.
function lockedFacadeFixture(): string {
  return moduleData(`
    import { RuntimePolicyError } from ${JSON.stringify(coreUrl)};
    export { RuntimePolicyError, isRuntimePolicyError, markRuntimePolicyResponse,
      isRuntimePolicyResponse } from ${JSON.stringify(coreUrl)};
    export const getRuntimePolicy = () => ({mode:"locked", policy:{providers:[],helpers:[]}});
    export const requiresLockedManagementAuth = () => true;
    export const assertNotLockedCapability = () => { throw new RuntimePolicyError("capability-disabled"); };
    export const assertNoApplicationProxy = selection => {
      if (selection !== "none") throw new RuntimePolicyError("proxy-forbidden");
    };
    export const assertProviderEntrypoint = () => { throw new RuntimePolicyError("entrypoint-unapproved"); };
    export const assertLocalHelper = () => { throw new RuntimePolicyError("helper-unapproved"); };
    export const requireLockedBootstrap = getRuntimePolicy;
  `);
}

test("pure merged admission imports no DB and rejects auth bypass before proxy/helper validators", async () => {
  const eventsUrl = moduleData("export const events = [];");
  const { events } = (await import(eventsUrl)) as { events: string[] };
  const policyUrl = lockedFacadeFixture();
  const facadeUrl = new URL(
    `../../../src/shared/runtimePolicy.ts?composition=${sequence++}`,
    import.meta.url
  ).href;
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "./runtimePolicy" && context.parentURL?.includes("runtimePolicySettings"))
        return { url: facadeUrl, shortCircuit: true };
      if (specifier.includes("runtime-policy.mjs") && context.parentURL === facadeUrl)
        return { url: policyUrl, shortCircuit: true };
      if (specifier === "./runtimePolicyProxyConfig")
        return {
          url: moduleData(
            `import {events} from ${JSON.stringify(eventsUrl)}; export const assertRuntimePolicyProxyConfig=()=>events.push("proxy");`
          ),
          shortCircuit: true,
        };
      if (specifier === "./runtimePolicyEntrypoints")
        return {
          url: moduleData(
            `import {events} from ${JSON.stringify(eventsUrl)}; export const validateRuntimeHelperSettings=()=>events.push("helper");`
          ),
          shortCircuit: true,
        };
      assert.ok(
        !specifier.includes("/db/") && !specifier.includes("managementPassword"),
        "pure composition must not load a DB-capable module"
      );
      return nextResolve(specifier, context);
    },
  });
  try {
    const { assertRuntimePolicySettings } = await import(
      `../../../src/shared/runtimePolicySettings.ts?composition=${sequence++}`
    );
    assert.throws(
      () => assertRuntimePolicySettings({ requireLogin: false, password: "fixture-only-password" }),
      denied("management-auth-required")
    );
    assert.deepEqual(events, []);
    for (const newPassword of ["CHANGEME", "        "]) {
      assert.throws(
        () =>
          assertRuntimePolicySettings({
            requireLogin: true,
            password: "fixture-existing-password",
            newPassword,
          }),
        denied("management-auth-required")
      );
    }
    assert.deepEqual(events, []);
    assertRuntimePolicySettings({ requireLogin: true, password: "fixture-only-password" });
    assert.deepEqual(events, ["proxy", "helper"]);
  } finally {
    hooks.deregister();
  }
});

for (const [invalid, hasSyntheticConnection] of [
  [false, false],
  [true, false],
  [false, true],
]) {
  test(`locked startup ${invalid ? "rejects invalid" : "awaits valid"} admission before network startup (resolved connection=${hasSyntheticConnection})`, async () => {
    const eventsUrl = moduleData(
      `export const events = []; export const invalid = ${invalid}; export const hasSyntheticConnection = ${hasSyntheticConnection};`
    );
    const { events } = (await import(eventsUrl)) as { events: string[] };
    const policyUrl = lockedFacadeFixture();
    const fixtureUrl = moduleData(`
      import {events,invalid,hasSyntheticConnection} from ${JSON.stringify(eventsUrl)};
      import {RuntimePolicyError} from ${JSON.stringify(coreUrl)};
      export const ensureDbInitialized=async()=>{events.push("db");};
      export const markServerStarting=()=>events.push("starting");
      export const markServerReady=()=>events.push("ready");
      export const getSettings=async options=>{if(options.autoCompleteSetup!==false)throw new Error("onboarding write allowed"); events.push("settings"); return {requireLogin:false,password:"fixture"};};
      export const getRuntimePolicySettingsCandidate=async()=>{events.push("candidate");return {requireLogin:false,password:"fixture",featureFlags:{},proxyConfig:{},proxyAssignments:[]};};
      export const assertLockedManagementAuthProvisioned=()=>{events.push("auth");if(invalid)throw new RuntimePolicyError("management-auth-required");};
      export const assertRuntimePolicySettings=candidate=>{events.push("settings-admit");if(candidate.requireLogin!==true)throw new Error("mutable auth not overridden");};
      export const validateRuntimeHelperEnvironment=()=>events.push("helper-env");
      export const assertRuntimeEntrypointInventory=()=>events.push("inventory");
      export const assertResolvedProviderConnectionEntrypoint=async candidate=>{await Promise.resolve();events.push("connection-admit");return candidate;};
      export const validateProviderNodeCandidate=()=>events.push("node-admit");
      export const getProviderConnections=async()=>{events.push("connections");return hasSyntheticConnection?[{id:"fixture-connection",provider:"fixture-builtin"}]:[];};
      export const getProviderNodes=async()=>{events.push("nodes");return [];};
      export const ensurePersistentManagementPasswordHash=async()=>{events.push("migrate");};
    `);
    const hooks = registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "@/shared/runtimePolicy") return { url: policyUrl, shortCircuit: true };
        if (
          [
            "@/lib/db/core",
            "@/lib/serverLifecycle",
            "@/lib/db/settings",
            "@/lib/auth/managementPassword",
            "@/shared/runtimePolicySettings",
            "@/shared/runtimePolicyEntrypoints",
            "@/sse/services/compatibleNodeBaseUrl",
            "@/lib/db/providers",
          ].includes(specifier)
        )
          return { url: fixtureUrl, shortCircuit: true };
        if (specifier.includes("proxyFetch"))
          return {
            url: moduleData(
              `import {events} from ${JSON.stringify(eventsUrl)}; events.push("network-boundary"); throw new Error("STOP_SYNTHETIC_NETWORK_BOUNDARY");`
            ),
            shortCircuit: true,
          };
        return nextResolve(specifier, context);
      },
    });
    try {
      const { registerNodejs } = await import(
        `../../../src/instrumentation-node.ts?startup=${sequence++}`
      );
      await assert.rejects(
        registerNodejs(),
        invalid ? denied("management-auth-required") : /STOP_SYNTHETIC_NETWORK_BOUNDARY/
      );
      assert.deepEqual(
        events,
        invalid
          ? ["starting", "db", "settings", "auth"]
          : [
              "starting",
              "db",
              "settings",
              "auth",
              "candidate",
              "settings-admit",
              "helper-env",
              "inventory",
              "connections",
              ...(hasSyntheticConnection ? ["connection-admit"] : []),
              "nodes",
              "migrate",
              "network-boundary",
            ]
      );
    } finally {
      hooks.deregister();
    }
  });
}

test("locked legacy import denies before body read, backup, DB mutation or cache changes", async () => {
  const policyUrl = lockedFacadeFixture();
  const effects: string[] = [];
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "@/shared/runtimePolicy") return { url: policyUrl, shortCircuit: true };
      if (specifier === "@/shared/utils/apiAuth")
        return {
          url: moduleData(
            "export const isAuthRequired=async()=>true; export const isAuthenticated=async()=>true;"
          ),
          shortCircuit: true,
        };
      const names: Record<string, string[]> = {
        "@/lib/db/core": ["getDbInstance"],
        "@/lib/db/backup": ["backupDbFile"],
        "@/lib/db/apiKeys": ["clearApiKeyCaches"],
        "@/lib/db/readCache": ["invalidateDbCache"],
        "@/lib/db/jsonMigration": ["runJsonMigration"],
        "@/lib/db/settings": ["getSettings"],
        "@omniroute/open-sse/services/systemPrompt.ts": ["setSystemPromptConfig"],
      };
      if (names[specifier])
        return {
          url: moduleData(
            names[specifier]
              .map(
                (name) =>
                  `export const ${name}=()=>{throw new Error("unexpected import effect ${name}");};`
              )
              .join("\n")
          ),
          shortCircuit: true,
        };
      return nextResolve(specifier, context);
    },
  });
  try {
    const { POST } = await import(
      `../../../src/app/api/settings/import-json/route.ts?locked=${sequence++}`
    );
    const request = new Request("http://127.0.0.1/api/settings/import-json", {
      method: "POST",
      body: "fixture",
    });
    request.text = async () => {
      effects.push("read-body");
      return "{}";
    };
    const response = await POST(request);
    assert.equal(response.status, 403);
    assert.deepEqual(effects, []);
    const body = await response.json();
    assert.equal(body.error.message.includes("/run"), false);
    const { isRuntimePolicyResponse } = await import(coreUrl);
    assert.equal(isRuntimePolicyResponse(response), true);
  } finally {
    hooks.deregister();
  }
});

for (const [name, patch, status] of [
  ["auth bypass", { requireLogin: false, newPassword: "fixture-replacement" }, 403],
  ["forwarding override", { cliproxyapi_url: "https://fixture.invalid" }, 403],
  ["known placeholder", { newPassword: "CHANGEME", currentPassword: "fixture-current" }, 403],
  ["blank password", { newPassword: "        ", currentPassword: "fixture-current" }, 403],
  [
    "valid password",
    { newPassword: "fixture-valid-replacement", currentPassword: "fixture-current" },
    200,
  ],
] as const) {
  test(`settings PATCH applies real merged admission to ${name} before hash/write`, async () => {
    const eventsUrl = moduleData(
      `export const effects = []; export const patch=${JSON.stringify(patch)};`
    );
    const { effects } = (await import(eventsUrl)) as { effects: string[] };
    const policyUrl = lockedFacadeFixture();
    const facadeUrl = new URL(
      `../../../src/shared/runtimePolicy.ts?patch=${sequence++}`,
      import.meta.url
    ).href;
    const compositionUrl = new URL(
      `../../../src/shared/runtimePolicySettings.ts?patch=${sequence++}`,
      import.meta.url
    ).href;
    const fixtureUrl = moduleData(`
      import {effects} from ${JSON.stringify(eventsUrl)};
      import {RuntimePolicyError} from ${JSON.stringify(coreUrl)};
      const settings={requireLogin:true,password:"fixture-hash"};
      export const getSettings=async()=>settings;
      export const getRuntimePolicySettingsCandidate=async patch=>{effects.push("candidate");return {...settings,...patch};};
      export const assertRuntimePolicyProxyConfig=()=>effects.push("proxy-admit");
      export const validateRuntimeHelperSettings=()=>effects.push("helper-admit");
      export const updateSettings=async()=>{effects.push("write");return settings;};
      export const getSettingsRevision=async()=>0;
      export class SettingsRevisionConflictError extends Error {}
      export const getRuntimePorts=()=>({});
      export const updateSettingsSchema={};
      export const validateBody=(_schema,data)=>({data});
      export const isValidationFailure=()=>false;
      export const getConsistentMachineId=async()=>"fixture";
      export const isFeatureFlagEnabled=()=>false;
      export const resolveModelLockoutSettings=value=>value;
      export const validateProxyUrl=()=>({valid:true});
      export const upsertUpstreamProxyConfig=async()=>effects.push("forwarding-write");
      export const getUpstreamProxyConfig=async()=>null;
      export const getProviderConnections=async()=>[];
      export const clearCliproxyapiUrlCache=()=>effects.push("clear-cache");
      export const ensurePersistentManagementPasswordHash=async()=>{effects.push("migrate");return {settings};};
      export const getStoredManagementPassword=()=>settings.password;
      export const hasManagementPasswordConfigured=()=>true;
      export const hashManagementPassword=async()=>{effects.push("hash");return "fixture-hash";};
      export const verifyManagementPassword=async()=>true;
      export const requireManagementAuth=async()=>null;
      export const isPaidModelTarget=()=>false;
      export const getAuditRequestContext=()=>({});
      export const logAuditEvent=event=>effects.push("audit:"+event.action);
      export const isAuthRequired=async()=>true;
      export const isDashboardSessionAuthenticated=async()=>true;
      export const isCliTokenAuthValid=async()=>false;
      export const extractApiKey=()=>null;
      export const getApiKeyMetadata=async()=>null;
      export const getRadarAdminUrl=()=>null;
      export const readSubjectFromHeaders=()=>({kind:"dashboard_session"});
      export const AUTHZ_HEADER_AUTH_ID="x-omniroute-auth-id";
      export const AUTHZ_HEADER_AUTH_KIND="x-omniroute-auth-kind";
      export const AUTHZ_HEADER_PEER_LOCALITY="x-omniroute-peer-locality";
    `);
    const hooks = registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "@/shared/runtimePolicy") return { url: policyUrl, shortCircuit: true };
        if (specifier === "@/shared/runtimePolicySettings")
          return { url: compositionUrl, shortCircuit: true };
        if (specifier === "./runtimePolicy" && context.parentURL === compositionUrl)
          return { url: facadeUrl, shortCircuit: true };
        if (specifier.includes("runtime-policy.mjs") && context.parentURL === facadeUrl)
          return { url: policyUrl, shortCircuit: true };
        if (
          ["./runtimePolicyProxyConfig", "./runtimePolicyEntrypoints"].includes(specifier) &&
          context.parentURL === compositionUrl
        )
          return { url: fixtureUrl, shortCircuit: true };
        if (
          context.parentURL?.includes("src/app/api/settings/route.ts") &&
          (specifier.startsWith("@/") || specifier.includes("executors/cliproxyapi"))
        )
          return { url: fixtureUrl, shortCircuit: true };
        return nextResolve(specifier, context);
      },
    });
    try {
      const { PATCH } = await import(`../../../src/app/api/settings/route.ts?locked=${sequence++}`);
      const response = await PATCH(
        new Request("http://127.0.0.1/api/settings", {
          method: "PATCH",
          body: JSON.stringify(patch),
        })
      );
      assert.equal(response.status, status);
      assert.deepEqual(
        effects,
        status === 200
          ? ["candidate", "proxy-admit", "helper-admit", "migrate", "hash", "write"]
          : "cliproxyapi_url" in patch
            ? ["audit:settings.update_failed"]
            : ["candidate", "audit:settings.update_failed"]
      );
      const { isRuntimePolicyResponse } = await import(coreUrl);
      assert.equal(isRuntimePolicyResponse(response), status === 403);
      if (status === 403) {
        assert.equal(effects.includes("hash"), false);
        assert.equal(effects.includes("write"), false);
        assert.equal(effects.includes("migrate"), false);
        assert.ok(!(await response.text()).includes("fixture-current"));
      } else {
        assert.equal((await response.json()).requireLogin, true);
      }
    } finally {
      hooks.deregister();
    }
  });
}

test("catalog warmup cannot swallow a branded policy rejection", async () => {
  const failure = new RuntimePolicyError("entrypoint-unapproved");
  const fixtureUrl = moduleData(
    `import {RuntimePolicyError} from ${JSON.stringify(coreUrl)}; export const getUnifiedModelsResponse=async()=>{throw new RuntimePolicyError("entrypoint-unapproved");};`
  );
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "@/app/api/v1/models/catalog")
        return { url: fixtureUrl, shortCircuit: true };
      return nextResolve(specifier, context);
    },
  });
  try {
    const { warmModelCatalogCache } = await import(
      `../../../src/instrumentation-node.ts?warmup=${sequence++}`
    );
    await assert.rejects(warmModelCatalogCache(), denied(failure.reason));
  } finally {
    hooks.deregister();
  }
});
