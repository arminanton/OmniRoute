import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// Load source with isolated, synthetic dependencies. No app bootstrap, DB, helper or network.
function loadSource(
  path: string,
  imports: Record<string, unknown>,
  globals: Record<string, unknown> = {}
) {
  const filename = new URL(`../../../${path}`, import.meta.url);
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const module = { exports: {} as Record<string, unknown> };
  vm.runInNewContext(
    compiled,
    {
      module,
      exports: module.exports,
      URL,
      Symbol,
      Object,
      Error,
      Array,
      Set,
      Map,
      WeakMap,
      console,
      Date,
      JSON,
      String,
      Number,
      Boolean,
      Response,
      Request,
      ...globals,
      require: (id: string) => {
        if (Object.hasOwn(imports, id)) return imports[id];
        throw new Error(`Unexpected fixture import: ${id}`);
      },
    },
    { filename: filename.pathname }
  );
  return module.exports;
}

class Denied extends Error {
  readonly code = "OMNI_RUNTIME_POLICY_DENIED";
  constructor(readonly reason: string) {
    super("Runtime policy denied");
  }
}
const policy = {
  schema: 1,
  profile: "omni-app-residential-direct-v1",
  providers: [] as unknown[],
  helpers: [] as unknown[],
};
let locked = true;
const selections: unknown[] = [];
const helperSelections: unknown[] = [];
const facade = {
  RuntimePolicyError: Denied,
  isRuntimePolicyError: (error: unknown) => error instanceof Denied,
  getRuntimePolicy: () => (locked ? { mode: "locked", policy } : { mode: "standalone" }),
  assertProviderEntrypoint: (selection: unknown) => {
    if (locked) selections.push(selection);
  },
  assertLocalHelper: (selection: unknown) => {
    if (locked) helperSelections.push(selection);
  },
  assertNotLockedCapability: () => {
    if (locked) throw new Denied("capability-disabled");
  },
};
const proxyCalls: unknown[] = [];
const projections = loadSource("src/shared/runtimePolicyEntrypoints.ts", {
  "./runtimePolicy": facade,
  "./runtimePolicyProxyConfig": {
    assertRuntimePolicyConnectionProxyConfig: (value: unknown) => proxyCalls.push(value),
  },
}) as {
  REVIEWED_RUNTIME_PROVIDER_ADAPTERS: readonly unknown[];
  projectProviderEntrypoint: (
    candidate: Record<string, unknown>,
    inventory: readonly unknown[]
  ) => unknown;
  assertRuntimeEntrypointInventory: () => void;
  assertRuntimeProviderSupported: (provider: string) => void;
  assertRuntimeExecutorEntrypoint: (
    provider: string,
    credentials?: Record<string, unknown> | null,
    adapter?: string
  ) => void;
  validateProviderConnectionCandidate: (candidate: Record<string, unknown>) => void;
  validateProviderNodeCandidate: (candidate: Record<string, unknown>) => void;
  validateRuntimeHelperSettings: (candidate: Record<string, unknown>) => void;
  validateRuntimeHelperEnvironment: (candidate: Record<string, unknown>) => void;
};
const inventory = Object.freeze([
  { providerId: "fixture-builtin", builtin: true, adapters: [], nonRoutingFields: ["accountTag"] },
  {
    providerId: "fixture-custom",
    builtin: true,
    adapters: ["executor-base-url-v1", "compatible-node-base-url-v1", "search-base-url-v1"],
    connectionAdapter: "executor-base-url-v1",
    nonRoutingFields: ["accountTag"],
  },
]);
const connection = {
  kind: "connection",
  providerId: "fixture-custom",
  connectionId: "fixture-connection",
};
const node = { kind: "node", providerId: "fixture-custom", nodeId: "fixture-node" };
function plain(value: unknown) {
  return JSON.parse(JSON.stringify(value));
}
function denied(fn: () => unknown) {
  assert.throws(fn, (error: unknown) => error instanceof Denied);
}

test.beforeEach(() => {
  locked = true;
  policy.providers = [];
  selections.length = 0;
  proxyCalls.length = 0;
});

test("synthetic builtin requires code coverage and no routing override", () => {
  assert.deepEqual(
    plain(
      projections.projectProviderEntrypoint(
        { providerId: "fixture-builtin", providerSpecificData: { accountTag: "fixture" } },
        inventory
      )
    ),
    { kind: "builtin", providerId: "fixture-builtin" }
  );
  for (const key of ["baseUrl", "gheUrl", "copilotProxyUrl", "newRoutingOverride"]) {
    denied(() =>
      projections.projectProviderEntrypoint(
        {
          providerId: "fixture-builtin",
          providerSpecificData: { [key]: "https://override.example.invalid" },
        },
        inventory
      )
    );
  }
  denied(() => projections.projectProviderEntrypoint({ providerId: "unreviewed" }, inventory));
});

test("synthetic configured endpoint uses exact server binding and known adapter", () => {
  for (const [binding, adapter] of [
    [connection, "executor-base-url-v1"],
    [node, "compatible-node-base-url-v1"],
    [connection, "search-base-url-v1"],
  ] as const) {
    assert.deepEqual(
      plain(
        projections.projectProviderEntrypoint(
          {
            providerId: "fixture-custom",
            binding,
            adapter,
            providerSpecificData: { baseUrl: "https://provider.example.invalid/v1/" },
          },
          inventory
        )
      ),
      { kind: "configured", binding, adapter, endpoint: "https://provider.example.invalid/v1/" }
    );
  }
  for (const binding of [
    undefined,
    { ...connection, providerId: "other" },
    { ...connection, connectionId: "" },
  ]) {
    denied(() =>
      projections.projectProviderEntrypoint(
        {
          providerId: "fixture-custom",
          binding,
          providerSpecificData: { baseUrl: "https://provider.example.invalid/v1" },
        },
        inventory
      )
    );
  }
  denied(() =>
    projections.projectProviderEntrypoint(
      {
        providerId: "fixture-custom",
        binding: node,
        adapter: "executor-base-url-v1",
        providerSpecificData: { baseUrl: "https://provider.example.invalid/v1" },
      },
      inventory
    )
  );
});

test("configuration URL credentials, query, fragment and invalid types cannot become builtin", () => {
  for (const baseUrl of [
    "https://user:secret@provider.example.invalid/v1",
    "https://@provider.example.invalid/v1",
    "https:provider.example.invalid/v1",
    "https://provider.example.invalid/v1?q=x",
    "https://provider.example.invalid/v1#x",
    "ftp://provider.example.invalid/v1",
    "https://provider.\nexample.invalid/v1",
    {},
    3,
    "   ",
  ]) {
    denied(() =>
      projections.projectProviderEntrypoint(
        { providerId: "fixture-custom", binding: connection, providerSpecificData: { baseUrl } },
        inventory
      )
    );
  }
});

test("production coverage inventory is frozen and empty, never inferred from fixtures", () => {
  assert.equal(projections.REVIEWED_RUNTIME_PROVIDER_ADAPTERS.length, 0);
  assert.ok(Object.isFrozen(projections.REVIEWED_RUNTIME_PROVIDER_ADAPTERS));
  projections.assertRuntimeEntrypointInventory();
  policy.providers = [{ kind: "builtin", providerId: "fixture-builtin" }];
  denied(() => projections.assertRuntimeEntrypointInventory());
  denied(() => projections.assertRuntimeProviderSupported("fixture-builtin"));
  denied(() =>
    projections.assertRuntimeExecutorEntrypoint("fixture-builtin", { providerSpecificData: {} })
  );
});

test("merged provider/node candidate admission precedes any operation and uses proxy candidate rule", () => {
  const candidate = {
    id: "fixture-id",
    provider: "fixture-custom",
    proxyEnabled: false,
    providerSpecificData: { baseUrl: "https://provider.example.invalid/v1" },
  };
  denied(() => projections.validateProviderConnectionCandidate(candidate));
  assert.equal(proxyCalls[0], candidate);
  denied(() =>
    projections.validateProviderNodeCandidate({
      id: "fixture-node",
      type: "openai-compatible",
      baseUrl: "https://provider.example.invalid/v1",
    })
  );
});

