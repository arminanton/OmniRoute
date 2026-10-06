import assert from "node:assert/strict";
import { test } from "node:test";
import { dispatchControlPlane } from "../../open-sse/services/controlPlaneRuntime.ts";
import {
  resolveAntigravityCliVersion,
  resolveAntigravityIdeVersion,
  getCachedAntigravityCliVersion,
  getCachedAntigravityIdeVersion,
} from "../../open-sse/services/antigravityVersion.ts";

test("absentserver bridge never invokes metadata and browser fingerprints stay usable", async () => {
  let calls = 0;
  const fetch = async () => {
    calls++;
    return new Response('{"tag_name":"v99.0.0"}');
  };
  assert.throws(
    () =>
      dispatchControlPlane(() => {
        calls++;
      }),
    /not initialized/
  );
  assert.equal(await resolveAntigravityCliVersion(fetch as typeof globalThis.fetch), "1.2.16");
  assert.equal(await resolveAntigravityIdeVersion(fetch as typeof globalThis.fetch), "2.5.5");
  assert.equal(getCachedAntigravityCliVersion(), "1.2.16");
  assert.equal(getCachedAntigravityIdeVersion(), "2.5.5");
  assert.equal(calls, 0);
});
