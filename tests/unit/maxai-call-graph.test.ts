import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  checkAndRefreshToken,
  getAccessToken,
  refreshAccessToken,
  refreshTokenByProvider,
} from "../../src/sse/services/tokenRefresh.ts";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

test("generic MaxAI refresh wrappers never send or claim a rotated credential", async () => {
  let sends = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    sends++;
    throw new Error("unsafe");
  };
  const stale = {
    connectionId: "mock-connection",
    accessToken: "stale",
    refreshToken: "mock-refresh",
    expiresAt: "2000-01-01T00:00:00Z",
  };
  try {
    for (const provider of ["maxai", "mx"]) {
      assert.deepEqual(await checkAndRefreshToken(provider, stale), stale);
      assert.equal(await getAccessToken(provider, stale), null);
      assert.equal(await refreshAccessToken(provider, "mock-refresh", stale), null);
      assert.equal(await refreshTokenByProvider(provider, stale), null);
    }
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(sends, 0);
});

test("all MaxAI signed entry points use the bound transport and unified coordinator", () => {
  for (const path of [
    "open-sse/executors/maxai.ts",
    "open-sse/services/maxaiModels.ts",
    "open-sse/handlers/imageGeneration/providers/maxaiImage.ts",
  ]) {
    const source = read(path);
    assert.match(source, /runMaxaiConnectionTransport/);
    assert.match(source, /ensureFreshMaxaiCredential/);
    assert.match(source, /maxaiFetch/);
    assert.doesNotMatch(source, /await fetch\(/);
    assert.doesNotMatch(source, /maxaiRefreshAccessToken\(/);
  }
  for (const path of [
    "src/app/api/v1/images/generations/route.ts",
    "src/app/api/v1/providers/[provider]/images/generations/route.ts",
  ]) {
    const source = read(path);
    assert.match(source, /runMaxaiConnectionTransport/);
    assert.match(source, /attemptCredentials.connectionId/);
  }
  const models = read("src/app/api/providers/[id]/models/route.ts");
  const branch = models.slice(
    models.indexOf('if (provider === "maxai"'),
    models.indexOf("const conolResponse")
  );
  assert.doesNotMatch(branch, /safeOutboundFetch|proxyConfig:/);
  assert.match(read("src/sse/handlers/chatHelpers.ts"), /wasMaxaiTlsUsed/);
});
