import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  AUDITED_SETUP,
  setupInstalledClis,
  setupPlan,
} from "../../scripts/build/setup-docker-clis.mjs";
import {
  AUDITED_SOURCE_HASHES,
  CLI_VERSIONS,
  MAX_OUTPUT_BYTES,
  assertContained,
  assertElf,
  assertGlobalNpmPackages,
  assertGlobalNpmRoot,
  assertPackageVersion,
  assertReady,
  assertRuntime,
  assertVersionOutput,
  cleanEnvironment,
  nativeRequirements,
  parseArgs,
  runBounded,
  verificationPlan,
  verifyInstalledClis,
} from "../../scripts/build/verify-docker-clis.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const docker = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
const instructions = docker
  .replace(/\\\r?\n[ \t]*/g, " ")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));
const cliStart = instructions.findIndex((line) => /^FROM runner-base AS runner-cli$/.test(line));
const nextStage = instructions.findIndex((line, index) => index > cliStart && /^FROM /.test(line));
const cli = instructions.slice(cliStart, nextStage < 0 ? undefined : nextStage);
const expected = {
  "@openai/codex": "0.160.0",
  "@anthropic-ai/claude-code": "2.1.289",
  droid: "0.212.0",
  openclaw: "2026.9.1",
};

function layout() {
  const roots = Object.fromEntries(
    Object.entries(expected).map(([name, version]) => [
      name,
      {
        dir: path.join("/fixture/global", name),
        manifest: { name, version, scripts: {} },
      },
    ])
  );
  roots["@anthropic-ai/claude-code"].manifest.scripts = { postinstall: "node install.cjs" };
  roots.openclaw.manifest.scripts = {
    preinstall: "node scripts/preinstall-package-manager-warning.mjs",
    postinstall: "node scripts/postinstall-bundled-plugins.mjs",
  };
  return {
    globalRoot: "/fixture/global",
    binRoot: "/fixture/bin",
    arch: "arm64",
    roots,
    binaries: Object.fromEntries(
      ["codex", "claude", "droid", "openclaw"].map((name) => [name, `/fixture/bin/${name}`])
    ),
    native: [
      {
        name: "fixture",
        dir: "/fixture/global/native",
        file: "/fixture/global/native/native.node",
      },
    ],
    claudeBinary: "/fixture/global/claude-native/claude",
  };
}

function globalNpmListing(versions: Record<string, string> = expected) {
  return JSON.stringify({
    dependencies: {
      npm: { version: "12.1.0" },
      "inherited-global-tool": { version: "1.0.0" },
      ...Object.fromEntries(Object.entries(versions).map(([name, version]) => [name, { version }])),
    },
  });
}

function successfulProbeOutput(step) {
  if (step.npmRoot) return step.npmRoot + "\n";
  if (step.npmPackages) return globalNpmListing();
  return step.version ?? step.helpName ?? step.expected;
}

function temp(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "docker-cli-fixture-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeElf(file, arch = "arm64") {
  const header = Buffer.alloc(20);
  header.write("\x7fELF", 0, "binary");
  header[4] = 2;
  header[5] = 1;
  header.writeUInt16LE(arch === "arm64" ? 183 : 62, 18);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, header, { mode: 0o755 });
}

