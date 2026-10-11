/**
 * Regression (intake e2e, step 3): the queue's "came in as" cell said only
 * "Chart note" / "Phone call". It now names the note type or who was on the
 * call, and flags items that follow up an already-open AE.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { QueueItem } from "../../../../lib/types";
import { normalizeQueueItem } from "../normalize";
import { SourceDetail } from "../QueueTable";

const BASE: QueueItem = {
  session_id: null,
  note_id: "01JNOTE000000000000000000A",
  source: "chart_note",
  usubjid: "R2810-ONC-1624-P-002",
  display_label: "P-002",
  completed_at: "2026-10-10T22:08:26.249Z",
  tier: 1,
  tier_name: "Coordinator review",
  max_grade: 1,
  vitals_status: "unavailable",
  is_measured: false,
  has_sae_clock: false,
  sae_due_at: null,
  escalation_acked: null,
  draft_counts: { AE: 2, VS: 0, CM: 0 },
  draft_status_summary: "2 draft",
} as QueueItem;

describe("queue SourceDetail", () => {
  it("names the note type and shows a follow-up chip", () => {
    const row = normalizeQueueItem({ ...BASE, note_type: "outside_record", followup_count: 2 });
    expect(row.followup_count).toBe(2);
    render(<SourceDetail row={row} />);
    expect(screen.getByTestId("source-detail")).toHaveTextContent("Outside record");
    expect(screen.getByTestId("followup-chip")).toHaveTextContent("Follow-up · 2 open AEs");
  });

  it("says who was on a phone call", () => {
    const row = normalizeQueueItem({
      ...BASE,
      note_type: "phone_call",
      caller: "caregiver",
      call_direction: "inbound",
    });
    render(<SourceDetail row={row} />);
    expect(screen.getByTestId("source-detail")).toHaveTextContent(/Caregiver/);
    expect(screen.queryByTestId("followup-chip")).toBeNull();
  });

  it("renders nothing for a plain check-in without follow-ups", () => {
    const row = normalizeQueueItem({
      ...BASE,
      source: "check_in",
      note_id: null,
      session_id: "S1",
    });
    const { container } = render(<SourceDetail row={row} />);
    expect(container).toBeEmptyDOMElement();
  });
});
