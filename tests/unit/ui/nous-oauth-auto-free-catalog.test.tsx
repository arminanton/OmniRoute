// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import ProviderModelsSection from "../../../src/app/(dashboard)/dashboard/providers/[id]/components/ProviderModelsSection";

// React's concurrent root needs the act() test flag for async catalog fetches.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const noop = () => {};
const asyncNoop = async () => {};
const t: any = Object.assign((key: string) => key, { has: () => false });
const stale = { id: "example/old:free", name: "Old (Free)", free: true, isFree: true };
const props: any = {
  providerId: "nous-oauth",
  providerAlias: "nso",
  providerStorageAlias: "nso",
  providerDisplayAlias: "nso",
  providerInfo: { name: "Nous OAuth", passthroughModels: true },
  isCcCompatible: false,
  isAnthropicCompatible: false,
  isAnthropicProtocolCompatible: false,
  isManagedAvailableModelsProvider: false,
  compatibleSupportsModelImport: false,
  allowModelImport: false,
  models: [stale],
  modelMeta: { customModels: [], modelCompatOverrides: [] },
  modelAliases: {},
  syncedAvailableModels: [stale],
  compatibleFallbackModels: [],
  copied: null,
  onCopy: noop,
  onSetAlias: asyncNoop,
  onDeleteAlias: noop,
  fetchProviderModelMeta: asyncNoop,
  connections: [{ id: "oauth-1", isActive: true }],
  selectedConnection: { id: "oauth-1" },
  canImportModels: false,
  importingModels: false,
  handleImportModels: asyncNoop,
  isAutoSyncEnabled: false,
  togglingAutoSync: false,
  handleToggleAutoSync: asyncNoop,
  isAutoFetchModelsEnabled: false,
  togglingAutoFetchModels: false,
  handleToggleAutoFetchModels: asyncNoop,
  handleCompatibleImportWithProgress: asyncNoop,
  compatSavingModelId: null,
  togglingModelId: null,
  bulkVisibilityAction: null,
  clearingModels: false,
  modelFilter: "",
  testingModelId: null,
  modelTestStatus: {},
  onModelTestStatusChange: noop,
  testingAll: false,
  testProgress: null,
  autoHideFailed: false,
  visibilityFilter: "all",
  providerAliasEntries: [],
  setModelFilter: noop,
  setAutoHideFailed: noop,
  setVisibilityFilter: noop,
  saveModelCompatFlags: asyncNoop,
  handleToggleModelHidden: asyncNoop,
  handleBulkToggleModelHidden: asyncNoop,
  handleClearAllModels: asyncNoop,
  onTestModel: asyncNoop,
  handleTestAll: asyncNoop,
  effectiveModelNormalize: () => false,
  effectiveModelPreserveDeveloper: () => false,
  effectiveModelHidden: () => false,
  getUpstreamHeadersRecordForModel: () => ({}),
  t,
};

const mounts: Array<{ root: ReturnType<typeof createRoot>; el: HTMLDivElement }> = [];
async function render() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  mounts.push({ root, el });
  await act(async () => {
    root.render(<ProviderModelsSection {...props} />);
  });
  return el;
}
afterEach(() => {
  for (const { root, el } of mounts.splice(0)) {
    act(() => root.unmount());
    el.remove();
  }
  vi.unstubAllGlobals();
});

describe("Nous OAuth provider portal fetches current public free labels", () => {
  it("loads live rows without enabling background model sync or displaying stale imported labels", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("/api/providers/oauth-1/models");
      return Response.json({
        source: "api",
        models: [
          {
            id: "stealth/space-bunny-alpha",
            name: "Space Bunny Alpha (Free)",
            free: true,
            isFree: true,
          },
          { id: "example/priced:free", name: "Priced", free: false, isFree: false },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const el = await render();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(el.textContent).toContain("nso/stealth/space-bunny-alpha");
    expect(el.textContent).not.toContain("Old (Free)");
    expect(el.querySelectorAll("span").length).toBeGreaterThan(0);
    expect(el.innerHTML).toMatch(/>Free<\/span>/);
  });

  it("hides old Free rows and shows a warning when the live catalog fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ source: "error", models: [], warning: "unavailable" }, { status: 503 })
      )
    );
    const el = await render();
    expect(el.textContent).toContain("Free labels hidden");
    expect(el.textContent).not.toContain("Old (Free)");
    expect(el.innerHTML).not.toMatch(/>Free<\/span>/);
  });
});
