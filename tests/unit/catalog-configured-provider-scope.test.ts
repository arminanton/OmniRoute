import assert from "node:assert/strict";
import test from "node:test";
import { filterConfiguredCatalogModels } from "../../src/app/api/v1/models/catalogConfiguredProviders.ts";

test("configured catalog scopes accounts to their provider and preserves combos", () => {
  const models = [
    { id: "cx/shared", root: "shared", owned_by: "codex" },
    { id: "horde/shared", root: "shared", owned_by: "aihorde" },
    { id: "dva/adaptive", root: "adaptive", owned_by: "devin-cli-agentic" },
    { id: "disabled/shared", root: "shared", owned_by: "disabled" },
    { id: "combo", owned_by: "combo" },
  ];
  const result = filterConfiguredCatalogModels(
    models,
    [
      { provider: "cx", isActive: true },
      { provider: "disabled", isActive: false },
    ],
    { cx: "codex" }
  );
  assert.deepEqual(
    result.map((m) => m.id),
    ["cx/shared", "combo"]
  );
});

test("configured catalog honors compatible-node owners and model exclusions", () => {
  const models = [
    { id: "my-host/allowed", root: "allowed", owned_by: "my-host" },
    { id: "my-host/blocked", root: "blocked", owned_by: "my-host" },
  ];
  const connections = [
    { provider: "node-uuid", providerSpecificData: { excludedModels: ["blocked"] } },
  ];
  assert.deepEqual(
    filterConfiguredCatalogModels(models, connections, {}, { "my-host": "node-uuid" }).map(
      (m) => m.id
    ),
    ["my-host/allowed"]
  );
});
