/**
 * Queries page against a mocked API (R4.4 endpoints do not exist yet). Mounted
 * without the Layout; the footer and nav come from Layout.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { ToastProvider } from "../../../../components/Toast";
import { AUTH_STORAGE_KEY } from "../../../../lib/api";
import { resetAuthCache } from "../../../../lib/auth";
import type { QueryRow, Role } from "../../../../lib/types";
import { installMockFetch, type Route as MockRoute } from "../../../../test/mockFetch";
import QueriesPage from "../QueriesPage";
import {
  ANSWERED_DETAIL,
  ANSWERED_ROW,
  ANSWER_EV,
  CM_DRAFT,
  CMTRT_EV,
  DRAFT_CM,
  OPEN_DETAIL,
  OPEN_DETAIL_CITES_TERM,
  OPEN_ROW,
  SAFETY_DETAIL,
  SAFETY_ROW,
  USUBJID,
} from "./fixtures";

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

const BY_STATUS: Record<string, QueryRow[]> = {
  open: [OPEN_ROW, SAFETY_ROW],
  answered: [ANSWERED_ROW],
  closed: [],
};

function routes(extra: MockRoute[] = []): MockRoute[] {
  return [
    ...extra,
    {
      method: "GET",
      path: "/api/v1/queries",
      handler: ({ url }) => {
        const status = url.searchParams.get("status") ?? "open";
        const rows = BY_STATUS[status] ?? [];
        const limit = Number(url.searchParams.get("limit") ?? 25);
        return { json: { items: rows.slice(0, limit), total: rows.length, limit, offset: 0 } };
      },
    },
    {
      method: "GET",
      path: `/api/v1/queries/${OPEN_ROW.id}`,
      handler: () => ({ json: OPEN_DETAIL }),
    },
    {
      method: "GET",
      path: `/api/v1/queries/${ANSWERED_ROW.id}`,
      handler: () => ({ json: ANSWERED_DETAIL }),
    },
    {
      method: "GET",
      path: `/api/v1/queries/${SAFETY_ROW.id}`,
      handler: () => ({ json: SAFETY_DETAIL }),
    },
    {
      method: "GET",
      path: `/api/v1/drafts/${DRAFT_CM}`,
      handler: () => ({ json: CM_DRAFT }),
    },
  ];
}

function renderPage(path = "/dashboard/queries") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ToastProvider>
        <Routes>
          <Route path="/dashboard/queries" element={<QueriesPage />} />
          <Route path="/dashboard/checkins/:id" element={<div>check-in page</div>} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe("QueriesPage", () => {
  it("lists open queries with plain labels, counts, severity and red aging", async () => {
    signIn("coordinator");
    installMockFetch(routes());
    renderPage();

    expect(
      screen.getByText(/A query is a question the drug company sends back/),
    ).toBeInTheDocument();
    const table = await screen.findByRole("grid");
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);

    const first = rows[1];
    expect(within(first).getByText("P-004")).toBeInTheDocument();
    expect(within(first).getByText("Medication change: Dose")).toBeInTheDocument();
    expect(within(first).getByText("CM.CMDOSE")).toBeInTheDocument();
    expect(within(first).getByText("Data")).toBeInTheDocument();
    expect(within(first).getByText("query.cm_required_fields")).toBeInTheDocument();
    expect(first.querySelector('[data-age-alert="true"]')).not.toBeNull();
    expect(within(first).getByText("late")).toBeInTheDocument();

    const second = rows[2];
    expect(within(second).getByText("Safety")).toBeInTheDocument();
    expect(second.querySelector('[data-age-alert="false"]')).not.toBeNull();

    await waitFor(() => expect(screen.getByTestId("count-open")).toHaveTextContent("2"));
    expect(screen.getByTestId("count-answered")).toHaveTextContent("1");
    expect(screen.getByTestId("count-closed")).toHaveTextContent("0");

    // Coordinators cannot raise queries.
    expect(screen.queryByRole("button", { name: "Raise query" })).toBeNull();
  });

  it("opens the panel with the record value, evidence and the template suggestion, and answers with also_edit", async () => {
    signIn("coordinator");
    const mock = installMockFetch(
      routes([
        {
          method: "POST",
          path: `/api/v1/queries/${OPEN_ROW.id}/answer`,
          handler: () => ({ json: { ...OPEN_ROW, status: "answered" } }),
        },
      ]),
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: /Open query: Dose, dose unit/ }));
    const panel = await screen.findByTestId("query-panel");

    await waitFor(() =>
      expect(within(panel).getByTestId("current-value")).toHaveTextContent("(empty)"),
    );
    expect(within(panel).getByText("Written by template")).toBeInTheDocument();
    expect(within(panel).getByText("Participant typed: started prednisone")).toBeInTheDocument();

    // A cited id the page cannot resolve says so.
    expect(within(panel).getByText("Not found")).toBeInTheDocument();

    // Click-to-evidence: the chip highlights the matching evidence row.
    const chip = within(panel).getAllByRole("button", {
      name: /Participant's answer to a closing question/,
    })[0];
    await user.click(chip);
    expect(panel.querySelector(`[data-evidence-row="${ANSWER_EV}"]`)).toHaveAttribute(
      "data-active",
      "true",
    );

    // Editor is prefilled with the suggestion.
    const box = within(panel).getByLabelText("Your answer") as HTMLTextAreaElement;
    expect(box.value).toContain("The participant reported starting prednisone");

    await user.click(within(panel).getByLabelText("Also correct the field"));
    await user.type(within(panel).getByPlaceholderText("Leave empty to clear the field"), "10");
    await user.click(within(panel).getByRole("button", { name: "Answer" }));

    await waitFor(() =>
      expect(mock.find("POST", `/api/v1/queries/${OPEN_ROW.id}/answer`)).toHaveLength(1),
    );
    const body = mock.find("POST", `/api/v1/queries/${OPEN_ROW.id}/answer`)[0].body as Record<
      string,
      unknown
    >;
    expect(body.answer_text).toContain("The participant reported starting prednisone");
    expect(body.evidence_ids).toEqual([
      ANSWER_EV,
      "protocol:7.7:p69",
      "01JNOTE0000000000000000004",
    ]);
    expect(body.also_edit).toEqual({ field: "CMDOSE", value: "10" });
  });

  it("shows a load error with retry when the list fails", async () => {
    signIn("coordinator");
    installMockFetch([
      {
        method: "GET",
        path: "/api/v1/queries",
        handler: () => ({
          status: 500,
          json: { type: "about:blank", title: "Server Error", status: 500, detail: "boom" },
        }),
      },
    ]);
    renderPage();
    expect(await screen.findByText("Could not load queries")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("shows an empty state on a tab with no queries", async () => {
    signIn("coordinator");
    installMockFetch(routes());
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("grid");
    await user.click(screen.getByRole("radio", { name: /Closed/ }));
    expect(await screen.findByText("No closed queries yet.")).toBeInTheDocument();
  });

  it("lets the admin close an answered query", async () => {
    signIn("admin");
    const mock = installMockFetch(
      routes([
        {
          method: "POST",
          path: `/api/v1/queries/${ANSWERED_ROW.id}/close`,
          handler: () => ({ json: { ...ANSWERED_ROW, status: "closed" } }),
        },
      ]),
    );
    const user = userEvent.setup();
    renderPage(`/dashboard/queries?status=answered&q=${ANSWERED_ROW.id}`);

    const panel = await screen.findByTestId("query-panel");
    await within(panel).findByText("Corrected: the end date was mistyped.");
    expect(within(panel).getByTestId("current-value")).toHaveTextContent("2026-10-05");
    expect(screen.getByRole("button", { name: "Raise query", hidden: true })).toBeInTheDocument();

    await user.click(within(panel).getByRole("button", { name: "Close query (as sponsor)" }));
    await waitFor(() =>
      expect(mock.find("POST", `/api/v1/queries/${ANSWERED_ROW.id}/close`)).toHaveLength(1),
    );
  });

  it("does not offer Close to a coordinator", async () => {
    signIn("coordinator");
    installMockFetch(routes());
    renderPage(`/dashboard/queries?status=answered&q=${ANSWERED_ROW.id}`);
    const panel = await screen.findByTestId("query-panel");
    await within(panel).findByText("Corrected: the end date was mistyped.");
    expect(within(panel).queryByRole("button", { name: /Close query/ })).toBeNull();
  });

  it("lets the admin raise a query from a pasted record id", async () => {
    signIn("admin");
    const mock = installMockFetch(
      routes([
        {
          method: "GET",
          path: "/api/v1/participants",
          handler: () => ({
            json: {
              items: [
                {
                  usubjid: USUBJID,
                  study_id: "S",
                  enrolled_at: "2026-01-01T00:00:00Z",
                  display_label: "P-004",
                },
              ],
              total: 1,
              limit: 100,
              offset: 0,
            },
          }),
        },
        {
          method: "POST",
          path: "/api/v1/queries",
          handler: ({ body }) => ({
            json: { ...OPEN_ROW, id: "01JQUERYNEW000000000000000", ...(body as object) },
          }),
        },
      ]),
    );
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Raise query" }));
    const form = await screen.findByTestId("raise-query");

    await user.type(within(form).getByPlaceholderText("01J…"), DRAFT_CM);
    await user.click(within(form).getByRole("button", { name: "Load record" }));
    await within(form).findByText(/Selected: Medication change: prednisone/);

    await user.selectOptions(within(form).getByLabelText("Field"), "CMINDC");
    await user.click(within(form).getByLabelText("Safety"));
    await user.type(within(form).getByLabelText("Question for the site"), "Why was it started?");
    await user.click(within(form).getByRole("button", { name: "Raise query" }));

    await waitFor(() => expect(mock.find("POST", "/api/v1/queries")).toHaveLength(1));
    expect(mock.find("POST", "/api/v1/queries")[0].body).toEqual({
      draft_id: DRAFT_CM,
      field: "CMINDC",
      text: "Why was it started?",
      severity: "safety",
    });
  });

  it("never lets a coordinator correct an investigator-only field from an AESER query", async () => {
    signIn("coordinator");
    installMockFetch(routes());
    const user = userEvent.setup();
    renderPage(`/dashboard/queries?q=${SAFETY_ROW.id}`);

    const panel = await screen.findByTestId("query-panel");
    const block = await within(panel).findByTestId("field-block");
    expect(block).toHaveAttribute("data-block-kind", "investigator");
    expect(block).toHaveTextContent("An investigator records this");
    expect(within(block).getByRole("link", { name: "Open the check-in" })).toBeInTheDocument();

    await user.click(within(panel).getByLabelText("Also correct the field"));
    const select = within(panel).getByLabelText("Field to correct") as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    for (const bad of ["AESER", "AEREL", "INTERIM_IRAE", "AESEQ"]) {
      expect(values).not.toContain(bad);
    }
    expect(values.some((v) => v.startsWith("INTERIM_"))).toBe(false);
    expect(select.value).not.toBe("AESER");
  });

  it("does not offer Raise query to a coordinator or an investigator", async () => {
    for (const role of ["coordinator", "investigator"] as const) {
      signIn(role);
      installMockFetch(routes());
      const { unmount } = renderPage();
      await screen.findByRole("grid");
      expect(screen.queryByRole("button", { name: "Raise query" })).toBeNull();
      unmount();
    }
  });

  it("resolves a chip that cites the record's term field and opens the extra evidence", async () => {
    signIn("coordinator");
    installMockFetch(
      routes([
        {
          method: "GET",
          path: `/api/v1/queries/${OPEN_ROW.id}`,
          handler: () => ({ json: OPEN_DETAIL_CITES_TERM }),
        },
      ]),
    );
    const user = userEvent.setup();
    renderPage(`/dashboard/queries?q=${OPEN_ROW.id}`);

    const panel = await screen.findByTestId("query-panel");
    await within(panel).findByText("Written by template");
    // Every cited id resolves: no amber "Not found" chip.
    expect(within(panel).queryByText("Not found")).toBeNull();
    // The query's full field list is shown.
    expect(within(panel).getByTestId("covered-fields")).toHaveTextContent(
      "Dose unit, How often, Taken for",
    );

    expect(panel.querySelector(`[data-evidence-row="${CMTRT_EV}"]`)).toBeNull();
    const chip = panel.querySelector(`[data-evidence-chip="${CMTRT_EV}"]`) as HTMLElement;
    await user.click(chip);
    expect(
      within(panel).getByRole("button", { name: /Hide more evidence on this record/ }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(panel.querySelector(`[data-evidence-row="${CMTRT_EV}"]`)).toHaveAttribute(
      "data-active",
      "true",
    );
  });

  it("shows a failed Close once, inline", async () => {
    signIn("admin");
    installMockFetch(
      routes([
        {
          method: "POST",
          path: `/api/v1/queries/${ANSWERED_ROW.id}/close`,
          handler: () => ({
            status: 409,
            json: { type: "about:blank", title: "Conflict", status: 409, detail: "Already closed" },
          }),
        },
      ]),
    );
    const user = userEvent.setup();
    renderPage(`/dashboard/queries?status=answered&q=${ANSWERED_ROW.id}`);
    const panel = await screen.findByTestId("query-panel");
    await user.click(
      await within(panel).findByRole("button", { name: "Close query (as sponsor)" }),
    );
    expect(await within(panel).findByText("Not closed")).toBeInTheDocument();
    expect(screen.queryByText("Could not close the query")).toBeNull();
  });

  it("moves to the next open query with the button and with the ] key", async () => {
    signIn("coordinator");
    installMockFetch(routes());
    const user = userEvent.setup();
    renderPage(`/dashboard/queries?q=${OPEN_ROW.id}`);

    const first = await screen.findByTestId("query-panel");
    await within(first).findByText(/Dose, dose unit/);
    await user.click(within(first).getByRole("button", { name: /Next open query/ }));
    await waitFor(() =>
      expect(screen.getByTestId("query-panel")).toHaveTextContent(SAFETY_DETAIL.text),
    );

    // "]" wraps back to the first open query when focus is not in a text field.
    await user.keyboard("]");
    await waitFor(() =>
      expect(screen.getByTestId("query-panel")).toHaveTextContent(OPEN_DETAIL.text),
    );
  });
});
