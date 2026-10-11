import { describe, expect, it } from "vitest";

import {
  clampOffset,
  escalationSource,
  filterEscalations,
  formatDuration,
  informationalDeadlines,
  isOverdue,
  median,
  medianSecondsToAck,
  mergeById,
  normalizeList,
  secondsRemaining,
  secondsToAck,
  sortClocks,
  sortEscalations,
} from "../model";
import type { ClockRow, EscalationRow } from "../../../../lib/types";

const T0 = Date.parse("2026-10-10T12:00:00.000Z");

function esc(partial: Partial<EscalationRow> & { id: string }): EscalationRow {
  return {
    session_id: "01JSESSION00000000000000AA",
    usubjid: "R2810-ONC-1624-P-007",
    tier: 2,
    reasons: ["any G3"],
    paged_at: null,
    acked_by: null,
    acked_at: null,
    seconds_to_ack: null,
    created_at: "2026-10-10T11:00:00.000Z",
    ...partial,
  };
}

function clock(partial: Partial<ClockRow> & { id: string }): ClockRow {
  return {
    session_id: "01JSESSION00000000000000AA",
    usubjid: "R2810-ONC-1624-P-003",
    site_awareness_at: "2026-10-10T10:00:00.000Z",
    due_at: "2026-10-11T10:00:00.000Z",
    stopped_at: null,
    stopped_by: null,
    decision: null,
    seconds_remaining: null,
    informational: {},
    ...partial,
  };
}

describe("generic helpers", () => {
  it("normalizeList accepts arrays and paginated envelopes", () => {
    expect(normalizeList([1, 2])).toEqual([1, 2]);
    expect(normalizeList({ items: [3], total: 1, limit: 25, offset: 0 })).toEqual([3]);
    expect(normalizeList(null)).toEqual([]);
  });

  it("mergeById keeps the first occurrence", () => {
    const a = [{ id: "x", v: 1 }];
    const b = [
      { id: "x", v: 2 },
      { id: "y", v: 3 },
    ];
    expect(mergeById(a, b)).toEqual([
      { id: "x", v: 1 },
      { id: "y", v: 3 },
    ]);
  });

  it("median", () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([Number.NaN, 7])).toBe(7);
  });

  it("clampOffset lands on the last real page when the row set shrinks", () => {
    expect(clampOffset(0, 0, 25)).toBe(0);
    expect(clampOffset(25, 0, 25)).toBe(0);
    expect(clampOffset(0, 10, 25)).toBe(0);
    expect(clampOffset(25, 26, 25)).toBe(25); // page 2 exists
    expect(clampOffset(25, 25, 25)).toBe(0); // page 2 vanished → back to page 1
    expect(clampOffset(50, 51, 25)).toBe(50);
    expect(clampOffset(75, 51, 25)).toBe(50);
    expect(clampOffset(-5, 51, 25)).toBe(0);
    expect(clampOffset(10, 3, 0)).toBe(2); // degenerate page size is treated as 1
    expect(clampOffset(10, 3, 1)).toBe(2);
  });

  it("formatDuration", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(125)).toBe("2m 05s");
    expect(formatDuration(3600 * 2 + 60 * 3)).toBe("2h 03m");
    expect(formatDuration(-10)).toBe("0s");
  });
});

