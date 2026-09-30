import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir: string;
let origDataDir: string | undefined;
let origKeychainDisabled: string | undefined;

test.before(() => {
  origKeychainDisabled = process.env.OMNIROUTE_CONTEXT_KEYCHAIN_DISABLED;
  // Must precede EVERY application import: never load a host keychain/D-Bus.
  process.env.OMNIROUTE_CONTEXT_KEYCHAIN_DISABLED = "1";
  tmpDir = mkdtempSync(join(tmpdir(), "omniroute-ctx-test-"));
  origDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDir;
});

test.after(() => {
  if (origKeychainDisabled === undefined) delete process.env.OMNIROUTE_CONTEXT_KEYCHAIN_DISABLED;
  else process.env.OMNIROUTE_CONTEXT_KEYCHAIN_DISABLED = origKeychainDisabled;
  if (origDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = origDataDir;
  try {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {}
});

test("contexts.mjs pode ser importado sem erro", async () => {
  const mod = await import("../../bin/cli/contexts.mjs");
  assert.equal(typeof mod.loadContexts, "function");
  assert.equal(typeof mod.saveContexts, "function");
  assert.equal(typeof mod.resolveActiveContext, "function");
  assert.equal(typeof mod.configPath, "function");
});

test("loadContexts retorna config padrão quando arquivo não existe", async () => {
  const { loadContexts } = await import("../../bin/cli/contexts.mjs");
  const cfg = loadContexts();
  assert.ok(cfg.contexts);
  assert.ok(cfg.contexts.default);
  assert.equal(typeof cfg.contexts.default.baseUrl, "string");
  assert.equal(cfg.currentContext, "default");
});

test("saveContexts persiste e loadContexts relê", async () => {
  const { loadContexts, saveContexts } = await import("../../bin/cli/contexts.mjs");
  const cfg = loadContexts();
  cfg.contexts.test = { baseUrl: "http://test:9999", apiKey: null };
  cfg.currentContext = "test";
  saveContexts(cfg);
  const cfg2 = loadContexts();
  assert.equal(cfg2.currentContext, "test");
  assert.equal(cfg2.contexts.test?.baseUrl, "http://test:9999");
});

test("resolveActiveContext retorna contexto ativo", async () => {
  const { resolveActiveContext, loadContexts, saveContexts } =
    await import("../../bin/cli/contexts.mjs");
  const cfg = loadContexts();
  cfg.contexts.prod = { baseUrl: "https://prod.example.com", apiKey: "sk-prod" };
  cfg.currentContext = "prod";
  saveContexts(cfg);
  const ctx = resolveActiveContext(undefined);
  assert.equal(ctx.baseUrl, "https://prod.example.com");
});

test("resolveActiveContext aceita override pontual", async () => {
  const { resolveActiveContext, loadContexts, saveContexts } =
    await import("../../bin/cli/contexts.mjs");
  const cfg = loadContexts();
  cfg.contexts.staging = { baseUrl: "http://staging:20128", apiKey: null };
  saveContexts(cfg);
  const ctx = resolveActiveContext("staging");
  assert.equal(ctx.baseUrl, "http://staging:20128");
});

test("saveContextsSecure guarda tokens no keychain e resolve pela referência", async () => {
  const {
    loadContexts,
    saveContextsSecure,
    resolveActiveContext,
    setContextKeychainBackendForTests,
  } = await import("../../bin/cli/contexts.mjs");
  const entries = new Map<string, string>();
  const fakeKeychain = {
    async getPassword(_service: string, account: string) {
      return entries.get(account) || null;
    },
    async setPassword(_service: string, account: string, value: string) {
      entries.set(account, value);
    },
    async deletePassword(_service: string, account: string) {
      entries.delete(account);
      return true;
    },
  };
  await setContextKeychainBackendForTests(fakeKeychain);
  const cfg = loadContexts();
  cfg.contexts.secure = {
    baseUrl: "https://secure.example.com",
    accessToken: "oma_test_secret",
    scope: "write",
  };
  await saveContextsSecure(cfg);

  const persisted = JSON.parse(readFileSync(join(tmpDir, "config.json"), "utf8"));
  assert.equal(persisted.contexts.secure.accessToken, undefined);
  assert.match(persisted.contexts.secure.credentialRef, /^omniroute-cli:context:/);
  assert.equal(resolveActiveContext("secure").accessToken, "oma_test_secret");
  assert.ok(entries.size >= 1);

  await setContextKeychainBackendForTests(null);
});

test("contexts.mjs (commands) pode ser importado sem erro", async () => {
  const mod = await import("../../bin/cli/commands/contexts.mjs");
  assert.equal(typeof mod.registerContexts, "function");
});

test("context export redaction covers canonical and legacy profile schemas", async () => {
  const { redactContextSecrets } = await import("../../bin/cli/commands/contexts.mjs");
  const redacted = redactContextSecrets({
    contexts: { remote: { accessToken: "oma-secret", apiKey: "sk-secret" } },
    profiles: { legacy: { accessToken: "legacy-secret", apiKey: "legacy-key" } },
  });
  assert.deepEqual(redacted.contexts.remote, { apiKey: null });
  assert.deepEqual(redacted.profiles.legacy, { apiKey: null });
});

test("confirm() declines cleanly on non-interactive stdin (no hung await)", async () => {
  // Regression: `contexts remove` without --yes used to prompt even when stdin
  // could not answer (pipe/CI/EOF), leaving the readline question pending and
  // triggering Node's "unsettled top-level await" warning. With a non-TTY stdin
  // confirm() must resolve to false immediately (decline) without touching
  // readline — `--yes` remains the way to proceed non-interactively.
  const { confirm } = await import("../../bin/cli/commands/contexts.mjs");
  const desc = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  try {
    const result = await confirm("Remove context 'x'?");
    assert.equal(result, false);
  } finally {
    if (desc) Object.defineProperty(process.stdin, "isTTY", desc);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
  }
});

test("registerContexts registers the singular `context` alias", async () => {
  // The connect output and older docs say `omniroute context current` (singular);
  // the command is `contexts`. An alias keeps the singular muscle-memory working.
  const { registerContexts } = await import("../../bin/cli/commands/contexts.mjs");
  let aliasName: string | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fakeCtx: any = {
    command() {
      return this;
    },
    alias(a: string) {
      aliasName = a;
      return this;
    },
    description() {
      return this;
    },
    requiredOption() {
      return this;
    },
    option() {
      return this;
    },
    action() {
      return this;
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fakeProgram: any = {
    command() {
      return fakeCtx;
    },
  };
  registerContexts(fakeProgram);
  assert.equal(aliasName, "context");
});

// All credentials below are synthetic. Tests capture command output and never
// call connect, providers, a real keychain, a D-Bus socket, or a user HOME.
const OLD_TOKEN = "FAKE_CONTEXT_OLD_TOKEN_DO_NOT_USE";
const NEW_TOKEN = "FAKE_CONTEXT_NEW_TOKEN_DO_NOT_USE";
const API_KEY = "FAKE_CONTEXT_API_KEY_DO_NOT_USE";
const FAKE_SECRETS = [OLD_TOKEN, NEW_TOKEN, API_KEY];
type StorageModule = typeof import("../../bin/cli/contexts.mjs");
type StorageFailure = Error & { code?: string; committed?: boolean; orphanedTemp?: boolean };
type StorageFixture = {
  mod: StorageModule;
  dir: string;
  file: string;
  logs: { out: string; err: string; failStderr: boolean };
};

function credentialConfig(token = OLD_TOKEN) {
  return {
    version: 1,
    currentContext: "remote",
    contexts: {
      default: { baseUrl: "http://127.0.0.1:9" },
      remote: { baseUrl: "http://127.0.0.1:9", accessToken: token, apiKey: API_KEY },
    },
  };
}

function assertNoSecretOutput(text: string) {
  for (const secret of FAKE_SECRETS)
    assert.ok(!text.includes(secret), "credential reached diagnostics");
}

function storageFailure(error: unknown, committed = false, code?: string) {
  assert.ok(error instanceof Error, "storage failures must be explicit errors");
  const failure = error as StorageFailure;
  assert.match(failure.code || "", /^ERR_CONTEXT_STORAGE_/);
  assert.equal(failure.committed, committed);
  if (code) assert.equal(failure.code, `ERR_CONTEXT_STORAGE_${code}`);
  assertNoSecretOutput(failure.message);
  return true;
}

async function withStorageFixture(
  t: TestContext,
  run: (fixture: StorageFixture) => void | Promise<void>
) {
  const before = process.env.DATA_DIR;
  const dir = mkdtempSync(join(tmpdir(), "omniroute-storage-"));
  process.env.DATA_DIR = dir;
  const mod = await import("../../bin/cli/contexts.mjs");
  const logs = { out: "", err: "", failStderr: false };
  t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
    logs.out += String(chunk);
    return true;
  });
  t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
    if (logs.failStderr) throw new Error(NEW_TOKEN);
    logs.err += String(chunk);
    return true;
  });
  try {
    await mod.setContextKeychainBackendForTests(null);
    await run({ mod, dir, file: join(dir, "config.json"), logs });
  } finally {
    t.mock.restoreAll();
    if (before === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = before;
    await mod.setContextKeychainBackendForTests(null);
    rmSync(dir, { recursive: true, force: true });
  }
}

function fakeKeychain() {
  const entries = new Map<string, string>();
  const writes: string[] = [];
  const removals: string[] = [];
  const backend = {
    async getPassword(service: string, account: string) {
      assert.equal(service, "omniroute-cli");
      return entries.get(account) || null;
    },
    async setPassword(service: string, account: string, value: string) {
      assert.equal(service, "omniroute-cli");
      writes.push(account);
      entries.set(account, value);
    },
    async deletePassword(service: string, account: string) {
      assert.equal(service, "omniroute-cli");
      removals.push(account);
      return entries.delete(account);
    },
  };
  return { backend, entries, writes, removals };
}

async function seedKeychain(fixture: StorageFixture) {
  const fake = fakeKeychain();
  await fixture.mod.setContextKeychainBackendForTests(fake.backend);
  await fixture.mod.saveContextsSecure(credentialConfig());
  const ref = fixture.mod.loadContexts().contexts.remote.credentialRef;
  return { ...fake, ref };
}

async function runContextCommand(args: string[]) {
  const { Command } = await import("commander");
  const { registerContexts } = await import("../../bin/cli/commands/contexts.mjs");
  const program = new Command().exitOverride();
  registerContexts(program);
  await program.parseAsync(["contexts", ...args], { from: "user" });
}

for (const mask of [0o000, 0o022, 0o077, 0o777]) {
  test(`plaintext fallback is private before bytes under umask${mask.toString(8)}`, async (t) => {
    await withStorageFixture(t, async ({ mod, dir, logs }) => {
      const data = join(dir, "new-parent", "data");
      process.env.DATA_DIR = data;
      const originalOpen = fs.openSync;
      const originalWrite = fs.writeFileSync;
      let secretWrites = 0;
      let tempCreates = 0;
      t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
        if (String(args[0]).endsWith(".tmp")) {
          const flags = Number(args[1]);
          assert.ok(flags & fs.constants.O_EXCL);
          assert.ok(flags & fs.constants.O_NOFOLLOW);
          assert.ok(flags & fs.constants.O_CREAT);
          assert.equal(args[2], 0o600);
          tempCreates++;
        }
        return originalOpen(...args);
      });
      t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
        assert.equal(typeof args[0], "number", "secret writes must use a verified descriptor");
        const info = fs.fstatSync(args[0] as number);
        assert.equal(info.mode & 0o7777, 0o600);
        assert.equal(info.uid, process.geteuid?.());
        assert.equal(info.nlink, 1);
        assert.ok(info.isFile());
        assert.equal(fs.statSync(data).mode & 0o7777, 0o700);
        secretWrites++;
        return originalWrite(...args);
      });
      const previousMask = process.umask(mask);
      try {
        const result = await mod.saveContextsSecure(credentialConfig());
        assert.equal(result.usedKeychain, false);
      } finally {
        process.umask(previousMask);
      }
      assert.equal(tempCreates, 1);
      assert.equal(secretWrites, 1);
      assert.equal(fs.statSync(mod.configPath()).mode & 0o7777, 0o600);
      assert.ok(mod.resolveActiveContext().accessToken === OLD_TOKEN);
      assert.match(logs.err, /plaintext.*0600/);
      assertNoSecretOutput(logs.err + logs.out);
    });
  });
}