test("CLI layer materializes locked nested roots before exact offline setup and UID1000 readiness", () => {
  assert.ok(cliStart >= 0);
  const dependencyStart = instructions.findIndex((line) =>
    /^FROM base AS cli-dependencies$/.test(line)
  );
  assert.ok(dependencyStart >= 0, "CLI fetching must be independent of the application builder");
  const dependencyEnd = instructions.findIndex(
    (line, index) => index > dependencyStart && /^FROM /.test(line)
  );
  const dependencies = instructions.slice(
    dependencyStart,
    dependencyEnd < 0 ? undefined : dependencyEnd
  );
  const manifestCopy = dependencies.indexOf(
    "COPY docker/cli/package.json docker/cli/package-lock.json /tmp/docker-cli-tree/"
  );
  const installs = dependencies.flatMap((line, index) =>
    /^RUN\b.*\bnpm ci\b/.test(line) ? [index] : []
  );
  assert.equal(installs.length, 1, "one private locked CLI install is required");
  const install = installs[0];
  assert.ok(manifestCopy >= 0 && manifestCopy < install);
  const installArgs = dependencies[install].split(/\s+/);
  assert.match(dependencies[install], /\bnpm ci --prefix \/tmp\/docker-cli-tree\b/);
  for (const flag of [
    "--install-strategy=nested",
    "--include=optional",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--fetch-retries=2",
    "--fetch-retry-mintimeout=2000",
    "--fetch-retry-maxtimeout=30000",
    "--fetch-timeout=60000",
  ])
    assert.ok(installArgs.includes(flag), `locked CLI npm ci must retain ${flag}`);
  assert.doesNotMatch(
    dependencies[install],
    /--omit=optional|--ignore-scripts=false|--allow-scripts|--force|\|\|/
  );
  const copy = cli.indexOf(
    "COPY --chmod=444 scripts/build/install-docker-cli-tree.mjs scripts/build/setup-docker-clis.mjs scripts/build/verify-docker-clis.mjs /opt/omniroute-docker-build/"
  );
  const setup = cli.findIndex(
    (line) => /^RUN --network=none\b/.test(line) && line.includes("/setup-docker-clis.mjs")
  );
  const user = cli.lastIndexOf("USER node");
  const verify = cli.indexOf(
    "RUN --network=none node /opt/omniroute-docker-build/verify-docker-clis.mjs"
  );
  assert.ok(copy >= 0 && copy < setup && setup < user && user < verify);
  assert.ok(
    !cli.some((line) => /\bnpm (?:ci|install)\b|\bnpx\b/.test(line)),
    "the final CLI stage must not reinstall or recover packages"
  );
  assert.ok(
    !cli.some((line) => /^COPY\b.*(?:docker\/cli|from=cli-dependencies)/.test(line)),
    "do not store both the temporary and materialized CLI trees in final image layers"
  );
  const mountMatch = /(?:^|\s)--mount=([^\s]+)/.exec(cli[setup]);
  assert.ok(mountMatch, "offline materialization must bind the completed CLI dependency stage");
  const mount = new Map<string, string>(
    mountMatch[1].split(",").map((field): [string, string] => {
      const separator = field.indexOf("=");
      return separator < 0 ? [field, ""] : [field.slice(0, separator), field.slice(separator + 1)];
    })
  );
  assert.equal(mount.get("type"), "bind");
  assert.equal(mount.get("from"), "cli-dependencies");
  assert.equal(mount.get("source"), "/tmp/docker-cli-tree");
  assert.equal(mount.get("target"), "/tmp/docker-cli-tree");
  assert.ok(
    !mount.has("rw") && !mount.has("readwrite"),
    "BuildKit bind must retain its read-only default"
  );
  for (const flag of ["readonly", "ro"]) {
    assert.ok(
      !mount.has(flag) || ["", "true"].includes(mount.get(flag) ?? ""),
      "read-only bind flags cannot be disabled"
    );
  }
  const setupBody = cli[setup].replace(/^RUN\s+(?:--\S+\s+)+/, "");
  assert.deepEqual(
    setupBody.split(/\s*&&\s*/).map((command) => command.replace(/\s+/g, " ").trim()),
    [
      "chmod 755 /opt/omniroute-docker-build",
      "node /opt/omniroute-docker-build/install-docker-cli-tree.mjs",
      "node /opt/omniroute-docker-build/setup-docker-clis.mjs",
    ],
    "make only the helper directory searchable, preserve 0444 files, and materialize before audited setup"
  );
  assert.equal(cli.filter((line) => /^USER /.test(line)).at(-1), "USER node");
  assert.ok(cli.slice(0, setup).includes("USER root"));
  assert.doesNotMatch(cli[setup] + cli[verify], /\|\||--network=host|\bnpm\b|\bnpx\b/);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "docker/cli/package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(root, "docker/cli/package-lock.json"), "utf8"));
  assert.equal(manifest.private, true);
  assert.equal(manifest.packageManager, "npm@12.1.0");
  assert.deepEqual(manifest.dependencies, expected);
  assert.equal(lock.lockfileVersion, 3);
  assert.deepEqual(lock.packages[""].dependencies, expected);
  for (const [name, version] of Object.entries(expected)) {
    const entry = lock.packages[`node_modules/${name}`];
    assert.equal(entry?.version, version, `${name} must retain its exact locked version`);
    assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\//);
    assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
  }
  assert.deepEqual(CLI_VERSIONS, expected);
});

