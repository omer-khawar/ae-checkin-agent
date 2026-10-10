/**
 * Queue page against a mocked GET /queue + GET /participants.
 * The API is not running; shapes follow CONTRACTS.md §2.2 and R2.4.
 */
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";

import { ToastProvider } from "../../../../components/Toast";
import { AUTH_STORAGE_KEY } from "../../../../lib/api";
import type { Paginated, Participant } from "../../../../lib/types";
import {
  installMockFetch,
  type Route as MockRoute,
  type RouteContext,
} from "../../../../test/mockFetch";
import { Queue } from "../../Queue";
import type { RawQueueItem } from "../types";
import { useQueuePolling } from "../useQueuePolling";

const STUDY_ID = "R2810-ONC-1624";
const USUBJID_007 = `${STUDY_ID}-P-007`;
const USUBJID_003 = `${STUDY_ID}-P-003`;

const PARTICIPANTS: Paginated<Participant> = {
  items: [
    {
      usubjid: USUBJID_007,
      study_id: STUDY_ID,
      enrolled_at: "2026-08-01T00:00:00.000Z",
      display_label: "P-007",
    },
    {
      usubjid: USUBJID_003,
      study_id: STUDY_ID,
      enrolled_at: "2026-08-01T00:00:00.000Z",
      display_label: "P-003",
    },
  ],
  total: 2,
  limit: 100,
  offset: 0,
};

const TIER1: RawQueueItem = {
  session_id: "01JSESSION00000000000000A",
  usubjid: USUBJID_007,
  display_label: "P-007",
  completed_at: "2026-10-10T18:04:12.345Z",
  tier: 1,
  tier_name: "Review within 1 business day",
  max_grade: 2,
  vitals_status: "simulated_ignored",
  is_measured: false,
  has_sae_clock: false,
  sae_due_at: null,
  escalation_acked: null,
  draft_counts: { AE: 2, VS: 2, CM: 1 },
  draft_status_summary: "5 draft",
  source: "check_in",
};

const NOTE: RawQueueItem = {
  session_id: null,
  note_id: "01JNOTE000000000000000001",
  source: "chart_note",
  usubjid: USUBJID_003,
  display_label: "P-003",
  completed_at: "2026-10-09T12:00:00.000Z",
  tier: 2,
  tier_name: "Nurse call today",
  max_grade: null,
  vitals_status: "unavailable",
  is_measured: false,
  has_sae_clock: false,
  sae_due_at: null,
  escalation_acked: false,
  draft_counts: { AE: 1, VS: 0, CM: 1 },
  draft_status_summary: "2 draft",
};

function tier3(): RawQueueItem {
  return {
    session_id: "01JSESSION00000000000000C",
    usubjid: USUBJID_003,
    display_label: "P-003",
    completed_at: new Date().toISOString(),
    tier: 3,
    tier_name: "Urgent",
    max_grade: 3,
    vitals_status: "ok",
    is_measured: true,
    has_sae_clock: true,
    // 23 h from now → calm amber chip with hours left.
    sae_due_at: new Date(Date.now() + 23 * 3600_000).toISOString(),
    escalation_acked: false,
    draft_counts: { AE: 1, VS: 2, CM: 0 },
    draft_status_summary: "3 draft",
    source: "check_in",
  };
}

type PageResponse = Paginated<RawQueueItem> | { status: number };

interface Options {
  /** Successive GET /queue responses; the last one repeats. A function sees the request. */
  pages?: Array<PageResponse | ((ctx: RouteContext) => PageResponse)>;
  /** Delay GET /participants by this many ms (deep-link resolution tests). */
  participantsDelayMs?: number;
}

function page(items: RawQueueItem[], extra: Partial<Paginated<RawQueueItem>> = {}) {
  return { items, total: items.length, limit: 25, offset: 0, ...extra };
}

function routes(opts: Options = {}): MockRoute[] {
  const pages = opts.pages ?? [page([TIER1, NOTE])];
  let n = 0;
  return [
    {
      method: "GET",
      path: "/api/v1/participants",
      handler: async () => {
        if (opts.participantsDelayMs) {
          await new Promise((r) => setTimeout(r, opts.participantsDelayMs));
        }
        return { json: PARTICIPANTS };
      },
    },
    {
      method: "GET",
      path: "/api/v1/queue",
      handler: (ctx) => {
        const entry = pages[Math.min(n, pages.length - 1)];
        const p = typeof entry === "function" ? entry(ctx) : entry;
        n += 1;
        if ("status" in p && !("items" in p)) {
          return {
            status: p.status,
            json: { type: "about:blank", title: "Server Error", status: p.status, detail: "boom" },
          };
        }
        return { json: p };
      },
    },
  ];
}

