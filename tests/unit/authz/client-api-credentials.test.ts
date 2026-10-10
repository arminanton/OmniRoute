import test from "node:test";
import assert from "node:assert/strict";
import { extractClientApiCredential } from "../../../src/server/authz/clientApiCredentials.ts";

test("CLIENT_API credential precedence remains Bearer, x-api-key, x-goog-api-key, path token", () => {
  const allCredentials = new Request(
    "https://omniroute.test/api/v1/vscode/path-token/models",
    {
      headers: {
        authorization: "Bearer bearer-key",
        "x-api-key": "anthropic-key",
        "x-goog-api-key": "google-key",
      },
    }
  );
  assert.equal(extractClientApiCredential(allCredentials), "bearer-key");

  const apiAndGoogle = new Request(
    "https://omniroute.test/api/v1/vscode/path-token/models",
    { headers: { "x-api-key": "api-key", "x-goog-api-key": "google-key" } }
  );
  assert.equal(extractClientApiCredential(apiAndGoogle), "api-key");

  const googleAndPath = new Request(
    "https://omniroute.test/api/v1/vscode/path-token/models",
    { headers: { "x-goog-api-key": "google-key" } }
  );
  assert.equal(extractClientApiCredential(googleAndPath), "google-key");

  const pathOnly = new Request("https://omniroute.test/api/v1/vscode/path-token/models");
  assert.equal(extractClientApiCredential(pathOnly), "path-token");
});
