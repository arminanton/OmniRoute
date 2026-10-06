import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  CLI_ROOTS,
  DEFAULT_SOURCE_PREFIX,
  DEFAULT_TARGET_PREFIX,
  inspectCliTree,
  installCliTree,
  parseArgs,
} from "../../scripts/build/install-docker-cli-tree.mjs";
import { CLI_VERSIONS } from "../../scripts/build/verify-docker-clis.mjs";

const integrity = `sha512-${Buffer.alloc(64).toString("base64")}`;

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "docker-cli-lock-fixture-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sourcePrefix = path.join(directory, "source");
  const targetPrefix = path.join(directory, "target");
  const modules = path.join(sourcePrefix, "node_modules");
  const globalRoot = path.join(targetPrefix, "lib", "node_modules");
  fs.mkdirSync(path.join(modules, ".bin"), { recursive: true });
  fs.mkdirSync(path.join(globalRoot, "npm"), { recursive: true });
  fs.writeFileSync(path.join(globalRoot, "npm", "keep.txt"), "preserve existing npm\n");
  const dependencies = Object.fromEntries(CLI_ROOTS.map(({ name, version }) => [name, version]));
  const lock = { lockfileVersion: 3, packages: { "": { dependencies } } };
  const writeJson = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  };
  const key = (dir) => path.relative(sourcePrefix, dir).split(path.sep).join("/");
  const add = (owner, name, manifest) => {
    const dir = path.join(owner, "node_modules", name);
    writeJson(path.join(dir, "package.json"), manifest);
    lock.packages[key(dir)] = {
      name: manifest.name,
      version: manifest.version,
      resolved: `https://registry.npmjs.org/${manifest.name}/-/fixture.tgz`,
      integrity,
    };
    return dir;
  };
  const roots = {};
  for (const root of CLI_ROOTS) {
    const dir = add(sourcePrefix, root.name, {
      name: root.name,
      version: root.version,
      bin: { [root.bin]: root.entry },
    });
    roots[root.name] = dir;
    const entry = path.join(dir, root.entry);
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, "#!/usr/bin/env node\nthrow Error('fixture must never execute');\n", {
      mode: 0o755,
    });
    fs.symlinkSync(
      path.relative(path.join(modules, ".bin"), entry),
      path.join(modules, ".bin", root.bin)
    );
  }
  writeJson(path.join(sourcePrefix, "package.json"), { private: true, dependencies });
  const save = () => writeJson(path.join(sourcePrefix, "package-lock.json"), lock);
  const update = (dir, values) => {
    const file = path.join(dir, "package.json");
    writeJson(file, { ...JSON.parse(fs.readFileSync(file, "utf8")), ...values });
  };
  save();
  return {
    directory,
    sourcePrefix,
    targetPrefix,
    modules,
    globalRoot,
    roots,
    lock,
    key,
    add,
    save,
    update,
    writeJson,
    options: { sourcePrefix, targetPrefix },
  };
}

function unchangedTarget(f) {
  assert.deepEqual(fs.readdirSync(f.globalRoot), ["npm"]);
  assert.equal(
    fs.readFileSync(path.join(f.globalRoot, "npm", "keep.txt"), "utf8"),
    "preserve existing npm\n"
  );
  assert.equal(fs.existsSync(path.join(f.targetPrefix, "bin")), false);
}

test("installer pins exactly the approved four CLI versions and standard prefixes", () => {
  assert.deepEqual(
    Object.fromEntries(CLI_ROOTS.map(({ name, version }) => [name, version])),
    CLI_VERSIONS
  );
  assert.equal(DEFAULT_SOURCE_PREFIX, "/tmp/docker-cli-tree");
  assert.equal(DEFAULT_TARGET_PREFIX, "/usr/local");
  assert.deepEqual(
    parseArgs(["--source-prefix", "/fixture/source", "--target-prefix", "/fixture/target"]),
    { sourcePrefix: "/fixture/source", targetPrefix: "/fixture/target" }
  );
  for (const args of [
    ["--source-prefix"],
    ["--execute-hooks"],
    ["--target-prefix", "/a", "--target-prefix", "/b"],
  ]) {
    assert.throws(() => parseArgs(args));
  }
});