test("only an owned DATA_DIR leaf is tightened; existing ancestors stay unchanged", async (t) => {
  await withStorageFixture(t, async ({ mod, dir }) => {
    const ancestor = join(dir, "ancestor");
    const data = join(ancestor, "data");
    fs.mkdirSync(ancestor, { mode: 0o755 });
    fs.mkdirSync(data, { mode: 0o755 });
    process.env.DATA_DIR = data;
    await mod.saveContextsSecure(credentialConfig());
    assert.equal(fs.statSync(data).mode & 0o7777, 0o700);
    assert.equal(fs.statSync(ancestor).mode & 0o7777, 0o755);
  });
});

for (const unsafe of [
  "file-symlink",
  "parent-symlink",
  "hardlink",
  "directory",
  "shared-ancestor",
]) {
  test(`unsafe ${unsafe} storage rejects without changing a victim`, async (t) => {
    await withStorageFixture(t, async ({ mod, dir, file, logs }) => {
      const victim = join(dir, "victim.json");
      const bytes = JSON.stringify(credentialConfig());
      fs.writeFileSync(victim, bytes, { mode: 0o600 });
      if (unsafe === "file-symlink") fs.symlinkSync(victim, file);
      if (unsafe === "hardlink") fs.linkSync(victim, file);
      if (unsafe === "directory") fs.mkdirSync(file, { mode: 0o700 });
      if (unsafe === "parent-symlink") {
        const link = join(dir, "linked");
        fs.symlinkSync(dir, link, "dir");
        process.env.DATA_DIR = link;
      }
      if (unsafe === "shared-ancestor") {
        const shared = join(dir, "shared");
        fs.mkdirSync(shared, { mode: 0o777 });
        fs.chmodSync(shared, 0o777);
        process.env.DATA_DIR = join(shared, "data");
      }
      assert.throws(
        () => mod.loadContexts(),
        (error) => storageFailure(error)
      );
      await assert.rejects(mod.saveContextsSecure(credentialConfig(NEW_TOKEN)), (error) =>
        storageFailure(error)
      );
      assert.ok(fs.readFileSync(victim, "utf8") === bytes);
      assert.equal(fs.statSync(victim).mode & 0o7777, 0o600);
      assertNoSecretOutput(logs.err + logs.out);
    });
  });
}

