/** Real transcription route with inert auth/storage/provider edges. No network. */
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { __setMaxaiConstantsForTest } from "../../open-sse/executors/maxai/constantsStore.ts";
import { MOCK_CONSTANTS } from "./helpers/maxaiMockConstants.ts";

const routeUrl = new URL("../../src/app/api/v1/audio/transcriptions/route.ts", import.meta.url);
const handlerUrl = new URL("../../open-sse/handlers/audioTranscription.ts", import.meta.url).href;
const maxaiTranscriptionUrl = new URL(
  "../../open-sse/executors/maxai/transcription.ts",
  import.meta.url
);
const state = {
  events: [] as string[],
  connectionId: "selected",
  auth: false,
  policy: false,
  realHandler: false,
};
const key = Symbol.for("omniroute.maxai-stt-route");
Object.defineProperty(globalThis, key, { value: state, configurable: true });
const prelude = 'const s = globalThis[Symbol.for("omniroute.maxai-stt-route")];';
const accessToken = "synthetic.eyJzdWIiOiJzeW50aGV0aWMtdXNlciIsImV4cCI6NDEwMjQ0NDgwMH0.signature";
const mocks = new Map<string, string>();
const ast = ts.createSourceFile(
  "route.ts",
  readFileSync(routeUrl, "utf8"),
  ts.ScriptTarget.Latest,
  true
);
for (const statement of ast.statements) {
  if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
    continue;
  const bindings = statement.importClause?.namedBindings;
  assert.ok(bindings && ts.isNamedImports(bindings));
  mocks.set(
    statement.moduleSpecifier.text,
    bindings.elements
      .map(
        (e) =>
          `export const ${e.propertyName?.text ?? e.name.text} = () => { throw new Error("unexpected dependency"); };`
      )
      .join("\n")
  );
}
const overrides = {
  "@/shared/utils/clientApiRouteAuth": `export const enforceClientApiRouteAuth = async () => {
    s.events.push("auth"); return s.auth ? new Response(null,{status:401}) : null;
  };`,
  "@/shared/utils/apiKeyPolicy": `export const enforceApiKeyPolicy = async (_r,model) => {
    s.events.push("policy:"+model); return {rejection:s.policy?new Response(null,{status:403}):null};
  };`,
  "@/app/api/v1/_shared/audioProviderNodes":
    "export const resolveDynamicAudioProviders = async () => [];",
  "@/sse/services/auth": `export const getProviderCredentialsWithQuotaPreflight = async () => {
    s.events.push("credentials"); return {connectionId:s.connectionId, accessToken:"${accessToken}",
      providerSpecificData:{deviceId:"synthetic-device",userId:"synthetic-user"}};
  }; export const clearRecoveredProviderState = async () => {s.events.push("healthy");};`,
  "@omniroute/open-sse/services/maxaiTransport.ts": `export const runMaxaiConnectionTransport = async (id,run) => {
    s.events.push("transport:"+id); return run();
  };`,
  "@omniroute/open-sse/handlers/audioTranscription.ts": `import {handleAudioTranscription as real} from "${handlerUrl}";
    export const handleAudioTranscription = async input => {
      if (s.realHandler) return real(input);
      s.events.push("transcribe"); if (!input.signal) throw new Error("missing signal");
      return Response.json({text:"fixture"});
    };`,
  "@/domain/omnirouteResponseMeta": "export const attachOmniRouteMetaToResponse = r => r;",
  "@/shared/utils/requestId": "export const generateRequestId = () => 'id';",
  "@/app/api/v1/_shared/rateLimit": `export const isAllRateLimitedCredentials = () => false;
    export const rateLimitedProviderResponse = () => {throw new Error("unexpected");};`,
};
for (const [name, source] of Object.entries(overrides)) mocks.set(name, source);
const real = new Set([
  "@omniroute/open-sse/config/audioRegistry.ts",
  "@omniroute/open-sse/utils/error.ts",
  "@omniroute/open-sse/config/constants.ts",
  "@/shared/middleware/bodySizeGuard",
  "@/shared/runtimePolicy",
]);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === routeUrl.href && !real.has(specifier) && mocks.has(specifier)) {
      return {
        url: "data:text/javascript," + encodeURIComponent(prelude + mocks.get(specifier)),
        shortCircuit: true,
      };
    }
    if (
      context.parentURL === maxaiTranscriptionUrl.href &&
      specifier === "../../services/maxaiTransport.ts"
    ) {
      return {
        url:
          "data:text/javascript," +
          encodeURIComponent(
            "export const maxaiFetch = (url, init) => globalThis.fetch(url, init);"
          ),
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});
const route = await import("../../src/app/api/v1/audio/transcriptions/route.ts");
function request() {
  const data = new FormData();
  data.set("model", "maxai/speech-to-text");
  data.set(
    "file",
    new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0])], { type: "audio/webm" }),
    "audio.webm"
  );
  return new Request("http://localhost/api/v1/audio/transcriptions", {
    method: "POST",
    body: data,
  });
}
test.beforeEach(() => {
  state.events = [];
  state.connectionId = "selected";
  state.auth = false;
  state.policy = false;
  state.realHandler = false;
});
test.after(() => {
  hooks.deregister();
  Reflect.deleteProperty(globalThis, key);
});
test("selected account transport surrounds transcription, then health recovery", async () => {
  const response = await route.POST(request());
  assert.equal(response.status, 200);
  assert.deepEqual(state.events, [
    "auth",
    "policy:maxai/speech-to-text",
    "policy:maxai/speech-to-text",
    "credentials",
    "transport:selected",
    "transcribe",
    "healthy",
  ]);
});
test("no connection never falls through to direct transcription", async () => {
  state.connectionId = "";
  const response = await route.POST(request());
  assert.equal(response.status, 400);
  assert.equal(state.events.includes("transcribe"), false);
  assert.equal(state.events.includes("healthy"), false);
});
test("auth and model policy reject before provider selection", async () => {
  state.auth = true;
  assert.equal((await route.POST(request())).status, 401);
  assert.deepEqual(state.events, ["auth"]);
  state.auth = false;
  state.policy = true;
  state.events = [];
  assert.equal((await route.POST(request())).status, 403);
  assert.equal(state.events.includes("credentials"), false);
});
test("pre-abort cannot enter the selected transport", async () => {
  const controller = new AbortController();
  controller.abort("secret");
  const aborted = new Request(request(), { signal: controller.signal });
  const response = await route.POST(aborted);
  assert.equal(response.status, 499);
  assert.deepEqual(state.events, ["auth"]);
});
test("MaxAI upstream failure preserves safe status/message without leaking upstream details", async () => {
  state.realHandler = true;
  const originalFetch = globalThis.fetch;
  const upstreamBody = [
    "Authorization: Bearer " + accessToken,
    "https://api.maxai.me/private?access_token=" + accessToken,
    "Error: private upstream failure",
    "    at transcribe (/srv/maxai/private/worker.js:12:34)",
  ].join("\n");
  let fetchCalls = 0;
  __setMaxaiConstantsForTest(MOCK_CONSTANTS);
  globalThis.fetch = async (url, init) => {
    fetchCalls++;
    assert.equal(String(url), "https://api.maxai.me/gpt/speech_to_text");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer " + accessToken);
    const form = init?.body;
    assert.ok(form instanceof FormData);
    const file = form.get("audio_file") as File;
    assert.ok(file instanceof Blob);
    assert.equal(file.type, "audio/webm");
    assert.equal(file.name, "audio.webm");
    assert.deepEqual(
      Array.from(new Uint8Array(await file.arrayBuffer())).slice(0, 4),
      [0x1a, 0x45, 0xdf, 0xa3]
    );
    return new Response(upstreamBody, { status: 429 });
  };
  try {
    const response = await route.POST(request());
    const body = await response.text();
    assert.equal(fetchCalls, 1);
    assert.equal(response.status, 429);
    assert.equal(
      response.headers.get("Access-Control-Allow-Methods"),
      "GET, POST, PUT, DELETE, PATCH, OPTIONS"
    );
    assert.equal(
      response.headers.get("Access-Control-Allow-Headers"),
      "Content-Type, Authorization, x-api-key, anthropic-version, x-omniroute-connection, x-internal-test, accept"
    );
    assert.ok(response.status >= 400 && response.status <= 599);
    assert.deepEqual(JSON.parse(body), {
      error: { message: "MaxAI transcription rejected", code: 429 },
    });
    for (const leak of [
      upstreamBody,
      accessToken,
      "https://api.maxai.me/private",
      "/srv/maxai/private/worker.js",
      "private upstream failure",
    ])
      assert.equal(body.includes(leak), false, `response leaked ${leak}`);
    assert.equal(state.events.includes("healthy"), false);
  } finally {
    globalThis.fetch = originalFetch;
    __setMaxaiConstantsForTest(null);
  }
});
