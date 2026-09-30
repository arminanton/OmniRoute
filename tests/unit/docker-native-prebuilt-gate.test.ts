/** All payload loads/filesystem effects are fakes. No installed package is imported. */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  createNativeContext,
  inspectTproxyOutput,
  parseGypConfig,
  readGlibcVersion,
  requiredNativePackages,
  resolveLockedNodeGyp,
  tproxyPaths,
  validateNodeHeaders,
  verifyDockerNativeDeps,
} from "../../scripts/build/verify-docker-native-deps.mjs";

const ROOT = "/repo";
const STANDALONE = "/repo/.build/next/standalone";
const INTEGRITY = `sha512-${Buffer.alloc(64).toString("base64")}`;
const RUNTIME = {
  node: "26.10.0",
  abi: "147",
  napi: "10",
  platform: "linux",
  arch: "arm64",
  glibc: "2.41",
};
const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");

function elf(arch = "arm64") {
  const buffer = Buffer.alloc(32);
  Buffer.from([0x7f, 69, 76, 70, 2, 1]).copy(buffer);
  buffer.writeUInt16LE(arch === "arm64" ? 183 : 62, 18);
  return buffer;
}

function fixture(arch = "arm64") {
  const files = new Map<string, Buffer>();
  const cache = new Set<string>();
  const requests: string[] = [];
  const dependencyGraph = new Map<string, string[]>();
  const lock: Record<string, { version: string; integrity: string; resolved: string }> = {};
  const metadata = new Map<string, Record<string, unknown>>();
  const state = { openDatabases: 0, nativeGateResult: 1, extensionLoads: 0 };
  const runtime = { ...RUNTIME, arch };
  const put = (filename: string, value: string | Buffer) => {
    files.set(filename, typeof value === "string" ? Buffer.from(value) : Buffer.from(value));
  };
  const readBuffer = (filename: string): Buffer => {
    const value = files.get(filename);
    assert.ok(value, `fixture file absent: ${filename}`);
    return value;
  };
  const packageDir = (name: string, root = ROOT) => path.join(root, "node_modules", name);
  const addPackage = (name: string, version: string, extra: Record<string, unknown> = {}) => {
    const info = { name, version, main: "index.cjs", ...extra };
    metadata.set(name, info);
    lock[`node_modules/${name}`] = {
      version,
      integrity: INTEGRITY,
      resolved: `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${version}.tgz`,
    };
    for (const root of [ROOT, STANDALONE]) {
      put(path.join(packageDir(name, root), "package.json"), JSON.stringify(info));
      put(path.join(packageDir(name, root), String(info.main)), "module fixture");
    }
  };
  const addBinary = (name: string, relative: string) => {
    for (const root of [ROOT, STANDALONE])
      put(path.join(packageDir(name, root), relative), elf(arch));
  };
  addPackage("node-gyp", "12.4.0");
  put(path.join(packageDir("node-gyp"), "bin/node-gyp.js"), "locked tool");
  addPackage("better-sqlite3", "13.0.3");
  addBinary("better-sqlite3", `prebuilds/linux-${arch}.node`);
  addPackage("wreq-js", "3.2.0");
  const nativeVersions = [
    "3.2.0",
    "16.3.3",
    "1.16.1",
    "2.5.6",
    "4.3.3",
    "1.32.0",
    "1.11.1",
    "0.9.3",
    "1.7.0",
  ];
  requiredNativePackages(arch).forEach((name: string, index: number) => {
    addPackage(name, nativeVersions[index], {
      main: "addon.node",
      cpu: [arch],
      os: ["linux"],
      libc: ["glibc"],
    });
    addBinary(name, "addon.node");
  });
  addPackage("sharp", "0.35.4");
  addPackage(`@img/sharp-linux-${arch}`, "0.35.4", { cpu: [arch], os: ["linux"], libc: ["glibc"] });
  addBinary(`@img/sharp-linux-${arch}`, `lib/sharp-linux-${arch}-0.35.4.node`);
  addPackage(`@img/sharp-libvips-linux-${arch}`, "1.3.3", {
    cpu: [arch],
    os: ["linux"],
    libc: ["glibc"],
    exports: { "./binary": "./lib/libvips.so" },
  });
  addBinary(`@img/sharp-libvips-linux-${arch}`, "lib/libvips.so");
  addPackage("esbuild", "0.28.2", {
    "esbuild.binaryHashes": { [`@esbuild/linux-${arch}/bin/esbuild`]: digest(elf(arch)) },
  });
  addPackage(`@esbuild/linux-${arch}`, "0.28.2", { cpu: [arch], os: ["linux"] });
  addBinary(`@esbuild/linux-${arch}`, "bin/esbuild");
  addPackage("onnxruntime-node", "1.24.3");
  addBinary("onnxruntime-node", `bin/napi-v6/linux/${arch}/onnxruntime_binding.node`);
  addBinary("onnxruntime-node", `bin/napi-v6/linux/${arch}/libonnxruntime.so.1`);
  addPackage("sqlite-vec", "0.1.9");
  addPackage(`sqlite-vec-linux-${arch}`, "0.1.9");
  addBinary(`sqlite-vec-linux-${arch}`, "vec0.so");
  put(path.join(ROOT, "package-lock.json"), JSON.stringify({ packages: lock }));
  for (const filename of ["node.h", "node_api.h", "common.gypi"]) {
    put(`/usr/local/include/node/${filename}`, "installed header");
  }
  put(
    "/usr/local/include/node/node_version.h",
    "#define NODE_MAJOR_VERSION 26\n#define NODE_MINOR_VERSION 10\n" +
      "#define NODE_PATCH_VERSION 0\n#define NODE_MODULE_VERSION 147\n"
  );
  put(
    "/usr/local/include/node/config.gypi",
    "# generated\n" +
      JSON.stringify({
        variables: { target_arch: arch, node_module_version: 147 },
      })
  );

  class MemoryDatabase {
    constructor(filename: string) {
      assert.equal(filename, ":memory:");
      state.openDatabases++;
    }
    prepare(sql: string) {
      assert.ok(["SELECT 1 AS native_gate", "SELECT vec_version() AS version"].includes(sql));
      return {
        get: () =>
          sql.includes("vec_version")
            ? { version: "v0.1.9" }
            : { native_gate: state.nativeGateResult },
      };
    }
    loadExtension(filename: string) {
      assert.ok(files.has(filename));
      state.extensionLoads++;
    }
    close() {
      state.openDatabases--;
    }
  }
  const seams = (root: string) => {
    const resolve = (specifier: string): string => {
      if (specifier === "node-gyp/package.json")
        return path.join(packageDir("node-gyp", root), "package.json");
      if (specifier === "node-gyp/bin/node-gyp.js")
        return path.join(packageDir("node-gyp", root), "bin/node-gyp.js");
      const info = metadata.get(specifier);
      assert.ok(info, `unexpected resolver request: ${specifier}`);
      return path.join(packageDir(specifier, root), String(info.main));
    };
    return {
      resolve,
      load: (specifier: string): object | typeof MemoryDatabase => {
        requests.push(specifier);
        if (specifier.endsWith(".node")) {
          assert.ok(files.has(specifier));
          cache.add(specifier);
          return {
            createTransparentListener() {
              throw new Error("no socket calls");
            },
            setSocketMark() {},
            connectMarked() {},
          };
        }
        const entry = resolve(specifier);
        cache.add(entry);
        if (specifier === "better-sqlite3") return MemoryDatabase;
        if (specifier === "wreq-js")
          return {
            createTransport() {
              throw new Error("no transports");
            },
            createSession() {},
          };
        if (specifier === "sharp") return { versions: { sharp: "0.35.4" } };
        if (specifier === "onnxruntime-node") return { env: { versions: { node: "1.24.3" } } };
        throw new Error(`Unexpected wrapper import: ${specifier}`);
      },
      loadedPaths: () => [...cache],
      dependencyPaths: (entry: string) => dependencyGraph.get(entry) ?? [entry],
    };
  };
  const opts = {
    runtime,
    execPath: "/usr/local/bin/node",
    nodeRoot: "/usr/local",
    env: {} as Record<string, string>,
    exists: (filename: string) => files.has(filename),
    realpath: (filename: string) => path.resolve(filename),
    readText: (filename: string) => readBuffer(filename).toString(),
    readBuffer,
    ...seams(ROOT),
    standaloneOptions: seams(STANDALONE),
  };
  const addTproxyReceipt = () => {
    const paths = tproxyPaths(ROOT);
    put(path.join(paths.directory, "binding.gyp"), "gyp source");
    put(path.join(paths.directory, "transparent.c"), "C source");
    put(paths.output, elf(arch));
    put(
      paths.config,
      JSON.stringify({
        variables: { node_module_version: 147, target_arch: arch, nodedir: "/usr/local" },
      })
    );
    put(tproxyPaths(STANDALONE).output, elf(arch));
    const context = createNativeContext(ROOT, opts);
    const receipt = inspectTproxyOutput(
      context,
      validateNodeHeaders(context),
      resolveLockedNodeGyp(context)
    );
    put(paths.receipt, JSON.stringify(receipt));
  };
  return {
    files,
    cache,
    requests,
    metadata,
    dependencyGraph,
    state,
    opts,
    put,
    packageDir,
    addTproxyReceipt,
  };
}

