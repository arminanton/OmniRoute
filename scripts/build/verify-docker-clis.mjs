#!/usr/bin/env node
/** Offline Docker CLI readiness gates. No package manager or install hooks run here.
 * Run with Docker RUN --network=none, after setup-docker-clis.mjs, as USER node.
 * Importing this module only defines helpers; tests need no installed CLI packages.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CLI_VERSIONS = Object.freeze({
  "@openai/codex": "0.158.0",
  "@anthropic-ai/claude-code": "2.1.260",
  droid: "0.212.0",
  openclaw: "2026.9.1",
});
export const DEFAULT_GLOBAL_ROOT = "/usr/local/lib/node_modules";
export const DEFAULT_BIN_ROOT = "/usr/local/bin";
export const COMMAND_TIMEOUT_MS = 20_000;
export const MAX_OUTPUT_BYTES = 128 * 1024;
// SHA256 of source members in the exact public npm tarballs, not hashes of local installs.
export const AUDITED_SOURCE_HASHES = Object.freeze({
  claudeInstall: "5cbab1670597f492cd4eeb946f3c344ebcb1fbd43c623ba192c9b33744461b85",
  openclawPreinstall: "e4216bfce089c40578d9fde499990960eb98722c2c8c5f7ab7619d340db6680a",
  openclawPostinstall: "91b18605d3c3e7493099172fe8658c363235c2b68bc10642dd85b1f470c4e0fe",
  openclawNodeVersion: "8ca5102f3beaea724f23bab3f92527d772de1470b3af6f3edce18b296342c8da",
  openclawMarker: "32c50197ecc6f10b78f9f8ef588b868e7cdf428233e00fb912044dee5da46e1a",
  droidShim: "b5227b0a92d7ead6c9b19090f1af864671f4fabc00066a69a659335f544364d8",
  droidPlatform: "92baf3d3969b3efe12cf6f53d30e5b109efefe7a58fb035d31badebdf363f61f",
  codexShim: "61b0194f3bb6534439c8d26a3ed57d0805f84b884588b761795323eeb92fcf70",
});

/** Read only the runtime header/identity, with environment collection disabled. */
export function readRuntimeIdentity() {
  const previousExcludeEnv = process.report.excludeEnv;
  let header;
  try {
    process.report.excludeEnv = true;
    header = process.report.getReport().header;
  } finally {
    process.report.excludeEnv = previousExcludeEnv;
  }
  return {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    glibcVersion: header.glibcVersionRuntime,
    uid: process.getuid?.(),
    gid: process.getgid?.(),
  };
}

// Supplying an identity is a pure test seam: missing libc must not fall back to the host.
export function assertRuntime(
  { platform, arch, nodeVersion, glibcVersion } = readRuntimeIdentity()
) {
  assert.equal(platform, "linux", "Docker CLI gates require Linux");
  assert.ok(arch === "x64" || arch === "arm64", `Unsupported Docker architecture: ${arch}`);
  assert.equal(typeof nodeVersion, "string", "Missing Node runtime version");
  assert.match(nodeVersion, /^26\.\d+\.\d+$/, "Docker CLI gates require the Node 26 image runtime");
  assert.equal(
    typeof glibcVersion,
    "string",
    "GNU/glibc runtime required; refusing to force LIBC=glibc"
  );
  assert.match(glibcVersion, /^\d+\.\d+(?:\.\d+)?$/, "Invalid GNU/glibc runtime version");
}

export function formatRuntimeSummary(runtime) {
  assertRuntime(runtime);
  for (const key of ["uid", "gid"]) {
    assert.ok(
      Number.isInteger(runtime[key]) && runtime[key] >= 0 && runtime[key] <= 0xffffffff,
      `Invalid runtime ${key}`
    );
  }
  const summary =
    `node=${runtime.nodeVersion} platform=${runtime.platform} arch=${runtime.arch} ` +
    `libc=glibc-${runtime.glibcVersion} uid=${runtime.uid} gid=${runtime.gid}`;
  assert.ok(summary.length <= 160, "Runtime diagnostic exceeds its output bound");
  return summary;
}

export function assertPackageVersion(manifest, name, version) {
  assert.equal(manifest.name, name, `Unexpected package name (expected ${name})`);
  assert.equal(manifest.version, version, `Unaudited ${name} version`);
}

