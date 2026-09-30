import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import type { PromiseWithChild } from "node:child_process";
import path from "node:path";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import vm from "node:vm";
import ts from "typescript";
import {
  RuntimePolicyError,
  isRuntimePolicyError,
  markRuntimePolicyResponse,
  isRuntimePolicyResponse,
} from "../../../scripts/build/runtime-policy.mjs";

// Execute only the selected source module. Every app dependency, file operation,
// process entrypoint, timer and network send is a synthetic fixture. No real DB,
// helper, provider, app bootstrap or reserved activation path is accessed.
const noop = () => {};
const logger = { info: noop, warn: noop, error: noop, debug: noop, log: noop };

type UnreadExecOutput = { stdout: never; stderr: never };

// The command detector awaits completion but never reads output or the child.
// Preserve every promisified execFile overload without a native process or cast.
function fixtureExecResult(
  effect: (name: string) => never,
  denial?: Error
): PromiseWithChild<UnreadExecOutput> {
  class SyntheticExecPromise extends Promise<UnreadExecOutput> {
    get child(): never {
      return effect("unexpected exec child access");
    }
  }
  return new SyntheticExecPromise((resolve, reject) => {
    if (denial) {
      reject(denial);
      return;
    }
    resolve({
      get stdout(): never {
        return effect("unexpected exec stdout access");
      },
      get stderr(): never {
        return effect("unexpected exec stderr access");
      },
    });
  });
}

class Fixture {
  locked = true;
  policyFailure: RuntimePolicyError | null = null;
  readonly denial = new RuntimePolicyError("capability-disabled");
  readonly effects: string[] = [];
  readonly capabilities: string[] = [];
  readonly imports: Record<string, unknown>;
  readonly globals: Record<string, unknown>;
  readonly process = {
    env: {} as Record<string, string>,
    platform: "linux",
    arch: "arm64",
    versions: {},
    pid: 42001,
    execPath: "/fixture/node",
    cwd: () => "/fixture",
    kill: this.trap("signal"),
    on: this.trap("process.on"),
    once: this.trap("process.once"),
  };
  readonly fs: Record<string, unknown> = {
    constants: { F_OK: 0, X_OK: 1 },
    existsSync: this.trap("fs.exists"),
    readFileSync: this.trap("fs.read"),
    mkdirSync: this.trap("fs.mkdir"),
    writeFileSync: this.trap("fs.write"),
    openSync: this.trap("fs.open"),
    closeSync: this.trap("fs.close"),
    chmodSync: this.trap("fs.chmod"),
    rmSync: this.trap("fs.rm"),
    unlinkSync: this.trap("fs.unlink"),
    access: this.trap("fs.access"),
    realpath: this.trap("fs.realpath"),
    stat: this.trap("fs.stat"),
    readFile: this.trap("fs.read"),
    writeFile: this.trap("fs.write"),
    mkdir: this.trap("fs.mkdir"),
    unlink: this.trap("fs.unlink"),
  };
  readonly childProcess = {
    spawn: this.trap("spawn"),
    spawnSync: this.trap("spawnSync"),
    execFile: this.trap("execFile"),
    execFileSync: this.trap("execFileSync"),
  };

  trap(name: string) {
    return (..._args: unknown[]): never => {
      this.effects.push(name);
      throw new Error(`Unexpected fixture side effect: ${name}`);
    };
  }

  constructor() {
    const facade = {
      getRuntimePolicy: () => {
        if (this.policyFailure) throw this.policyFailure;
        return this.locked
          ? { mode: "locked", policy: { providers: [], helpers: [] } }
          : { mode: "standalone" };
      },
      assertNotLockedCapability: (capability: string) => {
        this.capabilities.push(capability);
        if (this.policyFailure) throw this.policyFailure;
        if (this.locked) throw this.denial;
      },
      isRuntimePolicyError,
    };
    const os = {
      homedir: () => "/fixture",
      tmpdir: () => "/fixture/tmp",
      platform: () => "linux",
      hostname: () => "fixture",
    };
    const crypto = { createHash, randomUUID: () => "fixture-uuid" };
    this.imports = {
      "@/shared/runtimePolicy": facade,
      "node:events": { EventEmitter },
      events: { EventEmitter },
      "node:path": path,
      path,
      "node:os": os,
      os,
      "node:crypto": crypto,
      crypto,
      "node:util": { promisify },
      util: { promisify },
      "node:fs": this.fs,
      fs: this.fs,
      "node:fs/promises": this.fs,
      "fs/promises": this.fs,
      "node:child_process": this.childProcess,
      child_process: this.childProcess,
      module: { createRequire: () => (id: string) => this.require(id) },
      "@omniroute/open-sse/utils/error": {
        sanitizeErrorMessage: (value: unknown) => String(value),
      },
      "@/lib/db/core": { DATA_DIR: "/fixture", getDbInstance: this.trap("DB") },
      "@/lib/db/settings": {
        getSettings: this.trap("settings"),
        updateSettings: this.trap("settings.write"),
      },
      "@/lib/dataPaths": { resolveDataDir: () => "/fixture" },
      "@/lib/runtime/ports": { getRuntimePorts: () => ({ apiPort: 20128 }) },
    };
    this.globals = {
      process: this.process,
      console: logger,
      Buffer,
      URL,
      Error,
      Date,
      JSON,
      Object,
      Array,
      Map,
      Set,
      WeakMap,
      Promise,
      Symbol,
      String,
      Number,
      Boolean,
      Reflect,
      Response,
      Request,
      Headers,
      AbortSignal,
      TextDecoder,
      crypto,
      fetch: this.trap("fetch"),
      setTimeout: this.trap("timer"),
      setInterval: this.trap("interval"),
      clearTimeout: noop,
      clearInterval: noop,
    };
  }

  require(id: string): unknown {
    if (Object.hasOwn(this.imports, id)) return this.imports[id];
    throw new Error(`Unexpected fixture import: ${id}`);
  }

  load<T>(sourcePath: string, imports: Record<string, unknown> = {}): T {
    Object.assign(this.imports, imports);
    const filename = new URL(`../../../${sourcePath}`, import.meta.url);
    let source = readFileSync(filename, "utf8").replaceAll(
      "import.meta.url",
      JSON.stringify(filename.href)
    );
    // ESM createRequire bindings must not shadow the CJS import shim in this fixture.
    if (sourcePath === "src/lib/skills/sandbox.ts")
      source = source.replace(/\brequire\b/g, "fixtureRequire");
    const compiled = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    }).outputText;
    const module = { exports: {} };
    vm.runInNewContext(
      compiled,
      {
        ...this.globals,
        module,
        exports: module.exports,
        require: (id: string) => this.require(id),
      },
      { filename: filename.pathname }
    );
    return module.exports as T;
  }

  async denied(action: () => unknown) {
    await assert.rejects(
      async () => action(),
      (error: unknown) => {
        assert.ok(
          isRuntimePolicyError(error),
          `Expected branded denial; got ${String(error)}; effects=${this.effects.join(",")}`
        );
        assert.equal(error, this.policyFailure ?? this.denial);
        return true;
      }
    );
    assert.deepEqual(this.effects, []);
  }
}

test("ACP denies spawn and retained-session input; status and termination stay available", async () => {
  const f = new Fixture();
  const mod = f.load<typeof import("../../../src/lib/acp/manager.ts")>("src/lib/acp/manager.ts", {
    "./registry": { hasRegisteredAgent: () => true },
  });
  await f.denied(() => mod.acpManager.spawn("fixture", "fixture-cli"));
  await f.denied(() => mod.acpManager.sendInput("fixture", "payload"));
  await f.denied(() => mod.acpManager.sendPrompt("fixture", "payload"));
  assert.equal(mod.acpManager.getActiveSessions().length, 0);
  assert.equal(mod.acpManager.kill("missing"), false);
  mod.acpManager.killAll();
  f.locked = false;
  await assert.rejects(
    async () => mod.acpManager.spawn("fixture", "fixture-cli"),
    /Unexpected fixture side effect: spawn/
  );
  assert.deepEqual(f.effects, ["spawn"]);
});

