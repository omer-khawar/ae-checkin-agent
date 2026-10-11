/**
 * /dashboard/notes against a mocked API: pre-filled sample, dry-run scan,
 * highlighted spans, ingest outcome, list reload, error state.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";

import { resetAuthCache } from "../../../../lib/auth";
import { installMockFetch, type Route } from "../../../../test/mockFetch";
import { Notes } from "../../Notes";
import { DEFAULT_SAMPLE, SAMPLE_NOTES } from "../sampleNotes";
import {
  INGEST,
  NOTE_ID,
  NOTES_PAGE,
  PARTICIPANTS,
  SCAN,
  signInAs,
  TEXT,
  USUBJID_P003,
} from "./fixtures";
import type { NoteIngestRequest, ScanRequest } from "../../../../lib/types";

function routes(opts: { scanStatus?: number } = {}): Route[] {
  return [
    { method: "GET", path: "/api/v1/participants", handler: () => ({ json: PARTICIPANTS }) },
    { method: "GET", path: "/api/v1/notes", handler: () => ({ json: NOTES_PAGE }) },
    {
      method: "POST",
      path: "/api/v1/scan",
      handler: () =>
        opts.scanStatus && opts.scanStatus >= 400
          ? {
              status: opts.scanStatus,
              json: {
                type: "about:blank",
                title: "Unprocessable Entity",
                status: opts.scanStatus,
                detail: "text must not be empty",
              },
            }
          : { json: SCAN },
    },
    { method: "POST", path: "/api/v1/notes", handler: () => ({ json: INGEST }) },
  ];
}

function renderNotes() {
  return render(
    <MemoryRouter initialEntries={["/dashboard/notes"]}>
      <Notes />
    </MemoryRouter>,
  );
}

describe("Notes page", () => {
  beforeEach(() => {
    signInAs("coordinator");
  });

  it("pre-fills the form with the default sample and resolves its participant", async () => {
    const mock = installMockFetch(routes());
    renderNotes();
    const textarea = screen.getByLabelText("Note text") as HTMLTextAreaElement;
    expect(textarea.value).toBe(DEFAULT_SAMPLE.text);
    expect((screen.getByLabelText("Author") as HTMLInputElement).value).toBe(DEFAULT_SAMPLE.author);
    expect((screen.getByLabelText("Note date") as HTMLInputElement).value).toBe(
      DEFAULT_SAMPLE.note_date,
    );
    await waitFor(() =>
      expect(
        (screen.getByRole("combobox", { name: "Participant" }) as HTMLSelectElement).value,
      ).toBe(USUBJID_P003),
    );
    // The answer key for the sample is shown so a judge can compare.
    expect(screen.getByTestId("answer-key")).toHaveTextContent("Dyspnea, Cough");
    expect(screen.getByTestId("answer-key")).toHaveTextContent("lisinopril (stopped)");
    // Dashboard calls carry the bearer token.
    expect(mock.find("GET", "/api/v1/participants")[0].headers.authorization).toBe(
      "Bearer tok-test",
    );
  });

  it("dry-run scan posts {text, ref_date}, stores nothing and highlights every span kind", async () => {
    const mock = installMockFetch(routes());
    const user = userEvent.setup();
    renderNotes();
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Participant" })).toHaveValue(USUBJID_P003),
    );

    await user.click(screen.getByRole("button", { name: "Scan only (dry run)" }));

    await screen.findByText("Dry run · nothing stored");
    const scanCalls = mock.find("POST", "/api/v1/scan");
    expect(scanCalls).toHaveLength(1);
    expect(scanCalls[0].body as ScanRequest).toEqual({
      text: TEXT,
      ref_date: DEFAULT_SAMPLE.note_date,
    });
    expect(mock.find("POST", "/api/v1/notes")).toHaveLength(0);

    const note = screen.getByTestId("highlighted-note");
    expect(note).toHaveTextContent(TEXT);
    const kinds = [...note.querySelectorAll("[data-kind]")].map((el) =>
      el.getAttribute("data-kind"),
    );
    expect(kinds).toEqual(expect.arrayContaining(["red_flag", "symptom", "med", "excluded"]));
    // Overlap: "SOB" is covered by both the red flag and the Dyspnea symptom.
    const sob = [...note.querySelectorAll("[data-kind]")].find((el) => el.textContent === "SOB")!;
    expect(sob.getAttribute("data-kind")).toBe("red_flag");
    expect(sob.getAttribute("title")).toContain("Dyspnea (symptom)");
    // Excluded mention: muted, with the exclusion reason on hover.
    const excluded = note.querySelector('[data-kind="excluded"]')!;
    expect(excluded.getAttribute("title")).toContain("indication");
    expect(excluded.getAttribute("title")).toContain("not drafted");

    // Tables.
    const symptomRows = screen.getAllByTestId("symptom-row");
    expect(symptomRows).toHaveLength(2);
    expect(symptomRows[0]).toHaveTextContent("Dyspnea");
    expect(symptomRows[0]).toHaveTextContent("G2 (provisional)");
    expect(symptomRows[0]).toHaveTextContent("7 days before the note");
    expect(screen.getAllByTestId("excluded-symptom-row")[0]).toHaveTextContent("indication");
    expect(screen.getAllByTestId("med-row")[0]).toHaveTextContent("lisinopril");
    expect(screen.getAllByTestId("med-row")[0]).toHaveTextContent("stopped");
    expect(screen.getAllByTestId("red-flag-row")[0]).toHaveTextContent("urgent");

    // "Show" selects the row's words in the note.
    await user.click(
      screen.getByRole("button", { name: "Show red flag “increasing SOB” in the note" }),
    );
    const selected = [...note.querySelectorAll("[data-selected]")]
      .map((el) => el.textContent)
      .join("");
    expect(selected).toBe("increasing SOB");
  });

  it("ingest posts the note, shows drafts / escalation / why and reloads the list", async () => {
    const mock = installMockFetch(routes());
    const user = userEvent.setup();
    renderNotes();
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Participant" })).toHaveValue(USUBJID_P003),
    );
    await waitFor(() => expect(screen.getAllByTestId("note-row")).toHaveLength(1));
    const listCallsBefore = mock.find("GET", "/api/v1/notes").length;

    await user.click(screen.getByRole("button", { name: "Ingest" }));

    await screen.findByText("Stored · audit event written");
    const calls = mock.find("POST", "/api/v1/notes");
    expect(calls).toHaveLength(1);
    expect(calls[0].body as NoteIngestRequest).toEqual({
      usubjid: USUBJID_P003,
      note_date: DEFAULT_SAMPLE.note_date,
      author: DEFAULT_SAMPLE.author,
      note_type: DEFAULT_SAMPLE.note_type,
      text: TEXT,
    });

    const outcome = screen.getByTestId("ingest-outcome");
    expect(outcome).toHaveTextContent("1 AE");
    expect(outcome).toHaveTextContent("1 CM");
    expect(within(outcome).getByText("Nurse call today")).toBeInTheDocument();
    expect(outcome).toHaveTextContent("urgent red flag: dyspnea");
    expect(within(outcome).getByRole("link", { name: "Open note detail" })).toHaveAttribute(
      "href",
      `/dashboard/notes/${NOTE_ID}`,
    );

    // Drafts with provisional grade label and the Why list.
    expect(screen.getByTestId("draft-AE")).toHaveTextContent("Dyspnea");
    expect(screen.getByTestId("draft-AE")).toHaveTextContent("(provisional)");
    expect(screen.getByTestId("why-list").querySelectorAll("li")).toHaveLength(2);

    // The list refetches after an ingest.
    await waitFor(() =>
      expect(mock.find("GET", "/api/v1/notes").length).toBeGreaterThan(listCallsBefore),
    );
  });

  it("shows the problem+json error from a failed scan", async () => {
    installMockFetch(routes({ scanStatus: 422 }));
    const user = userEvent.setup();
    renderNotes();
    await user.click(screen.getByRole("button", { name: "Scan only (dry run)" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("HTTP 422");
    expect(alert).toHaveTextContent("text must not be empty");
  });

  it("loading another sample replaces the form and clears the result", async () => {
    installMockFetch(routes());
    const user = userEvent.setup();
    renderNotes();
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Participant" })).toHaveValue(USUBJID_P003),
    );
    const n1 = SAMPLE_NOTES.find((s) => s.id === "N1")!;
    await user.selectOptions(screen.getByLabelText("Load a sample note"), "N1");
    expect(screen.getByLabelText("Note text")).toHaveValue(n1.text);
    expect(screen.getByRole("combobox", { name: "Participant" })).toHaveValue(
      PARTICIPANTS.items.find((p) => p.display_label === "P-001")!.usubjid,
    );
    expect(screen.getByTestId("answer-key")).toHaveTextContent("loperamide (started)");
  });

  it("lists ingested notes with counts, tier chip and links", async () => {
    installMockFetch(routes());
    renderNotes();
    const row = (await screen.findAllByTestId("note-row"))[0];
    expect(within(row).getByRole("link", { name: "P-003" })).toHaveAttribute(
      "href",
      `/dashboard/participants/${USUBJID_P003}`,
    );
    expect(row).toHaveTextContent("Triage RN");
    expect(within(row).getByText("Nurse call today")).toBeInTheDocument();
    expect(within(row).getByRole("link", { name: "Open" })).toHaveAttribute(
      "href",
      `/dashboard/notes/${NOTE_ID}`,
    );
    // Local time with UTC on hover.
    expect(within(row).getByTitle(/2026-10-10T15:04:05\.000Z \(UTC\)/)).toBeInTheDocument();
  });

  it("Clear then picking 'Select…' never snaps the participant back to the sample's P-003", async () => {
    installMockFetch(routes());
    const user = userEvent.setup();
    renderNotes();
    const participant = () => screen.getByRole("combobox", { name: "Participant" });
    await waitFor(() => expect(participant()).toHaveValue(USUBJID_P003));

    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByLabelText("Note text")).toHaveValue("");
    // Clear keeps the operator's participant; they now explicitly un-pick it.
    await user.selectOptions(participant(), "");
    expect(participant()).toHaveValue("");
    // Nothing re-fills it on the next renders, and Ingest stays disabled.
    await user.type(screen.getByLabelText("Note text"), "Pt reports mild nausea.");
    expect(participant()).toHaveValue("");
    expect(screen.getByRole("button", { name: "Ingest" })).toBeDisabled();
  });

  it("Clear before the participant list arrives leaves the participant empty once it does", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    installMockFetch([
      {
        method: "GET",
        path: "/api/v1/participants",
        handler: async () => {
          await gate;
          return { json: PARTICIPANTS };
        },
      },
      ...routes().filter((r) => r.path !== "/api/v1/participants"),
    ]);
    const user = userEvent.setup();
    renderNotes();
    // Still loading: the participant control is the text fallback and empty.
    expect(screen.getByRole("textbox", { name: "Participant" })).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "Clear" }));
    release();
    const select = await screen.findByRole("combobox", { name: "Participant" });
    expect(select).toHaveValue("");
    // Give any stray effect a chance to run; it must not assign P-003.
    await waitFor(() => expect(screen.getAllByTestId("note-row")).toHaveLength(1));
    expect(screen.getByRole("combobox", { name: "Participant" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "Ingest" })).toBeDisabled();
  });

  it("a sample loaded before the list arrives is resolved exactly once, after it arrives", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    installMockFetch([
      {
        method: "GET",
        path: "/api/v1/participants",
        handler: async () => {
          await gate;
          return { json: PARTICIPANTS };
        },
      },
      ...routes().filter((r) => r.path !== "/api/v1/participants"),
    ]);
    const user = userEvent.setup();
    renderNotes();
    await user.selectOptions(screen.getByLabelText("Load a sample note"), "N1");
    expect(screen.getByRole("textbox", { name: "Participant" })).toHaveValue("");
    release();
    const select = await screen.findByRole("combobox", { name: "Participant" });
    await waitFor(() =>
      expect(select).toHaveValue(
        PARTICIPANTS.items.find((p) => p.display_label === "P-001")!.usubjid,
      ),
    );
  });

  it("investigator can dry-run scan but Ingest is disabled (coordinator/admin only)", async () => {
    signInAs("investigator");
    resetAuthCache();
    installMockFetch(routes());
    renderNotes();
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Participant" })).toHaveValue(USUBJID_P003),
    );
    const ingest = screen.getByRole("button", { name: "Ingest" });
    expect(ingest).toBeDisabled();
    expect(ingest).toHaveAttribute("title", expect.stringMatching(/coordinator or admin only/i));
    // Both the ingest form and the "Log a call" form are gated for the investigator.
    expect(screen.getAllByText(/read-only for your role/)).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Scan only (dry run)" })).toBeEnabled();
  });

  it("coordinator sees no role notice and an enabled Ingest", async () => {
    installMockFetch(routes());
    renderNotes();
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Participant" })).toHaveValue(USUBJID_P003),
    );
    expect(screen.getByRole("button", { name: "Ingest" })).toBeEnabled();
    expect(screen.queryByText(/read-only for your role/)).not.toBeInTheDocument();
  });
});
