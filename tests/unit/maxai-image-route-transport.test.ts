/** Both actual image entry points and real account fallback, no DB or live HTTP. */
import assert from "node:assert/strict";
import { RuntimePolicyError, isRuntimePolicyResponse } from "../../src/shared/runtimePolicy.ts";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import ts from "typescript";

const routeUrls = [
  new URL("../../src/app/api/v1/images/generations/route.ts", import.meta.url),
  new URL("../../src/app/api/v1/providers/[provider]/images/generations/route.ts", import.meta.url),
];
const PRIVATE_DETAIL = "synthetic-access synthetic-refresh proxy-password at /private/test.ts:1:1";
type Credentials = { connectionId?: string; accessToken: string };
type HandlerInput = {
  credentials: Credentials;
  body: { model: string };
  signal?: AbortSignal;
};
const state = {
  credentials: [
    { connectionId: "account-a", accessToken: "access-a" },
    { connectionId: "account-b", accessToken: "access-b" },
  ] as Credentials[],
  events: [] as string[],
  scope: null as string | null,
  scopes: [] as string[],
  attempts: [] as { scope: string | null; input: HandlerInput }[],
  unavailable: new Set<string>(),
  denied: false,
  policyDenied: false,
  invalid: false,
  scopeError: null as Error | null,
  handler: async (_input: HandlerInput) =>
    ({ success: true, data: { data: [{ url: "https://example.com/image.png" }] } }) as {
      success: boolean;
      data?: unknown;
      status?: number;
      error?: string;
      retryable?: boolean;
    },
};
const symbol = Symbol.for("omniroute.maxai-image-route-transport");
Object.defineProperty(globalThis, symbol, { value: state, configurable: true });
const prelude = 'const s = globalThis[Symbol.for("omniroute.maxai-image-route-transport")];';
const routeImports = new Map<string, Map<string, string>>();
const passthrough = new Set([
  "@/shared/runtimePolicy",
  "@omniroute/open-sse/config/imageRegistry.ts",
  "@/sse/services/imageCredentialRetry",
]);
for (const url of routeUrls) {
  const ast = ts.createSourceFile(
    "route.ts",
    readFileSync(url, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
  const imports = new Map<string, string>();
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    const specifier = statement.moduleSpecifier.text;
    if (passthrough.has(specifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings))
      imports.set(
        specifier,
        bindings.elements
          .map((element) => {
            const name = element.propertyName?.text ?? element.name.text;
            return `export const ${name} = () => { throw new Error("Unexpected dependency: ${name}"); };`;
          })
          .join("\n")
      );
  }
  routeImports.set(decodeURI(url.href), imports);
}
const authStub = `export const getProviderCredentialsWithQuotaPreflight = async (provider,_exclude,_allowed,_model,options={}) => {
  s.events.push("select:" + provider);
  return s.credentials.find(c => !(options.excludeConnectionIds ?? []).includes(c.connectionId)) ?? null;
};
export const clearRecoveredProviderState = async () => { s.events.push("recovered"); };`;
const logStub =
  "export const warn = () => {}; export const debug = () => {}; export const info = () => {}; export const error = () => {};";
const overrides: Record<string, string> = {
  "@omniroute/open-sse/handlers/imageGeneration.ts": `export async function handleImageGeneration(input) {
    s.events.push("generate:" + input.credentials?.connectionId);
    s.attempts.push({scope:s.scope,input}); return s.handler(input);
  }`,
  "@/middleware/promptInjectionGuard": "export const withInjectionGuard = fn => fn;",
  "@/sse/services/auth": authStub,
  "@/sse/utils/logger": logStub,
  "@omniroute/open-sse/config/constants.ts":
    "export const HTTP_STATUS = {BAD_REQUEST:400,RATE_LIMITED:429,GONE:410};",
  "@omniroute/open-sse/utils/error.ts": `export { runtimePolicyErrorResponse } from "file:///home/ubuntu/_/omni/ws/local-next/open-sse/utils/error.ts"; export const errorResponse = (status,message) => Response.json({error:{message}}, {status});
    export const unavailableResponse = (status,message) => Response.json({error:{message}}, {status});`,
  "@/shared/utils/upstreamError":
    "export const toJsonErrorPayload = error => ({error:{message:typeof error === 'string' ? error : 'Provider error'}});",
  "@/shared/utils/clientApiRouteAuth": `export async function enforceClientApiRouteAuth() {
    s.events.push("auth"); return s.denied ? Response.json({error:"denied"},{status:401}) : null;
  }`,
  "@/shared/utils/apiKeyPolicy": `export async function enforceApiKeyPolicy() {
    s.events.push("policy"); return {rejection:s.policyDenied ? Response.json({error:"denied"},{status:403}) : null};
  }`,
  "@/shared/validation/schemas": "export const v1ImageGenerationSchema = {};",
  "@/shared/validation/helpers": `export const validateBody = (_schema,body) => s.invalid
    ? {error:{message:"invalid body"}} : {data:body};
    export const isValidationFailure = result => !!result.error;`,
  "@/lib/images/imageRouteModel": "export const resolveImageRouteModel = async model => model;",
  "@/lib/providerModels/syncedEndpointRouting":
    "export const resolveLocalSyncedEndpointRoute = async () => null;",
  "@/lib/usage/callLogApiKeyContext":
    "export const runWithCallLogApiKeyContext = (_ctx,fn) => fn();",
  "@/lib/db/settings": `export async function resolveProxyForConnection() {
    s.events.push("generic-proxy"); return {proxy:"http://generic-proxy.invalid"};
  }`,
  "@omniroute/open-sse/utils/proxyFetch.ts": `export const runWithProxyContext = async (_proxy,fn) => {
    s.events.push("generic-scope"); return fn();
  };`,
  "@/domain/omnirouteResponseMeta": "export const attachOmniRouteMetaHeaders = () => {};",
  "@/lib/usage/costCalculator": "export const calculateModalCost = async () => 0;",
  "@/shared/utils/requestId": "export const generateRequestId = () => 'test-request';",
  "@/shared/constants/designerWebRetirement": `export const isMicrosoftDesignerWebProviderRetiredError = () => false;
    export const isMicrosoftDesignerWebRetiredProviderId = () => false;
    export const MICROSOFT_DESIGNER_WEB_RETIRED_MESSAGE = 'retired';`,
  "@/shared/constants/chatgptWebRetirement": `export const assertCommonChatGptWebModelAvailable = () => {};
    export const CHATGPT_WEB_RETIRED_ERROR_CODE = 'retired';
    export const isCommonChatGptWebRetirementError = () => false;`,
  "@/lib/providers/chatgptWebRetirementResponse":
    "export const rejectRetiredCommonChatGptWebProvider = () => null;",
  "@/server/authz/headers": "export const AUTHZ_HEADER_PEER_LOCALITY = 'x-peer-locality';",
};
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/db/featureFlags")
      return {
        url: "data:text/javascript,export const getFeatureFlagOverride=()=>undefined;",
        shortCircuit: true,
      };
    const imports = routeImports.get(decodeURI(context.parentURL ?? ""));
    let source = imports?.get(specifier);
    if (imports && overrides[specifier]) source = overrides[specifier];
    if (context.parentURL?.endsWith("/imageCredentialRetry.ts")) {
      if (specifier === "./auth") source = authStub;
      if (specifier === "./tokenRefresh")
        source =
          "export const checkAndRefreshToken = async (_provider,credentials) => credentials;";
      if (specifier === "../utils/logger") source = logStub;
      if (specifier.endsWith("/utils/error.ts"))
        source = "export const sanitizeErrorMessage = value => String(value);";
    }
    if (specifier.endsWith("/maxaiTransport.ts"))
      source = `
      export async function runMaxaiConnectionTransport(id,fn) {
        s.scopes.push(id);
        if (s.scopeError) throw s.scopeError;
        if (typeof id !== "string" || !id.trim() || s.unavailable.has(id)) throw new Error("${PRIVATE_DETAIL}");
        const old = s.scope; s.scope = id;
        try { return await fn(); } finally { s.scope = old; }
      }`;
    if (source !== undefined)
      return {
        url: "data:text/javascript," + encodeURIComponent(prelude + source),
        shortCircuit: true,
      };
    if (specifier.includes("/lib/db/"))
      throw new Error(`Real DB forbidden: ${specifier} from ${context.parentURL}`);
    return nextResolve(specifier, context);
  },
});
const general = await import("../../src/app/api/v1/images/generations/route.ts");
const specific =
  await import("../../src/app/api/v1/providers/[provider]/images/generations/route.ts");