export function assertContained(root, candidate) {
  const relative = path.relative(root, candidate);
  assert.ok(
    relative === "" ||
      (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)),
    `Path escapes CLI installation: ${candidate}`
  );
  return candidate;
}

function existingFile(root, candidate) {
  const resolved = assertContained(root, fs.realpathSync(candidate));
  const stat = fs.statSync(resolved);
  assert.ok(stat.isFile() && stat.size > 0, `Missing or empty CLI artifact: ${candidate}`);
  return resolved;
}

export function assertElf(file, arch, executable = false) {
  const header = Buffer.alloc(20);
  const fd = fs.openSync(file, "r");
  try {
    assert.equal(fs.readSync(fd, header, 0, header.length, 0), header.length);
  } finally {
    fs.closeSync(fd);
  }
  assert.equal(header.subarray(0, 4).toString("hex"), "7f454c46", `Not an ELF binary: ${file}`);
  assert.equal(header[4], 2, `Not a 64-bit ELF binary: ${file}`);
  assert.equal(header[5], 1, `Not a little-endian ELF binary: ${file}`);
  assert.equal(
    header.readUInt16LE(18),
    arch === "x64" ? 62 : 183,
    `Wrong ELF architecture: ${file}`
  );
  if (executable) {
    assert.equal(
      fs.statSync(file).mode & 0o005,
      0o005,
      `Binary must be readable/executable by USER node: ${file}`
    );
  }
}

function readPackage(globalRoot, dir, name, version) {
  const realDir = assertContained(globalRoot, fs.realpathSync(dir));
  const manifestFile = existingFile(globalRoot, path.join(realDir, "package.json"));
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  assertPackageVersion(manifest, name, version);
  return { dir: realDir, manifest };
}

// Resolve only inside this global installation. Never search HOME, NODE_PATH or app node_modules.
function dependency(globalRoot, owner, installName, version, manifestName = installName) {
  let current = owner.dir;
  const candidates = [];
  while (current !== globalRoot) {
    assertContained(globalRoot, current);
    if (path.basename(current) !== "node_modules")
      candidates.push(path.join(current, "node_modules", installName));
    current = path.dirname(current);
  }
  candidates.push(path.join(globalRoot, installName));
  const dir = candidates.find((candidate) => fs.existsSync(path.join(candidate, "package.json")));
  assert.ok(dir, `Required optional/native package missing: ${installName}@${version}`);
  return readPackage(globalRoot, dir, manifestName, version);
}

function declared(owner, name, expected, optional = false) {
  assert.equal(
    owner.manifest[optional ? "optionalDependencies" : "dependencies"]?.[name],
    expected,
    `Unaudited dependency declaration: ${owner.manifest.name} -> ${name}`
  );
}

export function nativeRequirements(arch) {
  assert.ok(arch === "x64" || arch === "arm64", "Unsupported native architecture");
  return [
    {
      name: "koffi",
      version: "3.1.6",
      platformName: `@koromix/koffi-linux-${arch}`,
      file: `linux_${arch}/koffi.node`,
    },
    {
      name: "tree-sitter-bash",
      version: "0.25.1",
      file: `prebuilds/linux-${arch}/tree-sitter-bash.node`,
    },
    {
      name: "@lydell/node-pty",
      version: "1.2.0-beta.15",
      platformName: `@lydell/node-pty-linux-${arch}`,
      file: `prebuilds/linux-${arch}/pty.node`,
    },
    {
      name: "@openclaw/fs-safe",
      version: "0.7.0",
      platformName: `@openclaw/fs-safe-linux-${arch}-gnu`,
      file: "fs-safe-native.node",
    },
    {
      name: "@trycua/cua-driver",
      version: "0.22.0",
      platformName: `@trycua/cua-driver-linux-${arch}-gnu`,
      file: "cua_driver_node_runtime.node",
      extra: "libcua_driver_sdk.so",
    },
    {
      name: "sqlite-vec",
      version: "0.1.9",
      optional: true,
      platformName: `sqlite-vec-linux-${arch}`,
      file: "vec0.so",
    },
  ];
}