test("service start/restart deny before DB/probe/lock; stop and in-memory status do not consult policy", async () => {
  const f = new Fixture();
  const mod = f.load<typeof import("../../../src/lib/services/ServiceSupervisor.ts")>(
    "src/lib/services/ServiceSupervisor.ts",
    {
      "@/lib/db/versionManager": { getServiceRow: f.trap("DB"), setToolStatus: f.trap("DB.write") },
      "./ringBuffer": { RingBuffer: class {} },
      "./healthCheck": { HealthChecker: class {} },
      "./portProbe": { probeBeforeSpawn: f.trap("probe") },
    }
  );
  const supervisor = new mod.ServiceSupervisor({
    tool: "fixture",
    port: 19222,
    spawnArgs: f.trap("spawnArgs"),
    healthUrl: () => "http://127.0.0.1:19222",
    healthIntervalMs: 100,
    stopTimeoutMs: 100,
    logsBufferBytes: 100,
    probeBeforeSpawn: true,
  });
  await f.denied(() => supervisor.start());
  await f.denied(() => supervisor.restart());
  assert.equal(supervisor.getStatus().state, "stopped");
  f.policyFailure = new RuntimePolicyError("bootstrap-invalid");
  assert.equal((await supervisor.stop()).state, "stopped");
  assert.deepEqual(f.effects, []);
});

test("locked embedded bootstrap does not read DB, provision keys, register or auto-start", async () => {
  const f = new Fixture();
  const installer = { resolveSpawnArgs: f.trap("spawnArgs") };
  const mod = f.load<typeof import("../../../src/lib/services/bootstrap.ts")>(
    "src/lib/services/bootstrap.ts",
    {
      "@/lib/db/versionManager": { getVersionManagerTool: f.trap("DB") },
      "@/lib/db/serviceModels": { markAllUnavailable: f.trap("DB.write") },
      "@omniroute/open-sse/handlers/chatCore/cliproxyapiCredentials": {},
      "./registry": { registerSupervisor: f.trap("register"), getSupervisor: f.trap("lookup") },
      "./ServiceSupervisor": {},
      "./installers/ninerouter": installer,
      "./installers/cliproxy": installer,
      "./installers/mux": installer,
      "./installers/bifrost": installer,
      "./installers/dario": installer,
      "./apiKey": { getOrCreateApiKey: f.trap("key") },
      "./modelSync": {},
      "./providerPlugins/registry": {
        getServiceProviderPlugin: () => ({
          tool: "fixture",
          port: { envVar: "FIXTURE_PORT", default: 19222 },
        }),
      },
    }
  );
  await mod.bootstrapEmbeddedServices();
  assert.deepEqual(f.effects, []);
});

test("npm install/version probes deny before exec and do not reclassify policy errors", async () => {
  const f = new Fixture();
  const mod = f.load<typeof import("../../../src/lib/services/installers/utils.ts")>(
    "src/lib/services/installers/utils.ts"
  );
  await f.denied(() => mod.runNpm(["install", "fixture"]));
  await f.denied(() => mod.runNpm(["view", "fixture", "version"]));
  f.locked = false;
  f.childProcess.execFile = ((
    _bin: string,
    _args: string[],
    _opts: unknown,
    callback: (error: Error) => void
  ) => callback(f.denial)) as typeof f.childProcess.execFile;
  await assert.rejects(
    mod.runNpm(["view", "fixture", "version"]),
    (error: unknown) => error === f.denial
  );
});

for (const [file, constructorName, resolverName] of [
  ["cliproxyapi", "CliproxyapiExecutor", "resolveCliproxyapiBaseUrl"],
  ["dario", "DarioExecutor", "resolveDarioBaseUrl"],
] as const) {
  test(`${file} skips preload and denies cached/configured forward and health probes`, async () => {
    const f = new Fixture();
    interface Executor {
      execute(input: unknown): Promise<unknown>;
      healthCheck(): Promise<unknown>;
    }
    const mod = f.load<Record<string, unknown>>(`open-sse/executors/${file}.ts`, {
      "./base.ts": { BaseExecutor: class {}, mergeUpstreamExtraHeaders: noop },
      "../config/constants.ts": { HTTP_STATUS: { RATE_LIMITED: 429 }, FETCH_TIMEOUT_MS: 5000 },
      "../config/providerPluginManifestUrl.ts": { getProviderPluginManifestHeader: () => ({}) },
      "../services/claudeCodeToolRemapper.ts": {},
      "../translator/helpers/schemaCoercion.ts": {},
    });
    const Constructor = mod[constructorName] as new (url: string) => Executor;
    const executor = new Constructor("https://fixture.example.invalid");
    await f.denied(() => executor.execute({}));
    await f.denied(() => executor.healthCheck());
    await f.denied(() => (mod[resolverName] as () => Promise<string>)());
    await Promise.resolve();
    assert.deepEqual(f.effects, []);
    f.locked = false;
    f.imports["@/lib/db/settings"] = {
      getSettings: async () => ({
        [file === "dario" ? "dario_url" : "cliproxyapi_url"]: "https://cached.example.invalid",
      }),
    };
    assert.equal(
      await (mod[resolverName] as () => Promise<string>)(),
      "https://cached.example.invalid"
    );
    f.locked = true;
    await f.denied(() => (mod[resolverName] as () => Promise<string>)());
  });
}

test("upstream forwarding writes use effective state, allow disabling/deleting and reject routing chains", async () => {
  const f = new Fixture();
  let writes = 0;
  const row = { provider_id: "fixture", mode: "fallback", enabled: 0, fallback_backend: "dario" };
  const db = {
    prepare: () => ({
      get: () => row,
      run: () => {
        writes++;
        return { changes: 1 };
      },
    }),
  };
  const mod = f.load<typeof import("../../../src/lib/db/upstreamProxy.ts")>(
    "src/lib/db/upstreamProxy.ts",
    {
      "./core": { getDbInstance: () => db },
      "@/shared/network/outboundUrlGuard": {},
      "@/shared/network/privateHost": {},
    }
  );
  await f.denied(() => mod.upsertUpstreamProxyConfig({ providerId: "fixture", mode: "dario" }));
  await f.denied(() => mod.updateUpstreamProxyConfig("fixture", { enabled: true }));
  assert.equal(writes, 0);
  await mod.upsertUpstreamProxyConfig({ providerId: "fixture", mode: "dario", enabled: false });
  await mod.updateUpstreamProxyConfig("fixture", { enabled: false });
  assert.equal(await mod.deleteUpstreamProxyConfig("fixture"), true);
  assert.equal(writes, 3);
  row.enabled = 1;
  await f.denied(() => mod.getFallbackChainForProvider("fixture"));
  assert.equal((await mod.getUpstreamProxyConfig("fixture"))?.mode, "fallback");
});

test("CLI runtime rejects hidden npm/login-shell/version probes and config provisioning", async () => {
  const f = new Fixture();
  const mod = f.load<typeof import("../../../src/shared/services/cliRuntime.ts")>(
    "src/shared/services/cliRuntime.ts",
    {
      "@/lib/cli-helper/config-generator/hermesHome": {},
      "./loginShellPath": { getCachedLoginShellPath: f.trap("login-shell") },
      "./cliInstallFallback": {},
      "./cliRuntimeGrokBuild": {},
      "./cliRuntimeKnownPath": {},
      "./cliRuntimeHealthcheckPath": {},
      "../utils/containerEnv": {},
      "../utils/containerConfigGuard": {},
      "./opencodeConfigPath": {},
    }
  );
  for (const action of [
    () => mod.getCliRuntimeStatus("codex"),
    () => mod.getLookupEnv(),
    () => mod.getKnownToolPaths("codex"),
    () => mod.locateCommand("codex", {}),
    () => mod.locateCommandCandidate(["codex"], {}, "codex"),
    () => mod.checkKnownPath("/fixture/codex"),
    () => mod.ensureCliConfigWriteAllowed(),
  ])
    await f.denied(action);
  assert.ok(mod.getCliToolCommandCandidates("codex").length > 0);
});

test("plugin load denies before integrity read/temp script creation/process launch", async () => {
  const f = new Fixture();
  const mod = f.load<typeof import("../../../src/lib/plugins/loader.ts")>(
    "src/lib/plugins/loader.ts",
    {
      "../../../open-sse/utils/logger.ts": { logger: () => logger },
    }
  );
  await f.denied(() =>
    mod.loadPlugin("/fixture/plugin.mjs", { integrity: "sha256-fixture" } as unknown as Parameters<
      typeof mod.loadPlugin
    >[1])
  );
  assert.match(mod.computeIntegrity("fixture"), /^sha256-/);
});

