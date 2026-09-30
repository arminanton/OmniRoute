import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const flags = `data:text/javascript,${encodeURIComponent(`
  export const isControlPlaneProxyDirectFallbackEnabled=()=>false;
  export const isFeatureFlagEnabled=()=>false;
`)}`;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/shared/utils/featureFlags") return { url: flags, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const originalFetch = globalThis.fetch;
let nativeSends = 0;
globalThis.fetch = async () => {
  nativeSends++;
  return new Response("native");
};
const { getOriginalFetch, runWithProxyContext } =
  await import("../../../open-sse/utils/proxyFetch.ts");
const { safeOutboundFetch } = await import("../../../src/shared/network/safeOutboundFetch.ts");
const { getRuntimePolicy } = await import("../../../src/shared/runtimePolicy.ts");
const target = "https://fixture.example.invalid/token";
const selected = { type: "http", host: "fixture-proxy.example.invalid", port: 8080 };

test.after(() => {
  globalThis.fetch = originalFetch;
  hooks.deregister();
});

test("standalone native factory captured before a scope cannot escape requireProxy", async () => {
  assert.equal(getRuntimePolicy().mode, "standalone");
  const retained = getOriginalFetch();
  await runWithProxyContext(
    selected,
    async () => {
      await assert.rejects(retained(target), { code: "PROXY_REQUIRED_EGRESS" });
      await assert.rejects(safeOutboundFetch(target, { bypassProxyPatch: true }), (error) => {
        return (
          typeof error === "object" &&
          error !== null &&
          "cause" in error &&
          (error.cause as { code?: string })?.code === "PROXY_REQUIRED_EGRESS"
        );
      });
    },
    { requireProxy: true, skipUnreachableProbe: true }
  );
  assert.equal(nativeSends, 0);
});

test("ordinary standalone native bypass behavior is retained without a required scope", async () => {
  const response = await safeOutboundFetch(target, { bypassProxyPatch: true });
  assert.equal(await response.text(), "native");
  assert.equal(nativeSends, 1);
});