/** Filesystem-only inspection. Accepts fixture globalRoot/binRoot/arch; executes no package code. */
export function inspectInstall({
  globalRoot = DEFAULT_GLOBAL_ROOT,
  binRoot = DEFAULT_BIN_ROOT,
  arch = process.arch,
} = {}) {
  assert.ok(arch === "x64" || arch === "arm64", "Unsupported CLI architecture");
  globalRoot = fs.realpathSync(globalRoot);
  binRoot = path.resolve(binRoot);
  const roots = Object.fromEntries(
    Object.entries(CLI_VERSIONS).map(([name, version]) => [
      name,
      readPackage(globalRoot, path.join(globalRoot, name), name, version),
    ])
  );
  const codex = roots["@openai/codex"];
  const claude = roots["@anthropic-ai/claude-code"];
  const droid = roots.droid;
  const openclaw = roots.openclaw;
  const binaries = {};
  const binEntries = {
    codex: [codex, "bin/codex.js"],
    claude: [claude, "bin/claude.exe"],
    droid: [droid, "bin/droid"],
    openclaw: [openclaw, "openclaw.mjs"],
  };
  for (const [command, [pkg, entry]] of Object.entries(binEntries)) {
    assert.equal(pkg.manifest.bin?.[command], entry, `Unexpected ${command} bin declaration`);
    const expected = existingFile(globalRoot, path.join(pkg.dir, entry));
    binaries[command] = path.join(binRoot, command);
    assert.equal(
      fs.realpathSync(binaries[command]),
      expected,
      `Global ${command} does not resolve to the audited package`
    );
  }

  const codexAlias = `@openai/codex-linux-${arch}`;
  declared(codex, codexAlias, `npm:@openai/codex@0.158.0-linux-${arch}`, true);
  const codexNative = dependency(
    globalRoot,
    codex,
    codexAlias,
    `0.158.0-linux-${arch}`,
    "@openai/codex"
  );
  const target = `${arch === "x64" ? "x86_64" : "aarch64"}-unknown-linux-musl`;
  const vendor = path.join(codexNative.dir, "vendor", target);
  const codexMetadata = JSON.parse(
    fs.readFileSync(existingFile(globalRoot, path.join(vendor, "codex-package.json")), "utf8")
  );
  for (const [key, value] of Object.entries({
    layoutVersion: 1,
    version: "0.158.0",
    target,
    variant: "codex",
    entrypoint: "bin/codex",
    resourcesDir: "codex-resources",
    pathDir: "codex-path",
  })) {
    assert.equal(codexMetadata[key], value, `Unexpected Codex layout field ${key}`);
  }
  for (const entry of [
    "bin/codex",
    "bin/codex-code-mode-host",
    "codex-resources/bwrap",
    "codex-resources/zsh/bin/zsh",
    "codex-path/rg",
  ]) {
    assertElf(existingFile(globalRoot, path.join(vendor, entry)), arch, true);
  }

  const claudeName = `@anthropic-ai/claude-code-linux-${arch}`;
  declared(claude, claudeName, "2.1.260", true);
  const claudeNative = dependency(globalRoot, claude, claudeName, "2.1.260");
  assert.ok(claudeNative.manifest.libc?.includes("glibc"), "Claude GNU binary package required");
  const claudeBinary = existingFile(globalRoot, path.join(claudeNative.dir, "claude"));
  assertElf(claudeBinary, arch, true);
  for (const name of [
    `@factory/cli-linux-${arch}`,
    ...(arch === "x64" ? ["@factory/cli-linux-x64-baseline"] : []),
  ]) {
    declared(droid, name, "0.212.0", true);
    const pkg = dependency(globalRoot, droid, name, "0.212.0");
    assertElf(existingFile(globalRoot, path.join(pkg.dir, "bin/droid")), arch, true);
  }

  const native = [];
  for (const requirement of nativeRequirements(arch)) {
    declared(openclaw, requirement.name, requirement.version, requirement.optional);
    const pkg = dependency(globalRoot, openclaw, requirement.name, requirement.version);
    let binaryPackage = pkg;
    if (requirement.platformName) {
      declared(pkg, requirement.platformName, requirement.version, true);
      binaryPackage = dependency(globalRoot, pkg, requirement.platformName, requirement.version);
    }
    const file = existingFile(globalRoot, path.join(binaryPackage.dir, requirement.file));
    assertElf(file, arch);
    if (requirement.extra)
      assertElf(existingFile(globalRoot, path.join(binaryPackage.dir, requirement.extra)), arch);
    native.push({ ...requirement, dir: pkg.dir, file });
    if (requirement.name === "@trycua/cua-driver") {
      declared(pkg, "@ubjs/node", "0.31.0-3");
      const ubjs = dependency(globalRoot, pkg, "@ubjs/node", "0.31.0-3");
      const name = `@ubjs/node-linux-${arch}-gnu`;
      declared(ubjs, name, "0.31.0-3", true);
      const targetPackage = dependency(globalRoot, ubjs, name, "0.31.0-3");
      const ubjsFile = existingFile(
        globalRoot,
        path.join(targetPackage.dir, `uniffi-runtime-napi.linux-${arch}-gnu.node`)
      );
      assertElf(ubjsFile, arch);
      native.push({ name: "@ubjs/node", version: "0.31.0-3", dir: ubjs.dir, file: ubjsFile });
    }
  }
  return { globalRoot, binRoot, arch, roots, binaries, native, claudeBinary };
}