test("only the three reviewed exact-version lifecycle entrypoints are permitted", () => {
  const plan = setupPlan(layout(), "/fixed/node");
  assert.deepEqual(
    AUDITED_SETUP.map(({ name, version, lifecycle, entry }) => ({
      name,
      version,
      lifecycle,
      entry,
    })),
    [
      {
        name: "@anthropic-ai/claude-code",
        version: "2.1.289",
        lifecycle: "postinstall",
        entry: "install.cjs",
      },
      {
        name: "openclaw",
        version: "2026.9.1",
        lifecycle: "preinstall",
        entry: "scripts/preinstall-package-manager-warning.mjs",
      },
      {
        name: "openclaw",
        version: "2026.9.1",
        lifecycle: "postinstall",
        entry: "scripts/postinstall-bundled-plugins.mjs",
      },
    ]
  );
  for (const step of plan) {
    assert.equal(step.command, "/fixed/node");
    assert.equal(step.args.length, 1);
    assert.match(step.sha256, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(step.args[0], /droid|koffi|tree-sitter|node-gyp|npm|npx/);
  }
  assert.equal(Object.keys(AUDITED_SOURCE_HASHES).length, 8);
  const changed = layout();
  changed.roots.openclaw.manifest.scripts.postinstall = "node arbitrary.mjs";
  assert.throws(() => setupPlan(changed), /Unaudited setup hook/);
  const changedVersion = layout();
  changedVersion.roots.openclaw.manifest.version = "2026.9.2";
  assert.throws(() => setupPlan(changedVersion), /Unaudited setup version/);
});

test("setup validates all artifacts and source hashes before executing an audited hook", async () => {
  const order = [];
  const calls = [];
  const install = layout();
  await setupInstalledClis(
    {},
    {
      inspect: () => {
        order.push("inspect");
        return install;
      },
      sources: () => {
        order.push("sources");
      },
      ready: () => {
        order.push("ready");
      },
      temporaryHome: async (callback) => callback("/fixture/home"),
      run: async (command, args, options) => {
        order.push("run");
        calls.push({ command, args, options });
      },
    }
  );
  assert.deepEqual(order, ["inspect", "sources", "run", "run", "run", "ready", "sources"]);
  for (const { options } of calls) {
    assert.equal(options.timeoutMs, 30_000);
    assert.equal(options.env.HOME, "/fixture/home");
    assert.ok(options.cwd.startsWith("/fixture/global/"));
    assert.equal(options.env.NODE_OPTIONS, undefined);
  }
  let ran = false;
  await assert.rejects(
    setupInstalledClis(
      {},
      {
        inspect: () => install,
        sources: () => {
          throw new Error("Unaudited source");
        },
        run: async () => {
          ran = true;
        },
      }
    ),
    /Unaudited source/
  );
  assert.equal(ran, false);
});

test("readiness rejects pending OpenClaw setup before invoking any CLI", async () => {
  let ran = false;
  await assert.rejects(
    verifyInstalledClis(
      {},
      {
        inspect: () => layout(),
        sources: () => {},
        ready: () => {
          throw new Error("OpenClaw setup incomplete");
        },
        run: async () => {
          ran = true;
        },
      }
    ),
    /OpenClaw setup incomplete/
  );
  assert.equal(ran, false);
});

test("global npm parsers reject wrong roots, malformed JSON, missing CLIs, and wrong versions", () => {
  assert.doesNotThrow(() => assertGlobalNpmRoot("/fixture/global\n", "/fixture/global"));
  for (const output of ["", "/other/root\n", "/fixture/global\nunexpected\n"]) {
    assert.throws(() => assertGlobalNpmRoot(output, "/fixture/global"), /npm root -g/);
  }
  assert.doesNotThrow(
    () => assertGlobalNpmPackages(globalNpmListing()),
    "the four exact CLIs may coexist with npm and inherited global tooling"
  );
  for (const output of ["not JSON", "npm warning\n{}", "null", "[]", "{}", '{"dependencies":[]}']) {
    assert.throws(() => assertGlobalNpmPackages(output), /npm global listing/);
  }
  const missing: Record<string, string> = { ...expected };
  delete missing.droid;
  assert.throws(() => assertGlobalNpmPackages(globalNpmListing(missing)), /missing droid/);
  assert.throws(
    () => assertGlobalNpmPackages(globalNpmListing({ ...expected, droid: "0.212.1" })),
    /unaudited droid version/
  );
  const invalidEntry = JSON.parse(globalNpmListing());
  invalidEntry.dependencies.droid = "0.212.0";
  assert.throws(() => assertGlobalNpmPackages(JSON.stringify(invalidEntry)), /missing droid/);
});

test("readiness fails closed at either npm probe before continuing to native loads", async () => {
  const missing: Record<string, string> = { ...expected };
  delete missing["@openai/codex"];
  const listingLabel = "npm ls --global --depth=0 --json";
  const failures = [
    { label: "npm root -g", output: "/wrong/global\n", error: /npm root -g/ },
    { label: listingLabel, output: "bad JSON", error: /not valid JSON/ },
    { label: listingLabel, output: globalNpmListing(missing), error: /missing @openai\/codex/ },
    {
      label: listingLabel,
      output: globalNpmListing({ ...expected, openclaw: "2026.9.2" }),
      error: /unaudited openclaw version/,
    },
    { label: listingLabel, output: globalNpmListing(), code: 1, error: /must exit successfully/ },
  ];
  for (const failure of failures) {
    const install = layout();
    const plan = verificationPlan(install, "/fixed/node");
    const labels: string[] = [];
    let ready = 0;
    await assert.rejects(
      verifyInstalledClis(
        {},
        {
          inspect: () => install,
          sources: () => {},
          ready: () => {
            ready += 1;
          },
          temporaryHome: async (callback) => callback("/fixture/home"),
          run: async (_command, _args, { label }) => {
            labels.push(label);
            const step = plan.find((entry) => entry.label === label);
            assert.ok(step);
            return label === failure.label
              ? { output: failure.output, code: failure.code ?? 0 }
              : { output: successfulProbeOutput(step), code: 0 };
          },
        }
      ),
      failure.error
    );
    assert.equal(labels.at(-1), failure.label);
    assert.equal(labels.includes("native prebuilt loads"), false);
    assert.equal(ready, 1, "failed npm discovery cannot reach the final readiness assertion");
  }
});

test("version/help, global npm discovery, and native checks are bounded offline without install or login", async () => {
  const install = layout();
  const plan = verificationPlan(install, "/fixed/node");
  assert.equal(plan.length, 11);
  assert.deepEqual(
    plan.slice(0, 8).map((step) => step.args),
    Array.from({ length: 4 }, () => [["--version"], ["--help"]]).flat()
  );
  assert.deepEqual(
    plan.slice(8, 10).map(({ command, args }) => ({ command, args })),
    [
      { command: "/fixture/bin/npm", args: ["root", "-g"] },
      { command: "/fixture/bin/npm", args: ["ls", "--global", "--depth=0", "--json"] },
    ]
  );
  assert.equal(plan[8].npmRoot, install.globalRoot);
  assert.equal(plan[9].npmPackages, true);
  assert.equal(plan.at(-1).label, "native prebuilt loads");
  const calls = [];
  let ready = 0;
  await verifyInstalledClis(
    {},
    {
      inspect: () => install,
      sources: () => {},
      ready: () => {
        ready += 1;
      },
      temporaryHome: async (callback) => callback("/fixture/home"),
      run: async (command, args, options) => {
        calls.push({ command, args, options });
        const step = plan[calls.length - 1];
        return { output: successfulProbeOutput(step), code: 0 };
      },
    }
  );
  assert.equal(calls.length, 11);
  assert.equal(ready, 2);
  for (const { command, args, options } of calls) {
    assert.equal(options.cwd, "/fixture/home");
    assert.equal(options.env.CI, "1");
    assert.equal(options.env.HOME, "/fixture/home");
    assert.doesNotMatch(command, /npx|pip|cargo|cmake/);
    if (command === "/fixture/bin/npm") {
      assert.ok(
        [["root", "-g"].join("\0"), ["ls", "--global", "--depth=0", "--json"].join("\0")].includes(
          args.join("\0")
        ),
        "only the two read-only npm probes are allowed"
      );
    } else assert.doesNotMatch(command, /npm/);
    assert.ok(!args.some((arg) => ["login", "install", "ci", "rebuild", "update"].includes(arg)));
  }
});

test("clean child environment cannot inherit keys, proxies, loaders or private config", () => {
  const env = cleanEnvironment("/fixture/home", "/fixture/bin", "/fixed/node");
  assert.equal(env.HOME, "/fixture/home");
  assert.equal(env.PATH, "/fixed:/fixture/bin:/usr/bin:/bin");
  assert.equal(env.npm_config_userconfig, "/dev/null");
  for (const key of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NODE_OPTIONS",
    "NODE_PATH",
    "LD_PRELOAD",
    "NPM_CONFIG_USERCONFIG",
  ]) {
    assert.equal(Object.hasOwn(env, key), false);
  }
  assert.equal(env.PREBUILDS_ONLY, "1");
  assert.equal(env.LIBC, "glibc");
});