test("special-file metadata rejects before opening or reading the destination", async (t) => {
  await withStorageFixture(t, async ({ mod, file }) => {
    mod.saveContexts(credentialConfig());
    const originalStat = fs.lstatSync;
    const originalOpen = fs.openSync;
    let destinationOpens = 0;
    t.mock.method(fs, "lstatSync", (...args: Parameters<typeof fs.lstatSync>) => {
      const info = originalStat(...args);
      return String(args[0]) === file
        ? Object.assign(Object.create(info), { isFile: () => false })
        : info;
    });
    t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
      if (String(args[0]) === file) destinationOpens++;
      return originalOpen(...args);
    });
    assert.throws(
      () => mod.loadContexts(),
      (error) => storageFailure(error)
    );
    await assert.rejects(mod.saveContextsSecure(credentialConfig()), (error) =>
      storageFailure(error)
    );
    assert.equal(destinationOpens, 0);
  });
});

for (const wrongOwner of ["parent", "file", "temp-fd"]) {
  test(`wrong-owner ${wrongOwner} metadata rejects without writing`, async (t) => {
    await withStorageFixture(t, async ({ mod, dir, file }) => {
      mod.saveContexts(credentialConfig());
      const before = fs.readFileSync(file, "utf8");
      const originalStat = fs.lstatSync;
      const originalFstat = fs.fstatSync;
      const originalFchmod = fs.fchmodSync;
      let tempChmods = 0;
      if (wrongOwner === "temp-fd") {
        t.mock.method(fs, "fstatSync", (...args: Parameters<typeof fs.fstatSync>) => {
          const info = originalFstat(...args);
          return info.isFile() && info.size === 0
            ? Object.assign(Object.create(info), { uid: Number(info.uid) + 1 })
            : info;
        });
        t.mock.method(fs, "fchmodSync", (...args: Parameters<typeof fs.fchmodSync>) => {
          if (originalFstat(args[0]).isFile()) tempChmods++;
          return originalFchmod(...args);
        });
      } else {
        t.mock.method(fs, "lstatSync", (...args: Parameters<typeof fs.lstatSync>) => {
          const info = originalStat(...args);
          return String(args[0]) === (wrongOwner === "parent" ? dir : file)
            ? Object.assign(Object.create(info), { uid: Number(info.uid) + 1 })
            : info;
        });
      }
      await assert.rejects(mod.saveContextsSecure(credentialConfig(NEW_TOKEN)), (error) =>
        storageFailure(error)
      );
      assert.ok(fs.readFileSync(file, "utf8") === before);
      assert.equal(tempChmods, 0);
      assert.deepEqual(fs.readdirSync(dir), ["config.json"]);
    });
  });
}

for (const unsafe of ["malformed", "insecure-file", "insecure-parent", "invalid-schema"]) {
  test(`existing ${unsafe} data is not reset by either writer`, async (t) => {
    await withStorageFixture(t, async ({ mod, dir, file }) => {
      const bytes =
        unsafe === "malformed"
          ? "{invalid-json"
          : unsafe === "invalid-schema"
            ? '{"contexts":[]}'
            : JSON.stringify(credentialConfig());
      fs.writeFileSync(file, bytes, { mode: 0o600 });
      if (unsafe === "insecure-file") fs.chmodSync(file, 0o644);
      if (unsafe === "insecure-parent") fs.chmodSync(dir, 0o755);
      assert.throws(
        () => mod.loadContexts(),
        (error) => storageFailure(error)
      );
      assert.throws(
        () => mod.saveContexts(credentialConfig(NEW_TOKEN)),
        (error) => storageFailure(error)
      );
      await assert.rejects(mod.saveContextsSecure(credentialConfig(NEW_TOKEN)), (error) =>
        storageFailure(error)
      );
      assert.ok(fs.readFileSync(file, "utf8") === bytes);
      if (unsafe === "insecure-parent") assert.equal(fs.statSync(dir).mode & 0o7777, 0o755);
    });
  });
}

for (const failurePoint of ["open", "fchmod", "write", "file-fsync", "close", "rename"]) {
  test(`precommit ${failurePoint} failure preserves the old file and active credential`, async (t) => {
    await withStorageFixture(t, async (fixture) => {
      const { mod, dir, file, logs } = fixture;
      const fake = await seedKeychain(fixture);
      const oldBytes = fs.readFileSync(file, "utf8");
      const oldCredential = fake.entries.get(fake.ref);
      const cfg = mod.loadContexts();
      cfg.contexts.remote.accessToken = NEW_TOKEN;
      let injected = false;
      const fail = () => {
        injected = true;
        throw new Error(NEW_TOKEN);
      };
      if (failurePoint === "open") {
        const original = fs.openSync;
        t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
          if (!injected && String(args[0]).endsWith(".tmp")) return fail();
          return original(...args);
        });
      } else if (failurePoint === "fchmod") {
        const original = fs.fchmodSync;
        t.mock.method(fs, "fchmodSync", (...args: Parameters<typeof fs.fchmodSync>) => {
          if (!injected && fs.fstatSync(args[0]).isFile()) return fail();
          return original(...args);
        });
      } else if (failurePoint === "write") {
        t.mock.method(fs, "writeFileSync", fail);
      } else if (failurePoint === "file-fsync") {
        const original = fs.fsyncSync;
        t.mock.method(fs, "fsyncSync", (fd: number) => {
          if (!injected && fs.fstatSync(fd).isFile()) return fail();
          return original(fd);
        });
      } else if (failurePoint === "close") {
        const original = fs.closeSync;
        const originalOpen = fs.openSync;
        const temporaryFds = new Set<number>();
        t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
          const fd = originalOpen(...args);
          if (String(args[0]).endsWith(".tmp")) temporaryFds.add(fd);
          return fd;
        });
        t.mock.method(fs, "closeSync", (fd: number) => {
          if (!injected && temporaryFds.has(fd)) return fail();
          return original(fd);
        });
      } else {
        t.mock.method(fs, "renameSync", fail);
      }
      await assert.rejects(mod.saveContextsSecure(cfg), (error) => storageFailure(error));
      assert.ok(injected);
      assert.ok(fs.readFileSync(file, "utf8") === oldBytes);
      assert.ok(fake.entries.get(fake.ref) === oldCredential);
      assert.ok(mod.resolveActiveContext().accessToken === OLD_TOKEN);
      assert.equal(fake.entries.size, 1);
      assert.deepEqual(fs.readdirSync(dir), ["config.json"]);
      assertNoSecretOutput(logs.out + logs.err);
    });
  });
}