test("both GNU architectures pass only through locked native payload paths", () => {
  for (const arch of ["arm64", "x64"]) {
    const f = fixture(arch);
    const result = verifyDockerNativeDeps(ROOT, f.opts);
    assert.equal(result.runtime.arch, arch);
    assert.equal(result.nodeGyp.version, "12.4.0");
    assert.ok(
      result.checked.some((entry: { path: string }) =>
        entry.path.endsWith(`prebuilds/linux-${arch}.node`)
      )
    );
    assert.equal(f.state.openDatabases, 0);
    assert.equal(f.state.extensionLoads, 1);
    for (const downloaderWrapper of ["next", "unrs-resolver", "@swc/core", "napi-postinstall"]) {
      assert.ok(
        !f.requests.includes(downloaderWrapper),
        "never invoke a recovery downloader wrapper"
      );
    }
  }
});

test("rejects missing, wrong-arch, corrupt, or unloadable SQLite prebuilts", () => {
  for (const failure of ["missing", "arch", "corrupt", "load"]) {
    const f = fixture();
    const filename = path.join(f.packageDir("better-sqlite3"), "prebuilds/linux-arm64.node");
    if (failure === "missing") f.files.delete(filename);
    if (failure === "arch") f.put(filename, elf("x64"));
    if (failure === "corrupt") f.put(filename, "not a binary");
    if (failure === "load")
      f.opts.load = () => {
        throw new Error("dlopen failed");
      };
    assert.throws(() => verifyDockerNativeDeps(ROOT, f.opts), /payload|ELF|dlopen/);
    assert.ok(!f.requests.includes("better-sqlite3"));
  }
});

