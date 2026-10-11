import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { KioskProgress } from "@/ui/kiosk/progress";

describe("KioskProgress", () => {
  it("shows one counter and exposes a progressbar with the same wording", () => {
    render(<KioskProgress current={3} total={13} />);
    expect(screen.getByText("Question 3 of 13")).toBeInTheDocument();
    const bar = screen.getByRole("progressbar", { name: "Question 3 of 13" });
    expect(bar).toHaveAttribute("aria-valuenow", "3");
    expect(bar).toHaveAttribute("aria-valuemin", "1");
    expect(bar).toHaveAttribute("aria-valuemax", "13");
    expect(bar).toHaveAttribute("aria-valuetext", "Question 3 of 13");
  });

  it("draws one decorative segment per step, filled up to the current one", () => {
    const { container } = render(<KioskProgress current={3} total={13} />);
    const segments = container.querySelectorAll("[data-state]");
    expect(segments).toHaveLength(13);
    expect(container.querySelectorAll('[data-state="complete"]')).toHaveLength(3);
    segments.forEach((s) => expect(s).toHaveAttribute("aria-hidden", "true"));
  });

  it("announces politely by default and can be silenced", () => {
    const { rerender } = render(<KioskProgress current={1} total={5} />);
    expect(screen.getByText("Question 1 of 5")).toHaveAttribute("aria-live", "polite");
    rerender(<KioskProgress current={1} total={5} announce={false} />);
    expect(screen.getByText("Question 1 of 5")).not.toHaveAttribute("aria-live");
  });

  it("clamps out-of-range input and supports custom wording", () => {
    render(<KioskProgress current={20} total={13} formatLabel={(c, t) => `Step ${c} of ${t}`} />);
    expect(screen.getByRole("progressbar", { name: "Step 13 of 13" })).toHaveAttribute(
      "aria-valuenow",
      "13",
    );
  });

  it("falls back to a continuous bar for many steps", () => {
    const { container } = render(<KioskProgress current={15} total={30} />);
    expect(container.querySelectorAll("[data-state]")).toHaveLength(0);
    const fill = container.querySelector('[data-slot="kiosk-progress-fill"]') as HTMLElement;
    expect(fill.style.width).toBe("50%");
  });
});
