import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Kbd, KbdCombo, KbdSequence } from "../kbd";

describe("Kbd", () => {
  it("renders a <kbd> with the key as text", () => {
    render(<Kbd>C</Kbd>);
    const el = screen.getByText("C");
    expect(el.tagName).toBe("KBD");
    expect(el).toHaveAttribute("data-slot", "kbd");
    expect(el).toHaveClass("text-caption", "bg-surface", "border-border");
  });

  it("speaks symbols as words and hides the glyph from screen readers", () => {
    render(<Kbd>]</Kbd>);
    expect(screen.getByText("]")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("Right bracket")).toHaveClass("sr-only");
  });
});

describe("KbdCombo", () => {
  it("announces one phrase ('Control plus K') and hides the caps", () => {
    const { container } = render(<KbdCombo keys={["Ctrl", "K"]} />);
    const root = container.querySelector("[data-slot='kbd-combo']") as HTMLElement;
    expect(root.tagName).toBe("KBD");
    expect(screen.getByText("Control plus K")).toHaveClass("sr-only");
    const caps = root.querySelectorAll("[aria-hidden='true'] kbd");
    expect(Array.from(caps).map((c) => c.textContent)).toEqual(["Ctrl", "K"]);
  });

  it("plus connector draws a visible + between caps (still hidden from AT)", () => {
    const { container } = render(<KbdCombo keys={["⌘", "S"]} connector="plus" />);
    expect(screen.getByText("Command plus S")).toBeInTheDocument();
    const hidden = container.querySelector("[aria-hidden='true']") as HTMLElement;
    expect(hidden.textContent).toBe("⌘+S");
  });

  it("md size keeps text at the 12px floor", () => {
    const { container } = render(<KbdCombo keys={["Alt", "Enter"]} size="md" />);
    container.querySelectorAll("[aria-hidden='true'] kbd").forEach((cap) => {
      expect(cap).toHaveClass("text-caption", "h-6");
    });
  });
});

describe("KbdSequence", () => {
  it("announces 'G then Q' with a visible 'then' connector", () => {
    const { container } = render(<KbdSequence keys={["G", "Q"]} />);
    expect(screen.getByText("G then Q")).toHaveClass("sr-only");
    const hidden = container.querySelector("[aria-hidden='true']") as HTMLElement;
    expect(hidden.textContent).toBe("GthenQ");
  });

  it("has no hex colours and no motion classes", () => {
    const { container } = render(
      <>
        <Kbd>Esc</Kbd>
        <KbdCombo keys={["Ctrl", "K"]} />
        <KbdSequence keys={["G", "Q"]} />
      </>,
    );
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(container.innerHTML).not.toMatch(/animate-|transition/);
    expect(screen.getByText("Escape")).toHaveClass("sr-only");
  });
});
