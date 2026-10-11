/**
 * The dashboard shell: stage-2 routes (R3.3 / R4.4), the Queries nav item, and
 * the "time saved this week (estimate)" strip (R3.2 `GET /metrics/time-saved`).
 *
 * The three stage-2 page modules are replaced by stubs so this test checks the
 * route table, not pages other agents are still writing.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { AppRoutes } from "../../../../App";
import { TimeSavedStrip } from "../../../../components/TimeSavedStrip";
import { ToastProvider } from "../../../../components/Toast";
import { AUTH_STORAGE_KEY } from "../../../../lib/api";
import {
  installMockFetch,
  type MockResult,
  type Route as MockRoute,
} from "../../../../test/mockFetch";

vi.mock("../../packets/PacketPage.tsx", () => ({
  default: () => <h1>Packet page stub</h1>,
}));
vi.mock("../../brief/BriefPage.tsx", () => ({
  default: () => <h1>Brief page stub</h1>,
}));
vi.mock("../../queries/QueriesPage.tsx", () => ({
  default: () => <h1>Queries page stub</h1>,
}));

const METRICS = {
  minutes_saved: 212,
  minutes_manual_baseline: 260,
  records_confirmed: 14,
  fields_prefilled: 96,
  fields_edited: 7,
  packets_signed: 1,
  briefs_generated: 2,
  queries_answered: 1,
  basis: [
    "AE fields: 40 pre-filled, 3 edited by a person (edited ones save nothing), so 37 x 1.5 min = 55.5 min saved.",
    "Total: 212 min saved out of 260 min of manual work (estimate).",
  ],
  is_estimate: true,
  disclaimer: "estimate",
};

function signIn() {
  sessionStorage.setItem(
    AUTH_STORAGE_KEY,
    JSON.stringify({
      token: "tok",
      role: "coordinator",
      display_name: "Coordinator",
      expires_at: "2099-01-01T00:00:00.000Z",
    }),
  );
}

function baseRoutes(metrics: { status: number } | typeof METRICS | object = METRICS): MockRoute[] {
  return [
    {
      method: "GET",
      path: "/api/v1/study",
      handler: () => ({
        json: {
          study_id: "R2810-ONC-1624",
          nct_id: "NCT03088540",
          title: "EMPOWER-Lung 1",
          source_url: "https://clinicaltrials.gov/study/NCT03088540",
          participants_note: "All participants are synthetic.",
        },
      }),
    },
    {
      method: "GET",
      path: "/api/v1/metrics/time-saved",
      handler: () =>
        "status" in metrics
          ? { status: metrics.status, json: { title: "Not Found", status: metrics.status } }
          : { json: metrics },
    },
  ];
}

/** Local Monday of this week as YYYY-MM-DD (independent re-implementation). */
function expectedMonday(): string {
  const d = new Date();
  const back = (d.getDay() + 6) % 7;
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back);
  return `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, "0")}-${String(
    m.getDate(),
  ).padStart(2, "0")}`;
}