test("standalone runtime guards remain no-ops for old provider and node configuration", () => {
  locked = false;
  projections.assertRuntimeEntrypointInventory();
  projections.assertRuntimeProviderSupported("unknown-standalone");
  projections.assertRuntimeExecutorEntrypoint("unknown-standalone", {
    providerSpecificData: { gheUrl: "http://localhost" },
  });
  projections.validateProviderConnectionCandidate({});
  projections.validateProviderNodeCandidate({});
  assert.equal(proxyCalls.length, 0);
  assert.equal(selections.length, 0);
});

test("node writes validate the effective merged candidate before SQL writes and backups", async () => {
  let writes = 0;
  let backups = 0;
  let candidate: Record<string, unknown> | undefined;
  const existing = {
    id: "fixture-node",
    type: "openai-compatible",
    baseUrl: "https://original.example.invalid/v1",
    name: "fixture",
  };
  const nodes = loadSource("src/lib/db/providers/nodes.ts", {
    uuid: { v4: () => "generated-fixture-node" },
    "../core": {
      getDbInstance: () => ({
        prepare: () => ({
          get: () => existing,
          run: () => {
            writes++;
          },
        }),
      }),
      rowToCamel: (value: unknown) => value,
    },
    "../providerNodeSelect": {},
    "../backup": {
      backupDbFile: () => {
        backups++;
      },
    },
    "../readCache": { invalidateDbCache: () => {} },
    "./columns": { toRecord: (value: unknown) => value },
    "@/shared/runtimePolicyEntrypoints": {
      validateProviderNodeCandidate: (value: Record<string, unknown>) => {
        candidate = value;
        throw new Denied("entrypoint-unapproved");
      },
    },
  }) as {
    createProviderNode: (data: Record<string, unknown>) => Promise<unknown>;
    updateProviderNode: (id: string, data: Record<string, unknown>) => Promise<unknown>;
  };
  await assert.rejects(
    nodes.createProviderNode({
      type: "openai-compatible",
      baseUrl: "https://new.example.invalid/v1",
    }),
    Denied
  );
  assert.equal(candidate?.id, "generated-fixture-node");
  await assert.rejects(
    nodes.updateProviderNode("fixture-node", { name: "edited", id: "request-forged" }),
    Denied
  );
  assert.equal(
    candidate?.id,
    "fixture-node",
    "the SQL target ID, not request data, is the binding"
  );
  assert.equal(
    candidate?.baseUrl,
    existing.baseUrl,
    "omitted routing fields stay part of admission"
  );
  assert.equal(writes, 0);
  assert.equal(backups, 0);
});

test("search projection runs before URL handling; caller overrides cannot select a configured binding", () => {
  let calls = 0;
  const search = loadSource("open-sse/handlers/search/baseUrl.ts", {
    "@/shared/network/outboundUrlGuard": {
      parseAndValidateNonMetadataUrl: () => {
        calls++;
      },
    },
    "@/shared/runtimePolicyEntrypoints": {
      assertRuntimeExecutorEntrypoint: () => {
        throw new Denied("entrypoint-unapproved");
      },
    },
    "@/shared/runtimePolicy": facade,
  }) as {
    resolveSearchBaseUrl: (
      config: Record<string, unknown>,
      params: Record<string, unknown>
    ) => string;
  };
  const config = {
    id: "fixture-search",
    authType: "none",
    allowClientBaseUrlOverride: true,
    baseUrl: "https://builtin.example.invalid/search",
  };
  denied(() =>
    search.resolveSearchBaseUrl(config, {
      providerSpecificData: { baseUrl: "https://other.example.invalid/search" },
    })
  );
  denied(() =>
    search.resolveSearchBaseUrl(config, {
      providerOptions: { baseUrl: "https://other.example.invalid/search" },
    })
  );
  assert.equal(calls, 0);
});

test("BaseExecutor denies before refresh/send and does not retry branded count-token errors", async () => {
  const path = "open-sse/executors/base.ts";
  const source = ts.createSourceFile(
    path,
    readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
  const imports: Record<string, unknown> = {};
  for (const statement of source.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    )
      imports[statement.moduleSpecifier.text] = {};
  }
  let admitted = false;
  let sends = 0;
  let refreshes = 0;
  imports["@/shared/runtimePolicyEntrypoints"] = {
    assertRuntimeProviderSupported: () => {},
    assertRuntimeExecutorEntrypoint: () => {
      if (!admitted) throw new Denied("entrypoint-unapproved");
    },
  };
  imports["@/shared/runtimePolicy"] = facade;
  const exports = loadSource(path, imports, {
    fetch: () => {
      sends++;
      throw new Denied("proxy-forbidden");
    },
  }) as {
    BaseExecutor: new (
      id: string,
      config: Record<string, unknown>
    ) => {
      execute: (input: Record<string, unknown>) => Promise<unknown>;
      countTokens: (input: Record<string, unknown>) => Promise<unknown>;
      refreshCredentials: () => Promise<unknown>;
      buildCountTokensUrl: () => string;
      assertOutboundUrlAllowed: () => void;
      buildHeaders: () => Record<string, string>;
      getCountTokensTimeoutMs: () => number;
    };
  };
  const executor = new exports.BaseExecutor("fixture-builtin", {
    baseUrls: ["https://a.example.invalid", "https://b.example.invalid"],
  });
  executor.refreshCredentials = async () => {
    refreshes++;
  };
  await assert.rejects(
    executor.execute({
      model: "fixture",
      credentials: { refreshToken: "fixture" },
      body: {},
      stream: false,
    }),
    Denied
  );
  assert.equal(refreshes, 0);
  // Count-token catches must not turn a transport policy denial into null.
  admitted = true;
  executor.buildCountTokensUrl = () => "https://count.example.invalid";
  executor.assertOutboundUrlAllowed = () => {};
  executor.buildHeaders = () => ({});
  executor.getCountTokensTimeoutMs = () => 0;
  await assert.rejects(
    executor.countTokens({ model: "fixture", credentials: {}, body: {} }),
    Denied
  );
  assert.equal(sends, 1);
});

test("executor selection denies unsupported providers before any lazy import or fallback", async () => {
  let loads = 0;
  const executors = loadSource("open-sse/executors/index.ts", {
    "@/shared/runtimePolicyEntrypoints": {
      assertRuntimeProviderSupported: () => {
        throw new Denied("entrypoint-unapproved");
      },
    },
    "../config/searchRegistry.ts": { SEARCH_PROVIDERS: {} },
    "../config/providerRegistry.ts": { getRegistryEntry: () => undefined },
    "@/shared/constants/designerWebRetirement": {
      assertMicrosoftDesignerWebProviderAvailable: () => {},
    },
    "@/shared/constants/providerRetirement": { assertRuntimeProviderAvailable: () => {} },
    "@/shared/constants/chatgptWebRetirement": {
      assertCommonChatGptWebProviderAvailable: () => {},
    },
    "./registry.ts": {
      registerLazyExecutor: () => {},
      loadRegisteredExecutor: () => {
        loads++;
      },
      hasRegisteredExecutor: () => false,
    },
    "./defaultResolver.ts": {
      getDefaultExecutor: () => {
        loads++;
      },
    },
    "./base.ts": {},
    "./default.ts": {},
  }) as { getExecutor: (provider: string) => Promise<unknown> };
  await assert.rejects(executors.getExecutor("fixture-unreviewed"), Denied);
  assert.equal(loads, 0);
});