test("postcommit directory-fsync failure retains complete JSON and both old/new credentials", async (t) => {
  await withStorageFixture(t, async (fixture) => {
    const { mod, file, logs } = fixture;
    const fake = await seedKeychain(fixture);
    const cfg = mod.loadContexts();
    cfg.contexts.remote.accessToken = NEW_TOKEN;
    const originalFsync = fs.fsyncSync;
    t.mock.method(fs, "fsyncSync", (fd: number) => {
      if (fs.fstatSync(fd).isDirectory()) throw new Error(NEW_TOKEN);
      return originalFsync(fd);
    });
    await assert.rejects(mod.saveContextsSecure(cfg), (error) =>
      storageFailure(error, true, "DURABILITY")
    );
    const published = JSON.parse(fs.readFileSync(file, "utf8"));
    const newRef = published.contexts.remote.credentialRef;
    assert.notEqual(newRef, fake.ref);
    assert.ok(fake.entries.has(fake.ref));
    assert.ok(fake.entries.has(newRef));
    assert.ok(mod.resolveActiveContext().accessToken === NEW_TOKEN);
    assert.equal(fake.removals.length, 0);
    assertNoSecretOutput(logs.out + logs.err);
  });
});

test("a partially successful keychain failure uses safe mixed fallback without stale refs", async (t) => {
  await withStorageFixture(t, async (fixture) => {
    const { mod, file, logs } = fixture;
    const fake = await seedKeychain(fixture);
    const cfg = mod.loadContexts();
    cfg.contexts.remote.accessToken = NEW_TOKEN;
    cfg.contexts.second = {
      baseUrl: "http://127.0.0.1:9",
      accessToken: OLD_TOKEN,
      credentialRef: fake.ref,
    };
    const originalSet = fake.backend.setPassword;
    let count = 0;
    t.mock.method(fake.backend, "setPassword", async (...args: Parameters<typeof originalSet>) => {
      await originalSet(...args);
      if (++count === 2) throw new Error(NEW_TOKEN); // Stored first, then failed.
    });
    const result = await mod.saveContextsSecure(cfg);
    assert.equal(result.usedKeychain, false);
    const disk = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(disk.contexts.remote.accessToken, undefined);
    assert.ok(disk.contexts.second.accessToken === OLD_TOKEN);
    assert.equal(disk.contexts.second.credentialRef, undefined);
    assert.ok(mod.resolveActiveContext("second").accessToken === OLD_TOKEN);
    assert.ok(fake.entries.has(disk.contexts.remote.credentialRef));
    assert.equal(fake.entries.size, 2); // Old published + new published; failed stage removed.
    assert.equal(fake.removals.length, 1);
    assertNoSecretOutput(logs.out + logs.err);
    assert.match(logs.err, /plaintext/);
  });
});

test("failed update never lets an old cached ref replace new plaintext", async (t) => {
  await withStorageFixture(t, async (fixture) => {
    const fake = await seedKeychain(fixture);
    const cfg = fixture.mod.loadContexts();
    cfg.contexts.remote.accessToken = NEW_TOKEN;
    t.mock.method(fake.backend, "setPassword", async () => {
      throw new Error(NEW_TOKEN);
    });
    await fixture.mod.saveContextsSecure(cfg);
    assert.equal(fixture.mod.loadContexts().contexts.remote.credentialRef, undefined);
    assert.ok(fixture.mod.resolveActiveContext().accessToken === NEW_TOKEN);
    assert.ok(fake.entries.has(fake.ref));
    assertNoSecretOutput(fixture.logs.err + fixture.logs.out);
  });
});

test("a throwing postcommit warning cannot roll back a published staged credential", async (t) => {
  await withStorageFixture(t, async ({ mod, file, logs }) => {
    const fake = fakeKeychain();
    await mod.setContextKeychainBackendForTests(fake.backend);
    const cfg = credentialConfig();
    const combined = {
      ...cfg,
      profiles: { legacy: { baseUrl: "http://127.0.0.1:9", apiKey: API_KEY } },
    };
    const originalSet = fake.backend.setPassword;
    let count = 0;
    t.mock.method(fake.backend, "setPassword", async (...args: Parameters<typeof originalSet>) => {
      await originalSet(...args);
      if (++count === 2) throw new Error(NEW_TOKEN);
    });
    logs.failStderr = true;
    await assert.rejects(mod.saveContextsSecure(combined), (error) =>
      storageFailure(error, true, "WARNING")
    );
    const disk = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.ok(fake.entries.has(disk.contexts.remote.credentialRef));
    assert.ok(disk.profiles.legacy.apiKey === API_KEY);
    assert.ok(mod.resolveActiveContext().accessToken === OLD_TOKEN);
    assert.equal(fake.entries.size, 1);
  });
});

test("failed staged-entry cleanup is explicit and cannot mask the original failure", async (t) => {
  await withStorageFixture(t, async (fixture) => {
    const fake = await seedKeychain(fixture);
    const cfg = fixture.mod.loadContexts();
    cfg.contexts.remote.accessToken = NEW_TOKEN;
    t.mock.method(fs, "renameSync", () => {
      throw new Error(NEW_TOKEN);
    });
    t.mock.method(fake.backend, "deletePassword", async () => {
      throw new Error(NEW_TOKEN);
    });
    await assert.rejects(fixture.mod.saveContextsSecure(cfg), (error) => storageFailure(error));
    assert.ok(fake.entries.has(fake.ref));
    assert.match(fixture.logs.err, /unused OS-keychain context entry/);
    assertNoSecretOutput(fixture.logs.err + fixture.logs.out);
  });
});

test("failed temp cleanup reports a private orphan without changing the old config", async (t) => {
  await withStorageFixture(t, async ({ mod, file }) => {
    mod.saveContexts(credentialConfig());
    const before = fs.readFileSync(file, "utf8");
    t.mock.method(fs, "renameSync", () => {
      throw new Error(NEW_TOKEN);
    });
    t.mock.method(fs, "unlinkSync", () => {
      throw new Error(NEW_TOKEN);
    });
    assert.throws(
      () => mod.saveContexts(credentialConfig(NEW_TOKEN)),
      (error) => {
        storageFailure(error);
        assert.equal((error as StorageFailure).orphanedTemp, true);
        assert.match((error as Error).message, /private temporary file/);
        return true;
      }
    );
    assert.ok(fs.readFileSync(file, "utf8") === before);
  });
});

test("mixed canonical/legacy schemas move all supported credentials into the fake keychain", async (t) => {
  await withStorageFixture(t, async ({ mod, file, logs }) => {
    const fake = fakeKeychain();
    await mod.setContextKeychainBackendForTests(fake.backend);
    const cfg = {
      ...credentialConfig(),
      profiles: { legacy: { baseUrl: "http://127.0.0.1:9", apiKey: API_KEY } },
    };
    await mod.saveContextsSecure(cfg);
    const raw = fs.readFileSync(file, "utf8");
    assertNoSecretOutput(raw);
    const disk = JSON.parse(raw);
    assert.ok(disk.contexts.remote.credentialRef);
    assert.ok(disk.profiles.legacy.credentialRef);
    assert.equal(fake.entries.size, 2);
    await mod.setContextKeychainBackendForTests(fake.backend);
    assert.ok(mod.resolveActiveContext().accessToken === OLD_TOKEN);
    assertNoSecretOutput(logs.err + logs.out);
  });
});

