import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  assembleStandalone,
  syncStandaloneExtraModules,
} from "../../../scripts/build/assembleStandalone.mjs";
import * as standaloneBuild from "../../../scripts/build/assembleStandalone.mjs";
import {
  APP_STAGING_ALLOWED_EXACT_PATHS,
  APP_STAGING_ALLOWED_PATH_PREFIXES,
  PACK_ARTIFACT_ALLOWED_EXACT_PATHS,
  PACK_ARTIFACT_ALLOWED_PATH_PREFIXES,
  PACK_ARTIFACT_REQUIRED_PATHS,
  findMissingArtifactPaths,
  findUnexpectedArtifactPaths,
} from "../../../scripts/build/pack-artifact-policy.ts";

// Raw JS with a built-in import: assembly must copy bytes, not bundle or transpile it.
// This fixture never reads the real activation path or starts an application.
const POLICY_SOURCE = Buffer.from(
  'import { createHash } from "node:crypto";\n' +
    'export const fixtureDigest = createHash("sha256").update("fixture").digest("hex");\n'
);
const silent = { log() {} };

function fixture(t, { source = true } = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "policy-artifact-"));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const distDir = path.join(projectRoot, ".next");
  const outDir = path.join(projectRoot, "out");
  const sourcePath = path.join(projectRoot, "scripts", "build", "runtime-policy.mjs");
  const artifactPath = path.join(outDir, "build", "runtime-policy.mjs");
  fs.mkdirSync(path.join(distDir, "standalone"), { recursive: true });
  fs.writeFileSync(path.join(distDir, "standalone", "server.js"), "// synthetic only\n");
  if (source) {
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, POLICY_SOURCE);
  }
  return { projectRoot, distDir, outDir, sourcePath, artifactPath };
}

function assertRawArtifact(artifactPath) {
  assert.ok(fs.lstatSync(artifactPath).isFile(), "artifact is a regular raw module");
  assert.deepEqual(fs.readFileSync(artifactPath), POLICY_SOURCE);
}

for (const copyNatives of [true, false]) {
  test(`sync assembly requires and copies policy bytes (copyNatives=${copyNatives})`, (t) => {
    const f = fixture(t);
    assembleStandalone({ ...f, copyNatives });
    assertRawArtifact(f.artifactPath);
  });

  test(`sync assembly rejects a missing source (copyNatives=${copyNatives})`, (t) => {
    const f = fixture(t, { source: false });
    // A stale artifact is not a substitute for the required source.
    fs.mkdirSync(path.dirname(f.artifactPath), { recursive: true });
    fs.writeFileSync(f.artifactPath, POLICY_SOURCE);
    assert.throws(
      () => assembleStandalone({ ...f, copyNatives }),
      /required.*runtime-policy.*source/i
    );
  });
}

test("async sidecar sync requires and copies identical policy bytes", async (t) => {
  const f = fixture(t);
  assert.equal(
    await syncStandaloneExtraModules(f.projectRoot, fs.promises, silent, f.outDir),
    true
  );
  assertRawArtifact(f.artifactPath);
});

test("async sidecar sync rejects a missing policy source despite a stale artifact", async (t) => {
  const f = fixture(t, { source: false });
  fs.mkdirSync(path.dirname(f.artifactPath), { recursive: true });
  fs.writeFileSync(f.artifactPath, POLICY_SOURCE);
  await assert.rejects(
    () => syncStandaloneExtraModules(f.projectRoot, fs.promises, silent, f.outDir),
    /required.*runtime-policy.*source/i
  );
});

