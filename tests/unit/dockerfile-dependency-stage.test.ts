/** Stage and input contracts only; real offline native proof is a Docker gate. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const source = fs.readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
const lines = source
  .split(/\r?\n/)
  .filter((line) => !line.trim().startsWith("#"))
  .join("\n")
  .replace(/\\\r?\n\s*/g, " ")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);
function stage(name: string) {
  const start = lines.findIndex((line) => new RegExp(`^FROM \\S+ AS ${name}$`, "i").test(line));
  assert.ok(start >= 0, `missing ${name}`);
  const end = lines.findIndex((line, index) => index > start && /^FROM /i.test(line));
  return lines.slice(start, end < 0 ? undefined : end);
}

test("dependencies target stages both workspaces and the unchanged committed lock before npm ci", () => {
  const deps = stage("dependencies");
  assert.equal(deps[0], "FROM base AS dependencies");
  const ci = deps.findIndex((line) => /^RUN .*npm ci\b/.test(line));
  assert.ok(ci > 0);
  for (const copy of [
    "COPY package.json package-lock.json ./",
    "COPY open-sse/package.json ./open-sse/package.json",
    "COPY packages/browser-pool/package.json ./packages/browser-pool/package.json",
    "COPY scripts/build/build-tproxy-native.mjs ./scripts/build/build-tproxy-native.mjs",
    "COPY scripts/build/verify-docker-native-deps.mjs ./scripts/build/verify-docker-native-deps.mjs",
  ])
    assert.ok(deps.indexOf(copy) >= 0 && deps.indexOf(copy) < ci, copy);
  assert.ok(deps.slice(0, ci).some((line) => /^RUN test -f package-lock\.json/.test(line)));
  for (const flag of [
    "--ignore-scripts",
    "--include=optional",
    "--legacy-peer-deps",
    "--no-audit",
    "--no-fund",
  ])
    assert.ok(deps[ci].includes(flag));
  assert.doesNotMatch(deps.join("\n"), /npm install|npm rebuild|npx|COPY \.|python3|make g\+\+/);
});

test("offline prebuilt and matching-header gate runs before any compiler stage", () => {
  const deps = stage("dependencies");
  const gate = deps.at(-1);
  assert.equal(
    gate,
    "RUN --network=none node scripts/build/verify-docker-native-deps.mjs --project-root=/app --node-root=/usr/local"
  );
  const builder = stage("builder");
  assert.equal(builder[0], "FROM dependencies AS builder");
  assert.ok(builder.includes("ENV OMNIROUTE_DOCKER_NATIVE_BUILD=1"));
  assert.ok(
    builder.some(
      (line) =>
        line.startsWith("RUN ") &&
        line.includes("apt-get install -y --no-install-recommends python3 make g++")
    )
  );
  assert.doesNotMatch(
    builder.join("\n"),
    /npm ci|npx|ALLOW_HEADER_DOWNLOAD=1|--ignore-scripts=false/
  );
});

test("complete compile is offline and strict receipt/native checks follow the final SQLite overlay", () => {
  const builder = stage("builder");
  assert.ok(builder.includes("COPY . ./"));
  const compile = builder.find((line) => line.startsWith("RUN ") && line.includes("npm run build"));
  assert.ok(compile);
  assert.match(compile, /^RUN --network=none /);
  const build = compile.indexOf("npm run build");
  const overlay = compile.indexOf("cp -a /app/node_modules/better-sqlite3");
  const gate = compile.indexOf("node scripts/build/verify-docker-native-deps.mjs");
  assert.ok(build >= 0 && overlay > build && gate > overlay);
  assert.ok(
    compile.includes(
      "--project-root=/app --node-root=/usr/local --require-tproxy --standalone-root=/app/.build/next/standalone"
    )
  );
  assert.ok(
    compile.includes("@atjsh/llmlingua-2") &&
      compile.includes("@huggingface/transformers") &&
      compile.includes("js-tiktoken") &&
      compile.includes("onnxruntime-node")
  );
  assert.doesNotMatch(compile, /\|\| true|; true|--network=host|npm install|npx/);
});

test("auxiliary trees are readonly inputs rather than duplicate release payload layers", () => {
  const npmTree = stage("npm-tool-tree");
  const cliTree = stage("cli-dependencies");
  assert.ok(
    npmTree.some((line) =>
      line.includes("npm ci --prefix /tmp/docker-npm-tree --install-strategy=nested")
    )
  );
  assert.ok(
    cliTree.some((line) =>
      line.includes("npm ci --prefix /tmp/docker-cli-tree --install-strategy=nested")
    )
  );
  for (const [name, producer, prefix] of [
    ["base", "npm-tool-tree", "npm"],
    ["runner-cli", "cli-dependencies", "cli"],
  ]) {
    const consumer = stage(name);
    const mount = `--mount=type=bind,from=${producer},source=/tmp/docker-${prefix}-tree,target=/tmp/docker-${prefix}-tree`;
    const materialize = consumer.find(
      (line) => line.startsWith("RUN --network=none ") && line.includes(mount)
    );
    assert.ok(materialize, name);
    assert.doesNotMatch(materialize, /(?:,rw\b|,readonly=false)/);
    assert.doesNotMatch(
      consumer.filter((line) => line.startsWith("COPY ")).join("\n"),
      /\/tmp\/docker-(?:npm|cli)-tree/
    );
  }
});