test("preflight is read-only and full nested packages, resources, bins and Droid shim survive copying", (t) => {
  const f = fixture(t);
  const openclaw = f.roots.openclaw;
  f.update(openclaw, { dependencies: { child: "^1.0.0", shared: "1.0.0" } });
  const child = f.add(openclaw, "child", {
    name: "child",
    version: "1.2.0",
    dependencies: { leaf: "1.0.0" },
    peerDependencies: { shared: "^1.0.0", absent: "*" },
    peerDependenciesMeta: { absent: { optional: true } },
  });
  f.add(child, "leaf", { name: "leaf", version: "1.0.0" });
  f.add(openclaw, "shared", { name: "shared", version: "1.0.0" });
  const childBin = path.join(child, "cli.js");
  fs.writeFileSync(childBin, "throw Error('never execute nested bins');", { mode: 0o755 });
  fs.mkdirSync(path.join(openclaw, "node_modules", ".bin"));
  fs.symlinkSync("../child/cli.js", path.join(openclaw, "node_modules", ".bin", "child"));
  const alias = "@openai/codex-linux-arm64";
  f.update(f.roots["@openai/codex"], {
    optionalDependencies: {
      [alias]: "npm:@openai/codex@0.160.0-linux-arm64",
      "@openai/codex-linux-x64": "npm:@openai/codex@0.160.0-linux-x64",
    },
  });
  const platform = f.add(f.roots["@openai/codex"], alias, {
    name: "@openai/codex",
    version: "0.160.0-linux-arm64",
  });
  const resource = "vendor/aarch64-unknown-linux-musl/codex-resources/zsh/bin/zsh";
  fs.mkdirSync(path.dirname(path.join(platform, resource)), { recursive: true });
  fs.writeFileSync(path.join(platform, resource), "complete platform resource\n", { mode: 0o755 });
  f.update(f.roots.droid, { scripts: { postinstall: "node install.js" } });
  fs.writeFileSync(
    path.join(f.roots.droid, "install.js"),
    "throw Error('no lifecycle is allowed');\n"
  );
  f.save();
  const plan = inspectCliTree(f.options);
  assert.equal(plan.packageCount, 8);
  unchangedTarget(f);
  const result = installCliTree(f.options);
  assert.equal(result.packageCount, 8);
  for (const root of CLI_ROOTS) {
    assert.equal(
      fs.realpathSync(path.join(f.targetPrefix, "bin", root.bin)),
      path.join(f.globalRoot, root.name, root.entry)
    );
    assert.equal(
      fs.readFileSync(path.join(f.globalRoot, root.name, root.entry), "utf8"),
      fs.readFileSync(path.join(f.roots[root.name], root.entry), "utf8")
    );
  }
  assert.equal(
    fs.readFileSync(path.join(f.globalRoot, "@openai/codex/node_modules", alias, resource), "utf8"),
    "complete platform resource\n"
  );
  const relocated = path.join(f.globalRoot, "openclaw/node_modules/.bin/child");
  assert.equal(fs.readlinkSync(relocated), "../child/cli.js");
  assert.equal(
    fs.realpathSync(relocated),
    path.join(f.globalRoot, "openclaw/node_modules/child/cli.js")
  );
  assert.equal(
    fs.readFileSync(path.join(f.globalRoot, "npm/keep.txt"), "utf8"),
    "preserve existing npm\n"
  );
  assert.ok(fs.existsSync(path.join(f.roots.droid, "install.js")), "source tree is not deleted");
  assert.ok(!fs.readdirSync(f.globalRoot).some((name) => name.startsWith(".omniroute-cli-tree-")));
});

