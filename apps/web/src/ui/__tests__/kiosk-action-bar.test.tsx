import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { KIOSK_DISCLAIMER, KioskActionBar } from "@/ui/kiosk/action-bar";

describe("KioskActionBar", () => {
  it("renders Back and Next and calls their handlers", async () => {
    const onBack = vi.fn();
    const onNext = vi.fn();
    render(<KioskActionBar onBack={onBack} onNext={onNext} />);
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("hides Back on the first question instead of disabling it", () => {
    render(<KioskActionBar onBack={() => {}} showBack={false} onNext={() => {}} />);
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });

  it("keeps Next enabled by default and uses the kiosk xl sizes from the shared Button", () => {
    render(<KioskActionBar onBack={() => {}} onNext={() => {}} />);
    const next = screen.getByRole("button", { name: "Next" });
    expect(next).toBeEnabled();
    expect(next.className).toContain("min-h-[72px]");
    expect(next.className).toContain("min-w-[200px]");
    const back = screen.getByRole("button", { name: "Back" });
    expect(back.className).toContain("min-h-k-option");
    expect(back.className).toContain("border-2");
  });

  it("marks Next busy while saving and blocks double taps", async () => {
    const onNext = vi.fn();
    render(<KioskActionBar onNext={onNext} nextLoading nextLabel="Send to study team" />);
    const next = screen.getByRole("button", { name: "Send to study team" });
    expect(next).toHaveAttribute("aria-busy", "true");
    expect(next).toBeDisabled();
    await userEvent.click(next);
    expect(onNext).not.toHaveBeenCalled();
  });

  it("is a labelled glass region with the verbatim disclaimer", () => {
    render(<KioskActionBar onNext={() => {}} />);
    const region = screen.getByRole("region", { name: "Question navigation" });
    expect(region.className).toContain("glass-strong");
    expect(region.className).toContain("sticky");
    expect(screen.getByText(KIOSK_DISCLAIMER)).toBeInTheDocument();
    expect(KIOSK_DISCLAIMER).toBe(
      "Interim is a research data-capture tool. It is not a medical device and does not provide medical advice.",
    );
  });

  it("publishes its height for scroll-padding while sticky and cleans up on unmount", () => {
    const { unmount } = render(<KioskActionBar onNext={() => {}} />);
    expect(screen.getByRole("region")).toHaveAttribute("data-position", "sticky");
    expect(document.documentElement.style.getPropertyValue("--k-actionbar-live")).toMatch(/px$/);
    unmount();
    expect(document.documentElement.style.getPropertyValue("--k-actionbar-live")).toBe("");
  });

  it("can drop stickiness and the disclaimer", () => {
    render(<KioskActionBar onNext={() => {}} position="static" disclaimer={null} />);
    expect(screen.getByRole("region").className).not.toContain("sticky");
    expect(screen.queryByText(KIOSK_DISCLAIMER)).toBeNull();
  });
});
