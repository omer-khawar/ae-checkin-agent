/**
 * /ui-preview smoke test: the route is registered, every section renders on the shared
 * components, the worklist has 25 synthetic rows with guarded selection, the kiosk mock
 * validates on Next and carries the disclaimer verbatim, and Ctrl+K opens the palette.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeAll, describe, expect, it } from "vitest";

import { AppRoutes } from "@/App";
import UiPreview from "@/pages/UiPreview";
import { KIOSK_DISCLAIMER } from "@/ui/kiosk/action-bar";

beforeAll(() => {
  // jsdom lacks these; cmdk scrolls the active item into view and measures the list.
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

describe("UiPreview", () => {
  it("is served at /ui-preview without signing in", async () => {
    render(
      <MemoryRouter initialEntries={["/ui-preview"]}>
        <AppRoutes />
      </MemoryRouter>,
    );
    expect(
      await screen.findByRole("heading", { level: 1, name: "Interim design system preview" }),
    ).toBeInTheDocument();
  });

  it("renders the four sections and the verbatim kiosk disclaimer", () => {
    render(<UiPreview />);
    for (const name of ["Tokens", "Console chrome", "Worklist", "Kiosk"]) {
      expect(screen.getByRole("heading", { level: 2, name })).toBeInTheDocument();
    }
    const kiosk = screen.getByRole("region", { name: "Kiosk preview, 1024 by 768" });
    expect(kiosk).toHaveAttribute("data-surface", "kiosk");
    expect(within(kiosk).getByText(KIOSK_DISCLAIMER)).toBeInTheDocument();
    expect(KIOSK_DISCLAIMER).toBe(
      "Interim is a research data-capture tool. It is not a medical device and does not provide medical advice.",
    );
  });

  it("shows 25 synthetic rows; T2/T3 rows cannot be bulk-selected", async () => {
    const user = userEvent.setup();
    render(<UiPreview />);
    const grid = screen.getByRole("grid");
    // 25 body rows + 1 header row.
    expect(within(grid).getAllByRole("row")).toHaveLength(26);

    // T2/T3 rows and running clocks show a lock with the reason, not a ghost checkbox.
    const locked = within(grid).getAllByRole("img", { name: /reviewed one at a time/ });
    expect(locked.length).toBeGreaterThan(0);

    // Report clocks read as time left with units, never as a time of day.
    const clocks = within(grid).getAllByText(/^(\d+h \d{2}m left|\d+m left|overdue .+)$/);
    expect(clocks.length).toBeGreaterThan(0);

    const selectable = within(grid).getAllByRole("checkbox", { name: /^Select P-\d{3} [a-z-]+$/ });
    await user.click(selectable[0]!);
    expect(screen.getByRole("toolbar", { name: "Actions for selected rows" })).toHaveTextContent(
      "1 selected",
    );
  });

  it("validates the kiosk answer on Next instead of disabling it", async () => {
    const user = userEvent.setup();
    render(<UiPreview />);
    const kiosk = screen.getByRole("region", { name: "Kiosk preview, 1024 by 768" });
    await user.click(within(kiosk).getByRole("button", { name: "Next" }));
    expect(within(kiosk).getByRole("alert")).toHaveTextContent("Please choose an answer");

    await user.click(within(kiosk).getByRole("radio", { name: "Moderate" }));
    await user.click(within(kiosk).getByRole("button", { name: "Next" }));
    expect(within(kiosk).getByText("Question 2 of 13")).toBeInTheDocument();
    expect(within(kiosk).getByRole("button", { name: "Back" })).toBeInTheDocument();
  });

  it("opens the command menu with Ctrl+K", async () => {
    const user = userEvent.setup();
    render(<UiPreview />);
    await user.keyboard("{Control>}k{/Control}");
    const dialog = await screen.findByRole("dialog", { name: "Command menu" });
    expect(within(dialog).getByRole("option", { name: /P-007/ })).toBeInTheDocument();
  });
});