test("headroom start denies before binary detection; stop remains callable on invalid policy", async () => {
  const f = new Fixture();
  const mod = f.load<typeof import("../../../src/lib/headroom/process.ts")>(
    "src/lib/headroom/process.ts",
    {
      "./detect": { findHeadroomBinary: f.trap("detect") },
    }
  );
  await f.denied(() => mod.startHeadroomProxy());
  f.fs.existsSync = () => false;
  f.policyFailure = new RuntimePolicyError("bootstrap-invalid");
  assert.equal(mod.stopHeadroomProxy().reason, "not_running");
  assert.equal(mod.getManagedPid(), null);
});

test("VNC start/harvest deny before DB/container/CDP work; status and stop remain available", async () => {
  const f = new Fixture();
  const mod = f.load<typeof import("../../../src/lib/vncSession/service.ts")>(
    "src/lib/vncSession/service.ts",
    {
      "@/lib/exclusiveLeaseIsolation": {
        isConnectionUnavailableToAuxiliaryActivity: f.trap("lease DB"),
      },
      "@/lib/db/providers": {},
      "@/lib/providers/validation": {},
      "./manifest": {},
      "./harvest": {},
    }
  );
  await f.denied(() => mod.startSession("fixture"));
  await f.denied(() => mod.harvestSession("fixture", "session"));
  assert.equal(mod.listSessions().length, 0);
  f.policyFailure = new RuntimePolicyError("bootstrap-invalid");
  await mod.stopSession("fixture", "session");
  await mod.stopAllSessions();
  assert.deepEqual(f.effects, []);
});

test("sandbox denies cached provider resolution/run while termination is ungated", async () => {
  const f = new Fixture();
  const providers = { resolveProvider: f.trap("container probe") };
  const mod = f.load<typeof import("../../../src/lib/skills/sandbox.ts")>(
    "src/lib/skills/sandbox.ts",
    {
      "./containerProvider.ts": providers,
    }
  );
  await f.denied(() => mod.sandboxRunner.getProvider());
  await f.denied(() => mod.sandboxRunner.run("fixture", ["fixture"]));
  f.locked = false;
  const cached = { id: "fixture" };
  providers.resolveProvider = (() => cached) as unknown as typeof providers.resolveProvider;
  assert.equal(await mod.sandboxRunner.getProvider(), cached);
  f.locked = true;
  await f.denied(() => mod.sandboxRunner.getProvider());
  f.policyFailure = new RuntimePolicyError("bootstrap-invalid");
  assert.equal(mod.sandboxRunner.kill("missing"), false);
  mod.sandboxRunner.killAll();
  assert.equal(mod.sandboxRunner.getRunningCount(), 0);
});

test("auto-update launch/runtime/version checks deny before command/file work; standalone callbacks still run", async () => {
  const f = new Fixture();
  f.fs.existsSync = () => false;
  const mod = f.load<typeof import("../../../src/lib/system/autoUpdate.ts")>(
    "src/lib/system/autoUpdate.ts"
  );
  const config = mod.getAutoUpdateConfig({ AUTO_UPDATE_MODE: "source" });
  await f.denied(() => mod.detectComposeCommand());
  await f.denied(() => mod.validateAutoUpdateRuntime(config));
  await f.denied(() => mod.ensureGitTagExists("fixture"));
  await f.denied(() => mod.launchAutoUpdate({ latest: "fixture" }));
  f.locked = false;
  let calls = 0;
  const effect = (name: string): never => f.trap(name)();
  const successfulExec: NonNullable<Parameters<typeof mod.detectComposeCommand>[0]> = () => {
    calls++;
    return fixtureExecResult(effect);
  };
  const rejectedExec: NonNullable<Parameters<typeof mod.detectComposeCommand>[0]> = () =>
    fixtureExecResult(effect, f.denial);
  assert.equal(await mod.detectComposeCommand(successfulExec), "docker compose");
  assert.equal(calls, 1);
  await assert.rejects(
    mod.detectComposeCommand(rejectedExec),
    (error: unknown) => error === f.denial
  );
  assert.deepEqual(f.effects, []);
});

function tunnelFixture() {
  const f = new Fixture();
  f.imports["@omniroute/open-sse/utils/proxyFetch.ts"] = f.trap("fetch");
  f.imports["@/mitm/manager"] = {
    getCachedPassword: () => null,
    setCachedPassword: f.trap("password"),
  };
  f.imports["@/mitm/systemCommands"] = { execFileWithPassword: f.trap("sudo") };
  f.imports["@/shared/utils/machineId"] = { getConsistentMachineId: f.trap("machineId") };
  return f;
}

test("Cloudflared start denies before lookup/install and locked status uses only local evidence", async () => {
  const f = tunnelFixture();
  const mod = f.load<typeof import("../../../src/lib/cloudflaredTunnel.ts")>(
    "src/lib/cloudflaredTunnel.ts"
  );
  await f.denied(() => mod.startCloudflaredTunnel());
  f.fs.readFile = async () => "{}";
  f.fs.existsSync = () => false;
  const status = await mod.getCloudflaredTunnelStatus();
  assert.equal(status.supported, false);
  assert.equal(status.running, false);
  assert.equal(status.phase, "unsupported");
  assert.deepEqual(f.effects, []);
});

test("Tailscale install/login/daemon/funnel deny before password/probe; locked status does not invoke CLI", async () => {
  const f = tunnelFixture();
  const mod = f.load<typeof import("../../../src/lib/tailscaleTunnel.ts")>(
    "src/lib/tailscaleTunnel.ts"
  );
  for (const action of [
    () => mod.installTailscale(),
    () => mod.startTailscaleDaemon(),
    () => mod.startTailscaleLogin(),
    () => mod.startTailscaleFunnel(19222),
    () => mod.enableTailscaleTunnel({ sudoPassword: "fixture" }),
  ])
    await f.denied(action);
  f.fs.readFile = async () => "{}";
  f.fs.existsSync = () => false;
  const status = await mod.getTailscaleCheckStatus();
  assert.equal(status.supported, false);
  assert.equal(status.running, false);
  assert.deepEqual(f.effects, []);
  f.policyFailure = new RuntimePolicyError("bootstrap-invalid");
  f.fs.readFile = async (filename: string) => {
    if (filename.endsWith(".tailscaled.pid"))
      throw Object.assign(new Error("fixture absent"), { code: "ENOENT" });
    return "{}";
  };
  await mod.stopTailscaleDaemon();
  assert.deepEqual(f.effects, []);
});

test("MITM denies start and provisioning before DNS/cert/file work; repair and stop remain available", async () => {
  const f = new Fixture();
  const cleanup: string[] = [];
  f.fs.existsSync = () => false;
  f.fs.unlinkSync = () => cleanup.push("unlink");
  const mod = f.load<typeof import("../../../src/mitm/manager.ts")>("src/mitm/manager.ts", {
    "./dataDir.ts": { resolveMitmDataDir: () => "/fixture" },
    "./dns/dnsConfig.ts": {},
    "./dns/provision.ts": { provisionDnsEntries: f.trap("DNS") },
    "./cert/generate.ts": {},
    "./cert/install.ts": {},
    "./cert/rootCa.ts": {},
    "./cert/migration.ts": {},
    "./targets/index.ts": { ALL_TARGETS: [] },
    "./detection/index.ts": {},
    "@/lib/db/agentBridgeState.ts": {},
    "@/lib/db/agentBridgeBypass.ts": {},
    "@/lib/db/providers.ts": {},
    "./upstreamTrust.ts": {},
    "@/shared/utils/logger.ts": { createLogger: () => logger },
    "./repair.ts": {
      performRepairSteps: async () => {
        cleanup.push("repair");
        return [];
      },
    },
    "./privilegedMitmStep.ts": {
      runPrivilegedMitmStep: async (_p: string, _m: string, fn: () => Promise<unknown>) => fn(),
    },
    "./stopDnsTeardown.ts": {
      removeStopDnsEntries: async () => {
        cleanup.push("DNS cleanup");
      },
    },
  });
  await f.denied(() => mod.startMitm("fixture", "fixture"));
  await f.denied(() => mod.writeTargetsJson());
  await f.denied(() => mod.writeBypassJson([]));
  f.policyFailure = new RuntimePolicyError("bootstrap-invalid");
  await mod.repairMitm("fixture");
  assert.equal((await mod.stopMitm("fixture")).running, false);
  assert.deepEqual(cleanup, ["repair", "DNS cleanup", "unlink"]);
});

