/**
 * Pure stage-2 queue helpers: report clocks with a kind (R3.2), phone calls as
 * a source (R4.1), "needs action", the since-last-here counts and the
 * last-seen storage.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  clearLastSeen,
  DEFAULT_LOOKBACK_MS,
  LAST_SEEN_STORAGE_KEY,
  readLastSeen,
  writeLastSeen,
} from "../lastSeen";
import { clockKind, inferSource, needsAction, normalizeQueueItem } from "../normalize";
import { countLabel, rowsSince, summarizeSince } from "../summary";
import type { RawQueueItem } from "../types";

const BASE: RawQueueItem = {
  session_id: "01JSESSION00000000000000A",
  usubjid: "R2810-ONC-1624-P-007",
  display_label: "P-007",
  completed_at: "2026-10-10T06:00:00.000Z",
  tier: 1,
  tier_name: "Review within 1 business day",
  max_grade: 2,
  vitals_status: "simulated_ignored",
  is_measured: false,
  has_sae_clock: false,
  sae_due_at: null,
  escalation_acked: null,
  draft_counts: { AE: 1, VS: 0, CM: 0 },
  draft_status_summary: "1 draft",
};

afterEach(() => localStorage.clear());

describe("report clocks", () => {
  it("has no clock when the row has none", () => {
    expect(normalizeQueueItem(BASE).clocks).toEqual([]);
  });

  it("turns the legacy single clock into one clock, with no kind claimed when none is sent", () => {
    const row = normalizeQueueItem({
      ...BASE,
      has_sae_clock: true,
      sae_due_at: "2026-10-11T05:00:00.000Z",
    });
    expect(row.clocks).toHaveLength(1);
    expect(row.clocks[0]).toMatchObject({
      kind: "unknown",
      clock_id: null,
      due_at: "2026-10-11T05:00:00.000Z",
      stopped: false,
      packet_id: null,
    });
    expect(row.has_sae_clock).toBe(true);
  });

  it("reads the kind of a legacy clock from clock_kind / sae_clock.kind", () => {
    expect(
      normalizeQueueItem({ ...BASE, has_sae_clock: true, clock_kind: "sae" }).clocks[0].kind,
    ).toBe("sae");
    expect(
      normalizeQueueItem({ ...BASE, has_sae_clock: true, clock_kind: "aesi" }).clocks[0].kind,
    ).toBe("aesi");
    expect(
      normalizeQueueItem({ ...BASE, sae_clock: { kind: "AESI", due_at: "2026-10-11T00:00:00Z" } })
        .clocks[0].kind,
    ).toBe("aesi");
  });

  it("prefers clocks[] and keeps every clock with its kind and packet", () => {
    const row = normalizeQueueItem({
      ...BASE,
      has_sae_clock: true,
      sae_due_at: "2000-01-01T00:00:00.000Z",
      clocks: [
        { id: "a", kind: "aesi", due_at: "2026-10-11T01:00:00.000Z", packet_id: "pk1" },
        { id: "s", kind: "sae", due_at: null, stopped_at: "2026-10-10T07:00:00.000Z" },
      ],
    });
    expect(row.clocks.map((c) => [c.key, c.clock_id, c.kind, c.stopped, c.packet_id])).toEqual([
      ["a", "a", "aesi", false, "pk1"],
      ["s", "s", "sae", true, null],
    ]);
    // Legacy mirror fields follow the first clock.
    expect(row.sae_due_at).toBe("2026-10-11T01:00:00.000Z");
  });

  it("names a kind only when the API does; anything else is unknown, never a guessed SAE", () => {
    expect(clockKind("aesi")).toBe("aesi");
    expect(clockKind("AESI")).toBe("aesi");
    expect(clockKind("sae")).toBe("sae");
    expect(clockKind(" SAE ")).toBe("sae");
    expect(clockKind(undefined)).toBe("unknown");
    expect(clockKind(null)).toBe("unknown");
    expect(clockKind("other")).toBe("unknown");
  });

  it("keeps a synthetic key but no clock id when the API sends none", () => {
    const row = normalizeQueueItem({
      ...BASE,
      clocks: [{ kind: "sae", due_at: "2026-10-11T01:00:00.000Z" }],
    });
    expect(row.clocks[0].key).toBe(`${BASE.session_id}:clock0`);
    expect(row.clocks[0].clock_id).toBeNull();
  });
});

describe("phone calls", () => {
  it("is a phone call when the note type says so or the source does", () => {
    expect(inferSource({ source: "chart_note", note_type: "phone_call" })).toBe("phone_call");
    expect(inferSource({ session_id: null, note_id: "n1", note_type: "phone_call" })).toBe(
      "phone_call",
    );
    expect(inferSource({ source: "phone_call" })).toBe("phone_call");
    expect(inferSource({ source: "chart_note", note_type: "er_note" })).toBe("chart_note");
    // A check-in never becomes a call.
    expect(inferSource({ source: "check_in", note_type: "phone_call" })).toBe("check_in");
  });

  it("opens the note detail and shows no vitals", () => {
    const row = normalizeQueueItem({
      ...BASE,
      session_id: null,
      note_id: "01JNOTECALL",
      source: "chart_note",
      note_type: "phone_call",
    });
    expect(row.source).toBe("phone_call");
    expect(row.href).toBe("/dashboard/notes/01JNOTECALL");
  });
});

describe("needsAction", () => {
  it("uses the API's is_open when present", () => {
    expect(needsAction({ ...BASE, is_open: false })).toBe(false);
    expect(needsAction({ ...BASE, is_open: true, draft_status_summary: "3 confirmed" })).toBe(true);
  });

  it("falls back to pending drafts or an unacknowledged alert", () => {
    expect(needsAction({ ...BASE, draft_status_summary: "2 draft, 1 confirmed" })).toBe(true);
    expect(needsAction({ ...BASE, draft_status_summary: "3 confirmed" })).toBe(false);
    expect(needsAction({ ...BASE, draft_status_summary: "no drafts" })).toBe(false);
    expect(
      needsAction({ ...BASE, draft_status_summary: "3 confirmed", escalation_acked: false }),
    ).toBe(true);
  });
});

describe("summarizeSince", () => {
  const rows = [
    normalizeQueueItem({ ...BASE, completed_at: "2026-10-10T06:00:00.000Z", is_open: true }),
    normalizeQueueItem({
      ...BASE,
      session_id: null,
      note_id: "n-er",
      source: "chart_note",
      note_type: "er_note",
      completed_at: "2026-10-10T05:00:00.000Z",
      is_open: true,
      clocks: [{ id: "c1", kind: "sae", due_at: "2026-10-11T05:00:00.000Z" }],
    }),
    normalizeQueueItem({
      ...BASE,
      session_id: null,
      note_id: "n-call",
      source: "chart_note",
      note_type: "phone_call",
      completed_at: "2026-10-10T04:00:00.000Z",
      is_open: false,
    }),
    normalizeQueueItem({
      ...BASE,
      session_id: "old",
      completed_at: "2026-10-08T04:00:00.000Z",
      is_open: true,
      clocks: [
        { id: "c2", kind: "aesi", due_at: "2026-10-09T04:00:00.000Z" },
        { id: "c3", kind: "sae", stopped_at: "2026-10-08T09:00:00.000Z" },
      ],
    }),
  ];

  it("counts new items by source and those needing action", () => {
    const s = summarizeSince(rows, "2026-10-10T00:00:00.000Z");
    expect(s).toEqual({
      checkIns: 1,
      notes: 1,
      calls: 1,
      needAction: 2,
      clocksRunning: 2,
      aesiClocksRunning: 1,
      saeClocksRunning: 1,
      truncated: false,
    });
  });

  it("counts a clock of unknown kind as running but as neither serious nor special-interest", () => {
    const legacy = normalizeQueueItem({
      ...BASE,
      has_sae_clock: true,
      sae_due_at: "2026-10-11T05:00:00.000Z",
    });
    const s = summarizeSince([legacy], "2026-10-10T00:00:00.000Z");
    expect(s.clocksRunning).toBe(1);
    expect(s.saeClocksRunning).toBe(0);
    expect(s.aesiClocksRunning).toBe(0);
  });

  it("is strictly after the cut-off and flags truncation", () => {
    expect(rowsSince(rows, "2026-10-10T06:00:00.000Z")).toHaveLength(0);
    expect(summarizeSince(rows, "2026-10-10T00:00:00.000Z", 250).truncated).toBe(true);
  });

  it("pluralises plainly", () => {
    expect(countLabel(1, "check-in")).toBe("1 check-in");
    expect(countLabel(0, "check-in")).toBe("0 check-ins");
    expect(countLabel(2, "open sponsor query", "open sponsor queries")).toBe(
      "2 open sponsor queries",
    );
  });
});

describe("last-seen storage", () => {
  const NOW = Date.parse("2026-10-12T08:00:00.000Z");

  it("defaults to 24 hours ago when nothing is stored", () => {
    expect(readLastSeen(NOW)).toEqual({
      since: new Date(NOW - DEFAULT_LOOKBACK_MS).toISOString(),
      isDefault: true,
    });
  });

  it("reads what was written", () => {
    writeLastSeen("2026-10-09T22:15:00.000Z");
    expect(localStorage.getItem(LAST_SEEN_STORAGE_KEY)).toBe("2026-10-09T22:15:00.000Z");
    expect(readLastSeen(NOW)).toEqual({ since: "2026-10-09T22:15:00.000Z", isDefault: false });
  });

  it("clearLastSeen goes back to the 24-hour default", () => {
    writeLastSeen("2026-10-12T07:59:00.000Z");
    expect(readLastSeen(NOW).isDefault).toBe(false);
    clearLastSeen();
    expect(localStorage.getItem(LAST_SEEN_STORAGE_KEY)).toBeNull();
    expect(readLastSeen(NOW).isDefault).toBe(true);
  });

  it("ignores garbage and future values", () => {
    localStorage.setItem(LAST_SEEN_STORAGE_KEY, "yesterday-ish");
    expect(readLastSeen(NOW).isDefault).toBe(true);
    localStorage.setItem(LAST_SEEN_STORAGE_KEY, "2030-01-01T00:00:00.000Z");
    expect(readLastSeen(NOW).isDefault).toBe(true);
  });
});
