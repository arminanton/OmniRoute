import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

// All external process entrypoints are blocked before importing the module.
// Tests must never signal a real PID or launch a real tailscaled/net/sudo/kill.
const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");
const modulePath = path.join(process.cwd(), "src/lib/tailscaleTunnel.ts");
const originalExecFile = childProcess.execFile;
const originalExecFileSync = childProcess.execFileSync;
const originalSpawn = childProcess.spawn;
const originalKill = process.kill;
const originalPlatform = os.platform;
const originalDataDir = process.env.DATA_DIR;
const originalNoSudo = process.env.OMNIROUTE_NO_SUDO;
const originalTailscaleBin = process.env.TAILSCALE_BIN;
let dataDir = "";
let calls: Array<{ command: string; args: string[] }> = [];
let alive = false;
let allowedPid = 0;
let signalHandler: (signal?: NodeJS.Signals | number) => void = () => {};
let spawnHandler: (command: string, args: string[]) => void = () => {};

function installProcessMocks() {
  childProcess.execFile = (command, args, options, callback) => {
    calls.push({ command: String(command), args: Array.from(args ?? [], String) });
    (typeof options === "function" ? options : callback)?.(null, "", "");
  };
  childProcess.execFile[promisify.custom] = async (command, args) => {
    calls.push({ command: String(command), args: Array.from(args ?? [], String) });
    return { stdout: "", stderr: "" };
  };
  childProcess.execFileSync = (command, args) => {
    calls.push({ command: String(command), args: Array.from(args ?? [], String) });
    if (String(command) === "sh") return Buffer.from("/usr/bin/sudo\n");
    throw new Error("unexpected synchronous child process");
  };
  childProcess.spawn = (command, args) => {
    const argv = Array.from(args ?? [], String);
    calls.push({ command: String(command), args: argv });
    spawnHandler(String(command), argv);
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
    };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    queueMicrotask(() => child.emit("close", 0));
    return child;
  };
  syncBuiltinESMExports();
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    assert.equal(pid, allowedPid, "an unrelated host PID must not be probed or signalled");
    if (signal === 0) {
      if (alive) return true;
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    }
    signalHandler(signal);
    return true;
  }) as typeof process.kill;
}

async function tunnel(label: string) {
  return import(`${pathToFileURL(modulePath).href}?stop-test=${label}-${Math.random()}`);
}

function identity(overrides: { executable?: string; socket?: string; stateDir?: string } = {}) {
  const dir = path.join(dataDir, "tailscale");
  return {
    executable: overrides.executable ?? "tailscaled",
    args: [
      "/usr/sbin/tailscaled",
      `--socket=${overrides.socket ?? path.join(dir, "tailscaled.sock")}`,
      `--statedir=${overrides.stateDir ?? dir}`,
    ],
  };
}

async function ownPid(pid: number, statePid = pid) {
  const dir = path.join(dataDir, "tailscale");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, ".tailscaled.pid"), `${pid}\n`);
  await fs.writeFile(path.join(dir, "state.json"), JSON.stringify({ daemonPid: statePid }));
}

async function statePid() {
  const state = JSON.parse(
    await fs.readFile(path.join(dataDir, "tailscale", "state.json"), "utf8")
  );
  return state.daemonPid;
}

const termSignals: Array<NodeJS.Signals | number | undefined> = [];

test.beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "omniroute-owned-stop-"));
  process.env.DATA_DIR = dataDir;
  delete process.env.OMNIROUTE_NO_SUDO;
  calls = [];
  termSignals.length = 0;
  alive = false;
  allowedPid = 42001;
  signalHandler = (signal) => {
    termSignals.push(signal);
    alive = false;
  };
  spawnHandler = () => {
    throw new Error("external process not explicitly allowed in stop test");
  };
  os.platform = () => "linux";
  installProcessMocks();
});

test.afterEach(async () => {
  process.kill = originalKill;
  childProcess.execFile = originalExecFile;
  childProcess.execFileSync = originalExecFileSync;
  childProcess.spawn = originalSpawn;
  syncBuiltinESMExports();
  os.platform = originalPlatform;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalNoSudo === undefined) delete process.env.OMNIROUTE_NO_SUDO;
  else process.env.OMNIROUTE_NO_SUDO = originalNoSudo;
  if (originalTailscaleBin === undefined) delete process.env.TAILSCALE_BIN;
  else process.env.TAILSCALE_BIN = originalTailscaleBin;
  await fs.rm(dataDir, { recursive: true, force: true });
});

test("system daemon is untouched without app ownership records", async () => {
  alive = true; // Simulate an unrelated live system daemon, never target it.
  const mod = await tunnel("unmanaged");
  await mod.stopTailscaleDaemon({ sudoPassword: "test-only" });
  assert.deepEqual(termSignals, []);
  assert.deepEqual(calls, []);
});

