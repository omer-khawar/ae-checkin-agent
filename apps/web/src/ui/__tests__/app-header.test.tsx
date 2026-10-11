import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, NavLink } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { AppHeader, AppHeaderBrand, AppHeaderNav, AppHeaderNavItem } from "@/ui/app-header";

function Header({ path = "/dashboard" }: { path?: string }) {
  return (
    <MemoryRouter initialEntries={[path]}>
      <AppHeader
        brand={
          <AppHeaderBrand asChild>
            <a href="/dashboard">Interim</a>
          </AppHeaderBrand>
        }
        nav={
          <AppHeaderNav>
            <AppHeaderNavItem asChild count={3} countLabel="need action">
              <NavLink to="/dashboard" end>
                Queue
              </NavLink>
            </AppHeaderNavItem>
            <AppHeaderNavItem asChild count={0}>
              <NavLink to="/dashboard/escalations">Escalations</NavLink>
            </AppHeaderNavItem>
            <AppHeaderNavItem
              href="/dashboard/queries"
              active={false}
              count={140}
              urgent
              countLabel="open"
            >
              Queries
            </AppHeaderNavItem>
          </AppHeaderNav>
        }
        study={<span>R2810-ONC-1624 · NCT03088540</span>}
        actions={<button type="button">Coordinator menu</button>}
      />
      <main id="main">content</main>
    </MemoryRouter>
  );
}

describe("AppHeader", () => {
  it("renders a banner with brand, labelled nav landmark, study and action slots", () => {
    render(<Header />);
    const banner = screen.getByRole("banner");
    expect(banner).toHaveClass("glass", "sticky", "h-appbar");
    expect(within(banner).getByRole("link", { name: "Interim" })).toHaveAttribute(
      "href",
      "/dashboard",
    );
    const nav = within(banner).getByRole("navigation", { name: "Primary" });
    expect(within(nav).getAllByRole("listitem")).toHaveLength(3);
    expect(within(banner).getByText("R2810-ONC-1624 · NCT03088540")).toBeInTheDocument();
    expect(within(banner).getByRole("button", { name: "Coordinator menu" })).toBeInTheDocument();
  });

  it("marks the current route with aria-current via NavLink and an explicit active flag", () => {
    render(<Header />);
    const queue = screen.getByRole("link", { name: /^Queue/ });
    expect(queue).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Escalations" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: /^Queries/ })).not.toHaveAttribute("aria-current");
  });

  it("shows count badges with words for screen readers, hides zero, caps at 99+", () => {
    render(<Header />);
    expect(screen.getByRole("link", { name: "Queue (3 need action)" })).toBeInTheDocument();
    // Zero renders no badge, so the accessible name is just the label.
    expect(screen.getByRole("link", { name: "Escalations" })).toBeInTheDocument();
    const queries = screen.getByRole("link", { name: "Queries (140 open)" });
    const badge = queries.querySelector('[data-slot="app-header-count"]');
    expect(badge).toHaveAttribute("data-urgent", "true");
    expect(badge).toHaveClass("bg-destructive", "tabular");
    expect(within(queries).getByText("99+")).toHaveAttribute("aria-hidden", "true");
  });

  it("puts a skip link first in the tab order that targets the main landmark", async () => {
    const user = userEvent.setup();
    render(<Header />);
    await user.tab();
    const skip = screen.getByRole("link", { name: "Skip to main content" });
    expect(skip).toHaveFocus();
    expect(skip).toHaveAttribute("href", "#main");
    await user.tab();
    expect(screen.getByRole("link", { name: "Interim" })).toHaveFocus();
  });

  it("supports the floating capsule variant and omitting the skip link", () => {
    render(<AppHeader brand={<AppHeaderBrand />} variant="floating" skipToId={null} />);
    expect(screen.getByRole("banner")).toHaveAttribute("data-variant", "floating");
    expect(screen.getByRole("banner")).toHaveClass("rounded-sheet");
    expect(screen.queryByRole("link", { name: "Skip to main content" })).not.toBeInTheDocument();
    expect(screen.getByText("Interim")).toBeInTheDocument();
  });
});
