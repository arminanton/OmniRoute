import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

type Row = Record<string, unknown>;
const MODELS = "src/app/api/providers/[id]/models/route.ts";
const SYNC = "src/app/api/providers/[id]/sync-models/route.ts";
const EFFECTIVE = "src/sse/services/compatibleNodeBaseUrl.ts";
const PROFILE = "omni-app-residential-direct-v1";
const DIRECTORY = "/run/omni-runtime-policy";
const originalConnection = (provider = "maxai"): Row => ({
  id: "server-connection",
  provider,
  apiKey: "fixture-key",
  providerSpecificData: { tag: "stored-tag", untouched: { deep: true } },
});

// Actual route/helper/policy source, with only synthetic policy files and inert
// external modules in one VM realm. No app, DB, provider, helper or network loads.
function fixture(
  options: {
    locked?: boolean;
    connection?: Row | null;
    node?: Row | null;
    authenticated?: boolean;
    admit?: (candidate: Row) => Promise<Row>;
    noAuthReply?: () => Promise<Response>;
    maxaiError?: unknown;
    syncReply?: () => Response;
    volc?: boolean;
  } = {}
) {
  const locked = options.locked !== false;
  const connection = options.connection === undefined ? originalConnection() : options.connection;
  const counts = {
    db: 0,
    node: 0,
    admission: 0,
    proxy: 0,
    fetch: 0,
    noauth: 0,
    maxai: 0,
    selfFetch: 0,
    fallback: 0,
    refresh: 0,
    persist: 0,
    log: 0,
    volc: 0,
  };
  const events: string[] = [];
  const admitted: Row[] = [];
  const fetchUrls: string[] = [];
  const discoveryData: unknown[] = [];
  const policyBytes = Buffer.from(
    JSON.stringify({ schema: 1, profile: PROFILE, providers: [], helpers: [] })
  );
  const markerBytes = Buffer.from(
    JSON.stringify({
      schema: 1,
      profile: PROFILE,
      policySha256: createHash("sha256").update(policyBytes).digest("hex"),
    })
  );
  const policyFiles = new Map([
    [`${DIRECTORY}/policy.json`, policyBytes],
    [`${DIRECTORY}/required-v1.json`, markerBytes],
  ]);
  const descriptors = new Map<number, string>();
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
      const bytes = policyFiles.get(name);
      return bytes ? metadata(false, bytes.length) : missing();
    },
    openSync(name: string) {
      const fd = 100 + descriptors.size;
      descriptors.set(fd, name);
      return fd;
    },
    fstatSync(fd: number) {
      return metadata(false, policyFiles.get(descriptors.get(fd)!)!.length);
    },
    readFileSync(fd: number) {
      return policyFiles.get(descriptors.get(fd)!);
    },
    closeSync(fd: number) {
      descriptors.delete(fd);
    },
  };
  const context = vm.createContext({
    console: { log() {}, info() {}, warn() {}, error() {} },
    URL,
    Buffer,
    Error,
    TypeError,
    Response,
    Request,
    Headers,
    AbortSignal,
    AbortController,
    setTimeout,
    clearTimeout,
    process: { env: {} },
    fetch: async () => {
      counts.fetch++;
      throw new Error("unexpected raw fetch");
    },
  });
  const modules = new Map<string, Record<string, unknown>>();
  function load<T>(relative: string): T {
    if (modules.has(relative)) return modules.get(relative) as T;
    const filename = new URL(`../../../${relative}`, import.meta.url);
    const source = readFileSync(filename, "utf8");
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
      if (id === "node:fs") return fakeFs;
      if (id === "node:crypto") return { createHash };
      if (id === "node:net") return { isIP };
      if (id === "@/shared/runtimePolicyEntrypoints")
        return load("src/shared/runtimePolicyEntrypoints.ts");
      if (id === "./runtimePolicyProxyConfig")
        return load("src/shared/runtimePolicyProxyConfig.ts");
      if (id === "./runtimePolicy" || id === "@/shared/runtimePolicy")
        return load("scripts/build/runtime-policy.mjs");
      if (id === "./constants/featureFlagDefinitions") return { FEATURE_FLAG_DEFINITIONS: [] };
      if (id === "@/sse/services/compatibleNodeBaseUrl")
        return {
          async assertResolvedProviderConnectionEntrypoint(candidate: Row) {
            counts.admission++;
            admitted.push(candidate);
            events.push("admission-start");
            const result = options.admit
              ? await options.admit(candidate)
              : await load<{
                  assertResolvedProviderConnectionEntrypoint: (candidate: Row) => Promise<Row>;
                }>(EFFECTIVE).assertResolvedProviderConnectionEntrypoint(candidate);
            events.push("admission-end");
            return result;
          },
        };
      if (id === "@/lib/db/providers/nodes")
        return {
          resolveProviderNodeForConnection: async () => {
            counts.node++;
            return options.node ?? null;
          },
        };
      if (id === "@omniroute/open-sse/config/providerRegistry.ts")
        return {
          getRegistryEntry: (provider: string) => ({ id: provider === "mx" ? "maxai" : provider }),
          requireCompatibleBaseUrl: (_provider: string, node: Row) => node.baseUrl,
        };
      if (id === "next/server") return { NextResponse: { json: Response.json } };
      if (id === "@/lib/api/requireManagementAuth")
        return {
          requireManagementAuth: async () =>
            options.authenticated === false ? Response.json({}, { status: 401 }) : null,
        };
      if (id === "@/shared/utils/apiAuth")
        return { isAuthenticated: async () => options.authenticated !== false };
      if (id === "@/lib/db/readCache")
        return {
          getCachedProviderConnectionById: async () => {
            counts.db++;
            events.push("connection");
            return connection;
          },
        };
      if (id === "@/shared/constants/providers")
        return {
          NOAUTH_PROVIDERS: {
            opencode: { id: "opencode", noAuth: true },
            "duckduckgo-web": { id: "duckduckgo-web", noAuth: true },
          },
          isClaudeCodeCompatibleProvider: () => false,
          isAnthropicCompatibleProvider: (provider: string) =>
            provider.startsWith("anthropic-compatible"),
          isOpenAICompatibleProvider: (provider: string) =>
            provider.startsWith("openai-compatible-"),
        };
      if (id === "@/lib/db/proxies")
        return {
          resolveProxyForProvider: async () => {
            counts.proxy++;
            events.push("proxy");
            return null;
          },
        };
      if (id === "@omniroute/open-sse/utils/error")
        return {
          runtimePolicyErrorResponse: policyResponse,
          sanitizeErrorMessage: () => "safe error",
          errorResponse: (status: number, error: string) => Response.json({ error }, { status }),
        };
      if (id === "@/shared/network/safeOutboundFetch")
        return {
          SAFE_OUTBOUND_FETCH_PRESETS: { modelsDiscovery: {}, modelsProbe: {} },
          SafeOutboundFetchError: class extends Error {},
          getSafeOutboundFetchErrorStatus: () => null,
          safeOutboundFetch: async (url: string) => {
            counts.fetch++;
            fetchUrls.push(url);
            events.push("fetch");
            return Response.json({ data: [{ id: "fixture-model" }] });
          },
        };
      if (id === "@/shared/network/outboundUrlGuardPolicy")
        return {
          getProviderOutboundGuard: () => ({}),
          getProviderValidationGuard: () => ({}),
        };
      if (id === "@/lib/providers/modelListingCapability")
        return { providerUsesCuratedModelsOnly: () => false };
      if (id === "@/lib/exclusiveLeaseIsolation")
        return { isConnectionUnavailableToAuxiliaryActivity: async () => false };
      if (id === "./staleEncryptionGuard") return { buildStaleEncryptionKeyResponse: () => null };
      if (id === "@/lib/db/models")
        return {
          getSyncedAvailableModels: async () => [],
          getCustomModels: async () => [],
          getModelIsHidden: () => false,
          getSyncedAvailableModelsForConnection: async () => [],
          replaceSyncedAvailableModelsForConnection: async (
            _provider: string,
            _id: string,
            rows: unknown
          ) => {
            counts.persist++;
            return rows;
          },
        };
      if (id === "@/lib/providerModels/modelDiscovery")
        return {
          getCachedDiscoveredModels: async () => [],
          isAutoFetchModelsEnabled: () => true,
          persistDiscoveredModels: async (_provider: string, _id: string, models: unknown[]) => {
            counts.persist++;
            return models;
          },
        };
      if (id === "@/shared/constants/models") return { getModelsByProviderId: () => [] };
      if (id === "@/lib/providers/staticModels") return { getStaticModelsForProvider: () => [] };
      if (id === "./modelRouteProjection")
        return {
          filterModelsForRoute: (_provider: string, models: unknown) => models,
          buildNoAuthModelsResponse: async (provider: string, connectionId: string) => {
            counts.noauth++;
            events.push("noauth");
            return options.noAuthReply
              ? options.noAuthReply()
              : Response.json({ provider, connectionId, models: [], source: "local_catalog" });
          },
        };
      if (id === "@omniroute/open-sse/services/maxaiModels.ts")
        return {
          MAXAI_REGISTRY_MODELS: [{ id: "curated-fixture" }],
          discoverMaxaiModels: async (args: Row) => {
            counts.maxai++;
            events.push("maxai");
            discoveryData.push(args.providerSpecificData);
            if (options.maxaiError) throw options.maxaiError;
            return { models: [{ id: "fixture-model" }] };
          },
        };
      if (id === "./conolDiscovery") return { maybeHandleConolModelDiscovery: async () => null };
      if (id === "./discovery/providerSets") return { isNamedOpenAIStyleProvider: () => false };
      if (id === "./discovery/helpers")
        return {
          asRecord: (value: unknown) => (value && typeof value === "object" ? value : {}),
          toNonEmptyString: (value: unknown) => (typeof value === "string" && value ? value : null),
          getProviderBaseUrl: (data: Row) => data.baseUrl,
          isLocalOpenAIStyleProvider: () => false,
          mergeLocalCatalogModels: (left: unknown[], right: unknown[]) => [...left, ...right],
          mergeSpecialtyCatalogIntoLiveModels: (models: unknown[]) => models,
          buildOptionalBearerHeaders: () => ({}),
        };
      if (id === "./discoveryClientVersion")
        return {
          getDiscoveryClientVersionOptions: (data: unknown) => {
            discoveryData.push(data);
            return {};
          },
          buildProviderModelsUrl: (url: string) => url,
        };
      if (id === "@/shared/services/modelSyncScheduler")
        return {
          isModelSyncInternalRequest: () => false,
          buildModelSyncInternalHeaders: () => ({}),
          getModelSyncInternalBaseUrl: () => "http://127.0.0.1:3000",
          fetchModelSyncInternal: async (url: string) => {
            counts.selfFetch++;
            events.push("self-fetch");
            return url.includes("__readiness_probe__")
              ? Response.json({}, { status: 404 })
              : options.syncReply
                ? options.syncReply()
                : Response.json({ models: [], source: "api" });
          },
        };
      if (id === "../models/route")
        return {
          GET: async () => {
            counts.fallback++;
            return policyResponse();
          },
        };
      if (id === "@/lib/providers/volcenginePlanModelDiscovery")
        return {
          providerToVolcPlanKind: () => (options.volc ? "fixture-plan" : null),
          fetchVolcPlanModels: async () => {
            counts.volc++;
            return [];
          },
        };
      if (id === "@/lib/usage/callLogs")
        return {
          saveCallLog: async () => {
            counts.log++;
          },
        };
      if (id === "@/shared/utils/freeModels")
        return {
          selectModelsForImport: (_provider: string, models: unknown) => ({
            models,
            freeFilterEmpty: false,
          }),
        };
      if (id === "./degradedLocalCatalog") return { isDegradedDiscovery: () => false };
      if (id === "@/lib/providerModels/managedModelImport")
        return {
          importManagedModels: async () => {
            counts.persist++;
            return {
              previousModels: [],
              previousSyncedAvailableModels: [],
              persistedModels: [],
              importedModels: [],
              discoveredModels: [],
              syncedAvailableModels: [],
              syncedAliases: 0,
              importedChanges: { added: 0, updated: 0, removed: 0 },
            };
          },
        };
      // Unused imports stay inert. There is no real Node/app-module fallback.
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
  function policyResponse() {
    return authority.markRuntimePolicyResponse(
      Response.json(
        {
          error: {
            code: "OMNI_RUNTIME_POLICY_DENIED",
            message: "Runtime policy denied this operation.",
          },
        },
        { status: 403 }
      )
    );
  }
  async function invoke(method: "GET" | "POST", id = "request-id") {
    const request = new Request(
      `http://localhost/api/providers/${id}/${method === "GET" ? "models?refresh=true" : "sync-models"}`,
      { method }
    );
    const module = load<
      Record<
        string,
        (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>
      >
    >(method === "GET" ? MODELS : SYNC);
    return module[method](request, { params: Promise.resolve({ id }) });
  }
  return {
    counts,
    admitted,
    events,
    fetchUrls,
    discoveryData,
    authority,
    policyResponse,
    invoke,
    load,
  };
}

function noDiscovery(f: ReturnType<typeof fixture>) {
  assert.equal(
    f.counts.proxy +
      f.counts.fetch +
      f.counts.noauth +
      f.counts.maxai +
      f.counts.selfFetch +
      f.counts.fallback +
      f.counts.refresh +
      f.counts.persist +
      f.counts.volc,
    0
  );
}

for (const method of ["GET", "POST"] as const) {
  test(`${method} locked admission denies before discovery and side effects`, async () => {
    const connection = originalConnection();
    const f = fixture({ connection });
    const response = await f.invoke(method);
    assert.equal(response.status, 403);
    assert.equal(f.authority.isRuntimePolicyResponse(response), true);
    assert.equal(f.counts.admission, 1);
    assert.equal(f.admitted[0], connection);
    assert.equal(f.admitted[0].id, "server-connection");
    assert.equal(f.admitted[0].providerSpecificData, connection.providerSpecificData);
    noDiscovery(f);
    assert.equal(f.counts.log, 0);
    assert.doesNotMatch(await response.text(), /fixture-key|stored-tag|server-connection/);
  });
}

for (const method of ["GET", "POST"] as const) {
  for (const provider of [
    "uc",
    "uc-direct",
    "maxai",
    "mx",
    "codex",
    "codex-app-server",
    "opencode",
  ]) {
    test(`${method} live symbol ${provider} stays closed with the actual empty inventory`, async () => {
      const f = fixture({ connection: originalConnection(provider) });
      const response = await f.invoke(method);
      assert.equal(response.status, 403);
      assert.equal(f.authority.isRuntimePolicyResponse(response), true);
      noDiscovery(f);
    });
  }

  test(`${method} admission is awaited before any discovery`, async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const admissionEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const f = fixture({
      admit: async () => {
        entered();
        await gate;
        throw new f.authority.RuntimePolicyError("entrypoint-unapproved");
      },
    });
    const pending = f.invoke(method);
    await admissionEntered;
    noDiscovery(f);
    release();
    const response = await pending;
    assert.equal(response.status, 403);
    noDiscovery(f);
  });

  test(`${method} authentication still precedes connection reads and admission`, async () => {
    const f = fixture({ authenticated: false });
    assert.equal((await f.invoke(method)).status, 401);
    assert.equal(f.counts.db + f.counts.admission, 0);
    noDiscovery(f);
  });

  test(`${method} missing unknown connection remains 404 without invented admission`, async () => {
    const f = fixture({ connection: null });
    assert.equal((await f.invoke(method, "unknown-request-provider")).status, 404);
    assert.equal(f.counts.admission, 0);
    noDiscovery(f);
  });

  for (const node of [
    null,
    { id: "openai-compatible-fixture", baseUrl: "https://current.example.invalid/v1" },
  ]) {
    test(`${method} ${node ? "unreviewed" : "missing"} current compatible node fails before copied URL discovery`, async () => {
      const f = fixture({
        connection: {
          ...originalConnection("openai-compatible-fixture"),
          providerSpecificData: { baseUrl: "https://copied.example.invalid/v1" },
        },
        node,
      });
      assert.equal((await f.invoke(method)).status, 403);
      assert.equal(f.counts.node, 1);
      noDiscovery(f);
    });
  }
}

