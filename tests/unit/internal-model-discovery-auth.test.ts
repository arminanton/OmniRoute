import "../_setup/isolateDataDir.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
process.env.INITIAL_PASSWORD = "synthetic-management-pass";
const { requireManagementAuth } = await import("../../src/lib/api/requireManagementAuth.ts");
const { buildModelSyncInternalHeaders } =
  await import("../../src/shared/services/modelSyncScheduler.ts");

test("signed internal model discovery survives the route-level management auth check", async () => {
  const headers = buildModelSyncInternalHeaders();
  assert.equal(
    await requireManagementAuth(
      new Request("http://127.0.0.1:20128/api/providers/account/models", { headers })
    ),
    null
  );
});

test("model-sync credentials cannot authorize unrelated management paths or arbitrary methods", async () => {
  const headers = buildModelSyncInternalHeaders();
  for (const [path, method] of [
    ["/api/settings", "POST"],
    ["/api/providers/account", "DELETE"],
    ["/api/providers/account/models", "DELETE"],
  ]) {
    assert.ok(
      await requireManagementAuth(new Request("http://127.0.0.1:20128" + path, { method, headers }))
    );
  }
  const wrong = new Request("http://127.0.0.1:20128/api/providers/account/models", {
    headers: { "x-model-sync-internal-auth": "wrong-secret" },
  });
  assert.ok(await requireManagementAuth(wrong));
});