const nativeFetch = globalThis.fetch;

test.beforeEach(() => {
  state.credentials = [
    { connectionId: "account-a", accessToken: "access-a" },
    { connectionId: "account-b", accessToken: "access-b" },
  ];
  state.events = [];
  state.scopes = [];
  state.scope = null;
  state.attempts = [];
  state.unavailable = new Set();
  state.denied = false;
  state.policyDenied = false;
  state.invalid = false;
  state.scopeError = null;
  state.handler = async () => ({
    success: true,
    data: { data: [{ url: "https://example.com/image.png" }] },
  });
  globalThis.fetch = async () => {
    throw new Error("Ambient fetch prohibited");
  };
});
test.afterEach(() => {
  globalThis.fetch = nativeFetch;
});
test.after(() => {
  hooks.deregister();
  Reflect.deleteProperty(globalThis, symbol);
});

async function post(specificRoute: boolean, provider = "maxai", signal?: AbortSignal) {
  const request = new Request("http://localhost/api/v1/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: specificRoute ? "gpt-image-1" : `${provider}/gpt-image-1`,
      prompt: "draw a boat",
    }),
    signal,
  });
  const response = specificRoute
    ? await specific.POST(request, { params: Promise.resolve({ provider }) })
    : await general.POST(request, {});
  return { response, request, body: await response.json() };
}
for (const specificRoute of [false, true]) {
  for (const provider of ["maxai", "mx"]) {
    const name = `${specificRoute ? "provider" : "general"} / ${provider}`;
    test(`${name}: each credential fallback attempt gets its own selected scope`, async () => {
      state.handler = async (input) =>
        input.credentials.connectionId === "account-a"
          ? { success: false, status: 401, error: "Expired account", retryable: true }
          : { success: true, data: { data: [{ url: "https://example.com/image.png" }] } };
      const { response, request } = await post(specificRoute, provider);
      assert.equal(response.status, 200);
      assert.deepEqual(state.scopes, ["account-a", "account-b"]);
      assert.deepEqual(
        state.attempts.map(({ scope, input }) => [scope, input.credentials.connectionId]),
        [
          ["account-a", "account-a"],
          ["account-b", "account-b"],
        ]
      );
      assert.ok(state.attempts.every(({ input }) => input.signal === request.signal));
      assert.ok(!state.events.includes("generic-proxy"));
      assert.ok(!state.events.includes("generic-scope"));
      assert.ok(
        state.events.indexOf("auth") <
          state.events.findIndex((event) => event.startsWith("select:"))
      );
      assert.ok(
        state.events.indexOf("policy") <
          state.events.findIndex((event) => event.startsWith("select:"))
      );
    });

    test(`${name}: unavailable first account cannot silently dispatch and fallback is separately verified`, async () => {
      state.unavailable.add("account-a");
      const { response } = await post(specificRoute, provider);
      assert.equal(response.status, 200);
      assert.deepEqual(state.scopes, ["account-a", "account-b"]);
      assert.equal(state.attempts.length, 1);
      assert.equal(state.attempts[0].scope, "account-b");
    });

    test(`${name}: missing connection ID fails before dispatch or transport`, async () => {
      state.credentials = [{ accessToken: "access-without-identity" }];
      const { response, body } = await post(specificRoute, provider);
      assert.equal(response.status, 503);
      assert.match(body.error.message, /requires a connection/);
      assert.equal(state.scopes.length, 0);
      assert.equal(state.attempts.length, 0);
    });
  }

  test(`${specificRoute ? "provider" : "general"}: auth, policy and validation still block dispatch`, async () => {
    state.denied = true;
    assert.equal((await post(specificRoute)).response.status, 401);
    state.denied = false;
    state.policyDenied = true;
    assert.equal((await post(specificRoute)).response.status, 403);
    state.policyDenied = false;
    state.invalid = true;
    assert.equal((await post(specificRoute)).response.status, 400);
    assert.equal(state.scopes.length, 0);
    assert.equal(state.attempts.length, 0);
  });

  test(`${specificRoute ? "provider" : "general"}: all rejected account errors are fixed and redacted`, async () => {
    state.unavailable = new Set(["account-a", "account-b"]);
    const { response, body } = await post(specificRoute);
    assert.equal(response.status, 503);
    assert.doesNotMatch(
      JSON.stringify(body),
      /synthetic-access|synthetic-refresh|proxy-password|at \/private/
    );
    assert.equal(state.attempts.length, 0);
  });

  test(`${specificRoute ? "provider" : "general"}: aborted request cannot start account transport`, async () => {
    const controller = new AbortController();
    controller.abort(new Error(PRIVATE_DETAIL));
    const { response, body } = await post(specificRoute, "maxai", controller.signal);
    assert.equal(response.status, 499);
    assert.equal(state.scopes.length, 0);
    assert.equal(state.attempts.length, 0);
    assert.doesNotMatch(JSON.stringify(body), /synthetic-access|proxy-password/);
  });

  test(`${specificRoute ? "provider" : "general"}: non-MaxAI image dispatch is unchanged`, async () => {
    const { response } = await post(specificRoute, "openai");
    assert.equal(response.status, 200);
    assert.equal(state.scopes.length, 0);
    assert.equal(state.attempts.length, 1);
    assert.equal(state.events.includes("generic-scope"), !specificRoute);
    assert.equal(state.events.includes("generic-proxy"), !specificRoute);
  });
}

