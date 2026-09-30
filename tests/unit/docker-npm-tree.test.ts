import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_NPM_TREE_SOURCE,
  DEFAULT_NPM_GLOBAL_PREFIX,
  EXPECTED_DOCKER_NPM_PACKAGES,
  installDockerNpmTree,
} from "../../scripts/build/install-docker-npm-tree.mjs";

type Fixture = { root: string; source: string; prefix: string; installed: string };
const pins: Record<string, string> = {
  npm: "12.1.0",
  "brace-expansion": "5.0.9",
  "ip-address": "10.5.0",
  tar: "7.5.22",
  undici: "6.28.0",
};
const originalPins: Record<string, string> = {
  "brace-expansion": "5.0.7",
  "ip-address": "10.2.0",
  tar: "7.5.19",
  undici: "6.27.0",
};

function write(filename: string, value: string, executable = false) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, value);
  if (executable) fs.chmodSync(filename, 0o755);
}

function json(filename: string, value: unknown) {
  write(filename, `${JSON.stringify(value)}\n`);
}

function pkg(
  directory: string,
  name: string,
  version: string,
  extra: Record<string, unknown> = {}
) {
  json(path.join(directory, "package.json"), { name, version, ...extra });
  write(path.join(directory, "index.js"), `module.exports = ${JSON.stringify(name)};\n`);
}

function updateManifest(directory: string, extra: Record<string, unknown>) {
  const filename = path.join(directory, "package.json");
  json(filename, { ...JSON.parse(fs.readFileSync(filename, "utf8")), ...extra });
}

function fixture(): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "docker-npm-tree-test-")));
  const source = path.join(root, "materialized", "node_modules");
  const prefix = path.join(root, "global");
  const installed = path.join(prefix, "lib", "node_modules", "npm");
  const npm = path.join(source, "npm");
  const bin = { npm: "bin/npm-cli.js", npx: "bin/npx-cli.js" };
  pkg(npm, "npm", pins.npm, {
    bin,
    dependencies: { ...originalPins, untouched: "1.0.0" },
    scripts: { install: "THIS_MUST_NEVER_RUN" },
  });
  write(path.join(npm, "lib", "cli.js"), "module.exports = 'npm-cli-fixture';\n");
  for (const [name, relative] of Object.entries(bin)) {
    write(
      path.join(npm, relative),
      `#!/usr/bin/env node\nthrow new Error('${name} must not execute');\n`,
      true
    );
    write(path.join(installed, relative), "#!/usr/bin/env node\n// Previous npm.\n", true);
    fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
    fs.symlinkSync(`../lib/node_modules/npm/${relative}`, path.join(prefix, "bin", name));
  }
  for (const [name, version] of Object.entries(originalPins)) {
    pkg(path.join(npm, "node_modules", name), name, version);
    write(path.join(npm, "node_modules", name, "old-only.txt"), "old bundled file\n");
    const overlay = path.join(source, name);
    pkg(overlay, name, pins[name], {
      dependencies: { "shared-helper": "1.0.0" },
      scripts: { install: "THIS_MUST_NEVER_RUN" },
    });
    pkg(path.join(overlay, "node_modules", "shared-helper"), "shared-helper", "1.0.0");
    write(path.join(overlay, "node_modules", "shared-helper", "owner.txt"), name);
  }
  pkg(path.join(npm, "node_modules", "untouched"), "untouched", "1.0.0", {
    dependencies: { "shared-helper": "1.0.0" },
  });
  pkg(path.join(npm, "node_modules", "shared-helper"), "shared-helper", "1.0.0");
  fs.symlinkSync("cli.js", path.join(npm, "lib", "relative-link.js"));
  fs.mkdirSync(path.join(source, ".bin"));
  fs.symlinkSync("../npm/bin/npm-cli.js", path.join(source, ".bin", "npm"));
  fs.symlinkSync("../npm/bin/npx-cli.js", path.join(source, ".bin", "npx"));
  json(path.join(source, ".package-lock.json"), { lockfileVersion: 3 });
  pkg(installed, "npm", "11.0.0");
  write(path.join(installed, "previous-installation.txt"), "preserve on rejection\n");
  write(
    path.join(prefix, "lib", "node_modules", "other-global", "sentinel.txt"),
    "unrelated global package\n"
  );
  return { root, source, prefix, installed };
}

