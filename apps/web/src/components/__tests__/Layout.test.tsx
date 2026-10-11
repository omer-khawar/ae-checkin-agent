/**
 * The console shell: nav + count badges, System/user menus, Demo guide default, the
 * keyboard layer (g-then-key, ?), the command palette and next-urgent logic.
 * Mounts Layout directly with stub child routes, so no page module is involved.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";

import { AUTH_STORAGE_KEY } from "../../lib/api";
import { resetShellPrefs } from "../../lib/shellPrefs";
import type { QueueItem } from "../../lib/types";
import { installMockFetch, type Route as MockRoute } from "../../test/mockFetch";
import { Layout } from "../Layout";
import { pickNextUrgent } from "../shell/useShellData";

function signIn(role: "coordinator" | "admin" = "coordinator") {
  sessionStorage.setItem(
    AUTH_STORAGE_KEY,
    JSON.stringify({
      token: "tok",
      role,
      display_name: role === "admin" ? "Admin" : "Coordinator",
      expires_at: "2099-01-01T00:00:00.000Z",
    }),
  );
}

const q = (over: Partial<QueueItem>): QueueItem =>
  ({
    usubjid: "R-P-001",
    display_label: "P-001",
    completed_at: "2026-10-10T10:00:00Z",
    tier: 1,
    tier_name: "",
    vitals_status: "ok",
    is_measured: false,
    has_sae_clock: false,
    sae_due_at: null,
    escalation_acked: null,
    draft_status_summary: "",
    session_id: "S1",
    ...over,
  }) as QueueItem;

function routes(): MockRoute[] {
  const page = (items: unknown[], total = items.length) => ({
    json: { items, total, limit: 100, offset: 0 },
  });
  return [
    {
      method: "GET",
      path: "/api/v1/study",
      handler: () => ({
        json: {
          study_id: "R2810",
          nct_id: "NCT03088540",
          title: "EMPOWER-Lung 1",
          source_url: "https://clinicaltrials.gov/study/NCT03088540",
          participants_note: "All participants are synthetic.",
        },
      }),
    },
    {
      method: "GET",
      path: "/api/v1/queue",
      handler: () => page([q({}), q({ tier: 3, session_id: "S9" })], 7),
    },
    { method: "GET", path: "/api/v1/escalations", handler: () => page([{ id: "E1", tier: 3 }], 2) },
    { method: "GET", path: "/api/v1/queries", handler: () => page([], 4) },
    { method: "GET", path: "/api/v1/notes", handler: () => page([], 5) },
    {
      method: "GET",
      path: "/api/v1/participants",
      handler: () => page([{ usubjid: "R-P-007", display_label: "P-007" }]),
    },
    {
      method: "GET",
      path: "/api/v1/metrics/time-saved",
      handler: () => ({ status: 404, json: { status: 404 } }),
    },
  ];
}

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname + l.search}</div>;
}

function renderShell(path = "/dashboard", role: "coordinator" | "admin" = "coordinator") {
  signIn(role);
  installMockFetch(routes());
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/dashboard" element={<Layout />}>
          <Route index element={<h1>Worklist stub</h1>} />
          <Route path="*" element={<h1>Other stub</h1>} />
        </Route>
        <Route path="/login" element={<h1>Login stub</h1>} />
        <Route path="/kiosk" element={<h1>Kiosk stub</h1>} />
      </Routes>
      <Where />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  // jsdom lacks these; cmdk measures its list and scrolls the active item into view.
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  sessionStorage.clear();
  resetShellPrefs();
});

describe("pickNextUrgent", () => {
  it("prefers the highest tier, then the oldest, and skips acknowledged items", () => {
    const next = pickNextUrgent([
      q({ tier: 2, session_id: "A", completed_at: "2026-10-10T08:00:00Z" }),
      q({ tier: 3, session_id: "B", completed_at: "2026-10-10T09:00:00Z" }),
      q({ tier: 3, session_id: "C", completed_at: "2026-10-10T07:00:00Z" }),
      q({ tier: 3, session_id: "D", completed_at: "2026-10-10T06:00:00Z", escalation_acked: true }),
      q({ tier: 1, session_id: "E" }),
    ]);
    expect(next?.path).toBe("/dashboard/checkins/C");
    expect(pickNextUrgent([q({ tier: 1 })])).toBeNull();
  });
});

describe("console shell", () => {
  it("has the four nav items with live counts and the System menu holds Audit and Eval", async () => {
    const user = userEvent.setup();
    renderShell();
    const nav = screen.getByRole("navigation", { name: "Dashboard" });
    expect(within(nav).getAllByRole("link").length).toBe(4);
    await waitFor(() =>
      expect(within(nav).getByRole("link", { name: /Queries/ })).toHaveTextContent("4"),
    );
    expect(within(nav).getByRole("link", { name: /Worklist/ })).toHaveTextContent("7");
    expect(within(nav).getByRole("link", { name: /Escalations/ })).toHaveTextContent("2");
    expect(within(nav).getByRole("link", { name: /Notes/ })).toHaveTextContent("5");

    await user.click(screen.getByRole("button", { name: /System/ }));
    const sys = screen.getByRole("navigation", { name: "System" });
    expect(within(sys).getByRole("link", { name: "Audit" })).toHaveAttribute(
      "href",
      "/dashboard/audit",
    );
    expect(within(sys).getByRole("link", { name: "Eval" })).toBeInTheDocument();
    expect(within(sys).queryByRole("link", { name: "Admin" })).toBeNull();
  });

  it("shows Admin in System only for admins", async () => {
    const user = userEvent.setup();
    renderShell("/dashboard", "admin");
    await user.click(screen.getByRole("button", { name: /System/ }));
    expect(screen.getByRole("link", { name: "Admin" })).toHaveAttribute("href", "/admin");
  });

  it("study chip carries the NCT id; the footer sentence is verbatim", async () => {
    renderShell();
    const chip = await screen.findByRole("button", { name: /NCT03088540/ });
    expect(chip).toHaveAttribute("title", expect.stringContaining("public registry record"));
    expect(
      screen.getByText(
        "Interim is a research data-capture tool. It is not a medical device and does not provide medical advice.",
      ),
    ).toBeInTheDocument();
  });

  it("user menu: Demo guide defaults ON and toggles; sign out goes to /login", async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(screen.getByRole("button", { name: /Coordinator/ }));
    const sw = screen.getByRole("switch", { name: /Demo guide/ });
    expect(sw).toHaveAttribute("aria-checked", "true");
    await user.click(sw);
    expect(screen.getByRole("switch", { name: /Demo guide/ })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await user.click(screen.getByRole("button", { name: /Sign out/ }));
    expect(await screen.findByRole("heading", { name: "Login stub" })).toBeInTheDocument();
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
  });

  it("g then q/e/n navigates; ? opens the shortcut sheet; typing in a field is ignored", async () => {
    const user = userEvent.setup();
    renderShell();
    await user.keyboard("gq");
    expect(screen.getByTestId("where")).toHaveTextContent("/dashboard/queries");
    await user.keyboard("ge");
    expect(screen.getByTestId("where")).toHaveTextContent("/dashboard/escalations");
    await user.keyboard("gn");
    expect(screen.getByTestId("where")).toHaveTextContent("/dashboard/notes");
    await user.keyboard("gw");
    expect(screen.getByTestId("where").textContent).toBe("/dashboard");

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    await user.keyboard("gq");
    expect(screen.getByTestId("where").textContent).toBe("/dashboard");
    input.remove();

    await user.keyboard("?");
    expect(await screen.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
  });

  it("g then u opens the next urgent item once the queue has loaded", async () => {
    const user = userEvent.setup();
    renderShell();
    const nav = screen.getByRole("navigation", { name: "Dashboard" });
    await waitFor(() =>
      expect(within(nav).getByRole("link", { name: /Worklist/ })).toHaveTextContent("7"),
    );
    await user.keyboard("gu");
    expect(screen.getByTestId("where")).toHaveTextContent("/dashboard/checkins/S9");
  });

  it("Ctrl+K opens the palette; a participant id finds Open and Print brief", async () => {
    const user = userEvent.setup();
    renderShell();
    await waitFor(() =>
      expect(screen.getByRole("link", { name: /Worklist/ })).toHaveTextContent("7"),
    );
    act(() => {
      fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    });
    const dialog = await screen.findByRole("dialog");
    await user.keyboard("P-007");
    expect(await within(dialog).findByText("Print a brief for P-007")).toBeInTheDocument();
    await user.click(within(dialog).getByText("Print a brief for P-007"));
    expect(screen.getByTestId("where")).toHaveTextContent("/dashboard/participants/R-P-007/brief");
  });
});
