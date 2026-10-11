/**
 * Escalations page against a mocked API (no server). Mounted without the Layout
 * so the test exercises only this page; the footer and nav come from Layout.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { ToastProvider } from "../../../../components/Toast";
import { AUTH_STORAGE_KEY } from "../../../../lib/api";
import { resetAuthCache } from "../../../../lib/auth";
import type { ClockRow, EscalationRow, PageEventRow, Paginated, Role } from "../../../../lib/types";
import { installMockFetch, type Route as MockRoute } from "../../../../test/mockFetch";
import { Escalations } from "../../Escalations";
import { Toaster } from "@/ui/toaster";

const SESSION_A = "01JSESSION00000000000000AA";
const SESSION_B = "01JSESSION00000000000000BB";
const NOTE_C = "01JNOTE000000000000000000C";

const ESCALATIONS: EscalationRow[] = [
  {
    id: "01JESC0000000000000000000A",
    session_id: SESSION_A,
    note_id: null,
    usubjid: "R2810-ONC-1624-P-007",
    tier: 3,
    tier_name: "Urgent",
    reasons: [
      "Hospitalization or ER visit reported (red flag; tier floor 3)",
      "tachypnea corroborates reported dyspnea",
    ],
    source: "check_in",
    created_at: "2026-10-10T09:00:00.000Z",
    paged_at: "2026-10-10T09:00:01.000Z",
    acked_by: null,
    acked_at: null,
    seconds_to_ack: null,
  },
  {
    id: "01JESC0000000000000000000B",
    session_id: SESSION_B,
    note_id: null,
    usubjid: "R2810-ONC-1624-P-002",
    tier: 2,
    tier_name: "Nurse call today",
    reasons: ["Provisional grade 3 for Diarrhea"],
    source: "check_in",
    created_at: "2026-10-09T15:00:00.000Z",
    paged_at: null,
    acked_by: "coordinator",
    acked_at: "2026-10-09T15:12:30.000Z",
    seconds_to_ack: 750,
  },
  {
    id: "01JESC0000000000000000000C",
    session_id: null,
    note_id: NOTE_C,
    usubjid: "R2810-ONC-1624-P-011",
    tier: 2,
    tier_name: "Nurse call today",
    reasons: ["Chart note: urgent red flag 'worsening shortness of breath'"],
    source: "chart_note",
    created_at: "2026-10-10T08:00:00.000Z",
    paged_at: null,
    acked_by: null,
    acked_at: null,
    seconds_to_ack: null,
  },
];

function clocks(nowMs: number): ClockRow[] {
  const inOneHour = new Date(nowMs + 3600 * 1000).toISOString();
  return [
    {
      id: "01JSAE0000000000000000000A",
      session_id: SESSION_A,
      note_id: null,
      usubjid: "R2810-ONC-1624-P-007",
      site_awareness_at: new Date(nowMs - 23 * 3600 * 1000).toISOString(),
      due_at: inOneHour,
      stopped_at: null,
      stopped_by: null,
      decision: null,
      seconds_remaining: 3600,
      informational: {
        sponsor_fatal_or_life_threatening_due: "2026-10-17T09:00:00.000Z",
        sponsor_other_serious_due: "2026-10-25T09:00:00.000Z",
        source: "21 CFR 312.32(c)",
        note: "Informational only.",
      },
    },
    {
      id: "01JSAE0000000000000000000B",
      session_id: SESSION_B,
      note_id: null,
      usubjid: "R2810-ONC-1624-P-002",
      site_awareness_at: "2026-10-08T09:00:00.000Z",
      due_at: "2026-10-09T09:00:00.000Z", // in the past, but stopped: must not read as overdue
      stopped_at: "2026-10-08T20:00:00.000Z",
      stopped_by: "investigator",
      decision: "AESER=Y",
      seconds_remaining: null,
      informational: {},
    },
    {
      id: "01JSAE0000000000000000000C",
      session_id: null,
      note_id: NOTE_C,
      usubjid: "R2810-ONC-1624-P-011",
      site_awareness_at: "2026-10-08T09:00:00.000Z",
      due_at: "2026-10-09T09:00:00.000Z", // active and past due
      stopped_at: null,
      stopped_by: null,
      decision: null,
      seconds_remaining: -90000,
      informational: {},
    },
  ];
}

const PAGES: PageEventRow[] = [
  {
    id: "01JPAGE000000000000000000A",
    ts: "2026-10-10T09:00:01.000Z",
    session_id: SESSION_A,
    escalation_id: "01JESC0000000000000000000A",
    usubjid: "R2810-ONC-1624-P-007",
    tier: 3,
    message: "URGENT: tier 3 check-in for P-007; contact participant today.",
    delivered: true,
  },
];

function paginated<T>(items: T[], url: URL): Paginated<T> {
  const limit = Number(url.searchParams.get("limit") ?? 25);
  const offset = Number(url.searchParams.get("offset") ?? 0);
  return { items: items.slice(offset, offset + limit), total: items.length, limit, offset };
}

interface Opts {
  escalations?: EscalationRow[];
  clocks?: ClockRow[];
  pages?: PageEventRow[];
  /** Status for GET /escalations; everything else stays 200. */
  escalationsStatus?: number;
  /** Status for GET /sae-clocks (both variants). */
  clocksStatus?: number;
  /** Status for GET /pages. */
  pagesStatus?: number;
  ackStatus?: number;
  /** Send SAE clocks as a bare array (the CONTRACTS.md ambiguity) instead of the envelope. */
  bareClockArray?: boolean;
}

