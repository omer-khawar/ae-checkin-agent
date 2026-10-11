/**
 * Participant timeline page against a mocked API (no server running).
 * Recharts renders inside jsdom via `initialDimension`; assertions go through
 * the table-view twins and lists so they do not depend on SVG layout.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AUTH_STORAGE_KEY } from "../../../../lib/api";
import { resetAuthCache } from "../../../../lib/auth";
import { ITEMS } from "../../../../test/fixtures";
import { installMockFetch, type Route as MockRoute } from "../../../../test/mockFetch";
import { ParticipantTimeline } from "../../ParticipantTimeline";
import type { Timeline } from "../../../../lib/types";

/**
 * jsdom has no ResizeObserver and lays nothing out, and Recharts'
 * ResponsiveContainer needs both: it subscribes to a ResizeObserver on mount
 * and replaces `initialDimension` with `getBoundingClientRect()` (0 x 0 in
 * jsdom, after which it renders no chart at all). A no-op observer plus a
 * fixed 480 x 150 rect let the SVG points render so the dot-level assertions
 * (per-point words, dot clicks) can run. Scoped to this file so the shared
 * test setup stays untouched.
 */
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
const g = globalThis as unknown as { ResizeObserver?: unknown };
let savedResizeObserver: unknown;
let savedRect: typeof HTMLElement.prototype.getBoundingClientRect;
beforeAll(() => {
  savedResizeObserver = g.ResizeObserver;
  g.ResizeObserver = NoopResizeObserver;
  savedRect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function rect(this: HTMLElement) {
    const w = this.classList.contains("recharts-responsive-container") ? 480 : 0;
    const h = w ? 150 : 0;
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: w,
      bottom: h,
      width: w,
      height: h,
      toJSON: () => ({}),
    } as DOMRect;
  };
});
afterAll(() => {
  g.ResizeObserver = savedResizeObserver;
  HTMLElement.prototype.getBoundingClientRect = savedRect;
});

const USUBJID = "R2810-ONC-1624-P-007";
const S1 = "01JSESSION00000000000000A";
const S2 = "01JSESSION00000000000000B";
const S3 = "01JSESSION00000000000000C";

function timeline(overrides: Partial<Timeline> = {}): Timeline {
  return {
    participant: {
      usubjid: USUBJID,
      study_id: "R2810-ONC-1624",
      enrolled_at: "2026-08-01T12:00:00.000Z",
      display_label: "P-007",
    },
    sessions: [
      {
        id: S1,
        usubjid: USUBJID,
        study_id: "R2810-ONC-1624",
        started_at: "2026-09-20T14:00:00.000Z",
        completed_at: "2026-09-20T14:06:00.000Z",
        consent_camera: true,
        vitals_status: "simulated_ignored",
        tier: 0,
        stop_screen_shown: false,
        is_eval: false,
      },
      {
        id: S2,
        usubjid: USUBJID,
        study_id: "R2810-ONC-1624",
        started_at: "2026-10-05T14:00:00.000Z",
        completed_at: "2026-10-05T14:07:00.000Z",
        consent_camera: true,
        vitals_status: "ok",
        tier: 2,
        stop_screen_shown: false,
        is_eval: false,
      },
      {
        id: S3,
        usubjid: USUBJID,
        study_id: "R2810-ONC-1624",
        started_at: "2026-10-10T14:00:00.000Z",
        completed_at: null,
        consent_camera: false,
        vitals_status: "declined",
        tier: null,
        stop_screen_shown: false,
        is_eval: false,
      },
    ],
    symptom_series: {
      shortness_of_breath: [
        { session_id: S1, ts: "2026-09-20T14:06:00.000Z", composite: 0, grade: 0 },
        { session_id: S2, ts: "2026-10-05T14:07:00.000Z", composite: 2, grade: 2 },
      ],
      cough: [{ session_id: S2, ts: "2026-10-05T14:07:00.000Z", composite: 1, grade: 1 }],
    },
    vitals_series: [
      {
        session_id: S1,
        ts: "2026-09-20T14:06:00.000Z",
        pulse_median: 72,
        breathing_median: 14,
        is_measured: false,
        source: "mock",
      },
      {
        session_id: S2,
        ts: "2026-10-05T14:07:00.000Z",
        pulse_median: 98,
        breathing_median: 26,
        is_measured: true,
        source: "presage",
      },
    ],
    open_aes: [
      {
        id: "01JAEOPEN0000000000000001",
        usubjid: USUBJID,
        aedecod: "Cough",
        first_session_id: S1,
        last_session_id: S2,
        ongoing: true,
      },
    ],
    conmed_changes: [
      {
        session_id: S2,
        ts: "2026-10-05T14:07:00.000Z",
        cmtrt: "loratadine",
        cmdecod: "loratadine",
        direction: "started",
        confidence: 1,
      },
      {
        session_id: S1,
        ts: "2026-09-20T14:06:00.000Z",
        cmtrt: "zzyzx drops",
        cmdecod: null,
        direction: null,
        confidence: 0,
      },
    ],
    notes: [
      {
        id: "01JNOTE00000000000000001",
        note_date: "2026-10-02",
        author: "Dr. Example",
        note_type: "progress",
        ingested_at: "2026-10-03T09:00:00.000Z",
        text: "Patient reports mild cough. No dyspnea.",
      },
    ],
    ...overrides,
  };
}