describe("escalations", () => {
  it("derives the source from `source`, then from note_id", () => {
    expect(escalationSource(esc({ id: "a", source: "chart_note" }))).toBe("chart_note");
    expect(escalationSource(esc({ id: "b", note_id: "01JNOTE", session_id: null }))).toBe(
      "chart_note",
    );
    expect(escalationSource(esc({ id: "c" }))).toBe("check_in");
  });

  it("secondsToAck ticks live for open rows and uses the server value when acked", () => {
    const open = esc({ id: "o", created_at: "2026-10-10T11:30:00.000Z" });
    expect(secondsToAck(open, T0)).toBe(1800);
    const acked = esc({
      id: "a",
      acked_at: "2026-10-10T11:10:00.000Z",
      acked_by: "coordinator",
      seconds_to_ack: 600,
    });
    expect(secondsToAck(acked, T0)).toBe(600);
    // Server omitted seconds_to_ack: fall back to the two timestamps.
    const ackedNoSeconds = esc({
      id: "b",
      acked_at: "2026-10-10T11:05:00.000Z",
      acked_by: "coordinator",
      seconds_to_ack: null,
    });
    expect(secondsToAck(ackedNoSeconds, T0)).toBe(300);
    // Contract-shaped row with no created_at and no paged_at: nothing to compute.
    expect(secondsToAck(esc({ id: "c", created_at: undefined }), T0)).toBeNull();
    // paged_at is the fallback start.
    expect(
      secondsToAck(
        esc({ id: "d", created_at: undefined, paged_at: "2026-10-10T11:59:00.000Z" }),
        T0,
      ),
    ).toBe(60);
  });

  it("filters and sorts: open first, tier desc, newest first", () => {
    const rows = [
      esc({ id: "acked-3", tier: 3, acked_at: "2026-10-10T11:10:00.000Z", acked_by: "c" }),
      esc({ id: "open-2-old", tier: 2, created_at: "2026-10-10T09:00:00.000Z" }),
      esc({ id: "open-2-new", tier: 2, created_at: "2026-10-10T11:00:00.000Z" }),
      esc({ id: "open-3", tier: 3, created_at: "2026-10-10T08:00:00.000Z" }),
    ];
    expect(sortEscalations(rows).map((r) => r.id)).toEqual([
      "open-3",
      "open-2-new",
      "open-2-old",
      "acked-3",
    ]);
    expect(filterEscalations(rows, "open")).toHaveLength(3);
    expect(filterEscalations(rows, "acked")).toHaveLength(1);
    expect(filterEscalations(rows, "all")).toHaveLength(4);
  });

  it("medianSecondsToAck ignores open rows", () => {
    const rows = [
      esc({ id: "a", acked_at: "x", seconds_to_ack: 100 }),
      esc({ id: "b", acked_at: "x", seconds_to_ack: 300 }),
      esc({ id: "c" }),
    ];
    expect(medianSecondsToAck(rows)).toEqual({ median: 200, n: 2 });
    expect(medianSecondsToAck([esc({ id: "c" })])).toEqual({ median: null, n: 0 });
  });
});

describe("SAE clocks", () => {
  it("secondsRemaining is live from due_at and null once stopped", () => {
    const c = clock({ id: "a", due_at: "2026-10-10T13:00:00.000Z" });
    expect(secondsRemaining(c, T0)).toBe(3600);
    expect(isOverdue(c, T0)).toBe(false);
    expect(isOverdue(c, T0 + 2 * 3600 * 1000)).toBe(true);
    expect(
      secondsRemaining(clock({ id: "b", stopped_at: "2026-10-10T11:00:00.000Z" }), T0),
    ).toBeNull();
    // Unparsable due_at falls back to the server snapshot.
    expect(secondsRemaining(clock({ id: "c", due_at: "nope", seconds_remaining: 42 }), T0)).toBe(
      42,
    );
  });

  it("sortClocks puts active (soonest due) first, then stopped (latest first)", () => {
    const rows = [
      clock({ id: "stopped-old", stopped_at: "2026-10-09T10:00:00.000Z" }),
      clock({ id: "active-late", due_at: "2026-10-12T10:00:00.000Z" }),
      clock({ id: "stopped-new", stopped_at: "2026-10-10T10:00:00.000Z" }),
      clock({ id: "active-soon", due_at: "2026-10-10T13:00:00.000Z" }),
    ];
    expect(sortClocks(rows).map((r) => r.id)).toEqual([
      "active-soon",
      "active-late",
      "stopped-new",
      "stopped-old",
    ]);
  });

  it("informationalDeadlines separates dated keys from source/note text", () => {
    const out = informationalDeadlines({
      sponsor_other_serious_due: "2026-10-25T10:00:00.000Z",
      sponsor_fatal_or_life_threatening_due: "2026-10-17T10:00:00.000Z",
      source: "21 CFR 312.32(c)",
      note: "Informational only.",
      something_else: "not a date",
    });
    expect(out.deadlines.map((d) => d.key)).toEqual([
      "sponsor_fatal_or_life_threatening_due",
      "sponsor_other_serious_due",
    ]);
    expect(out.deadlines[0].label).toMatch(/7-day/);
    expect(out.deadlines[1].label).toMatch(/15-day/);
    expect(out.source).toBe("21 CFR 312.32(c)");
    expect(out.note).toBe("Informational only.");
    expect(informationalDeadlines(null)).toEqual({ deadlines: [], source: null, note: null });
  });
});
