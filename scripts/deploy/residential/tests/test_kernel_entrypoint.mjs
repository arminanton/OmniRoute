// Offline VM composition only: no namespace, policy approval, app or helper starts.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {createHash} from "node:crypto";
import {EventEmitter} from "node:events";
import {fileURLToPath} from "node:url";
import {mountAt, validatePublicMetadata} from "../boundary-check.mjs";

const ENTRY = new URL("../workload-entrypoint.mjs", import.meta.url);
const CORE = new URL("../../../build/runtime-policy.mjs", import.meta.url);
const coreBytes = fs.readFileSync(CORE);
const source = fs.readFileSync(ENTRY, "utf8");
const PIN = "65ef803f048b16df2be39b0057ecd2e757590d23e2ef1cf87bf24b4bb849bd20";
class FixtureExit extends Error { constructor(code) { super("fixture exit"); this.code = code; } }

async function compose(role, options = {}) {
  const calls = [], spawns = [], logs = [];
  const image = options.imageBytes ?? coreBytes;
  const metadata = {dev: 1, ino: 2, size: image.length, nlink: 1, mtimeMs: 0, ctimeMs: 0,
    isFile: () => true, isSymbolicLink: () => false, isDirectory: () => false};
  const fakeFs = {
    constants: fs.constants,
    lstatSync(path) {
      if (path === "/run/omni-runtime-policy") {
        if (options.markerExists) return metadata;
        const error = new Error("fixture missing");
        error.code = options.markerError || "ENOENT";
        throw error;
      }
      if (["/app", "/app/build"].includes(path)) return {isDirectory: () => !options.symlinkParent, isSymbolicLink: () => !!options.symlinkParent};
      if (path !== "/app/build/runtime-policy.mjs" || options.missingImageCore) throw new Error("fixture unexpected/missing path");
      return metadata;
    },
    openSync(path) { assert.equal(path, "/app/build/runtime-policy.mjs"); calls.push("open-image"); return 42; },
    closeSync(fd) { assert.equal(fd, 42); calls.push("close-image"); },
    fstatSync(fd) { assert.equal(fd, 42); return metadata; },
    readFileSync(path) {
      if (path === "/proc/self/mountinfo") return options.mountinfo ?? "102 100 0:3 /runtime-policy /run/omni-runtime-policy ro,nosuid - tmpfs tmpfs rw";
      if (path === 42) return image;
      if (path instanceof URL && path.href === CORE.href) return coreBytes;
      throw new Error("fixture forbids real path reads");
    },
    mkdirSync() { calls.push("mkdir"); },
    readdirSync(path) { assert.equal(path, "/ms-playwright"); return ["chromium-999"]; },
    existsSync(path) { return path === "/ms-playwright/chromium-999/chrome-linux64/chrome"; },
    statSync() { return {isFile: () => true}; },
  };
  const fakeProcess = {argv: ["node", "fixture", role, "kernel-residential-v1"], env: {...options.env}, execPath: "/fixture/node",
    on() {}, chdir() { calls.push("chdir"); }, exit(code) { throw new FixtureExit(code); }};
  const fakeSpawn = (binary, args, settings) => {
    calls.push("spawn"); assert.equal(settings.shell, false);
    const child = new EventEmitter(); child.kill = () => {};
    if (binary === "/usr/bin/Xvfb") {
      child.stdio = [null, null, null, new EventEmitter()];
      queueMicrotask(() => child.stdio[3].emit("data", "42\n"));
    }
    spawns.push({binary, args, child}); return child;
  };
  const context = vm.createContext({URL, setTimeout, clearTimeout, process: fakeProcess, console: {
    error: (...values) => logs.push(values.join(" ")), log: (...values) => logs.push(values.join(" "))}});
  const dependencies = {
    "node:fs": {default: fakeFs}, "node:child_process": {spawn: fakeSpawn}, "node:url": {fileURLToPath},
    "./runtime-policy.mjs": {
      requireLockedBootstrap() { calls.push("policy"); if (options.denyBootstrap) throw new Error("sensitive fixture path"); return {mode: "locked"}; },
      assertLocalHelper(use) { calls.push("helper"); options.helperCalls?.push(JSON.parse(JSON.stringify(use))); if (options.denyHelper) throw new Error("denied helper"); },
    },
    "./boundary-check.mjs": {
      mountAt(text, path) { calls.push("policy-mount"); return mountAt(text, path); },
      inspectBoundary() { calls.push("boundary"); if (options.denyBoundary) throw new Error("denied boundary"); return {fixture: true}; },
    },
  };
  const entry = new vm.SourceTextModule(source, {context, identifier: ENTRY.href,
    initializeImportMeta(meta) { meta.url = ENTRY.href; }});
  await entry.link((specifier) => {
    const exports = dependencies[specifier]; assert.ok(exports, "unapproved module dependency");
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, {context});
  });
  let error;
  try { await entry.evaluate(); } catch (caught) { error = caught; }
  return {calls, spawns, logs, error};
}

for (const role of ["app", "browser", "codex", "browser-login"]) {
  test(`${role}: kernel boundary checked before real-role dispatch without adapter grants`, async () => {
    const result = await compose(role);
    assert.equal(result.error, undefined);
    assert.equal(result.spawns.length, role === "browser" ? 2 : 1);
    assert.ok(result.calls.indexOf("boundary") < result.calls.indexOf("spawn"));
    assert.ok(!result.calls.includes("policy"));
    assert.ok(!result.calls.includes("open-image"));
  });
  test(`${role}: image marker, I/O error, or invalid boundary refuses all spawns`, async () => {
    for (const options of [{markerExists: true}, {markerError: "EACCES"}, {denyBoundary: true}]) {
      const result = await compose(role, options);
      assert.equal(result.error?.code, 1);
      assert.equal(result.spawns.length, 0);
    }
  });
}

test("enabled app pool starts a ready private display before application", async () => {
  const result = await compose("app", {env: {OMNIROUTE_BROWSER_POOL: "true"}});
  assert.equal(result.error, undefined);
  assert.equal(result.spawns.length, 2);
  assert.equal(result.spawns[0].binary, "/usr/bin/Xvfb");
  assert.equal(result.spawns[0].args.slice(-2).join(" "), "-nolisten tcp");
  assert.equal(result.spawns[1].args[0], "/app/dev/run-standalone.mjs");
});
