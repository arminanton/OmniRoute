import test from "node:test";
import assert from "node:assert/strict";

import { buildProviderHeaders } from "../../open-sse/services/provider.ts";
import { POST as send } from "../../src/app/api/translator/send/route.ts";
import { POST as translate } from "../../src/app/api/translator/translate/route.ts";

const fakeBody = { model: "upstage/solar-pro4:free", messages: [{ role: "user", content: "Hi" }] };
const originalFetch = globalThis.fetch;
test.after(() => {
  globalThis.fetch = originalFetch;
});

test("generic header builder cannot mint a Nous OAuth bearer from an API key or access token", () => {
  for (const provider of ["nous-oauth", "nso"]) {
    assert.throws(
      () =>
        buildProviderHeaders(provider, { apiKey: "test-key", accessToken: "test-access" }, true),
      /dedicated inference executor/
    );
  }
  // The established API-key provider still uses its own path.
  assert.match(
    buildProviderHeaders("nous", { apiKey: "local-api-key" }).Authorization,
    /local-api-key/
  );
});

test("generic translator send and preview reject Nous OAuth before querying connections or sending", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("must not fetch");
  };
  for (const provider of ["nous-oauth", "nso"]) {
    const sendResponse = await send(
      new Request("http://localhost/api/translator/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, body: fakeBody }),
      })
    );
    assert.equal(sendResponse.status, 400);
    assert.match(JSON.stringify(await sendResponse.json()), /dedicated chat inference route/);
    const previewResponse = await translate(
      new Request("http://localhost/api/translator/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, step: 4, body: fakeBody }),
      })
    );
    assert.equal(previewResponse.status, 400);
    assert.doesNotMatch(JSON.stringify(await previewResponse.json()), /test-key|test-access/);
  }
  assert.equal(calls, 0);
});