test("legacy profile migration and no-op migration preserve result semantics", async (t) => {
  await withStorageFixture(t, async ({ mod, logs }) => {
    mod.saveContexts({
      activeProfile: "legacy",
      profiles: { legacy: { baseUrl: "http://127.0.0.1:9", apiKey: API_KEY } },
    });
    const fake = fakeKeychain();
    await mod.setContextKeychainBackendForTests(fake.backend);
    const result = await mod.migrateContextCredentials();
    assert.equal(result.migrated, true);
    assert.equal(result.pending, true);
    assert.equal(mod.loadContexts().profiles, undefined);
    assert.ok(mod.resolveActiveContext().apiKey === API_KEY);
    const second = await mod.migrateContextCredentials();
    assert.equal(second.migrated, false);
    assert.equal(second.pending, false);
    assertNoSecretOutput(logs.err + logs.out);
  });
});

test("invalid later context names fail before any keychain side effect", async (t) => {
  await withStorageFixture(t, async ({ mod, file, logs }) => {
    const fake = fakeKeychain();
    await mod.setContextKeychainBackendForTests(fake.backend);
    const cfg = { ...credentialConfig(), profiles: { ["\ud800"]: { apiKey: API_KEY } } };
    await assert.rejects(mod.saveContextsSecure(cfg), (error) =>
      storageFailure(error, false, "INVALID")
    );
    assert.equal(fake.writes.length, 0);
    assert.equal(fs.existsSync(file), false);
    assertNoSecretOutput(logs.err + logs.out);
  });
});

test("save snapshots config values and DATA_DIR across backend awaits", async (t) => {
  await withStorageFixture(t, async ({ mod, dir, file }) => {
    const fake = fakeKeychain();
    await mod.setContextKeychainBackendForTests(fake.backend);
    const other = join(dir, "other");
    fs.mkdirSync(other, { mode: 0o700 });
    const originalSet = fake.backend.setPassword;
    t.mock.method(fake.backend, "setPassword", async (...args: Parameters<typeof originalSet>) => {
      process.env.DATA_DIR = other;
      await originalSet(...args);
    });
    const cfg = credentialConfig();
    const pending = mod.saveContextsSecure(cfg);
    cfg.contexts.remote.accessToken = NEW_TOKEN;
    await pending;
    assert.equal(fs.existsSync(join(other, "config.json")), false);
    const disk = JSON.parse(fs.readFileSync(file, "utf8"));
    const credential = JSON.parse(fake.entries.get(disk.contexts.remote.credentialRef) || "{}");
    assert.ok(credential.accessToken === OLD_TOKEN);
    process.env.DATA_DIR = dir;
    assert.ok(mod.resolveActiveContext().accessToken === OLD_TOKEN);
  });
});

test("overlapping secure saves serialize backend operations without deleting published refs", async (t) => {
  await withStorageFixture(t, async ({ mod }) => {
    const fake = fakeKeychain();
    await mod.setContextKeychainBackendForTests(fake.backend);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const originalSet = fake.backend.setPassword;
    let active = 0;
    let maximum = 0;
    t.mock.method(fake.backend, "setPassword", async (...args: Parameters<typeof originalSet>) => {
      active++;
      maximum = Math.max(maximum, active);
      if (fake.writes.length === 0) {
        entered();
        await gate;
      }
      await originalSet(...args);
      active--;
    });
    const first = mod.saveContextsSecure(credentialConfig());
    await started;
    const second = mod.saveContextsSecure(credentialConfig(NEW_TOKEN));
    release();
    await Promise.all([first, second]);
    assert.equal(maximum, 1);
    assert.equal(fake.entries.size, 2);
    assert.equal(fake.removals.length, 0);
    assert.ok(mod.resolveActiveContext().accessToken === NEW_TOKEN);
  });
});

for (const failCommit of [false, true]) {
  test(`real Commander remove ${failCommit ? "failure retains" : "commit retires"} its old credential`, async (t) => {
    await withStorageFixture(t, async (fixture) => {
      const fake = await seedKeychain(fixture);
      const before = fs.readFileSync(fixture.file, "utf8");
      const originalDelete = fake.backend.deletePassword;
      t.mock.method(
        fake.backend,
        "deletePassword",
        async (...args: Parameters<typeof originalDelete>) => {
          assert.equal(
            fixture.mod.loadContexts().contexts.remote,
            undefined,
            "retirement requires publication first"
          );
          return originalDelete(...args);
        }
      );
      if (failCommit) {
        t.mock.method(fs, "renameSync", () => {
          throw new Error(NEW_TOKEN);
        });
        await assert.rejects(runContextCommand(["remove", "remote", "--yes"]), (error) =>
          storageFailure(error)
        );
        assert.ok(fs.readFileSync(fixture.file, "utf8") === before);
        assert.ok(fake.entries.has(fake.ref));
        assert.equal(fake.removals.length, 0);
        assert.doesNotMatch(fixture.logs.out, /Removed context/);
        assert.ok(fixture.mod.resolveActiveContext().accessToken === OLD_TOKEN);
      } else {
        await runContextCommand(["remove", "remote", "--yes"]);
        assert.equal(fixture.mod.loadContexts().contexts.remote, undefined);
        assert.equal(fake.entries.has(fake.ref), false);
        assert.deepEqual(fake.removals, [fake.ref]);
        assert.match(fixture.logs.out, /Removed context/);
      }
      assertNoSecretOutput(fixture.logs.out + fixture.logs.err);
    });
  });
}

test("retirement is cancelled if another context/profile still publishes the reference", async (t) => {
  await withStorageFixture(t, async (fixture) => {
    const fake = await seedKeychain(fixture);
    const cfg = fixture.mod.loadContexts();
    cfg.profiles = { legacy: { baseUrl: "http://127.0.0.1:9", credentialRef: fake.ref } };
    await fixture.mod.saveContextsSecure(cfg);
    await runContextCommand(["remove", "remote", "--yes"]);
    assert.ok(fake.entries.has(fake.ref));
    assert.equal(fake.removals.length, 0);
    assert.equal(fixture.mod.loadContexts().profiles.legacy.credentialRef, fake.ref);
  });
});

test("postcommit removal durability failure retains its old keychain entry", async (t) => {
  await withStorageFixture(t, async (fixture) => {
    const fake = await seedKeychain(fixture);
    const originalFsync = fs.fsyncSync;
    t.mock.method(fs, "fsyncSync", (fd: number) => {
      if (fs.fstatSync(fd).isDirectory()) throw new Error(NEW_TOKEN);
      return originalFsync(fd);
    });
    await assert.rejects(runContextCommand(["remove", "remote", "--yes"]), (error) =>
      storageFailure(error, true, "DURABILITY")
    );
    assert.equal(fixture.mod.loadContexts().contexts.remote, undefined);
    assert.ok(fake.entries.has(fake.ref));
    assert.equal(fake.removals.length, 0);
    assert.doesNotMatch(fixture.logs.out, /Removed context/);
  });
});

test("successful removal rejects a stale same-process reference instead of republishing it", async (t) => {
  await withStorageFixture(t, async (fixture) => {
    await seedKeychain(fixture);
    const stale = fixture.mod.loadContexts();
    await runContextCommand(["remove", "remote", "--yes"]);
    await assert.rejects(fixture.mod.saveContextsSecure(stale), (error) =>
      storageFailure(error, false, "STALE")
    );
    assert.throws(
      () => fixture.mod.saveContexts(stale),
      (error) => storageFailure(error, false, "STALE")
    );
    assert.equal(fixture.mod.loadContexts().contexts.remote, undefined);
  });
});

