import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const BROWSER = "http://127.0.0.1:19222";
const ADVERTISED = "ws://127.0.0.1:19222/devtools/browser/fixture-id";
const CODEX = "ws://127.0.0.1:19456";
const REMOTE = "http://helper.example.invalid:19222";
const DIRECTORY = "/run/omni-runtime-policy";
const PROFILE = "omni-app-residential-direct-v1";

// Each fixture evaluates the actual owned source and canonical authority in one
// fresh realm. Only synthetic policy bytes and dependency stubs are visible. No
// live policy files, app/provider/DB modules, helper processes or network are used.
function fixture(locked = true, browserEndpoint = BROWSER) {
  const counts = {
    fetch: 0,
    connect: 0,
    spawn: 0,
    listen: 0,
    tokenRead: 0,
    db: 0,
    fallback: 0,
    nativeImport: 0,
    forwarded: 0,
  };
  const env: Record<string, string> = {};
  const policyBytes = Buffer.from(
    JSON.stringify({
      schema: 1,
      profile: PROFILE,
      providers: [],
      helpers: [
        { role: "browser-cdp", endpoint: browserEndpoint },
        { role: "codex-app-server", endpoint: CODEX },
      ],
    })
  );
  const markerBytes = Buffer.from(
    JSON.stringify({
      schema: 1,
      profile: PROFILE,
      policySha256: createHash("sha256").update(policyBytes).digest("hex"),
    })
  );
  const files = new Map([
    [`${DIRECTORY}/policy.json`, policyBytes],
    [`${DIRECTORY}/required-v1.json`, markerBytes],
  ]);
  const descriptorFiles = new Map<number, string>();
  const metadata = (directory: boolean, size = 1) => ({
    dev: 1,
    ino: 2,
    uid: 0,
    gid: 0,
    mode: directory ? 0o40555 : 0o100444,
    nlink: directory ? 2 : 1,
    size,
    mtimeMs: 1,
    ctimeMs: 1,
    isDirectory: () => directory,
    isFile: () => !directory,
    isSymbolicLink: () => false,
  });
  const missing = () => {
    throw Object.assign(new Error("synthetic absent"), { code: "ENOENT" });
  };
  const fakeFs = {
    constants: { O_RDONLY: 0, O_NOFOLLOW: 1, O_NONBLOCK: 2 },
    lstatSync(name: string) {
      if (!locked) return missing();
      if (["/", "/run", DIRECTORY].includes(name)) return metadata(true);
      const bytes = files.get(name);
      return bytes ? metadata(false, bytes.length) : missing();
    },
    openSync(name: string) {
      const fd = 40000 + descriptorFiles.size;
      descriptorFiles.set(fd, name);
      return fd;
    },
    fstatSync(fd: number) {
      return metadata(false, files.get(descriptorFiles.get(fd)!)!.length);
    },
    readFileSync(name: number | string) {
      if (typeof name === "number") return files.get(descriptorFiles.get(name)!);
      counts.tokenRead++;
      return "fixture-token";
    },
    closeSync(fd: number) {
      descriptorFiles.delete(fd);
    },
    existsSync() {
      return true;
    },
  };
  let fetchReply = () => Response.json({ webSocketDebuggerUrl: ADVERTISED });
  let proxy: unknown = null;
  let transportError: unknown;
  let upgradeRedirect = false;
  let turnError: unknown;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  const connectCalls: string[] = [];
  const page = { isClosed: () => false, close: async () => {} };
  const browserContext = { newPage: async () => page, close: async () => {} };
  const browser = {
    isConnected: () => true,
    newContext: async () => browserContext,
    close: async () => {},
  };
  const chromium = {
    connectOverCDP: async (url: string) => {
      counts.connect++;
      connectCalls.push(url);
      if (upgradeRedirect) counts.forwarded++;
      if (transportError) throw transportError;
      return browser;
    },
    launch: async () => {
      counts.spawn++;
      return browser;
    },
  };
  const mockBridge = {
    buildResponseJSON: (events: unknown[]) => ({ events }),
    bridgeToResponsesSSE: (events: AsyncIterable<unknown>) =>
      new ReadableStream({
        async start(controller) {
          for await (const event of events)
            controller.enqueue(new TextEncoder().encode(JSON.stringify(event)));
          controller.enqueue(new TextEncoder().encode("done"));
          controller.close();
        },
      }),
  };
  const context = vm.createContext({
    console: { info() {}, warn() {}, error() {}, log() {} },
    URL,
    Buffer,
    Error,
    TypeError,
    TextEncoder,
    TextDecoder,
    Response,
    Request,
    Headers,
    ReadableStream,
    TransformStream,
    AbortController,
    AbortSignal,
    DOMException,
    performance,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    process: { env, argv: ["node", "/fixture/entry.js"], pid: 123 },
    fetch: async (url: string, init?: RequestInit) => {
      counts.fetch++;
      fetchCalls.push({ url, init });
      return fetchReply();
    },
  });
  const modules = new Map<string, Record<string, unknown>>();
  const owned = new Set([
    "scripts/build/runtime-policy.mjs",
    "open-sse/services/obscura.ts",
    "open-sse/services/browserPool.ts",
    "open-sse/executors/codex.ts",
    "open-sse/executors/codex-app-server.ts",
    "open-sse/executors/codex/appServerConfig.ts",
    "open-sse/executors/codex/appServerClient.ts",
    "open-sse/executors/codex/appServerAuthProbe.ts",
    "open-sse/executors/chatgpt-web-codex.ts",
    "open-sse/vendor/codex-chatgpt-web/adapters/chatgpt-web/browser-worker.ts",
    "open-sse/vendor/codex-chatgpt-web/adapters/chatgpt-web/launcher-helper-client.ts",
    "open-sse/vendor/codex-chatgpt-web/event-queue.ts",
  ]);
  class BaseExecutor {
    constructor(..._args: unknown[]) {}
    async execute() {
      counts.fallback++;
      throw new Error("unexpected HTTP fallback");
    }
  }
  function load<T>(relative: string): T {
    if (modules.has(relative)) return modules.get(relative) as T;
    const filename = new URL(`../../../${relative}`, import.meta.url);
    const original = readFileSync(filename, "utf8");
    const source = original.replaceAll("import.meta.url", JSON.stringify(filename.href));
    const compiled = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    }).outputText;
    const module = { exports: {} as Record<string, unknown> };
    modules.set(relative, module.exports);
    const requireMock = (id: string): unknown => {
      if (id.includes("shared/runtimePolicy")) return load("scripts/build/runtime-policy.mjs");
      if (id === "node:fs") return fakeFs;
      if (id === "node:crypto") return { createHash, randomUUID: () => "fixture-id" };
      if (id === "node:net")
        return {
          isIP,
          createServer: () => {
            counts.listen++;
            throw new Error("unexpected listener");
          },
        };
      if (id === "node:child_process")
        return {
          spawn: () => {
            counts.spawn++;
            throw new Error("unexpected child process");
          },
        };
      if (id === "node:path") return path;
      if (id === "node:buffer") return { Buffer };
      if (id === "module")
        return {
          createRequire: () => () => ({
            websocket: async () => {
              counts.connect++;
              throw new Error("unexpected native websocket");
            },
          }),
        };
      if (id === "playwright" || id === "playwright-core") {
        counts.nativeImport++;
        return { chromium };
      }
      if (id.endsWith("lib/db/proxies"))
        return {
          resolveProxyForProvider: async () => {
            counts.db++;
            return proxy;
          },
        };
      if (id.includes("utils/featureFlags"))
        return { isFeatureFlagEnabled: (key: string) => env[key] !== "false" };
      if (id.endsWith("/base.ts")) return { BaseExecutor };
      if (id.endsWith("/adapter-error")) return { ChatGptWebAdapterError: class extends Error {} };
      if (id.endsWith("/bridge.ts")) return mockBridge;
      if (id.endsWith("config/constants.ts"))
        return { PROVIDERS: { codex: {}, "codex-app-server": {} }, HTTP_STATUS: {} };
      if (id.endsWith("utils/error.ts"))
        return {
          sanitizeErrorMessage: () => "safe fixture error",
          buildErrorBody: () => ({ error: {} }),
        };
      if (id.endsWith("config/codexIdentity.ts"))
        return {
          withCodexFingerprintCredentials: (credentials: unknown) => credentials,
          isVerifiedNativeCodexRequest: () => true,
        };
      if (id.endsWith("translator/formats.ts"))
        return { FORMATS: { OPENAI_RESPONSES: "openai-responses" } };
      if (id.endsWith("/config"))
        return {
          CHATGPT_CONNECTOR_NAME: "fixture-connector",
          getConfigDir: () => "/fixture/config",
          expandUserPath: (v: string) => v,
          isLegacyChatGptConnectorName: () => false,
          defaultChromeExecutable: () => "/fixture/chrome",
        };
      if (id.endsWith("/browser-login") || id.endsWith("/browser-login.ts"))
        return {
          loginVerificationMarkerPath: () => "/fixture/verified",
          browserLoginStateExists: () => true,
        };
      if (id.endsWith("/index.ts") && id.includes("adapters/chatgpt-web"))
        return {
          createChatGptWebAdapter: () => ({
            runTurn: async () => {
              if (turnError) throw turnError;
            },
          }),
        };
      if (id.endsWith("/environment.ts"))
        return {
          extractChatGptTurnIdentity: () => ({
            threadId: "fixture-thread",
            turnId: "fixture-turn",
          }),
        };
      if (id.endsWith("responses/parser.ts"))
        return { parseRequest: () => ({ options: {}, context: {} }) };
      if (id.endsWith("responses/state.ts")) return { rememberResponseState() {} };
      if (id.endsWith("/models.ts"))
        return {
          requireChatGptWebCodexRoute: () => ({ sol: true, backendModel: "fixture-model" }),
          reasoningEffortOf: () => undefined,
        };
      if (id.endsWith("/storageState.ts"))
        return {
          connectionRuntimePaths: () => ({}),
          ensureConnectionStorageStateFromCredential: () => "/fixture/storage",
          readConnectionStorageState: () => ({}),
        };
      if (id.endsWith("/credentials.ts"))
        return {
          decodeChatGptWebCodexSecrets: () => ({}),
          encodeChatGptWebCodexSecrets: () => "fixture",
        };
      if (id.endsWith("/runtime.ts")) return { trackChatGptWebCodexRuntime() {} };
      if (id.endsWith("appServerEvents.ts")) return { translateNotification: () => true };
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), id));
      for (const candidate of [resolved, `${resolved}.ts`]) {
        if (owned.has(candidate)) return load(candidate);
      }
      // Unused imports are inert. No fallback to Node's require or app modules.
      return {};
    };
    context.__module = module;
    context.__require = requireMock;
    vm.runInContext(
      `(function(module, exports, require) {\n${compiled}\n})(__module, __module.exports, __require);`,
      context,
      { filename: filename.pathname }
    );
    return module.exports as T;
  }
  const authority = load<typeof import("../../../src/shared/runtimePolicy.ts")>(
    "scripts/build/runtime-policy.mjs"
  );
  assert.equal(authority.getRuntimePolicy().mode, locked ? "locked" : "standalone");
  const obscura = () =>
    load<typeof import("../../../open-sse/services/obscura.ts")>("open-sse/services/obscura.ts");
  const pool = () =>
    load<typeof import("../../../open-sse/services/browserPool.ts")>(
      "open-sse/services/browserPool.ts"
    );
  const config = () =>
    load<typeof import("../../../open-sse/executors/codex/appServerConfig.ts")>(
      "open-sse/executors/codex/appServerConfig.ts"
    );
  return {
    counts,
    assertHelper: (
      endpoint: string,
      phase: "configured" | "connect" | "advertised-cdp-websocket"
    ) => {
      context.__authority = authority;
      context.__helperUse = JSON.stringify({ role: "browser-cdp", endpoint, phase });
      vm.runInContext("__authority.assertLocalHelper(JSON.parse(__helperUse))", context);
    },
    env,
    authority,
    load,
    obscura,
    pool,
    config,
    fetchCalls,
    connectCalls,
    setFetchReply: (reply: () => Response) => {
      fetchReply = reply;
    },
    setProxy: (value: unknown) => {
      proxy = value;
    },
    setUpgradeRedirect: (value: boolean) => {
      upgradeRedirect = value;
    },
    setTransportError: (value: unknown) => {
      transportError = value;
    },
    setTurnError: (value: unknown) => {
      turnError = value;
    },
  };
}