function withFixture(run: (value: Fixture) => void) {
  const value = fixture();
  try {
    run(value);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
}

type FileSystemOverrides = Partial<Pick<typeof fs, "renameSync" | "cpSync" | "rmSync">>;

function install(value: Fixture, overrides: FileSystemOverrides = {}) {
  return installDockerNpmTree({
    sourceNodeModules: value.source,
    globalPrefix: value.prefix,
    fileSystem: { ...fs, ...overrides },
  });
}

function filesystemError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

function rejectWithoutMutation(
  value: Fixture,
  pattern: RegExp,
  overrides: FileSystemOverrides = {}
) {
  const modules = path.dirname(value.installed);
  const previousEntries = fs.readdirSync(modules).sort();
  const links = ["npm", "npx"].map((name) => fs.readlinkSync(path.join(value.prefix, "bin", name)));
  assert.throws(() => install(value, overrides), pattern);
  assert.equal(
    fs.readFileSync(path.join(value.installed, "previous-installation.txt"), "utf8"),
    "preserve on rejection\n"
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(value.installed, "package.json"), "utf8")).version,
    "11.0.0"
  );
  assert.deepEqual(
    fs.readdirSync(modules).sort(),
    previousEntries,
    "rejection must not leave staging directories"
  );
  assert.deepEqual(
    ["npm", "npx"].map((name) => fs.readlinkSync(path.join(value.prefix, "bin", name))),
    links
  );
}

test("Docker npm pins preserve all four CVE fixes and undici's compatible 6.x line", () => {
  assert.deepEqual(EXPECTED_DOCKER_NPM_PACKAGES, pins);
  assert.equal(Object.isFrozen(EXPECTED_DOCKER_NPM_PACKAGES), true);
  assert.equal(pins.undici.split(".")[0], "6");
  assert.equal(DEFAULT_NPM_TREE_SOURCE, "/tmp/docker-npm-tree/node_modules");
  assert.equal(DEFAULT_NPM_GLOBAL_PREFIX, "/usr/local");
});

test("installs complete npm and exactly four complete overlays at the normal global layout", () => {
  withFixture((value) => {
    const links = ["npm", "npx"].map((name) =>
      fs.readlinkSync(path.join(value.prefix, "bin", name))
    );
    const result = install(value);
    assert.equal(result.npmDirectory, value.installed);
    assert.equal(result.globalPrefix, value.prefix);
    assert.deepEqual(result.versions, pins);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(value.installed, "package.json"), "utf8")).version,
      pins.npm
    );
    for (const name of Object.keys(originalPins)) {
      const patched = path.join(value.installed, "node_modules", name);
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(patched, "package.json"), "utf8")).version,
        pins[name]
      );
      assert.equal(
        fs.readFileSync(path.join(patched, "node_modules", "shared-helper", "owner.txt"), "utf8"),
        name
      );
      assert.equal(
        fs.existsSync(path.join(patched, "old-only.txt")),
        false,
        "overlay removes old files, not just merges"
      );
      assert.equal(
        fs.existsSync(path.join(value.source, name, "package.json")),
        true,
        "source tree is never moved or removed"
      );
    }
    assert.equal(
      fs.readFileSync(path.join(value.installed, "node_modules", "untouched", "index.js"), "utf8"),
      'module.exports = "untouched";\n'
    );
    assert.equal(
      fs.readFileSync(
        path.join(value.prefix, "lib", "node_modules", "other-global", "sentinel.txt"),
        "utf8"
      ),
      "unrelated global package\n"
    );
    assert.equal(fs.readlinkSync(path.join(value.installed, "lib", "relative-link.js")), "cli.js");
    assert.deepEqual(
      ["npm", "npx"].map((name) => fs.readlinkSync(path.join(value.prefix, "bin", name))),
      links
    );
    for (const name of ["npm", "npx"]) {
      const command = path.join(value.prefix, "bin", name);
      assert.equal(fs.realpathSync(command), path.join(value.installed, "bin", `${name}-cli.js`));
      assert.notEqual(fs.statSync(command).mode & 0o111, 0);
      assert.match(fs.readFileSync(command, "utf8"), /must not execute/);
    }
    assert.equal(fs.existsSync(path.join(value.installed, "previous-installation.txt")), false);
    assert.deepEqual(fs.readdirSync(path.dirname(value.installed)).sort(), ["npm", "other-global"]);
  });
});

