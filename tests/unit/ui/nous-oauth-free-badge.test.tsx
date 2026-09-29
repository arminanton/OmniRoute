// @vitest-environment jsdom
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import PassthroughModelsSection from "../../../src/app/(dashboard)/dashboard/providers/[id]/components/PassthroughModelsSection";

const t: any = Object.assign((key: string) => key, { has: () => false });
const noop = () => {};
const asyncNoop = async () => {};

function renderModel(model: { id: string; name: string; free?: boolean; isFree?: boolean }) {
  return renderToStaticMarkup(
    <PassthroughModelsSection
      providerId="nous-oauth"
      providerAlias="nso"
      connectionId="isolated-fixture"
      modelAliases={{}}
      availableModels={[model]}
      description=""
      inputLabel="Model ID"
      inputPlaceholder=""
      onCopy={noop}
      onSetAlias={asyncNoop}
      onDeleteAlias={noop}
      t={t}
      effectiveModelNormalize={() => false}
      effectiveModelPreserveDeveloper={() => false}
      getUpstreamHeadersRecord={() => ({})}
      saveModelCompatFlags={asyncNoop}
      isModelHidden={() => false}
      onToggleHidden={asyncNoop}
      onBulkToggleHidden={asyncNoop}
    />
  );
}

describe("Nous OAuth provider detail free label", () => {
  it("shows a Free badge for a live zero-priced model without a :free suffix", () => {
    const html = renderModel({
      id: "stealth/space-bunny-alpha",
      name: "Space Bunny Alpha (Free)",
      free: true,
      isFree: true,
    });
    expect(html).toContain("nso/stealth/space-bunny-alpha");
    expect(html).toMatch(/>Free<\/span>/);
  });

  it("does not badge a paid :free ID or a misleading paid display name", () => {
    for (const model of [
      { id: "example/paid:free", name: "Priced Model", free: false, isFree: false },
      { id: "example/misleading", name: "Misleading (Free)", free: false, isFree: false },
    ]) {
      const html = renderModel(model);
      expect(html).toContain(`nso/${model.id}`);
      expect(html).not.toMatch(/>Free<\/span>/);
    }
  });
});
