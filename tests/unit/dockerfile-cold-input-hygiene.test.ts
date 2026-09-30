/** Cold-input and offline-gate contracts; no Docker invocation or private file reads. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
const dockerignore = fs.readFileSync(path.join(repoRoot, ".dockerignore"), "utf8");
const NODE_IMAGE =
  "node:26.10.0-trixie-slim@sha256:ec7758ee051e457b468b32bde57b0879010b325bb9862718e9615225ce4aaae1";
const POLICY = "scripts/build/runtime-policy.mjs";
const POLICY_SHA256 = "65ef803f048b16df2be39b0057ecd2e757590d23e2ef1cf87bf24b4bb849bd20";

type Instruction = { raw: string; kind: string; stage: string };
let currentStage = "";
const instructions: Instruction[] = dockerfile
  .split(/\r?\n/)
  .filter((line) => !line.trim().startsWith("#"))
  .join("\n")
  .replace(/\\\r?\n\s*/g, " ")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  .map((raw) => {
    const from = /^FROM\s+\S+\s+AS\s+(\S+)$/i.exec(raw);
    if (from) currentStage = from[1];
    return { raw, kind: raw.split(/\s+/)[0].toUpperCase(), stage: currentStage };
  });
const runs = instructions.filter((item) => item.kind === "RUN");
const instructionText = instructions.map((item) => item.raw).join("\n");

function leadingRunOptions(run: string): string[] {
  const options: string[] = [];
  for (const token of run.split(/\s+/).slice(1)) {
    if (!token.startsWith("--")) break;
    options.push(token);
  }
  return options;
}

function offline(run: Instruction) {
  assert.deepEqual(
    leadingRunOptions(run.raw).filter((option) => option.startsWith("--network=")),
    ["--network=none"],
    `${run.stage} must enforce offline execution in the Docker RUN, not just a comment`
  );
}

test("all external stages pin the same Node26.10.0 tag and observed immutable index digest", () => {
  const known = new Set<string>();
  const external: { stage: string; image: string }[] = [];
  const parents: Record<string, string> = {};
  for (const item of instructions.filter((step) => step.kind === "FROM")) {
    const match = /^FROM\s+(\S+)\s+AS\s+(\S+)$/i.exec(item.raw);
    assert.ok(match, `unreviewed FROM form: ${item.raw}`);
    const [, image, stage] = match;
    assert.ok(!known.has(stage), `duplicate Docker stage: ${stage}`);
    if (!known.has(image)) external.push({ stage, image });
    parents[stage] = image;
    known.add(stage);
  }
  assert.deepEqual(external, [
    { stage: "npm-tool-tree", image: NODE_IMAGE },
    { stage: "base", image: NODE_IMAGE },
  ]);
  for (const [stage, parent] of Object.entries({
    "cli-dependencies": "base",
    dependencies: "base",
    builder: "dependencies",
    "runner-base": "base",
    "runner-cli": "runner-base",
  })) {
    assert.equal(parents[stage], parent, `${stage} must preserve the reviewed stage DAG`);
  }
  assert.doesNotMatch(instructionText, /(?:@|:)latest\b/i);
});