for (const name of Object.keys(pins)) {
  test(`rejects wrong ${name} version before modifying the existing npm`, () => {
    withFixture((value) => {
      updateManifest(path.join(value.source, name), {
        version: name === "undici" ? "8.0.0" : "0.0.0",
      });
      rejectWithoutMutation(value, /expected .*found/);
    });
  });
}

test("rejects an unexpected top-level dependency instead of discarding external roots", () => {
  withFixture((value) => {
    pkg(path.join(value.source, "unexpected-peer"), "unexpected-peer", "1.0.0");
    rejectWithoutMutation(value, /unexpected top-level root/);
  });
});

test("rejects a missing root, wrong root name, and malformed root manifest", () => {
  withFixture((value) => {
    fs.rmSync(path.join(value.source, "tar"), { recursive: true });
    rejectWithoutMutation(value, /required physical directory/);
  });
  withFixture((value) => {
    updateManifest(path.join(value.source, "tar"), { name: "wrong-package" });
    rejectWithoutMutation(value, /expected tar@/);
  });
  withFixture((value) => {
    write(path.join(value.source, "tar", "package.json"), "not JSON");
    rejectWithoutMutation(value, /invalid JSON manifest/);
  });
});

test("requires all four npm bundled overlay target directories, like the old test -d guard", () => {
  for (const name of Object.keys(originalPins)) {
    withFixture((value) => {
      fs.rmSync(path.join(value.source, "npm", "node_modules", name), { recursive: true });
      rejectWithoutMutation(value, /required physical directory|missing contained dependency/);
    });
  }
});

test("rejects a hoisted dependency outside an overlay's own closure", () => {
  withFixture((value) => {
    updateManifest(path.join(value.source, "tar"), { dependencies: { undici: "6.28.0" } });
    rejectWithoutMutation(value, /missing contained dependency undici required by tar/);
  });
});

test("requires non-optional peers and rejects a missing nested dependency", () => {
  withFixture((value) => {
    updateManifest(path.join(value.source, "tar"), {
      peerDependencies: { "absent-peer": "1.0.0" },
    });
    rejectWithoutMutation(value, /missing contained dependency absent-peer/);
  });
  withFixture((value) => {
    fs.rmSync(path.join(value.source, "tar", "node_modules", "shared-helper"), { recursive: true });
    rejectWithoutMutation(value, /missing contained dependency shared-helper/);
  });
});

test("allows missing platform optionals and optional peers without fetching them", () => {
  withFixture((value) => {
    updateManifest(path.join(value.source, "tar"), {
      optionalDependencies: { "other-platform": "1.0.0" },
      peerDependencies: { "optional-peer": "1.0.0" },
      peerDependenciesMeta: { "optional-peer": { optional: true } },
    });
    install(value);
    assert.equal(
      fs.existsSync(
        path.join(value.installed, "node_modules", "tar", "node_modules", "other-platform")
      ),
      false
    );
  });
});

