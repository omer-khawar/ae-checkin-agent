/**
 * Component-level checks for the notes panels: landmark names on the scan
 * sections, valid <dl> markup for draft fields, and the outcome panel
 * surviving partial escalation / SAE-clock rows.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { DraftsPanel } from "../DraftsPanel";
import { normalizeNoteDetail } from "../normalize";
import { Outcome } from "../Outcome";
import { ScanTables } from "../ScanTables";
import type { NoteEscalation } from "../types";
import { INGEST, SCAN, span, TEXT } from "./fixtures";

describe("ScanTables", () => {
  it("names every section region so landmarks are navigable", () => {
    render(<ScanTables scan={SCAN} />);
    for (const name of [
      /Red flags/,
      /Symptom findings/,
      /Medication findings/,
      /Excluded mentions/,
    ]) {
      expect(screen.getByRole("region", { name })).toBeInTheDocument();
    }
    // Every aria-labelledby target exists.
    for (const section of document.querySelectorAll("section[aria-labelledby]")) {
      const id = section.getAttribute("aria-labelledby")!;
      expect(document.getElementById(id)).not.toBeNull();
    }
  });
});

describe("DraftsPanel markup", () => {
  it("renders fields as a valid definition list with buttons inside dt / dd", async () => {
    const user = userEvent.setup();
    const onSelectRange = vi.fn();
    render(<DraftsPanel drafts={INGEST.drafts} noteText={TEXT} onSelectRange={onSelectRange} />);
    const ae = screen.getByTestId("draft-AE");

    const rows = [...ae.querySelectorAll("dl > div")];
    expect(rows.length).toBe(Object.keys(INGEST.drafts[0].fields).length);
    for (const row of rows) {
      const tags = [...row.children].map((c) => c.tagName);
      expect(tags).toEqual(["DT", "DD"]);
    }
    // No dt/dd nested inside a button anywhere in the panel.
    expect(ae.querySelector("button dt, button dd")).toBeNull();

    // The dt button keeps the "<name>: <value>. Show evidence" label and is the
    // single tab stop per field; the dd button is a mouse-only second target.
    const dtButton = within(ae).getByRole("button", { name: /^AETOXGR: 2/ });
    expect(dtButton.closest("dt")).not.toBeNull();
    const ddButton = within(ae).getByRole("button", { name: /^Value of AETOXGR: 2/ });
    expect(ddButton.closest("dd")).not.toBeNull();
    expect(ddButton).toHaveAttribute("tabindex", "-1");

    await user.click(dtButton);
    expect(dtButton).toHaveAttribute("aria-pressed", "true");
    // Evidence renders inside the dd (part of the value's description).
    expect(within(ae).getByTestId("evidence-list").closest("dd")).not.toBeNull();
    const { span_start, span_end } = span("increasing SOB");
    expect(onSelectRange).toHaveBeenLastCalledWith({ start: span_start, end: span_end });
  });
});

describe("Outcome resilience", () => {
  it("renders an escalation with no reasons and a partial SAE clock after normalization", () => {
    const d = normalizeNoteDetail({
      ...INGEST,
      escalation: { id: "e", tier: 2 },
      sae_clock: { id: "s", due_at: "2026-10-11T15:04:05.000Z" },
    });
    render(
      <MemoryRouter>
        <Outcome noteId="n" drafts={d.drafts} escalation={d.escalation} saeClock={d.sae_clock} />
      </MemoryRouter>,
    );
    const outcome = screen.getByTestId("ingest-outcome");
    expect(outcome).toHaveTextContent("Escalation created (not yet acknowledged)");
    expect(within(outcome).getByText("Nurse call today")).toBeInTheDocument();
    expect(outcome).toHaveTextContent("SAE clock started");
  });

  it("does not crash when handed a raw escalation row lacking reasons", () => {
    const raw = { id: "e", tier: 2 } as unknown as NoteEscalation;
    render(
      <MemoryRouter>
        <Outcome noteId="n" drafts={[]} escalation={raw} saeClock={null} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("ingest-outcome")).toHaveTextContent("Escalation created");
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });
});
