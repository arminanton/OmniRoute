/** Offline, fail-closed checks for the locked GNU Linux Docker native payloads.
 * No installers, fallback downloaders, model sessions, transports, or sockets run.
 * Run the CLI under Docker RUN --network=none as a second network boundary.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  contained,
  createNativeContext,
  inspectTproxyOutput,
  loadAddon,
  lockedPackage,
  readJson,
  requireCondition,
  resolveLockedNodeGyp,
  samePath,
  sha256,
  tproxyPaths,
  validateNodeHeaders,
  verifyElf,
} from "./build-tproxy-native.mjs";

// Preserve the Docker gate's test API without making the published host helper
// depend on this Docker-only module.
export {
  createNativeContext,
  inspectTproxyOutput,
  parseGypConfig,
  readGlibcVersion,
  resolveLockedNodeGyp,
  tproxyPaths,
  validateNodeHeaders,
} from "./build-tproxy-native.mjs";

function loadWrapper(context, name, allowedNativePaths) {
  const pkg = lockedPackage(context, name);
  const entry = context.resolve(name);
  contained(context, entry, pkg.directory);
  const before = new Set(context.loadedPaths());
  const wrapper = context.load(name);
  for (const dependency of context.dependencyPaths(entry)) {
    contained(context, dependency, path.join(context.root, "node_modules"));
  }
  const allowed = new Set(allowedNativePaths.map((filename) => context.realpath(filename)));
  for (const loaded of context.loadedPaths()) {
    if (loaded.endsWith(".node") && !before.has(loaded)) {
      requireCondition(
        allowed.has(context.realpath(loaded)),
        `${name}: unexpected native fallback ${loaded}`
      );
    }
  }
  return wrapper;
}

/** Direct platform loads cannot run Next/unrs/sharp wrapper recovery installers. */
export function requiredNativePackages(arch) {
  return [
    `@wreq-js/binding-linux-${arch}-gnu`,
    `@next/swc-linux-${arch}-gnu`,
    `@swc/core-linux-${arch}-gnu`,
    `@parcel/watcher-linux-${arch}-glibc`,
    `@tailwindcss/oxide-linux-${arch}-gnu`,
    `lightningcss-linux-${arch}-gnu`,
    `@unrs/resolver-binding-linux-${arch}-gnu`,
    `@yuku-analyzer/binding-linux-${arch}-gnu`,
    `@ngrok/ngrok-linux-${arch}-gnu`,
  ];
}

function verifyTproxy(context, headers, tool, standaloneRoot) {
  const files = tproxyPaths(context.root);
  const receipt = readJson(context, files.receipt);
  const observed = inspectTproxyOutput(context, headers, tool);
  requireCondition(
    JSON.stringify(receipt) === JSON.stringify(observed),
    "TPROXY build receipt mismatch"
  );
  if (standaloneRoot) {
    const standalone = path.join(
      standaloneRoot,
      "src",
      "mitm",
      "tproxy",
      "native",
      "build",
      "Release",
      "transparent.node"
    );
    requireCondition(
      sha256(context, standalone) === receipt.binarySha256,
      "Standalone TPROXY bytes differ"
    );
    const binding = loadAddon(context, standalone);
    requireCondition(
      typeof binding.createTransparentListener === "function",
      "Standalone TPROXY addon invalid"
    );
  }
  return observed;
}