function routes(data: unknown, status = 200, itemsStatus = 200): MockRoute[] {
  return [
    {
      method: "GET",
      path: "/api/v1/items",
      handler: () =>
        itemsStatus >= 400
          ? {
              status: itemsStatus,
              json: { type: "about:blank", title: "Down", status: itemsStatus },
            }
          : { json: ITEMS },
    },
    {
      method: "GET",
      path: new RegExp(`^/api/v1/participants/${USUBJID}/timeline$`),
      handler: () =>
        status >= 400
          ? {
              status,
              json: { type: "about:blank", title: "Server Error", status, detail: "boom" },
            }
          : { json: data },
    },
  ];
}

function renderPage(tab = "overview", usubjid = USUBJID) {
  const qs = tab === "overview" ? "" : `?tab=${tab}`;
  return render(
    <MemoryRouter initialEntries={[`/dashboard/participants/${usubjid}${qs}`]}>
      <Routes>
        <Route path="/dashboard/participants/:usubjid" element={<ParticipantTimeline />} />
        <Route path="/dashboard/checkins/:sessionId" element={<h1>Detail page</h1>} />
        <Route path="/dashboard" element={<h1>Queue page</h1>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ParticipantTimeline", () => {
  it("renders the header, synthetic label and enrolment date", async () => {
    installMockFetch(routes(timeline()));
    renderPage();
    expect(await screen.findByRole("heading", { level: 1, name: /P-007/ })).toBeInTheDocument();
    expect(screen.getByText("Synthetic participant")).toBeInTheDocument();
    expect(screen.getByText(USUBJID)).toBeInTheDocument();
    // Enrolled time: local text with UTC on hover (title).
    expect(screen.getByTitle("2026-08-01T12:00:00.000Z (UTC)")).toBeInTheDocument();
  });

  it("labels sparklines from the items table and lists grades in the table view", async () => {
    installMockFetch(routes(timeline()));
    renderPage("symptoms");
    const sob = await screen.findByTestId("sparkline-shortness_of_breath");
    // Label and CTCAE term from GET /items, not the raw id.
    expect(within(sob).getByRole("heading", { name: "Shortness of breath" })).toBeInTheDocument();
    expect(within(sob).getByText("Dyspnea")).toBeInTheDocument();
    expect(within(sob).getByTestId("latest-grade")).toHaveTextContent("G2"); // endpoint direct label
    const table = within(sob).getByRole("table", { hidden: true });
    const rows = within(table).getAllByRole("row", { hidden: true });
    expect(rows).toHaveLength(3); // header + 2 points
    const links = within(table).getAllByRole("link", { hidden: true, name: "Open" });
    expect(links[1]).toHaveAttribute("href", `/dashboard/checkins/${S2}`);
    // An item in the table with no points still renders with an empty state.
    const rash = screen.getByTestId("sparkline-rash");
    expect(within(rash).getByText("No reports yet")).toBeInTheDocument();
  });

  it("falls back to humanised item ids when GET /items fails", async () => {
    installMockFetch(routes(timeline(), 200, 500));
    renderPage("symptoms");
    const sob = await screen.findByTestId("sparkline-shortness_of_breath");
    expect(within(sob).getByRole("heading", { name: "Shortness of breath" })).toBeInTheDocument();
    expect(screen.queryByTestId("sparkline-rash")).not.toBeInTheDocument();
  });

  it("shows vitals with MEASURED / SIMULATED words, source and a legend", async () => {
    installMockFetch(routes(timeline()));
    renderPage("symptoms");
    await screen.findByTestId("vitals-chart-pulse_median");
    expect(screen.getByTestId("vitals-chart-breathing_median")).toBeInTheDocument();
    const legend = screen.getByRole("list", { name: "Legend" });
    expect(within(legend).getByText("MEASURED")).toBeInTheDocument();
    expect(within(legend).getByText("SIMULATED")).toBeInTheDocument();
    const table = screen.getByTestId("vitals-table");
    const body = within(table).getAllByRole("row", { hidden: true }).slice(1);
    expect(body).toHaveLength(2);
    expect(within(body[0]).getByText("72")).toBeInTheDocument();
    expect(within(body[0]).getByText("SIMULATED")).toBeInTheDocument();
    expect(within(body[0]).getByText("mock")).toBeInTheDocument();
    expect(within(body[1]).getByText("26")).toBeInTheDocument();
    expect(within(body[1]).getByText("MEASURED")).toBeInTheDocument();
    expect(within(body[1]).getByText("presage")).toBeInTheDocument();
  });

  it("lists open AEs, con-med changes, chart notes and sessions with tier chips", async () => {
    const user = userEvent.setup();
    installMockFetch(routes(timeline()));
    renderPage();
    const aes = await screen.findByTestId("open-aes");
    expect(within(aes).getByText("Cough")).toBeInTheDocument();
    expect(within(aes).getByText("Ongoing")).toBeInTheDocument();
    expect(within(aes).getByRole("link", { name: "First check-in" })).toHaveAttribute(
      "href",
      `/dashboard/checkins/${S1}`,
    );
    expect(within(aes).getByRole("link", { name: "Latest follow-up" })).toHaveAttribute(
      "href",
      `/dashboard/checkins/${S2}`,
    );

    await user.click(screen.getByRole("radio", { name: /^Medicines/ }));
    const cm = screen.getByTestId("conmeds");
    expect(within(cm).getByText('"loratadine"')).toBeInTheDocument();
    expect(within(cm).getByText("Started")).toBeInTheDocument();
    expect(within(cm).getByText("100%")).toBeInTheDocument();
    expect(within(cm).getByText("Unmatched, verbatim kept")).toBeInTheDocument();
    expect(within(cm).getByText("Not stated")).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /^Notes & calls/ }));
    const notes = screen.getByTestId("chart-notes");
    expect(within(notes).getByText("Dr. Example")).toBeInTheDocument();
    expect(within(notes).getByText("progress")).toBeInTheDocument();
    expect(within(notes).getByText("Patient reports mild cough. No dyspnea.")).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /^Reports/ }));
    const sessions = screen.getByTestId("sessions");
    const rows = within(sessions).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    // Newest first: the in-progress session (started Oct 10) leads.
    expect(within(rows[0]).getByText(/In progress/)).toBeInTheDocument();
    expect(within(rows[0]).getByText("not yet evaluated")).toBeInTheDocument();
    expect(within(rows[0]).getByText("Camera off")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Nurse call today")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Log")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Simulated (ignored for rules)")).toBeInTheDocument();
    expect(within(rows[1]).getByRole("link", { name: "Open" })).toHaveAttribute(
      "href",
      `/dashboard/checkins/${S2}`,
    );
  });

  it("navigates to the check-in detail from a table-view link", async () => {
    const user = userEvent.setup();
    installMockFetch(routes(timeline()));
    renderPage("reports");
    const sessions = await screen.findByTestId("sessions");
    await user.click(within(sessions).getAllByRole("link", { name: "Open" })[1]);
    expect(await screen.findByRole("heading", { name: "Detail page" })).toBeInTheDocument();
  });

  it("renders empty states when the participant has nothing yet and optional arrays are missing", async () => {
    const bare = {
      participant: timeline().participant,
      sessions: [],
      symptom_series: {},
      vitals_series: [],
      open_aes: [],
      conmed_changes: [],
      // notes[] intentionally absent (pre-R2.4 API)
    };
    installMockFetch(routes(bare, 200, 500));
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText("No AE records.")).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: /^Symptoms/ }));
    expect(screen.getByText("No symptom reports yet for this participant.")).toBeInTheDocument();
    expect(screen.getByText(/No vitals recorded/)).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: /^Medicines/ }));
    expect(screen.getByText("No medication changes reported.")).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: /^Notes & calls/ }));
    expect(
      screen.getByText("No chart notes or phone calls yet for this participant."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: /^Reports/ }));
    expect(screen.getByText("No check-ins yet.")).toBeInTheDocument();
  });

  it("switches sections with the number keys, ignores them while typing, and B opens the brief", async () => {
    const user = userEvent.setup();
    installMockFetch(routes(timeline()));
    render(
      <MemoryRouter initialEntries={[`/dashboard/participants/${USUBJID}`]}>
        <Routes>
          <Route path="/dashboard/participants/:usubjid" element={<ParticipantTimeline />} />
          <Route path="/dashboard/participants/:usubjid/brief" element={<h1>Brief page</h1>} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByTestId("open-aes");
    await user.keyboard("3");
    expect(await screen.findByTestId("conmeds")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^Medicines/ })).toBeChecked();
    await user.keyboard("5");
    expect(await screen.findByTestId("sessions")).toBeInTheDocument();
    await user.keyboard("1");
    expect(await screen.findByTestId("open-aes")).toBeInTheDocument();
    // Typing in the call form must not switch sections.
    await user.click(screen.getByRole("button", { name: "Log a call" }));
    await user.click(screen.getByRole("textbox", { name: "Call summary" }));
    await user.keyboard("2");
    expect(screen.getByTestId("open-aes")).toBeInTheDocument();
    (document.activeElement as HTMLElement).blur();
    await user.keyboard("b");
    expect(await screen.findByRole("heading", { name: "Brief page" })).toBeInTheDocument();
  });

  it("shows the problem+json error with a retry that reloads", async () => {
    const user = userEvent.setup();
    let attempts = 0;
    installMockFetch([
      { method: "GET", path: "/api/v1/items", handler: () => ({ json: ITEMS }) },
      {
        method: "GET",
        path: new RegExp(`^/api/v1/participants/${USUBJID}/timeline$`),
        handler: () => {
          attempts += 1;
          return attempts === 1
            ? {
                status: 500,
                json: { type: "about:blank", title: "Server Error", status: 500, detail: "boom" },
              }
            : { json: timeline() };
        },
      },
    ]);
    renderPage();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(`Could not load the timeline for ${USUBJID}`);
    expect(alert).toHaveTextContent("HTTP 500");
    expect(alert).toHaveTextContent("boom");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(attempts).toBe(2));
    expect(await screen.findByRole("heading", { level: 1, name: /P-007/ })).toBeInTheDocument();
  });

  it("renders a date-only note_date as the same calendar date in every timezone", async () => {
    installMockFetch(routes(timeline()));
    renderPage("notes");
    const notes = await screen.findByTestId("chart-notes");
    // "2026-10-02" is a calendar date, not UTC midnight: it must never show as
    // Oct 01 (what a local-time formatter prints anywhere west of Greenwich).
    const date = within(notes).getByText(/Oct 02, 2026/);
    expect(date.tagName).toBe("TIME");
    expect(date).toHaveAttribute("datetime", "2026-10-02");
    expect(date).toHaveAttribute("title", "2026-10-02 (calendar date, no time of day)");
    expect(within(notes).queryByText(/Oct 01/)).not.toBeInTheDocument();
    // ingested_at is a real instant and keeps the local-time + UTC-on-hover treatment.
    expect(within(notes).getByTitle("2026-10-03T09:00:00.000Z (UTC)")).toBeInTheDocument();
  });

  it("falls back to <Time> when note_date is a full datetime and to 'Undated' when missing", async () => {
    installMockFetch(
      routes(
        timeline({
          notes: [
            { id: "01JNOTE00000000000000002", note_date: "2026-10-02T15:30:00.000Z", author: "A" },
            { id: "01JNOTE00000000000000003", note_date: null, author: "B" },
          ],
        }),
      ),
    );
    renderPage("notes");
    const notes = await screen.findByTestId("chart-notes");
    expect(within(notes).getByTitle("2026-10-02T15:30:00.000Z (UTC)")).toBeInTheDocument();
    expect(within(notes).getByText("Undated")).toBeInTheDocument();
  });

  it("counts only ongoing AEs as open, in both the header chip and the card", async () => {
    installMockFetch(
      routes(
        timeline({
          open_aes: [
            {
              id: "01JAEOPEN0000000000000001",
              usubjid: USUBJID,
              aedecod: "Cough",
              first_session_id: S1,
              last_session_id: S2,
              ongoing: true,
            },
            {
              id: "01JAEOPEN0000000000000002",
              usubjid: USUBJID,
              aedecod: "Rash",
              first_session_id: S1,
              last_session_id: S1,
              ongoing: false,
            },
          ],
        }),
      ),
    );
    renderPage();
    const aes = await screen.findByTestId("open-aes");
    const summary = screen.getByRole("list", { name: "Summary" });
    expect(within(summary).getByText("open side effects").closest("li")).toHaveTextContent(
      "1 open side effects",
    );
    expect(screen.getByTestId("ae-count")).toHaveTextContent("1 open · 1 resolved");
    expect(screen.getByText("Side effects (open and resolved)")).toBeInTheDocument();
    // The resolved record is still listed, badged Resolved.
    expect(within(aes).getByText("Rash")).toBeInTheDocument();
    expect(within(aes).getByText("Resolved")).toBeInTheDocument();
    expect(within(aes).getByText("Ongoing")).toBeInTheDocument();
  });

  it("labels every vitals point with the word MEASURED or SIMULATED and opens the table for a mixed series", async () => {
    installMockFetch(routes(timeline()));
    renderPage("symptoms");
    const pulse = await screen.findByTestId("vitals-plot-pulse_median");
    const labels = within(pulse)
      .getAllByTestId("point-label")
      .map((el) => el.textContent);
    expect(labels).toEqual(["SIMULATED", "MEASURED"]); // chronological: mock first, presage second
    // Mixed measured + simulated → the table twin (badge + source per row) starts expanded.
    expect(screen.getByTestId("vitals-table-details")).toHaveAttribute("open");
  });

  it("keeps the vitals table collapsed when every point has the same provenance", async () => {
    const simulatedOnly = timeline().vitals_series.map((v) => ({
      ...v,
      is_measured: false,
      source: "mock",
    }));
    installMockFetch(routes(timeline({ vitals_series: simulatedOnly })));
    renderPage("symptoms");
    await screen.findByTestId("vitals-plot-pulse_median");
    expect(screen.getByTestId("vitals-table-details")).not.toHaveAttribute("open");
  });

  it("navigates only from a plotted dot, not from a click on the plot background", async () => {
    const user = userEvent.setup();
    installMockFetch(routes(timeline()));
    renderPage("symptoms");
    const plot = await screen.findByTestId("sparkline-plot-shortness_of_breath");
    // The wrapper is described by its table twin (the keyboard route to the same links).
    expect(plot).toHaveAttribute("aria-describedby", "symptom-table-shortness_of_breath");
    expect(document.getElementById("symptom-table-shortness_of_breath")).not.toBeNull();

    await user.click(plot); // background click: nothing happens
    expect(screen.queryByRole("heading", { name: "Detail page" })).not.toBeInTheDocument();

    const dot = plot.querySelector(`circle[data-session-id="${S2}"]`);
    expect(dot).not.toBeNull();
    await user.click(dot as Element);
    expect(await screen.findByRole("heading", { name: "Detail page" })).toBeInTheDocument();
  });

  it("navigates from a vitals dot to that check-in", async () => {
    const user = userEvent.setup();
    installMockFetch(routes(timeline()));
    renderPage("symptoms");
    const plot = await screen.findByTestId("vitals-plot-breathing_median");
    const dot = plot.querySelector(`g[data-session-id="${S1}"] circle`);
    expect(dot).not.toBeNull();
    await user.click(dot as Element);
    expect(await screen.findByRole("heading", { name: "Detail page" })).toBeInTheDocument();
  });

  it("sends the bearer token when one is stored", async () => {
    sessionStorage.setItem(
      "interim.auth",
      JSON.stringify({
        token: "tok.coordinator.9999999999.sig",
        role: "coordinator",
        display_name: "C",
        expires_at: "2999-01-01T00:00:00.000Z",
      }),
    );
    const mock = installMockFetch(routes(timeline()));
    renderPage("reports");
    await screen.findByTestId("sessions");
    const call = mock.find("GET", new RegExp(`^/api/v1/participants/${USUBJID}/timeline$`))[0];
    expect(call.headers.authorization).toBe("Bearer tok.coordinator.9999999999.sig");
  });
});

