/**
 * Build the Linux TPROXY addon with the exact lock-installed node-gyp.
 * Hosts remain best-effort. Docker requires matching installed Node headers and
 * a loadable addon; its separate verifier checks the receipt after assembly.
 * No npx, npm install, global-tool fallback, or implicit header download occurs.
 *
 * This file is published on its own, so all common helpers stay self-contained
 * and import only Node builtins. Never import a Docker-only helper from here.
 * A published npm install may omit the root package-lock.json and local tool.
 * Such a host build remains unavailable (built:false); the explicit host header
 * opt-in never authorizes fetching a tool or reconstructing the missing lock.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export function requireCondition(condition, message, code = "NATIVE_GATE_FAILED") {
  if (!condition) throw Object.assign(new Error(message), { code });
}

/** Read only the needed report field without collecting environment variables. */
export function readGlibcVersion(report = process.report) {
  const previous = report.excludeEnv;
  try {
    report.excludeEnv = true;
    return report.getReport().header.glibcVersionRuntime;
  } finally {
    report.excludeEnv = previous;
  }
}

/**
 * Node headers can use JSON or Python dict literals. Parse data only: strings,
 * numbers, booleans, null/None, lists, and dictionaries. No names, calls, code,
 * substitution, or prototype-bearing objects are accepted. Limits bound input.
 */
export function parseGypConfig(source) {
  requireCondition(
    typeof source === "string" && source.length <= 4 * 1024 * 1024,
    "Invalid/oversized config.gypi"
  );
  let offset = 0;
  const fail = () => {
    throw new Error(`Invalid config.gypi literal at byte ${offset}`);
  };
  const skip = () => {
    while (offset < source.length) {
      if (/\s/.test(source[offset])) offset++;
      else if (source[offset] === "#") {
        while (offset < source.length && source[offset] !== "\n") offset++;
      } else break;
    }
  };
  const string = () => {
    const quote = source[offset++];
    if (quote !== "'" && quote !== '"') fail();
    let value = "";
    while (offset < source.length) {
      const char = source[offset++];
      if (char === quote) return value;
      if (char === "\n" || char === "\r") fail();
      if (char !== "\\") {
        value += char;
        continue;
      }
      const escape = source[offset++];
      const escapes = {
        "\\": "\\",
        "'": "'",
        '"': '"',
        n: "\n",
        r: "\r",
        t: "\t",
        b: "\b",
        f: "\f",
        v: "\v",
        a: "\x07",
      };
      if (Object.hasOwn(escapes, escape)) value += escapes[escape];
      else if (escape === "u" || escape === "x") {
        const length = escape === "u" ? 4 : 2;
        const hex = source.slice(offset, offset + length);
        if (hex.length !== length || !/^[a-f0-9]+$/i.test(hex)) fail();
        value += String.fromCharCode(Number.parseInt(hex, 16));
        offset += length;
      } else if (escape !== "\n") fail();
    }
    return fail();
  };
  const value = (depth = 0) => {
    if (depth > 64) fail();
    skip();
    const char = source[offset];
    if (char === "'" || char === '"') {
      let result = string();
      skip();
      // Python permits adjacent string literals, including wrapped long flags.
      while (source[offset] === "'" || source[offset] === '"') {
        result += string();
        skip();
      }
      return result;
    }
    if (char === "{" || char === "[") {
      const dictionary = char === "{";
      const end = dictionary ? "}" : "]";
      const result = dictionary ? Object.create(null) : [];
      offset++;
      skip();
      while (source[offset] !== end) {
        if (offset >= source.length) fail();
        if (dictionary) {
          const key = string();
          skip();
          if (source[offset++] !== ":" || Object.hasOwn(result, key)) fail();
          result[key] = value(depth + 1);
        } else result.push(value(depth + 1));
        skip();
        if (source[offset] === end) break;
        if (source[offset++] !== ",") fail();
        skip();
      }
      offset++;
      return result;
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(offset));
    if (number) {
      offset += number[0].length;
      return Number(number[0]);
    }
    const literal = /^(true|false|null|True|False|None)\b/.exec(source.slice(offset));
    if (literal) {
      offset += literal[0].length;
      if (["null", "None"].includes(literal[0])) return null;
      return ["true", "True"].includes(literal[0]);
    }
    return fail();
  };
  const parsed = value();
  skip();
  requireCondition(
    offset === source.length && parsed && !Array.isArray(parsed) && typeof parsed === "object",
    "Invalid config.gypi root/trailing data"
  );
  return parsed;
}

