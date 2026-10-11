import { describe, expect, it } from "vitest";

import type { Participant, QueueItem } from "../../../../lib/types";
import {
  buildQueueQuery,
  detailHref,
  hasNarrowingFilter,
  hasVitalsSamples,
  inferSource,
  isDefaultFilters,
  normalizeQueueItem,
  resolveParticipantFilter,
} from "../normalize";

const R1_ROW: QueueItem = {
  session_id: "01JSESSION00000000000000A",
  usubjid: "R2810-ONC-1624-P-007",
  display_label: "P-007",
  completed_at: "2026-10-10T18:04:12.345Z",
  tier: 1,
  tier_name: "Review within 1 business day",
  max_grade: 2,
  vitals_status: "simulated_ignored",
  is_measured: false,
  has_sae_clock: false,
  sae_due_at: null,
  escalation_acked: null,
  draft_counts: { AE: 2, VS: 2, CM: 1 },
  draft_status_summary: "5 draft",
};

const PARTICIPANTS: Participant[] = [
  {
    usubjid: "R2810-ONC-1624-P-007",
    study_id: "R2810-ONC-1624",
    enrolled_at: "2026-08-01T00:00:00.000Z",
    display_label: "P-007",
  },
];

describe("normalizeQueueItem", () => {
  it("maps an R1 check-in row to a check-in detail route", () => {
    const row = normalizeQueueItem(R1_ROW);
    expect(row.source).toBe("check_in");
    expect(row.key).toBe(R1_ROW.session_id);
    expect(row.href).toBe("/dashboard/checkins/01JSESSION00000000000000A");
    expect(row.draft_counts).toEqual({ AE: 2, VS: 2, CM: 1 });
    expect(row.has_sae_clock).toBe(false);
    expect(row.sae_stopped).toBe(false);
  });

  it("maps an R2.4 chart-note row (null session_id, note_id) to the note route", () => {
    const row = normalizeQueueItem({
      ...R1_ROW,
      session_id: null,
      note_id: "01JNOTE000000000000000001",
      source: "chart_note",
      max_grade: null,
      vitals_status: "unavailable",
    });
    expect(row.source).toBe("chart_note");
    expect(row.key).toBe("01JNOTE000000000000000001");
    expect(row.href).toBe("/dashboard/notes/01JNOTE000000000000000001");
    expect(row.max_grade).toBeNull();
    expect(hasVitalsSamples(row)).toBe(false);
  });

  it("infers chart_note from note_id when source is absent", () => {
    expect(inferSource({ session_id: null, note_id: "n1" })).toBe("chart_note");
    expect(inferSource({ session_id: "s1", note_id: null })).toBe("check_in");
    expect(inferSource({ source: "check_in", session_id: null, note_id: "n1" })).toBe("check_in");
    expect(detailHref("check_in", null, null)).toBe("");
  });

  it("survives missing optional fields and fills zero draft counts", () => {
    const row = normalizeQueueItem({
      ...R1_ROW,
      draft_counts: null,
      draft_status_summary: undefined as unknown as string,
      tier_name: "" as string,
      max_grade: undefined,
    });
    expect(row.draft_counts).toEqual({ AE: 0, VS: 0, CM: 0 });
    expect(row.draft_status_summary).toBe("");
    expect(row.tier_name).toBe("Review within 1 business day");
    expect(row.max_grade).toBeNull();
  });

  it("reads SAE clock stopped from any of the optional fields", () => {
    const base = { ...R1_ROW, has_sae_clock: true, sae_due_at: "2026-10-11T18:00:00.000Z" };
    expect(normalizeQueueItem(base).sae_stopped).toBe(false);
    expect(
      normalizeQueueItem({ ...base, sae_stopped_at: "2026-10-10T20:00:00.000Z" }).sae_stopped,
    ).toBe(true);
    expect(normalizeQueueItem({ ...base, sae_clock_stopped: true }).sae_stopped).toBe(true);
    const nested = normalizeQueueItem({
      ...R1_ROW,
      sae_clock: { due_at: "2026-10-11T18:00:00.000Z", stopped_at: "2026-10-10T20:00:00.000Z" },
    });
    expect(nested.has_sae_clock).toBe(true);
    expect(nested.sae_due_at).toBe("2026-10-11T18:00:00.000Z");
    expect(nested.sae_stopped_at).toBe("2026-10-10T20:00:00.000Z");
  });

  it("only shows a measured/simulated badge when samples exist", () => {
    expect(hasVitalsSamples({ source: "check_in", vitals_status: "ok" })).toBe(true);
    expect(hasVitalsSamples({ source: "check_in", vitals_status: "simulated_ignored" })).toBe(true);
    expect(hasVitalsSamples({ source: "check_in", vitals_status: "low_quality" })).toBe(true);
    expect(hasVitalsSamples({ source: "check_in", vitals_status: "declined" })).toBe(false);
    expect(hasVitalsSamples({ source: "check_in", vitals_status: "unavailable" })).toBe(false);
    expect(hasVitalsSamples({ source: "check_in", vitals_status: null })).toBe(false);
  });
});