for (const destination of ["stdout", "file"]) {
  test(`real Commander --no-secrets redacts both schemas in ${destination}`, async (t) => {
    await withStorageFixture(t, async ({ mod, dir, logs }) => {
      mod.saveContexts({
        ...credentialConfig(),
        profiles: { legacy: { apiKey: API_KEY, accessToken: NEW_TOKEN } },
      });
      const target = join(dir, "export.json");
      await runContextCommand([
        "export",
        "--no-secrets",
        ...(destination === "file" ? ["--out", target] : []),
      ]);
      const output = destination === "file" ? fs.readFileSync(target, "utf8") : logs.out;
      assertNoSecretOutput(output + logs.err);
      const exported = JSON.parse(output);
      assert.equal(exported.contexts.remote.apiKey, null);
      assert.equal(exported.contexts.remote.accessToken, undefined);
      assert.equal(exported.profiles.legacy.apiKey, null);
      assert.equal(exported.profiles.legacy.accessToken, undefined);
      if (destination === "file") assert.equal(fs.statSync(target).mode & 0o7777, 0o600);
    });
  });
}

test("intentional unredacted stdout/file exports retain credentials without diagnostic logging", async (t) => {
  await withStorageFixture(t, async ({ mod, dir, logs }) => {
    mod.saveContexts(credentialConfig());
    await runContextCommand(["export"]);
    assert.ok(JSON.parse(logs.out).contexts.remote.accessToken === OLD_TOKEN);
    logs.out = "";
    const target = join(dir, "explicit-secret-export.json");
    await runContextCommand(["export", "--out", target]);
    assert.ok(
      JSON.parse(fs.readFileSync(target, "utf8")).contexts.remote.accessToken === OLD_TOKEN
    );
    assert.equal(fs.statSync(target).mode & 0o7777, 0o600);
    assertNoSecretOutput(logs.out + logs.err);
  });
});

test("export refuses a permissive existing parent without chmod or success output", async (t) => {
  await withStorageFixture(t, async ({ mod, dir, logs }) => {
    mod.saveContexts(credentialConfig());
    const parent = join(dir, "public-output");
    fs.mkdirSync(parent, { mode: 0o755 });
    const output = join(parent, "out.json");
    await assert.rejects(runContextCommand(["export", "--out", output]), (error) =>
      storageFailure(error)
    );
    assert.equal(fs.statSync(parent).mode & 0o7777, 0o755);
    assert.equal(fs.existsSync(output), false);
    assert.doesNotMatch(logs.out, /Exported to/);
    assertNoSecretOutput(logs.out + logs.err);
  });
});

test("export rejects linked output and preserves an old output on rename failure", async (t) => {
  await withStorageFixture(t, async ({ mod, dir, logs }) => {
    mod.saveContexts(credentialConfig());
    const victim = join(dir, "victim-export.json");
    fs.writeFileSync(victim, "unchanged", { mode: 0o600 });
    const linked = join(dir, "linked-export.json");
    fs.symlinkSync(victim, linked);
    await assert.rejects(runContextCommand(["export", "--out", linked]), (error) =>
      storageFailure(error)
    );
    assert.equal(fs.readFileSync(victim, "utf8"), "unchanged");
    t.mock.method(fs, "renameSync", () => {
      throw new Error(NEW_TOKEN);
    });
    await assert.rejects(runContextCommand(["export", "--out", victim]), (error) =>
      storageFailure(error)
    );
    assert.equal(fs.readFileSync(victim, "utf8"), "unchanged");
    assert.doesNotMatch(logs.out, /Exported to/);
    assertNoSecretOutput(logs.out + logs.err);
  });
});

test("Windows branch rejects raw file bytes, including toJSON, but keeps fake-keychain metadata usable", async (t) => {
  await withStorageFixture(t, async ({ mod, dir, file, logs }) => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      await assert.rejects(mod.saveContextsSecure(credentialConfig()), (error) =>
        storageFailure(error, false, "UNSUPPORTED")
      );
      assert.equal(fs.existsSync(file), false);
      assert.throws(
        () => mod.saveContexts({ toJSON: () => credentialConfig() }),
        (error) => storageFailure(error, false, "UNSUPPORTED")
      );
      const output = join(dir, "windows-export.json");
      assert.throws(
        () => mod.writeContextExportFile(output, { toJSON: () => credentialConfig() }),
        (error) => storageFailure(error, false, "UNSUPPORTED")
      );
      assert.equal(fs.existsSync(output), false);
      const fake = fakeKeychain();
      await mod.setContextKeychainBackendForTests(fake.backend);
      const result = await mod.saveContextsSecure(credentialConfig());
      assert.equal(result.usedKeychain, true);
      assertNoSecretOutput(fs.readFileSync(file, "utf8"));
      assert.ok(mod.resolveActiveContext().accessToken === OLD_TOKEN);
      assertNoSecretOutput(logs.err + logs.out);
    } finally {
      if (descriptor) Object.defineProperty(process, "platform", descriptor);
    }
    // This is branch coverage on native Linux, NOT a Windows ACL/native proof.
  });
});

test("backend read failure stays optional and falls back without keychain or diagnostic leakage", async (t) => {
  await withStorageFixture(t, async (fixture) => {
    const fake = await seedKeychain(fixture);
    t.mock.method(fake.backend, "getPassword", async () => {
      throw new Error(NEW_TOKEN);
    });
    await fixture.mod.setContextKeychainBackendForTests(fake.backend);
    assert.equal(fixture.mod.getContextKeychainStatus().available, false);
    const cfg = fixture.mod.loadContexts();
    cfg.contexts.remote.accessToken = NEW_TOKEN;
    const result = await fixture.mod.saveContextsSecure(cfg);
    assert.equal(result.usedKeychain, false);
    assert.equal(fake.writes.length, 1);
    assert.ok(fixture.mod.resolveActiveContext().accessToken === NEW_TOKEN);
    assertNoSecretOutput(fixture.logs.out + fixture.logs.err);
  });
});

test("existing read errors are surfaced before backend mutation, not converted to defaults", async (t) => {
  await withStorageFixture(t, async (fixture) => {
    const fake = await seedKeychain(fixture);
    const originalRead = fs.readFileSync;
    const oldBytes = originalRead(fixture.file, "utf8");
    t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
      if (typeof args[0] === "number")
        throw Object.assign(new Error(NEW_TOKEN), { code: "EACCES" });
      return originalRead(...args);
    });
    assert.throws(
      () => fixture.mod.loadContexts(),
      (error) => storageFailure(error)
    );
    await assert.rejects(fixture.mod.saveContextsSecure(credentialConfig(NEW_TOKEN)), (error) =>
      storageFailure(error)
    );
    assert.equal(fake.writes.length, 1);
    assert.ok(originalRead(fixture.file, "utf8") === oldBytes);
    assertNoSecretOutput(fixture.logs.out + fixture.logs.err);
  });
});

