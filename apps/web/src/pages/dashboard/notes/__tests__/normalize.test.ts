import { describe, expect, it } from "vitest";

import {
  labelFromUsubjid,
  normalizeDraft,
  normalizeNoteDetail,
  normalizeNotesPage,
  normalizeScan,
} from "../normalize";

describe("normalizeScan", () => {
  it("accepts the contract field names", () => {
    const s = normalizeScan({
      symptoms: [
        {
          term: "Dyspnea",
          quote: "SOB",
          span_start: 4,
          span_end: 7,
          reason: "r",
          grade_hint: 2,
          grade_basis: "b",
          onset_days: 7,
          worsening: true,
          excluded_reason: null,
        },
      ],
      excluded_symptoms: [],
      meds: [
        {
          drug: "lisinopril",
          change: "stopped",
          quote: "Holding lisinopril",
          span_start: 1,
          span_end: 19,
          reason: "r",
          excluded_reason: null,
        },
      ],
      excluded_meds: [],
      red_flags: [
        {
          level: "urgent",
          category: "dyspnea",
          quote: "q",
          span_start: 0,
          span_end: 1,
          reason: "x",
        },
      ],
    });
    expect(s.symptoms[0]).toMatchObject({
      term: "Dyspnea",
      grade_hint: 2,
      onset_days: 7,
      worsening: true,
    });
    expect(s.meds[0]).toMatchObject({ drug: "lisinopril", change: "stopped" });
    expect(s.red_flags[0].level).toBe("urgent");
  });

  it("accepts the legacy source-repo field names and fills missing optionals", () => {
    const s = normalizeScan({
      symptoms: [
        { term: "Cough", mentioned_as: "Dry cough", span_start: 3, grade: 1, onset_days_ago: 5 },
      ],
      excluded_symptoms: [
        { term: "Cough", quote: "cough", span_start: 9, span_end: 14, excluded: "indication" },
      ],
      meds: [
        {
          drug: "x",
          action: "started",
          mentioned_as: "started x",
          span_start: 0,
          span_end: 9,
          reasoning: "why",
        },
      ],
      excluded_meds: [{ drug: "y", action: "bogus" }],
      red_flags: [{ level: "nope" }],
    });
    expect(s.symptoms[0]).toMatchObject({
      quote: "Dry cough",
      span_end: 3 + "Dry cough".length,
      grade_hint: 1,
      onset_days: 5,
      worsening: false,
      excluded_reason: null,
      grade_basis: "",
    });
    expect(s.excluded_symptoms[0].excluded_reason).toBe("indication");
    expect(s.meds[0]).toMatchObject({ change: "started", reason: "why" });
    expect(s.excluded_meds[0]).toMatchObject({
      drug: "y",
      change: "taking",
      quote: "",
      span_start: 0,
      span_end: 0,
    });
    expect(s.red_flags[0]).toMatchObject({ level: "urgent", category: "red_flag" });
  });

  it("tolerates garbage and a nested {scan: …} wrapper", () => {
    expect(normalizeScan(null)).toEqual({
      symptoms: [],
      excluded_symptoms: [],
      meds: [],
      excluded_meds: [],
      red_flags: [],
    });
    expect(normalizeScan({ scan: { meds: [{ drug: "a" }] } }).meds).toHaveLength(1);
  });
});