describe("ParticipantTimeline · visit brief and phone calls (R3.3 / R4.1)", () => {
  function signInCoordinator() {
    sessionStorage.setItem(
      AUTH_STORAGE_KEY,
      JSON.stringify({
        token: "t",
        role: "coordinator",
        display_name: "Dana",
        expires_at: "2099-01-01T00:00:00.000Z",
      }),
    );
    resetAuthCache();
  }

  it("links to the visit brief for this participant", async () => {
    installMockFetch(routes(timeline()));
    renderPage();
    const brief = await screen.findByRole("link", { name: "Visit brief" });
    expect(brief).toHaveAttribute("href", `/dashboard/participants/${USUBJID}/brief`);
  });

  it("logs a call for this participant and reloads the timeline", async () => {
    signInCoordinator();
    const mock = installMockFetch([
      ...routes(timeline()),
      {
        method: "POST",
        path: "/api/v1/notes",
        handler: () => ({
          json: {
            note: { id: "01JCALL", usubjid: USUBJID, note_type: "phone_call" },
            scan: {},
            drafts: [],
            escalation: null,
            sae_clock: null,
            rules_fired: [],
            why: [],
          },
        }),
      },
    ]);
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("heading", { level: 1, name: /P-007/ });
    const loadsBefore = mock.find("GET", `/api/v1/participants/${USUBJID}/timeline`).length;
    await user.click(screen.getByRole("button", { name: "Log a call" }));
    const form = screen.getByRole("form", { name: "Log a call" });
    await user.type(
      within(form).getByRole("textbox", { name: "Call summary" }),
      "Participant called: itchy rash on both arms.",
    );
    await user.click(within(form).getByRole("button", { name: "Log call" }));
    await waitFor(() => expect(mock.find("POST", "/api/v1/notes")).toHaveLength(1));
    expect(mock.find("POST", "/api/v1/notes")[0].body).toMatchObject({
      usubjid: USUBJID,
      note_type: "phone_call",
      caller: "participant",
      call_direction: "inbound",
      text: "Participant called: itchy rash on both arms.",
    });
    await waitFor(() =>
      expect(mock.find("GET", `/api/v1/participants/${USUBJID}/timeline`).length).toBeGreaterThan(
        loadsBefore,
      ),
    );
  });

  it("lists a logged call with the phone label and who called", async () => {
    installMockFetch(
      routes(
        timeline({
          notes: [
            {
              id: "01JCALL",
              note_date: "2026-10-09",
              author: "Dana",
              note_type: "phone_call",
              caller: "caregiver",
              call_direction: "inbound",
            },
          ],
        }),
      ),
    );
    renderPage("notes");
    const notes = await screen.findByTestId("chart-notes");
    expect(within(notes).getByTestId("phone-call-label")).toHaveTextContent("Phone call");
    expect(within(notes).getByText("Caregiver · they called the site")).toBeInTheDocument();
    expect(within(notes).getByRole("link", { name: "Open call" })).toHaveAttribute(
      "href",
      "/dashboard/notes/01JCALL",
    );
  });
});
