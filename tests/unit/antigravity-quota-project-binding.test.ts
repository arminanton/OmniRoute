import assert from "node:assert/strict";
import { test } from "node:test";
import { verifiedGoogleQuotaFields } from "../../src/lib/oauth/googleQuotaIdentity.ts";
import { resolveQuotaIdentity } from "../../open-sse/services/quotaIdentity.ts";
const proof = () => ({
  ...verifiedGoogleQuotaFields({ id: "123456789" }, "server-project"),
  projectId: "server-project",
});
const key = (provider: string, data: Record<string, unknown>, projectId?: string) =>
  resolveQuotaIdentity(provider, provider + "-row", {
    providerSpecificData: data,
    ...(projectId !== undefined ? { projectId } : {}),
  });

test("unchanged native project keeps CLI/IDE shared identity", () => {
  assert.equal(key("agy", proof()), key("antigravity", proof(), "server-project"));
});
test("edited or missing configured project cannot reuse automatic native identity", () => {
  assert.equal(key("agy", { ...proof(), projectId: "manual-project" }), "agy:agy-row");
  const missing = proof();
  delete missing.projectId;
  assert.equal(key("agy", missing), "agy:agy-row");
  assert.equal(key("agy", proof(), "manual-effective-project"), "agy:agy-row");
});
test("explicit operator group and realm remain authoritative after project edits", () => {
  const native = key("agy", { ...proof(), quotaGroup: "chosen", quotaRealm: "chosen-realm" });
  assert.equal(
    key("agy", {
      ...proof(),
      projectId: "manual-project",
      quotaGroup: "chosen",
      quotaRealm: "chosen-realm",
    }),
    native
  );
});
test("other verified identity protocols retain their existing contract", () => {
  const data = {
    quotaIdentityVerified: true,
    quotaAccountId: "trusted-account",
    quotaRealm: "other-native",
  };
  assert.equal(key("other", data), key("other", { ...data, projectId: "independent" }));
});
