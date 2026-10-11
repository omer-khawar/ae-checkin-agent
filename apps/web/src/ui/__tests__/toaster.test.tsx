import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ACTION_MIN_DURATION, notify, TOAST_DURATION } from "@/ui/toast";
import { ToastCard, Toaster } from "@/ui/toaster";

// jsdom has no pointer capture; sonner's swipe-to-dismiss calls it on pointerdown.
beforeAll(() => {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.hasPointerCapture ??= () => false;
});

afterEach(() => {
  act(() => {
    notify.dismiss();
  });
});

describe("ToastCard", () => {
  it("pairs every tone with an icon and a screen-reader tone word", () => {
    render(
      <>
        <ToastCard tone="success" title="Draft confirmed" />
        <ToastCard tone="warning" title="Draft rejected" description="AE 3 · Dyspnea" />
        <ToastCard tone="danger" title="Export failed" />
        <ToastCard tone="info" title="Queue refreshed" />
      </>,
    );
    expect(screen.getByText("Success:", { exact: false })).toHaveClass("sr-only");
    expect(screen.getByText("Warning:", { exact: false })).toHaveClass("sr-only");
    expect(screen.getByText("Error:", { exact: false })).toHaveClass("sr-only");
    expect(screen.getByText("Info:", { exact: false })).toHaveClass("sr-only");
    for (const card of document.querySelectorAll('[data-slot="toast"]')) {
      expect(card).toHaveClass("glass-strong");
      expect(card.querySelector("svg")).not.toBeNull();
    }
    expect(screen.getByText("AE 3 · Dyspnea")).toBeInTheDocument();
  });
});

describe("Toaster + notify", () => {
  it("announces toasts in a polite live region labelled Notifications", async () => {
    render(<Toaster />);
    act(() => {
      notify.success("Draft confirmed", { description: "Dyspnea, grade 2 (provisional)" });
    });
    const title = await screen.findByText("Draft confirmed");
    const region = title.closest("section");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region?.getAttribute("aria-label")).toMatch(/^Notifications/);
    expect(screen.getByText("Dyspnea, grade 2 (provisional)")).toBeInTheDocument();
  });

  it("runs Undo then dismisses the toast", async () => {
    const user = userEvent.setup();
    const undo = vi.fn();
    render(<Toaster />);
    act(() => {
      notify.warning("Draft rejected", { undo });
    });
    const card = (await screen.findByText("Draft rejected")).closest(
      '[data-slot="toast"]',
    ) as HTMLElement;
    expect(card).toHaveAttribute("data-tone", "warning");
    await user.click(within(card).getByRole("button", { name: "Undo" }));
    expect(undo).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText("Draft rejected")).not.toBeInTheDocument());
  });

  it("dismisses from the labelled close button", async () => {
    const user = userEvent.setup();
    render(<Toaster />);
    act(() => {
      notify.danger("Export failed");
    });
    await screen.findByText("Export failed");
    await user.click(screen.getByRole("button", { name: "Dismiss notification" }));
    await waitFor(() => expect(screen.queryByText("Export failed")).not.toBeInTheDocument());
  });

  it("keeps danger toasts until dismissed and gives action toasts at least 10 s", () => {
    expect(TOAST_DURATION.danger).toBe(Number.POSITIVE_INFINITY);
    expect(TOAST_DURATION.success).toBeLessThan(ACTION_MIN_DURATION);
    expect(ACTION_MIN_DURATION).toBeGreaterThanOrEqual(10000);
  });
});
