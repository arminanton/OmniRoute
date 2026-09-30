/**
 * Ownership belongs on COPY, not on a recursive walk over the standalone tree.
 * These are source-policy checks, not proof of ownership inside a built image.
 * The fixed official Node image supplies the node user (UID/GID 1000).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { posix } from "node:path";

type Instruction = {
  keyword: string;
  value: string;
  stage: string;
  workdir: string;
  index: number;
};
type Token = { value: string; control: boolean };
type Command = { args: string[]; instruction: Instruction };

// Read shell words without executing them. Quotes keep JS snippets and echo
// text opaque; only unquoted shell operators separate commands.
function shellTokens(input: string): Token[] {
  const tokens: Token[] = [];
  let word = "";
  let started = false;
  let quote = "";
  const flush = () => {
    if (started) tokens.push({ value: word, control: false });
    word = "";
    started = false;
  };
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    const next = input[i + 1];
    if (char === "\\" && quote !== "'" && next !== undefined) {
      if (quote !== '"' || '$`"\\\n'.includes(next)) {
        word += next;
        started = true;
        i++;
        continue;
      }
    }
    if (quote) {
      if (char === quote) quote = "";
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      flush();
    } else if (char === "#" && !started) {
      break;
    } else if (";&|()<>".includes(char)) {
      flush();
      const pair = char + (next ?? "");
      const operator = ["&&", "||", ">>", "<<"].includes(pair) ? pair : char;
      tokens.push({ value: operator, control: true });
      i += operator.length - 1;
    } else {
      word += char;
      started = true;
    }
  }
  assert.equal(quote, "", "source-policy parser requires balanced shell quotes");
  flush();
  return tokens;
}

function words(input: string): string[] {
  const tokens = shellTokens(input);
  assert.ok(
    tokens.every((token) => !token.control),
    `expected words, got ${input}`
  );
  return tokens.map((token) => token.value);
}

function leadingFlags(input: string): { flags: Map<string, string>; body: string } {
  const flags = new Map<string, string>();
  let body = input.trim();
  while (body.startsWith("--")) {
    const match = /^--([\w-]+)(?:=("[^"]*"|'[^']*'|\S+))?(?:\s+|$)/.exec(body);
    assert.ok(match, `unsupported Docker flag syntax: ${body}`);
    flags.set(match[1], match[2] === undefined ? "" : words(match[2])[0]);
    body = body.slice(match[0].length).trimStart();
  }
  return { flags, body };
}

function parseDockerfile(source: string): Instruction[] {
  const instructions: Instruction[] = [];
  const workdirs = new Map<string, string>();
  let pending = "";
  let stage = "";
  let workdir = "/";
  for (const physicalLine of source.split(/\r?\n/)) {
    const line = physicalLine.trim();
    if (!line || line.startsWith("#")) continue;
    pending += line.replace(/\\\s*$/, " ");
    if (/\\\s*$/.test(line)) continue;
    const match = /^([A-Za-z]+)\s+([\s\S]+)$/.exec(pending);
    assert.ok(match, `invalid Docker instruction: ${pending}`);
    const keyword = match[1].toUpperCase();
    const value = match[2].trim();
    if (keyword === "FROM") {
      const args = words(leadingFlags(value).body);
      const alias = args.findIndex((arg) => arg.toUpperCase() === "AS");
      assert.ok(alias >= 0 && args[alias + 1], "policy checks require named stages");
      stage = args[alias + 1].toLowerCase();
      workdir = workdirs.get(args[0].toLowerCase()) ?? "/";
    } else if (keyword === "WORKDIR") {
      workdir = posix.resolve(workdir, words(value)[0]);
    }
    instructions.push({ keyword, value, stage, workdir, index: instructions.length });
    workdirs.set(stage, workdir);
    pending = "";
  }
  assert.equal(pending, "", "unterminated Docker line continuation");
  return instructions;
}

function payloadArgs(body: string): string[] {
  if (!body.startsWith("[")) return words(body);
  const parsed: unknown = JSON.parse(body);
  assert.ok(Array.isArray(parsed) && parsed.every((value) => typeof value === "string"));
  return parsed as string[];
}

function copyInfo(instruction: Instruction) {
  assert.equal(instruction.keyword, "COPY");
  const { flags, body } = leadingFlags(instruction.value);
  const args = payloadArgs(body);
  assert.ok(args.length >= 2, "COPY requires a source and destination");
  return {
    flags,
    sources: args.slice(0, -1),
    destination: posix.resolve(instruction.workdir, args[args.length - 1]),
    instruction,
  };
}

function runCommands(instructions: Instruction[]): Command[] {
  return instructions.flatMap((instruction) => {
    if (instruction.keyword !== "RUN") return [];
    const { body } = leadingFlags(instruction.value);
    if (body.startsWith("[")) return [{ args: payloadArgs(body), instruction }];
    const commands: Command[] = [];
    let args: string[] = [];
    for (const token of shellTokens(body)) {
      if (!token.control) args.push(token.value);
      else if (args.length) {
        commands.push({ args, instruction });
        args = [];
      }
    }
    if (args.length) commands.push({ args, instruction });
    return commands;
  });
}

function executable(command: Command): string {
  return posix.basename(command.args[0]);
}

function operands(command: Command): string[] {
  return command.args.slice(1).filter((arg) => !arg.startsWith("-"));
}

function recursive(command: Command): boolean {
  return command.args.some((arg) => arg === "--recursive" || /^-[^-]*R/.test(arg));
}

function absolute(instruction: Instruction, value: string): string {
  assert.doesNotMatch(value, /[$`*?]/, "ownership paths must be statically resolvable");
  return posix.resolve(instruction.workdir, value);
}

const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
const instructions = parseDockerfile(dockerfile);
const stage = (name: string) => instructions.filter((instruction) => instruction.stage === name);
const runner = stage("runner-base");
const dependencies = stage("dependencies");
const builder = stage("builder");
const copies = runner.filter((instruction) => instruction.keyword === "COPY").map(copyInfo);
const writableDirectories = ["/app/data", "/run/codex-appserver", "/home/node/.codex"];
const ownedDirectories = ["/app", ...writableDirectories];
const privateDirectories = ["/run/codex-appserver", "/home/node/.codex"];
const payloads = [
  ["/app/.build/next/standalone", "/app"],
  ["/app/node_modules/better-sqlite3", "/app/node_modules/better-sqlite3"],
  ["/app/scripts/dev/healthcheck.mjs", "/app/healthcheck.mjs"],
];

function payloadCopies() {
  return payloads.map(([source, destination]) => {
    const matches = copies.filter(
      (copy) => copy.sources.length === 1 && copy.sources[0] === source
    );
    assert.equal(matches.length, 1, `${source} must have one complete runner-base COPY`);
    const copy = matches[0];
    assert.equal(copy.destination, destination);
    assert.equal(copy.flags.get("from"), "builder");
    return copy;
  });
}

test("ownership policy parser ignores comments and quoted command lookalikes", () => {
  const sample = parseDockerfile(
    [
      "FROM node:26-trixie-slim AS base",
      "WORKDIR /app",
      "# COPY --chown=node:node fake /app",
      "FROM base AS runner-base",
      "COPY --from=builder \\",
      "  # an interleaved Docker comment is not an instruction",
      '  --chown="node:node" ["/payload", "./"]',
      'RUN echo "chown -R node:node /app; not a command" && chown node:node /app',
    ].join("\n")
  );
  const copy = copyInfo(sample.find((instruction) => instruction.keyword === "COPY")!);
  assert.equal(copy.flags.get("chown"), "node:node");
  assert.equal(copy.destination, "/app");
  const commands = runCommands(sample);
  assert.deepEqual(commands.map(executable), ["echo", "chown"]);
  assert.equal(recursive(commands[1]), false);
});

test("runner-base assigns ownership while copying all three application payloads", () => {
  for (const copy of payloadCopies()) {
    assert.equal(copy.flags.get("chown"), "node:node", copy.sources[0]);
  }
});

test("runner-base changes directory inodes after COPY, not the full application tree", () => {
  const commands = runCommands(runner);
  const chowns = commands.filter((command) => executable(command) === "chown");
  assert.ok(chowns.length > 0, "the /app inode and writable directories need explicit ownership");
  const payloadIndexes = payloadCopies().map((copy) => copy.instruction.index);
  const firstPayload = Math.min(...payloadIndexes);
  const lastPayload = Math.max(...payloadIndexes);
  const runtimeUser = runner.find((instruction) => instruction.keyword === "USER");
  assert.ok(runtimeUser);
  const owned = new Set<string>();
  for (const command of chowns) {
    assert.equal(recursive(command), false, "runner-base chown must not recurse");
    assert.ok(command.instruction.index > lastPayload, "ownership must follow all payload COPYs");
    assert.ok(
      command.instruction.index < runtimeUser.index,
      "ownership mutations must precede USER node"
    );
    const [owner, ...paths] = operands(command);
    assert.equal(owner, "node:node");
    assert.ok(paths.length > 0);
    for (const operand of paths) {
      const path = absolute(command.instruction, operand);
      assert.ok(ownedDirectories.includes(path), `unexpected chown target ${path}`);
      owned.add(path);
    }
  }
  assert.deepEqual([...owned].sort(), [...ownedDirectories].sort());
  for (const directory of writableDirectories) {
    assert.ok(
      commands.some(
        (command) =>
          executable(command) === "mkdir" &&
          command.args.includes("-p") &&
          operands(command).some(
            (operand) => absolute(command.instruction, operand) === directory
          ) &&
          command.instruction.index < firstPayload
      ),
      `${directory} must keep its existing creation step before the payload COPYs`
    );
  }
  const protectedPaths = new Set<string>();
  for (const command of commands.filter((candidate) => executable(candidate) === "chmod")) {
    assert.ok(
      command.instruction.index < runtimeUser.index,
      "private mode changes must precede USER node"
    );
    const [mode, ...paths] = operands(command);
    assert.equal(mode, "700", "preserve private Codex directory modes");
    assert.equal(recursive(command), false);
    for (const operand of paths) protectedPaths.add(absolute(command.instruction, operand));
  }
  assert.deepEqual([...protectedPaths].sort(), [...privateDirectories].sort());
});

test("no app runner reintroduces a recursive ownership pass over /app", () => {
  const runnerStages = new Set(["runner-base"]);
  for (const instruction of instructions.filter((candidate) => candidate.keyword === "FROM")) {
    if (runnerStages.has(words(leadingFlags(instruction.value).body)[0])) {
      runnerStages.add(instruction.stage);
    }
  }
  const commands = runCommands(instructions.filter((item) => runnerStages.has(item.stage)));
  for (const command of commands) {
    let paths: string[] = [];
    if (executable(command) === "chown" && recursive(command)) {
      paths = operands(command).slice(1);
    } else if (executable(command) === "find") {
      paths = command.args.slice(1).filter((arg) => arg.startsWith("/") || arg.startsWith("."));
      if (paths.length === 0) paths = ["."];
    }
    for (const operand of paths) {
      const path = absolute(command.instruction, operand);
      assert.ok(
        path !== "/" && path !== "/app" && !path.startsWith("/app/"),
        `${command.instruction.stage} must not traverse ${path} for an ownership fix`
      );
    }
  }
});

test("immutable Node26.10 and the non-root entrypoint, healthcheck, and command remain unchanged", () => {
  const baseFrom = stage("base").find((instruction) => instruction.keyword === "FROM");
  assert.ok(baseFrom);
  assert.deepEqual(words(leadingFlags(baseFrom.value).body), [
    "node:26.10.0-trixie-slim@sha256:ec7758ee051e457b468b32bde57b0879010b325bb9862718e9615225ce4aaae1",
    "AS",
    "base",
  ]);
  for (const name of ["runner-base", "runner-web", "runner-cli"]) {
    const users = stage(name).filter((instruction) => instruction.keyword === "USER");
    assert.ok(users.length > 0, `${name} must explicitly return to the node user`);
    assert.deepEqual(words(users[users.length - 1].value), ["node"]);
  }
  const user = runner.find((instruction) => instruction.keyword === "USER");
  assert.ok(user);
  const postUserRuns = runner.filter(
    (instruction) => instruction.keyword === "RUN" && instruction.index > user.index
  );
  assert.equal(
    postUserRuns.length,
    1,
    "only the read-only final SQLite smoke belongs after USER node"
  );
  assert.equal(leadingFlags(postUserRuns[0].value).flags.get("network"), "none");
  const postUserCommands = runCommands(postUserRuns);
  assert.equal(postUserCommands.length, 1);
  assert.deepEqual(postUserCommands[0].args, [
    "node",
    "-e",
    "const assert=require('node:assert/strict'); assert.equal(require('better-sqlite3/package.json').version,'13.0.3'); const db=require('better-sqlite3')(':memory:'); assert.equal(db.prepare('SELECT 1 AS ok').get().ok,1); db.close()",
  ]);
  for (const command of runCommands(runner)) {
    if (["mkdir", "chown", "chmod"].includes(executable(command))) {
      assert.ok(
        command.instruction.index < user.index,
        "writable-directory and ownership changes must precede USER node"
      );
    }
  }
  const accountEditors = ["usermod", "groupmod", "useradd", "groupadd", "adduser", "addgroup"];
  assert.ok(
    runCommands(instructions).every((command) => !accountEditors.includes(executable(command))),
    "keep the fixed base image's node UID/GID 1000 instead of remapping accounts"
  );
  const entrypoint = runner.filter((instruction) => instruction.keyword === "ENTRYPOINT");
  assert.equal(entrypoint.length, 1);
  assert.deepEqual(payloadArgs(entrypoint[0].value), ["/app/check-permissions.sh"]);
  const entrypointCopy = copies.find((copy) => copy.destination === "/app/check-permissions.sh");
  assert.ok(entrypointCopy);
  assert.deepEqual(entrypointCopy.sources, ["scripts/check-permissions.sh"]);
  assert.equal(entrypointCopy.flags.get("chmod"), "755");
  assert.equal(
    entrypointCopy.flags.has("chown"),
    false,
    "entrypoint stays root-owned and executable"
  );
  assert.equal(entrypointCopy.flags.has("from"), false);
  const healthchecks = runner.filter((instruction) => instruction.keyword === "HEALTHCHECK");
  assert.equal(healthchecks.length, 1);
  const healthcheck = leadingFlags(healthchecks[0].value);
  assert.deepEqual(Object.fromEntries(healthcheck.flags), {
    interval: "30s",
    timeout: "5s",
    "start-period": "15s",
    retries: "3",
  });
  assert.match(healthcheck.body, /^CMD\s+/);
  assert.deepEqual(payloadArgs(healthcheck.body.replace(/^CMD\s+/, "")), [
    "node",
    "healthcheck.mjs",
  ]);
  const commands = runner.filter((instruction) => instruction.keyword === "CMD");
  assert.equal(commands.length, 1);
  assert.deepEqual(payloadArgs(commands[0].value), ["node", "dev/run-standalone.mjs"]);
});

test("dependencies stage receives all manifests and the committed lock before offline native acceptance", () => {
  const dependencyFrom = dependencies.find((instruction) => instruction.keyword === "FROM");
  assert.ok(dependencyFrom);
  assert.deepEqual(words(leadingFlags(dependencyFrom.value).body), ["base", "AS", "dependencies"]);
  const commands = runCommands(dependencies);
  const dependencyInstall = commands.filter(
    (command) => command.args[0] === "npm" && command.args[1] === "ci"
  );
  assert.equal(dependencyInstall.length, 1);
  const ci = dependencyInstall[0];
  for (const flag of [
    "--include=optional",
    "--ignore-scripts",
    "--legacy-peer-deps",
    "--no-audit",
    "--no-fund",
    "--fetch-retries=2",
    "--fetch-retry-mintimeout=2000",
    "--fetch-retry-maxtimeout=30000",
    "--fetch-timeout=60000",
  ])
    assert.ok(ci.args.includes(flag), `npm ci must retain ${flag}`);
  assert.ok(!ci.args.some((arg) => arg === "--omit=optional" || arg === "--ignore-scripts=false"));
  const dependencyCopies = dependencies
    .filter((instruction) => instruction.keyword === "COPY")
    .map(copyInfo);
  for (const manifest of ["open-sse/package.json", "packages/browser-pool/package.json"]) {
    assert.ok(
      dependencyCopies.some(
        (copy) =>
          copy.sources.includes(manifest) &&
          copy.destination === `/app/${manifest}` &&
          copy.instruction.index < ci.instruction.index
      ),
      `${manifest} must reach its workspace path before npm ci`
    );
  }
  assert.ok(
    dependencyCopies.some(
      (copy) =>
        copy.sources.length === 2 &&
        copy.sources.includes("package.json") &&
        copy.sources.includes("package-lock.json") &&
        copy.destination === "/app" &&
        copy.instruction.index < ci.instruction.index
    ),
    "copy the root manifest and committed lock explicitly before npm ci"
  );
  assert.ok(
    commands.some(
      (command) =>
        command.args.join("\0") === ["test", "-f", "package-lock.json"].join("\0") &&
        command.instruction.index < ci.instruction.index
    ),
    "keep the explicit committed-lockfile existence guard"
  );
  const gates = commands.filter(
    (command) =>
      command.args[0] === "node" &&
      command.args[1] === "scripts/build/verify-docker-native-deps.mjs"
  );
  assert.equal(gates.length, 1);
  const gate = gates[0];
  assert.deepEqual(gate.args, [
    "node",
    "scripts/build/verify-docker-native-deps.mjs",
    "--project-root=/app",
    "--node-root=/usr/local",
  ]);
  assert.equal(leadingFlags(gate.instruction.value).flags.get("network"), "none");
  assert.ok(gate.instruction.index > ci.instruction.index);
  assert.ok(
    dependencyCopies.some(
      (copy) =>
        copy.sources.includes("scripts/build/verify-docker-native-deps.mjs") &&
        copy.destination === "/app/scripts/build/verify-docker-native-deps.mjs" &&
        copy.instruction.index < gate.instruction.index
    )
  );
  assert.ok(
    !commands.some((command) => executable(command) === "apt-get"),
    "compiler provisioning belongs after dependency acceptance"
  );
});

test("builder inherits accepted dependencies and preserves strict TPROXY compilation without SQLite gyp", () => {
  const builderFrom = builder.find((instruction) => instruction.keyword === "FROM");
  assert.ok(builderFrom);
  assert.deepEqual(words(leadingFlags(builderFrom.value).body), ["dependencies", "AS", "builder"]);
  assert.ok(
    builder.some(
      (instruction) =>
        instruction.keyword === "ENV" &&
        words(instruction.value).includes("OMNIROUTE_DOCKER_NATIVE_BUILD=1")
    ),
    "retain the strict first-party native build flag"
  );
  const commands = runCommands(builder);
  assert.ok(
    !commands.some((command) => command.args[0] === "npm" && command.args[1] === "ci"),
    "the builder must reuse the accepted dependency stage, not reinstall"
  );
  const toolchain = commands.find(
    (command) => executable(command) === "apt-get" && command.args[1] === "install"
  );
  assert.ok(toolchain, "TPROXY still needs an explicit compiler toolchain");
  for (const pkg of ["python3", "make", "g++"]) assert.ok(toolchain.args.includes(pkg));
  const allNativeCommands = runCommands([...dependencies, ...builder]);
  assert.ok(
    !allNativeCommands.some(
      (command) =>
        ["npx", "node-gyp"].includes(executable(command)) ||
        (command.args[0] === "node" && /(?:^|\/)node-gyp(?:\/|\.)/.test(command.args[1] ?? "")) ||
        (command.args[0] === "npm" && command.args[1] === "rebuild") ||
        (command.args[0] === "cd" && command.args[1]?.includes("node_modules/better-sqlite3"))
    ),
    "do not restore stamp-only SQLite gyp or broad native/lifecycle rebuilds in Docker"
  );
  const build = commands.findIndex(
    (command) => command.args.join("\0") === ["npm", "run", "build"].join("\0")
  );
  assert.ok(build >= 0);
  assert.ok(toolchain.instruction.index < commands[build].instruction.index);
  assert.equal(leadingFlags(commands[build].instruction.value).flags.get("network"), "none");
  const removeSQLite = commands.findIndex(
    (command) =>
      command.args.join("\0") ===
      ["rm", "-rf", "/app/.build/next/standalone/node_modules/better-sqlite3"].join("\0")
  );
  const copySQLite = commands.findIndex(
    (command) =>
      command.args.join("\0") ===
      [
        "cp",
        "-a",
        "/app/node_modules/better-sqlite3",
        "/app/.build/next/standalone/node_modules/better-sqlite3",
      ].join("\0")
  );
  const gate = commands.findIndex(
    (command) =>
      command.args[0] === "node" &&
      command.args[1] === "scripts/build/verify-docker-native-deps.mjs"
  );
  assert.ok(
    build < removeSQLite && removeSQLite < copySQLite && copySQLite < gate,
    "prepare the full SQLite standalone overlay before final native/TProxy acceptance"
  );
  assert.deepEqual(commands[gate].args, [
    "node",
    "scripts/build/verify-docker-native-deps.mjs",
    "--project-root=/app",
    "--node-root=/usr/local",
    "--require-tproxy",
    "--standalone-root=/app/.build/next/standalone",
  ]);
  assert.equal(leadingFlags(commands[gate].instruction.value).flags.get("network"), "none");
  assert.ok(
    commands
      .slice(gate + 1)
      .some(
        (command) =>
          command.args[0] === "node" &&
          command.args.includes("--input-type=module") &&
          command.args.some(
            (arg) => arg.includes("onnxruntime-node") && arg.includes("@huggingface/transformers")
          )
      ),
    "keep the standalone ML module import gate after native readiness"
  );
});

test("the native prebuilt packages keep registry integrity entries in the committed lock", () => {
  const lock = JSON.parse(
    readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8")
  ) as { packages: Record<string, { version?: string; resolved?: string; integrity?: string }> };
  for (const name of [
    "better-sqlite3",
    "wreq-js",
    "@wreq-js/binding-linux-x64-gnu",
    "@wreq-js/binding-linux-arm64-gnu",
    "sharp",
    "esbuild",
  ]) {
    const entry = lock.packages[`node_modules/${name}`];
    assert.ok(entry, `${name} must remain locked`);
    assert.ok(entry.version, `${name} needs a resolved version`);
    assert.match(entry.resolved ?? "", /^https:\/\/registry\.npmjs\.org\//);
    assert.match(entry.integrity ?? "", /^sha512-[A-Za-z0-9+/]{86}==$/);
  }
});