test("Codex tunnel acquisition/install/status/connect denies before provisioning; release/stop remain available", async () => {
  const f = new Fixture();
  const mod = f.load<
    typeof import("../../../open-sse/executors/chatgpt-web-codex/tunnelClient.ts")
  >("open-sse/executors/chatgpt-web-codex/tunnelClient.ts", {
    fflate: {},
    "../../vendor/codex-chatgpt-web/config.ts": {
      getConfigDir: () => "/fixture",
      atomicWriteFile: f.trap("config.write"),
    },
  });
  const config = {
    tunnelId: "fixture",
    runtimeKey: "fixture",
    brokerSocketPath: "/fixture/socket",
  };
  for (const action of [
    () => mod.acquireTunnelSupervisorLease(),
    () => mod.ensureTunnelClientInstalled(),
    () => mod.getTunnelRuntimeStatus({}),
    () => mod.startTunnelRuntime(config),
    () => mod.ensureTunnelRuntimeReady(config),
  ])
    await f.denied(action);
  f.policyFailure = new RuntimePolicyError("bootstrap-invalid");
  mod.releaseTunnelSupervisorLease();
  await mod.stopChatGptWebCodexTunnelRuntime();
  assert.deepEqual(f.effects, []);
});

test("cloud-agent catalog/lookup remain stable for local cancellation, all retained network operations deny", async () => {
  const f = new Fixture();
  class Agent {
    readonly providerId = "fixture";
    createTask = f.trap("cloud.create");
    getStatus = f.trap("cloud.status");
    approvePlan = f.trap("cloud.approve");
    sendMessage = f.trap("cloud.message");
    listSources = f.trap("cloud.sources");
  }
  const mod = f.load<typeof import("../../../src/lib/cloudAgent/registry.ts")>(
    "src/lib/cloudAgent/registry.ts",
    {
      "./agents/jules.ts": { JulesAgent: Agent },
      "./agents/devin.ts": { DevinAgent: Agent },
      "./agents/codex.ts": { CodexCloudAgent: Agent },
      "./agents/cursor.ts": { CursorCloudAgent: Agent },
    }
  );
  const agent = mod.getAgent("jules")!;
  assert.equal(mod.getAgent("jules"), agent);
  assert.ok(mod.getAvailableAgents().length > 0);
  assert.equal(mod.getAgent("missing"), null);
  for (const name of [
    "createTask",
    "getStatus",
    "approvePlan",
    "sendMessage",
    "listSources",
  ] as const) {
    await f.denied(() => Reflect.apply(agent[name], agent, []));
  }
  f.locked = false;
  await assert.rejects(async () => agent.listSources({ apiKey: "fixture" }), /cloud.sources/);
  assert.deepEqual(f.effects, ["cloud.sources"]);
});

test("cloud-agent credentials deny before DB, without blocking management auth or task serialization", async () => {
  const f = new Fixture();
  const mod = f.load<typeof import("../../../src/lib/cloudAgent/api.ts")>(
    "src/lib/cloudAgent/api.ts",
    {
      "@/lib/api/requireManagementAuth": { requireManagementAuth: async () => null },
      "@/lib/db/providers": { getProviderConnections: f.trap("credentials DB") },
      "@/server/cors/origins": {},
    }
  );
  await f.denied(() => mod.getCloudAgentCredentials("fixture"));
  f.policyFailure = new RuntimePolicyError("bootstrap-invalid");
  assert.equal(
    await mod.requireCloudAgentManagementAuth(new Request("http://fixture.invalid")),
    null
  );
  assert.deepEqual(f.effects, []);
});

for (const name of ["ninerouter", "mux", "bifrost", "dario", "cliproxy"] as const) {
  test(`embedded installer ${name} denies before mkdir/download/probe and preserves read-only version`, async () => {
    const f = new Fixture();
    interface Installer {
      install(): Promise<unknown>;
      update(): Promise<unknown>;
      getLatestVersion(): Promise<string | null>;
      getInstalledVersion(): Promise<string | null>;
      resolveSpawnArgs(...args: unknown[]): unknown;
      uninstall?: () => Promise<void>;
    }
    const cleanup: string[] = [];
    const utils = { runNpm: f.trap("npm"), InstallError: Error };
    const releases = { getLatestRelease: f.trap("release probe") };
    const mod = f.load<Installer>(`src/lib/services/installers/${name}.ts`, {
      "./utils": utils,
      "@/lib/db/versionManager": {
        upsertVersionManagerTool: async () => {
          cleanup.push("DB.delete");
        },
      },
      "@/lib/versionManager/releaseChecker.ts": releases,
      "@/lib/versionManager/binaryManager.ts": {
        installVersion: f.trap("download"),
        getCurrentBinaryPath: async () => "/fixture/cliproxyapi-1.0.0/binary",
      },
    });
    await f.denied(() => mod.install());
    await f.denied(() => mod.update());
    await f.denied(() => mod.getLatestVersion());
    if (["mux", "dario", "cliproxy"].includes(name)) {
      await f.denied(() => mod.resolveSpawnArgs("fixture", 19222));
    }
    f.fs.readFileSync = () => JSON.stringify({ version: "1.0.0" });
    assert.equal(await mod.getInstalledVersion(), "1.0.0");
    f.locked = false;
    utils.runNpm = (() => {
      throw f.denial;
    }) as typeof utils.runNpm;
    releases.getLatestRelease = (() => {
      throw f.denial;
    }) as typeof releases.getLatestRelease;
    await assert.rejects(mod.getLatestVersion(), (error: unknown) => error === f.denial);
    if (mod.uninstall) {
      f.policyFailure = new RuntimePolicyError("bootstrap-invalid");
      f.fs.existsSync = () => true;
      f.fs.rmSync = () => {
        cleanup.push("rm");
      };
      await mod.uninstall();
      assert.deepEqual(cleanup, ["rm", "DB.delete"]);
    }
  });
}

test("retained ACP session refuses input while locked but still terminates its existing child", async () => {
  const f = new Fixture();
  const events: string[] = [];
  class Child extends EventEmitter {
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    stdin = { writable: true, write: () => events.push("stdin") };
    kill() {
      events.push("SIGTERM");
      return true;
    }
  }
  f.childProcess.spawn = (() => new Child()) as unknown as typeof f.childProcess.spawn;
  f.globals.setTimeout = () => 1;
  const mod = f.load<typeof import("../../../src/lib/acp/manager.ts")>("src/lib/acp/manager.ts", {
    "./registry": { hasRegisteredAgent: () => true },
  });
  f.locked = false;
  const session = mod.acpManager.spawn("fixture", "fixture-cli");
  assert.equal(mod.acpManager.sendInput(session.id, "standalone"), true);
  assert.deepEqual(events, ["stdin"]);
  events.length = 0;
  f.locked = true;
  await f.denied(() => mod.acpManager.sendInput(session.id, "locked"));
  await f.denied(() => mod.acpManager.sendPrompt(session.id, "locked"));
  assert.equal(session.stdoutBuffer, "");
  f.policyFailure = new RuntimePolicyError("bootstrap-invalid");
  assert.equal(mod.acpManager.kill(session.id), true);
  assert.deepEqual(events, ["SIGTERM"]);
});

test("retained plugin hook denial survives catch-and-continue, while deactivate and cleanup are ungated", async () => {
  const f = new Fixture();
  const calls: string[] = [];
  class Child extends EventEmitter {
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    pid = 42002;
    kill() {
      calls.push("kill");
      return true;
    }
    send(message: { id: string; hook: string }) {
      calls.push(message.hook);
      this.emit("message", { type: "result", id: message.id, result: undefined });
    }
  }
  f.childProcess.spawn = (() => new Child()) as unknown as typeof f.childProcess.spawn;
  f.fs.writeFile = async () => {};
  f.fs.rmSync = () => calls.push("remove");
  f.globals.setTimeout = () => 1;
  const mod = f.load<typeof import("../../../src/lib/plugins/loader.ts")>(
    "src/lib/plugins/loader.ts",
    {
      "../../../open-sse/utils/logger.ts": { logger: () => logger },
    }
  );
  f.locked = false;
  const plugin = await mod.loadPlugin("/fixture/plugin.mjs", {
    name: "fixture",
    requires: { permissions: [] },
    hooks: { onRequest: true, onDeactivate: true },
  } as unknown as Parameters<typeof mod.loadPlugin>[1]);
  f.locked = true;
  await f.denied(() => Reflect.apply(plugin.plugin.onRequest!, plugin.plugin, [{}]));
  f.policyFailure = new RuntimePolicyError("bootstrap-invalid");
  await Reflect.apply(plugin.plugin.onDeactivate!, plugin.plugin, [{}]);
  plugin.cleanup();
  assert.deepEqual(calls, ["onDeactivate", "kill", "remove"]);
});