for (const copyMode of ["sync", "async"]) {
  for (const badCopy of ["missing", "changed"]) {
    test(`${copyMode} assembly rejects a ${badCopy} policy artifact after copy`, async (t) => {
      const f = fixture(t);
      const interceptCopy = (source, destination, options, copy) => {
        if (destination !== f.artifactPath) return copy(source, destination, options);
        if (badCopy === "changed") fs.writeFileSync(destination, "// corrupt copy\n");
      };
      if (copyMode === "sync") {
        const cpSync = fs.cpSync;
        t.mock.method(fs, "cpSync", (source, destination, options) =>
          interceptCopy(source, destination, options, cpSync)
        );
        assert.throws(() => assembleStandalone(f), /required.*runtime-policy.*artifact/i);
      } else {
        const fsImpl = {
          ...fs.promises,
          cp: (source, destination, options) =>
            interceptCopy(source, destination, options, fs.promises.cp),
        };
        await assert.rejects(
          () => syncStandaloneExtraModules(f.projectRoot, fsImpl, silent, f.outDir),
          /required.*runtime-policy.*artifact/i
        );
      }
    });
  }

  test(`${copyMode} assembly rejects a directory in place of the required source`, async (t) => {
    const f = fixture(t, { source: false });
    fs.mkdirSync(f.sourcePath, { recursive: true });
    if (copyMode === "sync") {
      assert.throws(() => assembleStandalone(f), /required.*runtime-policy.*source/i);
    } else {
      await assert.rejects(
        () => syncStandaloneExtraModules(f.projectRoot, fs.promises, silent, f.outDir),
        /required.*runtime-policy.*source/i
      );
    }
  });

  test(`${copyMode} assembly replaces a stale policy artifact`, async (t) => {
    const f = fixture(t);
    fs.mkdirSync(path.dirname(f.artifactPath), { recursive: true });
    fs.writeFileSync(f.artifactPath, "// previous revision\n");
    if (copyMode === "sync") assembleStandalone(f);
    else await syncStandaloneExtraModules(f.projectRoot, fs.promises, silent, f.outDir);
    assertRawArtifact(f.artifactPath);
  });
}

test("in-place assembly still copies the required raw policy module", (t) => {
  const f = fixture(t);
  const outDir = path.join(f.distDir, "standalone");
  assembleStandalone({ ...f, outDir, copyNatives: false });
  assertRawArtifact(path.join(outDir, "build", "runtime-policy.mjs"));
});

test("canonical policy ships byte-identically and imports in plain Node without a TS loader", async (t) => {
  const f = fixture(t);
  const canonicalBytes = fs.readFileSync(
    new URL("../../../scripts/build/runtime-policy.mjs", import.meta.url)
  );
  fs.writeFileSync(f.sourcePath, canonicalBytes);
  assembleStandalone({ ...f, copyNatives: false });
  assert.deepEqual(fs.readFileSync(f.artifactPath), canonicalBytes);
  const lstatSync = fs.lstatSync;
  t.mock.method(fs, "lstatSync", (target, ...args) => {
    assert.ok(!String(target).startsWith("/run/omni-runtime-policy"), "no real activation I/O");
    return lstatSync(target, ...args);
  });
  const artifact = await import(pathToFileURL(f.artifactPath).href);
  assert.equal(typeof artifact.getRuntimePolicy, "function");
  assert.equal(typeof artifact.requireLockedBootstrap, "function");
  // Only the pure parser runs; the fixed production reader is not invoked.
  const policy = artifact.parseLockedPolicy({
    schema: 1,
    profile: "omni-app-residential-direct-v1",
    providers: [],
    helpers: [],
  });
  assert.ok(Object.isFrozen(policy));
  assert.deepEqual(policy.providers, []);
});

for (const copyMode of ["sync", "async"]) {
  test(`${copyMode} assembly rejects an empty required source`, async (t) => {
    const f = fixture(t);
    fs.writeFileSync(f.sourcePath, "");
    if (copyMode === "sync") {
      assert.throws(() => assembleStandalone(f), /required.*runtime-policy.*source/i);
    } else {
      await assert.rejects(
        () => syncStandaloneExtraModules(f.projectRoot, fs.promises, silent, f.outDir),
        /required.*runtime-policy.*source/i
      );
    }
  });

  test(`${copyMode} assembly replaces a stale artifact directory`, async (t) => {
    const f = fixture(t);
    fs.mkdirSync(f.artifactPath, { recursive: true });
    fs.writeFileSync(path.join(f.artifactPath, "stale.txt"), "not a raw module");
    if (copyMode === "sync") assembleStandalone(f);
    else await syncStandaloneExtraModules(f.projectRoot, fs.promises, silent, f.outDir);
    assertRawArtifact(f.artifactPath);
  });

  test(
    `${copyMode} assembly materializes an artifact symlink even when it resolves to source`,
    { skip: process.platform === "win32" },
    async (t) => {
      const f = fixture(t);
      fs.mkdirSync(path.dirname(f.artifactPath), { recursive: true });
      fs.symlinkSync(f.sourcePath, f.artifactPath);
      if (copyMode === "sync") assembleStandalone(f);
      else await syncStandaloneExtraModules(f.projectRoot, fs.promises, silent, f.outDir);
      assertRawArtifact(f.artifactPath);
      assert.deepEqual(fs.readFileSync(f.sourcePath), POLICY_SOURCE, "source remains intact");
    }
  );
}