function denied(f: ReturnType<typeof fixture>, reason = "helper-unapproved") {
  return (error: unknown) => {
    assert.ok(f.authority.isRuntimePolicyError(error));
    assert.equal(error.reason, reason);
    return true;
  };
}

for (const endpoint of [
  REMOTE,
  "http://localhost:19222",
  "http://127.1:19222",
  "http://127.0.0.1:19223",
  `${BROWSER}?x=y`,
  ` ${BROWSER}`,
  `${BROWSER}#fragment`,
]) {
  test(`CDP denies literal configured endpoint before discovery: ${endpoint}`, async () => {
    const f = fixture();
    f.env.OBSCURA_CDP_ENDPOINT = endpoint;
    await assert.rejects(f.obscura().connectObscuraBrowser(), denied(f));
    assert.equal(f.counts.fetch + f.counts.connect + f.counts.spawn, 0);
  });
}

test("approved CDP endpoint still denies unsupported redirecting attachment before native import", async () => {
  const f = fixture();
  f.env.OBSCURA_CDP_ENDPOINT = BROWSER;
  f.setUpgradeRedirect(true);
  assert.doesNotThrow(() => f.assertHelper(BROWSER, "configured"));
  await assert.rejects(f.obscura().connectObscuraBrowser(), denied(f, "capability-disabled"));
  assert.equal(f.counts.fetch + f.counts.connect + f.counts.forwarded + f.counts.nativeImport, 0);
  assert.equal(f.counts.spawn + f.counts.listen, 0);
});