export function auditedSourcePaths(layout) {
  const { roots } = layout;
  return {
    claudeInstall: path.join(roots["@anthropic-ai/claude-code"].dir, "install.cjs"),
    openclawPreinstall: path.join(
      roots.openclaw.dir,
      "scripts/preinstall-package-manager-warning.mjs"
    ),
    openclawPostinstall: path.join(roots.openclaw.dir, "scripts/postinstall-bundled-plugins.mjs"),
    openclawNodeVersion: path.join(roots.openclaw.dir, "node-version.mjs"),
    openclawMarker: path.join(roots.openclaw.dir, "scripts/lib/package-lifecycle-marker.mjs"),
    droidShim: path.join(roots.droid.dir, "bin/droid"),
    droidPlatform: path.join(roots.droid.dir, "platform.js"),
    codexShim: path.join(roots["@openai/codex"].dir, "bin/codex.js"),
  };
}

export function assertAuditedSources(layout) {
  for (const [key, file] of Object.entries(auditedSourcePaths(layout))) {
    const source = existingFile(layout.globalRoot, file);
    assert.ok(fs.statSync(source).size <= 256 * 1024, `Unexpected source size: ${key}`);
    const hash = createHash("sha256").update(fs.readFileSync(source)).digest("hex");
    assert.equal(
      hash,
      AUDITED_SOURCE_HASHES[key],
      `Unaudited source: ${key}; stop and review this exact package`
    );
  }
}