for (const specificRoute of [false, true]) {
  for (const provider of ["maxai", "mx"]) {
    test(`${specificRoute ? "provider" : "general"}/${provider}: policy denial before dispatch never tries next account`, async () => {
      state.scopeError = new RuntimePolicyError("proxy-forbidden");
      const { response, body } = await post(specificRoute, provider);
      assert.equal(response.status, 403);
      assert.equal(isRuntimePolicyResponse(response), true);
      assert.equal(body.error.code, "OMNI_RUNTIME_POLICY_DENIED");
      assert.deepEqual(state.scopes, ["account-a"]);
      assert.equal(state.attempts.length, 0);
      assert.equal(state.events.filter((event) => event.startsWith("select:")).length, 1);
      assert.ok(!state.events.includes("recovered"));
    });
    test(`${specificRoute ? "provider" : "general"}/${provider}: helper policy denial remains terminal without retry or health reset`, async () => {
      state.handler = async () => {
        throw new RuntimePolicyError("entrypoint-unapproved");
      };
      const { response } = await post(specificRoute, provider);
      assert.equal(response.status, 403);
      assert.equal(isRuntimePolicyResponse(response), true);
      assert.deepEqual(state.scopes, ["account-a"]);
      assert.equal(state.attempts.length, 1);
      assert.equal(state.events.filter((event) => event.startsWith("select:")).length, 1);
      assert.ok(!state.events.includes("recovered"));
    });
  }
}
