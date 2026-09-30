/** Real transcription route with inert auth/storage/provider edges. No network. */
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import ts from "typescript";

const routeUrl = new URL("../../src/app/api/v1/audio/transcriptions/route.ts", import.meta.url);
const state = { events: [] as string[], connectionId: "selected", auth: false, policy: false };
const key = Symbol.for("omniroute.maxai-stt-route");
Object.defineProperty(globalThis, key, { value: state, configurable: true });
const prelude = 'const s = globalThis[Symbol.for("omniroute.maxai-stt-route")];';
const mocks = new Map<string, string>();
const ast = ts.createSourceFile("route.ts", readFileSync(routeUrl, "utf8"), ts.ScriptTarget.Latest, true);
for (const statement of ast.statements) {
  if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
  const bindings = statement.importClause?.namedBindings;
  assert.ok(bindings && ts.isNamedImports(bindings));
  mocks.set(statement.moduleSpecifier.text, bindings.elements.map((e) =>
    `export const ${e.propertyName?.text ?? e.name.text} = () => { throw new Error("unexpected dependency"); };`
  ).join("\n"));
}
const overrides = {
  "@/shared/utils/clientApiRouteAuth": `export const enforceClientApiRouteAuth = async () => {
    s.events.push("auth"); return s.auth ? new Response(null,{status:401}) : null;
  };`,
  "@/shared/utils/apiKeyPolicy": `export const enforceApiKeyPolicy = async (_r,model) => {
    s.events.push("policy:"+model); return {rejection:s.policy?new Response(null,{status:403}):null};
  };`,
  "@/app/api/v1/_shared/audioProviderNodes": "export const resolveDynamicAudioProviders = async () => [];",
  "@/sse/services/auth": `export const getProviderCredentialsWithQuotaPreflight = async () => {
    s.events.push("credentials"); return {connectionId:s.connectionId, accessToken:"synthetic"};
  }; export const clearRecoveredProviderState = async () => {s.events.push("healthy");};`,
  "@omniroute/open-sse/services/maxaiTransport.ts": `export const runMaxaiConnectionTransport = async (id,run) => {
    s.events.push("transport:"+id); return run();
  };`,
  "@omniroute/open-sse/handlers/audioTranscription.ts": `export const handleAudioTranscription = async input => {
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
  "@omniroute/open-sse/config/audioRegistry.ts", "@omniroute/open-sse/utils/error.ts",
  "@omniroute/open-sse/config/constants.ts", "@/shared/middleware/bodySizeGuard",
  "@/shared/runtimePolicy",
]);
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL === routeUrl.href && !real.has(specifier) && mocks.has(specifier)) {
    return {url:"data:text/javascript,"+encodeURIComponent(prelude+mocks.get(specifier)),shortCircuit:true};
  }
  return nextResolve(specifier, context);
} });
const route = await import("../../src/app/api/v1/audio/transcriptions/route.ts");
function request() {
  const data = new FormData(); data.set("model", "maxai/speech-to-text");
  data.set("file", new Blob(["synthetic"], {type:"audio/webm"}), "audio.webm");
  return new Request("http://localhost/api/v1/audio/transcriptions", {method:"POST",body:data});
}
test.beforeEach(() => {state.events=[];state.connectionId="selected";state.auth=false;state.policy=false;});
test.after(() => {hooks.deregister();Reflect.deleteProperty(globalThis,key);});
test("selected account transport surrounds transcription, then health recovery", async () => {
  const response = await route.POST(request()); assert.equal(response.status,200);
  assert.deepEqual(state.events, ["auth","policy:maxai/speech-to-text","policy:maxai/speech-to-text",
    "credentials","transport:selected","transcribe","healthy"]);
});
test("no connection never falls through to direct transcription", async () => {
  state.connectionId=""; const response=await route.POST(request()); assert.equal(response.status,400);
  assert.equal(state.events.includes("transcribe"),false);assert.equal(state.events.includes("healthy"),false);
});
test("auth and model policy reject before provider selection", async () => {
  state.auth=true;assert.equal((await route.POST(request())).status,401);assert.deepEqual(state.events,["auth"]);
  state.auth=false;state.policy=true;state.events=[];
  assert.equal((await route.POST(request())).status,403);assert.equal(state.events.includes("credentials"),false);
});
test("pre-abort cannot enter the selected transport", async () => {
  const controller=new AbortController();controller.abort("secret");
  const aborted = new Request(request(), { signal: controller.signal });
  const response=await route.POST(aborted);
  assert.equal(response.status,499);assert.deepEqual(state.events,["auth"]);
});