test("matching ownership stops only the verified PID, then clears app state", async () => {
  await ownPid(allowedPid);
  alive = true;
  const mod = await tunnel("owned");
  const restore = mod.__setTailscaleProcessIdentityReaderForTests(async () => identity());
  try {
    await mod.stopTailscaleDaemon();
  } finally {
    restore();
  }
  assert.deepEqual(termSignals, ["SIGTERM"]);
  assert.deepEqual(calls, []);
  assert.equal(await statePid(), null);
  await assert.rejects(fs.access(path.join(dataDir, "tailscale", ".tailscaled.pid")));
});

test("mismatched ownership records refuse stop and preserve the record", async () => {
  await ownPid(allowedPid, allowedPid + 1);
  alive = true;
  const mod = await tunnel("mismatched-records");
  await assert.rejects(
    mod.stopTailscaleDaemon({ sudoPassword: "test-only" }),
    /matching managed PID/
  );
  assert.equal(await statePid(), allowedPid + 1);
  assert.deepEqual(termSignals, []);
  assert.deepEqual(calls, []);
});

test("unreadable or unknown process identity refuses stop without signals", async () => {
  await ownPid(allowedPid);
  alive = true;
  const mod = await tunnel("unknown-identity");
  const restore = mod.__setTailscaleProcessIdentityReaderForTests(async () => null);
  try {
    await assert.rejects(mod.stopTailscaleDaemon(), /unverified tailscaled/);
  } finally {
    restore();
  }
  assert.equal(await statePid(), allowedPid);
  assert.deepEqual(termSignals, []);
  assert.deepEqual(calls, []);
});

test("reused PID with wrong executable, socket, or state dir cannot be stopped", async () => {
  await ownPid(allowedPid);
  alive = true;
  const mod = await tunnel("pid-reuse");
  const dir = path.join(dataDir, "tailscale");
  for (const bad of [
    identity({ executable: "other-daemon" }),
    identity({ socket: path.join(dir, "other.sock") }),
    identity({ stateDir: `${dir}-other` }),
  ]) {
    const restore = mod.__setTailscaleProcessIdentityReaderForTests(async () => bad);
    try {
      await assert.rejects(
        mod.stopTailscaleDaemon({ sudoPassword: "test-only" }),
        /unverified tailscaled/
      );
    } finally {
      restore();
    }
  }
  assert.equal(await statePid(), allowedPid);
  assert.deepEqual(termSignals, []);
  assert.deepEqual(calls, []);
});

test("permission failure without password does not try another process", async () => {
  await ownPid(allowedPid);
  alive = true;
  const mod = await tunnel("no-elevation");
  const restore = mod.__setTailscaleProcessIdentityReaderForTests(async () => identity());
  signalHandler = () => {
    throw Object.assign(new Error("permission denied"), { code: "EPERM" });
  };
  try {
    await assert.rejects(mod.stopTailscaleDaemon(), /requires elevated permission/);
  } finally {
    restore();
  }
  assert.equal(await statePid(), allowedPid);
  assert.deepEqual(calls, []);
});

test("permission fallback uses only sudo kill -TERM with exact owned PID", async () => {
  await ownPid(allowedPid);
  alive = true;
  const mod = await tunnel("sudo-scoped");
  const restore = mod.__setTailscaleProcessIdentityReaderForTests(async () => identity());
  signalHandler = () => {
    throw Object.assign(new Error("permission denied"), { code: "EPERM" });
  };
  spawnHandler = (command, argv) => {
    assert.equal(command, "sudo");
    assert.deepEqual(argv, ["-S", "kill", "-TERM", "--", String(allowedPid)]);
    alive = false;
  };
  try {
    await mod.stopTailscaleDaemon({ sudoPassword: "test-only" });
  } finally {
    restore();
  }
  assert.deepEqual(calls, [
    { command: "sh", args: ["-c", "command -v sudo"] },
    { command: "sudo", args: ["-S", "kill", "-TERM", "--", String(allowedPid)] },
  ]);
  assert.equal(await statePid(), null);
});

test("PID reused before sudo fallback is rechecked and never signalled again", async () => {
  await ownPid(allowedPid);
  alive = true;
  const mod = await tunnel("reuse-before-sudo");
  let reads = 0;
  const restore = mod.__setTailscaleProcessIdentityReaderForTests(async () =>
    ++reads === 1 ? identity() : identity({ stateDir: `${dataDir}-reused` })
  );
  signalHandler = () => {
    throw Object.assign(new Error("permission denied"), { code: "EPERM" });
  };
  try {
    await assert.rejects(
      mod.stopTailscaleDaemon({ sudoPassword: "test-only" }),
      /unverified tailscaled/
    );
  } finally {
    restore();
  }
  assert.equal(reads, 2);
  assert.equal(await statePid(), allowedPid);
  assert.deepEqual(calls, []);
});