function cloudTaskRouteFixture(
  failure: "credentials" | "status" | "operation" | "ordinary" | "none"
) {
  const f = new Fixture();
  Object.assign(f.imports["@/shared/runtimePolicy"] as object, { markRuntimePolicyResponse });
  const errors = f.load<typeof import("../../../open-sse/utils/error.ts")>(
    "open-sse/utils/error.ts",
    {
      "./cors.ts": {},
      "./clinepassEnvelope.ts": {},
      "./errorSanitization.ts": { sanitizeErrorMessage: (message: string) => message },
      "../config/errorConfig.ts": {
        getErrorInfo: () => ({ type: "permission_error", code: "forbidden" }),
        getDefaultErrorMessage: () => "Request failed.",
      },
      "@/lib/logPayloads": {},
      "./upstreamErrorPassthrough.ts": {},
    }
  );
  const calls = {
    reads: 0,
    writes: 0,
    credentials: 0,
    status: 0,
    interactions: 0,
    serialize: 0,
    deletes: 0,
  };
  const task = {
    id: "fixture-task",
    provider_id: "fixture-agent",
    external_id: "fixture-external",
    status: "running",
  };
  const schema = { safeParse: (data: unknown) => ({ success: true, data }) };
  f.denial.message = "private-token secret at /private/policy.json";
  const mod = f.load<typeof import("../../../src/app/api/v1/agents/tasks/[id]/route.ts")>(
    "src/app/api/v1/agents/tasks/[id]/route.ts",
    {
      "next/server": { NextResponse: Response },
      "@/lib/cloudAgent/registry": {
        getAgent: () => ({
          getStatus: async () => {
            calls.status++;
            if (failure === "status") throw f.denial;
            if (failure === "ordinary") throw new Error("ordinary failure");
            return { status: "completed", activities: [] };
          },
          approvePlan: async () => {
            calls.interactions++;
            if (failure === "operation") throw f.denial;
            if (failure === "ordinary") throw new Error("ordinary failure");
          },
          sendMessage: async () => {
            calls.interactions++;
            if (failure === "operation") throw f.denial;
            if (failure === "ordinary") throw new Error("ordinary failure");
            return { id: "fixture-activity" };
          },
        }),
      },
      "@/lib/cloudAgent/db": {
        createCloudAgentTaskTable: noop,
        getCloudAgentTaskById: () => {
          calls.reads++;
          return task;
        },
        updateCloudAgentTask: () => {
          calls.writes++;
        },
        deleteCloudAgentTask: () => {
          calls.deletes++;
        },
      },
      "@/lib/cloudAgent/api": {
        requireCloudAgentManagementAuth: async () => null,
        getCloudAgentCorsHeaders: () => ({
          "Access-Control-Allow-Origin": "https://fixture.example.invalid",
        }),
        getCloudAgentCredentials: async () => {
          calls.credentials++;
          if (failure === "credentials") throw f.denial;
          return { apiKey: "fixture-key" };
        },
        serializeCloudAgentTask: (value: unknown) => {
          calls.serialize++;
          return value;
        },
      },
      zod: {
        z: {
          object: () => schema,
          literal: () => schema,
          string: () => ({ min: () => schema }),
          discriminatedUnion: () => schema,
        },
      },
      pino: () => logger,
      "@omniroute/open-sse/utils/error": {
        ...errors,
        runtimePolicyErrorResponse: (...args: unknown[]) => {
          assert.equal(args.length, 0, "runtimePolicyErrorResponse has a zero-argument API");
          return errors.runtimePolicyErrorResponse();
        },
      },
    }
  );
  return { mod, f, calls };
}

for (const source of ["credentials", "status"] as const) {
  test(`cloud task GET ${source} policy denial is terminal, branded and safe instead of stored success`, async () => {
    const { mod, calls, f } = cloudTaskRouteFixture(source);
    const response = await mod.GET(
      new Request("https://fixture.invalid/tasks/fixture") as Parameters<typeof mod.GET>[0],
      { params: Promise.resolve({ id: "fixture" }) }
    );
    assert.equal(response.status, 403);
    assert.ok(isRuntimePolicyResponse(response));
    assert.equal(
      response.headers.get("Access-Control-Allow-Origin"),
      "https://fixture.example.invalid"
    );
    const body = await response.json();
    assert.equal(body.error.code, "OMNI_RUNTIME_POLICY_DENIED");
    assert.equal(body.error.message, "Request denied by runtime policy.");
    assert.equal("data" in body, false);
    assert.doesNotMatch(JSON.stringify(body), /private-token|private\/policy|at \//);
    assert.equal(calls.reads, 1);
    assert.equal(calls.writes, 0);
    assert.equal(calls.serialize, 0);
    assert.equal(calls.credentials, 1);
    assert.equal(calls.status, source === "status" ? 1 : 0);
    assert.deepEqual(f.effects, []);
  });
}

test("cloud task GET ordinary sync failure retains standalone stored-task fallback", async () => {
  const { mod, calls } = cloudTaskRouteFixture("ordinary");
  const response = await mod.GET(
    new Request("https://fixture.invalid/tasks/fixture") as Parameters<typeof mod.GET>[0],
    { params: Promise.resolve({ id: "fixture" }) }
  );
  assert.equal(response.status, 200);
  assert.equal(isRuntimePolicyResponse(response), false);
  assert.equal((await response.json()).data.id, "fixture-task");
  assert.equal(calls.reads, 2);
  assert.equal(calls.writes, 0);
  assert.equal(calls.serialize, 1);
});

test("cloud task local cancel/delete remain available without cloud credentials or status probes", async () => {
  const { mod, calls, f } = cloudTaskRouteFixture("credentials");
  f.policyFailure = new RuntimePolicyError("bootstrap-invalid");
  const params = { params: Promise.resolve({ id: "fixture" }) };
  const response = await mod.POST(
    new Request("https://fixture.invalid/tasks/fixture", {
      method: "POST",
      body: JSON.stringify({ action: "cancel" }),
    }) as Parameters<typeof mod.POST>[0],
    params
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).success, true);
  const deleted = await mod.DELETE(
    new Request("https://fixture.invalid/tasks/fixture", { method: "DELETE" }) as Parameters<
      typeof mod.DELETE
    >[0],
    params
  );
  assert.equal(deleted.status, 200);
  assert.equal(calls.writes, 1);
  assert.equal(calls.deletes, 1);
  assert.equal(calls.credentials, 0);
  assert.equal(calls.status, 0);
  assert.deepEqual(f.effects, []);
});

function modelSyncFixture(configure?: (fixture: Fixture) => void) {
  const f = new Fixture();
  configure?.(f);
  const network: { send: (...args: unknown[]) => unknown } = { send: f.trap("model-sync fetch") };
  f.globals.fetch = (...args: unknown[]) => network.send(...args);
  const mod = f.load<typeof import("../../../src/shared/services/modelSyncScheduler.ts")>(
    "src/shared/services/modelSyncScheduler.ts",
    {
      undici: {
        Agent: class {},
        buildConnector: f.trap("TLS connector"),
        fetch: f.trap("undici fetch"),
      },
      "@/lib/exclusiveLeaseIsolation": {
        isConnectionUnavailableToAuxiliaryActivity: f.trap("lease DB"),
      },
      "@/lib/runtime/ports": { getRuntimePorts: () => ({ dashboardPort: 20128 }) },
    }
  );
  return { f, mod, network };
}

