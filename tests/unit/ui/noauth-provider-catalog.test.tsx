// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { translate, notify } = vi.hoisted(() => ({ translate: (key: string) => key, notify: {} }));
vi.mock("next-intl", () => ({ useTranslations: () => translate }));
vi.mock("@/store/notificationStore", () => ({ useNotificationStore: () => notify }));
const { useProviderModels } =
  await import("@/app/(dashboard)/dashboard/providers/[id]/hooks/useProviderModels");
let state: ReturnType<typeof useProviderModels>;
let element: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let payload: Record<string, unknown>;
let fetchMock: ReturnType<typeof vi.fn>;
function Probe({ provider = "aihorde" }: { provider?: string }) {
  const models = useProviderModels(provider, false);
  React.useEffect(() => {
    state = models;
  });
  return null;
}
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  element = document.createElement("div");
  root = createRoot(element);
  payload = { models: [], authoritative: true, source: "upstream" };
  fetchMock = vi.fn(async (url: string) =>
    Response.json(url.includes("/api/providers/") ? payload : { models: [] })
  );
  vi.stubGlobal("fetch", fetchMock);
  act(() => root.render(<Probe />));
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});
it("loads no-auth discovery, preserves authoritative empty and exposes fallback warning", async () => {
  await act(async () => state.fetchProviderModelMeta());
  expect(
    fetchMock.mock.calls.some(([url]) => String(url).includes("/api/providers/aihorde/models"))
  ).toBe(true);
  expect(state.authoritativeModels).toEqual([]);
  payload = {
    models: [{ id: "live" }],
    authoritative: true,
    source: "cache",
    warning: "Catalog unavailable; cached availability unverified",
  };
  await act(async () => state.fetchProviderModelMeta());
  expect(state.authoritativeModels).toEqual([{ id: "live" }]);
  expect(state.catalogWarning).toContain("unverified");
  act(() => root.render(<Probe provider="chipotle" />));
  expect(state.authoritativeModels).toBeNull();
  expect(state.catalogWarning).toBeNull();
});
it("does not label fallback static data authoritative", async () => {
  payload = {
    models: [{ id: "seed" }],
    source: "local_catalog",
    warning: "Using unverified local catalog",
  };
  await act(async () => state.fetchProviderModelMeta());
  expect(state.authoritativeModels).toBeNull();
  expect(state.catalogWarning).toContain("unverified");
});

it("custom model panel suppresses stale imports but keeps explicit manual choices", async () => {
  const { default: CustomModelsSection } =
    await import("@/app/(dashboard)/dashboard/providers/[id]/components/CustomModelsSection");
  fetchMock.mockImplementation(async () =>
    Response.json({
      models: [
        { id: "stale-import", name: "Stale import", source: "imported" },
        { id: "manual-choice", name: "Manual choice", source: "manual" },
      ],
    })
  );
  await act(async () =>
    root.render(
      <CustomModelsSection
        providerId="aihorde"
        providerAlias="horde"
        onCopy={() => {}}
        authoritativeModels={[]}
      />
    )
  );
  expect(element.textContent).toContain("manual-choice");
  expect(element.textContent).not.toContain("stale-import");
});
