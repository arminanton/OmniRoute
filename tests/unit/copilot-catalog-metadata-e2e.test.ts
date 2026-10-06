import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-copilot-native-catalog-"));
process.env.DATA_DIR = dataDir;
process.env.API_KEY_SECRET = "native-catalog-test-encryption-key";
const core = await import("../../src/lib/db/core.ts");
const providers = await import("../../src/lib/db/providers.ts");
const models = await import("../../src/lib/db/models.ts");
const keys = await import("../../src/lib/db/apiKeys.ts");
const { parseGitHubCopilotModels } = await import("../../open-sse/services/githubCopilotModels.ts");
const { normalizeDiscoveredModels } =
  await import("../../src/lib/providerModels/modelDiscovery.ts");
const { getUnifiedModelsResponse } = await import("../../src/app/api/v1/models/catalog.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("authenticated native Copilot metadata survives persisted import into alias-only API", async () => {
  const connection = await providers.createProviderConnection({
    provider: "github",
    authType: "oauth",
    name: "native fixture",
    accessToken: "fixture",
    isActive: true,
  });
  const discovered = parseGitHubCopilotModels({
    data: [
      {
        id: "account-native-fixture",
        name: "Native fixture",
        capabilities: {
          type: "chat",
          limits: { max_context_window_tokens: 1000000, max_output_tokens: 64000 },
          supports: { vision: true, tool_calls: false },
        },
        billing: { multiplier: 3 },
      },
    ],
  });
  await models.replaceSyncedAvailableModelsForConnection(
    "github",
    connection.id,
    normalizeDiscoveredModels(discovered, "github")
  );
  const key = await keys.createApiKey("native catalog", "fixture-machine");
  const request = new Request("http://localhost/v1/models?prefix=alias&configuredOnly=true", {
    headers: { Authorization: `Bearer ${key.key}` },
  });
  const [a, b] = await Promise.all([
    getUnifiedModelsResponse(request),
    getUnifiedModelsResponse(request),
  ]);
  assert.equal(a.status, 200, await a.clone().text());
  assert.equal(b.status, 200);
  const rows = (await a.json()).data;
  const row = rows.find(
    (entry: Record<string, unknown>) => entry.id === "gh/account-native-fixture"
  );
  assert.ok(row);
  assert.equal(row.context_length, 1000000);
  assert.equal(row.max_output_tokens, 64000);
  assert.equal(row.capabilities.tool_calling, false);
  assert.equal(row.billing_metadata.unit, "premium_requests");
  assert.equal(row.billing_metadata.multiplier, 3);
  assert.equal(row.pricing, undefined);
  assert.ok(
    !rows.some((entry: Record<string, unknown>) => entry.id === "github/account-native-fixture")
  );
});
