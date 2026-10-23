// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("@/shared/components", async () => {
  const ReactModule = await import("react");
  return {
    Card: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement("div", null, children),
    Button: ({ children, onClick }: { children?: React.ReactNode; onClick?: () => void }) =>
      ReactModule.createElement("button", { onClick }, children),
  };
});
vi.mock("../../../src/app/(dashboard)/dashboard/settings/components/CompressionTokenSaverCard", () => ({
  default: () => null,
}));

const roots: Array<{ unmount: () => void }> = [];
const containers: HTMLElement[] = [];

function mount(ui: React.ReactElement): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(ui));
  return container;
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await act(async () => {
    while (roots.length) roots.pop()?.unmount();
  });
  while (containers.length) containers.pop()?.remove();
  document.body.innerHTML = "";
});

describe("CompressionSettingsTab load retry", () => {
  it("keeps defaults hidden after failed loads and restores saved settings on retry", async () => {
    const config = {
      enabled: true,
      defaultMode: "stacked",
      autoTriggerTokens: 1234,
      cacheMinutes: 17,
      preserveSystemPrompt: true,
      comboOverrides: {},
      cavemanConfig: {
        enabled: true,
        compressRoles: ["user"],
        skipRules: [],
        minMessageLength: 73,
        preservePatterns: [],
        intensity: "full",
      },
      cavemanOutputMode: { enabled: false, intensity: "full", autoClarity: true },
      rtkConfig: { enabled: true, intensity: "standard" },
      codexResponsesConfig: {
        enabled: false,
        minBytes: 512,
        maxOutputBytes: 2 * 1024 * 1024,
        maxCandidateBytes: 512 * 1024,
        maxLines: 160,
        minSearchMatches: 8,
        minLogLines: 24,
        preserveToolNames: ["Read", "Glob", "Grep", "Write", "Edit", "WebSearch", "WebFetch"],
      },
      aggressive: {
        thresholds: { fullSummary: 5, moderate: 3, light: 2, verbatim: 2 },
        toolStrategies: {
          fileContent: true,
          grepSearch: true,
          shellOutput: true,
          json: true,
          errorMessage: true,
        },
        summarizerEnabled: true,
        maxTokensPerMessage: 2048,
        minSavingsThreshold: 0.05,
      },
      ultra: {
        enabled: false,
        compressionRate: 0.5,
        minScoreThreshold: 0.3,
        slmFallbackToAggressive: true,
        maxTokensPerMessage: 0,
      },
    };
    const statuses: Array<number | Error> = [new Error("network unavailable"), 503, 200];
    const puts: unknown[] = [];
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.endsWith("/api/compression/rules")) return json({ rules: [] });
      if (url.endsWith("/api/settings/compression")) {
        if (method === "PUT") {
          puts.push(JSON.parse(String(init?.body ?? "{}")));
          return json(config);
        }
        const status = statuses.shift() ?? 200;
        if (status instanceof Error) throw status;
        return json(config, status);
      }
      return json({}, 404);
    });

    const { default: CompressionSettingsTab } =
      await import("../../../src/app/(dashboard)/dashboard/settings/components/CompressionSettingsTab");
    const container = mount(<CompressionSettingsTab />);
    await flush();

    expect(container.textContent).toContain("compressionTitle: failedToLoad");
    expect(container.textContent).not.toContain("compressionDesc");
    expect(container.querySelector('input, [role="switch"]')).toBeNull();
    expect(puts).toHaveLength(0);

    for (let attempt = 0; attempt < 2; attempt++) {
      const retry = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "retry"
      );
      expect(retry).toBeTruthy();
      await act(async () => retry!.click());
      await flush();
      expect(puts).toHaveLength(0);
      if (attempt === 0) expect(container.textContent).toContain("failedToLoad");
    }

    expect(container.textContent).not.toContain("failedToLoad");
    expect(container.textContent).toContain("compressionDesc");
    expect(container.querySelector("input, [role=\"switch\"]")).toBeTruthy();
    const numberInputValues = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[type="number"]'),
      (input) => input.value
    );
    expect(numberInputValues).toEqual(["1234", "17", "73"]);
    expect(puts).toHaveLength(0);
  });
});