test("unexpected installed or lock-only top-level roots fail before any target mutation", (t) => {
  for (const lockOnly of [false, true]) {
    const f = fixture(t);
    if (lockOnly) f.lock.packages["node_modules/hoisted"] = { version: "1.0.0" };
    else f.add(f.sourcePrefix, "hoisted", { name: "hoisted", version: "1.0.0" });
    f.save();
    assert.throws(() => installCliTree(f.options), /external lock root|exactly four/);
    unchangedTarget(f);
  }
});

test("missing required dependency and cross-CLI required peer are never silently dropped", (t) => {
  for (const crossRoot of [false, true]) {
    const f = fixture(t);
    f.update(
      f.roots.droid,
      crossRoot
        ? { peerDependencies: { openclaw: "2026.9.1" } }
        : { dependencies: { missing: "1.0.0" } }
    );
    assert.throws(
      () => installCliTree(f.options),
      /Missing required dependency|escapes its complete CLI root/
    );
    unchangedTarget(f);
  }
});

test("version, missing lock entry, registry integrity and bin metadata mismatches fail closed", (t) => {
  const corruptions = [
    (f) => f.update(f.roots.droid, { version: "0.213.0" }),
    (f) => {
      delete f.lock.packages[f.key(f.roots.droid)];
    },
    (f) => {
      delete f.lock.packages[f.key(f.roots.droid)].integrity;
    },
    (f) => {
      f.lock.packages[f.key(f.roots.droid)].resolved = "file:/untrusted/archive.tgz";
    },
    (f) => f.update(f.roots.droid, { bin: { droid: "install.js" } }),
    (f) => f.update(f.roots.droid, { dependencies: [] }),
    (f) => f.update(f.roots.droid, { optionalDependencies: "invalid" }),
    (f) => {
      f.lock.packages[""].dependencies.droid = "latest";
    },
  ];
  for (const corrupt of corruptions) {
    const f = fixture(t);
    corrupt(f);
    f.save();
    assert.throws(() => installCliTree(f.options));
    unchangedTarget(f);
  }
});

test("absolute and external relative package symlinks fail before target mutation", (t) => {
  for (const absolute of [false, true]) {
    const f = fixture(t);
    const root = f.roots.openclaw;
    const target = absolute
      ? path.join(root, "package.json")
      : path.join(f.globalRoot, "npm/keep.txt");
    fs.symlinkSync(absolute ? target : path.relative(root, target), path.join(root, "unsafe-link"));
    assert.throws(() => installCliTree(f.options), /Absolute symlink|Symlink escapes/);
    unchangedTarget(f);
  }
});

test("unknown source bin and colliding target bin are rejected before copying packages", (t) => {
  const f = fixture(t);
  fs.symlinkSync("../droid/bin/droid", path.join(f.modules, ".bin", "surprise"));
  assert.throws(() => installCliTree(f.options), /Unexpected source root bin/);
  unchangedTarget(f);
  fs.unlinkSync(path.join(f.modules, ".bin", "surprise"));
  fs.mkdirSync(path.join(f.targetPrefix, "bin"));
  fs.writeFileSync(path.join(f.targetPrefix, "bin", "droid"), "do not overwrite\n");
  assert.throws(() => installCliTree(f.options), /existing global bin/);
  assert.deepEqual(fs.readdirSync(f.globalRoot), ["npm"]);
  assert.equal(
    fs.readFileSync(path.join(f.targetPrefix, "bin", "droid"), "utf8"),
    "do not overwrite\n"
  );
});

test("target scope symlinks and overlapping prefixes cannot redirect materialization", (t) => {
  const f = fixture(t);
  fs.symlinkSync(f.directory, path.join(f.globalRoot, "@openai"));
  assert.throws(() => installCliTree(f.options), /real directory/);
  fs.unlinkSync(path.join(f.globalRoot, "@openai"));
  unchangedTarget(f);
  assert.throws(
    () => inspectCliTree({ sourcePrefix: f.sourcePrefix, targetPrefix: f.directory }),
    /disjoint/
  );
});
