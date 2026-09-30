#!/usr/bin/env node
/**
 * Install an already materialized, integrity-checked Docker npm tools tree.
 * This file uses only filesystem operations. It never invokes npm, lifecycle
 * scripts, a downloader, or package code. Docker must smoke-test npm/npx next.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_FILE_SYSTEM = fs;

export const DEFAULT_NPM_TREE_SOURCE = "/tmp/docker-npm-tree/node_modules";
export const DEFAULT_NPM_GLOBAL_PREFIX = "/usr/local";
export const EXPECTED_DOCKER_NPM_PACKAGES = Object.freeze({
  npm: "12.1.0",
  "brace-expansion": "5.0.9",
  "ip-address": "10.5.0",
  tar: "7.5.22",
  // npm's node-gyp requires the 6.x API. Do not substitute undici 8.x.
  undici: "6.28.0",
});
const OVERLAYS = Object.keys(EXPECTED_DOCKER_NPM_PACKAGES).filter((name) => name !== "npm");
const BIN_FILES = Object.freeze({ npm: "bin/npm-cli.js", npx: "bin/npx-cli.js" });
const INSTALL_METADATA = new Set([".bin", ".package-lock.json"]);

function fail(message) {
  throw new Error(`Docker npm tree: ${message}`);
}

function exists(filename) {
  try {
    fs.lstatSync(filename);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function inside(root, filename) {
  const relative = path.relative(root, filename);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

function directory(filename) {
  if (!exists(filename) || !fs.lstatSync(filename).isDirectory()) {
    fail(`required physical directory is missing or is a symlink: ${filename}`);
  }
}

function regularFile(filename) {
  if (!exists(filename) || !fs.lstatSync(filename).isFile()) {
    fail(`required regular file is missing or is a symlink: ${filename}`);
  }
}

function manifest(packageDirectory) {
  const filename = path.join(packageDirectory, "package.json");
  regularFile(filename);
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch {
    fail(`invalid JSON manifest: ${filename}`);
  }
  if (
    !value ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    typeof value.name !== "string" ||
    typeof value.version !== "string"
  ) {
    fail(`invalid package name/version manifest: ${filename}`);
  }
  return value;
}

function exactPackage(packageDirectory, name, version) {
  directory(packageDirectory);
  const value = manifest(packageDirectory);
  if (value.name !== name || value.version !== version) {
    fail(`expected ${name}@${version}, found ${value.name}@${value.version}`);
  }
  return value;
}

/** Relative links must survive relocation and remain within their own root. */
function containedTree(root) {
  directory(root);
  const pending = [root];
  while (pending.length) {
    const filename = pending.pop();
    const stat = fs.lstatSync(filename);
    if (stat.isSymbolicLink()) {
      const link = fs.readlinkSync(filename);
      if (path.isAbsolute(link) || !inside(root, path.resolve(path.dirname(filename), link))) {
        fail(`non-relocatable or escaping symlink: ${filename}`);
      }
      let resolved;
      try {
        resolved = fs.realpathSync(filename);
      } catch {
        fail(`dangling or cyclic symlink: ${filename}`);
      }
      if (!inside(root, resolved)) fail(`escaping symlink: ${filename}`);
    } else if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(filename)) pending.push(path.join(filename, entry));
    } else if (!stat.isFile()) {
      fail(`unsupported filesystem entry: ${filename}`);
    }
  }
}

function installMetadata(modules) {
  const bin = path.join(modules, ".bin");
  const lock = path.join(modules, ".package-lock.json");
  if (exists(bin)) directory(bin);
  if (exists(lock)) regularFile(lock);
}

function dependencyNames(value, field, packageDirectory) {
  const group = value[field];
  if (group === undefined) return [];
  if (!group || typeof group !== "object" || Array.isArray(group)) {
    fail(`invalid ${field}: ${packageDirectory}`);
  }
  for (const [name, range] of Object.entries(group)) {
    if (
      !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) ||
      name === "." ||
      name === ".." ||
      typeof range !== "string"
    ) {
      fail(`invalid dependency in ${field}: ${packageDirectory}`);
    }
  }
  return Object.keys(group);
}