export function assertReady(layout) {
  const openclaw = layout.roots.openclaw.dir;
  for (const marker of [
    ".openclaw-lifecycle-pending",
    "dist/openclaw-install-guard",
    ".openclaw-lifecycle-lock",
  ]) {
    let exists = false;
    try {
      fs.lstatSync(path.join(openclaw, marker));
      exists = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    assert.equal(
      exists,
      false,
      `OpenClaw setup incomplete (${marker}); never replay setup at non-root first launch`
    );
  }
  const claudeBin = path.join(layout.roots["@anthropic-ai/claude-code"].dir, "bin/claude.exe");
  assertElf(claudeBin, layout.arch, true);
  assert.equal(
    fs.statSync(claudeBin).size,
    fs.statSync(layout.claudeBinary).size,
    "Claude binary placement incomplete"
  );
}

/** Deliberately do not merge process.env. No host keys, proxies, loaders or config paths. */
export function cleanEnvironment(home, binRoot = DEFAULT_BIN_ROOT, nodePath = process.execPath) {
  return {
    PATH: [...new Set([path.dirname(nodePath), binRoot, "/usr/bin", "/bin"])].join(":"),
    HOME: home,
    TMPDIR: home,
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    XDG_DATA_HOME: path.join(home, "data"),
    CODEX_HOME: path.join(home, "codex"),
    CLAUDE_CONFIG_DIR: path.join(home, "claude"),
    OPENCLAW_HOME: home,
    OPENCLAW_STATE_DIR: path.join(home, "openclaw"),
    OPENCLAW_CONFIG_PATH: path.join(home, "openclaw", "absent.json"),
    npm_config_userconfig: "/dev/null",
    npm_config_cache: path.join(home, "npm"),
    CI: "1",
    TERM: "dumb",
    NO_COLOR: "1",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    DO_NOT_TRACK: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    NODE_DISABLE_COMPILE_CACHE: "1",
    PREBUILDS_ONLY: "1",
    LIBC: "glibc",
  };
}

export async function withTemporaryHome(callback) {
  // A fixed system temp root avoids reading a host-controlled TMPDIR value.
  const home = fs.mkdtempSync(path.join("/tmp", "omniroute-cli-gate-"));
  try {
    for (const entry of ["config", "cache", "data", "codex", "claude", "openclaw", "npm"]) {
      fs.mkdirSync(path.join(home, entry), { mode: 0o700 });
    }
    return await callback(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/** Bounded argv-only child; kill its process group on timeout or excessive output. */
export function runBounded(
  command,
  args,
  {
    env,
    cwd,
    label = command,
    timeoutMs = COMMAND_TIMEOUT_MS,
    maxOutputBytes = MAX_OUTPUT_BYTES,
    spawnImpl = spawn,
    killImpl = (pid, signal) => process.kill(pid, signal),
  } = {}
) {
  assert.ok(env && cwd, "Explicit clean environment and cwd are required");
  assert.ok(
    Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60_000,
    "Invalid command timeout"
  );
  assert.ok(
    Number.isInteger(maxOutputBytes) && maxOutputBytes > 0 && maxOutputBytes <= MAX_OUTPUT_BYTES,
    "Invalid command output limit"
  );
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      env,
      cwd,
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let done = false;
    let bytes = 0;
    const chunks = [];
    let timer;
    const stopProcessGroup = () => {
      if (!child.pid) return null; // A spawn failure never created a process group.
      try {
        killImpl(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code === "ESRCH") return null; // The whole owned group is already gone.
        try {
          child.kill?.("SIGKILL");
        } catch {}
        return new Error(
          `${label}: could not terminate owned process group (${error.code ?? "unknown"})`
        );
      }
      return null;
    };
    const finish = (error, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Also remove descendants whose parent exited successfully with detached stdio.
      const cleanupError = stopProcessGroup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref?.();
      if (error || cleanupError) reject(error ?? cleanupError);
      else resolve(result);
    };
    const onData = (chunk) => {
      if (done) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxOutputBytes)
        finish(new Error(`${label}: exceeded ${maxOutputBytes} output bytes`));
      else chunks.push(Buffer.from(chunk));
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (error) =>
      finish(new Error(`${label}: failed to start (${error.code ?? "unknown"})`))
    );
    child.on("close", (code, signal) => {
      const output = Buffer.concat(chunks).toString("utf8");
      if (code !== 0 || signal)
        finish(
          new Error(`${label}: exit ${code}, signal ${signal ?? "none"}\n${output.slice(-8192)}`)
        );
      else finish(null, { output, code });
    });
    // Mock runners can settle while listeners are registered; do not leave a timer behind.
    if (!done)
      timer = setTimeout(() => finish(new Error(`${label}: exceeded ${timeoutMs} ms`)), timeoutMs);
  });
}

export function assertVersionOutput(output, version, label) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(
    output,
    new RegExp(`(?:^|[^0-9.])${escaped}(?![0-9A-Za-z.+-])`),
    `${label}: unexpected version output`
  );
}

export function assertGlobalNpmRoot(output, globalRoot) {
  assert.equal(typeof output, "string", "npm root -g must return text");
  assert.equal(output.trim(), globalRoot, "npm root -g does not match the audited global root");
}

export function assertGlobalNpmPackages(output) {
  assert.equal(typeof output, "string", "npm global listing must return JSON text");
  let listing;
  try {
    listing = JSON.parse(output);
  } catch {
    throw new Error("npm global listing is not valid JSON");
  }
  assert.ok(
    listing && typeof listing === "object" && !Array.isArray(listing),
    "npm global listing must be an object"
  );
  const dependencies = listing.dependencies;
  assert.ok(
    dependencies && typeof dependencies === "object" && !Array.isArray(dependencies),
    "npm global listing must contain dependencies"
  );
  for (const [name, version] of Object.entries(CLI_VERSIONS)) {
    const entry = dependencies[name];
    assert.ok(
      entry && typeof entry === "object" && !Array.isArray(entry),
      `npm global discovery missing ${name}`
    );
    assert.equal(entry.version, version, `npm global discovery has an unaudited ${name} version`);
  }
}

// Direct .node imports have no node-gyp/install fallback. Then test real wrappers and sqlite extension.
export const NATIVE_CHECK_SOURCE = String.raw`
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
const native = JSON.parse(process.argv[1]);
const require = createRequire(path.join(native[0].dir, "package.json"));
for (const item of native) if (item.file.endsWith(".node")) require(item.file);
const get = (name) => native.find((item) => item.name === name);
assert.equal(require(get("koffi").dir).version, "3.1.6");
assert.equal(require(path.join(get("tree-sitter-bash").dir, "bindings/node/index.js")).name, "bash");
assert.equal(typeof require(get("@lydell/node-pty").dir).spawn, "function");
const db = new DatabaseSync(":memory:", { allowExtension: true });
try {
  db.loadExtension(get("sqlite-vec").file);
  assert.match(db.prepare("select vec_version() as v").get().v, /^v?0\.1\.9$/);
} finally { db.close(); }
console.log("offline native prebuild checks passed");
`;