function problem(status: number) {
  return {
    status,
    json: { type: "about:blank", title: "Server Error", status, detail: "boom" },
  };
}

function routes(opts: Opts = {}): MockRoute[] {
  const escalations = opts.escalations ?? ESCALATIONS;
  const allClocks = opts.clocks ?? clocks(Date.now());
  return [
    {
      method: "GET",
      path: "/api/v1/escalations",
      handler: ({ url }) => {
        if (opts.escalationsStatus && opts.escalationsStatus >= 400) {
          return problem(opts.escalationsStatus);
        }
        return { json: paginated(escalations, url) };
      },
    },
    {
      method: "GET",
      path: "/api/v1/sae-clocks",
      handler: ({ url }) => {
        if (opts.clocksStatus && opts.clocksStatus >= 400) return problem(opts.clocksStatus);
        // Shipped API (services/dashboard.py#list_sae_clocks): active=true → running
        // clocks only; active=false → stopped only; paginated envelope, default limit 50.
        const active = url.searchParams.get("active") === "true";
        const subset = allClocks.filter((c) => (c.stopped_at === null) === active);
        if (opts.bareClockArray) return { json: subset };
        // Cap the page at 50 whatever the client asks for, so a client that does
        // not walk pages (the original bug) or walks them wrongly is caught.
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 50);
        url.searchParams.set("limit", String(limit));
        return { json: paginated(subset, url) };
      },
    },
    {
      method: "GET",
      path: "/api/v1/pages",
      handler: ({ url }) => {
        if (opts.pagesStatus && opts.pagesStatus >= 400) return problem(opts.pagesStatus);
        return { json: paginated(opts.pages ?? PAGES, url) };
      },
    },
    {
      method: "POST",
      path: /^\/api\/v1\/escalations\/([^/]+)\/ack$/,
      handler: ({ params }) => {
        if (opts.ackStatus && opts.ackStatus >= 400) {
          return {
            status: opts.ackStatus,
            json: {
              type: "about:blank",
              title: "Forbidden",
              status: opts.ackStatus,
              detail: "role not allowed",
            },
          };
        }
        const row = escalations.find((e) => e.id === params[0]);
        if (!row) return { status: 404, json: { title: "Not Found", status: 404, type: "x" } };
        // Contract-shaped response (no `source` / `created_at`): the page must keep them.
        const { source: _s, created_at: _c, tier_name: _t, note_id: _n, ...contract } = row;
        return {
          json: {
            ...contract,
            acked_by: "coordinator",
            acked_at: "2026-10-10T09:30:00.000Z",
            seconds_to_ack: 1800,
          },
        };
      },
    },
  ];
}