test("Windows refuses unverified managed PID and never stops a system service", async () => {
  await ownPid(allowedPid);
  alive = true;
  os.platform = () => "win32";
  const mod = await tunnel("windows-service");
  const restore = mod.__setTailscaleProcessIdentityReaderForTests(async () => identity());
  try {
    await assert.rejects(mod.stopTailscaleDaemon(), /unverified tailscaled/);
  } finally {
    restore();
  }
  assert.equal(await statePid(), allowedPid);
  assert.deepEqual(termSignals, []);
  assert.deepEqual(calls, []);
});

test("malformed ownership state and PID files fail closed without overwriting evidence", async () => {
  await ownPid(allowedPid);
  alive = true;
  const dir = path.join(dataDir, "tailscale");
  const mod = await tunnel("malformed-records");
  await fs.writeFile(path.join(dir, "state.json"), "{malformed");
  await assert.rejects(mod.stopTailscaleDaemon(), SyntaxError);
  assert.equal(await fs.readFile(path.join(dir, "state.json"), "utf8"), "{malformed");

  await fs.writeFile(path.join(dir, "state.json"), JSON.stringify({ daemonPid: allowedPid }));
  await fs.writeFile(path.join(dir, ".tailscaled.pid"), `${allowedPid}suffix\n`);
  await assert.rejects(mod.stopTailscaleDaemon(), /Invalid managed tailscaled PID file/);
  assert.deepEqual(termSignals, []);
  assert.deepEqual(calls, []);
});

test("cleanup errors keep ownership evidence and do not signal another process", async () => {
  await ownPid(allowedPid);
  alive = true;
  const dir = path.join(dataDir, "tailscale");
  await fs.mkdir(path.join(dir, "tailscaled.sock")); // unlink must fail with EISDIR
  const mod = await tunnel("cleanup-error");
  const restore = mod.__setTailscaleProcessIdentityReaderForTests(async () => identity());
  try {
    await assert.rejects(mod.stopTailscaleDaemon(), /EISDIR|directory/i);
  } finally {
    restore();
  }
  assert.deepEqual(termSignals, ["SIGTERM"]);
  assert.equal(await statePid(), allowedPid);
  assert.equal(await fs.readFile(path.join(dir, ".tailscaled.pid"), "utf8"), `${allowedPid}\n`);
  assert.deepEqual(calls, []);
});

test("PID reused before sudo SIGKILL is rechecked and never signalled again", async () => {
  await ownPid(allowedPid);
  alive = true;
  const mod = await tunnel("reuse-before-kill");
  let reads = 0;
  const restore = mod.__setTailscaleProcessIdentityReaderForTests(async () =>
    ++reads < 3 ? identity() : identity({ socket: `${dataDir}/reused.sock` })
  );
  signalHandler = () => {
    throw Object.assign(new Error("permission denied"), { code: "EPERM" });
  };
  spawnHandler = (command, argv) => {
    assert.equal(command, "sudo");
    assert.deepEqual(argv, ["-S", "kill", "-TERM", "--", String(allowedPid)]);
  };
  try {
    await assert.rejects(
      mod.stopTailscaleDaemon({ sudoPassword: "test-only" }),
      /unverified tailscaled/
    );
  } finally {
    restore();
  }
  assert.equal(reads, 3);
  assert.equal(await statePid(), allowedPid);
  assert.equal(calls.filter((call) => call.command === "sudo").length, 1);
});

test("macOS also refuses unverifiable live PIDs without stopping a system daemon", async () => {
  await ownPid(allowedPid);
  alive = true;
  os.platform = () => "darwin";
  const mod = await tunnel("mac-system");
  const restore = mod.__setTailscaleProcessIdentityReaderForTests(async () => identity());
  try {
    await assert.rejects(mod.stopTailscaleDaemon(), /unverified tailscaled/);
  } finally {
    restore();
  }
  assert.equal(await statePid(), allowedPid);
  assert.deepEqual(termSignals, []);
  assert.deepEqual(calls, []);
});

test("disable keeps malformed ownership evidence and reports the original stop error", async () => {
  await ownPid(allowedPid);
  const dir = path.join(dataDir, "tailscale");
  await fs.writeFile(path.join(dir, "state.json"), "{malformed");
  const fakeBin = path.join(dataDir, "fake-tailscale");
  await fs.writeFile(fakeBin, "");
  process.env.TAILSCALE_BIN = fakeBin;
  const mod = await tunnel("disable-malformed");
  await assert.rejects(mod.disableTailscaleTunnel(), SyntaxError);
  assert.equal(await fs.readFile(path.join(dir, "state.json"), "utf8"), "{malformed");
  assert.equal(await fs.readFile(path.join(dir, ".tailscaled.pid"), "utf8"), `${allowedPid}\n`);
  assert.deepEqual(termSignals, []);
  assert.ok(calls.every(({ command }) => command === fakeBin));
});
