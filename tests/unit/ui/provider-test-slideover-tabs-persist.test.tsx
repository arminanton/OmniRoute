// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/image", () => ({ default: (props: Record<string, unknown>) => <img {...props} /> }));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@/shared/components/ProviderIcon", () => ({ default: () => <span /> }));
const mockState = vi.hoisted(() => ({
  keys: [] as Array<unknown>,
  models: [{ id: "model-test" }],
}));
vi.mock("@/app/(dashboard)/dashboard/providers/hooks/useApiKey", () => ({
  useApiKey: () => mockState,
}));
vi.mock("@/app/(dashboard)/dashboard/providers/hooks/useProviderModels", () => ({
  useProviderModels: () => ({ models: mockState.models }),
}));
vi.mock("@/app/(dashboard)/dashboard/media-providers/components/LlmChatCard", () => ({
  LlmChatCard: () => <div data-testid="test-conversation">conversation state</div>,
}));

import ProviderTestSlideOver from "@/shared/components/ProviderTestSlideOver";

describe("ProviderTestSlideOver tab state", () => {
  let root: ReturnType<typeof createRoot> | null = null;
  let container: HTMLDivElement | null = null;
  afterEach(() => {
    if (root) act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    vi.unstubAllGlobals();
  });

  it("keeps the test conversation mounted while switching to Logs and back", async () => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }))
    );
    vi.stubGlobal("setInterval", (() => 1) as typeof setInterval);
    vi.stubGlobal("clearInterval", (() => {}) as typeof clearInterval);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root?.render(
        <ProviderTestSlideOver
          isOpen
          onClose={() => {}}
          providerId="provider-test"
          provider={{ id: "provider-test", name: "Provider Test" }}
        />
      )
    );

    expect(container.querySelector('[data-testid="test-conversation"]')).not.toBeNull();
    const logsTab = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("logs")
    );
    expect(logsTab).toBeTruthy();
    act(() => {
      logsTab!.click();
    });
    expect(container.querySelector('[data-testid="test-conversation"]')).not.toBeNull();
    act(() => {
      const testTab = Array.from(container!.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("test")
      );
      testTab?.click();
    });
    expect(container.querySelector('[data-testid="test-conversation"]')?.textContent).toBe(
      "conversation state"
    );
  });
});
