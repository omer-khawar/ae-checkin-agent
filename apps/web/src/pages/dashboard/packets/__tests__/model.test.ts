/**
 * Pure helpers behind the packet page: normalisation of contract-shaped JSON,
 * plain labels, value editing round-trips, evidence lookup, the narrative view
 * and the deadline fallback.
 */
import { describe, expect, it } from "vitest";

import {
  evidenceIndex,
  evidenceLink,
  evidenceQuote,
  explainer,
  formatValue,
  kindLabel,
  narrativeView,
  normalizeClocks,
  normalizePacket,
  parseEditText,
  participantLabel,
  resolveDeadline,
  secondsUntil,
  sequenceLabel,
  unwrapPacket,
  valuesEqual,
  valueToEditText,
  writerLabel,
} from "../model";
import { ANSWER_ID, CLOCK_ID, draftPacket, followUpPacket, NOTE_ID } from "./fixtures";

describe("labels", () => {
  it("leads with plain names, not abbreviations", () => {
    expect(kindLabel("sae")).toBe("Serious event report");
    expect(kindLabel("aesi")).toBe("Special-interest event report");
    expect(sequenceLabel(0)).toBe("Initial report");
    expect(sequenceLabel(2)).toBe("Follow-up 2");
    expect(writerLabel("template")).toBe("Written by template");
    expect(writerLabel("llm")).toBe("Written by Claude");
  });

  it("explains the 24-hour obligation in one sentence, with no advice", () => {
    for (const kind of ["sae", "aesi"] as const) {
      const s = explainer(kind);
      expect(s).toMatch(/within 24 hours/);
      expect(s).toMatch(/pre-filled this draft/);
      expect(s.split(/[.!?](\s|$)/).filter((x) => x.trim()).length).toBe(1);
    }
    expect(explainer("aesi")).toMatch(/investigator to confirm/);
  });
});

describe("values", () => {
  it("formats unknowns, booleans and lists", () => {
    expect(formatValue(null)).toBe("Not known yet");
    expect(formatValue("  ")).toBe("Not known yet");
    expect(formatValue(true)).toBe("Yes");
    expect(formatValue(["a", "b"])).toBe("a, b");
    expect(formatValue(3)).toBe("3");
  });

  it("keeps the original type when parsing an edit", () => {
    expect(parseEditText("", "x")).toBeNull();
    expect(parseEditText(" 4 ", 3)).toBe(4);
    expect(parseEditText("four", 3)).toBe("four");
    expect(parseEditText("no", true)).toBe(false);
    expect(parseEditText("a, b ,", ["x"])).toEqual(["a", "b"]);
    expect(parseEditText("Recovering", null)).toBe("Recovering");
  });

  it("round-trips through the editor text", () => {
    for (const v of ["text", 7, true, false, ["a", "b"], null] as const) {
      const back = parseEditText(valueToEditText(v as never), v as never);
      expect(valuesEqual(back, v as never)).toBe(true);
    }
  });
});

describe("normalizePacket", () => {
  it("reads the contract shape", () => {
    const p = normalizePacket(draftPacket());
    expect(p.kind).toBe("sae");
    expect(p.status).toBe("draft");
    expect(p.fields).toHaveLength(3);
    expect(p.fields[0].evidence[0].quote).toBe("worsening shortness of breath");
    expect(p.narrative.sentences).toHaveLength(2);
    expect(p.sequence).toBe(0);
    expect(participantLabel(p)).toBe("P-004");
  });

  it("tolerates a minimal packet and fills safe defaults", () => {
    const p = normalizePacket({ id: "x", kind: "aesi", usubjid: "STUDY-P-009" });
    expect(p.kind).toBe("aesi");
    expect(p.status).toBe("draft");
    expect(p.fields).toEqual([]);
    expect(p.missing_information).toEqual([]);
    expect(p.narrative.writer).toBe("template");
    expect(p.changes_since_previous).toEqual([]);
    expect(participantLabel(p)).toBe("P-009");
  });

  it("rejects a response with no id", () => {
    expect(() => normalizePacket({ kind: "sae" })).toThrow(/no id/);
  });

  it("unwraps {packet, mock_edc_ack}", () => {
    const raw = unwrapPacket({ packet: draftPacket(), mock_edc_ack: { ack_id: "EDC-1" } });
    expect(normalizePacket(raw).mock_edc_ack_id).toBe("EDC-1");
  });

  it("reads follow-up changes", () => {
    const p = normalizePacket(followUpPacket());
    expect(p.sequence).toBe(1);
    expect(p.changes_since_previous[0]).toMatchObject({
      field: "AEOUT",
      before: null,
      after: "Recovering",
    });
  });
});