function resolveContainedDependency(packageDirectory, name, root) {
  let cursor = packageDirectory;
  while (inside(root, cursor)) {
    if (path.basename(cursor) !== "node_modules") {
      const candidate = path.join(cursor, "node_modules", name);
      if (exists(candidate)) {
        const resolved = fs.realpathSync(candidate);
        if (!inside(root, resolved) || !fs.statSync(resolved).isDirectory()) {
          fail(`dependency escapes its package root: ${name} from ${packageDirectory}`);
        }
        manifest(resolved);
        return resolved;
      }
    }
    if (cursor === root) break;
    cursor = path.dirname(cursor);
  }
  return null;
}

/** Validate runtime dependencies, including required peers, without importing them. */
function closedPackage(root) {
  containedTree(root);
  const pending = [root];
  const seen = new Set();
  while (pending.length) {
    const packageDirectory = fs.realpathSync(pending.pop());
    if (seen.has(packageDirectory)) continue;
    seen.add(packageDirectory);
    const value = manifest(packageDirectory);
    const optional = new Set(dependencyNames(value, "optionalDependencies", packageDirectory));
    const required = dependencyNames(value, "dependencies", packageDirectory).filter(
      (name) => !optional.has(name)
    );
    for (const name of dependencyNames(value, "peerDependencies", packageDirectory)) {
      if (value.peerDependenciesMeta?.[name]?.optional !== true) required.push(name);
    }
    for (const name of new Set(required)) {
      if (!resolveContainedDependency(packageDirectory, name, root)) {
        fail(`missing contained dependency ${name} required by ${value.name}`);
      }
    }
    const modules = path.join(packageDirectory, "node_modules");
    if (!exists(modules)) continue;
    directory(modules);
    installMetadata(modules);
    for (const entry of fs.readdirSync(modules)) {
      if (INSTALL_METADATA.has(entry)) continue;
      const child = path.join(modules, entry);
      if (entry.startsWith("@")) {
        directory(child);
        for (const scoped of fs.readdirSync(child)) pending.push(path.join(child, scoped));
      } else {
        pending.push(child);
      }
    }
  }
}

function npmLayout(npmDirectory, patched) {
  const value = exactPackage(npmDirectory, "npm", EXPECTED_DOCKER_NPM_PACKAGES.npm);
  directory(path.join(npmDirectory, "node_modules"));
  regularFile(path.join(npmDirectory, "lib", "cli.js"));
  for (const [name, relative] of Object.entries(BIN_FILES)) {
    if (value.bin?.[name] !== relative) fail(`unexpected npm ${name} bin manifest layout`);
    const filename = path.join(npmDirectory, relative);
    regularFile(filename);
    if ((fs.statSync(filename).mode & 0o111) === 0)
      fail(`npm ${name} entrypoint is not executable`);
  }
  for (const name of OVERLAYS) {
    const bundled = path.join(npmDirectory, "node_modules", name);
    directory(bundled); // Preserve the old overlay's fail-closed test -d guard.
    const bundledManifest = manifest(bundled);
    if (bundledManifest.name !== name) fail(`unexpected bundled overlay target: ${name}`);
    if (patched && bundledManifest.version !== EXPECTED_DOCKER_NPM_PACKAGES[name]) {
      fail(`patched version mismatch for ${name}`);
    }
  }
}

function checkedAbsoluteDirectory(filename, label) {
  if (typeof filename !== "string" || !path.isAbsolute(filename)) fail(`${label} must be absolute`);
  directory(filename);
  return fs.realpathSync(filename);
}

/**
 * Fixture injection changes only filesystem roots. The direct CLI has fixed
 * Docker defaults, and intentionally accepts no flags or environment overrides.
 */