test("required policy packaging retains canonical bytes through staging prune", (t) => {
  const f = fixture(t);
  const canonicalBytes = fs.readFileSync(
    new URL("../../../scripts/build/runtime-policy.mjs", import.meta.url)
  );
  fs.writeFileSync(f.sourcePath, canonicalBytes);
  assembleStandalone({ ...f, copyNatives: false });
  const unrelatedPath = path.join(f.outDir, "build", "unreviewed-loader.mjs");
  fs.writeFileSync(unrelatedPath, "// not a reviewed packaging asset\n");
  const pruned = findUnexpectedArtifactPaths(
    ["server.js", "build/runtime-policy.mjs", "build/unreviewed-loader.mjs"],
    {
      exactPaths: APP_STAGING_ALLOWED_EXACT_PATHS,
      prefixPaths: APP_STAGING_ALLOWED_PATH_PREFIXES,
      neverAllowedSegments: [],
    }
  );
  for (const relativePath of pruned) fs.rmSync(path.join(f.outDir, relativePath));
  assert.deepEqual(pruned, ["build/unreviewed-loader.mjs"], "no broad build/ allowlist");
  assert.deepEqual(fs.readFileSync(f.artifactPath), canonicalBytes);
  assert.doesNotThrow(() =>
    standaloneBuild.assertRequiredStandaloneModules(f.projectRoot, f.outDir)
  );
  fs.writeFileSync(f.artifactPath, "// modified after prune\n");
  assert.throws(
    () => standaloneBuild.assertRequiredStandaloneModules(f.projectRoot, f.outDir),
    /required.*runtime-policy.*artifact differs/i
  );
  fs.rmSync(f.artifactPath);
  assert.throws(
    () => standaloneBuild.assertRequiredStandaloneModules(f.projectRoot, f.outDir),
    /required.*runtime-policy.*artifact.*missing/i
  );
});

test("required policy packaging allows and requires the exact source and built module paths", () => {
  const paths = [
    "scripts/build/runtime-policy.mjs",
    "scripts/build/runtime-policy.d.mts",
    "dist/build/runtime-policy.mjs",
  ];
  assert.deepEqual(
    findUnexpectedArtifactPaths(paths, {
      exactPaths: PACK_ARTIFACT_ALLOWED_EXACT_PATHS,
      prefixPaths: PACK_ARTIFACT_ALLOWED_PATH_PREFIXES,
    }),
    []
  );
  for (const policyPath of paths) {
    assert.ok(PACK_ARTIFACT_REQUIRED_PATHS.includes(policyPath), `${policyPath} is mandatory`);
    assert.deepEqual(
      findMissingArtifactPaths(
        PACK_ARTIFACT_REQUIRED_PATHS.filter((candidate) => candidate !== policyPath),
        PACK_ARTIFACT_REQUIRED_PATHS
      ),
      [policyPath]
    );
  }
  assert.deepEqual(
    findUnexpectedArtifactPaths(["dist/build/unreviewed-loader.mjs"], {
      exactPaths: PACK_ARTIFACT_ALLOWED_EXACT_PATHS,
      prefixPaths: PACK_ARTIFACT_ALLOWED_PATH_PREFIXES,
    }),
    ["dist/build/unreviewed-loader.mjs"]
  );
});

test("required policy packaging includes the canonical module in npm files", () => {
  const pkg = JSON.parse(
    fs.readFileSync(new URL("../../../package.json", import.meta.url), "utf8")
  );
  assert.ok(pkg.files.includes("scripts/build/runtime-policy.mjs"));
  assert.ok(pkg.files.includes("scripts/build/runtime-policy.d.mts"));
});

