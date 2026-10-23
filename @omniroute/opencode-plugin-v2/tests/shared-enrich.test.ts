import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyEnrichment,
  buildCanonicalToAliasMap,
  canonicalDedupSet,
  lookupEnrichment,
  type OmniRouteEnrichmentMap,
} from "../src/shared/enrich.js";
import { mapRawModelToModelV2 } from "../src/shared/models-map.js";

const enrichment: OmniRouteEnrichmentMap = new Map([
  ["cc/model-x", { name: "Model X", providerAlias: "cc", providerCanonical: "claude" }],
  ["model-x", { name: "Model X", providerAlias: "cc", providerCanonical: "claude" }],
]);

describe("lookupEnrichment", () => {
  it("resolves a canonical id via the alias fallback chain", () => {
    const canonicalToAlias = buildCanonicalToAliasMap(enrichment);
    assert.equal(canonicalToAlias.get("claude"), "cc");
    const found = lookupEnrichment("claude/model-x", enrichment, canonicalToAlias);
    assert.equal(found?.name, "Model X");
  });
  it("rejects contradictory explicit owners on direct and alias hits", () => {
    const aliasEntry = {
      name: "Claude model",
      providerAlias: "cc",
      providerCanonical: "claude",
    };
    const aliasMap: OmniRouteEnrichmentMap = new Map([["cc/model-x", aliasEntry]]);
    const directMap: OmniRouteEnrichmentMap = new Map([["claude/model-x", aliasEntry]]);
    const canonicalToAlias = buildCanonicalToAliasMap(aliasMap);

    assert.equal(
      lookupEnrichment("claude/model-x", directMap, canonicalToAlias, "ollama"),
      undefined,
    );
    assert.equal(
      lookupEnrichment("claude/model-x", aliasMap, canonicalToAlias, "ollama"),
      undefined,
    );
    assert.equal(
      lookupEnrichment("claude/model-x", directMap, canonicalToAlias, "claude")?.name,
      "Claude model",
    );
    assert.equal(
      lookupEnrichment("claude/model-x", aliasMap, canonicalToAlias, "claude")?.name,
      "Claude model",
    );
  });
  it("rejects same-id bare enrichment owned by another provider", () => {
    const foreign: OmniRouteEnrichmentMap = new Map([
      [
        "model-x",
        {
          name: "Ollama title",
          pricing: { input: 7 },
          freeType: "recurring-credit",
          providerAlias: "ollama",
          providerCanonical: "ollama",
        },
      ],
    ]);
    assert.equal(lookupEnrichment("ih/model-x", foreign, new Map(), "ih"), undefined);
  });

  it("keeps only the name on short-alias bare fallback", () => {
    const bare: OmniRouteEnrichmentMap = new Map([
      [
        "nova-3",
        {
          name: "Nova 3",
          pricing: { input: 7 },
          providerAlias: "deepgram",
          providerCanonical: "deepgram",
          providerDisplayName: "Deepgram",
        },
      ],
    ]);
    assert.deepEqual(lookupEnrichment("dg/nova-3", bare, new Map()), { name: "Nova 3" });
  });

  it("keeps metadata-free bare pricing when the row has no provider identity", () => {
    const entry = { name: "Model X", pricing: { input: 2, output: 3 } };
    const bare: OmniRouteEnrichmentMap = new Map([["model-x", entry]]);
    assert.deepEqual(lookupEnrichment("model-x", bare, new Map()), entry);
  });

  it("keeps metadata-free bare pricing on a provider-qualified row", () => {
    const entry = { pricing: { input: 2, output: 3 } };
    const bare: OmniRouteEnrichmentMap = new Map([["nova-3", entry]]);
    assert.deepEqual(lookupEnrichment("dg/nova-3", bare, new Map()), entry);
  });

  it("prefers exact provider/model identity over a same-id bare entry", () => {
    const sameId: OmniRouteEnrichmentMap = new Map([
      [
        "model-x",
        { name: "Ollama title", providerAlias: "ollama", providerCanonical: "ollama" },
      ],
      ["ih/model-x", { name: "IH title", providerAlias: "ih", providerCanonical: "ih" }],
    ]);
    const found = lookupEnrichment("ih/model-x", sameId, buildCanonicalToAliasMap(sameId), "ih");
    assert.equal(found?.name, "IH title");
  });
});

describe("applyEnrichment", () => {
  it("overlays the enrichment display name onto the model", () => {
    const model = mapRawModelToModelV2(
      { id: "cc/model-x" },
      { providerId: "omniroute", baseURL: "https://gw.example.com" }
    );
    applyEnrichment(model, { name: "Model X" });
    assert.equal(model.name, "Model X");
  });
});

describe("canonicalDedupSet", () => {
  it("drops the canonical twin when the alias row exists", () => {
    const canonicalToAlias = buildCanonicalToAliasMap(enrichment);
    const drop = canonicalDedupSet(
      [{ id: "cc/model-x" }, { id: "claude/model-x" }],
      canonicalToAlias
    );
    assert.ok(drop.has("claude/model-x"));
    assert.ok(!drop.has("cc/model-x"));
  });
});
