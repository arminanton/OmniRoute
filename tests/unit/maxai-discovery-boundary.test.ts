import test from "node:test";
import assert from "node:assert/strict";
import { discoverMaxaiModels, MaxaiDiscoveryError, MAXAI_REGISTRY_MODELS } from "../../open-sse/services/maxaiModels.ts";
import { checkMaxaiConnection } from "../../open-sse/services/maxaiConnectionCheck.ts";
import { __setMaxaiConstantsForTest } from "../../open-sse/executors/maxai/constantsStore.ts";
import { MOCK_CONSTANTS } from "./helpers/maxaiMockConstants.ts";
import { RuntimePolicyError } from "../../src/shared/runtimePolicy.ts";
import type { EnsureFreshMaxaiCredentialInput } from "../../open-sse/executors/maxai/refresh.ts";

const input = {connectionId:"selected",accessToken:"synthetic",providerSpecificData:{maxaiDeviceId:"device",maxaiUserId:"user"}};
const deps = {
  runTransport: async <T>(_id: string, run: () => Promise<T>) => run(),
  ensureCredential: async ({credential}: EnsureFreshMaxaiCredentialInput) => credential,
};
test.beforeEach(() => __setMaxaiConstantsForTest(MOCK_CONSTANTS));
test.after(() => __setMaxaiConstantsForTest(null));
test("connection checks are explicitly neutral, never public-catalog login proof", () => {
  const result=checkMaxaiConnection();
  assert.equal(result.valid,false);assert.equal(result.unverified,true);
  assert.equal(result.unsupported,true);
  assert.equal(result.inconclusive,true);assert.equal(result.code,"maxai_verification_unavailable");
});
test("live discovery preserves selected identity, signing and successful model mapping", async () => {
  const model=MAXAI_REGISTRY_MODELS[0].id; let calls=0;
  const result=await discoverMaxaiModels({...input,fetchImpl:async(url,init)=>{
    calls++;assert.equal(String(url),"https://api.maxai.me/models/get_config");
    assert.equal(init?.method,"POST");assert.equal(init?.redirect,"error");
    assert.equal(new Headers(init?.headers).get("authorization"),"Bearer synthetic");
    return Response.json({data:{chat_models:[{model_name:model,max_tokens:12345}]}});
  }},deps);
  assert.equal(result.models[0].inputTokenLimit,12345);assert.equal(calls,1);
});
test("stalled body cancellation releases the transport owner and no error reason leaks", async () => {
  const controller=new AbortController();let owned=0;let cancelled=false;
  const result=discoverMaxaiModels({...input,signal:controller.signal,fetchImpl:async()=>{
    const body=new ReadableStream<Uint8Array>({pull(){controller.abort("SECRET at /private");},cancel(){cancelled=true;}});
    return new Response(body);
  }},{...deps,runTransport:async(_id,run)=>{owned++;try{return await run();}finally{owned--;}}});
  await assert.rejects(result,(error: unknown)=>error instanceof MaxaiDiscoveryError && error.code==="aborted" && !error.message.includes("SECRET"));
  assert.equal(owned,0);assert.equal(cancelled,true);
});
test("HTTP failures remain finite and never become successful catalog results", async () => {
  for(const status of [401,403,429,500]) {
    await assert.rejects(discoverMaxaiModels({...input,fetchImpl:async()=>new Response("SECRET",{status})},deps),
      (error: unknown)=>error instanceof MaxaiDiscoveryError && error.code==="rejected" && !error.message.includes("SECRET"));
  }
});
test("policy identity survives discovery without retry",async()=>{
  const error=new RuntimePolicyError("proxy-forbidden");let calls=0;
  await assert.rejects(discoverMaxaiModels({...input,fetchImpl:async()=>{calls++;throw error;}},deps),e=>e===error);
  assert.equal(calls,1);
});