test("compatible hydration preserves policy error identity instead of stale-URL fallback", async () => {
  const denial = new Denied("entrypoint-unapproved");
  const hydrate = loadSource("src/sse/services/compatibleNodeBaseUrl.ts", {
    "@/shared/runtimePolicyEntrypoints": {
      validateProviderNodeCandidate: () => {
        throw denial;
      },
      bindRuntimeProviderData: (value: unknown) => value,
    },
    "@/shared/runtimePolicy": facade,
    "@/lib/db/providers/nodes": {
      resolveProviderNodeForConnection: async () => ({
        id: "fixture-node",
        baseUrl: "https://node.example.invalid/v1",
      }),
    },
    "@omniroute/open-sse/config/providerRegistry.ts": {
      requireCompatibleBaseUrl: () => {
        throw new Error("must not normalize after denial");
      },
    },
  }) as {
    hydrateCompatibleNodeBaseUrl: (
      provider: string,
      data: Record<string, unknown>
    ) => Promise<unknown>;
  };
  await assert.rejects(
    hydrate.hydrateCompatibleNodeBaseUrl("openai-compatible-fixture", {
      baseUrl: "https://stale.example.invalid/v1",
    }),
    (error) => error === denial
  );
});

test("connection create/dedupe/update validate effective routing fields before write-side effects", async () => {
  const path = "src/lib/db/providers.ts";
  const source = ts.createSourceFile(
    path,
    readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
  const imports: Record<string, unknown> = {};
  for (const statement of source.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    )
      imports[statement.moduleSpecifier.text] = {};
  }
  let writes = 0;
  let sideEffects = 0;
  let candidate: Record<string, unknown> | undefined;
  let dedupe = false;
  const existing = {
    id: "fixture-stored",
    provider: "fixture-custom",
    authType: "apikey",
    proxyEnabled: false,
    providerSpecificData: { baseUrl: "https://stored.example.invalid/v1" },
  };
  const db = {
    prepare: (sql: string) => ({
      get: () =>
        sql.startsWith("SELECT 1")
          ? undefined
          : sql.includes("WHERE id = ?") || dedupe
            ? existing
            : undefined,
      all: () => [],
      run: () => {
        writes++;
      },
    }),
    transaction: () => {
      sideEffects++;
      throw new Error("write transaction reached");
    },
  };
  imports.uuid = { v4: () => "fixture-created" };
  imports["./core"] = {
    getDbInstance: () => db,
    rowToCamel: (value: unknown) => value,
    cleanNulls: (value: unknown) => value,
  };
  imports["./providers/columns"] = {
    toRecord: (value: unknown) => value ?? {},
    toStringOrNull: (value: unknown) => (typeof value === "string" ? value : null),
    normalizeBooleanColumn: (value: unknown, fallback: boolean) =>
      value === undefined ? fallback : value,
    toNumberOrZero: (value: unknown) => Number(value) || 0,
  };
  const proxyCandidates: Record<string, unknown>[] = [];
  imports["@/shared/runtimePolicy"] = facade;
  imports["./settings"] = {
    getRuntimePolicySettingsCandidate: async () => ({
      proxyEnabled: true,
      perKeyProxyEnabled: true,
      proxyApiKeyAssignments: [{ id: "fixture-key", proxy_id: "fixture-proxy" }],
      proxyPerKeyConnectionEnabled: false,
    }),
  };
  imports["@/shared/runtimePolicyProxyConfig"] = {
    assertRuntimePolicyProxyConfig: (value: Record<string, unknown>) => {
      proxyCandidates.push(value);
      if (value.proxyPerKeyConnectionEnabled === true) throw new Denied("proxy-forbidden");
    },
  };
  imports["./encryption"] = {
    encryptConnectionFields: () => {
      sideEffects++;
    },
    decryptConnectionFields: (value: unknown) => value,
  };
  imports["@/sse/services/compatibleNodeBaseUrl"] = {
    assertResolvedProviderConnectionEntrypoint: async (value: Record<string, unknown>) => {
      candidate = value;
      throw new Denied("entrypoint-unapproved");
    },
  };
  imports["@/lib/providers/requestDefaults"] = {
    normalizeProviderSpecificData: (_provider: unknown, value: unknown) => value ?? {},
  };
  imports["@/shared/constants/providers"] = { WEB_COOKIE_PROVIDERS: {} };
  const providers = loadSource(path, imports) as {
    createProviderConnection: (data: Record<string, unknown>) => Promise<unknown>;
    updateProviderConnection: (id: string, data: Record<string, unknown>) => Promise<unknown>;
  };
  await assert.rejects(
    providers.createProviderConnection({
      provider: "fixture-custom",
      name: "fixture",
      authType: "apikey",
      providerSpecificData: { baseUrl: "https://new.example.invalid/v1" },
    }),
    Denied
  );
  assert.equal(candidate?.id, "fixture-created");
  await assert.rejects(
    providers.updateProviderConnection("fixture-stored", {
      name: "edited",
      id: "forged-request-id",
    }),
    Denied
  );
  assert.equal(candidate?.id, "fixture-stored");
  assert.equal(
    (candidate?.providerSpecificData as Record<string, unknown>)?.baseUrl,
    "https://stored.example.invalid/v1"
  );
  candidate = undefined;
  await assert.rejects(
    providers.updateProviderConnection("fixture-stored", {
      proxyEnabled: true,
      perKeyProxyEnabled: true,
      proxyApiKeyAssignments: [],
    }),
    (error: unknown) => error instanceof Denied && error.reason === "proxy-forbidden"
  );
  assert.equal(
    candidate,
    undefined,
    "trusted proxy preflight denies before entrypoint/write admission"
  );
  assert.equal(proxyCandidates.at(-1)?.proxyPerKeyConnectionEnabled, true);
  assert.equal(
    (proxyCandidates.at(-1)?.proxyApiKeyAssignments as unknown[]).length,
    1,
    "request fields cannot erase authoritative key bindings"
  );
  await assert.rejects(
    providers.updateProviderConnection("fixture-stored", {
      proxyEnabled: false,
      perKeyProxyEnabled: true,
    }),
    (error: unknown) => error instanceof Denied && error.reason === "entrypoint-unapproved"
  );
  assert.equal(
    proxyCandidates.at(-1)?.proxyPerKeyConnectionEnabled,
    false,
    "disabling the target excludes its old eligible state"
  );
  dedupe = true;
  await assert.rejects(
    providers.createProviderConnection({
      provider: "fixture-custom",
      name: "fixture",
      authType: "apikey",
      apiKey: undefined,
    }),
    Denied
  );
  assert.equal(candidate?.id, "fixture-stored");
  assert.equal(writes, 0);
  assert.equal(
    sideEffects,
    0,
    "no encryption, history reconciliation or transaction after denied admission"
  );
});

test("unsaved node validation refuses caller identity before network and returns a branded safe response", async () => {
  let probes = 0;
  let admittedCandidate: Record<string, unknown> | undefined;
  const marked = new WeakSet<Response>();
  const route = loadSource("src/app/api/provider-nodes/validate/route.ts", {
    "next/server": { NextResponse: Response },
    "@/shared/runtimePolicyEntrypoints": {
      validateProviderNodeCandidate: (value: Record<string, unknown>) => {
        admittedCandidate = value;
        throw new Denied("entrypoint-unapproved");
      },
    },
    "@/shared/runtimePolicy": {
      ...facade,
      markRuntimePolicyResponse: (response: Response) => {
        marked.add(response);
        return response;
      },
    },
    "@omniroute/open-sse/utils/error.ts": {
      buildErrorBody: (_status: number, message: string) => ({ error: { message } }),
    },
    "@/lib/api/requireManagementAuth": { requireManagementAuth: async () => null },
    "@/lib/compliance/index": {
      getAuditRequestContext: () => ({}),
      logAuditEvent: () => {
        throw new Error("denial must not emit raw audit endpoint");
      },
    },
    "@/lib/providers/validation": {
      validateClaudeCodeCompatibleProvider: () => {
        probes++;
      },
    },
    "@/shared/network/safeOutboundFetch": {
      safeOutboundFetch: () => {
        probes++;
      },
      getSafeOutboundFetchErrorStatus: () => undefined,
    },
    "@/shared/network/outboundUrlGuardPolicy": {},
    "@/shared/utils/featureFlags": {},
    "@/shared/validation/schemas": { providerNodeValidateSchema: {} },
    "@/shared/validation/helpers": {
      validateBody: (_schema: unknown, value: unknown) => ({ data: value }),
      isValidationFailure: () => false,
    },
  }) as { POST: (request: Request) => Promise<Response> };
  const response = await route.POST(
    new Request("http://127.0.0.1/api/provider-nodes/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "borrowed-policy-id",
        type: "openai-compatible",
        baseUrl: "https://private.example.invalid/v1",
        apiKey: "fixture-secret",
      }),
    })
  );
  assert.equal(response.status, 403);
  assert.ok(marked.has(response));
  assert.equal(admittedCandidate?.id, undefined);
  assert.equal(probes, 0);
  const body = await response.text();
  assert.equal(body.includes("private.example"), false);
  assert.equal(body.includes("fixture-secret"), false);
});