test("versions, runtime targets and path containment fail closed", () => {
  assert.doesNotThrow(() =>
    assertRuntime({
      platform: "linux",
      arch: "arm64",
      nodeVersion: "26.10.0",
      glibcVersion: "2.41",
    })
  );
  assert.throws(
    () =>
      assertRuntime({
        platform: "linux",
        arch: "arm64",
        nodeVersion: "24.21.0",
        glibcVersion: "2.41",
      }),
    /Node 26/
  );
  assert.throws(
    () =>
      assertRuntime({
        platform: "linux",
        arch: "s390x",
        nodeVersion: "26.10.0",
        glibcVersion: "2.41",
      }),
    /architecture/
  );
  assert.throws(
    () =>
      assertRuntime({
        platform: "linux",
        arch: "arm64",
        nodeVersion: "26.10.0",
        glibcVersion: null,
      }),
    /glibc|GNU/
  );
  assertPackageVersion({ name: "droid", version: "0.212.0" }, "droid", "0.212.0");
  assert.throws(
    () => assertPackageVersion({ name: "droid", version: "0.213.0" }, "droid", "0.212.0"),
    /Unaudited/
  );
  assertVersionOutput("codex-cli 0.160.0\n", "0.160.0", "codex");
  for (const output of ["0.160.00", "10.160.0", "0.160.0-dev", "missing"]) {
    assert.throws(() => assertVersionOutput(output, "0.160.0", "codex"));
  }
  assert.equal(assertContained("/fixture/global", "/fixture/global/pkg"), "/fixture/global/pkg");
  assert.throws(() => assertContained("/fixture/global", "/fixture/global-escape/pkg"), /escapes/);
  assert.throws(() => parseArgs(["--skip-native"]), /Unknown/);
  assert.throws(() => parseArgs(["--global-root", "/x", "--global-root", "/y"]), /Duplicate/);
});