test("each of exactly three npm ci sites has bounded fetches, optional packages and no hooks", () => {
  const installs = runs.filter((item) => /\bnpm\s+ci\b/.test(item.raw));
  assert.equal(installs.length, 3, "npm tools, application and CLI closures must each use npm ci");
  assert.deepEqual(installs.map((item) => item.stage).sort(), [
    "cli-dependencies",
    "dependencies",
    "npm-tool-tree",
  ]);
  for (const install of installs) {
    assert.equal([...install.raw.matchAll(/\bnpm\s+ci\b/g)].length, 1);
    const tokens = install.raw.split(/\s+/);
    for (const [flag, value] of Object.entries({
      "fetch-retries": "2",
      "fetch-retry-mintimeout": "2000",
      "fetch-retry-maxtimeout": "30000",
      "fetch-timeout": "60000",
    })) {
      assert.deepEqual(
        tokens.filter((token) => token === `--${flag}` || token.startsWith(`--${flag}=`)),
        [`--${flag}=${value}`],
        `${install.stage}: ${flag} must be explicit and cannot be overridden later`
      );
    }
    assert.deepEqual(
      tokens.filter((token) => token.startsWith("--ignore-scripts")),
      ["--ignore-scripts"]
    );
    assert.ok(
      tokens.includes("--include=optional"),
      `${install.stage} must retain optional platform packages`
    );
    assert.doesNotMatch(install.raw, /--(?:omit|exclude)=(?:[^\s]*,)?optional\b/);
    assert.doesNotMatch(
      install.raw,
      /[;&|#]/,
      "npm ci must remain fatal and flags must not be hidden by shell cleanup or comments"
    );
    if (install.stage === "dependencies") {
      assert.ok(tokens.includes("--legacy-peer-deps"));
      assert.ok(!tokens.includes("--prefix"), "application install must remain rooted at /app");
    } else {
      assert.ok(tokens.includes("--install-strategy=nested"));
      const prefix =
        install.stage === "npm-tool-tree" ? "/tmp/docker-npm-tree" : "/tmp/docker-cli-tree";
      assert.match(install.raw, new RegExp(`--prefix\\s+${prefix}(?:\\s|$)`));
    }
  }
  assert.doesNotMatch(instructionText, /\bnpm\s+(?:install|i|add|update|upgrade|exec|x)\b/);
  for (const match of instructionText.matchAll(/\bnpx\s+([^\s;)"']+)/g)) {
    assert.equal(match[1], "--version", "npx must not resolve or download an unlocked package");
  }
  assert.doesNotMatch(
    instructionText,
    /--(?:allow-scripts|allow-remote)(?:=|\s)|NPM_CONFIG_(?:ALLOW_SCRIPTS|ALLOW_REMOTE)|NPM_CONFIG_IGNORE_SCRIPTS\s*=\s*(?:false|0)/i
  );
});

test("application compile and every npm/native/CLI materialization or readiness gate is offline", () => {
  for (const filename of [
    "install-docker-npm-tree.mjs",
    "verify-docker-native-deps.mjs",
    "install-docker-cli-tree.mjs",
    "setup-docker-clis.mjs",
    "verify-docker-clis.mjs",
  ]) {
    const matching = runs.filter((item) => item.raw.includes(filename));
    assert.ok(matching.length > 0, `missing required Docker gate ${filename}`);
    for (const run of matching) offline(run);
  }
  const application = runs.filter((item) => /\bnpm\s+run\s+build\b/.test(item.raw));
  assert.equal(application.length, 1);
  assert.equal(application[0].stage, "builder");
  offline(application[0]);
  assert.match(application[0].raw, /verify-docker-native-deps\.mjs\b/);
  assert.ok(
    application[0].raw.includes("--require-tproxy"),
    "the offline build must retain and verify TPROXY"
  );
  assert.ok(application[0].raw.includes("--standalone-root=/app/.build/next/standalone"));
  assert.doesNotMatch(application[0].raw, /\|\|\s*(?:true\b|:(?:\s|$)|echo\b)/);
  const runtimeSqlite = runs.filter(
    (item) => item.stage === "runner-base" && /require\(['"]better-sqlite3['"]\)/.test(item.raw)
  );
  assert.equal(runtimeSqlite.length, 1, "keep the final runner SQLite load/query smoke");
  offline(runtimeSqlite[0]);
});

test("temporary npm and CLI trees enter release stages only through readonly bind mounts", () => {
  for (const { stage, producer, tree, script } of [
    {
      stage: "base",
      producer: "npm-tool-tree",
      tree: "/tmp/docker-npm-tree",
      script: "install-docker-npm-tree.mjs",
    },
    {
      stage: "runner-cli",
      producer: "cli-dependencies",
      tree: "/tmp/docker-cli-tree",
      script: "install-docker-cli-tree.mjs",
    },
  ]) {
    const matching = runs.filter((item) => item.stage === stage && item.raw.includes(script));
    assert.equal(matching.length, 1);
    offline(matching[0]);
    const mounts = leadingRunOptions(matching[0].raw)
      .filter((option) => option.startsWith("--mount="))
      .map((option) => option.slice("--mount=".length).split(","));
    const candidates = mounts.filter((fields) => fields.includes(`from=${producer}`));
    assert.equal(candidates.length, 1);
    const fields = candidates[0];
    assert.equal(
      new Set(fields.map((field) => field.split("=", 1)[0])).size,
      fields.length,
      "mount fields must not override one another"
    );
    for (const expected of ["type=bind", `from=${producer}`, `source=${tree}`, `target=${tree}`]) {
      assert.ok(fields.includes(expected), `missing readonly tree mount field: ${expected}`);
    }
    // BuildKit bind mounts default to readonly. Explicit readonly=true is also safe.
    assert.ok(
      !fields.some((field) => /^(?:rw|readwrite)(?:=|$)|^(?:ro|readonly)=(?:false|0)$/.test(field))
    );
    for (const copy of instructions.filter((item) => item.kind === "COPY" || item.kind === "ADD")) {
      assert.ok(
        !copy.raw.includes(`--from=${producer}`),
        `do not persist the temporary ${producer} tree through COPY`
      );
      if (copy.raw.includes(tree))
        assert.equal(
          copy.stage,
          producer,
          "temporary-tree COPY belongs only to its producer stage"
        );
    }
    assert.doesNotMatch(
      matching[0].raw,
      new RegExp(`rm\\s+[^;]*${tree}`),
      "the mounted input must not be removed or mutated"
    );
  }
});

test("all three installs receive their locks, and app ci receives both workspace manifests first", () => {
  const inputs: Record<string, string[][]> = {
    "npm-tool-tree": [["docker/npm-tools/package.json", "docker/npm-tools/package-lock.json"]],
    "cli-dependencies": [["docker/cli/package.json", "docker/cli/package-lock.json"]],
    dependencies: [
      ["package.json", "package-lock.json"],
      ["open-sse/package.json"],
      ["packages/browser-pool/package.json"],
    ],
  };
  for (const [stage, groups] of Object.entries(inputs)) {
    const steps = instructions.filter((item) => item.stage === stage);
    const installIndex = steps.findIndex(
      (item) => item.kind === "RUN" && /\bnpm\s+ci\b/.test(item.raw)
    );
    assert.ok(installIndex >= 0);
    const priorCopies = steps.slice(0, installIndex).filter((item) => item.kind === "COPY");
    for (const group of groups) {
      assert.ok(
        priorCopies.some((item) =>
          group.every((source) => item.raw.split(/\s+/).slice(1, -1).includes(source))
        ),
        `${stage} lacks locked input COPY: ${group.join(", ")}`
      );
    }
  }
  const baseUpgrade = runs.find(
    (item) => item.stage === "base" && /apt-get\s+upgrade\s+-y/.test(item.raw)
  );
  assert.ok(baseUpgrade, "keep live apt security upgrades; pinning Node does not replace them");
  assert.match(baseUpgrade.raw, /apt-get\s+update\s*&&\s*apt-get\s+upgrade\s+-y/);
});

type IgnoreRule = { pattern: string; include: boolean };
function parseIgnore(text: string): IgnoreRule[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && line !== "." && !line.startsWith("#"))
    .map((line) => ({
      include: line.startsWith("!"),
      pattern: line.replace(/^!/, "").replace(/^\/+|\/+$/g, ""),
    }));
}
const ignoreRules = parseIgnore(dockerignore);

// Docker patterns are root-relative (unlike gitignore's bare basename rule).
// Match reviewed *, ?, ** patterns with memoized walks, including parent dirs.
function segmentMatches(pattern: string, value: string): boolean {
  const memo = new Map<string, boolean>();
  function match(pi: number, vi: number): boolean {
    const key = `${pi}:${vi}`;
    if (memo.has(key)) return memo.get(key)!;
    let result: boolean;
    if (pi === pattern.length) result = vi === value.length;
    else if (pattern[pi] === "*")
      result = match(pi + 1, vi) || (vi < value.length && match(pi, vi + 1));
    else
      result =
        vi < value.length &&
        (pattern[pi] === "?" || pattern[pi] === value[vi]) &&
        match(pi + 1, vi + 1);
    memo.set(key, result);
    return result;
  }
  return match(0, 0);
}

function patternMatches(pattern: string, filename: string): boolean {
  const parts = pattern.split("/");
  const names = filename.split("/");
  const memo = new Map<string, boolean>();
  function match(pi: number, ni: number): boolean {
    const key = `${pi}:${ni}`;
    if (memo.has(key)) return memo.get(key)!;
    let result: boolean;
    if (pi === parts.length) result = ni === names.length;
    else if (parts[pi] === "**")
      result = match(pi + 1, ni) || (ni < names.length && match(pi, ni + 1));
    else
      result = ni < names.length && segmentMatches(parts[pi], names[ni]) && match(pi + 1, ni + 1);
    memo.set(key, result);
    return result;
  }
  return match(0, 0);
}

function isIgnored(filename: string, rules = ignoreRules): boolean {
  const parts = filename.split("/");
  const candidates = parts.map((_, index) => parts.slice(0, index + 1).join("/"));
  let ignored = false;
  for (const rule of rules) {
    if (candidates.some((candidate) => patternMatches(rule.pattern, candidate)))
      ignored = !rule.include;
  }
  return ignored;
}

const REVIEWED_ENV_EXAMPLES = [
  ".env.example",
  ".env.devin-bridge.example",
  ".env.homolog.example",
  "contrib/vps/.env.example",
];

test("context matcher keeps rule order, root anchoring, recursive patterns and parent exclusions", () => {
  for (const rule of ignoreRules) {
    assert.doesNotMatch(
      rule.pattern,
      /[\\\[\]{}]/,
      "new Docker pattern syntax needs a reviewed matcher update"
    );
  }
  assert.equal(isIgnored("scripts/build/runtime-policy.mjs", parseIgnore("build\n")), false);
  assert.equal(isIgnored("build/runtime-policy.mjs", parseIgnore("build\n")), true);
  assert.equal(isIgnored("a/b/node_modules/pkg/index.js", parseIgnore("**/node_modules\n")), true);
  assert.equal(
    isIgnored(".env.example", parseIgnore(".env.*\n!.env.example\n.env.example\n")),
    true
  );
  assert.equal(isIgnored("x/.env", parseIgnore("**/.env\n")), true);
});

test("private env files at every depth are excluded, with only four exact reviewed exceptions", () => {
  const exclusions = ignoreRules.filter((rule) => !rule.include).map((rule) => rule.pattern);
  for (const pattern of [".env", ".env.*", "**/.env", "**/.env.*"])
    assert.ok(exclusions.includes(pattern));
  const envExceptions = ignoreRules
    .filter((rule) => rule.include && rule.pattern.includes(".env"))
    .map((rule) => rule.pattern);
  assert.deepEqual(envExceptions.sort(), [...REVIEWED_ENV_EXAMPLES].sort());
  const reviewed = new Set(REVIEWED_ENV_EXAMPLES);
  for (const prefix of ["", "nested/", "a/b/", "packages/browser-pool/", "contrib/vps/"]) {
    for (const basename of [
      ".env",
      ".envrc",
      ".envrc.local",
      "secrets.env",
      "deployment.env.production",
      ".env.local",
      ".env.production",
      ".env.calibration",
      ".env.example",
      ".env.devin-bridge.example",
      ".env.homolog.example",
      ".env.new.example",
      ".env.example.secret",
    ]) {
      const filename = prefix + basename;
      assert.equal(
        isIgnored(filename),
        !reviewed.has(filename),
        `unexpected env inclusion: ${filename}`
      );
    }
  }
  for (const filename of REVIEWED_ENV_EXAMPLES) {
    assert.equal(isIgnored(filename), false);
    assert.ok(
      fs.existsSync(path.join(repoRoot, filename)),
      `reviewed example disappeared: ${filename}`
    );
  }
});

test("context retains npmrc, workspaces, locks, raw policy, safety source and English docs/assets", () => {
  const required = [
    ".npmrc",
    "package.json",
    "package-lock.json",
    "open-sse/package.json",
    "packages/browser-pool/package.json",
    "docker/npm-tools/package.json",
    "docker/npm-tools/package-lock.json",
    "docker/cli/package.json",
    "docker/cli/package-lock.json",
    POLICY,
    "scripts/build/install-docker-npm-tree.mjs",
    "scripts/build/install-docker-cli-tree.mjs",
    "scripts/build/verify-docker-native-deps.mjs",
    "scripts/build/build-tproxy-native.mjs",
    "scripts/build/setup-docker-clis.mjs",
    "scripts/build/verify-docker-clis.mjs",
    "scripts/build/assembleStandalone.mjs",
    "src/shared/runtimePolicy.ts",
    "open-sse/utils/proxyFetch.ts",
    "src/shared/network/outboundUrlGuardPolicy.ts",
    "docs/README.md",
    "docs/providers/CLAUDE_WEB.md",
    "docs/routing/AUTO-COMBO.md",
    "docs/guides/SETUP_GUIDE.md",
    "docs/guides/TROUBLESHOOTING.md",
    "docs/reference/API_REFERENCE.md",
    "docs/reference/PROVIDER_REFERENCE.md",
    "docs/reference/ENVIRONMENT.md",
    "docs/diagrams/exported/request-pipeline.svg",
    "docs/diagrams/exported/resilience-3layers.svg",
    "docs/diagrams/exported/authz-pipeline.svg",
    "docs/diagrams/exported/db-schema-overview.svg",
    "docs/screenshots/01-providers.png",
    "docs/screenshots/05-translator.png",
    "public/favicon.ico",
    "public/sw.js",
    "public/openapi.yaml",
  ];
  for (const filename of required) {
    assert.ok(
      fs.existsSync(path.join(repoRoot, filename)),
      `required build input missing: ${filename}`
    );
    assert.equal(isIgnored(filename), false, `required build input excluded: ${filename}`);
  }
  // Read only the reviewed public source policy, never npmrc or env contents.
  assert.equal(
    createHash("sha256")
      .update(fs.readFileSync(path.join(repoRoot, POLICY)))
      .digest("hex"),
    POLICY_SHA256
  );
  for (const filename of [
    "node_modules/example/index.js",
    "packages/browser-pool/node_modules/example/index.js",
    "docker/npm-tools/node_modules/npm/package.json",
    "docker/cli/node_modules/openclaw/package.json",
  ])
    assert.equal(
      isIgnored(filename),
      true,
      `host-materialized dependencies must not leak into context: ${filename}`
    );
});
