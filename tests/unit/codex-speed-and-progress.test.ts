import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const root = process.env.OMNIROUTE_TEST_REPO_ROOT
  ? pathToFileURL(`${process.env.OMNIROUTE_TEST_REPO_ROOT}/`)
  : new URL("../../", import.meta.url);
const tiers = await import(new URL("src/lib/providers/codexFastTier.ts", root).href);
const { normalizeCodexServiceTier } = await import(
  new URL("src/lib/providers/requestDefaults.ts", root).href
);
const { updateSettingsSchema } = await import(
  new URL("src/shared/validation/settingsSchemas.ts", root).href
);
const { updateProviderConnectionSchema } = await import(
  new URL("src/shared/validation/schemas.ts", root).href
);
const { normalizeServiceTierId } = await import(
  new URL("src/shared/utils/serviceTierLabels.ts", root).href
);
const { normalizeServiceTier } = await import(
  new URL("src/lib/usage/usageHistory/helpers.ts", root).href
);
const { resolveStreamReadinessTimeout } = await import(
  new URL("open-sse/utils/streamReadinessPolicy.ts", root).href
);

test("priority remains independent of fast and ultrafast through settings and connection validation", () => {
  for (const tier of ["priority", "fast", "ultrafast"] as const) {
    assert.equal(normalizeCodexServiceTier(tier), tier);
    const settings = {
      codexServiceTier: { enabled: true, tier, supportedModels: ["gpt-6-astra"] },
    };
    assert.equal(updateSettingsSchema.safeParse(settings).success, true);
    assert.equal(
      updateProviderConnectionSchema.safeParse({
        providerSpecificData: { requestDefaults: { serviceTier: tier } },
      }).success,
      true
    );
    const body: Record<string, unknown> = {};
    tiers.applyCodexGlobalFastServiceTier("codex", { providerSpecificData: {} }, settings, {
      model: "codex/gpt-6-astra-xhigh",
      body,
    });
    assert.equal(body.service_tier, tier);
  }
  assert.equal(normalizeServiceTierId("ultrafast"), "ultrafast");
  assert.equal(normalizeServiceTier("ultrafast"), "ultrafast");
});

test("empty model selection stays empty and does not re-enable legacy models", () => {
  const settings = { codexServiceTier: { enabled: true, supportedModels: [] } };
  assert.deepEqual(tiers.resolveCodexGlobalFastServiceTier(settings).supportedModels, []);
  const body: Record<string, unknown> = {};
  tiers.applyCodexGlobalFastServiceTier("codex", { providerSpecificData: {} }, settings, {
    model: "gpt-5.5",
    body,
  });
  assert.equal(body.service_tier, undefined);
});

test("a selected model cannot accidentally enable a different numeric family", () => {
  const body: Record<string, unknown> = {};
  tiers.applyCodexGlobalFastServiceTier(
    "codex",
    { providerSpecificData: {} },
    { codexServiceTier: { enabled: true, supportedModels: ["gpt-5.5"] } },
    { model: "gpt-5.50", body }
  );
  assert.equal(body.service_tier, undefined);
});

test("model catalog includes discovered and custom Codex models without other providers", () => {
  const catalog = tiers.getCodexFastTierCatalog(
    [
      { provider: "codex", model: "gpt-6-astra" },
      { provider: "cx", model: "gpt-6.1-sol" },
      { provider: "github", model: "other-provider-model" },
    ],
    ["custom-model"]
  );
  assert.ok(catalog.includes("gpt-6-astra"));
  assert.ok(catalog.includes("gpt-6.1-sol"));
  assert.ok(catalog.includes("custom-model"));
  assert.ok(!catalog.includes("other-provider-model"));
});

test("GPT-6 high reasoning gets readiness room without extending unrelated providers", () => {
  const common = { baseTimeoutMs: 80000, body: { input: [] } };
  for (const effort of ["high", "xhigh", "max", "ultra"]) {
    assert.equal(
      resolveStreamReadinessTimeout({ ...common, provider: "codex", model: `gpt-6-luna-${effort}` })
        .timeoutMs,
      110000
    );
  }
  assert.equal(
    resolveStreamReadinessTimeout({ ...common, provider: "github", model: "gpt-6-luna-xhigh" })
      .timeoutMs,
    80000
  );
});