function codexRevalidationFixture(configure?: (fixture: Fixture) => void) {
  const f = new Fixture();
  configure?.(f);
  const models = {
    getSyncedAvailableModelsForConnection: f.trap("catalog DB"),
    replaceSyncedAvailableModelsForConnection: f.trap("catalog scrub"),
  };
  const providers = { getProviderConnections: f.trap("connection DB") };
  const transport = {
    resolveModelSyncInternalBaseUrl: () => "http://127.0.0.1:20128",
    fetchModelSyncInternal: f.trap("catalog fetch"),
    buildModelSyncInternalHeaders: () => ({}),
  };
  const mod = f.load<typeof import("../../../src/shared/services/codexCatalogRevalidation.ts")>(
    "src/shared/services/codexCatalogRevalidation.ts",
    {
      "@/shared/services/codexDiscoveryPolicy": {
        isCodexDiscoveryModelExcluded: ({ id }: { id: string }) => id === "deprecated-fixture",
      },
      "@/lib/db/models": models,
      "@/lib/db/providers": providers,
      "./modelSyncScheduler": transport,
    }
  );
  return { f, mod, models, providers, transport };
}

test("model-sync automatic start is a locked no-op; explicit sync denies before auth/DB/network", async () => {
  const { f, mod } = modelSyncFixture();
  mod.startModelSyncScheduler("http://127.0.0.1:20128");
  assert.deepEqual(f.effects, []);
  await f.denied(() => mod.syncConnectionModels("fixture", "fixture", "http://127.0.0.1:20128"));
  f.policyFailure = new RuntimePolicyError("bootstrap-invalid");
  mod.stopModelSyncScheduler();
  assert.deepEqual(f.effects, []);
});

test("model-sync generic internal fetch stays usable for separate callers; explicit sync preserves policy errors", async () => {
  const { f, mod, network } = modelSyncFixture();
  const requests: string[] = [];
  network.send = async (input: unknown) => {
    requests.push(String(input));
    return new Response("{}", { status: 200 });
  };
  assert.equal((await mod.fetchModelSyncInternal("http://127.0.0.1:20128/fixture")).status, 200);
  assert.deepEqual(requests, ["http://127.0.0.1:20128/fixture"]);
  f.locked = false;
  network.send = async () => {
    throw f.denial;
  };
  await assert.rejects(
    mod.syncConnectionModels("fixture", "fixture", "http://127.0.0.1:20128"),
    (error: unknown) => error === f.denial
  );
  assert.deepEqual(f.effects, []);
});

test("Codex catalog boot/init hooks are locked no-ops before version reads/DB/timers", async () => {
  const { f, mod } = codexRevalidationFixture();
  mod.scheduleCodexCatalogRevalidation();
  mod.scheduleCodexCatalogRevalidationAfterInit();
  await mod.revalidateCodexCatalogsOnStartup();
  assert.deepEqual(f.effects, []);
});

test("Codex explicit revalidation denies before scrub/import/readiness/DB/network", async () => {
  const { f, mod } = codexRevalidationFixture();
  await f.denied(() => mod.revalidateCodexCatalogs({ reason: "init" }));
  await f.denied(() => mod.waitForLoopbackHttpReady());
  await f.denied(() => mod.liveResyncCodexConnections());
  await f.denied(() =>
    mod.executeCodexCatalogRevalidation({
      appVersion: "fixture",
      scrub: f.trap("scrub callback"),
      waitForReady: f.trap("wait callback"),
      liveResync: f.trap("sync callback"),
      writeMarker: f.trap("marker callback"),
      logSuccess: f.trap("success log"),
    })
  );
  const coordinate = mod.createCodexCatalogRevalidationCoordinator(f.trap("coordinator run"));
  await f.denied(() => coordinate({ reason: "init" }));
});

test("Codex dedicated offline scrub remains available even when runtime policy is invalid", async () => {
  const { f, mod, models, providers } = codexRevalidationFixture();
  const writes: unknown[] = [];
  providers.getProviderConnections = (() => [
    { id: "fixture" },
  ]) as unknown as typeof providers.getProviderConnections;
  models.getSyncedAvailableModelsForConnection = (() => [
    { id: "deprecated-fixture" },
    { id: "kept-fixture" },
  ]) as unknown as typeof models.getSyncedAvailableModelsForConnection;
  models.replaceSyncedAvailableModelsForConnection = ((...args: unknown[]) => {
    writes.push(args);
  }) as unknown as typeof models.replaceSyncedAvailableModelsForConnection;
  f.policyFailure = new RuntimePolicyError("bootstrap-invalid");
  const result = await mod.scrubCodexPersistedCatalogs();
  assert.equal(result.modelsRemoved, 1);
  assert.equal(result.connectionsChanged, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(writes)), [
    ["codex", "fixture", [{ id: "kept-fixture" }]],
  ]);
  assert.deepEqual(f.effects, []);
});

test("Codex readiness/execution and allSettled revalidation preserve denial without retry or success", async () => {
  const { f, mod, providers, transport } = codexRevalidationFixture();
  f.locked = false;
  let sends = 0;
  transport.fetchModelSyncInternal = (() => {
    sends++;
    throw f.denial;
  }) as typeof transport.fetchModelSyncInternal;
  await assert.rejects(mod.waitForLoopbackHttpReady(), (error: unknown) => error === f.denial);
  assert.equal(sends, 1);
  await assert.rejects(
    mod.executeCodexCatalogRevalidation({
      appVersion: "fixture",
      scrub: async () => {},
      waitForReady: async () => {
        throw f.denial;
      },
      liveResync: f.trap("sync after denial"),
      writeMarker: f.trap("marker after denial"),
      logSuccess: f.trap("success after denial"),
    }),
    (error: unknown) => error === f.denial
  );
  providers.getProviderConnections = (() => [
    { id: "fixture", isActive: true },
  ]) as unknown as typeof providers.getProviderConnections;
  await assert.rejects(mod.liveResyncCodexConnections(), (error: unknown) => error === f.denial);
  assert.equal(sends, 2);
  assert.deepEqual(f.effects, []);
});

test("Codex coordinator drops queued init after a branded denial", async () => {
  const { f, mod } = codexRevalidationFixture();
  f.locked = false;
  let rejectRun: (error: unknown) => void = () => {};
  const runs: string[] = [];
  const coordinate = mod.createCodexCatalogRevalidationCoordinator(async ({ reason }) => {
    runs.push(reason);
    if (reason === "first-start")
      return new Promise<void>((_resolve, reject) => {
        rejectRun = reject;
      });
  });
  const initial = coordinate({ reason: "first-start" });
  const queued = coordinate({ reason: "init" });
  assert.equal(initial, queued);
  rejectRun(f.denial);
  await assert.rejects(initial, (error: unknown) => error === f.denial);
  assert.deepEqual(runs, ["first-start"]);
  await coordinate({ reason: "upgrade" });
  assert.deepEqual(runs, ["first-start", "upgrade"]);
  assert.deepEqual(f.effects, []);
});

test("reactive model-sync locked hook does not mutate cooldown/inflight or resolve/send; standalone stays active", async () => {
  const f = new Fixture();
  const calls: string[] = [];
  const scheduler = {
    getModelSyncInternalBaseUrl: f.trap("reactive origin"),
    syncConnectionModels: f.trap("reactive send"),
  };
  const mod = f.load<typeof import("../../../src/lib/providerModels/reactiveModelSync.ts")>(
    "src/lib/providerModels/reactiveModelSync.ts",
    {
      "@/shared/services/modelSyncScheduler": scheduler,
    }
  );
  assert.equal(mod.maybeTriggerReactiveModelSync("antigravity", "fixture-connection"), false);
  assert.equal(mod.maybeTriggerReactiveModelSync("antigravity", "fixture-connection"), false);
  assert.deepEqual(f.effects, []);
  f.locked = false;
  scheduler.getModelSyncInternalBaseUrl = (() =>
    "http://127.0.0.1:20128") as unknown as typeof scheduler.getModelSyncInternalBaseUrl;
  scheduler.syncConnectionModels = (async () => {
    calls.push("sync");
    return true;
  }) as unknown as typeof scheduler.syncConnectionModels;
  // No reset: proves locked no-op did not poison the connection's cooldown/inflight maps.
  assert.equal(mod.maybeTriggerReactiveModelSync("antigravity", "fixture-connection"), true);
  await Promise.resolve();
  assert.equal(mod.maybeTriggerReactiveModelSync("antigravity", "fixture-connection"), false);
  assert.deepEqual(calls, ["sync"]);
  assert.deepEqual(f.effects, []);
});