for (const endpoint of [
  "ws://helper.example.invalid:19222/devtools/browser/fixture-id",
  "ws://127.0.0.1:19223/devtools/browser/fixture-id",
  "ws://127.0.0.2:19222/devtools/browser/fixture-id",
  "ws://127.0.0.1:19222/not-devtools",
  "ws://127.0.0.1:19222/devtools/browser/fixture-id?token=x",
]) {
  test(`CDP advertised endpoint validation remains independent of attach availability: ${endpoint}`, () => {
    const f = fixture();
    assert.throws(() => f.assertHelper(endpoint, "advertised-cdp-websocket"), denied(f));
    assert.equal(f.counts.fetch + f.counts.connect, 0);
  });
}

for (const status of [301, 302, 307, 308]) {
  test(`locked CDP never reaches HTTP redirect ${status} or upgrade redirect transport`, async () => {
    const f = fixture();
    f.env.OBSCURA_CDP_ENDPOINT = BROWSER;
    f.setFetchReply(() => new Response(null, { status, headers: { location: REMOTE } }));
    f.setUpgradeRedirect(true);
    await assert.rejects(f.obscura().connectObscuraBrowser(), denied(f, "capability-disabled"));
    assert.equal(f.counts.fetch + f.counts.connect + f.counts.forwarded + f.counts.nativeImport, 0);
  });
}

