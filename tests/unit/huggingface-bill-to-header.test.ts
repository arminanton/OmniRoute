import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyConfiguredUserAgent,
  applyHuggingFaceBillToHeader,
} from "../../open-sse/executors/base/headers.ts";
import { assignEditApiKeyProviderSpecificData } from "../../src/app/(dashboard)/dashboard/providers/[id]/components/modals/connectionProviderSpecificData.ts";
import { normalizeProviderSpecificData } from "../../src/lib/providers/requestDefaults.ts";

const { updateProviderConnectionSchema } = await import("../../src/shared/validation/schemas.ts");

test("Hugging Face bill-to header trims and emits only for the exact provider", () => {
  const headers: Record<string, string> = {};
  applyHuggingFaceBillToHeader(headers, "huggingface", { billTo: "  account-id  " });
  assert.deepEqual(headers, { "X-HF-Bill-To": "account-id" });

  const maxLengthHeaders: Record<string, string> = {};
  applyHuggingFaceBillToHeader(maxLengthHeaders, "huggingface", { billTo: "x".repeat(500) });
  assert.equal(maxLengthHeaders["X-HF-Bill-To"]?.length, 500);

  const otherProviderHeaders: Record<string, string> = {};
  applyHuggingFaceBillToHeader(otherProviderHeaders, "huggingface-compatible", {
    billTo: "account-id",
  });
  assert.deepEqual(otherProviderHeaders, {});
});

test("configured headers omit invalid bill-to values", () => {
  const invalidValues = [
    undefined,
    "",
    "   ",
    42,
    "account\r\nX-Injected: yes",
    "bad\u0001value",
    "x".repeat(501),
  ];
  for (const billTo of invalidValues) {
    const headers: Record<string, string> = {};
    applyConfiguredUserAgent(headers, { billTo }, "huggingface");
    assert.equal(headers["X-HF-Bill-To"], undefined);
  }
});

test("configured bill-to is omitted without an exact provider match", () => {
  const headers: Record<string, string> = {};
  applyConfiguredUserAgent(headers, { billTo: "account-id" });
  assert.deepEqual(headers, {});
});

test("provider schema accepts safe bill-to values and rejects unsafe values", () => {
  const parse = (billTo: unknown) =>
    updateProviderConnectionSchema.safeParse({ providerSpecificData: { billTo } });
  assert.equal(parse(" account-id ").success, true);
  assert.equal(parse("").success, true);
  const clearParse = parse(null);
  assert.equal(clearParse.success, true, "null explicitly clears a merge-persisted value");
  if (clearParse.success) {
    assert.equal(clearParse.data.providerSpecificData?.billTo, null);
  }
  for (const billTo of [
    "account\r\nX-Injected: yes",
    "bad\u0001value",
    "x".repeat(501),
    " ".repeat(501),
  ]) {
    assert.equal(parse(billTo).success, false);
  }
});

test("editing a Hugging Face connection with a blank bill-to clears the stored value", () => {
  const persisted = { billTo: "old-account", untouched: "keep" };
  const providerSpecificData: Record<string, unknown> = { ...persisted };
  assignEditApiKeyProviderSpecificData({
    provider: "huggingface",
    formData: {
      billTo: "",
      tag: "",
      routingTags: "",
      excludedModels: "",
      customUserAgent: "",
      passthroughModels: false,
    } as Parameters<typeof assignEditApiKeyProviderSpecificData>[0]["formData"],
    target: providerSpecificData,
    extraApiKeys: [],
    openRouterPreset: { getPatch: () => ({}) },
    usesBaseUrl: false,
    validatedBaseUrl: null,
    showsRegion: false,
    defaultRegion: "",
    isGlm: false,
    isCloudflare: false,
    isAntigravityFamily: false,
    trimmedCloudCodeProjectId: "",
    isGooglePse: false,
    isCcCompatible: false,
  });

  const request = JSON.parse(JSON.stringify({ providerSpecificData }));
  assert.equal(request.providerSpecificData.billTo, null);
  const mergedByPut = { ...persisted, ...request.providerSpecificData };
  const saved = normalizeProviderSpecificData("huggingface", mergedByPut);
  assert.equal(saved?.billTo, undefined);
  assert.equal("billTo" in (saved ?? {}), false);
  assert.equal(saved?.untouched, "keep");
});
