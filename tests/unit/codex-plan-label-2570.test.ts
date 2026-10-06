// Codex provider details show persisted plan labels verbatim. Quota-tier
// classification does not infer entitlements from undocumented Codex labels.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getCodexPlanLabel } from "@/app/(dashboard)/dashboard/providers/[id]/codexPlanLabel";
import {
  normalizePlanTier,
  resolvePlanValue,
} from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils";

test("getCodexPlanLabel displays provider metadata without inferred tiers", () => {
  assert.equal(getCodexPlanLabel(true, { chatgptPlanType: "  prolite  " }), "prolite");
  assert.equal(getCodexPlanLabel(true, { chatgptPlanType: "pro" }), "pro");
  assert.equal(getCodexPlanLabel(true, { chatgptPlanType: "PROMAX" }), "PROMAX");
  assert.equal(getCodexPlanLabel(true, { chatgptPlanType: "  Team  " }), "Team");
});

test("getCodexPlanLabel falls back to workspacePlanType", () => {
  assert.equal(getCodexPlanLabel(true, { workspacePlanType: "pro" }), "pro");
  assert.equal(
    getCodexPlanLabel(true, { chatgptPlanType: " ", workspacePlanType: "prolite" }),
    "prolite"
  );
  assert.equal(
    getCodexPlanLabel(true, { chatgptPlanType: "Team", workspacePlanType: "pro" }),
    "Team"
  );
});

test("getCodexPlanLabel returns empty string when not a codex connection", () => {
  assert.equal(getCodexPlanLabel(false, { chatgptPlanType: "Pro" }), "");
});

test("getCodexPlanLabel returns empty string when chatgptPlanType is missing/blank", () => {
  assert.equal(getCodexPlanLabel(true, {}), "");
  assert.equal(getCodexPlanLabel(true, { chatgptPlanType: "   " }), "");
  assert.equal(getCodexPlanLabel(true, undefined), "");
});

test("resolvePlanValue does not classify chatgptPlanType as a quota tier", () => {
  for (const plan of ["prolite", "pro", "promax"]) {
    assert.equal(resolvePlanValue("unknown", { chatgptPlanType: plan }, "codex"), null);
  }
});

test("resolvePlanValue preserves existing workspacePlanType behavior", () => {
  const tier = normalizePlanTier(
    resolvePlanValue("unknown", { workspacePlanType: "pro" }, "codex")
  );
  assert.equal(tier.label, "Pro");
  assert.equal(tier.key, "pro");
});

test("resolvePlanValue returns null when neither live nor persisted Codex plan is available", () => {
  assert.equal(resolvePlanValue("unknown", {}), null);
  assert.equal(resolvePlanValue(null, null), null);
});

test("Codex quota classification does not infer tiers from undocumented labels", () => {
  for (const plan of ["prolite", "promax"]) {
    assert.equal(normalizePlanTier(resolvePlanValue(plan, {}, "codex")).key, "unknown");
  }
});

test("other providers keep generic Pro labels and Business classification", () => {
  assert.equal(normalizePlanTier(resolvePlanValue("pro", {}, "other")).label, "Pro");
  assert.equal(normalizePlanTier("self_serve_business_prolite").key, "business");
});