test("cached Obscura endpoint and newly selected env are checked before reuse", async () => {
  const f = fixture();
  f.env.OBSCURA_CDP_ENDPOINT = BROWSER;
  const cached = await f.obscura().ensureObscuraServer();
  assert.ok(cached);
  cached.endpoint = REMOTE;
  await assert.rejects(f.obscura().ensureObscuraServer(), denied(f));
  cached.endpoint = BROWSER;
  f.env.OBSCURA_CDP_ENDPOINT = REMOTE;
  await assert.rejects(f.obscura().ensureObscuraServer(), denied(f));
  assert.equal(f.counts.fetch + f.counts.connect, 0);
});

test("Obscura and browser pool cannot spawn or allocate ports when locked", async () => {
  const f = fixture();
  f.env.OBSCURA_BIN = "/fixture/arbitrary-browser";
  await assert.rejects(f.obscura().ensureObscuraServer(), denied(f, "capability-disabled"));
  await assert.rejects(
    f.pool().acquireBrowserContext("fixture", { cookieDomain: ".example.invalid" }),
    denied(f, "capability-disabled")
  );
  assert.equal(f.counts.spawn + f.counts.listen + f.counts.fetch + f.counts.db, 0);
});

test("browser DB proxy denial stays terminal rather than catch-to-direct", async () => {
  const f = fixture();
  for (const value of [{ host: "proxy.example.invalid", port: 8080 }, {}]) {
    await assert.rejects(
      f.pool().resolvePlaywrightProxy("fixture", {
        resolveProxy: async () => value as { host: string; port: number },
      }),
      denied(f, "proxy-forbidden")
    );
  }
  const error = new f.authority.RuntimePolicyError("proxy-forbidden");
  await assert.rejects(
    f.pool().resolvePlaywrightProxy("fixture", {
      resolveProxy: async () => {
        throw error;
      },
    }),
    (caught) => caught === error
  );
  assert.equal(
    await f.pool().resolvePlaywrightProxy("fixture", { resolveProxy: async () => null }),
    undefined
  );
  assert.equal(f.counts.connect + f.counts.spawn, 0);
});

