/** The helper uses only injected effects here: no compiler, addon, or installer runs. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildTproxyNative } from "../../scripts/build/build-tproxy-native.mjs";

const ROOT = "/repo";
const NATIVE = path.join(ROOT, "src/mitm/tproxy/native");
const GYP = path.join(NATIVE, "binding.gyp");
const OUT = path.join(NATIVE, "build/Release/transparent.node");
const RECEIPT = path.join(NATIVE, "build/Release/transparent.build.json");
const CONFIG = path.join(NATIVE, "build/config.gypi");
const TOOL = path.join(ROOT, "node_modules/node-gyp/bin/node-gyp.js");
const MANIFEST = path.join(ROOT, "node_modules/node-gyp/package.json");
const INTEGRITY = `sha512-${Buffer.alloc(64).toString("base64")}`;

function fixture() {
  const files = new Map<string, Buffer>();
  const loaded = new Set<string>();
  const calls: { cmd: string; args: string[]; cwd: string; env: Record<string, string> }[] = [];
  const runtime = {
    node: "26.10.0",
    abi: "147",
    napi: "10",
    arch: "arm64",
    platform: "linux",
    glibc: "2.41",
  };
  const put = (filename: string, value: string | Buffer) => files.set(filename, Buffer.from(value));
  const readBuffer = (filename: string): Buffer => {
    const value = files.get(filename);
    assert.ok(value, `fixture file absent: ${filename}`);
    return value;
  };
  const headers = (prefix = "/usr/local") => {
    const dir = path.join(prefix, "include/node");
    for (const name of ["node.h", "node_api.h", "common.gypi"]) put(path.join(dir, name), "header");
    const [major, minor, patch] = runtime.node.split(".");
    put(
      path.join(dir, "node_version.h"),
      `#define NODE_MAJOR_VERSION ${major}\n#define NODE_MINOR_VERSION ${minor}\n` +
        `#define NODE_PATCH_VERSION ${patch}\n#define NODE_MODULE_VERSION ${runtime.abi}\n`
    );
    put(
      path.join(dir, "config.gypi"),
      "# generated\n" +
        JSON.stringify({
          variables: { node_module_version: Number(runtime.abi), target_arch: runtime.arch },
        })
    );
  };
  put(GYP, "binding source");
  put(path.join(NATIVE, "transparent.c"), "C source");
  put(TOOL, "locked node-gyp entry");
  put(MANIFEST, JSON.stringify({ name: "node-gyp", version: "12.4.0" }));
  put(
    path.join(ROOT, "package-lock.json"),
    JSON.stringify({
      packages: {
        "node_modules/node-gyp": {
          version: "12.4.0",
          integrity: INTEGRITY,
          resolved: "https://registry.npmjs.org/node-gyp/-/node-gyp-12.4.0.tgz",
        },
      },
    })
  );
  headers();
  const opts = {
    runtime,
    platform: "linux",
    strict: false,
    allowHeaderDownload: false,
    execPath: "/usr/local/bin/node",
    nodeRoot: "/usr/local",
    env: {} as Record<string, string>,
    exists: (filename: string) => files.has(filename),
    realpath: (filename: string) => path.resolve(filename),
    readText: (filename: string) => readBuffer(filename).toString(),
    readBuffer,
    resolve: (specifier: string) => {
      if (specifier === "node-gyp/package.json") return MANIFEST;
      if (specifier === "node-gyp/bin/node-gyp.js") return TOOL;
      throw new Error(`Unexpected resolver request: ${specifier}`);
    },
    load: (filename: string) => {
      loaded.add(filename);
      return { createTransparentListener() {}, setSocketMark() {}, connectMarked() {} };
    },
    loadedPaths: () => [...loaded],
    remove: (filename: string) => {
      files.delete(filename);
    },
    writeText: (filename: string, value: string) => {
      put(filename, value);
    },
    run: (cmd: string, args: string[], cwd: string, env: Record<string, string>) => {
      calls.push({ cmd, args, cwd, env });
      const prefix =
        args.find((arg) => arg.startsWith("--nodedir="))?.slice(10) ?? "/cache/node-gyp/26.10.0";
      headers(prefix); // simulated explicit host download, never a real network request
      const elf = Buffer.alloc(32);
      Buffer.from([0x7f, 69, 76, 70, 2, 1]).copy(elf);
      elf.writeUInt16LE(183, 18);
      put(OUT, elf);
      put(
        CONFIG,
        JSON.stringify({
          variables: {
            target_arch: runtime.arch,
            node_module_version: runtime.abi,
            nodedir: prefix,
          },
        })
      );
    },
  };
  return { files, calls, opts, put, headers };
}

test("non-Linux and source-absent hosts remain best-effort without running anything", () => {
  const f = fixture();
  f.opts.platform = "darwin";
  assert.match(buildTproxyNative(ROOT, f.opts).reason ?? "", /non-linux/i);
  f.opts.platform = "linux";
  f.files.delete(GYP);
  assert.match(buildTproxyNative(ROOT, f.opts).reason ?? "", /sources absent/i);
  assert.equal(f.calls.length, 0);
});

test("uses process.execPath, exact locked local node-gyp, and matching installed headers", () => {
  const f = fixture();
  f.opts.strict = true;
  f.opts.env.npm_config_target = "24.0.0";
  f.opts.env.npm_config_force_process_config = "true";
  assert.deepEqual(buildTproxyNative(ROOT, f.opts), { built: true });
  assert.deepEqual(f.calls, [
    {
      cmd: "/usr/local/bin/node",
      args: [TOOL, "rebuild", "--target=26.10.0", "--arch=arm64", "--nodedir=/usr/local"],
      cwd: NATIVE,
      env: {},
    },
  ]);
  const receipt = JSON.parse(f.files.get(RECEIPT)!.toString());
  assert.equal(receipt.nodeGypVersion, "12.4.0");
  assert.equal(receipt.node, "26.10.0");
  assert.equal(receipt.abi, "147");
  assert.match(receipt.binarySha256, /^[a-f0-9]{64}$/);
  assert.ok(f.opts.loadedPaths().includes(OUT));
});

test("missing local tool or a lock-version mismatch never falls back to npx/global tools", () => {
  for (const missing of [true, false]) {
    const f = fixture();
    if (missing)
      f.opts.resolve = () => {
        throw new Error("local node-gyp absent");
      };
    else f.put(MANIFEST, JSON.stringify({ name: "node-gyp", version: "12.3.0" }));
    assert.equal(buildTproxyNative(ROOT, f.opts).built, false);
    f.opts.strict = true;
    assert.throws(() => buildTproxyNative(ROOT, f.opts), /node-gyp|root lock/);
    assert.equal(f.calls.length, 0);
  }
});

test("Docker rejects absent headers and every semver/ABI/config mismatch before building", () => {
  const mutations: ((f: ReturnType<typeof fixture>) => void)[] = [
    (f) => {
      f.files.delete("/usr/local/include/node/node.h");
    },
    (f) => {
      f.put(
        "/usr/local/include/node/node_version.h",
        f.opts
          .readText("/usr/local/include/node/node_version.h")
          .replace("VERSION 26", "VERSION 24")
      );
    },
    (f) => {
      f.put(
        "/usr/local/include/node/node_version.h",
        f.opts.readText("/usr/local/include/node/node_version.h").replace("VERSION 10", "VERSION 9")
      );
    },
    (f) => {
      f.put(
        "/usr/local/include/node/node_version.h",
        f.opts.readText("/usr/local/include/node/node_version.h").replace("VERSION 0", "VERSION 1")
      );
    },
    (f) => {
      f.put(
        "/usr/local/include/node/node_version.h",
        f.opts
          .readText("/usr/local/include/node/node_version.h")
          .replace("VERSION 147", "VERSION 137")
      );
    },
    (f) => {
      f.put(
        "/usr/local/include/node/config.gypi",
        JSON.stringify({ variables: { node_module_version: 137, target_arch: "arm64" } })
      );
    },
    (f) => {
      f.put(
        "/usr/local/include/node/config.gypi",
        JSON.stringify({ variables: { node_module_version: 147, target_arch: "x64" } })
      );
    },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f);
    f.opts.env.OMNIROUTE_DOCKER_NATIVE_BUILD = "1";
    assert.throws(() => buildTproxyNative(ROOT, f.opts), /headers|header|config.gypi/i);
    assert.equal(f.calls.length, 0);
  }
});

test("host header download is explicit, local-tool-only, and forbidden by Docker mode", () => {
  const f = fixture();
  for (const filename of f.files.keys()) {
    if (filename.startsWith("/usr/local/include/node/")) f.files.delete(filename);
  }
  assert.equal(buildTproxyNative(ROOT, f.opts).built, false);
  assert.equal(f.calls.length, 0);
  f.opts.allowHeaderDownload = true;
  assert.deepEqual(buildTproxyNative(ROOT, f.opts), { built: true });
  assert.deepEqual(f.calls[0].args, [TOOL, "rebuild", "--target=26.10.0", "--arch=arm64"]);
  assert.equal(JSON.parse(f.files.get(RECEIPT)!.toString()).nodeRoot, "/cache/node-gyp/26.10.0");
  f.opts.strict = true;
  assert.throws(() => buildTproxyNative(ROOT, f.opts), /forbids.*fallback/);
});

test("the environment host opt-in cannot make mismatched installed headers acceptable", () => {
  const f = fixture();
  f.opts.env.OMNIROUTE_TPROXY_ALLOW_HEADER_DOWNLOAD = "1";
  f.put(
    "/usr/local/include/node/node_version.h",
    f.opts.readText("/usr/local/include/node/node_version.h").replace("VERSION 147", "VERSION 137")
  );
  assert.equal(buildTproxyNative(ROOT, f.opts).built, false);
  assert.equal(f.calls.length, 0);
});

test("build failure clears stale receipt and remains optional only on hosts", () => {
  const f = fixture();
  f.put(RECEIPT, "stale success");
  f.opts.run = () => {
    throw new Error("make failed");
  };
  assert.match(buildTproxyNative(ROOT, f.opts).reason ?? "", /make failed/);
  assert.equal(f.files.has(RECEIPT), false);
  f.opts.strict = true;
  assert.throws(() => buildTproxyNative(ROOT, f.opts), /make failed/);
});

test("missing output, corrupt output, load failure, or wrong gyp metadata are Docker errors", () => {
  for (const mode of ["missing", "corrupt", "load", "config"]) {
    const f = fixture();
    const run = f.opts.run;
    f.opts.strict = true;
    f.opts.run = (...args) => {
      run(...args);
      if (mode === "missing") f.files.delete(OUT);
      if (mode === "corrupt") f.put(OUT, "not ELF");
      if (mode === "config")
        f.put(
          CONFIG,
          JSON.stringify({
            variables: { target_arch: "x64", node_module_version: "147", nodedir: "/usr/local" },
          })
        );
    };
    if (mode === "load")
      f.opts.load = () => {
        throw new Error("invalid addon load");
      };
    assert.throws(() => buildTproxyNative(ROOT, f.opts), /transparent.node|ELF|addon|config.gypi/);
    assert.equal(f.files.has(RECEIPT), false);
  }
});

test("legacy host environment opt-in uses the locked tool without npx", () => {
  const f = fixture();
  for (const filename of f.files.keys()) {
    if (filename.startsWith("/usr/local/include/node/")) f.files.delete(filename);
  }
  f.opts.env.OMNIROUTE_TPROXY_ALLOW_HEADER_DOWNLOAD = "1";
  assert.deepEqual(buildTproxyNative(ROOT, f.opts), { built: true });
  assert.equal(f.calls[0].cmd, "/usr/local/bin/node");
  assert.equal(f.calls[0].args[0], TOOL);
  assert.ok(!f.calls[0].args.some((arg) => arg.startsWith("--nodedir=")));
});

test("explicit host fallback accepts universal x64 header config only with arm64 build proof", () => {
  const f = fixture();
  for (const filename of f.files.keys()) {
    if (filename.startsWith("/usr/local/include/node/")) f.files.delete(filename);
  }
  f.opts.allowHeaderDownload = true;
  const run = f.opts.run;
  f.opts.run = (...args) => {
    run(...args);
    f.put(
      "/cache/node-gyp/26.10.0/include/node/config.gypi",
      "{'variables': {'node_module_version': 147, 'target_arch': 'x64',},}"
    );
    f.put(
      CONFIG,
      "{'variables': {'node_module_version': 147, " +
        "'target_arch': 'arm64', 'nodedir': '/cache/node-gyp/26.10.0',},}"
    );
  };
  assert.deepEqual(buildTproxyNative(ROOT, f.opts), { built: true });
  assert.equal(JSON.parse(f.files.get(RECEIPT)!.toString()).arch, "arm64");
});

test("published helper imports alone with Node builtins and no Docker-only neighbor", async () => {
  const source = readFileSync(
    new URL("../../scripts/build/build-tproxy-native.mjs", import.meta.url),
    "utf8"
  );
  const imports = [...source.matchAll(/^import\s+[\s\S]*?\sfrom\s+["']([^"']+)["']/gm)];
  assert.equal(imports.length, [...source.matchAll(/^import\s/gm)].length);
  assert.ok(imports.length > 0);
  assert.ok(imports.every((entry) => entry[1].startsWith("node:")));
  const directory = mkdtempSync(path.join(tmpdir(), "omniroute-tproxy-published-"));
  try {
    const filename = path.join(directory, "build-tproxy-native.mjs");
    writeFileSync(filename, source);
    assert.equal(existsSync(path.join(directory, "verify-docker-native-deps.mjs")), false);
    assert.equal(existsSync(path.join(directory, "package-lock.json")), false);
    // Import only: no build function, package loader, compiler, or native API runs.
    const isolated = await import(pathToFileURL(filename).href);
    assert.equal(typeof isolated.buildTproxyNative, "function");
    assert.equal(typeof isolated.resolveLockedNodeGyp, "function");
    assert.equal(typeof isolated.inspectTproxyOutput, "function");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a published host without the root lock stays best-effort and never fetches a tool", () => {
  const f = fixture();
  f.files.delete(path.join(ROOT, "package-lock.json"));
  f.opts.allowHeaderDownload = true;
  const result = buildTproxyNative(ROOT, f.opts);
  assert.equal(result.built, false);
  assert.match(result.reason ?? "", /package-lock.json/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.files.has(RECEIPT), false);
  f.opts.strict = true;
  assert.throws(() => buildTproxyNative(ROOT, f.opts), /package-lock.json/);
  assert.equal(f.calls.length, 0);
});
