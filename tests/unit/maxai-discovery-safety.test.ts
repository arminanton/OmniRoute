/** Actual discovery route + service, with all storage/auth/transport edges inert. */
import assert from "node:assert/strict";
import { RuntimePolicyError, isRuntimePolicyResponse } from "../../src/shared/runtimePolicy.ts";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import ts from "typescript";
import type { MaxaiCredential } from "../../open-sse/executors/maxai/credentials.ts";
import { MOCK_CONSTANTS } from "./helpers/maxaiMockConstants.ts";

const routeUrl = new URL("../../src/app/api/providers/[id]/models/route.ts", import.meta.url);
const PRIVATE_DETAIL = "synthetic-access synthetic-refresh proxy-password at /private/test.ts:1:1";
const credential = {
  accessToken: "synthetic-access",
  refreshToken: "canonical-refresh",
  providerSpecificData: {
    maxaiDeviceId: "22222222-2222-4222-8222-222222222222",
    maxaiUserId: "11111111-1111-4111-8111-111111111111",
    maxaiRefreshToken: "legacy-refresh",
  },
};
type RefreshInput = {
  connectionId: string;
  credential: MaxaiCredential;
  signal?: AbortSignal;
  fetchImpl: typeof fetch;
};
const state = {
  connection: { id: "selected-account", provider: "maxai", ...credential },
  scope: null as string | null,
  events: [] as string[],
  calls: [] as { scope: string | null; url: string; init?: RequestInit }[],
  refreshed: null as RefreshInput | null,
  refresh: async (input: RefreshInput) => ({ ...input.credential, accessToken: "fresh-access" }),
  wire: (async () => Response.json({})) as typeof fetch,
  denied: false,
  failScope: false,
  cached: [] as { id: string; name: string }[],
  autoFetch: true,
  logs: [] as unknown[],
  constants: MOCK_CONSTANTS,
};
const symbol = Symbol.for("omniroute.maxai-discovery-safety");
Object.defineProperty(globalThis, symbol, { value: state, configurable: true });
const prelude = 'const s = globalThis[Symbol.for("omniroute.maxai-discovery-safety")];';