export function verificationPlan(layout, nodePath = process.execPath) {
  const cliVersions = {
    codex: CLI_VERSIONS["@openai/codex"],
    claude: CLI_VERSIONS["@anthropic-ai/claude-code"],
    droid: CLI_VERSIONS.droid,
    openclaw: CLI_VERSIONS.openclaw,
  };
  return [
    ...Object.entries(cliVersions).flatMap(([name, version]) => [
      { label: `${name} --version`, command: layout.binaries[name], args: ["--version"], version },
      { label: `${name} --help`, command: layout.binaries[name], args: ["--help"], helpName: name },
    ]),
    {
      label: "npm root -g",
      command: path.join(layout.binRoot, "npm"),
      args: ["root", "-g"],
      npmRoot: layout.globalRoot,
    },
    {
      label: "npm ls --global --depth=0 --json",
      command: path.join(layout.binRoot, "npm"),
      args: ["ls", "--global", "--depth=0", "--json"],
      npmPackages: true,
    },
    {
      label: "native prebuilt loads",
      command: nodePath,
      args: ["--input-type=module", "-e", NATIVE_CHECK_SOURCE, JSON.stringify(layout.native)],
      expected: "offline native prebuild checks passed",
    },
  ];
}

/** Inject inspector/runner/checks for offline unit tests; the CLI exposes no bypass flags. */
export async function verifyInstalledClis(
  options = {},
  {
    inspect = inspectInstall,
    run = runBounded,
    sources = assertAuditedSources,
    ready = assertReady,
    temporaryHome = withTemporaryHome,
  } = {}
) {
  const layout = inspect(options);
  sources(layout);
  ready(layout); // Reject pending lifecycle before invoking any OpenClaw code.
  await temporaryHome(async (home) => {
    const env = cleanEnvironment(home, layout.binRoot);
    for (const step of verificationPlan(layout)) {
      const { output, code } = await run(step.command, step.args, {
        env,
        cwd: home,
        label: step.label,
      });
      assert.equal(code, 0, `${step.label}: command must exit successfully`);
      if (step.npmRoot) assertGlobalNpmRoot(output, step.npmRoot);
      if (step.npmPackages) assertGlobalNpmPackages(output);
      if (step.version) assertVersionOutput(output, step.version, step.label);
      if (step.helpName)
        assert.match(
          output.toLowerCase(),
          new RegExp(`\\b${step.helpName}\\b`),
          `${step.label}: empty/unexpected help`
        );
      if (step.expected)
        assert.ok(output.includes(step.expected), `${step.label}: incomplete check`);
    }
  });
  ready(layout);
  return layout;
}

export function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help") {
      options.help = true;
      continue;
    }
    const key = arg === "--global-root" ? "globalRoot" : arg === "--bin-root" ? "binRoot" : null;
    assert.ok(
      key && argv[i + 1] && !argv[i + 1].startsWith("--"),
      `Unknown or incomplete argument: ${arg}`
    );
    assert.ok(!options[key], `Duplicate argument: ${arg}`);
    options[key] = path.resolve(argv[++i]);
  }
  return options;
}

export function isMain(url, argv1 = process.argv[1]) {
  return Boolean(argv1) && fileURLToPath(url) === path.resolve(argv1);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(
      "verify-docker-clis.mjs [--global-root DIR] [--bin-root DIR] (Docker --network=none, USER node)"
    );
    return;
  }
  const runtime = readRuntimeIdentity();
  assertRuntime(runtime);
  assert.equal(runtime.uid, 1000, "Run Docker CLI verification as runtime UID 1000");
  assert.equal(runtime.gid, 1000, "Run Docker CLI verification as runtime GID 1000");
  console.log(`Docker CLI target: ${formatRuntimeSummary(runtime)}`);
  await verifyInstalledClis(options);
  console.log("Docker CLI offline readiness verified (all four exact versions)");
}

if (isMain(import.meta.url)) {
  main().catch((error) => {
    console.error(`Docker CLI verification failed: ${error.message}`);
    process.exitCode = 1;
  });
}
