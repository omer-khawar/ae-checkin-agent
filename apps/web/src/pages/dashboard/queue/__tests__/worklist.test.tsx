/**
 * Worklist interactions (UI phase 2): view tabs, j/k/Enter, multi-select, the
 * "Confirm all drafts (N)" sheet and the c / r page shortcuts. Same mocked API as
 * Queue.test.tsx; the confirm endpoint is POST /drafts/:id/confirm, once per draft.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";

import { ToastProvider } from "../../../../components/Toast";
import { AUTH_STORAGE_KEY } from "../../../../lib/api";
import type { QueueItem } from "../../../../lib/types";
import { installMockFetch, type Route as MockRoute } from "../../../../test/mockFetch";
import { Queue } from "../../Queue";
import { canBulkSelect } from "../bulk";
import { normalizeQueueItem } from "../normalize";

const STUDY = "R2810-ONC-1624";

const CHECK_IN: QueueItem = {
  session_id: "01JSESSION00000000000000A",
  usubjid: `${STUDY}-P-007`,
  display_label: "P-007",
  completed_at: "2026-10-10T18:04:12.345Z",
  tier: 1,
  tier_name: "Review within 1 business day",
  max_grade: 2,
  vitals_status: "ok",
  is_measured: false,
  has_sae_clock: false,
  sae_due_at: null,
  escalation_acked: null,
  draft_counts: { AE: 1, VS: 1, CM: 0 },
  draft_status_summary: "2 draft",
  source: "check_in",
};

const NOTE_T1: QueueItem = {
  ...CHECK_IN,
  session_id: null,
  note_id: "01JNOTE000000000000000001",
  source: "chart_note",
  usubjid: `${STUDY}-P-003`,
  display_label: "P-003",
  completed_at: "2026-10-10T12:00:00.000Z",
  vitals_status: "unavailable",
  draft_counts: { AE: 1, VS: 0, CM: 1 },
  draft_status_summary: "2 draft",
};

const URGENT: QueueItem = {
  ...CHECK_IN,
  session_id: "01JSESSION00000000000000C",
  display_label: "P-009",
  usubjid: `${STUDY}-P-009`,
  tier: 3,
  tier_name: "Urgent",
  escalation_acked: false,
  has_sae_clock: true,
  clock_kind: "sae",
  sae_due_at: new Date(Date.now() + 22 * 3600_000).toISOString(),
};

function draft(id: string, domain: string, status = "draft") {
  return {
    id,
    domain,
    status,
    session_id: "s",
    usubjid: "u",
    version: 1,
    fields: {},
    evidence: {},
  };
}

function routes(
  items: QueueItem[],
  onConfirm: (id: string) => void = () => undefined,
): MockRoute[] {
  return [
    {
      method: "GET",
      path: "/api/v1/participants",
      handler: () => ({ json: { items: [], total: 0, limit: 100, offset: 0 } }),
    },
    {
      method: "GET",
      path: "/api/v1/queries",
      handler: () => ({ json: { items: [], total: 0, limit: 1, offset: 0 } }),
    },
    {
      method: "GET",
      path: "/api/v1/queue",
      handler: () => ({ json: { items, total: items.length, limit: 25, offset: 0 } }),
    },
    {
      method: "GET",
      path: /^\/api\/v1\/checkins\/.+/,
      handler: () => ({
        json: { drafts: [draft("D1", "AE"), draft("D2", "VS"), draft("D3", "CM", "confirmed")] },
      }),
    },
    {
      method: "GET",
      path: /^\/api\/v1\/notes\/.+/,
      handler: () => ({ json: { drafts: [draft("D4", "AE"), draft("D5", "CM")] } }),
    },
    {
      method: "POST",
      path: /^\/api\/v1\/drafts\/.+\/confirm$/,
      handler: (ctx) => {
        const id = ctx.url.pathname.split("/")[4];
        onConfirm(id);
        return { json: draft(id, "AE", "confirmed") };
      },
    },
  ];
}

function Probe() {
  const loc = useLocation();
  return <span data-testid="where">{loc.pathname + loc.search}</span>;
}

function renderQueue() {
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
    <MemoryRouter initialEntries={["/dashboard"]}>
      <ToastProvider>
        <Routes>
          <Route path="/dashboard" element={<Queue refreshIntervalMs={60_000} />} />
          <Route path="*" element={<span>detail page</span>} />
        </Routes>
        <Probe />
      </ToastProvider>
    </MemoryRouter>,
  );
}

afterEach(() => localStorage.clear());

describe("worklist: bulk eligibility", () => {
  it("only lets low-risk rows with drafts be ticked", () => {
    expect(canBulkSelect(normalizeQueueItem(CHECK_IN))).toBe(true);
    expect(canBulkSelect(normalizeQueueItem(NOTE_T1))).toBe(true);
    expect(canBulkSelect(normalizeQueueItem(URGENT))).toBe(false);
    expect(canBulkSelect(normalizeQueueItem({ ...CHECK_IN, tier: 2 }))).toBe(false);
    expect(
      canBulkSelect(normalizeQueueItem({ ...CHECK_IN, draft_counts: { AE: 0, VS: 0, CM: 0 } })),
    ).toBe(false);
  });
});

describe("worklist: tabs", () => {
  it("filters the loaded page by view and keeps it in the URL", async () => {
    installMockFetch(routes([CHECK_IN, NOTE_T1, URGENT]));
    const user = userEvent.setup();
    renderQueue();
    const grid = await screen.findByRole("grid");
    expect(within(grid).getAllByRole("row")).toHaveLength(4);

    await user.click(screen.getByRole("radio", { name: /Notes & calls/ }));
    await waitFor(() => expect(within(grid).getAllByRole("row")).toHaveLength(2));
    expect(within(grid).getByRole("link", { name: "P-003" })).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /Serious & special-interest/ }));
    await waitFor(() => expect(within(grid).getAllByRole("row")).toHaveLength(2));
    expect(within(grid).getByRole("link", { name: "P-009" })).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("view=serious");
  });
});

describe("worklist: keyboard", () => {
  it("j moves to the next row and Enter opens it", async () => {
    installMockFetch(routes([CHECK_IN, NOTE_T1]));
    const user = userEvent.setup();
    renderQueue();
    const grid = await screen.findByRole("grid");
    const rows = within(grid).getAllByRole("row").slice(1);
    rows[0].focus();
    await user.keyboard("j");
    expect(rows[1]).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(await screen.findByText("detail page")).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent(
      "/dashboard/notes/01JNOTE000000000000000001",
    );
  });
});

describe("worklist: bulk confirm", () => {
  it("ticks rows, confirms every unconfirmed draft once, then clears the selection", async () => {
    const confirmed: string[] = [];
    const mock = installMockFetch(routes([CHECK_IN, NOTE_T1, URGENT], (id) => confirmed.push(id)));
    const user = userEvent.setup();
    renderQueue();
    await screen.findByRole("grid");

    // The urgent row is locked, not tickable.
    expect(screen.queryByRole("checkbox", { name: /P-009/ })).toBeNull();
    expect(screen.getByRole("img", { name: /P-009.*one at a time/ })).toBeInTheDocument();

    // Wait for each tick to render before the next one: on a slow runner the second click
    // can otherwise land on a row the first re-render has just replaced.
    await user.click(screen.getByRole("checkbox", { name: /Select P-007/ }));
    await waitFor(() =>
      expect(screen.getByRole("toolbar", { name: /selected rows/ })).toHaveTextContent(
        "1 selected",
      ),
    );
    await user.click(screen.getByRole("checkbox", { name: /Select P-003/ }));
    await waitFor(() =>
      expect(screen.getByRole("toolbar", { name: /selected rows/ })).toHaveTextContent(
        "2 selected",
      ),
    );

    await user.click(screen.getByRole("button", { name: "Confirm all drafts (4)" }));
    const sheet = await screen.findByRole("dialog");
    // D1 + D2 (the confirmed D3 is skipped) from the check-in, D4 + D5 from the note.
    const go = await within(sheet).findByRole("button", { name: "Confirm all drafts (4)" });
    await waitFor(() => expect(go).toBeEnabled());
    await user.click(go);

    await waitFor(() => expect(confirmed.sort()).toEqual(["D1", "D2", "D4", "D5"]));
    expect(mock.find("POST", /\/drafts\/.+\/confirm/).length).toBe(4);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByRole("toolbar", { name: /selected rows/ })).toBeNull();
  });

  it("c opens the confirmation sheet once rows are ticked, and does nothing before", async () => {
    installMockFetch(routes([CHECK_IN]));
    const user = userEvent.setup();
    renderQueue();
    await screen.findByRole("grid");
    await user.keyboard("c");
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("checkbox", { name: /Select P-007/ }));
    await user.keyboard("c");
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });
});