test("rejects escaping, cross-root, absolute, and dangling symlinks before writes", () => {
  for (const kind of ["escaping", "cross-root", "absolute", "dangling"]) {
    withFixture((value) => {
      write(path.join(value.root, "outside.txt"), "outside");
      const link = path.join(value.source, "tar", "unsafe-link");
      const target =
        kind === "escaping"
          ? "../../../outside.txt"
          : kind === "cross-root"
            ? "../npm/lib/cli.js"
            : kind === "absolute"
              ? path.join(value.source, "tar", "index.js")
              : "does-not-exist";
      fs.symlinkSync(target, link);
      rejectWithoutMutation(value, /symlink/);
    });
  }
});

test("rejects a symlink in place of a package manifest", () => {
  withFixture((value) => {
    const manifest = path.join(value.source, "tar", "package.json");
    fs.renameSync(manifest, path.join(value.source, "tar", "actual.json"));
    fs.symlinkSync("actual.json", manifest);
    rejectWithoutMutation(value, /required regular file/);
  });
});

test("rejects changed npm entrypoints, missing CLI implementation, and non-executable bins", () => {
  withFixture((value) => {
    updateManifest(path.join(value.source, "npm"), {
      bin: { npm: "unexpected.js", npx: "bin/npx-cli.js" },
    });
    rejectWithoutMutation(value, /unexpected npm npm bin manifest layout/);
  });
  withFixture((value) => {
    fs.rmSync(path.join(value.source, "npm", "lib", "cli.js"));
    // Remove the fixture's now-dangling link so this isolates the layout guard.
    fs.rmSync(path.join(value.source, "npm", "lib", "relative-link.js"));
    rejectWithoutMutation(value, /required regular file/);
  });
  withFixture((value) => {
    fs.chmodSync(path.join(value.source, "npm", "bin", "npx-cli.js"), 0o644);
    rejectWithoutMutation(value, /entrypoint is not executable/);
  });
});

test("preserves standard npm/npx links and fails closed on an unexpected global link", () => {
  withFixture((value) => {
    const bin = path.join(value.prefix, "bin", "npx");
    fs.unlinkSync(bin);
    fs.symlinkSync("../some-other-tool", bin);
    rejectWithoutMutation(value, /expected standard global npx symlink/);
  });
});

test("rejects an overlapping source and destination without altering either tree", () => {
  withFixture((value) => {
    assert.throws(
      () => installDockerNpmTree({ sourceNodeModules: value.source, globalPrefix: value.root }),
      /must be disjoint/
    );
    assert.equal(fs.existsSync(path.join(value.installed, "previous-installation.txt")), true);
  });
});

test("rejects directories disguised as npm metadata before writes", () => {
  withFixture((value) => {
    const lock = path.join(value.source, ".package-lock.json");
    fs.rmSync(lock);
    fs.mkdirSync(lock);
    rejectWithoutMutation(value, /required regular file/);
  });
});

test("validates the composed tree before replacing live npm and cleans failed staging", () => {
  withFixture((value) => {
    fs.symlinkSync(
      "../node_modules/tar/old-only.txt",
      path.join(value.source, "npm", "lib", "legacy-link")
    );
    // Valid in the input npm, but the complete tar overlay removes its target.
    rejectWithoutMutation(value, /dangling or cyclic symlink/);
  });
});

test("preserves a scoped transitive dependency inside an overlay", () => {
  withFixture((value) => {
    const overlay = path.join(value.source, "undici");
    updateManifest(overlay, { dependencies: { "@fixture/helper": "1.0.0" } });
    pkg(path.join(overlay, "node_modules", "@fixture", "helper"), "@fixture/helper", "1.0.0");
    install(value);
    const installed = path.join(
      value.installed,
      "node_modules",
      "undici",
      "node_modules",
      "@fixture",
      "helper",
      "package.json"
    );
    assert.equal(JSON.parse(fs.readFileSync(installed, "utf8")).name, "@fixture/helper");
  });
});