test("artifact gates reject wrong architecture and all first-run lifecycle markers", (t) => {
  const directory = temp(t);
  const install = layout();
  install.arch = "arm64";
  install.roots.openclaw.dir = path.join(directory, "openclaw");
  install.roots["@anthropic-ai/claude-code"].dir = path.join(directory, "claude");
  install.claudeBinary = path.join(directory, "native", "claude");
  fs.mkdirSync(install.roots.openclaw.dir);
  const launcher = path.join(install.roots["@anthropic-ai/claude-code"].dir, "bin", "claude.exe");
  writeElf(launcher);
  writeElf(install.claudeBinary);
  assert.doesNotThrow(() => assertReady(install));
  assert.throws(() => assertElf(launcher, "x64"), /Wrong ELF architecture/);
  for (const marker of [
    ".openclaw-lifecycle-pending",
    "dist/openclaw-install-guard",
    ".openclaw-lifecycle-lock",
  ]) {
    const target = path.join(install.roots.openclaw.dir, marker);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "pending");
    assert.throws(() => assertReady(install), /setup incomplete/);
    fs.rmSync(target);
  }
  fs.writeFileSync(launcher, "#!/bin/sh\nexit 1\n");
  assert.throws(() => assertReady(install));
  for (const arch of ["arm64", "x64"]) {
    const required = nativeRequirements(arch);
    assert.ok(required.some((item) => item.name === "koffi" && item.version === "3.1.6"));
    assert.ok(
      required.some((item) => item.name === "tree-sitter-bash" && item.version === "0.25.1")
    );
    assert.ok(required.every((item) => !item.platformName || item.platformName.includes(arch)));
  }
});