test("pure settings/environment projections pass raw helper candidates, never null or local fallback", () => {
  helperSelections.length = 0;
  projections.validateRuntimeHelperSettings({
    browserCdpEndpoint: "https://remote.example.invalid/cdp",
    codexAppServerUrl: "ws://127.0.0.1:14555",
  });
  projections.validateRuntimeHelperEnvironment({
    OBSCURA_CDP_ENDPOINT: "http://127.0.0.1:19222",
    CHATGPT_WEB_CODEX_CDP_URL: "https://remote.example.invalid/other",
    OMNIROUTE_CODEX_APPSERVER_WS: "wss://remote.example.invalid",
  });
  assert.deepEqual(plain(helperSelections), [
    { role: "browser-cdp", endpoint: "https://remote.example.invalid/cdp", phase: "configured" },
    { role: "codex-app-server", endpoint: "ws://127.0.0.1:14555", phase: "configured" },
    { role: "browser-cdp", endpoint: "http://127.0.0.1:19222", phase: "configured" },
    { role: "browser-cdp", endpoint: "https://remote.example.invalid/other", phase: "configured" },
    { role: "codex-app-server", endpoint: "wss://remote.example.invalid", phase: "configured" },
  ]);
  for (const candidate of [
    { chromeExecutablePath: "/fixture/chrome" },
    { browserHost: "launcher" },
    { browserHostDescriptorPath: "/fixture/launcher.json" },
  ])
    denied(() => projections.validateRuntimeHelperSettings(candidate));
});

test("connection adapter selection comes only from reviewed code inventory", () => {
  const searchInventory = [
    {
      providerId: "fixture-search",
      builtin: false,
      adapters: ["search-base-url-v1"],
      connectionAdapter: "search-base-url-v1",
      nonRoutingFields: [],
    },
  ];
  const candidate = {
    providerId: "fixture-search",
    binding: {
      kind: "connection",
      providerId: "fixture-search",
      connectionId: "fixture-search-account",
    },
    providerSpecificData: { baseUrl: "https://search.example.invalid/" },
  };
  assert.deepEqual(plain(projections.projectProviderEntrypoint(candidate, searchInventory)), {
    kind: "configured",
    binding: candidate.binding,
    adapter: "search-base-url-v1",
    endpoint: "https://search.example.invalid/",
  });
  denied(() =>
    projections.projectProviderEntrypoint(candidate, [
      { ...searchInventory[0], connectionAdapter: undefined },
    ])
  );
});

test("shared connection admission returns the current node selection, never approve-A/send-copied-B", async () => {
  const key = Symbol("fixture-server-binding");
  let nodeReads = 0;
  let admitted: Record<string, unknown> | undefined;
  const node = {
    id: "openai-compatible-fixture-current",
    baseUrl: "https://node.example.invalid/v1/",
    apiType: "chat",
    chatPath: "/chat/completions",
    customHeaders: { "X-Fixture": "node" },
  };
  const resolver = loadSource("src/sse/services/compatibleNodeBaseUrl.ts", {
    "@/shared/runtimePolicy": facade,
    "@/shared/runtimePolicyEntrypoints": {
      bindRuntimeProviderData: (data: Record<string, unknown>, binding: unknown) => ({
        ...data,
        [key]: binding,
      }),
      validateProviderNodeCandidate: (candidate: unknown) => assert.equal(candidate, node),
      validateProviderConnectionCandidate: (candidate: Record<string, unknown>) => {
        admitted = candidate;
        const data = candidate.providerSpecificData as Record<string | symbol, unknown>;
        const binding = data[key] as Record<string, unknown>;
        assert.equal(binding.kind, "node");
        assert.equal(binding.nodeId, node.id);
        assert.equal(data.baseUrl, node.baseUrl);
        return {
          kind: "configured",
          binding,
          adapter: "compatible-node-base-url-v1",
          endpoint: node.baseUrl,
        };
      },
    },
    "@/lib/db/providers/nodes": {
      resolveProviderNodeForConnection: async () => {
        nodeReads++;
        return node;
      },
    },
    "@omniroute/open-sse/config/providerRegistry.ts": {
      getRegistryEntry: () => undefined,
      requireCompatibleBaseUrl: (_provider: string, candidate: typeof node) => candidate.baseUrl,
    },
  }) as {
    assertResolvedProviderConnectionEntrypoint: <T extends Record<string, unknown>>(
      candidate: T
    ) => Promise<T>;
  };
  const original = {
    id: "fixture-db-connection",
    provider: "openai-compatible-fixture-current",
    providerSpecificData: {
      baseUrl: "https://copied.example.invalid/v1",
      accountTag: "keep",
      chatPath: "/stale",
    },
  };
  const effective = await resolver.assertResolvedProviderConnectionEntrypoint(original);
  assert.equal(nodeReads, 1);
  assert.equal(effective.provider, node.id);
  assert.equal(effective.providerSpecificData.baseUrl, node.baseUrl);
  assert.equal(effective.providerSpecificData.chatPath, node.chatPath);
  assert.equal(effective.providerSpecificData.accountTag, "keep");
  assert.equal(original.providerSpecificData.baseUrl, "https://copied.example.invalid/v1");
  assert.equal(admitted?.id, original.id);
  assert.notEqual(effective, original);
  locked = false;
  assert.equal(await resolver.assertResolvedProviderConnectionEntrypoint(original), original);
  assert.equal(nodeReads, 1, "ordinary helper returns before DB or projection work");
});

test("shared non-node admission binds canonical registry identity and actual DB connection id", async () => {
  const bindings: unknown[] = [];
  let candidate: Record<string, unknown> | undefined;
  const resolver = loadSource("src/sse/services/compatibleNodeBaseUrl.ts", {
    "@/shared/runtimePolicy": facade,
    "@/shared/runtimePolicyEntrypoints": {
      bindRuntimeProviderData: (data: unknown, binding: unknown) => {
        bindings.push(binding);
        return data;
      },
      validateProviderConnectionCandidate: (value: Record<string, unknown>) => {
        candidate = value;
        return { kind: "builtin", providerId: "fixture-canonical" };
      },
    },
    "@/lib/db/providers/nodes": {
      resolveProviderNodeForConnection: () => {
        throw new Error("non-node must not query nodes");
      },
    },
    "@omniroute/open-sse/config/providerRegistry.ts": {
      getRegistryEntry: () => ({ id: "fixture-canonical" }),
    },
  }) as {
    assertResolvedProviderConnectionEntrypoint: (
      candidate: Record<string, unknown>
    ) => Promise<Record<string, unknown>>;
  };
  const result = await resolver.assertResolvedProviderConnectionEntrypoint({
    id: "fixture-stored-id",
    provider: "fixture-alias",
    providerSpecificData: {},
  });
  assert.deepEqual(plain(bindings), [
    { kind: "connection", providerId: "fixture-canonical", connectionId: "fixture-stored-id" },
  ]);
  assert.equal(candidate?.provider, "fixture-canonical");
  assert.equal(result.provider, "fixture-canonical");
});