export function createNativeContext(projectRoot, opts = {}) {
  const root = path.resolve(projectRoot);
  const localRequire = createRequire(path.join(root, "package.json"));
  const execPath = opts.execPath ?? process.execPath;
  return {
    root,
    lockRoot: opts.lockRoot ?? root,
    execPath,
    nodeRoot: opts.nodeRoot ?? path.dirname(path.dirname(execPath)),
    runtime: opts.runtime ?? {
      node: process.versions.node,
      abi: process.versions.modules,
      napi: process.versions.napi,
      arch: process.arch,
      platform: process.platform,
      glibc: readGlibcVersion(opts.report ?? process.report),
    },
    env: opts.env ?? process.env,
    exists: opts.exists ?? existsSync,
    readText: opts.readText ?? ((filename) => readFileSync(filename, "utf8")),
    readBuffer: opts.readBuffer ?? readFileSync,
    realpath: opts.realpath ?? realpathSync,
    resolve: opts.resolve ?? ((specifier) => localRequire.resolve(specifier)),
    load: opts.load ?? ((specifier) => localRequire(specifier)),
    loadedPaths: opts.loadedPaths ?? (() => Object.keys(localRequire.cache)),
    dependencyPaths:
      opts.dependencyPaths ??
      ((entry) => {
        const visited = new Set();
        const walk = (module) => {
          if (!module || visited.has(module.filename)) return;
          visited.add(module.filename);
          for (const child of module.children ?? []) walk(child);
        };
        walk(localRequire.cache[entry]);
        return [...visited];
      }),
  };
}

export function readJson(context, filename) {
  return JSON.parse(context.readText(filename));
}

function readGypi(context, filename) {
  return parseGypConfig(context.readText(filename));
}

export function sha256(context, filename) {
  return createHash("sha256").update(context.readBuffer(filename)).digest("hex");
}

export function samePath(context, actual, expected, label) {
  requireCondition(context.realpath(actual) === context.realpath(expected), `${label}: wrong path`);
}

export function contained(context, filename, directory) {
  const relative = path.relative(context.realpath(directory), context.realpath(filename));
  requireCondition(
    relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    `Resolved payload escaped ${directory}: ${filename}`
  );
}

export function lockedPackage(context, name, requiredVersion) {
  const lock = (context.lock ??= readJson(
    context,
    path.join(context.lockRoot, "package-lock.json")
  ));
  const entry = lock.packages?.[`node_modules/${name}`];
  requireCondition(entry && !entry.link, `Missing locked package: ${name}`);
  requireCondition(
    /^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity ?? "") &&
      entry.resolved?.startsWith("https://registry.npmjs.org/"),
    `Missing registry integrity for ${name}`
  );
  const directory = path.join(context.root, "node_modules", name);
  const metadata = readJson(context, path.join(directory, "package.json"));
  requireCondition(
    metadata.name === name && metadata.version === entry.version,
    `${name}: installed version does not match root lock (${entry.version})`
  );
  if (requiredVersion) {
    requireCondition(entry.version === requiredVersion, `${name}: expected ${requiredVersion}`);
  }
  return { directory, metadata, version: entry.version };
}

/** Resolve the local tool only. Never use npx or an ancestor/global installation. */
export function resolveLockedNodeGyp(context) {
  const pkg = lockedPackage(context, "node-gyp", "12.4.0");
  const manifest = context.resolve("node-gyp/package.json");
  const entry = context.resolve("node-gyp/bin/node-gyp.js");
  samePath(context, manifest, path.join(pkg.directory, "package.json"), "node-gyp manifest");
  samePath(context, entry, path.join(pkg.directory, "bin", "node-gyp.js"), "node-gyp entry");
  requireCondition(context.exists(entry), "Local node-gyp entry is absent");
  return { entry, version: pkg.version };
}

