import assert from "node:assert/strict";
import test from "node:test";

import { redactProviderRequestPreview } from "../../src/lib/translator/previewRedaction.ts";

test("translator request preview redacts credentials in URLs and headers but keeps protocol metadata", () => {
  const apiKey = "sk-translator-preview-secret";
  const accessToken = "oauth-access-token-secret";
  const customCredential = "custom-provider-credential-secret";
  const preview = redactProviderRequestPreview(
    `https://user:password-secret@provider.example/v1?api_key=${apiKey}&region=west&session_id=${accessToken}`,
    {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: `Bearer ${apiKey}`,
      "x-api-key": apiKey,
      "X-Provider-Credential": customCredential,
      "x-request-id": "request-123",
    },
    {
      apiKey,
      accessToken,
      providerSpecificData: { customCredential },
    }
  );

  const serialized = JSON.stringify(preview);
  for (const secret of [apiKey, accessToken, customCredential, "password-secret"]) {
    assert.equal(serialized.includes(secret), false, `preview must not expose ${secret}`);
  }

  assert.equal(preview.headers["Content-Type"], "application/json");
  assert.equal(preview.headers.Accept, "text/event-stream");
  assert.equal(preview.headers.Authorization, "Bearer [REDACTED]");
  assert.equal(preview.headers["x-api-key"], "[REDACTED]");
  assert.equal(preview.headers["X-Provider-Credential"], "[REDACTED]");
  assert.equal(preview.headers["x-request-id"], "request-123");

  const safeUrl = new URL(preview.url);
  assert.equal(safeUrl.searchParams.get("api_key"), "[REDACTED]");
  assert.equal(safeUrl.searchParams.get("region"), "west");
  assert.equal(safeUrl.searchParams.get("session_id"), "[REDACTED]");
  assert.equal(safeUrl.username.includes("user"), false);
  assert.equal(safeUrl.password.includes("password-secret"), false);
});
