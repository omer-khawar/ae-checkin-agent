import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { SegmentedControl, type Segment } from "@/ui/segmented-control";

type View = "open" | "acked" | "all" | "archived";

const OPTIONS: Segment<View>[] = [
  { value: "open", label: "Open", accessory: <span>4</span> },
  { value: "acked", label: "Acknowledged" },
  { value: "archived", label: "Archived", disabled: true },
  { value: "all", label: "All" },
];

function Controlled({ onChange }: { onChange?: (v: View) => void }) {
  const [value, setValue] = useState<View>("open");
  return (
    <SegmentedControl
      label="Show escalations"
      options={OPTIONS}
      value={value}
      onValueChange={(v) => {
        setValue(v);
        onChange?.(v);
      }}
    />
  );
}

describe("SegmentedControl", () => {
  it("is a labelled radio group with exactly one checked option", () => {
    render(<Controlled />);
    expect(screen.getByRole("radiogroup", { name: "Show escalations" })).toBeInTheDocument();
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(4);
    expect(screen.getByRole("radio", { name: "Open 4" })).toHaveAttribute("aria-checked", "true");
    expect(radios.filter((r) => r.getAttribute("aria-checked") === "true")).toHaveLength(1);
  });

  it("uses a roving tab stop: only the selected option is tabbable", async () => {
    const user = userEvent.setup();
    render(<Controlled />);
    await user.tab();
    expect(screen.getByRole("radio", { name: "Open 4" })).toHaveFocus();
    expect(screen.getByRole("radio", { name: "Acknowledged" })).toHaveAttribute("tabindex", "-1");
  });

  it("moves and selects with arrows (wrapping, skipping disabled), Home and End", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);
    await user.tab();

    await user.keyboard("{ArrowRight}");
    const acked = screen.getByRole("radio", { name: "Acknowledged" });
    expect(acked).toHaveFocus();
    expect(acked).toHaveAttribute("aria-checked", "true");
    expect(acked).toHaveAttribute("tabindex", "0");

    await user.keyboard("{ArrowRight}"); // skips disabled "Archived"
    expect(screen.getByRole("radio", { name: "All" })).toHaveFocus();

    await user.keyboard("{ArrowRight}"); // wraps
    expect(screen.getByRole("radio", { name: "Open 4" })).toHaveFocus();

    await user.keyboard("{ArrowLeft}"); // wraps backwards
    expect(screen.getByRole("radio", { name: "All" })).toHaveFocus();

    await user.keyboard("{Home}");
    expect(screen.getByRole("radio", { name: "Open 4" })).toHaveAttribute("aria-checked", "true");
    await user.keyboard("{End}");
    expect(screen.getByRole("radio", { name: "All" })).toHaveAttribute("aria-checked", "true");

    expect(onChange.mock.calls.map((c) => c[0])).toEqual([
      "acked",
      "all",
      "open",
      "all",
      "open",
      "all",
    ]);
  });

  it("selects on click, ignores clicks on the selected or disabled option", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);
    await user.click(screen.getByRole("radio", { name: "Open 4" }));
    await user.click(screen.getByRole("radio", { name: "Archived" }));
    expect(onChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole("radio", { name: "Acknowledged" }));
    expect(onChange).toHaveBeenCalledWith("acked");
    expect(screen.getByRole("radio", { name: "Acknowledged" })).toHaveClass(
      "font-semibold",
      "border-input",
    );
  });

  it("reports intent on hover and focus for prefetching", async () => {
    const user = userEvent.setup();
    const onIntent = vi.fn();
    render(
      <SegmentedControl
        label="Codes"
        options={[
          { value: "plain", label: "Plain" },
          { value: "codes", label: "Codes" },
        ]}
        value="plain"
        onValueChange={() => undefined}
        onOptionIntent={onIntent}
      />,
    );
    await user.hover(screen.getByRole("radio", { name: "Codes" }));
    expect(onIntent).toHaveBeenCalledWith("codes");
  });
});