test("locked node lookup failures are terminal policy errors, not builtin or stale endpoint fallback", async () => {
  const resolver = loadSource("src/sse/services/compatibleNodeBaseUrl.ts", {
    "@/shared/runtimePolicy": facade,
    "@/shared/runtimePolicyEntrypoints": {},
    "@/lib/db/providers/nodes": {
      resolveProviderNodeForConnection: async () => {
        throw new Error("fixture-private-database-error");
      },
    },
    "@omniroute/open-sse/config/providerRegistry.ts": {},
  }) as {
    hydrateCompatibleNodeBaseUrl: (
      provider: string,
      data: Record<string, unknown>
    ) => Promise<Record<string, unknown>>;
  };
  await assert.rejects(
    resolver.hydrateCompatibleNodeBaseUrl("openai-compatible-fixture", {
      baseUrl: "https://copied.example.invalid",
    }),
    (error: unknown) => error instanceof Denied && !error.message.includes("private")
  );
  locked = false;
  const result = await resolver.hydrateCompatibleNodeBaseUrl("openai-compatible-fixture", {
    baseUrl: "https://copied.example.invalid",
  });
  assert.equal(result.baseUrl, undefined);
});


const PROBE_ROUTE = "src/app/api/providers/[id]/test/route.ts";
type ProbeRow = Record<string, unknown>;
function providerProbeFixture(
  options: {
    connection?: ProbeRow | null;
    admit?: (candidate: ProbeRow) => Promise<ProbeRow>;
    denyAt?: "proxy" | "runtime" | "refresh" | "probe" | "body";
    fetchReplies?: Array<Response | Error>;
    oauthConfig?: Record<string, unknown>;
    rotating?: boolean;
  } = {}
) {
  const connection =
    options.connection === undefined
      ? {
          id: "stored-probe-id",
          provider: "fixture-live",
          authType: "apikey",
          apiKey: "fixture-secret",
          isActive: false,
          providerSpecificData: { accountTag: "keep", nested: { keep: true } },
        }
      : options.connection;
  const counts = {
    admission: 0,
    lease: 0,
    proxy: 0,
    runtime: 0,
    appserver: 0,
    refresh: 0,
    probe: 0,
    healthWrite: 0,
    cloud: 0,
    log: 0,
  };
  const admissions: ProbeRow[] = [];
  const validations: ProbeRow[] = [];
  const writes: ProbeRow[] = [];
  const urls: string[] = [];
  const marked = new WeakSet<Response>();
  const denial = new Denied("entrypoint-unapproved");
  const source = ts.createSourceFile(
    PROBE_ROUTE,
    readFileSync(new URL(`../../../${PROBE_ROUTE}`, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
  const imports: Record<string, unknown> = {};
  for (const statement of source.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      imports[statement.moduleSpecifier.text] = {};
    }
  }
  const resolver = loadSource("src/sse/services/compatibleNodeBaseUrl.ts", {
    "@/shared/runtimePolicy": facade,
    "@/shared/runtimePolicyEntrypoints": projections,
    "@/lib/db/providers/nodes": { resolveProviderNodeForConnection: async () => null },
    "@omniroute/open-sse/config/providerRegistry.ts": {
      getRegistryEntry: (provider: string) => ({ id: provider }),
    },
  }) as { assertResolvedProviderConnectionEntrypoint: (candidate: ProbeRow) => Promise<ProbeRow> };
  imports["@/sse/services/compatibleNodeBaseUrl"] = {
    assertResolvedProviderConnectionEntrypoint: async (candidate: ProbeRow) => {
      counts.admission++;
      admissions.push(candidate);
      return options.admit
        ? options.admit(candidate)
        : resolver.assertResolvedProviderConnectionEntrypoint(candidate);
    },
  };
  imports["@/shared/runtimePolicy"] = facade;
  imports["@omniroute/open-sse/utils/error"] = {
    runtimePolicyErrorResponse: () => {
      const response = Response.json(
        {
          error: {
            code: "OMNI_RUNTIME_POLICY_DENIED",
            message: "Runtime policy denied this operation.",
          },
        },
        { status: 403 }
      );
      marked.add(response);
      return response;
    },
  };
  imports["next/server"] = { NextResponse: Response };
  const optionalString = { max: () => optionalString, optional: () => optionalString };
  imports.zod = { z: { string: () => optionalString, object: () => ({}) } };
  imports["@/shared/validation/helpers"] = {
    validateBody: (_schema: unknown, value: ProbeRow) => ({ data: value }),
    isValidationFailure: () => false,
  };
  imports["@/lib/db/readCache"] = { getCachedProviderConnectionById: async () => connection };
  imports["@/lib/db/providers"] = {
    updateProviderConnection: async (_id: string, patch: ProbeRow) => {
      counts.healthWrite++;
      writes.push(patch);
    },
  };
  imports["@/lib/exclusiveLeaseIsolation"] = {
    isConnectionUnavailableToAuxiliaryActivity: async () => {
      counts.lease++;
      return false;
    },
  };
  imports["@/lib/db/settings"] = {
    resolveProxyForConnection: async () => {
      counts.proxy++;
      if (options.denyAt === "proxy") throw denial;
      return null;
    },
    isCloudEnabled: async () => false,
  };
  imports["@/lib/cloudSync"] = {
    syncToCloud: async () => {
      counts.cloud++;
    },
  };
  imports["@/lib/providers/chatgptWebRetirementResponse"] = {
    assertProviderAvailable() {},
    responseForError: () => null,
  };
  imports["./cliRuntimeProviderMap"] = {
    CLI_RUNTIME_PROVIDER_MAP: {
      "fixture-live": "fixture-runtime",
      "fixture-oauth": "fixture-runtime",
      "fixture-canonical": "fixture-runtime",
    },
  };
  imports["@/shared/services/cliRuntime"] = {
    getCliRuntimeStatus: async () => {
      counts.runtime++;
      if (options.denyAt === "runtime") throw denial;
      return { installed: true, runnable: true };
    },
  };
  const diagnosis = (type: string, source: string, message: unknown, code: unknown) => ({
    type,
    source,
    message,
    code,
  });
  imports["./codexAppServerHealth"] = {
    makeDiagnosis: diagnosis,
    testCodexAppServerConnection: async () => {
      counts.appserver++;
      return null;
    },
  };
  imports["./publicErrorBoundary"] = {
    classifyFailure: () => diagnosis("upstream", "fixture", "safe failure", "fixture"),
    isAccountDeactivatedMessage: () => false,
    projectConnectionTestResultForPublicResponse: (value: unknown) => value,
    projectProviderRuntimeForPublicResponse: (value: unknown) => value,
    toSafeMessage: () => "safe error",
  };
  imports["@/shared/constants/providers"] = { providerAllowsOptionalApiKey: () => false };
  imports["./webSessionTestDispatch"] = {
    shouldUseApiKeyConnectionTest: (authType: string) => authType === "apikey",
  };
  imports["@/lib/providers/validation"] = {
    validateProviderApiKey: async (value: ProbeRow) => {
      counts.probe++;
      validations.push(value);
      if (options.denyAt === "probe") throw denial;
      return { valid: true };
    },
  };
  imports["@/lib/providers/validation/transport"] = {
    projectProviderValidationResultForPublicResponse: (value: unknown) => value,
  };
  imports["./apiKeyTestResult"] = {
    buildApiKeyConnectionTestResult: (result: ProbeRow, error: unknown, diagnosis: unknown) => ({
      ...result,
      error,
      diagnosis,
    }),
  };
  imports["@omniroute/open-sse/utils/proxyFetch.ts"] = {
    runWithProxyContext: (_proxy: unknown, action: () => unknown) => action(),
  };
  imports["@omniroute/open-sse/services/apiKeyRotator.ts"] = { recoverKeyHealth: () => null };
  imports["@/lib/usage/providerLimits"] = {
    shouldClearErrorStateOnValidProbe: (_connection: unknown, valid: boolean) => valid,
  };
  imports["@/lib/tokenHealthCheck"] = { shouldHideLogs: async () => true };
  imports["@/lib/usageDb"] = {
    saveCallLog: async () => {
      counts.log++;
    },
  };
  imports["@/lib/proxyLogger"] = {
    logProxyEvent: () => {
      counts.log++;
    },
  };
  imports["@omniroute/open-sse/services/refreshSerializer.ts"] = {
    rotationGroupFor: () => (options.rotating ? "fixture-rotation-group" : null),
  };
  imports["@omniroute/open-sse/services/tokenRefresh.ts"] = {
    getAccessToken: async () => {
      counts.refresh++;
      if (options.denyAt === "refresh") throw denial;
      return { accessToken: "refreshed-fixture-token" };
    },
  };
  imports["./oauthTestConfig"] = {
    OAUTH_TEST_CONFIG: {
      "fixture-oauth": {
        refreshable: true,
        method: "GET",
        url: "https://probe.example.invalid",
        authHeader: "Authorization",
        authPrefix: "Bearer ",
        ...options.oauthConfig,
      },
      "gitlab-duo": {
        refreshable: false,
        method: "GET",
        url: "https://probe.example.invalid",
        authHeader: "Authorization",
        authPrefix: "Bearer ",
      },
    },
    classifyOAuthProbeInconclusive: () => null,
  };
  imports["@omniroute/open-sse/services/errorClassifier.ts"] = { isGeoBlockedError: () => false };
  imports["@/lib/oauth/gitlab"] = {
    buildGitLabOAuthEndpoints: () => ({ publicCompletionsUrl: "https://fallback.example.invalid" }),
    resolveGitLabOAuthBaseUrl: () => "https://gitlab.example.invalid",
    buildGitLabDuoProbeHeaders: () => ({}),
    buildGitLabDuoProbeBody: () => ({}),
    shouldFallbackToPublicCodeSuggestions: () => true,
  };
  const route = loadSource(PROBE_ROUTE, imports, {
    console: { log() {}, error() {}, warn() {} },
    AbortSignal,
    fetch: async (url: string) => {
      counts.probe++;
      urls.push(url);
      if (options.denyAt === "probe") throw denial;
      if (options.denyAt === "body")
        return {
          status: 401,
          ok: false,
          text: async () => {
            throw denial;
          },
        };
      const reply = options.fetchReplies?.shift();
      if (reply instanceof Error) throw reply;
      return reply ?? new Response(null, { status: 200 });
    },
  }) as {
    testSingleConnection: (id: string, validationModelId?: string) => Promise<ProbeRow>;
    testOAuthConnection: (candidate: ProbeRow, timeoutMs?: number) => Promise<ProbeRow>;
    POST: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
  };
  return { route, connection, counts, admissions, validations, writes, urls, marked, denial };
}

function noProbeEffects(f: ReturnType<typeof providerProbeFixture>) {
  const { admission: _admission, ...effects } = f.counts;
  assert.equal(
    Object.values(effects).reduce((sum, count) => sum + count, 0),
    0
  );
}

test("connection test locked inactive unreviewed candidate denies before runtime refresh probe and health", async () => {
  const f = providerProbeFixture();
  await assert.rejects(f.route.testSingleConnection("request-id"), Denied);
  assert.equal(f.counts.admission, 1);
  assert.equal(f.admissions[0], f.connection);
  noProbeEffects(f);
});

test("connection test real provider symbols stay closed even for inactive stored rows", async () => {
  for (const provider of ["maxai", "uc", "uc-direct", "codex", "codex-app-server"]) {
    const f = providerProbeFixture({
      connection: {
        id: "stored-id",
        provider,
        isActive: false,
        authType: "oauth",
        accessToken: "fixture-token",
        refreshToken: "fixture-refresh",
        expiresAt: "2000-01-01T00:00:00Z",
        providerSpecificData: { accountTag: "keep" },
      },
    });
    await assert.rejects(f.route.testSingleConnection("request-id"), Denied);
    noProbeEffects(f);
  }
});

test("provider test POST returns safe branded403 without state or transport effects", async () => {
  const f = providerProbeFixture();
  const response = await f.route.POST(
    new Request("http://localhost/api/providers/request-id/test", { method: "POST" }),
    { params: Promise.resolve({ id: "request-id" }) }
  );
  assert.equal(response.status, 403);
  assert.ok(f.marked.has(response));
  assert.doesNotMatch(await response.text(), /fixture-secret|stored-probe-id|accountTag/);
  noProbeEffects(f);
});

test("connection test not-found remains before admission", async () => {
  const f = providerProbeFixture({ connection: null });
  const result = await f.route.testSingleConnection("missing-id");
  assert.equal(result.error, "Connection not found");
  assert.equal(f.counts.admission, 0);
  noProbeEffects(f);
});

for (const provider of ["nous-oauth", "nso"]) {
  for (const isLocked of [true, false]) {
    test(`connection test ${provider} unsupported skip stays side-effect-free when ${isLocked ? "locked" : "standalone"}`, async () => {
      locked = isLocked;
      const f = providerProbeFixture({
        connection: {
          id: "stored-nso",
          provider,
          isActive: false,
          authType: "oauth",
          accessToken: "fixture-token",
          refreshToken: "fixture-refresh",
          expiresAt: "2000-01-01T00:00:00Z",
        },
      });
      const result = await f.route.testSingleConnection("stored-nso");
      assert.equal(result.skipped, true);
      assert.equal(result.valid, false);
      assert.equal(result.testedAt, null);
      assert.equal(result.refreshed, false);
      assert.equal(f.counts.admission, 0);
      noProbeEffects(f);
    });
  }
}

test("connection test awaits admission before lease proxy runtime or probe", async () => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const admissionEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const f = providerProbeFixture({
    admit: async () => {
      entered();
      await gate;
      throw f.denial;
    },
  });
  const pending = f.route.testSingleConnection("request-id");
  await admissionEntered;
  noProbeEffects(f);
  release();
  await assert.rejects(pending, (error) => error === f.denial);
  noProbeEffects(f);
});

test("connection test uses returned canonical identity and full effective PSD for validation", async () => {
  const marker = Symbol("fixture-node-binding");
  const original = {
    id: "stored-id",
    provider: "stored-alias",
    authType: "apikey",
    apiKey: "fixture-secret",
    isActive: false,
    providerSpecificData: {
      baseUrl: "https://copied.example.invalid/v1",
      retained: { keep: true },
      modelsPath: "/old-models",
    },
  };
  const effectiveData = {
    ...original.providerSpecificData,
    baseUrl: "https://node.example.invalid/v1",
    modelsPath: "/current-models",
    customHeaders: { "X-Fixture": "kept" },
    [marker]: { kind: "node", nodeId: "fixture-current-node" },
  };
  const effective = {
    ...original,
    provider: "fixture-canonical",
    providerSpecificData: effectiveData,
  };
  // A synthetic admitted projection isolates the caller contract, not live approval.
  const f = providerProbeFixture({ connection: original, admit: async () => effective });
  const result = await f.route.testSingleConnection("request-id", "selected-model");
  assert.equal(result.valid, true);
  assert.equal(f.admissions[0], original);
  assert.equal(f.validations[0].provider, "fixture-canonical");
  const data = f.validations[0].providerSpecificData as Record<string | symbol, unknown>;
  assert.equal(data.baseUrl, effectiveData.baseUrl);
  assert.equal(data.modelsPath, effectiveData.modelsPath);
  assert.equal(data.customHeaders, effectiveData.customHeaders);
  assert.equal(data.retained, original.providerSpecificData.retained);
  assert.equal(data[marker], effectiveData[marker]);
  assert.equal(data.validationModelId, "selected-model");
  assert.equal(original.providerSpecificData.baseUrl, "https://copied.example.invalid/v1");
});

test("standalone connection testing keeps successful validation and activation", async () => {
  locked = false;
  const f = providerProbeFixture();
  const result = await f.route.testSingleConnection("stored-probe-id");
  assert.equal(result.valid, true);
  assert.equal(f.counts.admission, 1);
  assert.equal(f.admissions[0], f.connection);
  assert.equal(f.validations[0].providerSpecificData, f.connection?.providerSpecificData);
  assert.equal(f.counts.runtime, 1);
  assert.equal(f.counts.probe, 1);
  assert.equal(f.counts.refresh, 0);
  assert.equal(f.counts.healthWrite, 1);
  assert.equal(f.writes[0].isActive, true);
});

for (const denyAt of ["proxy", "runtime", "probe"] as const) {
  test(`connection test preserves local ${denyAt} denial instead of health penalty`, async () => {
    const f = providerProbeFixture({ admit: async (candidate) => candidate, denyAt });
    await assert.rejects(
      f.route.testSingleConnection("stored-probe-id"),
      (error) => error === f.denial
    );
    assert.equal(f.counts.healthWrite + f.counts.cloud + f.counts.log, 0);
    if (denyAt !== "probe") assert.equal(f.counts.probe, 0);
    if (denyAt === "proxy") assert.equal(f.counts.runtime + f.counts.appserver, 0);
  });
}

function oauthProbeConnection(overrides: ProbeRow = {}): ProbeRow {
  return {
    id: "stored-oauth",
    provider: "fixture-oauth",
    authType: "oauth",
    isActive: false,
    accessToken: "fixture-access",
    expiresAt: "2099-01-01T00:00:00Z",
    providerSpecificData: {},
    ...overrides,
  };
}

for (const denyAt of ["refresh", "probe", "body"] as const) {
  test(`OAuth ${denyAt} policy failure stays terminal before health normalization`, async () => {
    const f = providerProbeFixture({
      admit: async (candidate) => candidate,
      denyAt,
      connection: oauthProbeConnection(
        denyAt === "refresh"
          ? {
              refreshToken: "fixture-refresh",
              expiresAt: "2000-01-01T00:00:00Z",
            }
          : {}
      ),
    });
    await assert.rejects(
      f.route.testSingleConnection("stored-oauth"),
      (error) => error === f.denial
    );
    assert.equal(f.counts.healthWrite + f.counts.cloud + f.counts.log, 0);
    if (denyAt === "refresh") assert.equal(f.counts.probe, 0);
  });
}

test("OAuth reactive400 retry policy failure is not a network verdict or health penalty", async () => {
  const options: Parameters<typeof providerProbeFixture>[0] = {
    admit: async (candidate) => candidate,
    connection: oauthProbeConnection({ refreshToken: "fixture-refresh" }),
  };
  const f = providerProbeFixture(options);
  options.fetchReplies = [new Response(null, { status: 400 }), f.denial];
  await assert.rejects(f.route.testSingleConnection("stored-oauth"), (error) => error === f.denial);
  assert.equal(f.counts.refresh, 1);
  assert.equal(f.counts.probe, 2);
  assert.equal(f.counts.healthWrite + f.counts.cloud + f.counts.log, 0);
});

test("OAuth GitLab fallback policy failure does not become an authentication failure", async () => {
  const options: Parameters<typeof providerProbeFixture>[0] = {
    admit: async (candidate) => candidate,
    connection: oauthProbeConnection({ provider: "gitlab-duo" }),
  };
  const f = providerProbeFixture(options);
  options.fetchReplies = [new Response("fixture-direct-access-denied", { status: 403 }), f.denial];
  await assert.rejects(f.route.testSingleConnection("stored-oauth"), (error) => error === f.denial);
  assert.equal(f.counts.probe, 2);
  assert.equal(f.counts.refresh + f.counts.healthWrite + f.counts.log, 0);
});

for (const mode of [
  "initial-inconclusive",
  "reactive400-inconclusive",
  "reactive401-inconclusive",
  "reactive401-body",
] as const) {
  test(`OAuth ${mode} branded body read is not normalized to empty text`, async () => {
    const rotating = mode.startsWith("reactive401");
    const options: Parameters<typeof providerProbeFixture>[0] = {
      admit: async (candidate) => candidate,
      rotating,
      connection: oauthProbeConnection({
        refreshToken: "fixture-refresh",
        ...(rotating ? { expiresAt: "2000-01-01T00:00:00Z" } : {}),
      }),
      oauthConfig: { inconclusiveStatuses: [402] },
    };
    const f = providerProbeFixture(options);
    const status = mode === "reactive401-body" ? 401 : 402;
    const bodyReply = new Response("fixture-body", { status });
    bodyReply.text = async () => {
      throw f.denial;
    };
    bodyReply.clone = () => bodyReply;
    options.fetchReplies =
      mode === "initial-inconclusive"
        ? [bodyReply]
        : [new Response(null, { status: rotating ? 401 : 400 }), bodyReply];
    await assert.rejects(
      f.route.testSingleConnection("stored-oauth"),
      (error) => error === f.denial
    );
    assert.equal(f.counts.healthWrite + f.counts.cloud + f.counts.log, 0);
  });
}

test("provider test POST cannot replace the canonical candidate through request JSON", async () => {
  const f = providerProbeFixture();
  const response = await f.route.POST(
    new Request("http://localhost/api/providers/request-id/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "forged-id",
        provider: "forged-provider",
        providerSpecificData: { baseUrl: "https://forged.example.invalid" },
        validationModelId: "fixture-model",
      }),
    }),
    { params: Promise.resolve({ id: "request-id" }) }
  );
  assert.equal(response.status, 403);
  assert.equal(f.admissions[0], f.connection);
  assert.equal(f.admissions[0].id, "stored-probe-id");
  assert.equal(f.admissions[0].provider, "fixture-live");
  noProbeEffects(f);
});

