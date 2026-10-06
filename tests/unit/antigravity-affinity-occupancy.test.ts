import "../_setup/isolateDataDir.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createProviderConnection } from "../../src/lib/db/providers.ts";
import { updateSettings } from "../../src/lib/db/settings.ts";
import { getProviderCredentials } from "../../src/sse/services/auth.ts";
import { reserveOAuthSession } from "../../open-sse/services/oauthSessionOccupancy.ts";

test("capacity preference cannot move a healthy pinned Antigravity conversation to another account", async () => {
  await updateSettings({
    sessionAffinityTtlMs: 60000,
    fallbackStrategy: "fill-first",
    resilience: { quotaPreflight: { enabled: false } },
  });
  for (const name of ["a", "b"])
    await createProviderConnection({
      provider: "antigravity",
      authType: "oauth",
      name,
      accessToken: `synthetic-${name}`,
      isActive: true,
      testStatus: "active",
      providerSpecificData: { projectId: "synthetic-project" },
    });
  const first = await getProviderCredentials("antigravity", null, null, "gemini-2.5-flash", {
    sessionKey: "own-conversation",
    reserveOAuthSession: true,
  });
  assert.ok(first?.connectionId);
  first.releaseOAuthSession?.();
  const release = reserveOAuthSession(first.connectionId, "other-conversation");
  try {
    const second = await getProviderCredentials("antigravity", null, null, "gemini-2.5-flash", {
      sessionKey: "own-conversation",
      reserveOAuthSession: true,
    });
    assert.equal(second.connectionId, first.connectionId);
    second.releaseOAuthSession?.();
  } finally {
    release();
  }
});
