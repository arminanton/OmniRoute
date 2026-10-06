import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../../../src/i18n/messages/en.json";
import CodexFastTierTab from "../../../src/app/(dashboard)/dashboard/settings/components/CodexFastTierTab";

vi.mock("@/shared/components", async () => ({
  Card: (await import("../../../src/shared/components/Card")).default,
  Toggle: (await import("../../../src/shared/components/Toggle")).default,
  Select: (await import("../../../src/shared/components/Select")).default,
}));

type SavedSetting = { codexServiceTier: { tier: string; supportedModels: string[] } };
let saved: SavedSetting[];
beforeEach(() => {
  saved = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      if (options?.method === "PATCH") {
        saved.push(JSON.parse(String(options.body)) as SavedSetting);
        return Response.json({});
      }
      if (url.startsWith("/api/models")) {
        return Response.json({ models: [{ provider: "codex", model: "gpt-6-astra" }] });
      }
      return Response.json({
        codexServiceTier: { enabled: true, tier: "priority", supportedModels: ["gpt-5.5"] },
      });
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function showControls() {
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <CodexFastTierTab />
    </NextIntlClientProvider>
  );
}

it("retains legacy Priority and saves new speed tiers independently", async () => {
  showControls();
  const select = (await screen.findByLabelText("Service tier")) as HTMLSelectElement;
  expect(select.value).toBe("priority");
  expect(screen.getByRole("option", { name: "Priority" })).toBeTruthy();
  expect(screen.getByRole("option", { name: "Fast" })).toBeTruthy();
  expect(screen.getByRole("option", { name: "Ultrafast" })).toBeTruthy();
  fireEvent.change(select, { target: { value: "ultrafast" } });
  await waitFor(() => expect(saved.at(-1)?.codexServiceTier.tier).toBe("ultrafast"));
  await waitFor(() => expect(select.disabled).toBe(false));
  fireEvent.change(select, { target: { value: "priority" } });
  await waitFor(() => expect(saved.at(-1)?.codexServiceTier.tier).toBe("priority"));
});

it("lets operators select discovered models and add future model IDs", async () => {
  showControls();
  await screen.findByLabelText("Service tier");
  fireEvent.click(screen.getByRole("button", { name: /Fast-tier models/ }));
  const checkbox = (await screen.findByLabelText(
    "Enable Fast Tier for gpt-6-astra"
  )) as HTMLInputElement;
  fireEvent.click(checkbox);
  await waitFor(() =>
    expect(saved.at(-1)?.codexServiceTier.supportedModels).toContain("gpt-6-astra")
  );
  await waitFor(() => expect(checkbox.disabled).toBe(false));
  fireEvent.change(screen.getByLabelText("Custom Codex model ID"), {
    target: { value: "gpt-future-custom" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add model" }));
  await waitFor(() =>
    expect(saved.at(-1)?.codexServiceTier.supportedModels).toContain("gpt-future-custom")
  );
});