test("connectionless noauth uses only the known canonical provider and no invented id", async () => {
  const f = fixture({ connection: null });
  assert.equal((await f.invoke("GET", "opencode")).status, 403);
  assert.equal(f.counts.admission, 1);
  assert.equal(f.admitted[0].provider, "opencode");
  assert.deepEqual(Object.keys(f.admitted[0]).sort(), ["provider", "providerSpecificData"]);
  assert.deepEqual(Object.keys(f.admitted[0].providerSpecificData as Row), []);
  noDiscovery(f);
});

test("stored noauth connection sends its full merged metadata to admission", async () => {
  const connection = originalConnection("opencode");
  connection.providerSpecificData = {
    ...(connection.providerSpecificData as Row),
    browserCdpEndpoint: "http://helper.example.invalid:19222",
    baseUrl: "https://changed.example.invalid/v1",
  };
  const f = fixture({ connection });
  assert.equal((await f.invoke("GET")).status, 403);
  assert.equal(f.admitted[0], connection);
  assert.equal(f.admitted[0].providerSpecificData, connection.providerSpecificData);
  noDiscovery(f);
});

test("GET uses returned canonical connection and complete hydrated data, not copied routing", async () => {
  const connection = originalConnection("stored-alias");
  const symbol = Symbol.for("fixture.server-binding");
  const hydrated = {
    ...(connection.providerSpecificData as Row),
    baseUrl: "https://current.example.invalid/v1",
    modelsPath: "/fixture-models",
    customHeaders: { "x-fixture": "kept" },
    [symbol]: {
      kind: "node",
      providerId: "openai-compatible-fixture",
      nodeId: "openai-compatible-fixture",
    },
  };
  const effective = {
    ...connection,
    provider: "openai-compatible-fixture",
    providerSpecificData: hydrated,
  };
  // Synthetic admitted projection tests caller data flow only, never production coverage.
  const f = fixture({ connection, admit: async () => effective });
  const response = await f.invoke("GET");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.provider, "openai-compatible-fixture");
  assert.equal(body.connectionId, "server-connection");
  assert.equal(f.admitted[0], connection);
  assert.equal(f.discoveryData[0], hydrated);
  assert.equal((f.discoveryData[0] as typeof hydrated)[symbol], hydrated[symbol]);
  assert.equal(
    (f.discoveryData[0] as Row).untouched,
    (connection.providerSpecificData as Row).untouched
  );
  assert.equal(f.fetchUrls[0], "https://current.example.invalid/v1/models");
  assert.equal(f.counts.admission, 1);
  assert.ok(f.events.indexOf("admission-end") < f.events.indexOf("proxy"));
  assert.ok(f.events.indexOf("admission-end") < f.events.indexOf("fetch"));
});