test("exclusive temp-name collisions are bounded and never remove someone else's file", async (t) => {
  await withStorageFixture(t, async ({ mod, dir, file }) => {
    mod.saveContexts(credentialConfig());
    const before = fs.readFileSync(file, "utf8");
    const originalOpen = fs.openSync;
    let attempts = 0;
    t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
      if (String(args[0]).endsWith(".tmp")) {
        attempts++;
        throw Object.assign(new Error(NEW_TOKEN), { code: "EEXIST" });
      }
      return originalOpen(...args);
    });
    assert.throws(
      () => mod.saveContexts(credentialConfig(NEW_TOKEN)),
      (error) => storageFailure(error)
    );
    assert.equal(attempts, 3);
    assert.ok(fs.readFileSync(file, "utf8") === before);
    assert.deepEqual(fs.readdirSync(dir), ["config.json"]);
  });
});

test("all retirement refs are guarded before the first asynchronous cleanup", async (t) => {
  await withStorageFixture(t, async (fixture) => {
    const { mod, dir, logs } = fixture;
    const fake = await seedKeychain(fixture);
    const cfg = mod.loadContexts();
    cfg.contexts.second = { baseUrl: "http://127.0.0.1:9", accessToken: OLD_TOKEN };
    await mod.saveContextsSecure(cfg);
    const before = mod.loadContexts();
    const refs = [before.contexts.remote.credentialRef, before.contexts.second.credentialRef];
    await mod.deleteContextCredential("remote", before.contexts.remote);
    await mod.deleteContextCredential("second", before.contexts.second);
    const next = credentialConfig(NEW_TOKEN);
    next.contexts.remote = { ...next.contexts.remote };
    const update = { ...next, profiles: { fail: { apiKey: API_KEY } } };
    const originalSet = fake.backend.setPassword;
    let stagedCount = 0;
    let failedRef = "";
    t.mock.method(fake.backend, "setPassword", async (...args: Parameters<typeof originalSet>) => {
      await originalSet(...args);
      if (++stagedCount === 2) {
        failedRef = args[1];
        throw new Error(NEW_TOKEN);
      }
    });
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const originalDelete = fake.backend.deletePassword;
    t.mock.method(
      fake.backend,
      "deletePassword",
      async (...args: Parameters<typeof originalDelete>) => {
        if (args[1] === failedRef) {
          entered();
          await gate;
        }
        return originalDelete(...args);
      }
    );
    const pending = mod.saveContextsSecure(update);
    await started;
    try {
      for (const ref of refs) {
        const stale = {
          contexts: { stale: { baseUrl: "http://127.0.0.1:9", credentialRef: ref } },
        };
        assert.throws(
          () => mod.saveContexts(stale),
          (error) => storageFailure(error, false, "STALE")
        );
        assert.throws(
          () => mod.writeContextExportFile(join(dir, "stale-export.json"), stale),
          (error) => storageFailure(error, false, "STALE")
        );
      }
    } finally {
      release();
      await pending;
    }
    assert.ok(refs.every((ref) => !fake.entries.has(ref)));
    assert.equal(fake.entries.size, 1);
    assertNoSecretOutput(logs.out + logs.err);
  });
});

test("a retirement request cannot delete a ref after an unmatched config revision", async (t) => {
  await withStorageFixture(t, async (fixture) => {
    const fake = await seedKeychain(fixture);
    const cfg = fixture.mod.loadContexts();
    await fixture.mod.deleteContextCredential("remote", cfg.contexts.remote);
    cfg.contexts.remote.description = "another local update";
    fixture.mod.saveContexts(cfg);
    delete cfg.contexts.remote;
    cfg.currentContext = "default";
    await fixture.mod.saveContextsSecure(cfg);
    assert.equal(fixture.mod.loadContexts().contexts.remote, undefined);
    assert.ok(fake.entries.has(fake.ref));
    assert.equal(fake.removals.length, 0);
  });
});

test("a cleanup-warning failure preserves the precommit error and old credential", async (t) => {
  await withStorageFixture(t, async (fixture) => {
    const fake = await seedKeychain(fixture);
    const cfg = fixture.mod.loadContexts();
    cfg.contexts.remote.accessToken = NEW_TOKEN;
    t.mock.method(fs, "renameSync", () => {
      throw new Error(NEW_TOKEN);
    });
    t.mock.method(fake.backend, "deletePassword", async () => {
      throw new Error(NEW_TOKEN);
    });
    fixture.logs.failStderr = true;
    await assert.rejects(fixture.mod.saveContextsSecure(cfg), (error) =>
      storageFailure(error, false, "UNSAFE")
    );
    assert.ok(fake.entries.has(fake.ref));
    assert.ok(fixture.mod.resolveActiveContext().accessToken === OLD_TOKEN);
  });
});

test("Windows branch keeps a removed keychain entry when directory durability is unproven", async (t) => {
  await withStorageFixture(t, async (fixture) => {
    const fake = await seedKeychain(fixture);
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      await runContextCommand(["remove", "remote", "--yes"]);
      assert.equal(fixture.mod.loadContexts().contexts.remote, undefined);
      assert.ok(fake.entries.has(fake.ref));
      assert.equal(fake.removals.length, 0);
      assert.match(fixture.logs.err, /unused OS-keychain context entry/);
      assertNoSecretOutput(fixture.logs.err + fixture.logs.out);
    } finally {
      if (descriptor) Object.defineProperty(process, "platform", descriptor);
    }
  });
});

for (const unsafe of ["type", "owner", "links"]) {
  test(`safe-read descriptor rejects bad ${unsafe} before bytes or keychain hydration`, async (t) => {
    await withStorageFixture(t, async (fixture) => {
      const fake = await seedKeychain(fixture);
      const originalOpen = fs.openSync;
      const originalFstat = fs.fstatSync;
      const originalRead = fs.readFileSync;
      let destinationOpens = 0;
      let credentialReads = 0;
      let fileReads = 0;
      t.mock.method(fake.backend, "getPassword", async () => {
        credentialReads++;
        return null;
      });
      t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
        if (String(args[0]) === fixture.file) {
          const flags = Number(args[1]);
          assert.ok(flags & fs.constants.O_NOFOLLOW);
          assert.ok(flags & fs.constants.O_NONBLOCK);
          destinationOpens++;
        }
        return originalOpen(...args);
      });
      t.mock.method(fs, "fstatSync", (...args: Parameters<typeof fs.fstatSync>) => {
        const info = originalFstat(...args);
        if (!info.isFile()) return info;
        return Object.assign(
          Object.create(info),
          unsafe === "type"
            ? { isFile: () => false }
            : unsafe === "owner"
              ? { uid: Number(info.uid) + 1 }
              : { nlink: 2 }
        );
      });
      t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
        fileReads++;
        return originalRead(...args);
      });
      assert.throws(
        () => fixture.mod.loadContexts(),
        (error) => storageFailure(error)
      );
      await assert.rejects(fixture.mod.setContextKeychainBackendForTests(fake.backend), (error) =>
        storageFailure(error)
      );
      assert.equal(destinationOpens, 2);
      assert.equal(fileReads, 0);
      assert.equal(credentialReads, 0);
    });
  });
}

