import { afterEach, describe, expect, it } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SkillsmpApiKeyControl } from "../../../src/app/(dashboard)/dashboard/settings/components/SkillsmpApiKeyControl.tsx";

afterEach(() => cleanup());

function renderControl(options: {
  configured?: boolean;
  onSave?: (value: string) => void;
  onClear?: () => void;
  value?: string;
  onChange?: (value: string) => void;
}) {
  return render(
    <SkillsmpApiKeyControl
      value={options.value ?? ""}
      configured={options.configured ?? false}
      saving={false}
      label="API Key"
      configuredLabel="configured"
      saveLabel="Save"
      clearLabel="Clear"
      placeholder={options.configured ? "leave empty to keep current key" : "sk_live_..."}
      onChange={options.onChange ?? (() => {})}
      onSave={options.onSave ?? (() => {})}
      onClear={options.onClear ?? (() => {})}
    />
  );
}

function StatefulControl({ onSave }: { onSave: (value: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <SkillsmpApiKeyControl
      value={value}
      configured={false}
      saving={false}
      label="API Key"
      configuredLabel="configured"
      saveLabel="Save"
      clearLabel="Clear"
      placeholder="sk_live_..."
      onChange={setValue}
      onSave={onSave}
      onClear={() => {}}
    />
  );
}

describe("SkillsmpApiKeyControl", () => {
  it("keeps configured credentials write-only and exposes clear as an explicit action", () => {
    let saveCalls = 0;
    let clearCalls = 0;
    renderControl({
      configured: true,
      onSave: () => saveCalls++,
      onClear: () => clearCalls++,
    });

    const input = screen.getByLabelText("API Key") as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("leave empty to keep current key");
    expect(screen.getByText("configured")).toBeTruthy();

    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(saveCalls).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(clearCalls).toBe(1);
  });

  it("submits a newly entered credential and hides clear when none is configured", () => {
    let savedValue = "";
    render(<StatefulControl onSave={(value) => (savedValue = value)} />);

    const input = screen.getByLabelText("API Key");
    fireEvent.change(input, { target: { value: "new-skillsmp-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(savedValue).toBe("new-skillsmp-key");
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
  });
});