/** Headers must match patch version, module ABI, and architecture, not only major. */
export function validateNodeHeaders(
  context,
  { nodeRoot = context.nodeRoot, adjacent = true } = {}
) {
  const root = path.resolve(nodeRoot);
  const directory = path.join(root, "include", "node");
  const required = ["node.h", "node_api.h", "node_version.h", "common.gypi", "config.gypi"];
  for (const filename of required) {
    requireCondition(
      context.exists(path.join(directory, filename)),
      `Node headers missing: ${path.join(directory, filename)}`,
      "NODE_HEADERS_MISSING"
    );
  }
  if (adjacent) {
    samePath(
      context,
      root,
      path.dirname(path.dirname(context.execPath)),
      "Headers must be adjacent to the running Node installation"
    );
  }
  const source = context.readText(path.join(directory, "node_version.h"));
  const define = (name) => {
    const matches = [
      ...source.matchAll(new RegExp(`^\\s*#\\s*define\\s+${name}\\s+(\\d+)\\b`, "gm")),
    ];
    requireCondition(matches.length === 1, `Missing/ambiguous numeric header define ${name}`);
    return matches[0][1];
  };
  const node = ["MAJOR", "MINOR", "PATCH"].map((part) => define(`NODE_${part}_VERSION`)).join(".");
  const abi = define("NODE_MODULE_VERSION");
  const config = readGypi(context, path.join(directory, "config.gypi"));
  requireCondition(node === context.runtime.node, `Node header version mismatch: ${node}`);
  requireCondition(abi === String(context.runtime.abi), `Node header ABI mismatch: ${abi}`);
  requireCondition(
    String(config.variables?.node_module_version) === abi &&
      (!adjacent || config.variables?.target_arch === context.runtime.arch),
    "Node header config.gypi ABI/architecture mismatch"
  );
  // Official downloadable headers can carry an x64 template config on arm64.
  // Only the explicit host-download path allows that template; the generated
  // build/config.gypi must still prove the actual runtime architecture below.
  return { root, node, abi, arch: context.runtime.arch };
}

export function verifyElf(context, filename) {
  requireCondition(context.exists(filename), `Native payload missing: ${filename}`);
  const bytes = context.readBuffer(filename);
  const machine = context.runtime.arch === "arm64" ? 183 : 62;
  requireCondition(
    bytes.length >= 20 &&
      bytes.subarray(0, 4).equals(Buffer.from([0x7f, 69, 76, 70])) &&
      bytes[4] === 2 &&
      bytes[5] === 1 &&
      bytes.readUInt16LE(18) === machine,
    `Wrong architecture or corrupt ELF payload: ${filename}`
  );
}

export function loadAddon(context, filename) {
  verifyElf(context, filename);
  requireCondition(filename.endsWith(".node"), `Not a native addon: ${filename}`);
  const binding = context.load(filename);
  requireCondition(
    binding && ["object", "function"].includes(typeof binding),
    `Empty addon: ${filename}`
  );
  requireCondition(
    context
      .loadedPaths()
      .some(
        (loaded) =>
          loaded === filename ||
          (loaded.endsWith(".node") && context.realpath(loaded) === context.realpath(filename))
      ),
    `Native binding not present in require.cache: ${filename}`
  );
  return binding;
}

export function tproxyPaths(projectRoot) {
  const directory = path.join(projectRoot, "src", "mitm", "tproxy", "native");
  return {
    directory,
    output: path.join(directory, "build", "Release", "transparent.node"),
    receipt: path.join(directory, "build", "Release", "transparent.build.json"),
    config: path.join(directory, "build", "config.gypi"),
  };
}

/** Return a receipt only after real build metadata and a loadable addon agree. */
export function inspectTproxyOutput(context, headers, tool) {
  const files = tproxyPaths(context.root);
  const config = readGypi(context, files.config);
  requireCondition(
    String(config.variables?.node_module_version) === String(context.runtime.abi) &&
      config.variables?.target_arch === context.runtime.arch,
    "TPROXY build config.gypi ABI/architecture mismatch"
  );
  samePath(context, config.variables?.nodedir ?? "", headers.root, "TPROXY build headers");
  const binding = loadAddon(context, files.output);
  for (const name of ["createTransparentListener", "setSocketMark", "connectMarked"]) {
    requireCondition(typeof binding[name] === "function", `TPROXY export missing: ${name}`);
  }
  return {
    schema: 1,
    node: context.runtime.node,
    abi: String(context.runtime.abi),
    arch: context.runtime.arch,
    nodeRoot: headers.root,
    nodeGypVersion: tool.version,
    binarySha256: sha256(context, files.output),
    sources: Object.fromEntries(
      ["binding.gyp", "transparent.c"].map((name) => [
        name,
        sha256(context, path.join(files.directory, name)),
      ])
    ),
  };
}

