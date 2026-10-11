import { describe, expect, it } from "vitest";

import {
  ageHours,
  buildAnswer,
  coerceValue,
  editableFields,
  evidenceIndex,
  evidenceKindLabel,
  fieldLabel,
  formatAge,
  formatValue,
  isAgeAlert,
  participantLabel,
  queriedFieldBlock,
  queryFields,
  raisedBy,
  writtenEvidenceIds,
  writerLabel,
} from "../model";
import {
  AE_DRAFT_7,
  ANSWER_EV,
  ANSWERED_ROW,
  CM_DRAFT,
  CM_DRAFT_WITH_TERM_EV,
  CMTRT_EV,
  NOTE_EV,
  OPEN_DETAIL,
  OPEN_DETAIL_CITES_TERM,
  OPEN_ROW,
  SAFETY_ROW,
} from "./fixtures";

const NOW = Date.parse("2026-10-10T08:00:00.000Z");

describe("labels", () => {
  it("prefers the API's plain label, then the local table, then the SDTM name", () => {
    expect(fieldLabel("CMDOSE", "Dose (from API)")).toBe("Dose (from API)");
    expect(fieldLabel("CMDOSE")).toBe("Dose");
    expect(fieldLabel("XXFOO")).toBe("XXFOO");
  });

  it("derives a participant label when the API sends none", () => {
    expect(participantLabel(OPEN_ROW)).toBe("P-004");
    expect(participantLabel(SAFETY_ROW)).toBe("P-007");
  });

  it("names who raised it, keeping the check id as a code", () => {
    expect(raisedBy(OPEN_ROW)).toEqual({
      label: "Automatic data check",
      code: "query.cm_required_fields",
    });
    expect(raisedBy(SAFETY_ROW).label).toBe("Sponsor monitor");
  });

  it("formats empty values visibly", () => {
    expect(formatValue(null)).toBe("(empty)");
    expect(formatValue("")).toBe("(empty)");
    expect(formatValue(true)).toBe("Yes");
    expect(formatValue(["a", "b"])).toBe("a, b");
  });
});

describe("aging", () => {
  it("measures open queries from raised_at and turns red only past 72 h", () => {
    expect(ageHours(OPEN_ROW, NOW)).toBe(96);
    expect(isAgeAlert(OPEN_ROW, 96)).toBe(true);
    expect(isAgeAlert(OPEN_ROW, 72)).toBe(false);
    expect(ageHours(SAFETY_ROW, NOW)).toBe(2);
  });

  it("measures answered queries up to the answer, never red", () => {
    const h = ageHours(ANSWERED_ROW, NOW);
    expect(h).toBe(4);
    expect(isAgeAlert(ANSWERED_ROW, 500)).toBe(false);
  });

  it("keeps aging while the page stays open, ignoring the stale age_hours snapshot", () => {
    // Loaded at 71 h; two hours later the page must say 73 h and go red.
    const raised = NOW - 73 * 3_600_000;
    const row = { ...OPEN_ROW, raised_at: new Date(raised).toISOString(), age_hours: 71 };
    const h = ageHours(row, NOW);
    expect(h).toBe(73);
    expect(isAgeAlert(row, h)).toBe(true);
  });

  it("falls back to age_hours only when raised_at does not parse", () => {
    expect(ageHours({ ...OPEN_ROW, raised_at: "not a time", age_hours: 12.7 }, NOW)).toBe(12);
    expect(ageHours({ ...OPEN_ROW, raised_at: "not a time", age_hours: null }, NOW)).toBeNull();
  });

  it("computes from raised_at when the API omits age_hours", () => {
    const row = { ...OPEN_ROW, age_hours: undefined };
    expect(ageHours(row, NOW)).toBe(96);
    expect(formatAge(0)).toBe("< 1 h");
    expect(formatAge(null)).toBe("—");
  });
});