function fakeChild() {
  const child = new EventEmitter();
  Object.assign(child, {
    pid: 424242,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
    unref: () => {},
  });
  return child;
}

test("bounded runner uses argv and a new process group, and cleans residual children", async () => {
  const child = fakeChild();
  const kills = [];
  let spawnOptions;
  const result = runBounded("/fixed/node", ["--version"], {
    env: { PATH: "/fixed" },
    cwd: "/fixture",
    label: "fixture",
    timeoutMs: 100,
    killImpl: (pid, signal) => {
      kills.push([pid, signal]);
    },
    spawnImpl: (command, args, options) => {
      assert.equal(command, "/fixed/node");
      assert.deepEqual(args, ["--version"]);
      spawnOptions = options;
      return child;
    },
  });
  child.stdout.write("26.10.0");
  child.emit("close", 0, null);
  assert.equal((await result).output, "26.10.0");
  assert.equal(spawnOptions.shell, false);
  assert.equal(spawnOptions.detached, true);
  assert.deepEqual(kills, [[-424242, "SIGKILL"]]);
});

test("bounded runner rejects timeout, nonzero exit and excess output and kills only its group", async () => {
  for (const failure of ["timeout", "exit", "output"]) {
    const child = fakeChild();
    const kills = [];
    const result = runBounded("/fixed/node", [], {
      env: {},
      cwd: "/fixture",
      label: "fixture",
      timeoutMs: 10,
      maxOutputBytes: 8,
      killImpl: (pid, signal) => {
        kills.push([pid, signal]);
      },
      spawnImpl: () => child,
    });
    if (failure === "exit") child.emit("close", 2, null);
    if (failure === "output") child.stdout.write("too much output");
    await assert.rejects(result, /exceeded|exit 2/);
    assert.deepEqual(kills, [[-424242, "SIGKILL"]]);
  }
  assert.throws(
    () => runBounded("x", [], { env: {}, cwd: "/fixture", maxOutputBytes: MAX_OUTPUT_BYTES + 1 }),
    /output limit/
  );
});

test("combined browser/CLI target retains locked browser installer and non-root final user", () => {
  const start = instructions.findIndex((line) => line === "FROM runner-cli AS runner-browser-cli");
  assert.ok(start > cliStart);
  const browser = instructions.slice(start);
  assert.ok(browser.includes("ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright"));
  assert.ok(
    browser.some((line) =>
      line.includes("node node_modules/playwright/cli.js install chromium --with-deps")
    )
  );
  assert.ok(browser.some((line) => line.includes("xvfb xauth x11vnc novnc websockify")));
  assert.equal(browser.filter((line) => line.startsWith("USER ")).at(-1), "USER node");
  assert.ok(browser.some((line) => line.includes("chown root:root /app")));
});