test("POST uses returned canonical provider and merged model-import settings", async () => {
  const connection = originalConnection();
  const effective = {
    ...connection,
    provider: "fixture-canonical",
    providerSpecificData: {
      ...(connection.providerSpecificData as Row),
      importFreeModelsOnly: true,
    },
  };
  const f = fixture({ connection, admit: async () => effective });
  const response = await f.invoke("POST");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.provider, "fixture-canonical");
  assert.equal(body.importFreeOnly, true);
  assert.equal(f.admitted[0], connection);
  assert.ok(f.events.indexOf("admission-end") < f.events.indexOf("self-fetch"));
});

test("POST denies before the special Volcano discovery path", async () => {
  const f = fixture({ connection: originalConnection("fixture-volcano-plan"), volc: true });
  assert.equal((await f.invoke("POST")).status, 403);
  noDiscovery(f);
});

test("POST retains a locally branded models response without parsing, logging or persistence", async () => {
  let branded!: Response;
  const f = fixture({ admit: async (candidate) => candidate, syncReply: () => branded });
  branded = f.policyResponse();
  const response = await f.invoke("POST");
  assert.equal(response, branded);
  assert.equal(f.authority.isRuntimePolicyResponse(response), true);
  assert.equal(response.bodyUsed, false);
  assert.equal(f.counts.log + f.counts.persist, 0);
  // This is local object provenance, not a claim that a brand survives HTTP.
});