test("browser pool denies unsupported CDP before even proxy selection", async () => {
  const f = fixture();
  f.env.OBSCURA_CDP_ENDPOINT = BROWSER;
  f.setProxy({ host: "proxy.example.invalid", port: 8080 });
  await assert.rejects(
    f.pool().acquireBrowserContext("fixture", { cookieDomain: ".example.invalid" }),
    denied(f, "capability-disabled")
  );
  assert.equal(f.counts.db + f.counts.nativeImport, 0);
  assert.equal(f.counts.fetch + f.counts.connect + f.counts.spawn + f.counts.forwarded, 0);
});

for (const endpoint of [
  "ws://helper.example.invalid:19456",
  "ws://localhost:19456",
  "ws://127.1:19456",
  "ws://127.0.0.1:19457",
  ` ${CODEX}`,
  "http://127.0.0.1:19456",
]) {
  test(`Codex selected endpoint denied before missing-token/null/SSRF fallback: ${endpoint}`, () => {
    const f = fixture();
    f.env.OMNIROUTE_CODEX_APPSERVER_WS = CODEX;
    f.env.OMNIROUTE_CODEX_APPSERVER_WS_TOKEN_FILE = "/fixture/token";
    assert.throws(
      () => f.config().resolveAppServerConfig({ codexAppServerUrl: endpoint }),
      denied(f)
    );
    assert.equal(f.counts.tokenRead + f.counts.connect, 0);
  });
}

test("Codex PSD precedence approves only the selected literal endpoint", () => {
  const f = fixture();
  f.env.OMNIROUTE_CODEX_APPSERVER_WS = "ws://remote.example.invalid:19456";
  const config = f
    .config()
    .resolveAppServerConfig({ codexAppServerUrl: CODEX, codexAppServerToken: "fixture" });
  assert.equal(config?.url, CODEX);
  assert.throws(
    () => f.config().resolveAppServerConfig({ codexAppServerToken: "fixture" }),
    denied(f)
  );
});

test("regular Codex and first-class app-server reject before native import, send or HTTP fallback", async () => {
  const f = fixture();
  const codex = f.load<typeof import("../../../open-sse/executors/codex.ts")>(
    "open-sse/executors/codex.ts"
  );
  const sibling = f.load<typeof import("../../../open-sse/executors/codex-app-server.ts")>(
    "open-sse/executors/codex-app-server.ts"
  );
  const input = {
    model: "fixture-model",
    body: {},
    stream: true,
    credentials: {
      providerSpecificData: {
        codexTransport: "app-server",
        codexAppServerUrl: "ws://remote.example.invalid:19456",
      },
    },
  };
  await assert.rejects(new codex.CodexExecutor().execute(input), denied(f));
  await assert.rejects(
    new sibling.CodexAppServerExecutor({}, "codex-app-server").execute(input),
    denied(f)
  );
  f.env.OMNIROUTE_CODEX_APP_SERVER_ENABLED = "false";
  assert.throws(() => codex.isCodexAppServerRequired(input.credentials), denied(f));
  assert.equal(f.counts.connect + f.counts.fallback + f.counts.tokenRead, 0);
});

test("Codex client checks each connect including cached/reused client", async () => {
  const f = fixture();
  const { CodexAppServerClient } = f.load<
    typeof import("../../../open-sse/executors/codex/appServerClient.ts")
  >("open-sse/executors/codex/appServerClient.ts");
  let connects = 0;
  const socket = { send() {}, close() {}, onmessage: null, onerror: null, onclose: null };
  const client = new CodexAppServerClient({
    websocketFn: async () => {
      connects++;
      return socket;
    },
  });
  await client.connect(CODEX, "fixture");
  assert.equal(connects, 1);
  await assert.rejects(client.connect("ws://remote.example.invalid:19456", "fixture"), denied(f));
  assert.equal(connects, 1);
  client.close();
});

test("Codex async executor preserves branded errors for JSON and streaming", async () => {
  const f = fixture();
  const { CodexAppServerExecutor } = f.load<
    typeof import("../../../open-sse/executors/codex-app-server.ts")
  >("open-sse/executors/codex-app-server.ts");
  const error = new f.authority.RuntimePolicyError("helper-unapproved");
  const executor = new CodexAppServerExecutor({
    websocketFn: async () => {
      throw error;
    },
  });
  const input = {
    model: "fixture-model",
    body: {},
    stream: false,
    credentials: {
      providerSpecificData: { codexAppServerUrl: CODEX, codexAppServerToken: "fixture" },
    },
  };
  await assert.rejects(executor.execute(input), (caught) => caught === error);
  const result = await executor.execute({ ...input, stream: true });
  assert.ok(!(result instanceof Response));
  await assert.rejects(result.response.text(), (caught) => caught === error);
  assert.equal(f.authority.isRuntimePolicyResponse(result.response), true);
});