// Parse only imports from the actual route. Any dependency not explicitly used
// by this MaxAI branch is an inert function that throws if accidentally called.
const routeMocks = new Map<string, string>();
const routeAst = ts.createSourceFile(
  "route.ts",
  readFileSync(routeUrl, "utf8"),
  ts.ScriptTarget.Latest,
  true
);
for (const statement of routeAst.statements) {
  if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
    continue;
  const specifier = statement.moduleSpecifier.text;
  if (specifier.endsWith("/services/maxaiModels.ts") || specifier === "@/shared/runtimePolicy")
    continue;
  const bindings = statement.importClause?.namedBindings;
  assert.ok(bindings && ts.isNamedImports(bindings), `Unexpected route import: ${specifier}`);
  routeMocks.set(
    specifier,
    bindings.elements
      .map((element) => {
        const name = element.propertyName?.text ?? element.name.text;
        return `export const ${name} = () => { throw new Error("Unexpected dependency: ${name}"); };`;
      })
      .join("\n")
  );
}
const overrides: Record<string, string> = {
  // Existing standalone/offline fixtures do not exercise locked node admission;
  // C's policy tests cover that guard. Preserve its effective-candidate return.
  "@/sse/services/compatibleNodeBaseUrl":
    "export const assertResolvedProviderConnectionEntrypoint = async candidate => candidate;",
  "next/server": "export const NextResponse = {json:(body,init)=>Response.json(body,init)};",
  "@/lib/api/requireManagementAuth": `export async function requireManagementAuth() {
    s.events.push("auth"); return s.denied ? Response.json({error:"denied"},{status:403}) : null;
  }`,
  "@/lib/db/readCache": `export async function getCachedProviderConnectionById() {
    s.events.push("read"); return s.connection;
  }`,
  "@/shared/constants/providers": `export const NOAUTH_PROVIDERS = {};
    export const isClaudeCodeCompatibleProvider = () => false;
    export const isAnthropicCompatibleProvider = () => false;
    export const isOpenAICompatibleProvider = () => false;`,
  "@/lib/providers/modelListingCapability":
    "export const providerUsesCuratedModelsOnly = () => false;",
  "@/lib/exclusiveLeaseIsolation":
    "export const isConnectionUnavailableToAuxiliaryActivity = async () => false;",
  "./staleEncryptionGuard": "export const buildStaleEncryptionKeyResponse = () => null;",
  "@/lib/db/proxies": `export const resolveProxyForProvider = () => {
    s.events.push("unsafe-provider-proxy"); throw new Error("Provider proxy cannot replace selected account");
  };`,
  "@/lib/db/models": `export const getCustomModels = async () => [];
    export const getSyncedAvailableModels = async () => [];
    export const getModelIsHidden = () => false;`,
  "@/lib/providerModels/modelDiscovery": `export const isAutoFetchModelsEnabled = () => s.autoFetch;
    export const getCachedDiscoveredModels = async () => s.cached;
    export const persistDiscoveredModels = async (_provider,_id,models) => {
      s.events.push("persist-models"); return models;
    };`,
  "@/shared/constants/models": "export const getModelsByProviderId = () => [];",
  "@/lib/providers/staticModels": "export const getStaticModelsForProvider = () => [];",
  "./modelRouteProjection": `export const filterModelsForRoute = (_provider,models) => models;
    export const buildNoAuthModelsResponse = () => { throw new Error("Unexpected no-auth provider"); };`,
};
for (const [specifier, source] of Object.entries(overrides)) routeMocks.set(specifier, source);
routeMocks.set(
  "@omniroute/open-sse/utils/error",
  `export { runtimePolicyErrorResponse } from "file:///home/ubuntu/_/omni/ws/local-next/open-sse/utils/error.ts";
  export const errorResponse=(status,message)=>Response.json({error:{message}},{status});
  export const sanitizeErrorMessage=value=>String(value);`
);
// Retain names the route imports but does not use in this branch.
routeMocks.set(
  "./discovery/helpers",
  routeMocks
    .get("./discovery/helpers")!
    .replace(
      'export const mergeLocalCatalogModels = () => { throw new Error("Unexpected dependency: mergeLocalCatalogModels"); };',
      "export const mergeLocalCatalogModels = (a,b) => [...a,...b];"
    )
    .replace(
      'export const mergeSpecialtyCatalogIntoLiveModels = () => { throw new Error("Unexpected dependency: mergeSpecialtyCatalogIntoLiveModels"); };',
      "export const mergeSpecialtyCatalogIntoLiveModels = (models) => models;"
    )
);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    let source: string | undefined;
    if (decodeURI(context.parentURL ?? "") === decodeURI(routeUrl.href))
      source = routeMocks.get(specifier);
    if (specifier.endsWith("/maxaiTransport.ts"))
      source = `
      export async function runMaxaiConnectionTransport(id, fn) {
        s.events.push("scope:" + id);
        if (!id || s.failScope) throw new Error("${PRIVATE_DETAIL}");
        const prior = s.scope; s.scope = id;
        try { return await fn(); } finally { s.scope = prior; }
      }
      export const maxaiFetch = (url,init) => {
        if (!s.scope) throw new Error("Unscoped fetch");
        s.calls.push({scope:s.scope,url:String(url),init}); return s.wire(url,init);
      };`;
    if (specifier.endsWith("/maxai/refresh.ts"))
      source = `
      export class MaxaiRefreshError extends Error { status = 503; }
      export async function ensureFreshMaxaiCredential(input) {
        s.events.push("refresh:" + s.scope); s.refreshed = input; return s.refresh(input);
      }`;
    if (specifier.endsWith("/maxai/constantsStore.ts"))
      source = `
      export async function ensureMaxaiConstants(input) {
        s.events.push("constants:" + s.scope);
        await input.fetchImpl("https://www.maxai.co/app/", {signal:input.signal,redirect:"error"});
        return s.constants;
      }`;
    if (source !== undefined)
      return {
        url: "data:text/javascript," + encodeURIComponent(prelude + source),
        shortCircuit: true,
      };
    if (specifier.includes("/lib/db/"))
      throw new Error(`Real database forbidden: ${specifier} from ${context.parentURL}`);
    return nextResolve(specifier, context);
  },
});
const { discoverMaxaiModels, MAXAI_REGISTRY_MODELS } =
  await import("../../open-sse/services/maxaiModels.ts");