for (const connection of [null, originalConnection("opencode")]) {
  test(`standalone noauth retains ${connection ? "stored connection" : "connectionless"} discovery`, async () => {
    const f = fixture({ locked: false, connection });
    const response = await f.invoke("GET", connection ? "request-id" : "opencode");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.provider, "opencode");
    assert.equal(body.connectionId, connection ? "server-connection" : "opencode");
    assert.equal(f.counts.noauth, 1);
    assert.equal(f.counts.node + f.counts.proxy, 0);
    if (connection) assert.equal(f.admitted[0], connection);
  });
}

for (const provider of ["maxai", "mx"]) {
  test(`standalone ${provider} discovery still bypasses unrelated proxy selection`, async () => {
    const connection = originalConnection(provider);
    const f = fixture({ locked: false, connection });
    const helper = f.load<{
      assertResolvedProviderConnectionEntrypoint: (candidate: Row) => Promise<Row>;
    }>(EFFECTIVE);
    assert.equal(await helper.assertResolvedProviderConnectionEntrypoint(connection), connection);
    const response = await f.invoke("GET");
    assert.equal(response.status, 200);
    assert.equal((await response.json()).provider, provider);
    assert.equal(f.discoveryData[0], connection.providerSpecificData);
    assert.equal(f.counts.maxai, 1);
    assert.equal(f.counts.proxy + f.counts.node, 0);
  });
}

test("standalone ordinary MaxAI failure keeps the curated fallback", async () => {
  const f = fixture({ locked: false, maxaiError: new Error("synthetic transport failed") });
  const response = await f.invoke("GET");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.source, "local_catalog");
  assert.equal(body.models[0].id, "curated-fixture");
});

test("existing MaxAI branded discovery error remains terminal rather than curated success", async () => {
  const options: Parameters<typeof fixture>[0] = { admit: async (candidate) => candidate };
  const f = fixture(options);
  options.maxaiError = new f.authority.RuntimePolicyError("proxy-forbidden");
  const response = await f.invoke("GET");
  assert.equal(response.status, 403);
  assert.equal(f.authority.isRuntimePolicyResponse(response), true);
  assert.equal(f.counts.maxai, 1);
  assert.equal(f.counts.persist, 0);
});

test("standalone model sync still completes through its synthetic self-fetch", async () => {
  const f = fixture({ locked: false });
  const response = await f.invoke("POST");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  assert.equal(f.counts.admission, 1);
  assert.equal(f.counts.selfFetch, 2);
  assert.equal(f.counts.persist, 1);
});
