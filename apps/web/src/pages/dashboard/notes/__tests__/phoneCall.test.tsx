/**
 * R4.1 phone-call intake and the R3/R4 note-detail additions against a mocked
 * API: "Log a call" posts a phone_call note, calls are listed with a phone
 * icon + "Phone call", the note detail names the caller, leads its Why rows
 * with a plain sentence, shows protocol chips, and offers the report packet
 * and (investigator, no AE draft) the seriousness decision on the clock.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";

import { installMockFetch, type Route as MockRoute } from "../../../../test/mockFetch";
import { NoteDetail } from "../../NoteDetail";
import { Notes } from "../../Notes";
import { LogCallForm } from "../PhoneCall";
import { callSummary, noteTypeWords } from "../phoneCallLabels";
import {
  INGEST,
  NOTE_ID,
  NOTES_PAGE,
  PARTICIPANTS,
  SCAN,
  signInAs,
  USUBJID_P003,
} from "./fixtures";

const CLOCK_ID = "01JCLOCKNOTE00000000000001";

const CALL = {
  ...INGEST,
  note: {
    ...INGEST.note,
    note_type: "phone_call",
    caller: "caregiver",
    call_direction: "inbound",
    text: "Daughter called: increasing SOB since Tuesday. Holding lisinopril.",
  },
};

describe("phone-call labels", () => {
  it("words note types and call summaries", () => {
    expect(noteTypeWords("phone_call")).toBe("Phone call");
    expect(noteTypeWords("ed_note")).toBe("Emergency department note");
    expect(callSummary("caregiver", "inbound")).toBe("Caregiver · they called the site");
    expect(callSummary(null, "outbound")).toBe("The site called them");
    expect(callSummary(null, null)).toBeNull();
  });
});

describe("Log a call", () => {
  beforeEach(() => signInAs("coordinator"));

  it("posts a phone_call note with caller, direction and the summary verbatim", async () => {
    const mock = installMockFetch([
      { method: "GET", path: "/api/v1/participants", handler: () => ({ json: PARTICIPANTS }) },
      { method: "GET", path: "/api/v1/notes", handler: () => ({ json: NOTES_PAGE }) },
      { method: "POST", path: "/api/v1/scan", handler: () => ({ json: SCAN }) },
      { method: "POST", path: "/api/v1/notes", handler: () => ({ json: CALL }) },
    ]);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Notes />
      </MemoryRouter>,
    );
    const form = await screen.findByRole("form", { name: "Log a call" });
    const who = await within(form).findByRole("combobox", { name: "Call is about" });
    await waitFor(() => expect(within(who).getAllByRole("option").length).toBeGreaterThan(1));
    // Nothing to submit until a participant and a summary are given.
    expect(within(form).getByRole("button", { name: "Log call" })).toBeDisabled();
    await user.selectOptions(who, USUBJID_P003);
    await user.selectOptions(
      within(form).getByRole("combobox", { name: "Who was on the call" }),
      "caregiver",
    );
    await user.click(within(form).getByRole("radio", { name: "The site called them" }));
    await user.type(
      within(form).getByRole("textbox", { name: "Call summary" }),
      "Daughter says increasing SOB.",
    );
    const listCallsBefore = mock.find("GET", "/api/v1/notes").length;
    await user.click(within(form).getByRole("button", { name: "Log call" }));

    await waitFor(() => expect(mock.find("POST", "/api/v1/notes")).toHaveLength(1));
    const body = mock.find("POST", "/api/v1/notes")[0].body as Record<string, unknown>;
    expect(body).toMatchObject({
      usubjid: USUBJID_P003,
      note_type: "phone_call",
      caller: "caregiver",
      call_direction: "outbound",
      text: "Daughter says increasing SOB.",
    });
    // The signed-in user is recorded as the author.
    expect(typeof body.author === "string" && body.author.length > 0).toBe(true);
    expect(body.note_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const done = await within(form).findByTestId("call-logged");
    expect(done).toHaveTextContent("Call logged. 2 drafts created.");
    expect(within(done).getByRole("link", { name: "Open call record" })).toHaveAttribute(
      "href",
      `/dashboard/notes/${NOTE_ID}`,
    );
    // The summary box is cleared and the list reloads.
    expect(within(form).getByRole("textbox", { name: "Call summary" })).toHaveValue("");
    await waitFor(() =>
      expect(mock.find("GET", "/api/v1/notes").length).toBeGreaterThan(listCallsBefore),
    );
  });

  it("works with a fixed participant (timeline) and shows the API error", async () => {
    installMockFetch([
      {
        method: "POST",
        path: "/api/v1/notes",
        handler: () => ({
          status: 422,
          json: { type: "about:blank", title: "Unprocessable Entity", status: 422, detail: "bad" },
        }),
      },
    ]);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <LogCallForm usubjid={USUBJID_P003} displayLabel="P-003" />
      </MemoryRouter>,
    );
    expect(screen.getByText("P-003")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Call is about" })).toBeNull();
    await user.type(screen.getByRole("textbox", { name: "Call summary" }), "rash");
    await user.click(screen.getByRole("button", { name: "Log call" }));
    expect(await screen.findByText("The call was not logged")).toBeInTheDocument();
  });

  it("is read-only for the investigator", () => {
    signInAs("investigator");
    installMockFetch([]);
    render(
      <MemoryRouter>
        <LogCallForm usubjid={USUBJID_P003} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/read-only for your role/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Log call" })).toBeDisabled();
  });
});

describe("Notes list", () => {
  beforeEach(() => signInAs("coordinator"));

  it("labels phone calls with an icon and the words Phone call", async () => {
    const page = {
      ...NOTES_PAGE,
      items: [{ ...NOTES_PAGE.items[0], note_type: "phone_call" }],
    };
    installMockFetch([
      { method: "GET", path: "/api/v1/participants", handler: () => ({ json: PARTICIPANTS }) },
      { method: "GET", path: "/api/v1/notes", handler: () => ({ json: page }) },
    ]);
    render(
      <MemoryRouter>
        <Notes />
      </MemoryRouter>,
    );
    const row = (await screen.findAllByTestId("note-row"))[0];
    const label = within(row).getByTestId("phone-call-label");
    expect(label).toHaveTextContent("Phone call");
    expect(label.querySelector("svg")).not.toBeNull();
  });
});

function detailRoutes(payload: unknown, extra: MockRoute[] = []): MockRoute[] {
  return [
    {
      method: "GET",
      path: new RegExp(`^/api/v1/notes/${NOTE_ID}$`),
      handler: () => ({ json: payload }),
    },
    ...extra,
  ];
}

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={[`/dashboard/notes/${NOTE_ID}`]}>
      <Routes>
        <Route path="/dashboard/notes/:noteId" element={<NoteDetail />} />
        <Route path="/dashboard/packets/:id" element={<p>Packet page stub</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

const CLOCK = {
  id: CLOCK_ID,
  session_id: null,
  note_id: NOTE_ID,
  usubjid: USUBJID_P003,
  site_awareness_at: "2026-10-10T15:04:05.000Z",
  due_at: new Date(Date.now() + 3600_000).toISOString(),
  stopped_at: null,
  stopped_by: null,
  decision: null,
  seconds_remaining: 3600,
  informational: {},
  kind: "sae",
};

describe("NoteDetail · phone call and R3/R4", () => {
  beforeEach(() => signInAs("coordinator"));

  it("names the call, leads Why rows with plain words and shows protocol chips", async () => {
    const payload = {
      ...CALL,
      drafts: CALL.drafts.map((d) =>
        d.domain === "CM"
          ? {
              ...d,
              fields: {
                ...d.fields,
                INTERIM_PROTOCOL_FLAG: "prohibited",
                INTERIM_CM_MISSING_FIELDS: ["CMDOSE"],
              },
            }
          : d,
      ),
    };
    installMockFetch(detailRoutes(payload));
    renderDetail();
    await screen.findByText("Scanner findings");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Phone call about P-003");
    expect(screen.getByTestId("phone-call-label")).toHaveTextContent("Phone call");
    expect(screen.getByText("Caregiver · they called the site")).toBeInTheDocument();
    expect(screen.getByText("Synthetic call")).toBeInTheDocument();

    const cm = screen.getByTestId("draft-CM");
    expect(within(cm).getByTestId("protocol-chip")).toHaveTextContent(
      "Prohibited by protocol §7.7.1",
    );
    expect(within(cm).getByTestId("cm-missing")).toHaveTextContent(
      "Still needed for the medication form: dose",
    );
    expect(within(cm).getByText("Medication change: Holding lisinopril")).toBeInTheDocument();

    const rule = document.querySelector('[data-rule-id="chartscan.red_flag"]') as HTMLElement;
    // Plain sentence from plain_language.json, filled from the rule's inputs.
    expect(within(rule).getByText(/A chart note contains a warning sign/)).toBeInTheDocument();
  });

  it("opens the report packet for the note's clock", async () => {
    const mock = installMockFetch(
      detailRoutes({ ...INGEST, sae_clock: CLOCK }, [
        {
          method: "POST",
          path: "/api/v1/packets",
          handler: () => ({ json: { id: "01JPACKETNOTE", clock_id: CLOCK_ID } }),
        },
      ]),
    );
    const user = userEvent.setup();
    renderDetail();
    await screen.findByText("Scanner findings");
    await user.click(screen.getByRole("button", { name: "Open report packet" }));
    expect(await screen.findByText("Packet page stub")).toBeInTheDocument();
    expect(mock.find("POST", "/api/v1/packets")[0].body).toEqual({ clock_id: CLOCK_ID });
  });

  it("lets the investigator record the seriousness decision when the note drafted no AE", async () => {
    signInAs("investigator");
    const noAe = {
      ...INGEST,
      drafts: INGEST.drafts.filter((d) => d.domain !== "AE"),
      sae_clock: CLOCK,
    };
    const mock = installMockFetch(
      detailRoutes(noAe, [
        {
          method: "PATCH",
          path: `/api/v1/sae-clocks/${CLOCK_ID}/stop`,
          handler: ({ body }) => ({
            json: {
              ...CLOCK,
              stopped_at: "2026-10-10T16:00:00.000Z",
              stopped_by: "investigator",
              decision: (body as { decision: string }).decision,
              seconds_remaining: null,
            },
          }),
        },
      ]),
    );
    const user = userEvent.setup();
    renderDetail();
    await screen.findByText("Scanner findings");
    await user.click(screen.getByRole("button", { name: "Record seriousness decision" }));
    await user.click(screen.getByRole("radio", { name: "Serious" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Yes, record decision" }));
    await waitFor(() =>
      expect(mock.find("PATCH", `/api/v1/sae-clocks/${CLOCK_ID}/stop`)).toHaveLength(1),
    );
    expect(mock.find("PATCH", `/api/v1/sae-clocks/${CLOCK_ID}/stop`)[0].body).toEqual({
      decision: "AESER = Y",
    });
    // The clock line now reads stopped and the decision control is gone.
    await waitFor(() => expect(screen.getByTestId("ingest-outcome")).toHaveTextContent("Stopped"));
    expect(screen.queryByRole("button", { name: "Record seriousness decision" })).toBeNull();
  });

  it("does not offer the clock decision when an AE draft exists", async () => {
    signInAs("investigator");
    installMockFetch(detailRoutes({ ...INGEST, sae_clock: CLOCK }));
    renderDetail();
    await screen.findByText("Scanner findings");
    expect(screen.getByRole("button", { name: "Open report packet" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Record seriousness decision" })).toBeNull();
  });
});