const { maxaiFetch } = await import("../../open-sse/services/maxaiTransport.ts");
const route = await import("../../src/app/api/providers/[id]/models/route.ts");
const modelId = MAXAI_REGISTRY_MODELS[0].id;
const nativeFetch = globalThis.fetch;
const originalLog = console.log;

function validCatalog() {
  return {
    data: {
      chat_models: [{ model_name: modelId, max_tokens: 123456, capabilities: { vision: true } }],
    },
  };
}
async function get(refresh = true, signal?: AbortSignal) {
  return route.GET(
    new Request(`http://localhost/api/providers/selected-account/models?refresh=${refresh}`, {
      signal,
    }),
    { params: { id: "selected-account" } }
  );
}
test.beforeEach(() => {
  state.connection = { id: "selected-account", provider: "maxai", ...credential };
  state.scope = null;
  state.events = [];
  state.calls = [];
  state.refreshed = null;
  state.denied = false;
  state.failScope = false;
  state.cached = [];
  state.autoFetch = true;
  state.logs = [];
  state.refresh = async (input) => ({ ...input.credential, accessToken: "fresh-access" });
  state.wire = async (url) =>
    String(url).endsWith("/app/") ? new Response("bundle fixture") : Response.json(validCatalog());
  globalThis.fetch = async () => {
    throw new Error("Ambient fetch forbidden");
  };
  console.log = (...args) => state.logs.push(args);
});
test.afterEach(() => {
  globalThis.fetch = nativeFetch;
  console.log = originalLog;
});
test.after(() => {
  hooks.deregister();
  Reflect.deleteProperty(globalThis, symbol);
});

test("discovery uses selected account for bundle, refresh and API, not provider/global proxy", async () => {
  state.refresh = async (input) => {
    assert.equal(input.fetchImpl, maxaiFetch);
    assert.equal(state.scope, "selected-account");
    await input.fetchImpl("https://api.maxai.me/oauth/refresh_access_token", {
      method: "POST",
      signal: input.signal,
      redirect: "error",
    });
    return { ...input.credential, accessToken: "fresh-access" };
  };
  const response = await get();
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.source, "api");
  assert.equal(body.models[0].inputTokenLimit, 123456);
  assert.equal(body.models[0].supportsVision, true);
  assert.deepEqual(
    state.calls.map((call) => call.scope),
    ["selected-account", "selected-account", "selected-account"]
  );
  assert.equal(state.refreshed?.credential.refreshToken, "canonical-refresh");
  assert.equal(state.refreshed?.connectionId, "selected-account");
  assert.ok(!("onCredentialsRefreshed" in (state.refreshed ?? {})));
  const apiCall = state.calls.at(-1)!;
  assert.equal(apiCall.url, "https://api.maxai.me/models/get_config");
  assert.equal(new Headers(apiCall.init?.headers).get("authorization"), "Bearer fresh-access");
  assert.equal(apiCall.init?.redirect, "error");
  assert.deepEqual(JSON.parse(String(apiCall.init?.body)), { language: "en", client_type: "web" });
  assert.ok(!state.events.includes("unsafe-provider-proxy"));
  assert.equal(state.events[0], "auth");
});

test("management denial stops before connection read or transport", async () => {
  state.denied = true;
  assert.equal((await get()).status, 403);
  assert.deepEqual(state.events, ["auth"]);
  assert.equal(state.calls.length, 0);
});

test("mx discovery also bypasses provider proxy selection", async () => {
  state.connection.provider = "mx";
  assert.equal((await (await get()).json()).source, "api");
  assert.ok(!state.events.includes("unsafe-provider-proxy"));
});

test("discovery rejects absent or blank connection identity without any network", async () => {
  for (const connectionId of [undefined, "", "  "]) {
    await assert.rejects(
      discoverMaxaiModels({ ...credential, connectionId }),
      /requires a connection/
    );
  }
  assert.deepEqual(state.calls, []);
  assert.deepEqual(state.events, []);
});