describe("evidence", () => {
  it("indexes field evidence first, de-duplicates, and lists cited ids in order", () => {
    const idx = evidenceIndex(OPEN_DETAIL, CM_DRAFT);
    expect(idx.map((e) => e.id)).toEqual([ANSWER_EV, "protocol:7.7:p69"]);
    expect(writtenEvidenceIds(OPEN_DETAIL.suggested_answer)).toEqual([
      ANSWER_EV,
      "protocol:7.7:p69",
      NOTE_EV,
    ]);
    expect(writerLabel({ writer: "template" })).toBe("Written by template");
    expect(writerLabel({ writer: "llm" })).toBe("Written by Claude");
  });

  it("resolves chips cited from other fields of the record (CMTRT on a CMDOSE query)", () => {
    const idx = evidenceIndex(OPEN_DETAIL_CITES_TERM, CM_DRAFT_WITH_TERM_EV);
    const term = idx.find((e) => e.id === CMTRT_EV);
    expect(term).toBeDefined();
    expect(term?.primary).toBe(false);
    // The queried field's evidence still lists first and is primary.
    expect(idx[0]).toMatchObject({ id: ANSWER_EV, primary: true });
    // Every id the suggestion cites resolves.
    for (const id of writtenEvidenceIds(OPEN_DETAIL_CITES_TERM.suggested_answer)) {
      expect(idx.some((e) => e.id === id)).toBe(true);
    }
  });

  it("merges pointers the API resolves for the suggestion", () => {
    const detail = {
      ...OPEN_DETAIL,
      suggested_answer: {
        ...OPEN_DETAIL.suggested_answer!,
        evidence: [{ kind: "chart_note", id: NOTE_EV, ts: null, note: "Urgent-care note" }],
      },
    };
    expect(evidenceIndex(detail, CM_DRAFT).find((e) => e.id === NOTE_EV)).toMatchObject({
      kind: "chart_note",
      primary: false,
    });
  });

  it("reads the API's top-level evidence_index map as secondary rows", () => {
    const detail = {
      ...OPEN_DETAIL,
      evidence_index: {
        [NOTE_EV]: { kind: "chart_note", ts: null, note: "Urgent-care note" },
        [ANSWER_EV]: { kind: "gate_answer", id: ANSWER_EV, ts: null, note: "duplicate" },
      },
    };
    const idx = evidenceIndex(detail, CM_DRAFT);
    expect(idx.find((e) => e.id === NOTE_EV)).toMatchObject({
      kind: "chart_note",
      primary: false,
    });
    // Ids already on the record are not listed twice.
    expect(idx.filter((e) => e.id === ANSWER_EV)).toHaveLength(1);
  });

  it("never invents an 'unknown' row for a bare answer id", () => {
    const unresolved = evidenceIndex(
      { field: "AEENDTC", evidence: null, answer_evidence: ["01JNOWHERE0000000000000000"] },
      null,
    );
    expect(unresolved).toEqual([]);
    // A bare id that is on the record resolves to the record's pointer.
    const resolved = evidenceIndex(
      { field: "CMSTDTC", evidence: null, answer_evidence: [ANSWER_EV] },
      CM_DRAFT,
    );
    expect(resolved).toEqual([expect.objectContaining({ id: ANSWER_EV, kind: "gate_answer" })]);
    expect(resolved.some((e) => e.kind === "unknown")).toBe(false);
  });

  it("labels an unexpected evidence kind in plain words", () => {
    expect(evidenceKindLabel("unknown")).toBe("Cited item");
    expect(evidenceKindLabel("chart_note")).toBe("Chart note");
  });
});

describe("answer request", () => {
  const base = {
    text: "  Answer text  ",
    citeSuggestion: true,
    alsoEdit: false,
    editField: "CMDOSE",
    editValue: "",
  };

  it("rejects an empty answer", () => {
    expect(buildAnswer({ ...base, text: "  " }, null, null)).toEqual({
      ok: false,
      error: "Write an answer before sending it.",
    });
  });

  it("trims the text and attaches the suggestion's evidence ids", () => {
    const r = buildAnswer(base, OPEN_DETAIL.suggested_answer, CM_DRAFT);
    expect(r).toEqual({
      ok: true,
      body: { answer_text: "Answer text", evidence_ids: [ANSWER_EV, "protocol:7.7:p69", NOTE_EV] },
    });
  });

  it("omits evidence ids when not citing, and adds also_edit when correcting", () => {
    const r = buildAnswer(
      { ...base, citeSuggestion: false, alsoEdit: true, editValue: "10" },
      OPEN_DETAIL.suggested_answer,
      CM_DRAFT,
    );
    expect(r).toEqual({
      ok: true,
      body: { answer_text: "Answer text", also_edit: { field: "CMDOSE", value: "10" } },
    });
  });

  it("keeps numbers numeric and clears with an empty box", () => {
    expect(coerceValue("2", 3)).toBe(2);
    expect(coerceValue("2", null)).toBe("2");
    expect(coerceValue("  ", "x")).toBeNull();
  });

  it("lists editable fields with the queried one first and identity fields excluded", () => {
    const f = editableFields(CM_DRAFT, "CM", "CMDOSE");
    expect(f[0]).toBe("CMDOSE");
    expect(f).not.toContain("USUBJID");
    expect(f).not.toContain("STUDYID");
    expect(f).not.toContain("CMTRT"); // kept verbatim by design
    expect(new Set(f).size).toBe(f.length);
  });
});