export function verifyDockerNativeDeps(projectRoot, opts = {}) {
  const context = createNativeContext(projectRoot, opts);
  const runtime = context.runtime;
  requireCondition(
    runtime.platform === "linux" && ["x64", "arm64"].includes(runtime.arch),
    "GNU Linux x64/arm64 required"
  );
  requireCondition(
    /^26\./.test(runtime.node) && String(runtime.abi) === "147",
    "Docker Node26 ABI147 required"
  );
  const [glibcMajor, glibcMinor] = String(runtime.glibc ?? "")
    .split(".")
    .map(Number);
  requireCondition(
    glibcMajor > 2 || (glibcMajor === 2 && glibcMinor >= 34),
    "glibc >=2.34 required"
  );
  requireCondition(Number(runtime.napi) >= 10, "N-API10 required");
  for (const name of [
    "NAPI_RS_NATIVE_LIBRARY_PATH",
    "NAPI_RS_FORCE_WASI",
    "SWC_BINARY_PATH",
    "ESBUILD_BINARY_PATH",
    "NEXT_TEST_WASM",
    "LIGHTNINGCSS_FORCE_WASM",
    "LIBC",
    "npm_config_libc",
    "npm_config_arch",
    "npm_config_platform",
    "npm_config_target",
    "npm_config_runtime",
  ]) {
    requireCondition(!context.env[name], `Native override is not allowed: ${name}`);
  }
  const tool = resolveLockedNodeGyp(context);
  const headers = validateNodeHeaders(context);
  const checked = verifyRuntimePayloads(context);
  for (const name of requiredNativePackages(runtime.arch)) {
    if (!name.startsWith("@wreq-js/") && !name.startsWith("@ngrok/")) {
      checked.push(verifyPlatformPackage(context, name));
    }
  }
  const esbuild = lockedPackage(context, "esbuild");
  const esbuildName = `@esbuild/linux-${runtime.arch}`;
  const esbuildPlatform = lockedPackage(context, esbuildName, esbuild.version);
  const esbuildPath = path.join(esbuildPlatform.directory, "bin", "esbuild");
  verifyElf(context, esbuildPath);
  requireCondition(
    esbuild.metadata["esbuild.binaryHashes"]?.[`${esbuildName}/bin/esbuild`] ===
      sha256(context, esbuildPath),
    "esbuild executable SHA256 mismatch"
  );
  checked.push({ name: "esbuild", version: esbuild.version, path: esbuildPath });

  const tproxy = opts.requireTproxy
    ? verifyTproxy(context, headers, tool, opts.standaloneRoot)
    : undefined;
  let standalone;
  if (opts.standaloneRoot) {
    requireCondition(
      opts.requireTproxy,
      "Standalone validation requires the TPROXY acceptance gate"
    );
    const standaloneContext = createNativeContext(opts.standaloneRoot, {
      ...opts,
      ...opts.standaloneOptions,
      lockRoot: context.root,
      resolve: opts.standaloneOptions?.resolve,
      load: opts.standaloneOptions?.load,
      loadedPaths: opts.standaloneOptions?.loadedPaths,
      dependencyPaths: opts.standaloneOptions?.dependencyPaths,
    });
    standalone = verifyRuntimePayloads(standaloneContext);
    for (const entry of standalone) {
      const original = checked.find((candidate) => candidate.name === entry.name);
      requireCondition(
        original && sha256(context, original.path) === sha256(standaloneContext, entry.path),
        `Standalone native bytes differ: ${entry.name}`
      );
    }
  }
  return { runtime, headers, nodeGyp: tool, checked, tproxy, standalone };
}

function verifyPlatformPackage(context, name) {
  const pkg = lockedPackage(context, name);
  requireCondition(
    pkg.metadata.os?.includes("linux") &&
      pkg.metadata.cpu?.includes(context.runtime.arch) &&
      pkg.metadata.libc?.includes("glibc"),
    `${name}: platform/libc metadata mismatch`
  );
  const filename = path.resolve(pkg.directory, pkg.metadata.main ?? "");
  contained(context, filename, pkg.directory);
  loadAddon(context, filename);
  return { name, version: pkg.version, path: filename };
}