test("transport rejection returns curated catalog only and redacts errors", async () => {
  state.failScope = true;
  const body = await (await get()).json();
  assert.equal(body.source, "local_catalog");
  assert.deepEqual(body.models, MAXAI_REGISTRY_MODELS);
  assert.equal(state.calls.length, 0);
  assert.doesNotMatch(
    JSON.stringify({ body, logs: state.logs }),
    /synthetic-access|synthetic-refresh|proxy-password|at \/private/
  );
});

test("HTTP and thrown upstream errors only return safe cache fallback", async () => {
  for (const wire of [
    async () => new Response(PRIVATE_DETAIL, { status: 418 }),
    async () => {
      throw new Error(PRIVATE_DETAIL);
    },
  ]) {
    state.cached = [{ id: modelId, name: "Cached model" }];
    state.wire = async (url) => (String(url).endsWith("/app/") ? new Response("") : wire());
    const body = await (await get()).json();
    assert.equal(body.source, "cache");
    assert.deepEqual(body.models, state.cached);
    assert.doesNotMatch(
      JSON.stringify({ body, logs: state.logs }),
      /synthetic-access|synthetic-refresh|proxy-password|at \/private/
    );
  }
});

test("cached discovery and disabled auto-fetch do not open transport", async () => {
  state.cached = [{ id: modelId, name: "Cached model" }];
  assert.equal((await (await get(false)).json()).source, "cache");
  state.cached = [];
  state.autoFetch = false;
  assert.equal((await (await get(false)).json()).source, "local_catalog");
  assert.equal(state.calls.length, 0);
  assert.ok(!state.events.some((event) => event.startsWith("scope:")));
});

test("caller abort during refresh prevents bundle and API work", async () => {
  const controller = new AbortController();
  state.refresh = async (input) => {
    controller.abort(new Error(PRIVATE_DETAIL));
    return input.credential;
  };
  const body = await (await get(true, controller.signal)).json();
  assert.equal(body.source, "local_catalog");
  assert.equal(state.refreshed?.signal?.aborted, true);
  assert.equal(state.calls.length, 0);
  assert.doesNotMatch(JSON.stringify(state.logs), /synthetic-access|proxy-password/);
});

test("discovery keeps a 10-second linked timeout without safeOutboundFetch", async (t) => {
  const timeout = new AbortController();
  const durations: number[] = [];
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    durations.push(ms);
    return timeout.signal;
  });
  state.refresh = async (input) => {
    timeout.abort();
    return input.credential;
  };
  const response = await get();
  assert.equal((await response.json()).source, "local_catalog");
  assert.deepEqual(durations, [10_000]);
  assert.equal(state.calls.length, 0);
});

test("discovery drops non-curated/deprecated/non-chat/null rows and keeps catalog window fallback", async () => {
  state.wire = async (url) =>
    String(url).endsWith("/app/")
      ? new Response("")
      : Response.json({
          chat_models: [
            null,
            12,
            { model_name: "unknown-live-model" },
            { model_name: modelId, is_deprecated: true },
            { model_name: modelId, type: "image" },
            { model_name: modelId },
          ],
        });
  const result = await discoverMaxaiModels({ ...credential, connectionId: "selected-account" });
  assert.equal(result.models.length, 1);
  assert.equal(result.models[0].id, modelId);
  assert.ok(result.models[0].inputTokenLimit > 0);
});

test("runtime policy stops discovery before send and never selects cached or curated models", async () => {
  state.cached = [{ id: "cached-safe-looking", name: "cached" }];
  state.refresh = async () => {
    throw new RuntimePolicyError("entrypoint-unapproved");
  };
  const response = await get(),
    body = await response.json();
  assert.equal(response.status, 403);
  assert.equal(isRuntimePolicyResponse(response), true);
  assert.equal(body.error.code, "OMNI_RUNTIME_POLICY_DENIED");
  assert.equal(body.models, undefined);
  assert.equal(state.calls.length, 0);
  assert.equal(state.logs.length, 0);
  assert.ok(!state.events.includes("persist-models"));
});