// The copied build entry runs only in a temp project. Next spawn, sentinel spawn,
// backend stubbing, native builds, and assembly are mocked. The required-module
// verifier is the real assembler export. No real build or app can start here.
function runBuildBoundaryFixture(
  t,
  {
    source = true,
    artifact = "canonical",
    assemblyError = false,
    standalone = true,
    pruneAfterAssembly = false,
    contributor = false,
  } = {}
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "policy-build-boundary-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const buildDir = path.join(dir, "scripts", "build");
  fs.mkdirSync(buildDir, { recursive: true });
  fs.mkdirSync(path.join(dir, "docs"));
  fs.mkdirSync(path.join(dir, "tmp"));
  const canonical = new URL("../../../scripts/build/runtime-policy.mjs", import.meta.url);
  fs.copyFileSync(canonical, path.join(dir, "fixture-canonical.mjs"));
  if (source) fs.copyFileSync(canonical, path.join(buildDir, "runtime-policy.mjs"));
  fs.copyFileSync(
    new URL("../../../scripts/build/build-next-isolated.mjs", import.meta.url),
    path.join(buildDir, "build-next-isolated.mjs")
  );
  const assemblerUrl = new URL("../../../scripts/build/assembleStandalone.mjs", import.meta.url)
    .href;
  fs.writeFileSync(
    path.join(buildDir, "assembleStandalone.mjs"),
    `export * from ${JSON.stringify(assemblerUrl)};\n` +
      'import fs from "node:fs";\nimport path from "node:path";\n' +
      "export function assembleStandalone({ outDir, projectRoot }) {\n" +
      '  const target = path.join(outDir, "build", "runtime-policy.mjs");\n' +
      "  fs.mkdirSync(path.dirname(target), { recursive: true });\n" +
      (artifact === "canonical"
        ? '  fs.copyFileSync(path.join(projectRoot, "fixture-canonical.mjs"), target);\n'
        : artifact === "changed"
          ? '  fs.writeFileSync(target, "// changed mandatory module\\n");\n'
          : "") +
      (assemblyError ? '  throw new Error("fixture optional assembly failure");\n' : "") +
      "}\n"
  );
  fs.writeFileSync(
    path.join(buildDir, "backendOnlyPages.mjs"),
    "export function isBackendOnlyBuild() { return false; }\n" +
      `export function isContributorBuild() { return ${contributor}; }\n` +
      "export function stubContributorInstrumentation() { return []; }\n" +
      "export function stubDashboardPages() { return []; }\n" +
      "export function restoreDashboardPages() {}\n"
  );
  fs.writeFileSync(
    path.join(buildDir, "build-tproxy-native.mjs"),
    'export function buildTproxyNative() { return { built: false, reason: "fixture only" }; }\n'
  );
  const probePath = path.join(dir, "probe.mjs");
  fs.writeFileSync(
    probePath,
    'import cp from "node:child_process";\nimport fs from "node:fs";\n' +
      'import path from "node:path";\nimport { EventEmitter } from "node:events";\n' +
      'import { syncBuiltinESMExports } from "node:module";\n' +
      "cp.spawn = () => {\n" +
      "  const child = new EventEmitter(); child.kill = () => true;\n" +
      "  queueMicrotask(() => {\n" +
      (standalone
        ? '    fs.mkdirSync(path.join(process.cwd(), ".next", "standalone"), { recursive: true });\n'
        : "") +
      '    child.emit("exit", 0, null);\n' +
      "  }); return child;\n};\n" +
      "cp.spawnSync = () => {\n" +
      (pruneAfterAssembly
        ? '  fs.rmSync(path.join(process.cwd(), ".next", "standalone", "build", "runtime-policy.mjs"));\n'
        : "") +
      "  return { status: 0 };\n};\n" +
      "syncBuiltinESMExports();\n" +
      'const { main } = await import("./scripts/build/build-next-isolated.mjs");\n' +
      "await main();\n"
  );
  const result = spawnSync(process.execPath, [probePath], {
    cwd: dir,
    env: {
      PATH: path.dirname(process.execPath),
      HOME: dir,
      TMPDIR: path.join(dir, "tmp"),
      NEXT_DIST_DIR: ".next",
    },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.ifError(result.error);
  return result;
}

for (const [label, options] of [
  ["missing source despite a stale artifact", { source: false }],
  ["missing artifact after an assembly error", { artifact: "missing", assemblyError: true }],
  ["changed artifact after assembly", { artifact: "changed" }],
  ["absent standalone directory", { standalone: false }],
  ["artifact pruned after assembly", { pruneAfterAssembly: true }],
]) {
  test(`required policy build boundary fails on ${label}`, (t) => {
    const result = runBuildBoundaryFixture(t, options);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /Build failed:/);
    assert.match(result.stderr, /Required runtime-policy module (source|artifact)/);
  });
}

test("required policy build boundary preserves nonfatal optional assembly errors with intact bytes", (t) => {
  const result = runBuildBoundaryFixture(t, { assemblyError: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Non-fatal error assembling standalone/);
  assert.doesNotMatch(result.stderr, /Build failed:/);
});

test("required policy build boundary accepts intact canonical bytes", (t) => {
  const result = runBuildBoundaryFixture(t);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
});

test("required policy build boundary leaves contributor compile-only behavior unchanged", (t) => {
  const result = runBuildBoundaryFixture(t, {
    contributor: true,
    source: false,
    standalone: false,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /skipped standalone packaging \(compile-only validation\)/);
  assert.equal(result.stderr, "");
});

// Execute only the real post-copy staging-prune section, not prepublish's build,
// package managers, helpers, or its development-residue cleanup. Both input and
// output are synthetic temp trees containing copied canonical source bytes.
function runPrepublishPruneFixture(t, mutation) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "policy-post-prune-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sourcePath = path.join(dir, "scripts", "build", "runtime-policy.mjs");
  const distDir = path.join(dir, "dist");
  const artifactPath = path.join(distDir, "build", "runtime-policy.mjs");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.copyFileSync(
    new URL("../../../scripts/build/runtime-policy.mjs", import.meta.url),
    sourcePath
  );
  fs.copyFileSync(sourcePath, artifactPath);
  fs.writeFileSync(path.join(distDir, "build", "unreviewed-loader.mjs"), "// must be pruned\n");

  const prepublish = fs.readFileSync(
    new URL("../../../scripts/build/prepublish.ts", import.meta.url),
    "utf8"
  );
  const start = prepublish.indexOf("const stagedFiles = walkFiles(DIST_DIR);");
  const end = prepublish.indexOf("// -- Step 11:", start);
  assert.ok(start >= 0 && end > start, "isolate only the actual staging-prune section");
  const assemblerImport = prepublish.match(
    /import\s*\{[^}]+\}\s*from "\.\/assembleStandalone\.mjs";/
  )?.[0];
  assert.ok(assemblerImport, "use the actual prepublish assembler/verifier import");
  const assemblerUrl = new URL("../../../scripts/build/assembleStandalone.mjs", import.meta.url)
    .href;
  const policyUrl = new URL("../../../scripts/build/pack-artifact-policy.ts", import.meta.url).href;
  const fixturePath = path.join(dir, "prune-fixture.mts");
  fs.writeFileSync(
    fixturePath,
    'import fs, { rmSync } from "node:fs";\n' +
      'import { join, relative } from "node:path";\n' +
      assemblerImport.replace('"./assembleStandalone.mjs"', JSON.stringify(assemblerUrl)) +
      "\n" +
      "import { APP_STAGING_ALLOWED_EXACT_PATHS, APP_STAGING_ALLOWED_PATH_PREFIXES, " +
      `findUnexpectedArtifactPaths } from ${JSON.stringify(policyUrl)};\n` +
      'const ROOT = process.cwd(); const DIST_DIR = join(ROOT, "dist");\n' +
      "function walkFiles(root, dir = root) {\n" +
      "  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {\n" +
      "    const target = join(dir, entry.name);\n" +
      '    return entry.isDirectory() ? walkFiles(root, target) : [relative(root, target).replaceAll("\\\\", "/")];\n' +
      "  });\n}\n" +
      "function removeEmptyDirectories() {\n" +
      (mutation === "missing"
        ? '  rmSync(join(DIST_DIR, "build", "runtime-policy.mjs"));\n'
        : mutation === "changed"
          ? '  fs.writeFileSync(join(DIST_DIR, "build", "runtime-policy.mjs"), "// changed during prune\\n");\n'
          : "") +
      "}\n" +
      prepublish.slice(start, end) +
      '\nconsole.log("fixture-prune-finished");\n'
  );
  const result = spawnSync(process.execPath, [fixturePath], {
    cwd: dir,
    env: { PATH: path.dirname(process.execPath), HOME: dir },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(fs.existsSync(path.join(distDir, "build", "unreviewed-loader.mjs")), false);
  return result;
}

for (const mutation of ["missing", "changed"]) {
  test(`required policy prepublish post-prune boundary rejects ${mutation} module bytes`, (t) => {
    const result = runPrepublishPruneFixture(t, mutation);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /Required runtime-policy module artifact/);
    assert.doesNotMatch(result.stdout, /fixture-prune-finished/);
  });
}

test("required policy prepublish post-prune boundary accepts canonical module bytes", (t) => {
  const result = runPrepublishPruneFixture(t, "intact");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /fixture-prune-finished/);
  assert.equal(result.stderr, "");
});
