import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import {
  GlassCard,
  GlassCardAction,
  GlassCardContent,
  GlassCardDescription,
  GlassCardFooter,
  GlassCardHeader,
  GlassCardTitle,
} from "../glass-card";

describe("GlassCard", () => {
  it("uses the token-driven .glass utility and the sheet radius", () => {
    const { container } = render(<GlassCard>Body</GlassCard>);
    const card = container.firstElementChild as HTMLElement;
    expect(card).toHaveAttribute("data-slot", "glass-card");
    expect(card).toHaveClass("glass", "rounded-sheet", "text-foreground");
    expect(card).not.toHaveClass("glass-strong");
    // No inline styles (the original used an SVG backdrop filter), no hex, no motion.
    expect(card).not.toHaveAttribute("style");
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(container.innerHTML).not.toMatch(/animate-|transition-all|<svg|<filter/);
  });

  it("strength=strong switches to .glass-strong (needed for teal text on the console)", () => {
    const { container } = render(<GlassCard strength="strong">Body</GlassCard>);
    const card = container.firstElementChild as HTMLElement;
    expect(card).toHaveClass("glass-strong");
    expect(card).not.toHaveClass("glass");
    expect(card).toHaveAttribute("data-strength", "strong");
  });

  it("as=section is named by its title (kiosk question cards are announced by the question)", () => {
    render(
      <GlassCard as="section">
        <GlassCardHeader>
          <GlassCardTitle>
            In the last 7 days, how severe was your shortness of breath?
          </GlassCardTitle>
          <GlassCardAction>
            <span>1 of 13</span>
          </GlassCardAction>
        </GlassCardHeader>
        <GlassCardDescription>Pick the one that fits best.</GlassCardDescription>
        <GlassCardContent>Options</GlassCardContent>
        <GlassCardFooter>Footer</GlassCardFooter>
      </GlassCard>,
    );
    const region = screen.getByRole("region", {
      name: "In the last 7 days, how severe was your shortness of breath?",
    });
    expect(region.tagName).toBe("SECTION");
    const heading = screen.getByRole("heading", { level: 2 });
    expect(region).toHaveAttribute("aria-labelledby", heading.id);
    expect(screen.getByText("Pick the one that fits best.")).toHaveClass("text-muted-foreground");
  });

  it("does not set aria-labelledby on a plain div or when there is no title", () => {
    const { container, rerender } = render(
      <GlassCard>
        <GlassCardTitle>Title</GlassCardTitle>
      </GlassCard>,
    );
    expect(container.firstElementChild).not.toHaveAttribute("aria-labelledby");
    rerender(<GlassCard as="section">No title</GlassCard>);
    expect(container.firstElementChild).not.toHaveAttribute("aria-labelledby");
  });

  it("a caller-supplied aria-label or aria-labelledby wins", () => {
    render(
      <>
        <GlassCard as="section" aria-label="Sign in">
          <GlassCardTitle>Welcome</GlassCardTitle>
        </GlassCard>
        <span id="ext">External name</span>
        <GlassCard as="aside" aria-labelledby="ext">
          <GlassCardTitle>Inner</GlassCardTitle>
        </GlassCard>
      </>,
    );
    expect(screen.getByRole("region", { name: "Sign in" })).not.toHaveAttribute("aria-labelledby");
    expect(screen.getByRole("complementary", { name: "External name" })).toHaveAttribute(
      "aria-labelledby",
      "ext",
    );
  });

  it("drops the label when the title unmounts", () => {
    function Toggle() {
      const [show, setShow] = useState(true);
      return (
        <GlassCard as="section">
          {show ? <GlassCardTitle>Question</GlassCardTitle> : null}
          <button type="button" onClick={() => setShow(false)}>
            hide
          </button>
        </GlassCard>
      );
    }
    const { container } = render(<Toggle />);
    expect(container.firstElementChild).toHaveAttribute("aria-labelledby");
    fireEvent.click(screen.getByRole("button", { name: "hide" }));
    expect(container.firstElementChild).not.toHaveAttribute("aria-labelledby");
  });

  it("title heading level is configurable; padding presets follow the surface", () => {
    const { container } = render(
      <GlassCard padding="kiosk">
        <GlassCardTitle as="h1">Welcome</GlassCardTitle>
      </GlassCard>,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Welcome" })).toBeInTheDocument();
    expect(container.firstElementChild).toHaveClass("p-[1.6em]");
  });

  it("forwards refs and extra props", () => {
    const ref = { current: null as HTMLElement | null };
    render(
      <GlassCard ref={ref} data-testid="card" className="max-w-k-content">
        x
      </GlassCard>,
    );
    expect(ref.current).toBe(screen.getByTestId("card"));
    expect(ref.current).toHaveClass("max-w-k-content");
  });
});