test("SQLite must use the exact prebuild and close its DB even on query failure", () => {
  const f = fixture();
  f.state.nativeGateResult = 0;
  assert.throws(() => verifyDockerNativeDeps(ROOT, f.opts), /memory query failed/);
  assert.equal(f.state.openDatabases, 0);
  const alternate = fixture();
  alternate.cache.add(
    path.join(alternate.packageDir("better-sqlite3"), "build/Release/better_sqlite3.node")
  );
  assert.throws(() => verifyDockerNativeDeps(ROOT, alternate.opts), /unexpected native binding/);
});

test("package version, platform libc, lock integrity, and embedded esbuild hash are enforced", () => {
  for (const failure of ["version", "libc", "integrity", "esbuild"]) {
    const f = fixture();
    const name = "@wreq-js/binding-linux-arm64-gnu";
    if (failure === "version" || failure === "libc") {
      const info = { ...f.metadata.get(name) };
      if (failure === "version") info.version = "3.1.0";
      else info.libc = ["musl"];
      f.put(path.join(f.packageDir(name), "package.json"), JSON.stringify(info));
    }
    if (failure === "integrity") {
      const lock = JSON.parse(f.opts.readText(path.join(ROOT, "package-lock.json")));
      delete lock.packages["node_modules/better-sqlite3"].integrity;
      f.put(path.join(ROOT, "package-lock.json"), JSON.stringify(lock));
    }
    if (failure === "esbuild") {
      const changed = elf();
      changed[24] = 1;
      f.put(path.join(f.packageDir("@esbuild/linux-arm64"), "bin/esbuild"), changed);
    }
    assert.throws(() => verifyDockerNativeDeps(ROOT, f.opts), /version|libc|integrity|SHA256/);
  }
});

