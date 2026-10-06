/**
 * Bulk Web-Session Import — Unit Tests (PR6 of issue #3368)
 *
 * Run: node --import tsx/esm --test tests/unit/bulk-web-session-import.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { POST } from "../../src/app/api/providers/bulk-web-session/route.ts";
import {
  createProviderConnection,
  getProviderConnectionById,
  getProviderConnections,
} from "../../src/lib/db/providers.ts";
import { deleteProviderConnection } from "../../src/lib/db/providers/deletion.ts";
import { bulkWebSessionImportSchema } from "../../src/shared/validation/schemas.ts";
import {
  requiresWebSessionCredential,
  getWebSessionCredentialRequirement,
  canUpdateProviderApiKey,
  hasUsableWebSessionCredential,
  resolveWebSessionImportApiKey,
} from "../../src/shared/providers/webSessionCredentials.ts";

describe("bulkWebSessionImportSchema", () => {
  it("accepts valid input with single entry", () => {
    const result = bulkWebSessionImportSchema.safeParse({
      provider: "perplexity-web",
      entries: [{ name: "Account 1", credential: "__Secure-next-auth.session-token=abc123" }],
    });
    assert.equal(result.success, true);
  });

  it("accepts valid input with multiple entries", () => {
    const result = bulkWebSessionImportSchema.safeParse({
      provider: "grok-web",
      entries: [
        { name: "Account 1", credential: "sso=abc; sso-rw=def" },
        { name: "Account 2", credential: "sso=ghi; sso-rw=jkl" },
        { name: "Account 3", credential: "sso=mno; sso-rw=pqr" },
      ],
      priority: 5,
    });
    assert.equal(result.success, true);
  });

  it("accepts optional globalPriority as null", () => {
    const result = bulkWebSessionImportSchema.safeParse({
      provider: "claude-web",
      entries: [{ name: "A1", credential: "sessionKey=xyz" }],
      globalPriority: null,
    });
    assert.equal(result.success, true);
  });

  it("rejects empty entries array", () => {
    const result = bulkWebSessionImportSchema.safeParse({
      provider: "perplexity-web",
      entries: [],
    });
    assert.equal(result.success, false);
  });

  it("rejects more than 50 entries", () => {
    const entries = Array.from({ length: 51 }, (_, i) => ({
      name: `Account ${i}`,
      credential: "cookie=value",
    }));
    const result = bulkWebSessionImportSchema.safeParse({
      provider: "perplexity-web",
      entries,
    });
    assert.equal(result.success, false);
  });

  it("rejects entry with empty credential", () => {
    const result = bulkWebSessionImportSchema.safeParse({
      provider: "perplexity-web",
      entries: [{ name: "Account 1", credential: "" }],
    });
    assert.equal(result.success, false);
  });

  it("rejects entry with empty name", () => {
    const result = bulkWebSessionImportSchema.safeParse({
      provider: "perplexity-web",
      entries: [{ name: "", credential: "cookie=value" }],
    });
    assert.equal(result.success, false);
  });

  it("rejects missing provider", () => {
    const result = bulkWebSessionImportSchema.safeParse({
      entries: [{ name: "A1", credential: "cookie=value" }],
    });
    assert.equal(result.success, false);
  });

  it("rejects priority out of range", () => {
    const result = bulkWebSessionImportSchema.safeParse({
      provider: "perplexity-web",
      entries: [{ name: "A1", credential: "cookie=value" }],
      priority: 0,
    });
    assert.equal(result.success, false);

    const result2 = bulkWebSessionImportSchema.safeParse({
      provider: "perplexity-web",
      entries: [{ name: "A1", credential: "cookie=value" }],
      priority: 101,
    });
    assert.equal(result2.success, false);
  });

  it("accepts exactly 50 entries (boundary)", () => {
    const entries = Array.from({ length: 50 }, (_, i) => ({
      name: `Account ${i}`,
      credential: "cookie=value",
    }));
    const result = bulkWebSessionImportSchema.safeParse({
      provider: "perplexity-web",
      entries,
    });
    assert.equal(result.success, true);
  });
});

describe("web-session credential helpers", () => {
  it("requiresWebSessionCredential returns true for web-cookie providers", () => {
    assert.equal(requiresWebSessionCredential("perplexity-web"), true);
    assert.equal(requiresWebSessionCredential("grok-web"), true);
    assert.equal(requiresWebSessionCredential("claude-web"), true);
    assert.equal(requiresWebSessionCredential("deepseek-web"), true);
  });

  it("requiresWebSessionCredential returns false for non-web providers", () => {
    assert.equal(requiresWebSessionCredential("openai"), false);
    assert.equal(requiresWebSessionCredential("anthropic"), false);
    assert.equal(requiresWebSessionCredential("nonexistent"), false);
  });

  it("getWebSessionCredentialRequirement returns correct kind for cookie providers", () => {
    const req = getWebSessionCredentialRequirement("perplexity-web");
    assert.ok(req);
    assert.equal(req.kind, "cookie");
  });

  it("getWebSessionCredentialRequirement returns correct kind for token providers", () => {
    const req = getWebSessionCredentialRequirement("deepseek-web");
    assert.ok(req);
    assert.equal(req.kind, "token");
  });

  it("hasUsableWebSessionCredential validates cookie data correctly", () => {
    assert.equal(
      hasUsableWebSessionCredential("perplexity-web", {
        cookie: "__Secure-next-auth.session-token=abc",
      }),
      true
    );
    assert.equal(hasUsableWebSessionCredential("perplexity-web", { cookie: "" }), false);
    assert.equal(hasUsableWebSessionCredential("perplexity-web", {}), false);
  });

  it("hasUsableWebSessionCredential validates token data correctly", () => {
    assert.equal(hasUsableWebSessionCredential("deepseek-web", { token: "my-token" }), true);
    assert.equal(hasUsableWebSessionCredential("deepseek-web", { token: "   " }), false);
  });
});

describe("canUpdateProviderApiKey", () => {
  it("preserves normal API-key credential updates", () => {
    assert.equal(canUpdateProviderApiKey("apikey", "openai"), true);
  });

  it("allows token-kind web sessions stored with cookie authType", () => {
    assert.equal(canUpdateProviderApiKey("cookie", "deepseek-web"), true);
    assert.equal(canUpdateProviderApiKey("cookie", "zai-web"), true);
  });

  it("does not allow cookie-kind web sessions to update apiKey", () => {
    assert.equal(canUpdateProviderApiKey("cookie", "perplexity-web"), false);
    assert.equal(canUpdateProviderApiKey("cookie", "claude-web"), false);
  });

  it("does not broaden non-cookie auth types", () => {
    assert.equal(canUpdateProviderApiKey("oauth", "deepseek-web"), false);
    assert.equal(canUpdateProviderApiKey(null, "deepseek-web"), false);
  });
});

describe("resolveWebSessionImportApiKey (token-kind imports must populate apiKey)", () => {
  // Regression: the bulk web-session import stored token-kind credentials
  // (deepseek-web, copilot-web, t3-chat-web, …) only in providerSpecificData and
  // left apiKey null. Both the connection validator (validateDeepSeekWebProvider)
  // and the executor (extractUserToken → credentials.apiKey) read the token from
  // apiKey, so imported token-kind connections were never recognized. Token-kind
  // must resolve the credential into apiKey; cookie-kind keeps apiKey null (those
  // executors read providerSpecificData.cookie).
  it("returns the credential for a token-kind provider (deepseek-web)", () => {
    const req = getWebSessionCredentialRequirement("deepseek-web");
    assert.equal(
      resolveWebSessionImportApiKey(req, "j9CVFGvd8Y/deadbeeftoken"),
      "j9CVFGvd8Y/deadbeeftoken"
    );
  });

  it("preserves a JSON-wrapped userToken verbatim (extractUserToken unwraps it later)", () => {
    const req = getWebSessionCredentialRequirement("deepseek-web");
    const blob = '{"value":"abc123","__version":"0"}';
    assert.equal(resolveWebSessionImportApiKey(req, blob), blob);
  });

  it("returns null for cookie-kind providers (they read providerSpecificData.cookie)", () => {
    assert.equal(
      resolveWebSessionImportApiKey(
        getWebSessionCredentialRequirement("claude-web"),
        "sessionKey=abc"
      ),
      null
    );
    assert.equal(
      resolveWebSessionImportApiKey(
        getWebSessionCredentialRequirement("perplexity-web"),
        "__Secure-next-auth.session-token=abc"
      ),
      null
    );
  });

  it("returns null for a whitespace-only or missing credential", () => {
    const req = getWebSessionCredentialRequirement("deepseek-web");
    assert.equal(resolveWebSessionImportApiKey(req, "   "), null);
    assert.equal(resolveWebSessionImportApiKey(null, "anything"), null);
  });

  it("trims surrounding whitespace from the stored token", () => {
    const req = getWebSessionCredentialRequirement("copilot-web");
    assert.equal(resolveWebSessionImportApiKey(req, "  tok-123  "), "tok-123");
  });
});

describe("bulk web-session route cookie-name conflicts", () => {
  it("rejects different credentials without overwriting and updates the same session in place", async () => {
    const provider = "perplexity-web";
    const name = `cookie-conflict-${randomUUID()}`;
    const partialName = `${name}-partial`;
    const credentialA = `__Secure-next-auth.session-token=session-a-${randomUUID()}`;
    const credentialB = `__Secure-next-auth.session-token=session-b-${randomUUID()}`;
    const credentialC = `__Secure-next-auth.session-token=session-c-${randomUUID()}`;
    const createdIds = new Set<string>();
    const send = (entries: Array<{ name: string; credential: string }>, priority = 1) =>
      POST(
        new Request("http://localhost/api/providers/bulk-web-session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider, entries, priority }),
        })
      );

    try {
      const initialResponse = await send([{ name, credential: credentialA }]);
      const initialBody = await initialResponse.json();
      for (const created of initialBody.created || []) {
        if (typeof created.id === "string") createdIds.add(created.id);
      }
      assert.equal(initialResponse.status, 200);
      assert.equal(initialBody.success, 1);
      assert.equal(initialBody.failed, 0);
      const originalId = initialBody.created[0].id as string;

      const original = await getProviderConnectionById(originalId);
      assert.ok(original);
      const originalState = {
        id: original.id,
        name: original.name,
        apiKey: original.apiKey,
        providerSpecificData: original.providerSpecificData,
        priority: original.priority,
      };

      const conflictResponse = await send(
        [
          { name, credential: credentialB },
          { name: partialName, credential: credentialC },
        ],
        4
      );
      assert.equal(conflictResponse.status, 200);
      const conflictBody = await conflictResponse.json();
      for (const created of conflictBody.created || []) {
        if (typeof created.id === "string") createdIds.add(created.id);
      }
      assert.equal(conflictBody.success, 1);
      assert.equal(conflictBody.failed, 1);
      assert.equal(conflictBody.total, 2);
      assert.equal(conflictBody.errors[0].index, 0);
      assert.equal(conflictBody.errors[0].name, name);
      assert.equal(conflictBody.errors[0].message, "Provider connection name already in use");
      assert.equal(JSON.stringify(conflictBody.errors).includes(credentialB), false);

      const unchanged = await getProviderConnectionById(originalId);
      assert.ok(unchanged);
      assert.deepEqual(
        {
          id: unchanged.id,
          name: unchanged.name,
          apiKey: unchanged.apiKey,
          providerSpecificData: unchanged.providerSpecificData,
          priority: unchanged.priority,
        },
        originalState
      );

      const updateResponse = await send([{ name, credential: credentialA }], 7);
      assert.equal(updateResponse.status, 200);
      const updateBody = await updateResponse.json();
      assert.equal(updateBody.success, 1);
      assert.equal(updateBody.failed, 0);
      assert.equal(updateBody.created[0].id, originalId);

      const updated = await getProviderConnectionById(originalId);
      assert.ok(updated);
      assert.equal(updated.priority, 7);
      assert.deepEqual(updated.providerSpecificData, originalState.providerSpecificData);
      const sameNameRows = (await getProviderConnections({ provider, authType: "cookie" })).filter(
        (connection) => connection.name === name
      );
      assert.equal(sameNameRows.length, 1);

      const rotated = await createProviderConnection({
        provider,
        authType: "cookie",
        name,
        apiKey: null,
        priority: 8,
        providerSpecificData: { cookie: credentialB },
        isActive: true,
      });
      assert.ok(rotated);
      assert.equal(rotated.id, originalId);
      const rotatedConnection = await getProviderConnectionById(originalId);
      const rotatedData = rotatedConnection?.providerSpecificData as
        Record<string, unknown> | undefined;
      assert.equal(rotatedData?.cookie, credentialB);
    } finally {
      for (const id of createdIds) await deleteProviderConnection(id);
    }
  });
});