describe("evidence", () => {
  it("indexes field, change and extra evidence by id", () => {
    const p = normalizePacket(
      draftPacket({ evidence_index: { EXTRA: { kind: "rule", id: "", ts: null, note: "r" } } }),
    );
    const idx = evidenceIndex(p);
    expect(idx.get(NOTE_ID)?.kind).toBe("chart_note");
    expect(idx.get(ANSWER_ID)?.kind).toBe("gate_answer");
    expect(idx.get("EXTRA")?.note).toBe("r");
    expect(idx.has("01JUNKNOWN000000000000000Z")).toBe(false);
  });

  it("finds quotes and source links", () => {
    const p = normalizePacket(draftPacket());
    const note = p.fields[0].evidence[0];
    expect(evidenceQuote(note)).toBe("worsening shortness of breath");
    expect(evidenceLink(note)).toBe(`/dashboard/notes/${NOTE_ID}`);
    expect(
      evidenceLink({ kind: "pro_response", id: "a", ts: null, note: "", session_id: "S1" }),
    ).toBe("/dashboard/checkins/S1");
    expect(evidenceLink({ kind: "rule", id: "a", ts: null, note: "" })).toBeNull();
  });
});

describe("narrativeView", () => {
  it("shows generated sentences when nobody edited them", () => {
    const v = narrativeView(normalizePacket(draftPacket()));
    expect(v.editedByPerson).toBe(false);
    expect(v.sentences).toHaveLength(2);
  });

  it("prefers a person's saved text and keeps the sentences one level deeper", () => {
    const v = narrativeView(
      normalizePacket(
        draftPacket({
          narrative_edited: { text: "Rewritten.", edited_by: "investigator", edited_at: null },
        }),
      ),
    );
    expect(v.editedByPerson).toBe(true);
    expect(v.text).toBe("Rewritten.");
    expect(v.editedBy).toBe("investigator");
    expect(v.sentences).toHaveLength(2);
  });

  it("detects an edit stored straight in narrative.text", () => {
    const base = draftPacket();
    const narrative = { ...(base.narrative as Record<string, unknown>), text: "Changed." };
    const v = narrativeView(normalizePacket({ ...base, narrative }));
    expect(v.editedByPerson).toBe(true);
    expect(v.text).toBe("Changed.");
  });
});

describe("deadline", () => {
  it("uses the packet's own due_at first", () => {
    const p = normalizePacket(draftPacket());
    expect(resolveDeadline(p, null).dueAt).toBe("2026-10-13T05:00:00.000Z");
  });

  it("falls back to the clock row", () => {
    const p = normalizePacket(draftPacket({ due_at: null, site_awareness_at: null }));
    const clocks = normalizeClocks({
      items: [
        {
          id: CLOCK_ID,
          kind: "sae",
          site_awareness_at: "2026-10-12T05:00:00Z",
          due_at: "2026-10-13T05:00:00Z",
          stopped_at: null,
          decision: null,
        },
      ],
      total: 1,
      limit: 25,
      offset: 0,
    });
    const d = resolveDeadline(p, clocks);
    expect(d.dueAt).toBe("2026-10-13T05:00:00Z");
    expect(d.siteAwarenessAt).toBe("2026-10-12T05:00:00Z");
  });

  it("counts seconds both ways", () => {
    const now = Date.parse("2026-10-12T05:00:00Z");
    expect(secondsUntil("2026-10-12T06:00:00Z", now)).toBe(3600);
    expect(secondsUntil("2026-10-12T04:00:00Z", now)).toBe(-3600);
    expect(secondsUntil(null, now)).toBeNull();
    expect(secondsUntil("garbage", now)).toBeNull();
  });
});