test("wrong runtime, musl, old glibc, and native/WASM force overrides fail closed", () => {
  for (const change of [
    { node: "24.21.0", abi: "137" },
    { platform: "darwin" },
    { arch: "arm" },
    { glibc: "" },
    { glibc: "2.28" },
  ]) {
    const f = fixture();
    Object.assign(f.opts.runtime, change);
    assert.throws(() => verifyDockerNativeDeps(ROOT, f.opts), /Node26|GNU|glibc/);
  }
  for (const name of ["NAPI_RS_FORCE_WASI", "SWC_BINARY_PATH", "ESBUILD_BINARY_PATH", "LIBC"]) {
    const f = fixture();
    f.opts.env[name] = "forced";
    assert.throws(() => verifyDockerNativeDeps(ROOT, f.opts), /override/);
  }
});

test("headers must exist next to Node and match full version, ABI, and gyp config", () => {
  for (const failure of ["missing", "patch", "abi", "config", "adjacent"]) {
    const f = fixture();
    if (failure === "missing") f.files.delete("/usr/local/include/node/node.h");
    if (failure === "patch" || failure === "abi") {
      f.put(
        "/usr/local/include/node/node_version.h",
        f.opts
          .readText("/usr/local/include/node/node_version.h")
          .replace(
            failure === "patch" ? "PATCH_VERSION 0" : "MODULE_VERSION 147",
            failure === "patch" ? "PATCH_VERSION 1" : "MODULE_VERSION 137"
          )
      );
    }
    if (failure === "config")
      f.put(
        "/usr/local/include/node/config.gypi",
        JSON.stringify({ variables: { node_module_version: 147, target_arch: "x64" } })
      );
    if (failure === "adjacent") f.opts.execPath = "/other/bin/node";
    assert.throws(() => verifyDockerNativeDeps(ROOT, f.opts), /header|Header|config.gypi/);
    assert.equal(f.requests.length, 0);
  }
});

test("missing local node-gyp cannot resolve from an ancestor or global prefix", () => {
  const f = fixture();
  f.opts.resolve = () => "/usr/local/lib/node_modules/node-gyp/package.json";
  assert.throws(() => verifyDockerNativeDeps(ROOT, f.opts), /node-gyp.*wrong path/);
  assert.equal(f.requests.length, 0);
});

test("missing required build addon fails rather than calling Next/unrs WASM recovery", () => {
  const f = fixture();
  f.files.delete(path.join(f.packageDir("@unrs/resolver-binding-linux-arm64-gnu"), "addon.node"));
  assert.throws(() => verifyDockerNativeDeps(ROOT, f.opts), /payload missing/);
  assert.ok(!f.requests.includes("unrs-resolver"));
  assert.ok(!f.requests.includes("napi-postinstall"));
});

test("post-build acceptance validates receipt, loaded TPROXY, and isolated standalone payloads", () => {
  const f = fixture();
  f.addTproxyReceipt();
  const result = verifyDockerNativeDeps(ROOT, {
    ...f.opts,
    requireTproxy: true,
    standaloneRoot: STANDALONE,
  });
  assert.equal(result.tproxy?.node, "26.10.0");
  assert.ok(
    result.standalone?.every((entry: { path: string }) => entry.path.startsWith(`${STANDALONE}/`))
  );
  assert.equal(f.state.openDatabases, 0);
});

test("missing/stale TPROXY receipts and changed standalone native bytes are fatal", () => {
  for (const failure of ["receipt", "stale", "binary", "source"]) {
    const f = fixture();
    f.addTproxyReceipt();
    if (failure === "receipt") f.files.delete(tproxyPaths(ROOT).receipt);
    if (failure === "stale") f.put(tproxyPaths(ROOT).receipt, "{}");
    if (failure === "binary") {
      const bytes = elf();
      bytes[25] = 1;
      f.put(tproxyPaths(STANDALONE).output, bytes);
    }
    if (failure === "source")
      f.put(path.join(tproxyPaths(ROOT).directory, "transparent.c"), "changed source");
    assert.throws(
      () =>
        verifyDockerNativeDeps(ROOT, {
          ...f.opts,
          requireTproxy: true,
          standaloneRoot: STANDALONE,
        }),
      /absent|receipt mismatch|bytes differ/
    );
  }
});