test("OverlayFS EXDEV copies a complete same-layer backup before removing old npm", () => {
  withFixture((value) => {
    const events: string[] = [];
    let backup = "";
    install(value, {
      renameSync(from, to) {
        if (String(from) === value.installed) {
          events.push("lower-rename-EXDEV");
          throw filesystemError("EXDEV", "lower-layer directory cannot be renamed");
        }
        if (String(to) === value.installed) events.push("install-validated-tree");
        fs.renameSync(from, to);
      },
      cpSync(from, to, options) {
        fs.cpSync(from, to, options);
        if (String(from) === value.installed) {
          backup = String(to);
          events.push("backup-complete");
        }
      },
      rmSync(filename, options) {
        if (String(filename) === value.installed) {
          assert.equal(
            fs.readFileSync(path.join(backup, "previous-installation.txt"), "utf8"),
            "preserve on rejection\n"
          );
          assert.ok(fs.existsSync(path.join(backup, "bin", "npm-cli.js")));
          assert.ok(fs.existsSync(path.join(backup, "bin", "npx-cli.js")));
          events.push("remove-old-tree");
        }
        fs.rmSync(filename, options);
      },
    });
    assert.deepEqual(events, [
      "lower-rename-EXDEV",
      "backup-complete",
      "remove-old-tree",
      "install-validated-tree",
    ]);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(value.installed, "package.json"), "utf8")).version,
      "12.1.0"
    );
    assert.equal(fs.existsSync(backup), false);
    for (const name of ["npm", "npx"]) {
      assert.equal(
        fs.realpathSync(path.join(value.prefix, "bin", name)),
        path.join(value.installed, "bin", `${name}-cli.js`)
      );
    }
    assert.deepEqual(fs.readdirSync(path.dirname(value.installed)).sort(), ["npm", "other-global"]);
  });
});

for (const code of ["EACCES", "EPERM"]) {
  test(`never applies the EXDEV fallback to ${code} moving original npm`, () => {
    withFixture((value) => {
      let backupCopies = 0;
      rejectWithoutMutation(value, /original move denied/, {
        renameSync(from, to) {
          if (String(from) === value.installed) {
            throw filesystemError(code, "original move denied");
          }
          fs.renameSync(from, to);
        },
        cpSync(from, to, options) {
          if (String(from) === value.installed) backupCopies++;
          fs.cpSync(from, to, options);
        },
      });
      assert.equal(backupCopies, 0);
    });
  });
}

test("an incomplete EXDEV backup fails before any original npm removal", () => {
  withFixture((value) => {
    let originalRemovals = 0;
    rejectWithoutMutation(value, /backup copy failed/, {
      renameSync(from, to) {
        if (String(from) === value.installed) throw filesystemError("EXDEV", "lower layer");
        fs.renameSync(from, to);
      },
      cpSync(from, to, options) {
        if (String(from) === value.installed) {
          write(path.join(String(to), "partial-backup.txt"), "incomplete");
          throw filesystemError("ENOSPC", "backup copy failed");
        }
        fs.cpSync(from, to, options);
      },
      rmSync(filename, options) {
        if (String(filename) === value.installed) originalRemovals++;
        fs.rmSync(filename, options);
      },
    });
    assert.equal(originalRemovals, 0);
  });
});

test("partial original-tree removal restores the complete backup and still fails the install", () => {
  withFixture((value) => {
    let removals = 0;
    rejectWithoutMutation(value, /partial original removal/, {
      renameSync(from, to) {
        if (String(from) === value.installed) throw filesystemError("EXDEV", "lower layer");
        fs.renameSync(from, to);
      },
      rmSync(filename, options) {
        if (String(filename) === value.installed && ++removals === 1) {
          fs.rmSync(path.join(value.installed, "previous-installation.txt"));
          throw filesystemError("EIO", "partial original removal");
        }
        fs.rmSync(filename, options);
      },
    });
    assert.equal(removals, 2, "rollback must remove the partial tree before restoring the backup");
  });
});

