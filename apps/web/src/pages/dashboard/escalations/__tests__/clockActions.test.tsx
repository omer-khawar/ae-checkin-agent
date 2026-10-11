/**
 * Escalations page, R3.2 / R4.3 clock additions: clock kind (SAE / possible
 * AESI), "Open report packet" → POST /packets → packet page, and the
 * investigator's "Record seriousness decision" on a clock with no AE draft.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { ToastProvider } from "../../../../components/Toast";
import { AUTH_STORAGE_KEY } from "../../../../lib/api";
import { resetAuthCache } from "../../../../lib/auth";
import type { ClockRow, Role } from "../../../../lib/types";
import { installMockFetch, type Route as MockRoute } from "../../../../test/mockFetch";
import { Escalations } from "../../Escalations";

const AESI_ID = "01JCLOCKAESI00000000000001";
const NOTE_CLOCK_ID = "01JCLOCKNOTE00000000000002";

function clocks(): ClockRow[] {
  const due = new Date(Date.now() + 3600_000).toISOString();
  return [
    {
      id: AESI_ID,
      session_id: "01JSESSION00000000000000AA",
      note_id: null,
      usubjid: "R2810-ONC-1624-P-004",
      site_awareness_at: "2026-10-10T07:00:00.000Z",
      due_at: due,
      stopped_at: null,
      stopped_by: null,
      decision: null,
      seconds_remaining: 3600,
      informational: {},
      kind: "aesi",
      has_ae_draft: true,
    },
    {
      id: NOTE_CLOCK_ID,
      session_id: null,
      note_id: "01JNOTE000000000000000000C",
      usubjid: "R2810-ONC-1624-P-011",
      site_awareness_at: "2026-10-10T06:00:00.000Z",
      due_at: due,
      stopped_at: null,
      stopped_by: null,
      decision: null,
      seconds_remaining: 3600,
      informational: {},
      kind: "sae",
      has_ae_draft: false,
    },
  ];
}

function routes(extra: MockRoute[] = []): MockRoute[] {
  const empty = { items: [], total: 0, limit: 50, offset: 0 };
  return [
    { method: "GET", path: "/api/v1/escalations", handler: () => ({ json: empty }) },
    { method: "GET", path: "/api/v1/pages", handler: () => ({ json: empty }) },
    {
      method: "GET",
      path: "/api/v1/sae-clocks",
      handler: ({ url }) => {
        const active = url.searchParams.get("active") === "true";
        const items = clocks().filter((c) => (c.stopped_at === null) === active);
        return { json: { items, total: items.length, limit: 50, offset: 0 } };
      },
    },
    ...extra,
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
        <Routes>
          <Route path="/dashboard/escalations" element={<Escalations />} />
          <Route path="/dashboard/packets/:id" element={<p>Packet page stub</p>} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

const row = (id: string) =>
  document.querySelector(`[data-testid="clocks-table"] tr[data-row-id="${id}"]`) as HTMLElement;

describe("Escalations · report clocks (R3.2 / R4.3)", () => {
  it("names each clock's kind and opens the report packet", async () => {
    signIn("coordinator");
    const mock = installMockFetch(
      routes([
        {
          method: "POST",
          path: "/api/v1/packets",
          handler: () => ({ json: { id: "01JPACKETAESI", clock_id: AESI_ID, kind: "aesi" } }),
        },
      ]),
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(row(AESI_ID)).not.toBeNull());
    expect(row(AESI_ID).querySelector('[data-kind="aesi"]')).not.toBeNull();
    expect(row(AESI_ID)).toHaveTextContent(
      "possible special-interest event, investigator to confirm",
    );
    expect(row(NOTE_CLOCK_ID)).toHaveTextContent("possible serious event");
    // The coordinator never sees the investigator-only decision control.
    expect(screen.queryByRole("button", { name: "Record seriousness decision" })).toBeNull();

    await user.click(within(row(AESI_ID)).getByRole("button", { name: "Open report packet" }));
    expect(await screen.findByText("Packet page stub")).toBeInTheDocument();
    expect(mock.find("POST", "/api/v1/packets")[0].body).toEqual({ clock_id: AESI_ID });
  });

  it("lets the investigator stop a clock that has no AE draft, after confirming", async () => {
    signIn("investigator");
    const mock = installMockFetch(
      routes([
        {
          method: "PATCH",
          path: `/api/v1/sae-clocks/${NOTE_CLOCK_ID}/stop`,
          handler: ({ body }) => ({
            json: {
              ...clocks()[1],
              stopped_at: "2026-10-10T08:00:00.000Z",
              stopped_by: "investigator",
              decision: (body as { decision: string }).decision,
              seconds_remaining: null,
            },
          }),
        },
      ]),
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(row(NOTE_CLOCK_ID)).not.toBeNull());
    // Only the clock with no AE draft offers the decision.
    expect(
      within(row(AESI_ID)).queryByRole("button", { name: "Record seriousness decision" }),
    ).toBeNull();
    const target = row(NOTE_CLOCK_ID);
    await user.click(within(target).getByRole("button", { name: "Record seriousness decision" }));
    await user.click(within(target).getByRole("radio", { name: "Not serious" }));
    await user.click(within(target).getByRole("button", { name: "Continue" }));
    expect(within(target).getByTestId("decision-confirm")).toHaveTextContent(
      "R2810-ONC-1624-P-011",
    );
    await user.click(within(target).getByRole("button", { name: "Yes, record decision" }));
    await waitFor(() =>
      expect(mock.find("PATCH", `/api/v1/sae-clocks/${NOTE_CLOCK_ID}/stop`)).toHaveLength(1),
    );
    expect(mock.find("PATCH", `/api/v1/sae-clocks/${NOTE_CLOCK_ID}/stop`)[0].body).toEqual({
      decision: "AESER = N",
    });
    // The row flips to stopped in place.
    await waitFor(() => expect(row(NOTE_CLOCK_ID)).toHaveTextContent(/Stopped by/));
    expect(row(NOTE_CLOCK_ID)).toHaveTextContent("AESER = N");
  });

  it("with the API's real clock shape (no AE-draft hint), hides the decision on AESI clocks and words it neutrally on SAE clocks", async () => {
    signIn("investigator");
    // sae_clock_to_dict sends neither has_ae_draft nor ae_draft_ids.
    const bare = clocks().map(({ has_ae_draft: _h, ...c }) => c);
    installMockFetch([
      ...routes().filter((r) => r.path !== "/api/v1/sae-clocks"),
      {
        method: "GET",
        path: "/api/v1/sae-clocks",
        handler: ({ url }) => {
          const active = url.searchParams.get("active") === "true";
          const items = bare.filter((c) => (c.stopped_at === null) === active);
          return { json: { items, total: items.length, limit: 50, offset: 0 } };
        },
      },
    ]);
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(row(AESI_ID)).not.toBeNull());
    // AESI: answered by "Immune-related? No" on its record, never by AESER here.
    expect(
      within(row(AESI_ID)).queryByRole("button", { name: "Record seriousness decision" }),
    ).toBeNull();
    expect(within(row(AESI_ID)).getByTestId("clock-stop-rule")).toHaveTextContent(
      "Immune-related? No",
    );
    // SAE clock with unknown AE status: offered, without claiming there is no record.
    const target = row(NOTE_CLOCK_ID);
    expect(
      within(target).getByRole("button", { name: "Record seriousness decision" }),
    ).toBeInTheDocument();
    expect(target).not.toHaveTextContent("No side-effect record was drafted");
    expect(within(target).getByTestId("decision-neutral-hint")).toHaveTextContent(
      "Use this only if the source has no side-effect record to attribute",
    );
    expect(within(target).getByRole("link", { name: "open the note" })).toHaveAttribute(
      "href",
      "/dashboard/notes/01JNOTE000000000000000000C",
    );
    expect(within(target).getByTestId("clock-stop-rule")).toHaveTextContent("(AESER)");
    await user.click(within(target).getByRole("button", { name: "Record seriousness decision" }));
    expect(within(target).getByRole("form", { name: "Record seriousness decision" })).toBeVisible();
  });
});