/** Exposes the router's current search string so tests can assert URL state. */
function LocationProbe() {
  const loc = useLocation();
  // A plain span: <output> would carry an implicit "status" role and clash with the loading state.
  return <span data-testid="location">{loc.search}</span>;
}

function renderQueue(initialEntry = "/dashboard", refreshIntervalMs = 60_000) {
  sessionStorage.setItem(
    AUTH_STORAGE_KEY,
    JSON.stringify({
      token: "tok",
      role: "coordinator",
      display_name: "Coordinator",
      expires_at: "2099-01-01T00:00:00.000Z",
    }),
  );
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <ToastProvider>
        <Routes>
          <Route path="/dashboard" element={<Queue refreshIntervalMs={refreshIntervalMs} />} />
        </Routes>
        <LocationProbe />
      </ToastProvider>
    </MemoryRouter>,
  );
}

function queueQueries(mock: ReturnType<typeof installMockFetch>): URLSearchParams[] {
  return mock.fn.mock.calls
    .filter((c) => String(c[0]).includes("/api/v1/queue"))
    .map((c) => new URL(String(c[0]), "http://localhost").searchParams);
}

function lastQueueQuery(mock: ReturnType<typeof installMockFetch>): URLSearchParams {
  const all = queueQueries(mock);
  return all[all.length - 1];
}

/** jsdom's `document.hidden` is a prototype getter; override it per test. */
function setDocumentHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
}

afterEach(() => {
  // Restore the prototype getter if a test overrode `document.hidden`.
  Reflect.deleteProperty(document, "hidden");
});