export function installDockerNpmTree({
  sourceNodeModules = DEFAULT_NPM_TREE_SOURCE,
  globalPrefix = DEFAULT_NPM_GLOBAL_PREFIX,
  fileSystem = DEFAULT_FILE_SYSTEM,
} = {}) {
  // Trusted fixture seam for filesystem failures; the direct CLI cannot set it.
  const fs = fileSystem;
  const source = checkedAbsoluteDirectory(sourceNodeModules, "sourceNodeModules");
  const prefix = checkedAbsoluteDirectory(globalPrefix, "globalPrefix");
  const modules = path.join(prefix, "lib", "node_modules");
  const destination = path.join(modules, "npm");
  if (inside(source, prefix) || inside(prefix, source))
    fail("source and global prefix must be disjoint");

  // All source/layout/link guards run before any filesystem write.
  const allowed = new Set([...Object.keys(EXPECTED_DOCKER_NPM_PACKAGES), ...INSTALL_METADATA]);
  for (const entry of fs.readdirSync(source)) {
    if (!allowed.has(entry)) fail(`unexpected top-level root: ${entry}`);
  }
  installMetadata(source);
  containedTree(source);
  for (const [name, version] of Object.entries(EXPECTED_DOCKER_NPM_PACKAGES)) {
    exactPackage(path.join(source, name), name, version);
  }
  npmLayout(path.join(source, "npm"), false);
  for (const name of Object.keys(EXPECTED_DOCKER_NPM_PACKAGES)) {
    closedPackage(path.join(source, name));
  }
  for (const filename of [path.join(prefix, "lib"), modules, destination, path.join(prefix, "bin")])
    directory(filename);
  for (const [name, relative] of Object.entries(BIN_FILES)) {
    const bin = path.join(prefix, "bin", name);
    if (
      !exists(bin) ||
      !fs.lstatSync(bin).isSymbolicLink() ||
      path.resolve(path.dirname(bin), fs.readlinkSync(bin)) !== path.join(destination, relative)
    ) {
      fail(`expected standard global ${name} symlink: ${bin}`);
    }
    regularFile(path.join(destination, relative));
  }

  const staging = fs.mkdtempSync(path.join(modules, ".docker-npm-tree-"));
  const stagedNpm = path.join(staging, "npm");
  const previousNpm = path.join(staging, "previous-npm");
  const copy = {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    errorOnExist: true,
    force: false,
  };
  let backupReady = false;
  let destinationTouched = false;
  let installed = false;
  let restored = false;
  try {
    fs.cpSync(path.join(source, "npm"), stagedNpm, copy);
    for (const name of OVERLAYS) {
      const target = path.join(stagedNpm, "node_modules", name);
      directory(target);
      fs.rmSync(target, { recursive: true });
      fs.cpSync(path.join(source, name), target, copy);
    }
    npmLayout(stagedNpm, true);
    closedPackage(stagedNpm);
    try {
      fs.renameSync(destination, previousNpm);
      backupReady = true;
      destinationTouched = true;
    } catch (error) {
      if (error.code !== "EXDEV") throw error;
      // OverlayFS cannot rename a lower-layer directory. Finish a same-layer
      // backup before deleting any original bytes; never fallback on other errors.
      fs.cpSync(destination, previousNpm, copy);
      backupReady = true;
      destinationTouched = true; // rm may throw after deleting only some files.
      fs.rmSync(destination, { recursive: true });
    }
    fs.renameSync(stagedNpm, destination);
    installed = true;
  } catch (error) {
    if (backupReady && destinationTouched && !installed) {
      try {
        // A failed removal or injected partial rename can leave a partial tree.
        // Do not merge the backup into it: restore the complete previous npm.
        if (exists(destination)) fs.rmSync(destination, { recursive: true });
        fs.renameSync(previousNpm, destination);
        restored = true;
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          `Docker npm tree: install and rollback failed; previous npm backup retained at ${previousNpm}`
        );
      }
    }
    throw error;
  } finally {
    // A failed restore must leave the complete backup available for recovery.
    if (!backupReady || installed || restored) {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }
  return {
    npmDirectory: destination,
    globalPrefix: prefix,
    versions: { ...EXPECTED_DOCKER_NPM_PACKAGES },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) fail("direct CLI accepts no arguments; Docker paths are fixed");
    console.log(JSON.stringify(installDockerNpmTree()));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
