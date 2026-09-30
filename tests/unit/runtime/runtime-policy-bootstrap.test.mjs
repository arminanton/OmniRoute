import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const runnerSource = fs.readFileSync(
  new URL("../../../scripts/dev/run-standalone.mjs", import.meta.url),
  "utf8"
);
const runtimeEnvUrl = new URL("../../../scripts/build/runtime-env.mjs", import.meta.url).href;
const runtimePolicyUrl = new URL("../../../scripts/build/runtime-policy.mjs", import.meta.url).href;
const LOCKED_PATH = "/usr/local/bin:/usr/bin:/bin";
const LOCKED_FLAGS = ["--dns-result-order=ipv4first", "--max-old-space-size=2048"];
const unsafeEnv = {
  PATH: "/fixture/writable/bin",
  NODE_OPTIONS: "--import=/fixture/writable/preload.mjs --max-old-space-size=16384",
  NODE_PATH: "/fixture/writable/modules",
  NODE_EXTRA_CA_CERTS: "/fixture/writable/ca.pem",
  NODE_TLS_REJECT_UNAUTHORIZED: "0",
  NODE_USE_SYSTEM_CA: "1",
  NODE_USE_ENV_PROXY: "1",
  NODE_ICU_DATA: "/fixture/writable/icu",
  NODE_V8_COVERAGE: "/fixture/writable/coverage",
  LD_PRELOAD: "/fixture/writable/preload.so",
  LD_LIBRARY_PATH: "/fixture/writable/lib",
  LD_AUDIT: "/fixture/writable/audit.so",
  DYLD_INSERT_LIBRARIES: "/fixture/writable/preload.dylib",
  DYLD_LIBRARY_PATH: "/fixture/writable/lib",
  OPENSSL_CONF: "/fixture/writable/openssl.cnf",
  OPENSSL_MODULES: "/fixture/writable/openssl-modules",
  OPENSSL_ENGINES: "/fixture/writable/engines",
  SSL_CERT_FILE: "/fixture/writable/ca.pem",
  SSL_CERT_DIR: "/fixture/writable/certs",
};