test("already-scheduled model and Codex callbacks become locked no-ops without changing standalone stop", async () => {
  const modelCallbacks: Array<() => Promise<void>> = [];
  let intervalCleared = 0;
  const { f: modelFixture, mod: model } = modelSyncFixture((f) => {
    f.globals.setTimeout = (callback: () => Promise<void>) => {
      modelCallbacks.push(callback);
      return { unref: noop };
    };
    f.globals.setInterval = (callback: () => Promise<void>) => {
      modelCallbacks.push(callback);
      return { unref: noop };
    };
    f.globals.clearInterval = () => {
      intervalCleared++;
    };
    f.imports["./codexCatalogRevalidation"] = { scheduleCodexCatalogRevalidation: noop };
  });
  modelFixture.locked = false;
  model.startModelSyncScheduler("http://127.0.0.1:20128");
  await Promise.resolve();
  modelFixture.locked = true;
  for (const callback of modelCallbacks) await callback();
  assert.equal(modelCallbacks.length, 2);
  assert.deepEqual(modelFixture.effects, []);
  modelFixture.policyFailure = new RuntimePolicyError("bootstrap-invalid");
  model.stopModelSyncScheduler();
  assert.equal(intervalCleared, 1);

  const catalogCallbacks: Array<() => void> = [];
  const { f: catalogFixture, mod: catalog } = codexRevalidationFixture((f) => {
    f.globals.setTimeout = (callback: () => void) => {
      catalogCallbacks.push(callback);
      return { unref: noop };
    };
  });
  catalogFixture.locked = false;
  catalog.scheduleCodexCatalogRevalidation();
  catalog.scheduleCodexCatalogRevalidationAfterInit();
  catalogFixture.locked = true;
  for (const callback of catalogCallbacks) callback();
  assert.equal(catalogCallbacks.length, 2);
  assert.deepEqual(catalogFixture.effects, []);
});

test("model-sync cycle does not mark success after branded allSettled failure, but keeps ordinary failures unchanged", async () => {
  let callback: (() => Promise<void>) | undefined;
  const { f, mod, network } = modelSyncFixture((fixture) => {
    fixture.globals.setTimeout = (run: () => Promise<void>) => {
      callback = run;
      return { unref: noop };
    };
    fixture.globals.setInterval = () => ({ unref: noop });
    fixture.imports["./codexCatalogRevalidation"] = { scheduleCodexCatalogRevalidation: noop };
    fixture.imports["@/lib/db/providers"] = {
      getProviderConnections: async () => [
        { id: "fixture", provider: "fixture", providerSpecificData: { autoSync: true } },
      ],
    };
  });
  Object.assign(f.imports["@/lib/exclusiveLeaseIsolation"] as object, {
    isConnectionUnavailableToAuxiliaryActivity: async () => false,
  });
  f.locked = false;
  mod.startModelSyncScheduler("http://127.0.0.1:20128");
  await Promise.resolve();
  let sends = 0;
  network.send = async () => {
    sends++;
    throw f.denial;
  };
  await assert.rejects(callback!(), (error: unknown) => error === f.denial);
  assert.equal(sends, 1);
  assert.deepEqual(f.effects, []);
  let markers = 0;
  Object.assign(f.imports["@/lib/db/settings"] as object, {
    updateSettings: async () => {
      markers++;
    },
  });
  network.send = async () => {
    sends++;
    throw new Error("ordinary failure");
  };
  await callback!();
  assert.equal(sends, 2);
  assert.equal(markers, 1);
  mod.stopModelSyncScheduler();
});