test("standalone ordinary OAuth transport failure retains its existing health result", async () => {
  locked = false;
  const f = providerProbeFixture({
    connection: oauthProbeConnection(),
    fetchReplies: [new Error("ordinary transport failure")],
  });
  const result = await f.route.testSingleConnection("stored-oauth");
  assert.equal(result.valid, false);
  assert.equal(result.error, "safe error");
  assert.equal(f.counts.probe, 1);
  assert.equal(f.counts.refresh, 0);
  assert.equal(f.counts.healthWrite, 1);
  assert.equal(f.writes[0].testStatus, "error");
});


const BATCH_PROBE_ROUTE = "src/app/api/providers/test-batch/route.ts";
function batchProbeFixture(
  options: {
    connections?: Array<Record<string, unknown>>;
    test?: (id: string) => Promise<Record<string, unknown>>;
    authenticated?: boolean;
  } = {}
) {
  const connections =
    options.connections ??
    Array.from({ length: 12 }, (_, index) => ({
      id: `connection-${index}`,
      provider: "fixture-provider",
      name: `fixture-name-${index}`,
      authType: "apikey",
      isActive: true,
    }));
  const called: string[] = [];
  const completed: string[] = [];
  const filters: unknown[] = [];
  const normalized: unknown[] = [];
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const marked = new WeakSet<Response>();
  let active = 0;
  let maxActive = 0;
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const denial = new Denied("entrypoint-unapproved");
  const constants: Record<string, unknown> = {};
  for (const name of [
    "AI_PROVIDERS",
    "NOAUTH_PROVIDERS",
    "OAUTH_PROVIDERS",
    "APIKEY_PROVIDERS",
    "LOCAL_PROVIDERS",
    "UPSTREAM_PROXY_PROVIDERS",
    "WEB_COOKIE_PROVIDERS",
    "SEARCH_PROVIDERS",
    "AUDIO_ONLY_PROVIDERS",
    "CLOUD_AGENT_PROVIDERS",
  ])
    constants[name] = {};
  Object.assign(constants, {
    IDE_PROVIDER_IDS: new Set(),
    getProviderConnectionFamilyIds: (id: string) => [id],
    OPENAI_COMPATIBLE_PREFIX: "openai-compatible-",
    ANTHROPIC_COMPATIBLE_PREFIX: "anthropic-compatible-",
  });
  const route = loadSource(
    BATCH_PROBE_ROUTE,
    {
      "next/server": { NextResponse: Response },
      "@/shared/runtimePolicy": facade,
      "@/models": {
        getProviderConnections: async (filter?: Record<string, unknown>) => {
          filters.push(filter);
          return filter?.isActive
            ? connections.filter((connection) => connection.isActive)
            : connections;
        },
      },
      "@/shared/constants/providers": constants,
      "../[id]/test/route": {
        testSingleConnection: async (id: string) => {
          called.push(id);
          active++;
          maxActive = Math.max(maxActive, active);
          started();
          try {
            return options.test
              ? await options.test(id)
              : { valid: true, latencyMs: 7, testedAt: "fixture-tested-at" };
          } finally {
            active--;
            completed.push(id);
          }
        },
      },
      "@/shared/validation/schemas": { providersBatchTestSchema: {} },
      "@/shared/validation/helpers": {
        validateBody: (_schema: unknown, data: unknown) => ({ data }),
        isValidationFailure: () => false,
      },
      "@/lib/api/requireManagementAuth": {
        requireManagementAuth: async () =>
          options.authenticated === false ? Response.json({}, { status: 401 }) : null,
      },
      "@omniroute/open-sse/utils/error": {
        sanitizeErrorMessage: (error: unknown) => {
          normalized.push(error);
          return "safe ordinary error";
        },
        runtimePolicyErrorResponse: () => {
          const response = Response.json(
            {
              error: {
                code: "OMNI_RUNTIME_POLICY_DENIED",
                message: "Runtime policy denied this operation.",
              },
            },
            { status: 403 }
          );
          marked.add(response);
          return response;
        },
      },
    },
    {
      console: { log() {}, warn() {}, error() {} },
      setTimeout: (callback: () => void, delay: number) => {
        timers.push({ callback, delay });
        return timers.length;
      },
    }
  ) as { POST: (request: Request) => Promise<Response> };
  return {
    called,
    completed,
    filters,
    normalized,
    timers,
    marked,
    denial,
    firstStarted,
    maxActive: () => maxActive,
    invoke: (body: Record<string, unknown> = { mode: "all" }) =>
      route.POST(
        new Request("http://localhost/api/providers/test-batch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      ),
  };
}

test("batch policy denial stays terminal and never starts a later batch", async () => {
  const options: Parameters<typeof batchProbeFixture>[0] = {};
  const f = batchProbeFixture(options);
  options.test = async (id) => {
    if (id === "connection-2") throw f.denial;
    return { valid: true };
  };
  const response = await f.invoke();
  assert.equal(response.status, 403);
  assert.ok(f.marked.has(response));
  assert.deepEqual(
    f.called,
    Array.from({ length: 5 }, (_, index) => `connection-${index}`)
  );
  assert.equal(f.normalized.length, 0);
  assert.doesNotMatch(await response.text(), /fixture-name|connection-2|network_error/);
});

test("batch denial lets already-started siblings finish but does not start later work", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const options: Parameters<typeof batchProbeFixture>[0] = {};
  const f = batchProbeFixture(options);
  options.test = async (id) => {
    if (id === "connection-0") throw f.denial;
    await gate;
    return { valid: true };
  };
  let finished = false;
  const pending = f.invoke().then((response) => {
    finished = true;
    return response;
  });
  await f.firstStarted;
  assert.equal(f.called.length, 5);
  assert.equal(finished, false);
  release();
  const response = await pending;
  assert.equal(response.status, 403);
  assert.equal(f.called.length, 5);
  assert.equal(f.completed.length, 5);
  assert.equal(f.maxActive(), 5);
  assert.equal(f.timers.length, 5);
});

test("batch denial in a later group discards partial summary and blocks subsequent groups", async () => {
  const options: Parameters<typeof batchProbeFixture>[0] = {};
  const f = batchProbeFixture(options);
  options.test = async (id) => {
    if (id === "connection-8") throw f.denial;
    return { valid: true };
  };
  const response = await f.invoke();
  assert.equal(response.status, 403);
  assert.equal(f.called.length, 10);
  assert.equal(f.completed.length, 10);
  const body = await response.json();
  assert.equal(body.results, undefined);
  assert.equal(body.summary, undefined);
  assert.equal(f.normalized.length, 0);
});

test("standalone ordinary batch failure keeps result order summary and concurrency five", async () => {
  locked = false;
  const f = batchProbeFixture({
    test: async (id) => {
      if (id === "connection-2") throw new Error("ordinary upstream failure");
      return { valid: true, latencyMs: 7, testedAt: "fixture-tested-at" };
    },
  });
  const response = await f.invoke();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.summary, { total: 12, passed: 11, failed: 1 });
  assert.deepEqual(
    body.results.map((result: Record<string, unknown>) => result.connectionId),
    f.called
  );
  assert.equal(body.results[2].diagnosis.type, "network_error");
  assert.equal(body.results[2].error, "safe ordinary error");
  assert.equal(body.results[0].testedAt, "fixture-tested-at");
  assert.equal(body.results[0].latencyMs, 7);
  assert.equal(f.maxActive(), 5);
  assert.equal(f.timers.length, 12);
  assert.ok(f.timers.every((timer) => timer.delay === 30_000));
});

