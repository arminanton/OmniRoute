#!/usr/bin/env node
/** Materialize an npm-ci-verified, nested CLI tree without running package code.
 * npm ci owns tarball integrity and dependency resolution. This script validates
 * the locked filesystem boundary, then preserves each complete CLI package.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_SOURCE_PREFIX = "/tmp/docker-cli-tree";
export const DEFAULT_TARGET_PREFIX = "/usr/local";
export const CLI_ROOTS = Object.freeze([
  Object.freeze({ name: "@openai/codex", version: "0.158.0", bin: "codex", entry: "bin/codex.js" }),
  Object.freeze({
    name: "@anthropic-ai/claude-code",
    version: "2.1.260",
    bin: "claude",
    entry: "bin/claude.exe",
  }),
  Object.freeze({ name: "droid", version: "0.212.0", bin: "droid", entry: "bin/droid" }),
  Object.freeze({ name: "openclaw", version: "2026.9.1", bin: "openclaw", entry: "openclaw.mjs" }),
]);
export const MAX_TREE_ENTRIES = 250_000;
const EXPECTED_DEPENDENCIES = Object.fromEntries(
  CLI_ROOTS.map(({ name, version }) => [name, version])
);
const SAFE_PACKAGE_NAME = /^(?:@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9._~-]+$/;

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

function exists(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function regularDirectory(dir) {
  const stat = fs.lstatSync(dir);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), `Expected a real directory: ${dir}`);
}

function readJson(file, maxBytes = 2 * 1024 * 1024) {
  const stat = fs.lstatSync(file);
  assert.ok(
    stat.isFile() && !stat.isSymbolicLink() && stat.size <= maxBytes,
    `Invalid metadata file: ${file}`
  );
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(
    value && typeof value === "object" && !Array.isArray(value),
    `Invalid metadata object: ${file}`
  );
  return value;
}

function packageName(name) {
  assert.ok(
    typeof name === "string" &&
      SAFE_PACKAGE_NAME.test(name) &&
      name.split("/").every((part) => part !== "." && part !== ".."),
    `Invalid package name: ${name}`
  );
  return name;
}

function exactRoots(dependencies, label) {
  assert.deepEqual(
    dependencies,
    EXPECTED_DEPENDENCIES,
    `${label} must pin exactly the four audited CLIs`
  );
}

function lockRoot(key) {
  assert.equal(typeof key, "string");
  assert.ok(
    !key.includes("\\") && !key.split("/").some((part) => part === "." || part === ".."),
    `Invalid lock package path: ${key}`
  );
  const parts = key.split("/");
  assert.equal(parts.shift(), "node_modules", `External lock package path: ${key}`);
  const first = parts.shift();
  const name = first?.startsWith("@") ? `${first}/${parts.shift()}` : first;
  return packageName(name);
}

function dependencyMap(value, label) {
  if (value === undefined) return {};
  assert.ok(
    value && typeof value === "object" && !Array.isArray(value),
    `Invalid dependency metadata: ${label}`
  );
  return value;
}

function dependencyName(name, spec) {
  packageName(name);
  assert.equal(typeof spec, "string", `Invalid dependency specification: ${name}`);
  if (!spec.startsWith("npm:")) return name;
  const separator = spec.lastIndexOf("@");
  assert.ok(separator > 4, `Invalid npm alias: ${name}`);
  return packageName(spec.slice(4, separator));
}

function modulePackages(modulesDir) {
  regularDirectory(modulesDir);
  const result = [];
  for (const entry of fs.readdirSync(modulesDir, { withFileTypes: true })) {
    const full = path.join(modulesDir, entry.name);
    if (entry.name === ".bin") {
      regularDirectory(full);
      continue;
    }
    if (entry.name === ".package-lock.json") {
      readJson(full, 64 * 1024 * 1024);
      continue;
    }
    assert.ok(!entry.name.startsWith("."), `Unexpected node_modules entry: ${full}`);
    regularDirectory(full);
    if (entry.name.startsWith("@")) {
      const children = fs.readdirSync(full, { withFileTypes: true });
      assert.ok(children.length > 0, `Empty node_modules scope: ${full}`);
      for (const child of children) {
        const name = packageName(`${entry.name}/${child.name}`);
        const dir = path.join(full, child.name);
        regularDirectory(dir);
        result.push({ name, dir });
      }
    } else result.push({ name: packageName(entry.name), dir: full });
  }
  return result;
}

function inspectFiles(rootDir, budget) {
  const pending = [rootDir];
  while (pending.length) {
    const dir = pending.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      budget.entries += 1;
      assert.ok(budget.entries <= MAX_TREE_ENTRIES, "CLI tree inspection entry budget exceeded");
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const target = fs.readlinkSync(file);
        assert.ok(!path.isAbsolute(target), `Absolute symlink cannot be relocated: ${file}`);
        assert.ok(
          isInside(rootDir, fs.realpathSync(file)),
          `Symlink escapes its complete CLI root: ${file}`
        );
      } else if (entry.isDirectory()) pending.push(file);
      else assert.ok(entry.isFile(), `Unsupported CLI filesystem entry: ${file}`);
    }
  }
}

function inspectPackage(root, dir, installName, sourcePrefix, lock, packages) {
  regularDirectory(dir);
  const manifest = readJson(path.join(dir, "package.json"));
  packageName(manifest.name);
  assert.equal(typeof manifest.version, "string", `Missing package version: ${dir}`);
  const key = path.relative(sourcePrefix, dir).split(path.sep).join("/");
  const locked = lock.packages[key];
  assert.ok(locked && typeof locked === "object", `Installed package missing from lock: ${key}`);
  assert.ok(!locked.link, `Linked package is not a contained npm registry artifact: ${key}`);
  assert.equal(locked.version, manifest.version, `Installed/locked version mismatch: ${key}`);
  assert.equal(
    manifest.name,
    locked.name ?? installName,
    `Installed/locked package name mismatch: ${key}`
  );
  assert.match(
    locked.integrity ?? "",
    /^sha512-[A-Za-z0-9+/]{86}==$/,
    `Missing SHA512 registry integrity: ${key}`
  );
  const resolved = new URL(locked.resolved);
  assert.ok(
    resolved.protocol === "https:" &&
      resolved.hostname === "registry.npmjs.org" &&
      !resolved.username &&
      !resolved.password,
    `Non-public-registry lock artifact: ${key}`
  );
  const item = { root, dir, manifest };
  packages.set(dir, item);
  const modulesDir = path.join(dir, "node_modules");
  if (exists(modulesDir)) {
    for (const child of modulePackages(modulesDir))
      inspectPackage(root, child.dir, child.name, sourcePrefix, lock, packages);
  }
}

function resolveContainedDependency(item, name, expectedName, sourceModules, packages, required) {
  let current = item.dir;
  const candidates = [];
  while (current !== sourceModules) {
    assert.ok(
      isInside(sourceModules, current),
      "Dependency resolution escaped source node_modules"
    );
    if (path.basename(current) !== "node_modules")
      candidates.push(path.join(current, "node_modules", name));
    current = path.dirname(current);
  }
  candidates.push(path.join(sourceModules, name));
  const found = candidates.find((dir) => exists(path.join(dir, "package.json")));
  if (!found) {
    assert.ok(
      !required,
      `Missing required dependency inside ${item.root.name}: ${item.manifest.name} -> ${name}`
    );
    return;
  }
  const real = fs.realpathSync(found);
  assert.ok(
    isInside(item.root.sourceDir, real),
    `Dependency escapes its complete CLI root: ${item.manifest.name} -> ${name}`
  );
  const target = packages.get(real);
  assert.ok(target, `Dependency is not an inspected locked package: ${found}`);
  assert.equal(target.manifest.name, expectedName, `Dependency alias/name mismatch: ${name}`);
}

function inspectDependencies(item, sourceModules, packages) {
  const { manifest } = item;
  const dependencies = dependencyMap(manifest.dependencies, `${manifest.name} dependencies`);
  const optional = dependencyMap(
    manifest.optionalDependencies,
    `${manifest.name} optionalDependencies`
  );
  const peers = dependencyMap(manifest.peerDependencies, `${manifest.name} peerDependencies`);
  const peerMeta = dependencyMap(
    manifest.peerDependenciesMeta,
    `${manifest.name} peerDependenciesMeta`
  );
  for (const [name, spec] of Object.entries({ ...dependencies, ...optional })) {
    resolveContainedDependency(
      item,
      name,
      dependencyName(name, spec),
      sourceModules,
      packages,
      !Object.hasOwn(optional, name)
    );
  }
  for (const [name, spec] of Object.entries(peers)) {
    const metadata = dependencyMap(peerMeta[name], `${manifest.name} peer ${name}`);
    assert.ok(
      metadata.optional === undefined || typeof metadata.optional === "boolean",
      `Invalid optional peer metadata: ${manifest.name} -> ${name}`
    );
    resolveContainedDependency(
      item,
      name,
      dependencyName(name, spec),
      sourceModules,
      packages,
      metadata.optional !== true
    );
  }
}

function inspectTargetDirectory(prefix, dir) {
  assert.ok(isInside(prefix, dir), `Target escapes prefix: ${dir}`);
  let current = prefix;
  for (const part of path.relative(prefix, dir).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (exists(current)) regularDirectory(current);
  }
}

/** Filesystem-only preflight: all metadata, closure and target checks precede any write. */
export function inspectCliTree({
  sourcePrefix = DEFAULT_SOURCE_PREFIX,
  targetPrefix = DEFAULT_TARGET_PREFIX,
} = {}) {
  sourcePrefix = fs.realpathSync(path.resolve(sourcePrefix));
  targetPrefix = fs.realpathSync(path.resolve(targetPrefix));
  regularDirectory(sourcePrefix);
  regularDirectory(targetPrefix);
  assert.ok(
    !isInside(sourcePrefix, targetPrefix) && !isInside(targetPrefix, sourcePrefix),
    "Source and target prefixes must be disjoint"
  );
  const sourceManifest = readJson(path.join(sourcePrefix, "package.json"));
  exactRoots(sourceManifest.dependencies, "Source manifest");
  for (const field of ["devDependencies", "optionalDependencies", "peerDependencies"]) {
    assert.equal(Object.keys(sourceManifest[field] ?? {}).length, 0, `Unexpected source ${field}`);
  }
  const lock = readJson(path.join(sourcePrefix, "package-lock.json"), 64 * 1024 * 1024);
  assert.equal(lock.lockfileVersion, 3, "A committed npm lockfile v3 is required");
  assert.ok(lock.packages && typeof lock.packages === "object", "Missing lock packages");
  exactRoots(lock.packages[""]?.dependencies, "Lock root");
  for (const key of Object.keys(lock.packages)) {
    if (key)
      assert.ok(
        Object.hasOwn(EXPECTED_DEPENDENCIES, lockRoot(key)),
        `Unexpected external lock root: ${key}`
      );
  }

  const sourceModules = path.join(sourcePrefix, "node_modules");
  const top = modulePackages(sourceModules);
  assert.deepEqual(
    top.map(({ name }) => name).sort(),
    CLI_ROOTS.map(({ name }) => name).sort(),
    "Installed tree must contain exactly four top-level CLI roots; do not drop hoisted dependencies"
  );
  const globalRoot = path.join(targetPrefix, "lib", "node_modules");
  const binRoot = path.join(targetPrefix, "bin");
  const packages = new Map();
  const budget = { entries: 0 };
  const roots = CLI_ROOTS.map((spec) => ({
    ...spec,
    sourceDir: path.join(sourceModules, spec.name),
    targetDir: path.join(globalRoot, spec.name),
    binPath: path.join(binRoot, spec.bin),
  }));
  for (const root of roots) {
    inspectFiles(root.sourceDir, budget);
    inspectPackage(root, root.sourceDir, root.name, sourcePrefix, lock, packages);
    const manifest = packages.get(root.sourceDir).manifest;
    assert.equal(manifest.version, root.version, `Unaudited CLI version: ${root.name}`);
    assert.deepEqual(
      manifest.bin,
      { [root.bin]: root.entry },
      `Unexpected CLI bin metadata: ${root.name}`
    );
    const entry = path.join(root.sourceDir, root.entry);
    assert.ok(
      isInside(root.sourceDir, fs.realpathSync(entry)),
      `CLI bin escapes package: ${root.name}`
    );
    const stat = fs.statSync(entry);
    assert.ok(
      stat.isFile() && stat.size > 0 && (stat.mode & 0o005) === 0o005,
      `CLI bin must remain readable/executable for USER node: ${root.name}`
    );
  }
  for (const item of packages.values()) inspectDependencies(item, sourceModules, packages);
  const sourceBins = path.join(sourceModules, ".bin");
  if (exists(sourceBins)) {
    for (const bin of fs.readdirSync(sourceBins)) {
      const root = roots.find((entry) => entry.bin === bin);
      assert.ok(root, `Unexpected source root bin: ${bin}`);
      const file = path.join(sourceBins, bin);
      assert.ok(fs.lstatSync(file).isSymbolicLink(), `Expected npm root bin symlink: ${bin}`);
      assert.equal(
        fs.realpathSync(file),
        fs.realpathSync(path.join(root.sourceDir, root.entry)),
        `Wrong source bin target: ${bin}`
      );
    }
  }
  inspectTargetDirectory(targetPrefix, globalRoot);
  inspectTargetDirectory(targetPrefix, binRoot);
  for (const root of roots) {
    inspectTargetDirectory(targetPrefix, path.dirname(root.targetDir));
    assert.ok(!exists(root.targetDir), `Refusing to replace an existing global CLI: ${root.name}`);
    assert.ok(!exists(root.binPath), `Refusing to replace an existing global bin: ${root.bin}`);
  }
  return {
    sourcePrefix,
    targetPrefix,
    globalRoot,
    binRoot,
    roots,
    packageCount: packages.size,
    inspectedEntries: budget.entries,
  };
}