for (const action of ["approve", "message"] as const) {
  for (const source of ["credentials", "operation"] as const) {
    test(`cloud task POST ${action} ${source} policy denial keeps safe branded 403`, async () => {
      const { mod, calls, f } = cloudTaskRouteFixture(source);
      const response = await mod.POST(
        new Request("https://fixture.invalid/tasks/fixture", {
          method: "POST",
          body: JSON.stringify({ action, message: "fixture-message" }),
        }) as Parameters<typeof mod.POST>[0],
        { params: Promise.resolve({ id: "fixture" }) }
      );
      assert.equal(response.status, 403);
      assert.ok(isRuntimePolicyResponse(response));
      assert.equal(
        response.headers.get("Access-Control-Allow-Origin"),
        "https://fixture.example.invalid"
      );
      const body = await response.json();
      assert.equal(body.error.code, "OMNI_RUNTIME_POLICY_DENIED");
      assert.equal(body.error.message, "Request denied by runtime policy.");
      assert.equal("data" in body, false);
      assert.doesNotMatch(JSON.stringify(body), /private-token|private\/policy|at \//);
      assert.equal(calls.reads, 1);
      assert.equal(calls.writes, 0);
      assert.equal(calls.serialize, 0);
      assert.equal(calls.credentials, 1);
      assert.equal(calls.interactions, source === "operation" ? 1 : 0);
      assert.deepEqual(f.effects, []);
    });
  }
}

test("cloud task POST ordinary operation failure retains existing 500 path", async () => {
  const { mod, calls, f } = cloudTaskRouteFixture("ordinary");
  const response = await mod.POST(
    new Request("https://fixture.invalid/tasks/fixture", {
      method: "POST",
      body: JSON.stringify({ action: "approve" }),
    }) as Parameters<typeof mod.POST>[0],
    { params: Promise.resolve({ id: "fixture" }) }
  );
  assert.equal(response.status, 500);
  assert.equal(isRuntimePolicyResponse(response), false);
  assert.equal((await response.json()).error, "ordinary failure");
  assert.equal(calls.writes, 0);
  assert.equal(calls.credentials, 1);
  assert.equal(calls.interactions, 1);
  assert.deepEqual(f.effects, []);
});

function credentialSchedulerFixture(connectionCount = 1, locked = false) {
  const f = new Fixture();
  f.locked = locked;
  const clock = { now: 1_700_000_000_000 };
  const state = {
    initialized: false,
    sweepTimer: null as unknown,
    sweepInProgress: false,
    failureCounts: new Map<string, number>(),
    perConnTiming: new Map<string, { lastAttemptAt: number; nextAttemptAt: number }>(),
    terminalPolicyError: null as unknown,
  };
  const calls = {
    probes: [] as string[],
    health: [] as unknown[][],
    events: [] as unknown[][],
    initCache: 0,
    yields: 0,
    settings: 0,
    connections: 0,
    cacheReads: 0,
  };
  const health = new Map<string, { status: string; lastError?: unknown }>();
  const connections = Array.from({ length: connectionCount }, (_, index) => {
    const id = `fixture-health-${index}`;
    health.set(id, { status: "active" });
    return { id, provider: "fixture-provider", authType: "apikey" };
  });
  const control: { automated: boolean; probe: (id: string) => Promise<unknown> } = {
    automated: !locked,
    probe: async () => {
      throw f.denial;
    },
  };
  const timers: Array<{ run: () => unknown; delay: number; cleared: boolean }> = [];
  f.globals.__omnirouteCredentialHC = state;
  f.globals.Date = class extends Date {
    static now() {
      return clock.now;
    }
  };
  f.globals.setTimeout = (run: () => unknown, delay: number) => {
    const timer = { run, delay, cleared: false };
    timers.push(timer);
    return timer;
  };
  f.globals.clearTimeout = (timer: { cleared: boolean }) => {
    timer.cleared = true;
  };
  const mod = f.load<typeof import("../../../src/lib/credentialHealth/scheduler.ts")>(
    "src/lib/credentialHealth/scheduler.ts",
    {
      "node:timers/promises": {
        setImmediate: async () => {
          calls.yields++;
        },
      },
      "@/app/api/providers/[id]/test/route": {
        testSingleConnection: (id: string) => {
          calls.probes.push(id);
          return control.probe(id);
        },
      },
      "@/lib/db/providers": {
        getProviderConnections: async () => {
          calls.connections++;
          return connections;
        },
      },
      "@/lib/db/readCache": {
        getCachedSettings: async () => {
          calls.settings++;
          return { resilienceSettings: { credentialHealthCheck: { intervalMinutes: 1 } } };
        },
      },
      "@/lib/credentialHealth/cache": {
        getCredentialHealth: (id: string) => {
          calls.cacheReads++;
          return health.get(id);
        },
        setCredentialHealth: (...args: unknown[]) => {
          calls.health.push(args);
          health.set(String(args[0]), { status: String(args[2]), lastError: args[3] });
        },
        initCredentialCache: () => {
          calls.initCache++;
        },
      },
      "@/lib/credentialHealth/probePolicy": {
        isCredentialProbeInconclusive: () => false,
        resolveInconclusiveProbeRecheckDelayMs: f.trap("inconclusive delay"),
      },
      "@/lib/events/eventBus": {
        emit: (...args: unknown[]) => {
          calls.events.push(args);
        },
      },
      "@/shared/utils/testProcess": { isAutomatedTestProcess: () => control.automated },
      "@/lib/providers/validation/searchProviders": { SEARCH_VALIDATOR_CONFIGS: {} },
    }
  );
  return { f, mod, state, calls, health, connections, control, timers, clock };
}

test("credential-health branded probe denial preserves existing cache with zero failure/timing penalty", async () => {
  const { f, mod, state, calls, health, timers } = credentialSchedulerFixture();
  const error = await mod.forceSweep().then(
    () => null,
    (reason: unknown) => reason
  );
  assert.deepEqual([...state.failureCounts], []);
  assert.deepEqual([...state.perConnTiming], []);
  assert.deepEqual(calls.health, []);
  assert.deepEqual(calls.events, []);
  assert.deepEqual(health.get("fixture-health-0"), { status: "active" });
  assert.equal(error, f.denial);
  assert.equal(state.terminalPolicyError, f.denial);
  assert.equal(state.initialized, false);
  assert.equal(state.sweepInProgress, false);
  assert.equal(timers.length, 0);
  assert.deepEqual(f.effects, []);
});

test("credential-health allSettled propagates local denial and stops later batches", async () => {
  const { f, mod, state, calls, control, timers } = credentialSchedulerFixture(6);
  control.probe = async (id) => {
    if (id === "fixture-health-0") throw f.denial;
    return { skipped: true };
  };
  const error = await mod.forceSweep().then(
    () => null,
    (reason: unknown) => reason
  );
  assert.deepEqual(
    calls.probes,
    Array.from({ length: 5 }, (_, index) => `fixture-health-${index}`)
  );
  assert.equal(error, f.denial);
  assert.deepEqual([...state.failureCounts], []);
  assert.deepEqual([...state.perConnTiming], []);
  assert.deepEqual(calls.health, []);
  assert.equal(timers.length, 0);
  assert.deepEqual(f.effects, []);
});

test("credential-health queued startup callback and restart cannot probe after terminal denial", async () => {
  const { f, mod, state, calls, control, timers, clock } = credentialSchedulerFixture();
  control.automated = false;
  assert.equal(mod.initCredentialHealthCheck(), true);
  const queued = timers[0];
  await mod.sweep().catch(noop);
  const probesAtDenial = calls.probes.length;
  const initAtDenial = calls.initCache;
  clock.now += 10_000_000;
  queued.run();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(mod.initCredentialHealthCheck(), false);
  await assert.rejects(mod.forceSweep(), (error: unknown) => error === f.denial);
  assert.equal(calls.probes.length, probesAtDenial);
  assert.equal(calls.initCache, initAtDenial);
  assert.equal(queued.cleared, true);
  assert.equal(timers.length, 1);
  assert.equal(state.sweepTimer, null);
  f.policyFailure = new RuntimePolicyError("bootstrap-invalid");
  mod.stopCredentialHealthCheck();
  assert.equal(
    mod.resolveCredentialHealthSweepInterval({
      resilienceSettings: { credentialHealthCheck: { intervalMinutes: 2 } },
    }),
    120_000
  );
  assert.deepEqual(f.effects, []);
});

test("credential-health periodic callback latches denial and cached callback cannot retry", async () => {
  const { f, mod, state, calls, control, timers, clock } = credentialSchedulerFixture();
  control.probe = async () => ({ valid: true });
  await mod.forceSweep();
  assert.equal(calls.health.length, 1);
  const timingBefore = [...state.perConnTiming];
  const periodic = timers[0];
  clock.now = state.perConnTiming.get("fixture-health-0")!.nextAttemptAt + 1;
  control.probe = async () => {
    throw f.denial;
  };
  await periodic.run();
  assert.equal(state.terminalPolicyError, f.denial);
  assert.deepEqual([...state.failureCounts], []);
  assert.deepEqual([...state.perConnTiming], timingBefore);
  assert.equal(calls.health.length, 1);
  const probesAtDenial = calls.probes.length;
  clock.now += 10_000_000;
  await periodic.run();
  assert.equal(calls.probes.length, probesAtDenial);
  assert.equal(periodic.cleared, true);
  assert.equal(timers.length, 1);
  assert.deepEqual(f.effects, []);
});

test("credential-health policy-code lookalike error/result keep ordinary failure and success behavior", async () => {
  const { mod, state, calls, control, timers, clock, f } = credentialSchedulerFixture();
  control.probe = async () => {
    throw Object.assign(new Error("Request denied by runtime policy."), {
      code: "OMNI_RUNTIME_POLICY_DENIED",
      name: "RuntimePolicyError",
    });
  };
  await mod.forceSweep();
  assert.equal(state.failureCounts.get("fixture-health-0"), 1);
  assert.equal(calls.health.length, 1);
  assert.equal(calls.health[0][2], "error");
  assert.equal(state.initialized, true);
  assert.equal(state.terminalPolicyError, null);
  assert.equal(timers.length, 1);
  clock.now = state.perConnTiming.get("fixture-health-0")!.nextAttemptAt + 1;
  control.probe = async () => ({
    valid: false,
    error: "Request denied by runtime policy.",
    diagnosis: { code: "OMNI_RUNTIME_POLICY_DENIED", type: "RuntimePolicyError", source: "local" },
  });
  await timers[0].run();
  assert.equal(state.failureCounts.get("fixture-health-0"), 2);
  assert.equal(calls.health.length, 2);
  assert.equal(state.terminalPolicyError, null);
  assert.equal(timers.length, 2);
  clock.now = state.perConnTiming.get("fixture-health-0")!.nextAttemptAt + 1;
  control.probe = async () => ({ valid: true });
  await timers[1].run();
  assert.equal(state.failureCounts.size, 0);
  assert.equal(calls.health[2][2], "active");
  assert.equal(timers.length, 3);
  mod.stopCredentialHealthCheck();
  assert.equal(state.initialized, false);
  assert.deepEqual(f.effects, []);
});

test("credential-health locked import/init/sweep are no-ops and force denies before cache/timer/read/probe", async () => {
  const { f, mod, state, calls, health, control, timers } = credentialSchedulerFixture(1, true);
  control.automated = false;
  assert.equal(mod.initCredentialHealthCheck(), false);
  await mod.sweep();
  await f.denied(() => mod.forceSweep());
  assert.deepEqual(calls, {
    probes: [],
    health: [],
    events: [],
    initCache: 0,
    yields: 0,
    settings: 0,
    connections: 0,
    cacheReads: 0,
  });
  assert.equal(timers.length, 0);
  assert.equal(state.initialized, false);
  assert.deepEqual([...state.failureCounts], []);
  assert.deepEqual([...state.perConnTiming], []);
  assert.deepEqual(health.get("fixture-health-0"), { status: "active" });
  f.policyFailure = new RuntimePolicyError("bootstrap-invalid");
  mod.stopCredentialHealthCheck();
  assert.equal(mod.resolveCredentialHealthSweepInterval(null), 3_600_000);
  assert.deepEqual(f.effects, []);
});

test("credential-health cached ordinary-start callback becomes a locked no-op before reads", async () => {
  const { f, mod, state, calls, control, timers, clock } = credentialSchedulerFixture();
  control.probe = async () => ({ valid: true });
  await mod.forceSweep();
  const snapshot = JSON.stringify(calls);
  const timing = [...state.perConnTiming];
  clock.now = state.perConnTiming.get("fixture-health-0")!.nextAttemptAt + 1;
  f.locked = true;
  await timers[0].run();
  assert.equal(JSON.stringify(calls), snapshot);
  assert.deepEqual([...state.perConnTiming], timing);
  assert.equal(timers.length, 1);
  assert.equal(mod.initCredentialHealthCheck(), false);
  mod.stopCredentialHealthCheck();
  assert.equal(timers[0].cleared, true);
  assert.deepEqual(f.effects, []);
});
