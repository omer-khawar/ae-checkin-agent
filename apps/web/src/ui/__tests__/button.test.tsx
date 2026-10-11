import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Check } from "lucide-react";
import { describe, expect, it, vi } from "vitest";

import { Button } from "../button";

describe("Button", () => {
  it("is a native type=button by default so it never submits a form by accident", () => {
    const onSubmit = vi.fn((e: Event) => e.preventDefault());
    render(
      <form onSubmit={(e) => onSubmit(e.nativeEvent)}>
        <Button>Save</Button>
      </form>,
    );
    const btn = screen.getByRole("button", { name: "Save" });
    expect(btn).toHaveAttribute("type", "button");
    btn.click();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("runs onClick from the keyboard (Enter and Space)", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Confirm</Button>);
    await user.tab();
    expect(screen.getByRole("button", { name: "Confirm" })).toHaveFocus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["primary", "bg-primary"],
    ["secondary", "bg-surface"],
    ["ghost", "bg-transparent"],
    ["danger", "text-destructive"],
    ["destructive", "bg-destructive"],
    ["glass", "glass-strong"],
  ] as const)("variant %s uses token classes (%s)", (variant, cls) => {
    render(<Button variant={variant}>Go</Button>);
    const btn = screen.getByRole("button", { name: "Go" });
    expect(btn).toHaveClass(cls);
    expect(btn).toHaveAttribute("data-variant", variant);
    expect(btn.className).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it("console sizes are 28px / 32px; kiosk xl is at least 64px", () => {
    render(
      <>
        <Button size="sm">Small</Button>
        <Button size="md">Medium</Button>
        <Button size="xl">Back</Button>
        <Button size="xl" variant="primary">
          Next
        </Button>
      </>,
    );
    expect(screen.getByRole("button", { name: "Small" })).toHaveClass("h-7");
    expect(screen.getByRole("button", { name: "Medium" })).toHaveClass("h-8");
    const back = screen.getByRole("button", { name: "Back" });
    expect(back).toHaveClass("min-h-k-option", "text-k-answer", "border-2", "min-w-[160px]");
    const next = screen.getByRole("button", { name: "Next" });
    expect(next).toHaveClass("min-h-[72px]", "min-w-[200px]", "font-bold");
    // tailwind-merge keeps one min-height: the compound 72px wins over the 64px base.
    expect(next).not.toHaveClass("min-h-k-option");
  });

  it("loading disables the button, sets aria-busy and shows a hidden spinner", () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Export
      </Button>,
    );
    const btn = screen.getByRole("button", { name: "Export" });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("aria-busy", "true");
    btn.click();
    expect(onClick).not.toHaveBeenCalled();
    expect(btn.querySelector("svg")?.closest("[aria-hidden='true']")).not.toBeNull();
  });

  it("icon-only buttons are named by aria-label; icons never leak into the name", () => {
    render(
      <>
        <Button size="icon" aria-label="Close panel">
          <Check aria-hidden="true" />
        </Button>
        <Button leadingIcon={<Check />} trailingIcon={<Check />}>
          Confirm
        </Button>
      </>,
    );
    expect(screen.getByRole("button", { name: "Close panel" })).toHaveClass("size-8");
    const confirm = screen.getByRole("button", { name: "Confirm" });
    confirm.querySelectorAll("svg").forEach((svg) => {
      expect(svg.closest("[aria-hidden='true']")).not.toBeNull();
    });
  });

  it("asChild puts the styles on the child element (e.g. a link)", () => {
    render(
      <Button asChild variant="primary">
        <a href="/dashboard">Open dashboard</a>
      </Button>,
    );
    const link = screen.getByRole("link", { name: "Open dashboard" });
    expect(link).toHaveClass("bg-primary", "focus-ring");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("merges caller classes and forwards the ref", () => {
    const ref = { current: null as HTMLButtonElement | null };
    render(
      <Button ref={ref} className="w-40">
        Wide
      </Button>,
    );
    expect(ref.current).toBe(screen.getByRole("button", { name: "Wide" }));
    expect(ref.current).toHaveClass("w-40");
  });
});