test("browser-worker denies managed local launch and launcher descriptors before I/O", async () => {
  const f = fixture();
  const worker = f.load<
    typeof import("../../../open-sse/vendor/codex-chatgpt-web/adapters/chatgpt-web/browser-worker.ts")
  >("open-sse/vendor/codex-chatgpt-web/adapters/chatgpt-web/browser-worker.ts");
  for (const chatgptWeb of [
    { chromeExecutablePath: "/fixture/chrome" },
    { browserHost: "launcher" as const, browserHostDescriptorPath: "/fixture/descriptor" },
    { cdpEndpoint: REMOTE },
  ]) {
    assert.throws(
      () =>
        worker.resolveBrowserConfig({
          adapter: "chatgpt-web",
          baseUrl: "https://provider.example.invalid",
          chatgptWeb,
        }),
      (error) => f.authority.isRuntimePolicyError(error)
    );
  }
  const { LauncherBrowserHelperClient } = f.load<
    typeof import("../../../open-sse/vendor/codex-chatgpt-web/adapters/chatgpt-web/launcher-helper-client.ts")
  >("open-sse/vendor/codex-chatgpt-web/adapters/chatgpt-web/launcher-helper-client.ts");
  const helper = new LauncherBrowserHelperClient({
    browserHost: "launcher",
  } as ConstructorParameters<typeof LauncherBrowserHelperClient>[0]);
  await assert.rejects(
    helper.run({} as Parameters<typeof helper.run>[0]),
    denied(f, "capability-disabled")
  );
  assert.equal(f.counts.spawn + f.counts.tokenRead + f.counts.fetch + f.counts.connect, 0);
});

test("browser-worker configured, discovered and cached endpoints are guarded", async () => {
  const f = fixture();
  const { ChatGptBrowserWorker } = f.load<
    typeof import("../../../open-sse/vendor/codex-chatgpt-web/adapters/chatgpt-web/browser-worker.ts")
  >("open-sse/vendor/codex-chatgpt-web/adapters/chatgpt-web/browser-worker.ts");
  const worker = ChatGptBrowserWorker.forProvider({
    adapter: "chatgpt-web",
    baseUrl: "https://provider.example.invalid",
    chatgptWeb: { cdpEndpoint: BROWSER, storageStatePath: "/fixture/state" },
  });
  const isolated = worker as unknown as {
    ensurePage: () => Promise<unknown>;
    config: { cdpEndpoint: string };
  };
  await assert.rejects(isolated.ensurePage(), denied(f, "capability-disabled"));
  isolated.config.cdpEndpoint = REMOTE;
  await assert.rejects(isolated.ensurePage(), denied(f));
  assert.equal(f.counts.fetch + f.counts.connect + f.counts.forwarded + f.counts.tokenRead, 0);
});

test("ChatGPT connection endpoint beats env, with no trim-to-approved bypass", () => {
  const f = fixture();
  const { resolveChatGptWebCodexCdpEndpoint } = f.load<
    typeof import("../../../open-sse/executors/chatgpt-web-codex.ts")
  >("open-sse/executors/chatgpt-web-codex.ts");
  f.env.CHATGPT_WEB_CODEX_CDP_URL = REMOTE;
  assert.equal(resolveChatGptWebCodexCdpEndpoint({ browserCdpEndpoint: BROWSER }), BROWSER);
  assert.throws(() => resolveChatGptWebCodexCdpEndpoint({}), denied(f));
  assert.throws(
    () => resolveChatGptWebCodexCdpEndpoint({ browserCdpEndpoint: ` ${BROWSER} ` }),
    denied(f)
  );
  delete f.env.CHATGPT_WEB_CODEX_CDP_URL;
  assert.throws(() => resolveChatGptWebCodexCdpEndpoint({}), denied(f, "capability-disabled"));
});