function verifyRuntimePayloads(context) {
  const runtime = context.runtime;
  const checked = [];
  const sqlite = lockedPackage(context, "better-sqlite3", "13.0.3");
  const sqlitePath = path.join(sqlite.directory, "prebuilds", `linux-${runtime.arch}.node`);
  loadAddon(context, sqlitePath);
  const Database = loadWrapper(context, "better-sqlite3", [sqlitePath]);
  const db = new Database(":memory:");
  try {
    requireCondition(
      db.prepare("SELECT 1 AS native_gate").get().native_gate === 1,
      "SQLite memory query failed"
    );
  } finally {
    db.close();
  }
  const sqliteNatives = context
    .loadedPaths()
    .filter(
      (filename) =>
        filename.endsWith(".node") &&
        filename.startsWith(`${context.realpath(sqlite.directory)}${path.sep}`)
    );
  requireCondition(sqliteNatives.length === 1, "SQLite used an unexpected native binding");
  samePath(context, sqliteNatives[0], sqlitePath, "Loaded SQLite prebuild");
  checked.push({ name: "better-sqlite3", version: sqlite.version, path: sqlitePath });

  for (const name of [
    `@wreq-js/binding-linux-${runtime.arch}-gnu`,
    `@ngrok/ngrok-linux-${runtime.arch}-gnu`,
  ])
    checked.push(verifyPlatformPackage(context, name));
  const wreq = lockedPackage(context, "wreq-js", "3.2.0");
  const wreqBinding = checked.find((entry) => entry.name.startsWith("@wreq-js/"));
  requireCondition(wreqBinding?.version === wreq.version, "wreq binding version mismatch");
  const transport = loadWrapper(context, "wreq-js", [wreqBinding.path]);
  requireCondition(
    typeof transport.createTransport === "function" &&
      typeof transport.createSession === "function",
    "wreq-js native API missing"
  );

  const sharp = lockedPackage(context, "sharp");
  const sharpPlatform = lockedPackage(context, `@img/sharp-linux-${runtime.arch}`, sharp.version);
  const libvips = lockedPackage(context, `@img/sharp-libvips-linux-${runtime.arch}`);
  for (const pkg of [sharpPlatform, libvips]) {
    requireCondition(
      pkg.metadata.os?.includes("linux") &&
        pkg.metadata.cpu?.includes(runtime.arch) &&
        pkg.metadata.libc?.includes("glibc"),
      "sharp/libvips GNU platform payloads required"
    );
  }
  const vipsRelative = libvips.metadata.exports?.["./binary"];
  requireCondition(typeof vipsRelative === "string", "libvips binary export is missing");
  const vipsPath = path.resolve(libvips.directory, vipsRelative);
  contained(context, vipsPath, libvips.directory);
  verifyElf(context, vipsPath);
  checked.push({ name: libvips.metadata.name, version: libvips.version, path: vipsPath });
  const sharpPath = path.join(
    sharpPlatform.directory,
    "lib",
    `sharp-linux-${runtime.arch}-${sharp.version}.node`
  );
  loadAddon(context, sharpPath);
  const sharpApi = loadWrapper(context, "sharp", [sharpPath]);
  requireCondition(sharpApi.versions?.sharp === sharp.version, "sharp version/load mismatch");
  checked.push({ name: "sharp", version: sharp.version, path: sharpPath });

  const onnx = lockedPackage(context, "onnxruntime-node", "1.24.3");
  const onnxPath = path.join(
    onnx.directory,
    "bin",
    "napi-v6",
    "linux",
    runtime.arch,
    "onnxruntime_binding.node"
  );
  const onnxLibrary = path.join(path.dirname(onnxPath), "libonnxruntime.so.1");
  verifyElf(context, onnxLibrary);
  checked.push({ name: "onnxruntime-node/cpu-library", version: onnx.version, path: onnxLibrary });
  loadAddon(context, onnxPath);
  const onnxApi = loadWrapper(context, "onnxruntime-node", [onnxPath]);
  requireCondition(
    onnxApi.env?.versions?.node === onnx.version,
    "ONNX CPU runtime version mismatch"
  );
  checked.push({ name: "onnxruntime-node", version: onnx.version, path: onnxPath });
  const vector = lockedPackage(context, "sqlite-vec");
  const vectorPlatform = lockedPackage(context, `sqlite-vec-linux-${runtime.arch}`, vector.version);
  const vectorPath = path.join(vectorPlatform.directory, "vec0.so");
  verifyElf(context, vectorPath);
  const vectorDb = new Database(":memory:");
  try {
    vectorDb.loadExtension(vectorPath);
    const version = vectorDb.prepare("SELECT vec_version() AS version").get().version;
    requireCondition(
      String(version).replace(/^v/, "") === vector.version,
      "sqlite-vec load/version mismatch"
    );
  } finally {
    vectorDb.close();
  }
  checked.push({ name: "sqlite-vec", version: vector.version, path: vectorPath });
  return checked;
}

function parseCli(argv) {
  const options = {};
  for (const argument of argv) {
    if (argument === "--require-tproxy") options.requireTproxy = true;
    else if (argument.startsWith("--project-root=")) options.projectRoot = argument.slice(15);
    else if (argument.startsWith("--node-root=")) options.nodeRoot = argument.slice(12);
    else if (argument.startsWith("--standalone-root=")) options.standaloneRoot = argument.slice(18);
    else throw new Error(`Unknown native-gate argument: ${argument}`);
  }
  requireCondition(
    options.projectRoot && options.nodeRoot,
    "--project-root= and --node-root= are required"
  );
  requireCondition(
    !options.standaloneRoot || options.requireTproxy,
    "--standalone-root requires --require-tproxy"
  );
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseCli(process.argv.slice(2));
    console.log(JSON.stringify(verifyDockerNativeDeps(options.projectRoot, options), null, 2));
  } catch (error) {
    console.error(`[verify-docker-native-deps] ${error.message}`);
    process.exitCode = 1;
  }
}
