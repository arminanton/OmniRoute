import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveQuotaIdentity } from "../../open-sse/services/quotaIdentity.ts";
test("duplicate imports share only explicit or verified quota realms", () => {
  const credential = {
    providerSpecificData: {
      quotaGroup: "native-account",
      quotaRealm: "google-code-assist",
      quotaProjectId: "p1",
    },
  };
  assert.equal(
    resolveQuotaIdentity("antigravity", "a", credential),
    resolveQuotaIdentity("agy-cli", "b", credential)
  );
  assert.notEqual(
    resolveQuotaIdentity("antigravity", "a", credential),
    resolveQuotaIdentity("antigravity", "b", {
      providerSpecificData: { ...credential.providerSpecificData, quotaProjectId: "p2" },
    })
  );
  assert.notEqual(
    resolveQuotaIdentity("codex", "a", { email: "same" }),
    resolveQuotaIdentity("codex", "b", { email: "same" })
  );
  assert.equal(
    resolveQuotaIdentity("codex", "a", { providerSpecificData: { accountId: "native" } }),
    "codex:a"
  );
  assert.equal(resolveQuotaIdentity("codex", null, { email: "same" }), null);
});