describe("Queue page", () => {
  it("renders check-in and chart-note rows with chips, badges and the right links", async () => {
    const mock = installMockFetch(routes());
    renderQueue();

    expect(screen.getByRole("status")).toHaveTextContent("Loading queue…");
    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);

    // Row 1: check-in (server order preserved: the API put tier 1 first).
    const r1 = within(rows[0]);
    expect(r1.getByRole("link", { name: "P-007" })).toHaveAttribute(
      "href",
      `/dashboard/participants/${encodeURIComponent(USUBJID_007)}`,
    );
    expect(r1.getByText("Check-in")).toBeInTheDocument();
    expect(r1.getByText("Review within 1 business day")).toBeInTheDocument();
    expect(r1.getByText(/G2/)).toBeInTheDocument();
    expect(r1.getByText("provisional")).toBeInTheDocument();
    expect(r1.getByText("Simulated (ignored for rules)")).toBeInTheDocument();
    expect(r1.getByText("SIMULATED")).toBeInTheDocument();
    expect(r1.getByText("AE 2 · VS 2 · CM 1")).toBeInTheDocument();
    expect(r1.getByText("5 draft")).toBeInTheDocument();
    expect(r1.getByRole("link", { name: "Open check-in for P-007" })).toHaveAttribute(
      "href",
      "/dashboard/checkins/01JSESSION00000000000000A",
    );
    // Local time with UTC on hover.
    expect(r1.getByTitle("2026-10-10T18:04:12.345Z (UTC)").tagName).toBe("TIME");

    // Row 2: chart note → note route, no vitals badge, unacked escalation.
    const r2 = within(rows[1]);
    expect(r2.getByText("Chart note")).toBeInTheDocument();
    expect(r2.getByText("Nurse call today")).toBeInTheDocument();
    expect(r2.queryByText("SIMULATED")).toBeNull();
    expect(r2.queryByText("MEASURED")).toBeNull();
    expect(r2.getByText("Unacked")).toBeInTheDocument();
    expect(r2.getByRole("link", { name: "Open chart note for P-003" })).toHaveAttribute(
      "href",
      "/dashboard/notes/01JNOTE000000000000000001",
    );

    // Bearer token and default query.
    const queueCall = mock.find("GET", "/api/v1/queue")[0];
    expect(queueCall.headers.authorization).toBe("Bearer tok");
    const q = lastQueueQuery(mock);
    expect(q.get("status")).toBe("open");
    expect(q.get("include_eval")).toBe("false");
    expect(q.get("limit")).toBe("25");
    expect(q.get("offset")).toBe("0");
    expect(q.has("min_tier")).toBe(false);
    expect(q.has("usubjid")).toBe(false);

    // "updated hh:mm:ss" is visible once loaded.
    expect(screen.getByText(/^updated \d/)).toBeInTheDocument();
  });

  it("shows a live SAE countdown and MEASURED badge for a Tier 3 row", async () => {
    installMockFetch(routes({ pages: [page([tier3()])] }));
    renderQueue();
    const table = await screen.findByRole("table");
    const row = within(table).getAllByRole("row")[1];
    expect(row).toHaveAttribute("data-tier", "3");
    expect(within(row).getByText("Urgent")).toBeInTheDocument();
    expect(within(row).getByText("MEASURED")).toBeInTheDocument();
    expect(within(row).getByLabelText(/^SAE report due in 2[23]:\d\d hrs$/)).toHaveAttribute(
      "data-sae",
      "running",
    );
  });

  it("applies filters to the request and keeps them in the URL", async () => {
    const mock = installMockFetch(routes());
    const user = userEvent.setup();
    renderQueue();
    await screen.findByRole("table");

    await user.selectOptions(screen.getByLabelText("Minimum tier"), "2");
    await waitFor(() => expect(lastQueueQuery(mock).get("min_tier")).toBe("2"));

    await user.selectOptions(screen.getByLabelText("Status"), "all");
    await waitFor(() => expect(lastQueueQuery(mock).get("status")).toBe("all"));

    await user.click(screen.getByLabelText(/Include eval runs/));
    await waitFor(() => expect(lastQueueQuery(mock).get("include_eval")).toBe("true"));

    // Typed display label resolves to the USUBJID through GET /participants.
    await user.type(screen.getByLabelText("Participant"), "p-007");
    await waitFor(() => expect(lastQueueQuery(mock).get("usubjid")).toBe(USUBJID_007));

    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => {
      const q = lastQueueQuery(mock);
      expect(q.has("usubjid")).toBe(false);
      expect(q.has("min_tier")).toBe(false);
      expect(q.get("status")).toBe("open");
    });
  });

  it("reads initial filters from the URL", async () => {
    const mock = installMockFetch(routes());
    renderQueue("/dashboard?min_tier=3&status=all&include_eval=true&offset=25");
    await screen.findByRole("table");
    const q = lastQueueQuery(mock);
    expect(q.get("min_tier")).toBe("3");
    expect(q.get("status")).toBe("all");
    expect(q.get("include_eval")).toBe("true");
    expect(q.get("offset")).toBe("25");
    expect(screen.getByLabelText("Minimum tier")).toHaveValue("3");
  });

  it("shows the empty state", async () => {
    installMockFetch(routes({ pages: [page([])] }));
    renderQueue();
    expect(await screen.findByText("No items match these filters.")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Switch Status to All");
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("empty-state copy names the filter as the cause, not an empty queue", async () => {
    installMockFetch(routes({ pages: [page([])] }));
    // Participant + minimum tier + Status=All: the filters are why it is empty.
    renderQueue("/dashboard?participant=P-003&min_tier=3&status=all");
    const status = await screen.findByText("No items match these filters.");
    expect(status.parentElement).toHaveTextContent("Clear filters to see everything");
    expect(status.parentElement).not.toHaveTextContent("Nothing has been recorded yet");
  });

  it("empty-state copy says the queue is empty only with no narrowing filter and Status=All", async () => {
    installMockFetch(routes({ pages: [page([])] }));
    renderQueue("/dashboard?status=all");
    expect(await screen.findByText("The queue is empty.")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Nothing has been recorded yet");
  });

  it("explains a missing max grade differently for check-ins and chart notes", async () => {
    installMockFetch(routes({ pages: [page([{ ...TIER1, max_grade: null }, NOTE])] }));
    renderQueue();
    const table = await screen.findByRole("table");
    const [r1, r2] = within(table).getAllByRole("row").slice(1);
    expect(
      within(r1).getByTitle("No provisional grade reported for this check-in"),
    ).toBeInTheDocument();
    expect(
      within(r2).getByTitle("No provisional grade (chart-note findings carry a grade hint only)"),
    ).toBeInTheDocument();
  });

  it("does not announce the auto-refresh timestamp with aria-live", async () => {
    installMockFetch(routes());
    renderQueue();
    await screen.findByRole("table");
    const stamp = screen.getByText(/^updated \d/);
    expect(stamp).not.toHaveAttribute("aria-live");
    expect(stamp.closest("[aria-live]")).toBeNull();
  });

  it("holds the first fetch of a deep-linked participant until the label resolves", async () => {
    const mock = installMockFetch(routes({ participantsDelayMs: 40 }));
    renderQueue("/dashboard?participant=P-007");
    expect(screen.getByRole("status")).toHaveTextContent("Loading queue…");
    // Before the participants list settles, nothing has gone to GET /queue.
    expect(queueQueries(mock)).toHaveLength(0);
    await screen.findByRole("table");
    const sent = queueQueries(mock).map((q) => q.get("usubjid"));
    expect(sent[0]).toBe(USUBJID_007);
    expect(sent).not.toContain("P-007");
  });

  it("keeps the last result on screen when an auto-refresh fails", async () => {
    installMockFetch(routes({ pages: [page([TIER1]), { status: 503 }] }));
    renderQueue("/dashboard", 50);
    await screen.findByRole("table");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not refresh the queue; showing the last result");
    expect(alert).toHaveTextContent("HTTP 503");
    // Rows are still there; the stale-but-visible rule holds.
    const table = screen.getByRole("table");
    expect(within(table).getByRole("link", { name: "P-007" })).toBeInTheDocument();
    expect(screen.queryByText("Loading queue…")).toBeNull();
  });

  it("pages with Next: offset goes to the request and the URL", async () => {
    const mock = installMockFetch(
      routes({
        pages: [
          (ctx) =>
            page([TIER1], {
              total: 30,
              offset: Number(ctx.url.searchParams.get("offset") ?? "0"),
            }),
        ],
      }),
    );
    const user = userEvent.setup();
    renderQueue();
    await screen.findByRole("table");
    expect(screen.getByText("Page 1 / 2")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(lastQueueQuery(mock).get("offset")).toBe("25"));
    expect(screen.getByTestId("location")).toHaveTextContent("offset=25");
    await screen.findByText("Page 2 / 2");

    await user.click(screen.getByRole("button", { name: "Previous" }));
    await waitFor(() => expect(lastQueueQuery(mock).get("offset")).toBe("0"));
    expect(screen.getByTestId("location")).not.toHaveTextContent("offset");
  });

  it("the Refresh button re-fetches on demand", async () => {
    const mock = installMockFetch(routes());
    const user = userEvent.setup();
    renderQueue();
    await screen.findByRole("table");
    const before = queueQueries(mock).length;
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(queueQueries(mock).length).toBe(before + 1));
  });

  it("pauses auto-refresh while the tab is hidden and catches up on return", async () => {
    const mock = installMockFetch(routes());
    renderQueue("/dashboard", 30);
    await screen.findByRole("table");

    setDocumentHidden(true);
    const before = queueQueries(mock).length;
    await new Promise((r) => setTimeout(r, 120));
    expect(queueQueries(mock).length).toBe(before);

    setDocumentHidden(false);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(queueQueries(mock).length).toBeGreaterThan(before));
  });

  it("reports loading on the very first render (no blank-card paint)", () => {
    installMockFetch(routes());
    const seen: boolean[] = [];
    function Probe() {
      // Record the render-time value; effects have not run on the first pass.
      const { loading } = useQueuePolling({ limit: 25, offset: 0 }, { intervalMs: 60_000 });
      seen.push(loading);
      return null;
    }
    render(<Probe />);
    expect(seen[0]).toBe(true);
  });

  it("shows an error with retry, then recovers", async () => {
    installMockFetch(routes({ pages: [{ status: 503 }, page([TIER1])] }));
    const user = userEvent.setup();
    renderQueue();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not load the queue");
    expect(alert).toHaveTextContent("HTTP 503");
    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    await screen.findByRole("table");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("toasts when a new Tier 3 item appears on auto-refresh (mock pager)", async () => {
    installMockFetch(routes({ pages: [page([TIER1]), page([tier3(), TIER1])] }));
    renderQueue("/dashboard", 50);
    await screen.findByRole("table");
    // No toast for what was already there on first load.
    expect(screen.queryByText("Page: Tier 3 urgent check-in")).toBeNull();

    const toast = await screen.findByText("Page: Tier 3 urgent check-in");
    expect(toast.closest("[role=alert]")).not.toBeNull();
    expect(toast.parentElement).toHaveTextContent("P-003");

    // The row itself is rendered too, and only one toast fires across later refreshes.
    const table = screen.getByRole("table");
    await waitFor(() =>
      expect(within(table).getAllByRole("row")[1]).toHaveAttribute("data-tier", "3"),
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(screen.getAllByText("Page: Tier 3 urgent check-in")).toHaveLength(1);
  });
});