describe("filters → query", () => {
  it("resolves a display label to the USUBJID and passes unknown text through", () => {
    expect(resolveParticipantFilter("p-007", PARTICIPANTS)).toBe("R2810-ONC-1624-P-007");
    expect(resolveParticipantFilter(" R2810-ONC-1624-P-007 ", PARTICIPANTS)).toBe(
      "R2810-ONC-1624-P-007",
    );
    expect(resolveParticipantFilter("P-999", PARTICIPANTS)).toBe("P-999");
    expect(resolveParticipantFilter("   ", PARTICIPANTS)).toBeUndefined();
  });

  it("omits min_tier at 0 and always sends status/include_eval", () => {
    expect(
      buildQueueQuery(
        { participant: "", minTier: 0, status: "open", includeEval: false, offset: 0 },
        PARTICIPANTS,
        25,
      ),
    ).toEqual({
      usubjid: undefined,
      min_tier: undefined,
      status: "open",
      include_eval: false,
      limit: 25,
      offset: 0,
    });
    expect(
      buildQueueQuery(
        { participant: "P-007", minTier: 2, status: "all", includeEval: true, offset: 50 },
        PARTICIPANTS,
        25,
      ),
    ).toEqual({
      usubjid: "R2810-ONC-1624-P-007",
      min_tier: 2,
      status: "all",
      include_eval: true,
      limit: 25,
      offset: 50,
    });
  });
});

describe("filter-state helpers", () => {
  const base = {
    participant: "",
    minTier: 0,
    status: "open" as const,
    includeEval: false,
    offset: 0,
  };

  it("isDefaultFilters is true only for the untouched filter bar", () => {
    expect(isDefaultFilters(base)).toBe(true);
    expect(isDefaultFilters({ ...base, offset: 25 })).toBe(true); // paging is not a filter
    expect(isDefaultFilters({ ...base, participant: "P-007" })).toBe(false);
    expect(isDefaultFilters({ ...base, minTier: 2 })).toBe(false);
    expect(isDefaultFilters({ ...base, status: "all" })).toBe(false);
    expect(isDefaultFilters({ ...base, includeEval: true })).toBe(false);
  });

  it("hasNarrowingFilter counts participant and min tier, not status or include-eval", () => {
    expect(hasNarrowingFilter(base)).toBe(false);
    expect(hasNarrowingFilter({ ...base, status: "all", includeEval: true })).toBe(false);
    expect(hasNarrowingFilter({ ...base, participant: "  " })).toBe(false);
    expect(hasNarrowingFilter({ ...base, participant: "P-003" })).toBe(true);
    expect(hasNarrowingFilter({ ...base, minTier: 3 })).toBe(true);
  });
});
