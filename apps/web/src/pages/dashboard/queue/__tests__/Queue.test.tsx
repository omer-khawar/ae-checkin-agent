/**
 * Queue page against a mocked GET /queue + GET /participants (+ GET /queries).
 * The API is not running; shapes follow CONTRACTS.md §2.2, R2.4, R3.2 and R4.
 *
 * The "Since you were last here" row fetches the whole queue with
 * `status=all&limit=100`; the mock answers those calls from `opts.summary`
 * without consuming the page sequence, and `queueQueries()` leaves them out so
 * the main-table assertions see only the table's own requests.
 */
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "../../../../components/Toast";
import { AUTH_STORAGE_KEY } from "../../../../lib/api";
import type { Paginated, Participant, QueueItem } from "../../../../lib/types";
import {
  installMockFetch,
  type Route as MockRoute,
  type RouteContext,
} from "../../../../test/mockFetch";
import { Queue } from "../../Queue";
import { LAST_SEEN_STORAGE_KEY, MIN_VISIT_MS } from "../lastSeen";
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

const TIER1: QueueItem = {
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

const NOTE: QueueItem = {
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

function tier3(): QueueItem {
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
    clock_kind: "sae",
    // 23 h from now → calm amber chip with hours left.
    sae_due_at: new Date(Date.now() + 23 * 3600_000).toISOString(),
    escalation_acked: false,
    draft_counts: { AE: 1, VS: 2, CM: 0 },
    draft_status_summary: "3 draft",
    source: "check_in",
  };
}

type PageResponse = Paginated<QueueItem> | { status: number };

interface Options {
  /** Successive GET /queue responses; the last one repeats. A function sees the request. */
  pages?: Array<PageResponse | ((ctx: RouteContext) => PageResponse)>;
  /** Delay GET /participants by this many ms (deep-link resolution tests). */
  participantsDelayMs?: number;
  /** Rows for the summary fetch (status=all, limit=100). Default: none. */
  summary?: QueueItem[];
  /** Open-query total for GET /queries; undefined = endpoint missing (404). */
  openQueries?: number;
}

/** The summary row's whole-queue fetch, as opposed to the table's own page. */
function isSummaryCall(sp: URLSearchParams): boolean {
  return sp.get("limit") === "100" && sp.get("status") === "all";
}

function page(items: QueueItem[], extra: Partial<Paginated<QueueItem>> = {}) {
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
    ...(opts.openQueries === undefined
      ? []
      : [
          {
            method: "GET" as const,
            path: "/api/v1/queries",
            handler: () => ({
              json: { items: [], total: opts.openQueries, limit: 1, offset: 0 },
            }),
          },
        ]),
    {
      method: "GET",
      path: "/api/v1/queue",
      handler: (ctx) => {
        if (isSummaryCall(ctx.url.searchParams)) {
          const rows = opts.summary ?? [];
          return { json: { items: rows, total: rows.length, limit: 100, offset: 0 } };
        }
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
    .map((c) => new URL(String(c[0]), "http://localhost").searchParams)
    .filter((sp) => !isSummaryCall(sp));
}

/** The summary row's whole-queue requests only. */
function queueSummaryCalls(mock: ReturnType<typeof installMockFetch>): URLSearchParams[] {
  return mock.fn.mock.calls
    .filter((c) => String(c[0]).includes("/api/v1/queue"))
    .map((c) => new URL(String(c[0]), "http://localhost").searchParams)
    .filter(isSummaryCall);
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
  localStorage.clear();
});

describe("Queue page", () => {
  it("renders check-in and chart-note rows with chips, badges and the right links", async () => {
    const mock = installMockFetch(routes());
    renderQueue();

    expect(screen.getByRole("status")).toHaveTextContent("Loading queue…");
    const table = await screen.findByRole("grid");
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
    // The most severe provisional grade moved into the tier badge's hover text.
    expect(r1.getByTitle(/provisional grade 2, investigator to confirm/)).toBeInTheDocument();
    expect(r1.getByText("Simulated (ignored for rules)")).toBeInTheDocument();
    expect(r1.getByText("SIMULATED")).toBeInTheDocument();
    // Plain words first, SDTM domain codes one step deeper.
    expect(r1.getByText("2 side effects · 2 vital signs · 1 medication")).toBeInTheDocument();
    expect(r1.getByTitle(/AE 2 · VS 2 · CM 1/)).toBeInTheDocument();
    expect(r1.getByRole("link", { name: "Visit brief for P-007" })).toHaveAttribute(
      "href",
      `/dashboard/participants/${encodeURIComponent(USUBJID_007)}/brief`,
    );
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
    expect(r2.getByText("Not acknowledged")).toBeInTheDocument();
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
    const table = await screen.findByRole("grid");
    const row = within(table).getAllByRole("row")[1];
    expect(row).toHaveAttribute("data-row-id");
    expect(within(row).getByText("Urgent")).toBeInTheDocument();
    expect(within(row).getByText("MEASURED")).toBeInTheDocument();
    const chip = within(row)
      .getByText(/^Serious event: report due in 2[23] hours \d+ minutes?$/)
      .closest("[data-sae]");
    expect(chip).toHaveAttribute("data-sae", "running");
    expect(chip).toHaveAttribute("data-clock-kind", "sae");
  });

  it("applies filters to the request and keeps them in the URL", async () => {
    const mock = installMockFetch(routes());
    const user = userEvent.setup();
    renderQueue();
    await screen.findByRole("grid");

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
    await screen.findByRole("grid");
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
    expect(screen.queryByRole("grid")).toBeNull();
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

  it("leaves the grade out of the tier hover when there is none", async () => {
    installMockFetch(routes({ pages: [page([{ ...TIER1, max_grade: null }, NOTE])] }));
    renderQueue();
    const table = await screen.findByRole("grid");
    const [r1] = within(table).getAllByRole("row").slice(1);
    expect(within(r1).queryByTitle(/provisional grade/)).toBeNull();
    expect(within(r1).getByTitle(/^Tier 1: /)).toBeInTheDocument();
  });

  it("does not announce the auto-refresh timestamp with aria-live", async () => {
    installMockFetch(routes());
    renderQueue();
    await screen.findByRole("grid");
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
    await screen.findByRole("grid");
    const sent = queueQueries(mock).map((q) => q.get("usubjid"));
    expect(sent[0]).toBe(USUBJID_007);
    expect(sent).not.toContain("P-007");
  });

  it("keeps the last result on screen when an auto-refresh fails", async () => {
    installMockFetch(routes({ pages: [page([TIER1]), { status: 503 }] }));
    renderQueue("/dashboard", 50);
    await screen.findByRole("grid");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not refresh the queue; showing the last result");
    expect(alert).toHaveTextContent("HTTP 503");
    // Rows are still there; the stale-but-visible rule holds.
    const table = screen.getByRole("grid");
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
    await screen.findByRole("grid");
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
    await screen.findByRole("grid");
    const before = queueQueries(mock).length;
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(queueQueries(mock).length).toBe(before + 1));
  });

  it("pauses auto-refresh while the tab is hidden and catches up on return", async () => {
    const mock = installMockFetch(routes());
    renderQueue("/dashboard", 30);
    await screen.findByRole("grid");

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
    await screen.findByRole("grid");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("toasts when a new Tier 3 item appears on auto-refresh (mock pager)", async () => {
    installMockFetch(routes({ pages: [page([TIER1]), page([tier3(), TIER1])] }));
    renderQueue("/dashboard", 50);
    await screen.findByRole("grid");
    // No toast for what was already there on first load.
    expect(screen.queryByText("Page: new urgent check-in (Tier 3)")).toBeNull();

    const toast = await screen.findByText("Page: new urgent check-in (Tier 3)");
    expect(toast.closest("[role=alert]")).not.toBeNull();
    expect(toast.parentElement).toHaveTextContent("P-003");

    // The row itself is rendered too, and only one toast fires across later refreshes.
    const table = screen.getByRole("grid");
    await waitFor(() =>
      expect(within(within(table).getAllByRole("row")[1]).getByText("Urgent")).toBeInTheDocument(),
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(screen.getAllByText("Page: new urgent check-in (Tier 3)")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Stage 2 (CONTRACTS R3.3 / R4): since-last-here, report clocks, phone calls, briefs
// ---------------------------------------------------------------------------

const LAST_SEEN = "2026-10-10T00:00:00.000Z";

/** Monday-morning overnight state, relative to LAST_SEEN. */
const OVERNIGHT: QueueItem[] = [
  { ...TIER1, completed_at: "2026-10-10T06:00:00.000Z", is_open: true },
  {
    ...NOTE,
    note_id: "01JNOTE0000000000000000ER",
    note_type: "er_note",
    completed_at: "2026-10-10T05:00:00.000Z",
    is_open: true,
    has_sae_clock: true,
    sae_due_at: "2099-01-01T00:00:00.000Z",
  },
  {
    ...NOTE,
    note_id: "01JNOTE00000000000000CALL",
    note_type: "phone_call",
    completed_at: "2026-10-10T04:00:00.000Z",
    is_open: false,
  },
  {
    ...TIER1,
    session_id: "01JSESSION0000000000000OLD",
    completed_at: "2026-10-09T09:00:00.000Z",
    is_open: true,
    clocks: [{ id: "c-aesi", kind: "aesi", due_at: "2099-01-01T00:00:00.000Z", stopped_at: null }],
  },
];

describe("Queue page: since you were last here", () => {
  it("counts what arrived since the stored last-seen time, with open queries", async () => {
    localStorage.setItem(LAST_SEEN_STORAGE_KEY, LAST_SEEN);
    const mock = installMockFetch(routes({ summary: OVERNIGHT, openQueries: 2 }));
    renderQueue();
    const region = await screen.findByRole("region", { name: /Since you were last here/ });
    const stats = await within(region).findByRole("list", { name: "What is new" });
    expect(stats).toHaveTextContent("1 check-in");
    expect(stats).toHaveTextContent("1 chart note");
    expect(stats).toHaveTextContent("1 phone call");
    // The ER note and the new check-in are open; the call was already handled.
    expect(stats).toHaveTextContent("2 need action");
    // Clocks count across the whole queue (the older AESI clock included).
    expect(stats).toHaveTextContent("2 report clocks running");
    expect(within(stats).getByRole("link", { name: "2 open sponsor queries" })).toHaveAttribute(
      "href",
      "/dashboard/queries",
    );
    // The whole-queue fetch asks for every status, non-eval, 100 per page.
    const summaryCall = mock.fn.mock.calls
      .map((c) => new URL(String(c[0]), "http://localhost"))
      .find((u) => u.pathname === "/api/v1/queue" && u.searchParams.get("limit") === "100");
    expect(summaryCall?.searchParams.get("status")).toBe("all");
    expect(summaryCall?.searchParams.get("include_eval")).toBe("false");
    const queriesCall = mock.find("GET", "/api/v1/queries")[0];
    expect(queriesCall.headers.authorization).toBe("Bearer tok");
  });

  it("hides the open-queries count when GET /queries is unavailable", async () => {
    localStorage.setItem(LAST_SEEN_STORAGE_KEY, LAST_SEEN);
    installMockFetch(routes({ summary: OVERNIGHT }));
    renderQueue();
    const stats = await screen.findByRole("list", { name: "What is new" });
    expect(stats).toHaveTextContent("1 check-in");
    expect(within(stats).queryByRole("link")).toBeNull();
    expect(stats).not.toHaveTextContent("quer");
  });

  it("defaults to the last 24 hours when nothing is stored", async () => {
    installMockFetch(routes({ summary: [] }));
    renderQueue();
    const region = await screen.findByRole("region", { name: /Since you were last here/ });
    expect(region).toHaveTextContent("(in the last 24 hours)");
    expect(await within(region).findByText(/Nothing new has arrived/)).toBeInTheDocument();
  });

  it("Mark all as seen moves the cut-off to now and stores it", async () => {
    localStorage.setItem(LAST_SEEN_STORAGE_KEY, LAST_SEEN);
    installMockFetch(routes({ summary: OVERNIGHT }));
    const user = userEvent.setup();
    renderQueue();
    const stats = await screen.findByRole("list", { name: "What is new" });
    expect(stats).toHaveTextContent("1 check-in");
    await user.click(screen.getByRole("button", { name: "Mark all as seen" }));
    await waitFor(() => expect(stats).toHaveTextContent("0 check-ins"));
    expect(stats).toHaveTextContent("0 need action");
    const stored = localStorage.getItem(LAST_SEEN_STORAGE_KEY);
    expect(stored && Date.parse(stored)).toBeGreaterThan(Date.parse(LAST_SEEN));
  });

  it("records the last-seen time when the page unloads after a real visit", async () => {
    installMockFetch(routes());
    renderQueue();
    await screen.findByRole("grid");
    expect(localStorage.getItem(LAST_SEEN_STORAGE_KEY)).toBeNull();
    // Pretend the coordinator read the queue for longer than MIN_VISIT_MS.
    const realNow = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(realNow + MIN_VISIT_MS + 1_000);
    try {
      act(() => {
        window.dispatchEvent(new Event("pagehide"));
      });
    } finally {
      spy.mockRestore();
    }
    const stored = localStorage.getItem(LAST_SEEN_STORAGE_KEY);
    expect(stored).not.toBeNull();
    expect(Math.abs(Date.parse(stored ?? "") - Date.now())).toBeLessThan(5_000);
  });

  it("a reload (a short visit) does not wipe the overnight view", async () => {
    localStorage.setItem(LAST_SEEN_STORAGE_KEY, LAST_SEEN);
    installMockFetch(routes({ summary: OVERNIGHT }));
    const first = renderQueue();
    await screen.findByRole("list", { name: "What is new" });
    // Reload straight away: pagehide fires seconds after mount.
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(localStorage.getItem(LAST_SEEN_STORAGE_KEY)).toBe(LAST_SEEN);
    first.unmount();
    renderQueue();
    const stats = await screen.findByRole("list", { name: "What is new" });
    expect(stats).toHaveTextContent("1 check-in");
    expect(stats).toHaveTextContent("1 chart note");
    expect(stats).toHaveTextContent("1 phone call");
  });

  it("Show last 24 hours restores the overnight view after a later last-seen time", async () => {
    // A rehearsal left "last here" AFTER the overnight items (e.g. the presenter
    // opened the dashboard, then ran a demo reset that reseeded them earlier).
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    localStorage.setItem(LAST_SEEN_STORAGE_KEY, ago(60_000));
    const overnightNow: QueueItem[] = [
      { ...OVERNIGHT[0], completed_at: ago(2 * 3600_000) },
      { ...OVERNIGHT[1], completed_at: ago(3 * 3600_000) },
      { ...OVERNIGHT[2], completed_at: ago(4 * 3600_000) },
    ];
    installMockFetch(routes({ summary: overnightNow }));
    const user = userEvent.setup();
    renderQueue();
    const region = await screen.findByRole("region", { name: /Since you were last here/ });
    const stats = await within(region).findByRole("list", { name: "What is new" });
    expect(stats).toHaveTextContent("0 check-ins");
    expect(within(region).getByText(/Nothing new has arrived/)).toBeInTheDocument();

    await user.click(within(region).getByRole("button", { name: "Show last 24 hours" }));
    await waitFor(() => expect(stats).toHaveTextContent("1 check-in"));
    expect(stats).toHaveTextContent("1 chart note");
    expect(stats).toHaveTextContent("1 phone call");
    expect(region).toHaveTextContent("(in the last 24 hours)");
    expect(localStorage.getItem(LAST_SEEN_STORAGE_KEY)).toBeNull();
    // Already on the default window: the reset control is gone.
    expect(within(region).queryByRole("button", { name: "Show last 24 hours" })).toBeNull();
    // Leaving right after the reset does not overwrite it either.
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(localStorage.getItem(LAST_SEEN_STORAGE_KEY)).toBeNull();
  });

  it("offers no reset when the 24-hour default is already in use", async () => {
    installMockFetch(routes({ summary: [] }));
    renderQueue();
    const region = await screen.findByRole("region", { name: /Since you were last here/ });
    expect(within(region).queryByRole("button", { name: "Show last 24 hours" })).toBeNull();
    expect(within(region).getByRole("button", { name: "Mark all as seen" })).toBeInTheDocument();
  });

  it("re-counts when Refresh is pressed", async () => {
    const mock = installMockFetch(routes({ summary: [] }));
    const user = userEvent.setup();
    renderQueue();
    await screen.findByRole("grid");
    const summaryCalls = () => queueSummaryCalls(mock).length;
    await waitFor(() => expect(summaryCalls()).toBe(1));
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(summaryCalls()).toBe(2));
  });
});

describe("Queue page: report clocks, phone calls", () => {
  it("shows a special-interest clock chip, a phone-call source and a brief link", async () => {
    const call: QueueItem = {
      ...NOTE,
      note_id: "01JNOTE00000000000000CALL",
      note_type: "phone_call",
    };
    const aesi: QueueItem = {
      ...TIER1,
      tier: 2,
      tier_name: "Nurse call today",
      max_grade: 3,
      clocks: [
        {
          id: "clk-1",
          kind: "aesi",
          due_at: new Date(Date.now() + 20 * 3600_000).toISOString(),
          stopped_at: null,
          packet_id: "01JPACKET0000000000000001",
        },
      ],
    };
    installMockFetch(routes({ pages: [page([aesi, call])] }));
    renderQueue();
    const table = await screen.findByRole("grid");
    const [r1, r2] = within(table).getAllByRole("row").slice(1);

    const chip = within(r1)
      .getByText(/^Special-interest event: report due in \d+ hours/)
      .closest("[data-sae]");
    expect(chip).toHaveAttribute("data-clock-kind", "aesi");
    expect(chip).toHaveTextContent("AESI");
    // One click from the clock to its report packet.
    expect(within(r1).getByRole("link", { name: /Special-interest event/ })).toHaveAttribute(
      "href",
      "/dashboard/packets/01JPACKET0000000000000001",
    );
    expect(within(r1).getByTitle(/provisional grade 3/)).toBeInTheDocument();

    expect(within(r2).getByTestId("source-chip")).toHaveTextContent("Phone call");
    expect(within(r2).getByRole("link", { name: "Open phone call for P-003" })).toHaveAttribute(
      "href",
      "/dashboard/notes/01JNOTE00000000000000CALL",
    );
    expect(within(r2).getByRole("link", { name: "Visit brief for P-003" })).toHaveAttribute(
      "href",
      `/dashboard/participants/${encodeURIComponent(USUBJID_003)}/brief`,
    );
  });

  it("shows a neutral chip when the API sends no clock kind, and opens a packet from a clock id", async () => {
    const er: QueueItem = {
      ...NOTE,
      note_id: "01JNOTE0000000000000000ER",
      note_type: "er_note",
      has_sae_clock: true,
      sae_due_at: new Date(Date.now() + 20 * 3600_000).toISOString(),
    };
    const withClockId: QueueItem = {
      ...TIER1,
      clocks: [
        {
          id: "01JCLOCK000000000000000001",
          kind: "sae",
          due_at: new Date(Date.now() + 10 * 3600_000).toISOString(),
          stopped_at: null,
          packet_id: null,
        },
      ],
    };
    installMockFetch(routes({ pages: [page([withClockId, er])] }));
    renderQueue();
    const table = await screen.findByRole("grid");
    const [r1, r2] = within(table).getAllByRole("row").slice(1);

    // No packet yet: one click still opens a pre-filled one for this clock.
    expect(within(r1).getByRole("link", { name: /Serious event: report due in/ })).toHaveAttribute(
      "href",
      "/dashboard/packets/new?clock=01JCLOCK000000000000000001",
    );

    // Kind not reported: no "Serious event", no SAE badge, no protocol section.
    const chip = within(r2)
      .getByText(/^24-hour report: due in \d+ hours/)
      .closest("[data-sae]");
    expect(chip).toHaveAttribute("data-clock-kind", "unknown");
    expect(chip).not.toHaveTextContent(/Serious event|Special-interest|SAE|AESI/);
    expect((chip as HTMLElement).title).not.toContain("§9.4");
    // A legacy row carries no clock id, so there is nothing to link to.
    expect(within(r2).queryByRole("link", { name: /24-hour report/ })).toBeNull();
  });

  it("names the real source in the pager toast title for an urgent chart note", async () => {
    const urgentNote: QueueItem = {
      ...NOTE,
      note_id: "01JNOTE0000000000000URGNT",
      tier: 3,
      tier_name: "Urgent",
      completed_at: new Date().toISOString(),
    };
    installMockFetch(routes({ pages: [page([TIER1]), page([urgentNote, TIER1])] }));
    renderQueue("/dashboard", 50);
    await screen.findByRole("grid");
    const toast = await screen.findByText("Page: new urgent chart note (Tier 3)");
    expect(toast.parentElement).toHaveTextContent("P-003 · chart note completed");
    expect(screen.queryByText(/urgent check-in/)).toBeNull();
  });
});