/**
 * Effects are injectable: run(cmd,args,cwd,env), exists, readText, readBuffer,
 * realpath, resolve, load, loadedPaths, remove, writeText, runtime, execPath, env.
 * `strict` or OMNIROUTE_DOCKER_NATIVE_BUILD=1 makes every missing input/failure
 * fatal. Legacy host header download needs explicit allowHeaderDownload=true or
 * OMNIROUTE_TPROXY_ALLOW_HEADER_DOWNLOAD=1; it still uses the local locked tool.
 */
export function buildTproxyNative(projectRoot, opts = {}) {
  const context = createNativeContext(projectRoot, opts);
  const platform = opts.platform ?? context.runtime.platform;
  const strict = opts.strict === true || context.env.OMNIROUTE_DOCKER_NATIVE_BUILD === "1";
  const run = opts.run ?? defaultRun;
  const remove = opts.remove ?? ((filename) => rmSync(filename, { force: true }));
  const writeText = opts.writeText ?? ((filename, content) => writeFileSync(filename, content));
  const files = tproxyPaths(context.root);
  try {
    if (platform !== "linux") throw new Error("non-linux host (IP_TRANSPARENT is Linux-only)");
    if (!context.exists(path.join(files.directory, "binding.gyp"))) {
      throw new Error("native sources absent (binding.gyp not found)");
    }
    // Never let a failed rebuild be accepted through an earlier success receipt.
    remove(files.receipt);
    const tool = resolveLockedNodeGyp(context);
    const allowDownload =
      opts.allowHeaderDownload === true ||
      context.env.OMNIROUTE_TPROXY_ALLOW_HEADER_DOWNLOAD === "1";
    if (strict && allowDownload)
      throw new Error("Docker forbids the host header-download fallback");
    let headers;
    try {
      headers = validateNodeHeaders(context);
    } catch (error) {
      if (!strict && allowDownload && error.code === "NODE_HEADERS_MISSING") {
        headers = null;
      } else {
        throw error;
      }
    }
    const args = [
      tool.entry,
      "rebuild",
      `--target=${context.runtime.node}`,
      `--arch=${context.runtime.arch}`,
    ];
    if (headers) args.push(`--nodedir=${headers.root}`);
    const env = { ...context.env };
    // Do not let inherited npm configuration change the explicit runtime/tool
    // choice or force process.config over the validated installed header config.
    for (const name of Object.keys(env)) {
      if (
        /^npm_config_(target|runtime|arch|nodedir|disturl|dist_url|force_process_config|tarball)$/i.test(
          name
        )
      ) {
        delete env[name];
      }
    }
    run(context.execPath, args, files.directory, env);
    if (!context.exists(files.output)) throw new Error("node-gyp produced no transparent.node");
    if (!headers) {
      // Explicit legacy-host fallback must still validate the downloaded headers
      // after node-gyp reports which header tree it actually used.
      const config = parseGypConfig(context.readText(files.config));
      if (!config.variables?.nodedir)
        throw new Error("node-gyp did not record its header directory");
      headers = validateNodeHeaders(context, {
        nodeRoot: config.variables.nodedir,
        adjacent: false,
      });
    }
    const receipt = inspectTproxyOutput(context, headers, tool);
    writeText(files.receipt, `${JSON.stringify(receipt, null, 2)}\n`);
    return { built: true };
  } catch (error) {
    if (strict) throw error;
    return { built: false, reason: `toolchain/build failed: ${error?.message ?? String(error)}` };
  }
}

function defaultRun(cmd, args, cwd, env) {
  execFileSync(cmd, args, { cwd, env, stdio: "inherit" });
}