// Only the copied runner executes. Its policy reader, env bootstrap, and spawn are
// inert fixture modules. No real policy path, config, DB, app, or helper is opened.
function runFixture(t, { mode = "locked", mergedEnv = {}, ws = true, shellEnv = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "policy-runner-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "dev"));
  fs.mkdirSync(path.join(dir, "build"));
  fs.writeFileSync(path.join(dir, "dev", "run-standalone.mjs"), runnerSource);
  fs.writeFileSync(path.join(dir, "server.js"), 'throw new Error("must not execute server");\n');
  if (ws) {
    fs.writeFileSync(path.join(dir, "server-ws.mjs"), 'throw new Error("must not execute WS");\n');
  }
  fs.writeFileSync(
    path.join(dir, "trace.mjs"),
    `export const events = [];\nexport const launches = [];\n` +
      `export const mergedEnv = Object.freeze(${JSON.stringify(mergedEnv)});\n`
  );
  fs.writeFileSync(
    path.join(dir, "build", "bootstrap-env.mjs"),
    'import { events, mergedEnv } from "../trace.mjs";\n' +
      'export function bootstrapEnv() { events.push("bootstrapEnv"); return mergedEnv; }\n'
  );
  fs.writeFileSync(
    path.join(dir, "build", "runtime-env.mjs"),
    `export { resolveRuntimePorts, withRuntimePortEnv, resolveMaxOldSpaceMb, ` +
      `warnConflictingHeapLimits, buildStandaloneNodeOptions } from ${JSON.stringify(runtimeEnvUrl)};\n` +
      'import { events, launches } from "../trace.mjs";\n' +
      "export function spawnWithForwardedSignals(command, args, options) {\n" +
      '  events.push("spawn"); launches.push({ command, args, options });\n}\n'
  );
  if (mode !== "missing") {
    const result =
      mode === "invalid"
        ? 'throw new RuntimePolicyError("bootstrap-invalid");'
        : `return Object.freeze({ mode: ${JSON.stringify(mode)} });`;
    fs.writeFileSync(
      path.join(dir, "build", "runtime-policy.mjs"),
      'import { events } from "../trace.mjs";\n' +
        `import { RuntimePolicyError } from ${JSON.stringify(runtimePolicyUrl)};\n` +
        "export { RuntimePolicyError };\n" +
        "export function getRuntimePolicy(...args) {\n" +
        '  if (args.length) throw new Error("policy reader must take no arguments");\n' +
        `  events.push("getRuntimePolicy"); ${result}\n}\n`
    );
  }
  fs.writeFileSync(
    path.join(dir, "probe.mjs"),
    'import { events, launches, mergedEnv } from "./trace.mjs";\n' +
      `import { isRuntimePolicyError } from ${JSON.stringify(runtimePolicyUrl)};\n` +
      'let error = null;\ntry { await import("./dev/run-standalone.mjs"); }\n' +
      "catch (e) { error = { code: e.code, reason: e.reason, policyError: isRuntimePolicyError(e) }; }\n" +
      "console.log(JSON.stringify({ events, launches, error, mergedEnv, execPath: process.execPath }));\n"
  );
  const child = spawnSync(process.execPath, [path.join(dir, "probe.mjs")], {
    cwd: dir,
    env: { PATH: path.dirname(process.execPath), HOME: dir, ...shellEnv },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  return { ...JSON.parse(child.stdout.trim()), stderr: child.stderr };
}

test("runner reads policy before env bootstrap and spawn", (t) => {
  const result = runFixture(t);
  assert.equal(result.error, null);
  assert.deepEqual(result.events, ["getRuntimePolicy", "bootstrapEnv", "spawn"]);
  assert.equal(result.launches.length, 1);
});

test("invalid policy stops before env bootstrap or spawn", (t) => {
  const result = runFixture(t, { mode: "invalid" });
  assert.equal(result.error?.code, "OMNI_RUNTIME_POLICY_DENIED");
  assert.deepEqual(result.events, ["getRuntimePolicy"]);
  assert.deepEqual(result.launches, []);
});

test("missing raw policy artifact is fatal before env bootstrap or spawn", (t) => {
  const result = runFixture(t, { mode: "missing" });
  assert.equal(result.error?.code, "ERR_MODULE_NOT_FOUND");
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.launches, []);
});

for (const shellEnv of [{}, { PATH: "", NODE_OPTIONS: "" }]) {
  test(`locked runner fixes interpreter/loader/trust env after merge (${JSON.stringify(shellEnv)})`, (t) => {
    const mergedEnv = {
      ...unsafeEnv,
      OMNIROUTE_MEMORY_MB: "16384",
      NODE_ENV: "development",
      PORT: "24123",
      API_PORT: "24124",
      DASHBOARD_PORT: "24125",
      OMNIROUTE_HOSTNAME: "127.0.0.1",
      FIXTURE_APP_SETTING: "kept",
    };
    const result = runFixture(t, { mergedEnv, shellEnv });
    assert.equal(result.error, null);
    const launch = result.launches[0];
    assert.equal(launch.command, result.execPath, "PATH never selects the locked interpreter");
    assert.deepEqual(launch.args, [...LOCKED_FLAGS, "server-ws.mjs"]);
    assert.equal(launch.options.stdio, "inherit");
    const env = launch.options.env;
    for (const key of Object.keys(unsafeEnv).filter((key) => key !== "PATH")) {
      assert.equal(Object.hasOwn(env, key), false, `${key} must not reach locked Node`);
    }
    assert.equal(env.PATH, LOCKED_PATH);
    assert.equal(env.NODE_ENV, "production");
    assert.equal(env.PORT, "24125");
    assert.equal(env.API_PORT, "24124");
    assert.equal(env.DASHBOARD_PORT, "24125");
    assert.equal(env.OMNIROUTE_PORT, "24123");
    assert.equal(env.HOSTNAME, "127.0.0.1");
    assert.equal(env.FIXTURE_APP_SETTING, "kept");
    assert.deepEqual(result.mergedEnv, mergedEnv, "the merged config was not mutated");
    assert.equal(result.stderr, "", "locked boot never parses/warns about untrusted heap options");
  });
}

test("locked runner drops loader key aliases and unreviewed loader variables", (t) => {
  const result = runFixture(t, {
    mergedEnv: {
      Path: "/fixture/writable/bin",
      node_options: "--import=/fixture/writable/inject.mjs",
      ld_preload: "/fixture/writable/inject.so",
      DYLD_FALLBACK_LIBRARY_PATH: "/fixture/writable/lib",
      OPENSSL_CONF_INCLUDE: "/fixture/writable/include",
      SSL_CERT_file: "/fixture/writable/ca.pem",
      NODE_UNREVIEWED_LOADER: "/fixture/writable/future.mjs",
    },
  });
  assert.equal(result.error, null);
  const env = result.launches[0].options.env;
  for (const key of Object.keys(result.mergedEnv))
    assert.equal(Object.hasOwn(env, key), false, key);
  assert.equal(env.PATH, LOCKED_PATH);
  assert.equal(env.NODE_ENV, "production");
});

test("locked runner requires the WS wrapper before env bootstrap or spawn", (t) => {
  const result = runFixture(t, { ws: false });
  assert.deepEqual(result.error, {
    code: "OMNI_RUNTIME_POLICY_DENIED",
    reason: "bootstrap-invalid",
    policyError: true,
  });
  assert.deepEqual(result.events, ["getRuntimePolicy"]);
  assert.deepEqual(result.launches, []);
});

test("ordinary runner preserves configured interpreter env, WS entry, and heap override", (t) => {
  const mergedEnv = {
    ...unsafeEnv,
    NODE_OPTIONS: "--trace-warnings",
    NODE_ENV: "development",
    OMNIROUTE_MEMORY_MB: "1024",
    PORT: "24123",
    OMNIROUTE_HOSTNAME: "127.0.0.1",
  };
  const result = runFixture(t, { mode: "standalone", mergedEnv });
  assert.equal(result.error, null);
  assert.deepEqual(result.events, ["getRuntimePolicy", "bootstrapEnv", "spawn"]);
  assert.deepEqual(result.launches, [
    {
      command: "node",
      args: ["server-ws.mjs"],
      options: {
        stdio: "inherit",
        env: {
          ...mergedEnv,
          NODE_OPTIONS: "--trace-warnings --max-old-space-size=1024",
          PORT: "24123",
          OMNIROUTE_PORT: "24123",
          API_PORT: "24123",
          DASHBOARD_PORT: "24123",
          HOSTNAME: "127.0.0.1",
        },
      },
    },
  ]);
});

test("ordinary runner retains an explicit NODE_OPTIONS heap and server.js fallback", (t) => {
  const result = runFixture(t, {
    mode: "standalone",
    ws: false,
    mergedEnv: { NODE_OPTIONS: "--trace-warnings --max-old-space-size=2048" },
  });
  assert.equal(result.error, null);
  assert.equal(result.launches[0].command, "node");
  assert.deepEqual(result.launches[0].args, ["server.js"]);
  assert.equal(
    result.launches[0].options.env.NODE_OPTIONS,
    "--trace-warnings --max-old-space-size=2048"
  );
});

test("ordinary runner retains the default heap and ports", (t) => {
  const result = runFixture(t, { mode: "standalone" });
  assert.equal(result.error, null);
  assert.equal(result.launches[0].options.env.NODE_OPTIONS, "--max-old-space-size=512");
  assert.equal(result.launches[0].options.env.PORT, "20128");
  assert.equal(result.launches[0].options.env.HOSTNAME, "0.0.0.0");
});

test("ordinary runner retains the heap conflict warning and explicit memory precedence", (t) => {
  const result = runFixture(t, {
    mode: "standalone",
    mergedEnv: { NODE_OPTIONS: "--max-old-space-size=2048", OMNIROUTE_MEMORY_MB: "1024" },
  });
  assert.equal(result.error, null);
  assert.equal(
    result.launches[0].options.env.NODE_OPTIONS,
    "--max-old-space-size=2048 --max-old-space-size=1024"
  );
  assert.match(result.stderr, /heap limit conflict/);
});