function renderApp(path: string) {
  signIn();
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ToastProvider>
        <AppRoutes />
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe("stage-2 routes", () => {
  it.each([
    ["/dashboard/packets/01JPACKET0000000000000001", "Packet page stub"],
    ["/dashboard/participants/R2810-ONC-1624-P-007/brief", "Brief page stub"],
    ["/dashboard/queries", "Queries page stub"],
  ])("%s renders inside the dashboard layout", async (path, text) => {
    installMockFetch(baseRoutes());
    renderApp(path);
    expect(await screen.findByRole("heading", { name: text })).toBeInTheDocument();
    expect(screen.queryByText("Page not found")).toBeNull();
    // Layout chrome and the not-a-medical-device footer are present.
    expect(screen.getByRole("navigation", { name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByText(/not a medical device/i)).toBeInTheDocument();
  });

  it("adds Queries to the nav and keeps every existing item", async () => {
    installMockFetch(baseRoutes());
    renderApp("/dashboard/queries");
    const nav = screen.getByRole("navigation", { name: "Dashboard" });
    const labels = within(nav)
      .getAllByRole("link")
      .map((a) => a.textContent);
    expect(labels).toEqual(["Queue", "Escalations", "Notes", "Queries", "Audit", "Eval"]);
    expect(within(nav).getByRole("link", { name: "Queries" })).toHaveAttribute(
      "href",
      "/dashboard/queries",
    );
    await screen.findByRole("heading", { name: "Queries page stub" });
  });

  it("the brief route and the participant timeline do not shadow each other", async () => {
    const USUBJID = "R2810-ONC-1624-P-007";
    const timelinePath = new RegExp(`^/api/v1/participants/${USUBJID}/timeline$`);
    // The timeline's own endpoint, kept pending so the page sits in its loading
    // state: enough to prove which route rendered without a full fixture.
    const routes: MockRoute[] = [
      ...baseRoutes(),
      {
        method: "GET",
        path: timelinePath,
        handler: () => new Promise<MockResult>(() => undefined),
      },
      { method: "GET", path: "/api/v1/items", handler: () => ({ json: { items: [] } }) },
    ];

    // 1. The bare participant URL is still the timeline, not the brief.
    const mock = installMockFetch(routes);
    const first = renderApp(`/dashboard/participants/${USUBJID}`);
    expect(
      await screen.findByRole("heading", { name: "Participant timeline" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Brief page stub" })).toBeNull();
    await waitFor(() => expect(mock.find("GET", timelinePath)).toHaveLength(1));
    first.unmount();

    // 2. The /brief URL is the brief, and it does not render (or fetch) the timeline page.
    const mock2 = installMockFetch(routes);
    renderApp(`/dashboard/participants/${USUBJID}/brief`);
    await screen.findByRole("heading", { name: "Brief page stub" });
    expect(screen.queryByRole("heading", { name: "Participant timeline" })).toBeNull();
    expect(mock2.find("GET", timelinePath)).toHaveLength(0);
  });
});

describe("TimeSavedStrip", () => {
  it("shows the weekly estimate, labeled, for the week starting Monday", async () => {
    const mock = installMockFetch(baseRoutes());
    signIn();
    render(<TimeSavedStrip />);
    const strip = await screen.findByTestId("time-saved-strip");
    expect(strip).toHaveTextContent("≈ 3.5 hours of coordinator time saved this week");
    expect(within(strip).getByText("estimate")).toBeInTheDocument();
    const call = mock.fn.mock.calls
      .map((c) => new URL(String(c[0]), "http://localhost"))
      .find((u) => u.pathname === "/api/v1/metrics/time-saved");
    expect(call?.searchParams.get("since")).toBe(expectedMonday());
    expect(mock.find("GET", "/api/v1/metrics/time-saved")[0].headers.authorization).toBe(
      "Bearer tok",
    );
  });

  it("explains its basis and counts in a keyboard-operable disclosure", async () => {
    installMockFetch(baseRoutes());
    const user = userEvent.setup();
    render(<TimeSavedStrip />);
    const toggle = await screen.findByRole("button", { name: "How is this estimated?" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    toggle.focus();
    await user.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const panel = screen.getByRole("region", {
      name: "How the time-saved estimate is calculated",
    });
    expect(panel).toHaveTextContent("An estimate, not a measurement");
    for (const [label, value] of [
      ["Fields pre-filled", "96"],
      ["Fields edited by a person", "7"],
      ["Report packets signed", "1"],
      ["Visit briefs generated", "2"],
      ["Sponsor queries answered", "1"],
    ]) {
      expect(within(panel).getByText(label).nextElementSibling).toHaveTextContent(value);
    }
    expect(panel).toHaveTextContent("Total: 212 min saved out of 260 min");
    await user.keyboard("{Escape}");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("reads small totals in minutes and says when a count is not reported", async () => {
    installMockFetch(baseRoutes({ minutes_saved: 25, minutes_manual_baseline: 30, basis: [] }));
    const user = userEvent.setup();
    render(<TimeSavedStrip />);
    const strip = await screen.findByTestId("time-saved-strip");
    expect(strip).toHaveTextContent("≈ 25 minutes of coordinator time saved this week");
    await user.click(screen.getByRole("button", { name: "How is this estimated?" }));
    expect(screen.getByText("Sponsor queries answered").nextElementSibling).toHaveTextContent(
      "not reported",
    );
  });

  it("renders nothing when the metric is unavailable", async () => {
    const mock = installMockFetch(baseRoutes({ status: 404 }));
    const { container } = render(<TimeSavedStrip />);
    await waitFor(() => expect(mock.find("GET", "/api/v1/metrics/time-saved")).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for a malformed response", async () => {
    installMockFetch(baseRoutes({ basis: [] }));
    const { container } = render(<TimeSavedStrip />);
    await new Promise((r) => setTimeout(r, 30));
    expect(container).toBeEmptyDOMElement();
  });

  it("survives a response with no basis: the disclosure opens without crashing", async () => {
    // minutes_saved is present, basis is missing (an endpoint still being written).
    installMockFetch(
      baseRoutes({ minutes_saved: 212, minutes_manual_baseline: 260, fields_prefilled: 96 }),
    );
    const user = userEvent.setup();
    render(<TimeSavedStrip />);
    await user.click(await screen.findByRole("button", { name: "How is this estimated?" }));
    const panel = screen.getByRole("region", {
      name: "How the time-saved estimate is calculated",
    });
    expect(panel).toHaveTextContent("An estimate, not a measurement");
    expect(within(panel).getByText("Fields pre-filled").nextElementSibling).toHaveTextContent("96");
    expect(within(panel).queryByText("Basis")).toBeNull();
  });

  it("drops non-text basis lines and a non-array basis", async () => {
    installMockFetch(
      baseRoutes({
        minutes_saved: 90,
        minutes_manual_baseline: 120,
        basis: ["Total: 90 min saved (estimate).", 42, null, { x: 1 }],
      }),
    );
    const user = userEvent.setup();
    const { unmount } = render(<TimeSavedStrip />);
    await user.click(await screen.findByRole("button", { name: "How is this estimated?" }));
    const items = within(screen.getByRole("region")).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual(["Total: 90 min saved (estimate)."]);
    unmount();

    installMockFetch(baseRoutes({ minutes_saved: 90, minutes_manual_baseline: 120, basis: "x" }));
    render(<TimeSavedStrip />);
    await user.click(await screen.findByRole("button", { name: "How is this estimated?" }));
    expect(within(screen.getByRole("region")).queryByRole("listitem")).toBeNull();
  });

  it("appears in the dashboard header", async () => {
    installMockFetch(baseRoutes());
    renderApp("/dashboard/queries");
    const banner = screen.getByRole("banner");
    expect(await within(banner).findByTestId("time-saved-strip")).toHaveTextContent("estimate");
  });
});