export function installCliTree(options = {}) {
  const plan = inspectCliTree(options); // Invalid input must not create even a target directory.
  fs.mkdirSync(plan.globalRoot, { recursive: true });
  fs.mkdirSync(plan.binRoot, { recursive: true });
  const staging = fs.mkdtempSync(path.join(plan.globalRoot, ".omniroute-cli-tree-"));
  const installedRoots = [];
  const installedBins = [];
  try {
    for (const root of plan.roots) {
      const staged = path.join(staging, root.name);
      fs.mkdirSync(path.dirname(staged), { recursive: true });
      fs.cpSync(root.sourceDir, staged, {
        recursive: true,
        dereference: false,
        verbatimSymlinks: true,
        errorOnExist: true,
        force: false,
      });
    }
    for (const root of plan.roots) {
      assert.ok(!exists(root.targetDir), `Global CLI appeared during copy: ${root.name}`);
      fs.mkdirSync(path.dirname(root.targetDir), { recursive: true });
      fs.renameSync(path.join(staging, root.name), root.targetDir);
      installedRoots.push(root.targetDir);
    }
    for (const root of plan.roots) {
      fs.symlinkSync(
        path.relative(plan.binRoot, path.join(root.targetDir, root.entry)),
        root.binPath
      );
      installedBins.push(root.binPath);
    }
  } catch (error) {
    for (const bin of installedBins.reverse()) fs.rmSync(bin, { force: true });
    for (const dir of installedRoots.reverse()) fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return plan;
}

export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help") {
      options.help = true;
      continue;
    }
    const key =
      flag === "--source-prefix"
        ? "sourcePrefix"
        : flag === "--target-prefix"
          ? "targetPrefix"
          : null;
    assert.ok(
      key && argv[index + 1] && !argv[index + 1].startsWith("--"),
      `Unknown or incomplete argument: ${flag}`
    );
    assert.ok(!options[key], `Duplicate argument: ${flag}`);
    options[key] = path.resolve(argv[++index]);
  }
  return options;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(
      "install-docker-cli-tree.mjs [--source-prefix DIR] [--target-prefix DIR] (after nested npm ci --ignore-scripts)"
    );
    return;
  }
  assert.equal(process.platform, "linux", "Docker CLI tree materialization requires Linux");
  assert.equal(process.getuid?.(), 0, "Materialize the Docker CLI tree as root before USER node");
  const plan = installCliTree(options);
  console.log(
    `Materialized four complete locked CLI roots (${plan.packageCount} installed packages); no package code executed`
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(`Docker CLI tree rejected: ${error.message}`);
    process.exitCode = 1;
  }
}