test("batch retains the existing thirty-second timeout as an ordinary failed result", async () => {
  const f = batchProbeFixture({
    connections: [{ id: "pending-id", provider: "fixture-provider", isActive: true }],
    test: async () => new Promise(() => {}),
  });
  const pending = f.invoke();
  await f.firstStarted;
  assert.equal(f.timers.length, 1);
  assert.equal(f.timers[0].delay, 30_000);
  f.timers[0].callback();
  const response = await pending;
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.summary, { total: 1, passed: 0, failed: 1 });
  assert.equal(body.results[0].connectionId, "pending-id");
  assert.equal(body.results[0].diagnosis.type, "network_error");
  assert.deepEqual(f.normalized, ["Connection test timed out after 30s"]);
});

test("batch selected mode still includes inactive rows while bulk all remains active-only", async () => {
  const connections = [
    { id: "inactive-id", provider: "fixture-provider", isActive: false },
    { id: "active-id", provider: "fixture-provider", isActive: true },
  ];
  const selected = batchProbeFixture({ connections });
  assert.equal(
    (await selected.invoke({ mode: "selected", connectionIds: ["inactive-id", "active-id"] }))
      .status,
    200
  );
  assert.deepEqual(selected.called, ["inactive-id", "active-id"]);
  assert.equal(selected.filters[0], undefined);
  const bulk = batchProbeFixture({ connections });
  assert.equal((await bulk.invoke()).status, 200);
  assert.deepEqual(bulk.called, ["active-id"]);
  assert.deepEqual(plain(bulk.filters[0]), { isActive: true });
});

test("batch authentication and empty selections keep their existing early responses", async () => {
  const unauthenticated = batchProbeFixture({ authenticated: false });
  assert.equal((await unauthenticated.invoke()).status, 401);
  assert.equal(
    unauthenticated.filters.length + unauthenticated.called.length + unauthenticated.timers.length,
    0
  );
  const empty = batchProbeFixture();
  const response = await empty.invoke({ mode: "selected", connectionIds: ["missing-id"] });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).summary, { total: 0, passed: 0, failed: 0 });
  assert.equal(empty.called.length + empty.timers.length, 0);
});
