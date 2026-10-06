import "../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { antigravity } from "../../src/lib/oauth/providers/antigravity.ts";
import { agy } from "../../src/lib/oauth/providers/agy.ts";
import {
  enrichWithAntigravityBackend,
  createConnectionFromAgyToken,
} from "../../src/lib/oauth/utils/agyAuthImport.ts";
import {
  verifiedGoogleQuotaFields,
  mergeGoogleQuotaFields,
} from "../../src/lib/oauth/googleQuotaIdentity.ts";
import { resolveQuotaIdentity } from "../../open-sse/services/quotaIdentity.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";
import { persistOAuthConnection } from "../../src/lib/oauth/connectionPersistence.ts";
import { createProviderConnection } from "../../src/lib/db/providers.ts";
after(() => resetDbInstance());

async function nativeFixture<T>(
  operation: () => Promise<T>,
  id: string | null = "123456789",
  project = "server-project"
) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("userinfo"))
      return new Response(
        JSON.stringify({ email: "fixture@example.invalid", ...(id ? { id } : {}) }),
        { status: 200 }
      );
    if (url.includes("loadCodeAssist"))
      return new Response(
        JSON.stringify({ cloudaicompanionProject: project, currentTier: { id: "standard-tier" } }),
        { status: 200 }
      );
    if (url.includes("onboardUser"))
      return new Response(JSON.stringify({ done: true }), { status: 200 });
    throw new Error("unexpected fixture endpoint");
  };
  try {
    return await operation();
  } finally {
    globalThis.fetch = original;
  }
}
const key = (provider: string, data: unknown) =>
  resolveQuotaIdentity(provider, "different-row-" + provider, {
    providerSpecificData: {
      projectId: (data as Record<string, unknown>).quotaProjectId,
      ...(data as Record<string, unknown>),
    },
  });

test("actualIDE andCLI OAuth200 flows retain same verified account/project admission identity", async () => {
  const credentials = [];
  for (const provider of [antigravity, agy]) {
    credentials.push(
      await nativeFixture(async () => {
        const tokens = { access_token: "fixture", refresh_token: "fixture-refresh" };
        const extra = await provider.postExchange(tokens as never);
        return provider.mapTokens(tokens as never, extra);
      })
    );
  }
  assert.equal(
    key("antigravity", credentials[0].providerSpecificData),
    key("agy", credentials[1].providerSpecificData)
  );
  assert.equal(credentials[0].providerSpecificData.quotaAccountId, "123456789");
  assert.equal(credentials[0].providerSpecificData.quotaProjectId, "server-project");
  assert.equal(credentials[0].providerSpecificData.quotaIdentityVerified, true);
});

test("actualCLI token enrichment uses nativeuserinfo ID not importedemail/JWT/project", async () => {
  const enriched = await nativeFixture(() =>
    enrichWithAntigravityBackend({
      accessToken: "fixture",
      refreshToken: "fixture-refresh",
      tokenType: "Bearer",
      expiresAt: null,
      authMethod: null,
    })
  );
  assert.equal(enriched.verifiedQuotaIdentity?.quotaAccountId, "123456789");
  assert.equal(
    key("agy", enriched.verifiedQuotaIdentity),
    key("antigravity", verifiedGoogleQuotaFields({ id: "123456789" }, "server-project"))
  );
});

test("differentnativeIDs/projects partition; missingnativeproof fallsback to row", async () => {
  const a = verifiedGoogleQuotaFields({ id: "123456789" }, "project-a");
  assert.notEqual(
    key("agy", a),
    key("agy", verifiedGoogleQuotaFields({ id: "987654321" }, "project-a"))
  );
  assert.notEqual(
    key("agy", a),
    key("agy", verifiedGoogleQuotaFields({ id: "123456789" }, "project-b"))
  );
  const data = await nativeFixture(
    async () =>
      agy.mapTokens(
        { access_token: "fixture" } as never,
        await agy.postExchange({ access_token: "fixture" } as never)
      ),
    null
  );
  assert.equal(key("agy", data.providerSpecificData), "agy:different-row-agy");
  assert.deepEqual(
    verifiedGoogleQuotaFields({ email: "same", sub: "unverified" }, "manual-project"),
    {}
  );
  assert.deepEqual(verifiedGoogleQuotaFields({ id: "x".repeat(129) }, "project"), {});
});

test("replacement preservesoperator group/realm and revokes staleautomaticproof withoutnewnativeidentity", async () => {
  const original = verifiedGoogleQuotaFields({ id: "123456789" }, "project-a");
  const preserved = mergeGoogleQuotaFields(
    { ...original, quotaGroup: "operator-group", quotaRealm: "operator-realm" },
    verifiedGoogleQuotaFields({ id: "987654321" }, "project-b")
  );
  assert.equal(preserved.quotaGroup, "operator-group");
  assert.equal(preserved.quotaRealm, "operator-realm");
  assert.equal(preserved.quotaAccountId, "987654321");
  const revoked = mergeGoogleQuotaFields(original, {});
  assert.equal(revoked.quotaAccountId, undefined);
  assert.equal(revoked.quotaIdentityVerified, undefined);
  const existing = await createProviderConnection({
    provider: "agy",
    name: "fixture",
    authType: "oauth",
    email: "fixture@example.invalid",
    accessToken: "fixture-old",
    providerSpecificData: { quotaGroup: "chosen", quotaRealm: "chosen-realm" },
  });
  assert.ok(existing);
  const enriched = await nativeFixture(() =>
    enrichWithAntigravityBackend({
      accessToken: "fixture",
      refreshToken: "fixture-refresh",
      tokenType: "Bearer",
      expiresAt: null,
      authMethod: null,
    })
  );
  const result = await createConnectionFromAgyToken(enriched, { overwriteExisting: true });
  const persisted = result.connection.providerSpecificData as Record<string, unknown>;
  assert.equal(persisted.quotaGroup, "chosen");
  assert.equal(persisted.quotaRealm, "chosen-realm");
  assert.equal(persisted.quotaAccountId, "123456789");
});

test("dashboard persistence also retains explicit operator realm during native reauthentication", async () => {
  const existing = await createProviderConnection({
    provider: "antigravity",
    name: "fixtureIDE",
    authType: "oauth",
    email: "ide@example.invalid",
    accessToken: "fixture-old",
    providerSpecificData: { quotaGroup: "ide-group", quotaRealm: "ide-realm" },
  });
  assert.ok(existing);
  const tokenData = await nativeFixture(async () =>
    antigravity.mapTokens(
      { access_token: "fixture", refresh_token: "fixture-refresh" } as never,
      await antigravity.postExchange({ access_token: "fixture" } as never)
    )
  );
  const saved = await persistOAuthConnection("antigravity", tokenData, existing.id);
  assert.equal(saved.providerSpecificData.quotaGroup, "ide-group");
  assert.equal(saved.providerSpecificData.quotaRealm, "ide-realm");
  assert.equal(saved.providerSpecificData.quotaAccountId, "123456789");
});
