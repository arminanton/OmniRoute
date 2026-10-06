#!/usr/bin/env node
/** Exact, audited Docker package setup only. Run with Docker RUN --network=none.
 * Never invoke npm/npx/rebuild, Koffi/tree-sitter hooks, or Droid's downloader.
 */
import assert from "node:assert/strict";
import path from "node:path";
import {
  AUDITED_SOURCE_HASHES,
  assertAuditedSources,
  assertReady,
  assertRuntime,
  auditedSourcePaths,
  cleanEnvironment,
  inspectInstall,
  isMain,
  parseArgs,
  runBounded,
  withTemporaryHome,
} from "./verify-docker-clis.mjs";

export const SETUP_TIMEOUT_MS = 30_000;
export const AUDITED_SETUP = Object.freeze([
  Object.freeze({
    name: "@anthropic-ai/claude-code",
    version: "2.1.289",
    lifecycle: "postinstall",
    entry: "install.cjs",
    sourceKey: "claudeInstall",
    script: "node install.cjs",
  }),
  Object.freeze({
    name: "openclaw",
    version: "2026.9.1",
    lifecycle: "preinstall",
    entry: "scripts/preinstall-package-manager-warning.mjs",
    sourceKey: "openclawPreinstall",
    script: "node scripts/preinstall-package-manager-warning.mjs",
  }),
  Object.freeze({
    name: "openclaw",
    version: "2026.9.1",
    lifecycle: "postinstall",
    entry: "scripts/postinstall-bundled-plugins.mjs",
    sourceKey: "openclawPostinstall",
    script: "node scripts/postinstall-bundled-plugins.mjs",
  }),
]);

export function setupPlan(layout, nodePath = process.execPath) {
  const sourcePaths = auditedSourcePaths(layout);
  return AUDITED_SETUP.map((step) => {
    const pkg = layout.roots[step.name];
    assert.equal(pkg.manifest.version, step.version, `Unaudited setup version: ${step.name}`);
    assert.equal(
      pkg.manifest.scripts?.[step.lifecycle],
      step.script,
      `Unaudited setup hook: ${step.name}`
    );
    const entry = path.join(pkg.dir, step.entry);
    assert.equal(entry, sourcePaths[step.sourceKey]);
    return {
      label: `${step.name}@${step.version} ${step.lifecycle}`,
      command: nodePath,
      args: [entry],
      cwd: pkg.dir,
      sha256: AUDITED_SOURCE_HASHES[step.sourceKey],
    };
  });
}

/** Test seams cannot be selected from the command line. No package code runs on import. */
export async function setupInstalledClis(
  options = {},
  {
    inspect = inspectInstall,
    run = runBounded,
    sources = assertAuditedSources,
    ready = assertReady,
    temporaryHome = withTemporaryHome,
  } = {}
) {
  const layout = inspect(options); // Require all optional binaries BEFORE allowing even reviewed setup.
  sources(layout); // Pin all three entrypoints and their local helper imports; retain audited Droid shim.
  const plan = setupPlan(layout);
  await temporaryHome(async (home) => {
    const env = cleanEnvironment(home, layout.binRoot);
    for (const step of plan) {
      await run(step.command, step.args, {
        env,
        cwd: step.cwd,
        label: step.label,
        timeoutMs: SETUP_TIMEOUT_MS,
      });
    }
  });
  ready(layout);
  sources(layout); // No installer may replace Droid's runtime AVX2-aware JS shim.
  return layout;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(
      "setup-docker-clis.mjs [--global-root DIR] [--bin-root DIR] (Docker --network=none, root)"
    );
    return;
  }
  assertRuntime();
  assert.equal(process.getuid?.(), 0, "Docker CLI setup must run as root before USER node");
  await setupInstalledClis(options);
  console.log("Docker CLI reviewed setup complete; run non-root offline verification next");
}

if (isMain(import.meta.url)) {
  main().catch((error) => {
    console.error(`Docker CLI setup failed: ${error.message}`);
    process.exitCode = 1;
  });
}