test("Windows partial keychain failure preserves old config/credential and cleans only unpublished stages", async (t) => {
  await withStorageFixture(t, async (fixture) => {
    const fake = await seedKeychain(fixture);
    const oldBytes = fs.readFileSync(fixture.file, "utf8");
    const oldCredential = fake.entries.get(fake.ref);
    const cfg = fixture.mod.loadContexts();
    cfg.contexts.remote.accessToken = NEW_TOKEN;
    cfg.profiles = { fail: { apiKey: API_KEY } };
    const originalSet = fake.backend.setPassword;
    let count = 0;
    t.mock.method(fake.backend, "setPassword", async (...args: Parameters<typeof originalSet>) => {
      await originalSet(...args);
      if (++count === 2) throw new Error(NEW_TOKEN);
    });
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      await assert.rejects(fixture.mod.saveContextsSecure(cfg), (error) =>
        storageFailure(error, false, "UNSUPPORTED")
      );
      assert.ok(fs.readFileSync(fixture.file, "utf8") === oldBytes);
      assert.ok(fake.entries.get(fake.ref) === oldCredential);
      assert.equal(fake.entries.size, 1);
      assert.equal(fake.removals.length, 2);
      assert.ok(fixture.mod.resolveActiveContext().accessToken === OLD_TOKEN);
      assertNoSecretOutput(fixture.logs.err + fixture.logs.out);
    } finally {
      if (descriptor) Object.defineProperty(process, "platform", descriptor);
    }
  });
});

test("a newer synchronous update during staging wins over the stale async publication", async (t) => {
  await withStorageFixture(t, async (fixture) => {
    const fake = await seedKeychain(fixture);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const originalSet = fake.backend.setPassword;
    t.mock.method(fake.backend, "setPassword", async (...args: Parameters<typeof originalSet>) => {
      await originalSet(...args);
      entered();
      await gate;
    });
    const cfg = fixture.mod.loadContexts();
    cfg.contexts.remote.accessToken = NEW_TOKEN;
    const pending = fixture.mod.saveContextsSecure(cfg);
    const rejected = assert.rejects(pending, (error) => storageFailure(error, false, "STALE"));
    await started;
    let newerBytes = "";
    try {
      const newer = fixture.mod.loadContexts();
      newer.contexts.default.description = "newer synchronous update";
      fixture.mod.saveContexts(newer);
      newerBytes = fs.readFileSync(fixture.file, "utf8");
    } finally {
      release();
      await rejected;
    }
    assert.ok(fs.readFileSync(fixture.file, "utf8") === newerBytes);
    assert.ok(fake.entries.has(fake.ref));
    assert.equal(fake.entries.size, 1);
    assert.ok(fixture.mod.resolveActiveContext().accessToken === OLD_TOKEN);
  });
});

for (const brokenWarning of [false, true]) {
  test(`postcommit retirement failure ${brokenWarning ? "with broken warning stays marked" : "has fixed diagnostics"}`, async (t) => {
    await withStorageFixture(t, async (fixture) => {
      const fake = await seedKeychain(fixture);
      const oldCfg = fixture.mod.loadContexts();
      t.mock.method(fake.backend, "deletePassword", async (_service: string, ref: string) => {
        fake.entries.delete(ref); // A backend may mutate and then fail.
        throw new Error(NEW_TOKEN);
      });
      fixture.logs.failStderr = brokenWarning;
      if (brokenWarning) {
        await assert.rejects(runContextCommand(["remove", "remote", "--yes"]), (error) =>
          storageFailure(error, true, "WARNING")
        );
        assert.doesNotMatch(fixture.logs.out, /Removed context/);
      } else {
        await runContextCommand(["remove", "remote", "--yes"]);
        assert.match(fixture.logs.err, /unused OS-keychain context entry/);
      }
      assert.equal(fixture.mod.loadContexts().contexts.remote, undefined);
      assert.equal(fake.entries.has(fake.ref), false);
      assert.throws(
        () => fixture.mod.saveContexts(oldCfg),
        (error) => storageFailure(error, false, "STALE")
      );
      assertNoSecretOutput(fixture.logs.err + fixture.logs.out);
    });
  });
}

test("partial temp write plus ENOSPC preserves the old complete config", async (t) => {
  await withStorageFixture(t, async ({ mod, dir, file }) => {
    mod.saveContexts(credentialConfig());
    const before = fs.readFileSync(file, "utf8");
    let partialWrites = 0;
    t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
      assert.equal(typeof args[0], "number");
      const fd = args[0] as number;
      assert.equal(fs.fstatSync(fd).mode & 0o7777, 0o600);
      fs.writeSync(fd, '{"partial":');
      partialWrites++;
      throw Object.assign(new Error(NEW_TOKEN), { code: "ENOSPC" });
    });
    assert.throws(
      () => mod.saveContexts(credentialConfig(NEW_TOKEN)),
      (error) => storageFailure(error)
    );
    assert.equal(partialWrites, 1);
    assert.ok(fs.readFileSync(file, "utf8") === before);
    assert.deepEqual(fs.readdirSync(dir), ["config.json"]);
  });
});

test("changed parent identity before rename rejects publication and preserves the old file", async (t) => {
  await withStorageFixture(t, async ({ mod, dir, file }) => {
    mod.saveContexts(credentialConfig());
    const before = fs.readFileSync(file, "utf8");
    const originalWrite = fs.writeFileSync;
    const originalStat = fs.lstatSync;
    let written = false;
    t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
      const result = originalWrite(...args);
      written = true;
      return result;
    });
    t.mock.method(fs, "lstatSync", (...args: Parameters<typeof fs.lstatSync>) => {
      const info = originalStat(...args);
      return written && String(args[0]) === dir
        ? Object.assign(Object.create(info), { ino: Number(info.ino) + 1 })
        : info;
    });
    assert.throws(
      () => mod.saveContexts(credentialConfig(NEW_TOKEN)),
      (error) => storageFailure(error)
    );
    assert.ok(fs.readFileSync(file, "utf8") === before);
    assert.deepEqual(fs.readdirSync(dir), ["config.json"]);
  });
});

test("missing-config reads do not create the configured directory", async (t) => {
  await withStorageFixture(t, async ({ mod, dir }) => {
    const absent = join(dir, "absent", "data");
    process.env.DATA_DIR = absent;
    assert.equal(mod.loadContexts().currentContext, "default");
    assert.equal(fs.existsSync(join(dir, "absent")), false);
  });
});

for (const action of ["add", "import"]) {
  test(`real Commander ${action} does not report success after persistence failure`, async (t) => {
    await withStorageFixture(t, async (fixture) => {
      const fake = await seedKeychain(fixture);
      const before = fs.readFileSync(fixture.file, "utf8");
      let args: string[];
      if (action === "add") {
        args = ["add", "fixture-new", "--url", "http://127.0.0.1:9", "--access-token", NEW_TOKEN];
      } else {
        const input = join(fixture.dir, "incoming.json");
        fs.writeFileSync(input, JSON.stringify(credentialConfig(NEW_TOKEN)), { mode: 0o600 });
        args = ["import", input];
      }
      t.mock.method(fs, "renameSync", () => {
        throw new Error(NEW_TOKEN);
      });
      await assert.rejects(runContextCommand(args), (error) => storageFailure(error));
      assert.ok(fs.readFileSync(fixture.file, "utf8") === before);
      assert.ok(fake.entries.has(fake.ref));
      assert.doesNotMatch(fixture.logs.out, /Added|Imported/);
      assertNoSecretOutput(fixture.logs.err + fixture.logs.out);
    });
  });
}