describe("normalizeNoteDetail", () => {
  it("reads {note, scan, drafts, …} and falls back to rule descriptions for `why`", () => {
    const d = normalizeNoteDetail({
      note: { id: "n1", usubjid: "R2810-ONC-1624-P-003", note_date: "2026-10-09", text: "t" },
      scan: {},
      drafts: [
        {
          id: "d1",
          domain: "CM",
          fields: { CMTRT: "x" },
          evidence: {
            CMTRT: [{ kind: "chart_note", id: "n1", note: "x", span_start: 0, span_end: 1 }],
          },
        },
      ],
      rules_fired: [{ rule_id: "r", description: "because" }],
    });
    expect(d.note.display_label).toBe("P-003");
    expect(d.drafts[0]).toMatchObject({
      domain: "CM",
      status: "draft",
      version: 1,
      source: "chart_note",
    });
    expect(d.drafts[0].evidence.CMTRT[0]).toMatchObject({ span_start: 0, span_end: 1 });
    expect(d.why).toEqual(["because"]);
    expect(d.escalation).toBeNull();
    expect(d.sae_clock).toBeNull();
  });

  it("normalizes a partial escalation / SAE clock instead of passing them through", () => {
    const d = normalizeNoteDetail({
      note: { id: "n1", usubjid: "u" },
      // No `reasons`, no `acked_at`: the shapes an API might send before every
      // column is populated. These used to be cast straight through.
      escalation: { id: "e1", tier: 2, reasons: null },
      sae_clock: { id: "s1", due_at: "2026-10-11T00:00:00.000Z", informational: { x: 1 } },
    });
    expect(d.escalation).toEqual({
      id: "e1",
      session_id: "",
      usubjid: "",
      tier: 2,
      reasons: [],
      paged_at: null,
      acked_by: null,
      acked_at: null,
      seconds_to_ack: null,
      note_id: null,
      source: "chart_note",
    });
    expect(d.sae_clock).toMatchObject({
      id: "s1",
      due_at: "2026-10-11T00:00:00.000Z",
      site_awareness_at: "",
      stopped_at: null,
      decision: null,
      seconds_remaining: null,
      informational: {},
    });
    // Non-objects are treated as "none", and the tier floor for a note is 2.
    const g = normalizeNoteDetail({ escalation: "nope", sae_clock: 5 });
    expect(g.escalation).toBeNull();
    expect(g.sae_clock).toBeNull();
    expect(
      normalizeNoteDetail({ escalation: { reasons: ["a", 7, "b"] } }).escalation,
    ).toMatchObject({
      tier: 2,
      reasons: ["a", "b"],
    });
  });

  it("accepts the note's fields at the top level", () => {
    const d = normalizeNoteDetail({ id: "n2", usubjid: "u", text: "hello", symptoms: [] });
    expect(d.note.id).toBe("n2");
    expect(d.note.text).toBe("hello");
  });

  it("normalizeDraft never throws on an unknown status or domain", () => {
    const d = normalizeDraft({ id: "x", domain: "ZZ", status: "weird", evidence: "nope" });
    expect(d.domain).toBe("AE");
    expect(d.status).toBe("draft");
    expect(d.evidence).toEqual({});
  });
});

describe("normalizeNotesPage", () => {
  it("derives counts from the embedded scan or draft_counts when the API omits them", () => {
    const p = normalizeNotesPage(
      {
        items: [
          {
            id: "a",
            usubjid: "u",
            scan: { symptoms: [{}, {}], meds: [{}], red_flags: [] },
            draft_counts: { AE: 2, CM: 1 },
          },
          { id: "b", usubjid: "u", n_symptoms: 5, n_drafts: 9 },
        ],
        total: 2,
        limit: 10,
        offset: 0,
      },
      { limit: 10 },
    );
    expect(p.items[0]).toMatchObject({ n_symptoms: 2, n_meds: 1, n_red_flags: 0, n_drafts: 3 });
    expect(p.items[1]).toMatchObject({ n_symptoms: 5, n_drafts: 9 });
    expect(p.items[1].n_meds).toBeUndefined();
  });

  it("accepts a bare array", () => {
    const p = normalizeNotesPage([{ id: "a", usubjid: "u" }], { limit: 10 });
    expect(p.total).toBe(1);
    expect(p.offset).toBe(0);
  });

  it("labelFromUsubjid extracts P-xxx and otherwise returns the input", () => {
    expect(labelFromUsubjid("R2810-ONC-1624-P-007")).toBe("P-007");
    expect(labelFromUsubjid("p-007")).toBe("P-007");
    expect(labelFromUsubjid("something")).toBe("something");
  });
});
