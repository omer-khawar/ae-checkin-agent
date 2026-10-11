/**
 * /dashboard/notes/:noteId: loads the note, field → evidence highlighting,
 * Why panel, confirm / reject through the shared drafts endpoints, 404 state.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";

import { installMockFetch, type Route as MockRoute } from "../../../../test/mockFetch";
import { NoteDetail } from "../../NoteDetail";
import { AE_DRAFT_ID, INGEST, NOTE_ID, signInAs, span } from "./fixtures";

function routes(): MockRoute[] {
  return [
    {
      method: "GET",
      path: new RegExp(`^/api/v1/notes/${NOTE_ID}$`),
      handler: () => ({ json: INGEST }),
    },
    {
      method: "GET",
      path: /^\/api\/v1\/notes\/missing$/,
      handler: () => ({
        status: 404,
        json: { type: "about:blank", title: "Not Found", status: 404, detail: "No such note" },
      }),
    },
    {
      method: "POST",
      path: new RegExp(`^/api/v1/drafts/${AE_DRAFT_ID}/confirm$`),
      handler: () => ({ json: { ...INGEST.drafts[0], status: "confirmed" } }),
    },
    {
      method: "POST",
      path: new RegExp(`^/api/v1/drafts/${AE_DRAFT_ID}/reject$`),
      handler: ({ body }) => ({
        json: {
          ...INGEST.drafts[0],
          status: "rejected",
          note: (body as { reason: string }).reason,
        },
      }),
    },
  ];
}

function renderDetail(id = NOTE_ID) {
  return render(
    <MemoryRouter initialEntries={[`/dashboard/notes/${id}`]}>
      <Routes>
        <Route path="/dashboard/notes/:noteId" element={<NoteDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("NoteDetail page", () => {
  beforeEach(() => {
    signInAs("coordinator");
  });

  it("renders the note, highlights, drafts, escalation and why", async () => {
    installMockFetch(routes());
    renderDetail();
    await screen.findByText("Scanner findings");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Chart note for P-003");
    expect(screen.getByTestId("highlighted-note")).toHaveTextContent(INGEST.note.text);
    expect(
      screen.getByTestId("highlighted-note").querySelectorAll("[data-kind]").length,
    ).toBeGreaterThan(0);
    expect(screen.getByTestId("draft-AE")).toBeInTheDocument();
    expect(screen.getByTestId("draft-CM")).toBeInTheDocument();
    expect(screen.getByTestId("ingest-outcome")).toHaveTextContent("Escalation created");
    expect(screen.queryByRole("link", { name: "Open note detail" })).not.toBeInTheDocument();
    expect(screen.getByTestId("why-list").querySelectorAll("li")).toHaveLength(2);
    expect(screen.getByText("Synthetic note")).toBeInTheDocument();
  });

  it("clicking a draft field shows its evidence and outlines the quoted words", async () => {
    installMockFetch(routes());
    const user = userEvent.setup();
    renderDetail();
    await screen.findByText("Scanner findings");
    const ae = screen.getByTestId("draft-AE");

    await user.click(
      within(ae).getByRole("button", {
        name: /^Severity grade \(provisional\) \(AETOXGR\): Grade 2/,
      }),
    );
    const evidence = within(ae).getByTestId("evidence-list");
    expect(evidence).toHaveTextContent("Chart note");
    expect(evidence).toHaveTextContent("provisional grade 2");
    const { span_start, span_end } = span("increasing SOB");
    expect(evidence).toHaveTextContent(`chars ${span_start}–${span_end}`);

    const note = screen.getByTestId("highlighted-note");
    const selected = [...note.querySelectorAll("[data-selected]")]
      .map((el) => el.textContent)
      .join("");
    expect(selected).toBe("increasing SOB");

    // A field whose evidence is a rule (no span) shows the evidence but clears the outline.
    await user.click(within(ae).getByRole("button", { name: /^Started on \(AESTDTC\)/ }));
    expect(within(ae).getByTestId("evidence-list")).toHaveTextContent("minus 7 days");
    expect(note.querySelectorAll("[data-selected]")).toHaveLength(0);
  });

  it("confirms and rejects through /drafts/{id}", async () => {
    const mock = installMockFetch(routes());
    const user = userEvent.setup();
    renderDetail();
    await screen.findByText("Scanner findings");
    const ae = screen.getByTestId("draft-AE");

    await user.click(within(ae).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(within(ae).getByText("confirmed")).toBeInTheDocument());
    expect(mock.find("POST", new RegExp(`/drafts/${AE_DRAFT_ID}/confirm$`))).toHaveLength(1);
    // Confirmed drafts have no more actions.
    expect(within(ae).queryByRole("button", { name: "Confirm" })).not.toBeInTheDocument();
  });

  it("reject requires a reason and sends it", async () => {
    const mock = installMockFetch(routes());
    const user = userEvent.setup();
    renderDetail();
    await screen.findByText("Scanner findings");
    const ae = screen.getByTestId("draft-AE");
    await user.click(within(ae).getByRole("button", { name: "Reject…" }));
    const reject = within(ae).getByRole("button", { name: "Reject" });
    expect(reject).toBeDisabled();
    await user.type(within(ae).getByLabelText("Reason for rejecting"), "duplicate of visit AE");
    await user.click(reject);
    await waitFor(() => expect(within(ae).getByText("rejected")).toBeInTheDocument());
    const call = mock.find("POST", new RegExp(`/drafts/${AE_DRAFT_ID}/reject$`))[0];
    expect(call.body).toEqual({ reason: "duplicate of visit AE" });
  });

  it("shows the API error for an unknown note", async () => {
    installMockFetch(routes());
    renderDetail("missing");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("HTTP 404");
    expect(alert).toHaveTextContent("No such note");
    expect(screen.getByRole("link", { name: "← All chart notes" })).toHaveAttribute(
      "href",
      "/dashboard/notes",
    );
  });
});
