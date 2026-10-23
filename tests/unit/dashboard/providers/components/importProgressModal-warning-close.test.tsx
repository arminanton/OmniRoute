// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ImportProgressModal from "../../../../../src/app/(dashboard)/dashboard/providers/[id]/components/ImportProgressModal";

afterEach(cleanup);

describe("ImportProgressModal warning state", () => {
  it("shows a warning, not success, and provides a close button", () => {
    const onClose = vi.fn();
    render(
      <ImportProgressModal
        isOpen
        onClose={onClose}
        t={(key) => key}
        importProgress={{
          current: 0,
          total: 0,
          phase: "warning",
          status: "Couldn't reach the provider's model list — showing the built-in catalog",
          logs: ["API unavailable — using local catalog"],
          error: "",
          importedCount: 0,
        }}
      />
    );

    expect(
      screen.getByText("Couldn't reach the provider's model list — showing the built-in catalog")
    ).toBeTruthy();
    expect(screen.getByText("API unavailable — using local catalog")).toBeTruthy();
    expect(screen.getByText("warning")).toBeTruthy();
    expect(screen.queryByText("check_circle")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
