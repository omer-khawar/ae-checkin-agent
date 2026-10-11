import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { AnswerGroup, type AnswerOption } from "@/ui/kiosk/answer-group";

const SEVERITY: AnswerOption<number>[] = [
  { value: 0, label: "None" },
  { value: 1, label: "Mild" },
  { value: 2, label: "Moderate" },
  { value: 3, label: "Severe" },
  { value: 4, label: "Very severe" },
];

function Controlled(props: { onChange?: (v: number) => void; initial?: number | null }) {
  const [value, setValue] = useState<number | null>(props.initial ?? null);
  return (
    <AnswerGroup
      name="sob-severity"
      legend="How severe was your shortness of breath?"
      options={SEVERITY}
      value={value}
      onValueChange={(v) => {
        setValue(v);
        props.onChange?.(v);
      }}
    />
  );
}

describe("AnswerGroup", () => {
  it("is a named radiogroup built on a fieldset with one radio per option", () => {
    render(<Controlled />);
    const group = screen.getByRole("radiogroup", {
      name: "How severe was your shortness of breath?",
    });
    expect(group.tagName).toBe("FIELDSET");
    expect(screen.getAllByRole("radio")).toHaveLength(5);
    expect(screen.getByRole("radio", { name: "Moderate" })).not.toBeChecked();
  });

  it("selects on click, reports the typed value and marks the row selected", async () => {
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);
    await userEvent.click(screen.getByText("Moderate"));
    expect(onChange).toHaveBeenCalledWith(2);
    const radio = screen.getByRole("radio", { name: "Moderate" });
    expect(radio).toBeChecked();
    const row = radio.closest("label");
    expect(row).toHaveAttribute("data-state", "checked");
    // Selected = solid primary fill (token class), not just a border change.
    expect(row?.className).toContain("bg-primary");
    expect(row?.className).toContain("text-primary-foreground");
  });

  it("uses a roving tabindex: first option when empty, the chosen one otherwise", () => {
    const { unmount } = render(<Controlled />);
    expect(screen.getAllByRole("radio").map((r) => r.tabIndex)).toEqual([0, -1, -1, -1, -1]);
    unmount();
    render(<Controlled initial={3} />);
    expect(screen.getAllByRole("radio").map((r) => r.tabIndex)).toEqual([-1, -1, -1, 0, -1]);
  });

  it("moves focus and selection with arrow keys, Home and End, and wraps", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);
    await user.tab();
    expect(screen.getByRole("radio", { name: "None" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("radio", { name: "Mild" })).toHaveFocus();
    expect(screen.getByRole("radio", { name: "Mild" })).toBeChecked();
    await user.keyboard("{End}");
    expect(screen.getByRole("radio", { name: "Very severe" })).toBeChecked();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("radio", { name: "None" })).toBeChecked();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("radio", { name: "Very severe" })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(screen.getByRole("radio", { name: "None" })).toHaveFocus();
    expect(onChange).toHaveBeenLastCalledWith(0);
  });

  it("skips disabled options when moving with the keyboard", async () => {
    const user = userEvent.setup();
    render(
      <AnswerGroup
        name="x"
        legend="Pick"
        defaultValue="a"
        options={[
          { value: "a", label: "A" },
          { value: "b", label: "B", disabled: true },
          { value: "c", label: "C" },
        ]}
      />,
    );
    await user.tab();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("radio", { name: "C" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "B" })).toBeDisabled();
  });

  it("links helper and error text and flags the group invalid", () => {
    const { rerender } = render(
      <AnswerGroup
        name="y"
        legend="Q"
        options={SEVERITY}
        helperText="Think about the last 7 days."
      />,
    );
    const group = screen.getByRole("radiogroup");
    expect(group).toHaveAccessibleDescription("Think about the last 7 days.");
    expect(group).not.toHaveAttribute("aria-invalid");
    rerender(
      <AnswerGroup
        name="y"
        legend="Q"
        options={SEVERITY}
        helperText="Think about the last 7 days."
        error="Please choose an answer"
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Please choose an answer");
    expect(group).toHaveAttribute("aria-invalid", "true");
    expect(group).toHaveAccessibleDescription("Please choose an answer");
  });

  it("can be named by an external heading instead of a legend", () => {
    render(
      <>
        <h1 id="q-title">Did you have a rash?</h1>
        <AnswerGroup
          name="rash"
          aria-labelledby="q-title"
          options={[
            { value: "yes", label: "Yes" },
            { value: "no", label: "No" },
          ]}
        />
      </>,
    );
    expect(screen.getByRole("radiogroup", { name: "Did you have a rash?" })).toBeInTheDocument();
    expect(document.querySelector("legend")).toBeNull();
  });

  it("never auto-advances: a second tap on the chosen answer is not a new choice", async () => {
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);
    await userEvent.click(screen.getByText("Severe"));
    await userEvent.click(screen.getByText("Severe"));
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
