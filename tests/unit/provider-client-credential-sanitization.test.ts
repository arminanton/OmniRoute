import test from "node:test";
import assert from "node:assert/strict";

import { projectProviderClientConnection } from "../../src/lib/providers/providerClientProjection.ts";

test("provider client projection preserves dashboard metadata but never returns credential values", () => {
  const rawApiKey = "sk-live-primary-secret-tail-1002";
  const rawAccessToken = "oauth-access-token-secret";
  const rawRefreshToken = "oauth-refresh-token-secret";
  const rawIdToken = "oauth-id-token-secret";
  const rawExtraKey = "sk-live-extra-secret-tail-2003";
  const projected = projectProviderClientConnection({
    id: "connection-1",
    provider: "codex",
    name: "primary",
    isActive: true,
    apiKey: rawApiKey,
    accessToken: rawAccessToken,
    refreshToken: rawRefreshToken,
    idToken: rawIdToken,
    providerSpecificData: {
      tag: "production",
      apiKey: "nested-api-key-secret",
      accessToken: "nested-access-token-secret",
      extraApiKeys: [rawExtraKey],
    },
  });

  assert.equal(projected.id, "connection-1");
  assert.equal(projected.apiKey, "sk-live-****1002");
  assert.equal(projected.accessToken, undefined);
  assert.equal(projected.refreshToken, undefined);
  assert.equal(projected.idToken, undefined);
  assert.deepEqual(projected.providerSpecificData, {
    tag: "production",
    extraApiKeys: ["sk-live-****2003#0"],
  });

  const serialized = JSON.stringify(projected);
  for (const secret of [
    rawApiKey,
    rawAccessToken,
    rawRefreshToken,
    rawIdToken,
    rawExtraKey,
    "nested-api-key-secret",
    "nested-access-token-secret",
  ]) {
    assert.equal(serialized.includes(secret), false, `raw credential leaked: ${secret}`);
  }

  const shortCredential = projectProviderClientConnection({
    id: "connection-short-key",
    provider: "custom",
    apiKey: "short-secret",
  });
  assert.equal(shortCredential.apiKey, "****");
  assert.equal(JSON.stringify(shortCredential).includes("short-secret"), false);
});