test("ordinary standalone keeps helper, proxy and null-fallback behavior", async () => {
  const f = fixture(false);
  f.env.OBSCURA_CDP_ENDPOINT = REMOTE;
  await f.obscura().connectObscuraBrowser();
  assert.deepEqual(f.connectCalls, [REMOTE]);
  assert.equal(f.counts.fetch, 0);
  const proxy = await f.pool().resolvePlaywrightProxy("fixture", {
    resolveProxy: async () => ({ type: "http", host: "proxy.example.invalid", port: 8080 }),
  });
  assert.equal(proxy?.server, "http://proxy.example.invalid:8080");
  assert.equal(
    await f.pool().resolvePlaywrightProxy("fixture", {
      resolveProxy: async () => {
        throw new Error("synthetic DB unavailable");
      },
    }),
    undefined
  );
  assert.equal(
    f.config().resolveAppServerConfig({
      codexAppServerUrl: "http://invalid",
      codexAppServerToken: "fixture",
    }),
    null
  );
  assert.equal(
    f.config().resolveAppServerConfig({
      codexAppServerUrl: "ws://remote.example.invalid:19456",
      codexAppServerToken: "fixture",
    })?.url,
    "ws://remote.example.invalid:19456"
  );
});

test("ChatGPT executor preserves policy errors before fallback and across async responses", async () => {
  const f = fixture();
  const { ChatGptWebCodexExecutor } = f.load<
    typeof import("../../../open-sse/executors/chatgpt-web-codex.ts")
  >("open-sse/executors/chatgpt-web-codex.ts");
  const input = {
    model: "fixture-model",
    body: { _nativeCodexPassthrough: true },
    stream: false,
    clientResponseFormat: "openai-responses",
    credentials: {
      connectionId: "fixture-connection",
      apiKey: "fixture",
      providerSpecificData: { browserCdpEndpoint: REMOTE },
    },
  };
  const executor = new ChatGptWebCodexExecutor();
  await assert.rejects(executor.execute(input), denied(f));
  input.credentials.providerSpecificData.browserCdpEndpoint = BROWSER;
  const error = new f.authority.RuntimePolicyError("helper-unapproved");
  f.setTurnError(error);
  let refreshed = 0;
  const validInput = {
    ...input,
    onCredentialsRefreshed: async () => {
      refreshed++;
    },
  };
  await assert.rejects(executor.execute(validInput), (caught) => caught === error);
  const result = await executor.execute({ ...validInput, stream: true });
  assert.ok(!(result instanceof Response));
  await assert.rejects(result.response.text(), (caught) => caught === error);
  assert.equal(f.authority.isRuntimePolicyResponse(result.response), true);
  assert.equal(refreshed, 0);
  assert.equal(f.counts.spawn + f.counts.connect + f.counts.fallback, 0);
});

test("browser pool repeated attempts remain unavailable and cleanup is not denied", async () => {
  const f = fixture();
  f.env.OBSCURA_CDP_ENDPOINT = BROWSER;
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(
      f.pool().acquireBrowserContext("fixture", { cookieDomain: ".example.invalid" }),
      denied(f, "capability-disabled")
    );
  }
  assert.equal(f.counts.fetch + f.counts.connect + f.counts.nativeImport + f.counts.db, 0);
  await f.pool().shutdownPool("fixture-cleanup");
  f.obscura().killSharedObscuraServer();
});

test("literal approved websocket also cannot enter redirecting Playwright transport", async () => {
  const endpoint = "ws://127.0.0.1:19222";
  const f = fixture(true, endpoint);
  f.env.OBSCURA_CDP_ENDPOINT = endpoint;
  f.setUpgradeRedirect(true);
  assert.doesNotThrow(() => f.assertHelper(endpoint, "configured"));
  await assert.rejects(f.obscura().connectObscuraBrowser(), denied(f, "capability-disabled"));
  assert.equal(f.counts.fetch + f.counts.connect + f.counts.forwarded + f.counts.nativeImport, 0);
});

test("browser-worker both attach paths and cached pages deny while close remains available", async () => {
  const f = fixture();
  const { ChatGptBrowserWorker } = f.load<
    typeof import("../../../open-sse/vendor/codex-chatgpt-web/adapters/chatgpt-web/browser-worker.ts")
  >("open-sse/vendor/codex-chatgpt-web/adapters/chatgpt-web/browser-worker.ts");
  const worker = ChatGptBrowserWorker.forProvider({
    adapter: "chatgpt-web",
    baseUrl: "https://provider.example.invalid",
    chatgptWeb: { cdpEndpoint: BROWSER, storageStatePath: "/fixture/state" },
  });
  const isolated = worker as unknown as {
    ensurePage: () => Promise<unknown>;
    ensureManagedBrowser: () => Promise<unknown>;
    page: { isClosed: () => boolean };
  };
  isolated.page = { isClosed: () => false };
  await assert.rejects(isolated.ensurePage(), denied(f, "capability-disabled"));
  await assert.rejects(isolated.ensureManagedBrowser(), denied(f, "capability-disabled"));
  assert.equal(
    f.counts.fetch + f.counts.connect + f.counts.spawn + f.counts.forwarded + f.counts.tokenRead,
    0
  );
  await worker.close();
});