for (const useExdev of [false, true]) {
  for (const leavePartial of [false, true]) {
    test(`failed staged rename restores npm (EXDEV backup=${useExdev}, partial destination=${leavePartial})`, () => {
      withFixture((value) => {
        rejectWithoutMutation(value, /new tree rename failed/, {
          renameSync(from, to) {
            if (String(from) === value.installed && useExdev) {
              throw filesystemError("EXDEV", "lower layer");
            }
            if (String(to) === value.installed && path.basename(String(from)) === "npm") {
              if (leavePartial) write(path.join(value.installed, "partial-new.txt"), "partial");
              throw filesystemError("EIO", "new tree rename failed");
            }
            fs.renameSync(from, to);
          },
        });
        assert.equal(fs.existsSync(path.join(value.installed, "partial-new.txt")), false);
      });
    });
  }
}

function retainedBackup(value: Fixture): string {
  const modules = path.dirname(value.installed);
  const stages = fs.readdirSync(modules).filter((name) => name.startsWith(".docker-npm-tree-"));
  assert.equal(stages.length, 1, "failed rollback must retain its staging/backup directory");
  const backup = path.join(modules, stages[0], "previous-npm");
  assert.equal(
    fs.readFileSync(path.join(backup, "previous-installation.txt"), "utf8"),
    "preserve on rejection\n"
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(backup, "package.json"), "utf8")).version,
    "11.0.0"
  );
  return backup;
}

test("failed restore rename retains the complete backup and both failure causes", () => {
  withFixture((value) => {
    let failure: AggregateError | undefined;
    assert.throws(
      () =>
        install(value, {
          renameSync(from, to) {
            if (String(from) === value.installed) throw filesystemError("EXDEV", "lower layer");
            if (String(to) === value.installed) {
              const restoring = path.basename(String(from)) === "previous-npm";
              throw filesystemError(
                restoring ? "EPERM" : "EIO",
                restoring ? "restore denied" : "install move failed"
              );
            }
            fs.renameSync(from, to);
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        failure = error;
        assert.equal(error.errors.length, 2);
        assert.match(error.errors[0].message, /install move failed/);
        assert.match(error.errors[1].message, /restore denied/);
        return true;
      }
    );
    const backup = retainedBackup(value);
    assert.ok(failure!.message.includes(backup));
    assert.equal(fs.existsSync(value.installed), false);
  });
});

test("failed rollback removal never deletes the complete backup", () => {
  withFixture((value) => {
    let removals = 0;
    assert.throws(
      () =>
        install(value, {
          renameSync(from, to) {
            if (String(from) === value.installed) throw filesystemError("EXDEV", "lower layer");
            fs.renameSync(from, to);
          },
          rmSync(filename, options) {
            if (String(filename) === value.installed) {
              removals++;
              if (removals === 1)
                fs.rmSync(path.join(value.installed, "previous-installation.txt"));
              throw filesystemError(
                "EIO",
                removals === 1 ? "partial removal" : "rollback removal denied"
              );
            }
            fs.rmSync(filename, options);
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.message, /backup retained at/);
        assert.equal(error.errors.length, 2);
        return true;
      }
    );
    retainedBackup(value);
    assert.equal(removals, 2);
  });
});

test("installer is import-safe and contains no command runner, downloader, or environment override", () => {
  const filename = fileURLToPath(
    new URL("../../scripts/build/install-docker-npm-tree.mjs", import.meta.url)
  );
  const source = fs.readFileSync(filename, "utf8");
  const imports = [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(imports, ["node:fs", "node:path", "node:url"]);
  assert.doesNotMatch(source, /\b(?:spawn|spawnSync|execFile|execSync|fetch)\s*\(/);
  assert.doesNotMatch(source, /process\.env/);
  assert.match(
    source,
    /path\.resolve\(process\.argv\[1\]\) === fileURLToPath\(import\.meta\.url\)/
  );
  // Import above succeeds without a materialized tree at the fixed Docker path.
  assert.equal(typeof installDockerNpmTree, "function");
});