describe("also_edit field gating", () => {
  const FORBIDDEN = [
    "AESER",
    "AEREL",
    "INTERIM_IRAE",
    "INTERIM_TIER",
    "INTERIM_RULES_FIRED",
    "AESEQ",
  ];

  it("never offers investigator-only, computed or identity fields", () => {
    const f = editableFields(AE_DRAFT_7, "AE", "AESER");
    for (const bad of FORBIDDEN) expect(f).not.toContain(bad);
    expect(f.some((x) => x.startsWith("INTERIM_"))).toBe(false);
    // The queried AESER is not first because it is not offered at all.
    expect(f[0]).toBe("AETERM");
  });

  it("points AESER / AEREL / INTERIM_IRAE queries at the investigator box", () => {
    for (const field of ["AESER", "AEREL", "INTERIM_IRAE"]) {
      expect(queriedFieldBlock(AE_DRAFT_7, "AE", field, "coordinator")?.kind).toBe("investigator");
      // Not even an investigator corrects these through also_edit.
      const inv = queriedFieldBlock(AE_DRAFT_7, "AE", field, "investigator");
      expect(inv?.kind).toBe("investigator");
      expect(inv?.message).toMatch(/investigator box/);
    }
    expect(queriedFieldBlock(AE_DRAFT_7, "AE", "AEENDTC", "coordinator")).toBeNull();
  });

  it("offers the R3.1 CM details only when the record carries them", () => {
    expect(editableFields(CM_DRAFT, "CM", "CMDOSE")).toEqual(
      expect.arrayContaining(["CMDOSE", "CMDOSU", "CMINDC"]),
    );
    // CM_DRAFT has no CMDOSFRQ key: offering it would earn a 422.
    expect(editableFields(CM_DRAFT, "CM", "CMDOSE")).not.toContain("CMDOSFRQ");
    expect(queriedFieldBlock(CM_DRAFT, "CM", "CMDOSFRQ", "coordinator")?.kind).toBe(
      "not_on_record",
    );
    const bare = { ...CM_DRAFT, fields: { CMTRT: "prednisone", CMSTDTC: "2026-10-09" } };
    expect(editableFields(bare, "CM", "CMDOSE")).toEqual(["CMSTDTC"]);
    expect(queriedFieldBlock(bare, "CM", "CMTRT", "coordinator")?.kind).toBe("not_editable");
  });

  it("offers the fields the query covers even when the record has no key yet (dose missing)", () => {
    // Regression: the seeded "dose missing" query offered CMDECOD first, so typing a
    // dose into "Also correct the field" overwrote the drug's standard name.
    const bare = { ...CM_DRAFT, fields: { CMTRT: "Zofran", CMDECOD: "ondansetron" } };
    const covered = ["CMDOSE", "CMDOSU", "CMDOSFRQ", "CMINDC"];
    const f = editableFields(bare, "CM", "CMDOSE", covered);
    expect(f[0]).toBe("CMDOSE");
    expect(f).toEqual(expect.arrayContaining(covered));
    expect(f).not.toContain("CMTRT");
    expect(queriedFieldBlock(bare, "CM", "CMDOSE", "coordinator", covered)).toBeNull();
    // Without the query's coverage the old gate still applies.
    expect(editableFields(bare, "CM", "CMDOSE")).not.toContain("CMDOSE");
  });

  it("lists every field the query covers, queried field first", () => {
    expect(queryFields({ field: "CMDOSE", fields: ["CMDOSE", "CMDOSU", "CMINDC"] })).toEqual([
      "CMDOSE",
      "CMDOSU",
      "CMINDC",
    ]);
    expect(queryFields({ field: "AEENDTC" })).toEqual(["AEENDTC"]);
  });
});