test("ordinary managed browser launch remains available with a synthetic launcher", async () => {
  const f = fixture(false);
  const { ChatGptBrowserWorker } = f.load<
    typeof import("../../../open-sse/vendor/codex-chatgpt-web/adapters/chatgpt-web/browser-worker.ts")
  >("open-sse/vendor/codex-chatgpt-web/adapters/chatgpt-web/browser-worker.ts");
  const worker = ChatGptBrowserWorker.forProvider({
    adapter: "chatgpt-web",
    baseUrl: "https://provider.example.invalid",
    chatgptWeb: { chromeExecutablePath: "/fixture/chrome", storageStatePath: "/fixture/state" },
  });
  await (worker as unknown as { ensurePage: () => Promise<unknown> }).ensurePage();
  assert.equal(f.counts.spawn, 1);
  assert.equal(f.counts.fetch + f.counts.connect, 0);
});

test("vendor terminal catch sites retain policy provenance before retry/wrapping", () => {
  const filename = new URL(
    "../../../open-sse/vendor/codex-chatgpt-web/adapters/chatgpt-web/index.ts",
    import.meta.url
  );
  const source = readFileSync(filename, "utf8");
  const ast = ts.createSourceFile(filename.pathname, source, ts.ScriptTarget.ES2022, true);
  const submitted = ast.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === "submittedTurnFailure"
  );
  assert.ok(submitted);
  const f = fixture();
  const policyError = new f.authority.RuntimePolicyError("helper-unapproved");
  const script = ts.transpileModule(submitted.getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const context = vm.createContext({
    Error,
    isRuntimePolicyError: f.authority.isRuntimePolicyError,
    ChatGptWebAdapterError: class extends Error {},
  });
  vm.runInContext(script, context);
  for (const phase of ["prepared", "send_activated", "accepted"]) {
    assert.equal(
      context.submittedTurnFailure({ runtime: { submission: { phase } } }, policyError),
      policyError
    );
  }
  assert.match(
    source,
    /catch \(error\) \{\s*if \(isRuntimePolicyError\(error\)\) throw error;\s*let handoffError/
  );
  assert.match(
    source,
    /catch \(retirementError\) \{\s*if \(isRuntimePolicyError\(retirementError\)\) throw retirementError;/
  );
  assert.equal(
    (
      source.match(
        /catch \(error\) \{\s*if \(isRuntimePolicyError\(error\)\) throw error;\s*if \(\s*incoming.abortSignal/g
      ) ?? []
    ).length,
    2
  );
});

test("Codex auth probe preserves policy denial instead of unknown status", async () => {
  const f = fixture();
  const { probeCodexAppServerAuth } = f.load<
    typeof import("../../../open-sse/executors/codex/appServerAuthProbe.ts")
  >("open-sse/executors/codex/appServerAuthProbe.ts");
  let connects = 0;
  const policyError = new f.authority.RuntimePolicyError("proxy-forbidden");
  const websocket = async () => {
    connects++;
    throw policyError;
  };
  await assert.rejects(
    probeCodexAppServerAuth(
      { url: "ws://helper.example.invalid:19456", token: "fixture", cwd: "/fixture" },
      websocket,
      50
    ),
    denied(f)
  );
  assert.equal(connects, 0);
  await assert.rejects(
    probeCodexAppServerAuth({ url: CODEX, token: "fixture", cwd: "/fixture" }, websocket, 50),
    (error) => error === policyError
  );
  assert.equal(connects, 1);
});

test("ordinary Codex auth probe retains unknown status for transport errors", async () => {
  const f = fixture(false);
  const { probeCodexAppServerAuth } = f.load<
    typeof import("../../../open-sse/executors/codex/appServerAuthProbe.ts")
  >("open-sse/executors/codex/appServerAuthProbe.ts");
  const result = await probeCodexAppServerAuth(
    { url: "ws://helper.example.invalid:19456", token: "fixture", cwd: "/fixture" },
    async () => {
      throw new Error("synthetic transport failure");
    },
    50
  );
  assert.equal(result.state, "unknown");
});