function signIn(role: Role) {
  sessionStorage.setItem(
    AUTH_STORAGE_KEY,
    JSON.stringify({
      token: "t",
      role,
      display_name: "Dana",
      expires_at: "2099-01-01T00:00:00.000Z",
    }),
  );
  resetAuthCache();
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/dashboard/escalations"]}>
      <ToastProvider>
        <Toaster />
        <Routes>
          <Route path="/dashboard/escalations" element={<Escalations />} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe("Escalations page", () => {
  it("loads every section and computes the summary tiles from the same data", async () => {
    signIn("coordinator");
    const mock = installMockFetch(routes());
    renderPage();

    expect(screen.getByRole("status")).toHaveTextContent(/Loading/);
    expect(await screen.findByText("Open escalations")).toBeInTheDocument();

    // Tiles: 2 open of 3; median over the one acked (750 s → 12m 30s); 2 active clocks, 1 overdue; 1 page.
    const tiles = screen.getAllByRole("definition");
    const text = tiles.map((t) => t.textContent).join(" | ");
    expect(text).toContain("of 3 total");
    expect(text).toContain("12m 30s");
    expect(text).toContain("across 1 acknowledged");
    expect(text).toContain("1 overdue");
    expect(text).toContain("mock pager, tier 3 only");

    // Both GET /sae-clocks variants were requested and merged.
    expect(mock.find("GET", "/api/v1/sae-clocks")).toHaveLength(2);

    // Escalations table: "Open" filter is the default → two rows, tier 3 first.
    const rows = document.querySelectorAll(
      '[data-testid="escalations-table"] tbody tr[data-row-id]',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute("data-row-id", ESCALATIONS[0].id);
    expect(within(rows[0] as HTMLElement).getByText(/Urgent/)).toBeInTheDocument();
    expect(
      within(rows[0] as HTMLElement).getByText("tachypnea corroborates reported dyspnea"),
    ).toBeInTheDocument();
    // Paged time renders as <time> with UTC on hover.
    expect(
      within(rows[0] as HTMLElement).getByTitle("2026-10-10T09:00:01.000Z (UTC)"),
    ).toBeInTheDocument();
    // Open rows tick live.
    expect(within(rows[0] as HTMLElement).getByText(/and counting/)).toBeInTheDocument();
    // Chart-note source labelled, no check-in link.
    expect(within(rows[1] as HTMLElement).getByText("Chart note")).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText(NOTE_C)).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText("not paged (tier 2)")).toBeInTheDocument();
    // Check-in source links to the detail page.
    expect(
      within(rows[0] as HTMLElement).getByRole("link", { name: "open check-in" }),
    ).toHaveAttribute("href", `/dashboard/checkins/${SESSION_A}`);

    // SAE clocks: active first (overdue one is due earliest), stopped last.
    const clockRows = document.querySelectorAll(
      '[data-testid="clocks-table"] tbody tr[data-row-id]',
    );
    expect(clockRows).toHaveLength(3);
    expect(clockRows[0]).toHaveAttribute("data-row-id", "01JSAE0000000000000000000C");
    expect(within(clockRows[0] as HTMLElement).getByText("Overdue")).toBeInTheDocument();
    expect(clockRows[1]).toHaveAttribute("data-row-id", "01JSAE0000000000000000000A");
    expect(
      within(clockRows[1] as HTMLElement).getByText(/^(59m \d{2}s|1h 00m)$/),
    ).toBeInTheDocument();
    expect(
      within(clockRows[1] as HTMLElement).getByText("Sponsor 7-day (fatal or life-threatening)"),
    ).toBeInTheDocument();
    expect(within(clockRows[2] as HTMLElement).getByText(/Stopped by/)).toBeInTheDocument();
    expect(within(clockRows[2] as HTMLElement).getByText("AESER=Y")).toBeInTheDocument();
    expect(within(clockRows[2] as HTMLElement).queryByText("Overdue")).not.toBeInTheDocument();
    expect(
      screen.getAllByText("Informational, not owned by this system (21 CFR 312.32)").length,
    ).toBe(3);

    // Pager log rows carry the word Simulated.
    const pageRows = document.querySelectorAll('[data-testid="pager-table"] tbody tr[data-row-id]');
    expect(pageRows).toHaveLength(1);
    expect(within(pageRows[0] as HTMLElement).getByText("Simulated")).toBeInTheDocument();
    expect(within(pageRows[0] as HTMLElement).getByText(/URGENT: tier 3/)).toBeInTheDocument();
  });

  it("filters open / acknowledged / all", async () => {
    signIn("coordinator");
    installMockFetch(routes());
    renderPage();
    const user = userEvent.setup();
    await screen.findByText("Open escalations");

    await user.click(screen.getByRole("radio", { name: /Acknowledged \(1\)/ }));
    let rows = document.querySelectorAll('[data-testid="escalations-table"] tbody tr[data-row-id]');
    expect(rows).toHaveLength(1);
    expect(within(rows[0] as HTMLElement).getByText("coordinator")).toBeInTheDocument();
    expect(within(rows[0] as HTMLElement).getByText("12m 30s")).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /All \(3\)/ }));
    rows = document.querySelectorAll('[data-testid="escalations-table"] tbody tr[data-row-id]');
    expect(rows).toHaveLength(3);
    expect(screen.getByRole("radio", { name: /All \(3\)/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("acknowledges: POSTs, updates the row, keeps API-only fields, shows a toast", async () => {
    signIn("coordinator");
    const mock = installMockFetch(routes());
    renderPage();
    const user = userEvent.setup();
    await screen.findByText("Open escalations");

    await user.click(
      screen.getByRole("button", { name: "Acknowledge escalation for R2810-ONC-1624-P-007" }),
    );
    await waitFor(() =>
      expect(mock.find("POST", `/api/v1/escalations/${ESCALATIONS[0].id}/ack`)).toHaveLength(1),
    );
    const ack = mock.find("POST", `/api/v1/escalations/${ESCALATIONS[0].id}/ack`)[0];
    expect(ack.headers.authorization).toBe("Bearer t");

    // Row left the "Open" filter; tile now says 1 open.
    await waitFor(() =>
      expect(
        document.querySelectorAll('[data-testid="escalations-table"] tbody tr[data-row-id]'),
      ).toHaveLength(1),
    );
    expect(
      screen
        .getAllByRole("definition")
        .map((d) => d.textContent)
        .join(" "),
    ).toContain("across 2 acknowledged");
    expect(
      await screen.findByText("Escalation acknowledged for R2810-ONC-1624-P-007"),
    ).toBeInTheDocument();
    expect(screen.getByText(/escalation\.acked by coordinator/)).toBeInTheDocument();

    // Under "All", the acknowledged row still shows its check-in link (source kept).
    await user.click(screen.getByRole("radio", { name: /All \(3\)/ }));
    const row = document.querySelector(`tr[data-row-id="${ESCALATIONS[0].id}"]`);
    expect(within(row as HTMLElement).getByText("coordinator")).toBeInTheDocument();
    expect(
      within(row as HTMLElement).getByRole("link", { name: "open check-in" }),
    ).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText("30m 00s")).toBeInTheDocument();
  });

  it("surfaces an acknowledgement failure without losing the row", async () => {
    signIn("coordinator");
    installMockFetch(routes({ ackStatus: 403 }));
    renderPage();
    const user = userEvent.setup();
    await screen.findByText("Open escalations");
    await user.click(
      screen.getByRole("button", { name: "Acknowledge escalation for R2810-ONC-1624-P-007" }),
    );
    expect(await screen.findByText("Could not acknowledge")).toBeInTheDocument();
    expect(screen.getAllByText(/role not allowed/).length).toBeGreaterThanOrEqual(1);
    expect(
      document.querySelectorAll('[data-testid="escalations-table"] tbody tr[data-row-id]'),
    ).toHaveLength(2);
  });

  it("shows a visible read-only note instead of an unfocusable disabled button for admin (non-clinical)", async () => {
    signIn("admin");
    installMockFetch(routes());
    renderPage();
    await screen.findByText("Open escalations");
    // No Acknowledge control at all for this role (a disabled button would be
    // skipped by Tab and its title never read out), ...
    expect(
      screen.queryByRole("button", { name: /Acknowledge escalation for/ }),
    ).not.toBeInTheDocument();
    // ... and the explanation is visible text in every open row.
    const notes = screen.getAllByTestId("ack-read-only");
    expect(notes).toHaveLength(2);
    expect(notes[0]).toHaveTextContent(/Coordinator or investigator acknowledges/);
    expect(notes[0]).toHaveTextContent(/read-only/);
    // Acknowledged rows carry neither the button nor the note.
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: /Acknowledged \(1\)/ }));
    expect(screen.queryByTestId("ack-read-only")).not.toBeInTheDocument();
  });

  it("lets an investigator acknowledge", async () => {
    signIn("investigator");
    installMockFetch(routes());
    renderPage();
    await screen.findByText("Open escalations");
    expect(
      screen.getByRole("button", { name: "Acknowledge escalation for R2810-ONC-1624-P-007" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("ack-read-only")).not.toBeInTheDocument();
  });

  it("walks every page of GET /sae-clocks instead of only the API's first page", async () => {
    signIn("coordinator");
    // 60 active + 55 stopped clocks: more than the API's default page of 50 each.
    const many: ClockRow[] = [];
    for (let i = 0; i < 115; i++) {
      const active = i < 60;
      many.push({
        id: `01JSAE${String(i).padStart(20, "0")}`,
        session_id: SESSION_A,
        note_id: null,
        usubjid: `R2810-ONC-1624-P-${String(i).padStart(3, "0")}`,
        site_awareness_at: "2026-10-10T00:00:00.000Z",
        due_at: new Date(Date.now() + (i + 1) * 60_000).toISOString(),
        stopped_at: active ? null : "2026-10-10T01:00:00.000Z",
        stopped_by: active ? null : "investigator",
        decision: active ? null : "AESER=N",
        seconds_remaining: active ? (i + 1) * 60 : null,
        informational: {},
      });
    }
    const mock = installMockFetch(routes({ clocks: many }));
    renderPage();
    await screen.findByText("Open escalations");

    await waitFor(() =>
      expect(
        document.querySelectorAll('[data-testid="clocks-table"] tbody tr[data-row-id]'),
      ).toHaveLength(115),
    );
    // The mock caps pages at 50, so each variant needed two pages: 4 calls in all.
    const calls = mock.calls.filter((c) => c.path === "/api/v1/sae-clocks");
    expect(calls).toHaveLength(4);
    expect(mock.fn).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/v1\/sae-clocks\?active=true&limit=\d+&offset=50$/),
      expect.anything(),
    );
    expect(mock.fn).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/v1\/sae-clocks\?active=true&limit=\d+&offset=0$/),
      expect.anything(),
    );
    expect(mock.fn).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/v1\/sae-clocks\?active=false&limit=\d+&offset=0$/),
      expect.anything(),
    );
    const tiles = screen
      .getAllByRole("definition")
      .map((d) => d.textContent)
      .join(" | ");
    expect(tiles).toContain("60");
  });

  it("accepts a bare array from GET /sae-clocks (contract ambiguity) without looping", async () => {
    signIn("coordinator");
    const mock = installMockFetch(routes({ bareClockArray: true }));
    renderPage();
    await screen.findByText("Open escalations");
    expect(
      document.querySelectorAll('[data-testid="clocks-table"] tbody tr[data-row-id]'),
    ).toHaveLength(3);
    expect(mock.find("GET", "/api/v1/sae-clocks")).toHaveLength(2);
  });

  it("keeps acknowledged-away rows reachable: offset is clamped when the page shrinks", async () => {
    signIn("coordinator");
    // 26 open rows: page 1 holds 25, page 2 holds the single oldest row.
    const openRows: EscalationRow[] = [];
    for (let i = 0; i < 26; i++) {
      openRows.push({
        id: `01JESC${String(i).padStart(20, "0")}`,
        session_id: SESSION_A,
        note_id: null,
        usubjid: `R2810-ONC-1624-P-${String(i).padStart(3, "0")}`,
        tier: 2,
        tier_name: "Nurse call today",
        reasons: ["Provisional grade 3 for Nausea"],
        source: "check_in",
        created_at: new Date(Date.parse("2026-10-10T00:00:00.000Z") + i * 60_000).toISOString(),
        paged_at: null,
        acked_by: null,
        acked_at: null,
        seconds_to_ack: null,
      });
    }
    const mock = installMockFetch(routes({ escalations: openRows }));
    renderPage();
    const user = userEvent.setup();
    await screen.findByText("Open escalations");
    expect(
      document.querySelectorAll('[data-testid="escalations-table"] tbody tr[data-row-id]'),
    ).toHaveLength(25);

    await user.click(screen.getByRole("button", { name: "Next" }));
    const page2 = document.querySelectorAll(
      '[data-testid="escalations-table"] tbody tr[data-row-id]',
    );
    expect(page2).toHaveLength(1);
    const lastId = page2[0].getAttribute("data-row-id") as string;

    await user.click(screen.getByRole("button", { name: /Acknowledge escalation for/ }));
    await waitFor(() =>
      expect(mock.find("POST", `/api/v1/escalations/${lastId}/ack`)).toHaveLength(1),
    );

    // 25 open rows remain: all of them are on (the now only) page 1, the
    // pagination control is gone, and the empty state is NOT shown.
    await waitFor(() =>
      expect(
        document.querySelectorAll('[data-testid="escalations-table"] tbody tr[data-row-id]'),
      ).toHaveLength(25),
    );
    expect(screen.queryByText(/No open escalations/)).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Pagination" })).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Open \(25\)/ })).toBeInTheDocument();
  });

  it("renders each summary tile as a valid <dl> (no <section> between dl and dt/dd)", async () => {
    signIn("coordinator");
    installMockFetch(routes());
    renderPage();
    await screen.findByText("Open escalations");
    // Every <dl> on the page (the 4 tiles plus the SAE-clock deadline lists)
    // follows the content model: children are <div> wrappers, never <section>.
    const lists = document.querySelectorAll("dl");
    expect(lists.length).toBeGreaterThanOrEqual(4);
    for (const dl of Array.from(lists)) {
      for (const child of Array.from(dl.children)) expect(child.tagName).toBe("DIV");
      expect(dl.querySelector("dt")).not.toBeNull();
      expect(dl.querySelectorAll("dd").length).toBeGreaterThan(0);
      expect(dl.querySelector("section")).toBeNull();
    }
    // Each tile label is a <dt> whose own <dl> sits inside the Card, not around it.
    for (const label of [
      "Open escalations",
      "Median time to acknowledge",
      "Active SAE clocks",
      "Pages sent",
    ]) {
      const dt = screen.getByText(label);
      expect(dt.tagName).toBe("DT");
      const dl = dt.closest("dl") as HTMLElement;
      expect(dl.parentElement?.closest("section")).not.toBeNull();
      expect(dt.closest("dl > div")).not.toBeNull();
    }
    // Every dt/dd still resolves to its own list (what assistive tech associates).
    for (const dd of Array.from(document.querySelectorAll("dd"))) {
      expect(dd.closest("dl")).not.toBeNull();
    }
  });

  it("shows a MEASURED / SIMULATED badge beside the reasons when the API sends vitals provenance", async () => {
    signIn("coordinator");
    const withProvenance: EscalationRow[] = [
      { ...ESCALATIONS[0], vitals_is_measured: false },
      { ...ESCALATIONS[2], vitals_is_measured: true },
    ];
    installMockFetch(routes({ escalations: withProvenance }));
    renderPage();
    await screen.findByText("Open escalations");
    const rows = document.querySelectorAll(
      '[data-testid="escalations-table"] tbody tr[data-row-id]',
    );
    expect(within(rows[0] as HTMLElement).getByText("SIMULATED")).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText("MEASURED")).toBeInTheDocument();
    expect(
      within(rows[0] as HTMLElement).getByText(/vitals used by the rules/),
    ).toBeInTheDocument();
  });

  it("claims nothing about vitals provenance when the API does not send it", async () => {
    signIn("coordinator");
    installMockFetch(routes());
    renderPage();
    await screen.findByText("Open escalations");
    expect(screen.queryByText(/vitals used by the rules/)).not.toBeInTheDocument();
    expect(document.querySelector("[data-measured]")).toBeNull();
  });

  it("keeps the sections that loaded when one endpoint fails (partial failure)", async () => {
    signIn("coordinator");
    installMockFetch(routes({ pagesStatus: 500 }));
    renderPage();
    const user = userEvent.setup();
    await screen.findByText("Open escalations");

    // Escalations and SAE clocks render normally ...
    expect(
      document.querySelectorAll('[data-testid="escalations-table"] tbody tr[data-row-id]'),
    ).toHaveLength(2);
    expect(
      document.querySelectorAll('[data-testid="clocks-table"] tbody tr[data-row-id]'),
    ).toHaveLength(3);
    // ... only the pager section carries an alert, with retry ...
    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent(/Could not load the pager log/);
    expect(alerts[0]).toHaveTextContent(/HTTP 500/);
    expect(within(alerts[0]).getByRole("button", { name: "Try again" })).toBeInTheDocument();
    // ... and its tile is honest about not having a number.
    const tiles = screen.getAllByRole("definition").map((d) => d.textContent);
    expect(tiles.join(" | ")).toContain("could not load");
    expect(tiles.join(" | ")).toContain("of 3 total");

    // Acknowledging still works while another section is down.
    await user.click(
      screen.getByRole("button", { name: "Acknowledge escalation for R2810-ONC-1624-P-007" }),
    );
    expect(
      await screen.findByText("Escalation acknowledged for R2810-ONC-1624-P-007"),
    ).toBeInTheDocument();
  });

  it("shows the SAE-clock section error alone when only /sae-clocks fails", async () => {
    signIn("coordinator");
    installMockFetch(routes({ clocksStatus: 503 }));
    renderPage();
    await screen.findByText("Open escalations");
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/Could not load SAE clocks/);
    expect(
      document.querySelectorAll('[data-testid="escalations-table"] tbody tr[data-row-id]'),
    ).toHaveLength(2);
    expect(
      document.querySelectorAll('[data-testid="pager-table"] tbody tr[data-row-id]'),
    ).toHaveLength(1);
    expect(
      screen
        .getAllByRole("definition")
        .map((d) => d.textContent)
        .join(" | "),
    ).toContain("could not load");
  });

  it("collapses to one banner when every endpoint fails", async () => {
    signIn("coordinator");
    const mock = installMockFetch(
      routes({ escalationsStatus: 500, clocksStatus: 500, pagesStatus: 500 }),
    );
    renderPage();
    const user = userEvent.setup();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/Could not load escalations, SAE clocks or the pager log/);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.queryByText("Open escalations")).not.toBeInTheDocument();
    const before = mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(mock.calls.length).toBeGreaterThan(before));
  });

  it("shows empty states", async () => {
    signIn("coordinator");
    installMockFetch(routes({ escalations: [], clocks: [], pages: [] }));
    renderPage();
    expect(await screen.findByText(/No open escalations/)).toBeInTheDocument();
    expect(screen.getByText(/No SAE clock has been started/)).toBeInTheDocument();
    expect(screen.getByText(/No pages sent/)).toBeInTheDocument();
    const text = screen
      .getAllByRole("definition")
      .map((d) => d.textContent)
      .join(" ");
    expect(text).toContain("No acknowledgements yet");
    expect(text).toContain("No clock running");
  });

  it("shows an error with retry when the API fails", async () => {
    signIn("coordinator");
    const mock = installMockFetch(routes({ escalationsStatus: 500 }));
    renderPage();
    const user = userEvent.setup();
    expect(await screen.findByRole("alert")).toHaveTextContent(/Could not load escalations/);
    expect(screen.getByRole("alert")).toHaveTextContent(/HTTP 500/);

    // Retry refetches.
    const before = mock.find("GET", "/api/v1/escalations").length;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(mock.find("GET", "/api/v1/escalations").length).toBeGreaterThan(before),
    );
  });
});