test("standalone cannot reuse builder package resolution or transitive dependency graph", () => {
  for (const transitive of [false, true]) {
    const f = fixture();
    f.addTproxyReceipt();
    if (transitive) {
      const entry = path.join(f.packageDir("wreq-js", STANDALONE), "index.cjs");
      f.dependencyGraph.set(entry, [entry, path.join(ROOT, "node_modules/borrowed/index.js")]);
    } else {
      f.opts.standaloneOptions.resolve = f.opts.resolve;
    }
    assert.throws(
      () =>
        verifyDockerNativeDeps(ROOT, {
          ...f.opts,
          requireTproxy: true,
          standaloneRoot: STANDALONE,
        }),
      /escaped/
    );
  }
});

test("already loaded builder shared libraries cannot hide missing standalone .so files", () => {
  for (const [name, relative] of [
    ["@img/sharp-libvips-linux-arm64", "lib/libvips.so"],
    ["onnxruntime-node", "bin/napi-v6/linux/arm64/libonnxruntime.so.1"],
  ]) {
    const f = fixture();
    f.addTproxyReceipt();
    f.files.delete(path.join(f.packageDir(name, STANDALONE), relative));
    assert.throws(
      () =>
        verifyDockerNativeDeps(ROOT, {
          ...f.opts,
          requireTproxy: true,
          standaloneRoot: STANDALONE,
        }),
      /payload missing/
    );
  }
});

test("standalone runtime binaries must equal the validated project copies", () => {
  const f = fixture();
  f.addTproxyReceipt();
  const binary = path.join(
    f.packageDir("@img/sharp-linux-arm64", STANDALONE),
    "lib/sharp-linux-arm64-0.35.4.node"
  );
  const changed = elf();
  changed[26] = 1;
  f.put(binary, changed);
  assert.throws(
    () =>
      verifyDockerNativeDeps(ROOT, {
        ...f.opts,
        requireTproxy: true,
        standaloneRoot: STANDALONE,
      }),
    /Standalone native bytes differ: sharp/
  );
});

test("Node/gyp JSON and Python dictionary data parse without evaluation", () => {
  const python = `# Node-style Python dictionary representation
  {
    'target_defaults': {'cflags': ['-O2',],},
    'variables': {
      'node_module_version': 147,
      'target_arch': 'arm64',
      'nodedir': '/usr/local',
      'tag': 'literal#not-comment',
      'enabled': False,
      'unused': None,
    },
  }`;
  const parsed = parseGypConfig(python);
  assert.equal(parsed.variables.node_module_version, 147);
  assert.equal(parsed.variables.target_arch, "arm64");
  assert.equal(parsed.variables.tag, "literal#not-comment");
  assert.equal(parsed.variables.enabled, false);
  assert.equal(parsed.variables.unused, null);
  assert.equal(Object.getPrototypeOf(parsed), null);
  const f = fixture();
  f.put("/usr/local/include/node/config.gypi", python);
  assert.equal(verifyDockerNativeDeps(ROOT, f.opts).headers.abi, "147");
});

test("gyp literal parser rejects code, duplicate fields, trailing data, and excessive depth", () => {
  for (const source of [
    "{'variables': __import__('os').system('false')}",
    "{'variables': {}, 'variables': {}}",
    "{'variables': {}}; process.exit(0)",
    "{'variables': {'target_arch': 'unterminated}}",
    "{".repeat(70),
    "{'variables': " + "[".repeat(70) + "0" + "]".repeat(70) + "}",
  ])
    assert.throws(() => parseGypConfig(source), /config.gypi/);
});

test("native identity excludes environment collection and restores report policy on every path", () => {
  for (const initial of [false, true]) {
    const report = {
      excludeEnv: initial,
      getReport() {
        assert.equal(this.excludeEnv, true);
        return { header: { glibcVersionRuntime: "2.41" } };
      },
    };
    assert.equal(readGlibcVersion(report), "2.41");
    assert.equal(report.excludeEnv, initial);
    report.getReport = () => {
      throw new Error("report failed");
    };
    assert.throws(() => readGlibcVersion(report), /report failed/);
    assert.equal(report.excludeEnv, initial);
  }
});
