import { describe, expect, it } from "vitest";

import {
  allRules,
  attributionBody,
  changedFields,
  describeGate,
  diffVersions,
  draftTitle,
  editProblem,
  gradeDefinitions,
  gradeHover,
  groupDrafts,
  highlightSet,
  informationalLabel,
  isEditable,
  optionLabel,
  secondsUntil,
  selectionEvidence,
  sortAnswers,
  stoppedRemaining,
  vitalsProvenance,
  vsDraftIsMeasured,
} from "../model";
import {
  A_COUGH_SEV,
  A_SOB_INT,
  A_SOB_SEV,
  AE,
  AE_DRAFT,
  CM,
  detail,
  RULES,
  S3,
  S4,
  VS,
  withRepeatedRules,
} from "./fixture";

describe("model helpers", () => {
  it("sorts answers by server receipt time, stable on ties", () => {
    const d = detail();
    const shuffled = [...d.answers].reverse();
    expect(sortAnswers(shuffled).map((a) => a.id)).toEqual(d.answers.map((a) => a.id));
  });

  it("labels options from PRO-CTCAE defaults when no items table is loaded", () => {
    expect(optionLabel("shortness_of_breath", "severity", 2, null)).toBe("Moderate");
    expect(optionLabel("x", "interference", 2, null)).toBe("Somewhat");
    expect(optionLabel("x", "gate", 1, null)).toBeNull();
  });

  it("describes gate answers: yes/no, verbatim free text, con-med text", () => {
    const d = detail();
    const hosp = d.answers.find((a) => a.item_id === "gate_hospitalization")!;
    const other = d.answers.find((a) => a.item_id === "gate_other")!;
    const cm = d.answers.find((a) => a.item_id === "gate_conmed_text")!;
    expect(describeGate(hosp)).toMatchObject({ text: "No", verbatim: false });
    expect(describeGate(other)).toMatchObject({
      text: "Felt winded on the stairs.",
      verbatim: true,
      matchedOnly: false,
    });
    expect(describeGate(cm)).toMatchObject({
      text: "loratadine",
      verbatim: true,
      matchedOnly: true,
    });
  });

  it("groups current drafts by domain and drops superseded rows", () => {
    const g = groupDrafts([VS, CM, AE, { ...AE, id: "old", status: "superseded" }]);
    expect(g.AE.map((d) => d.id)).toEqual([AE.id]);
    expect(g.VS).toHaveLength(1);
    expect(g.CM).toHaveLength(1);
  });

  it("titles drafts with SDTM identifiers", () => {
    expect(draftTitle(AE)).toBe("AE 1 · Dyspnea");
    expect(draftTitle(VS)).toBe("VS · PULSE");
    expect(draftTitle(CM)).toBe("CM · loratadine");
  });

  it("never lets provenance or attribution fields be edited inline", () => {
    expect(isEditable("AE", "AETOXGR")).toBe(true);
    expect(isEditable("AE", "AESER")).toBe(false);
    expect(isEditable("AE", "INTERIM_TIER")).toBe(false);
    expect(isEditable("CM", "CMTRT")).toBe(false);
  });

  it("diffs the editor against the original and parses numbers", () => {
    const changes = changedFields(AE.fields, {
      AETOXGR: "3",
      AETERM: "Shortness of breath",
      AEENDTC: "",
      AEOUT: "RECOVERING",
    });
    expect(changes).toEqual({ AETOXGR: 3, AEOUT: "RECOVERING" });
  });

  it("refuses grades above the maximum Interim assigns", () => {
    expect(editProblem("AETOXGR", "3")).toBeNull();
    expect(editProblem("AETOXGR", "4")).toMatch(/never assigns/);
    expect(editProblem("VSORRES", "abc")).toMatch(/number/);
  });

  it("resolves the evidence behind a field or a rule selection", () => {
    const d = detail();
    const ids = highlightSet(
      selectionEvidence({ kind: "field", draftId: AE_DRAFT, field: "AETOXGR" }, d),
    );
    expect(ids.has(A_SOB_SEV)).toBe(true);
    expect(ids.has(A_SOB_INT)).toBe(true);
    expect(ids.has("grade.provisional.shortness_of_breath")).toBe(true);
    const ruleIds = highlightSet(
      selectionEvidence({ kind: "rule", ruleId: "tier.base", index: 3 }, d),
    );
    expect([...ruleIds]).toEqual(["grade.provisional.shortness_of_breath"]);
    expect(selectionEvidence(null, d)).toEqual([]);
  });

  it("keeps every repeated rule in engine order and never merges the two API copies", () => {
    const d = withRepeatedRules();
    const rules = allRules(d);
    expect(rules).toHaveLength(RULES.length + 4);
    expect(rules.filter((r) => r.rule_id === "draft.ae")).toHaveLength(2);
    expect(rules.filter((r) => r.rule_id === "vitals.implausible")).toHaveLength(2);
    // Both keys carry the same list; using both would double every rule.
    expect(allRules({ ...d, rules_fired: [] })).toHaveLength(rules.length);
    expect(allRules({ ...d, rules_fired: [], result: { ...d.result, rules_fired: [] } })).toEqual(
      [],
    );
  });

  it("selects each occurrence of a repeated rule independently", () => {
    const d = withRepeatedRules();
    const rules = allRules(d);
    const [first, second] = rules
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.rule_id === "draft.ae")
      .map(({ i }) => i);
    const ev1 = highlightSet(
      selectionEvidence({ kind: "rule", ruleId: "draft.ae", index: first }, d),
    );
    const ev2 = highlightSet(
      selectionEvidence({ kind: "rule", ruleId: "draft.ae", index: second }, d),
    );
    expect(ev1.has(A_SOB_SEV)).toBe(true);
    expect(ev1.has(A_COUGH_SEV)).toBe(false);
    expect(ev2.has(A_COUGH_SEV)).toBe(true);
    expect(ev2.has(A_SOB_SEV)).toBe(false);
    const [impA, impB] = rules
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.rule_id === "vitals.implausible")
      .map(({ i }) => i);
    expect([
      ...highlightSet(
        selectionEvidence({ kind: "rule", ruleId: "vitals.implausible", index: impA }, d),
      ),
    ]).toEqual([S3]);
    expect([
      ...highlightSet(
        selectionEvidence({ kind: "rule", ruleId: "vitals.implausible", index: impB }, d),
      ),
    ]).toEqual([S4]);
    // A stale index (after a reload shortened the list) falls back to the id, never to nothing.
    expect(
      selectionEvidence({ kind: "rule", ruleId: "draft.ae", index: 99 }, d).map((e) => e.id),
    ).toEqual([A_SOB_SEV, A_SOB_INT]);
  });

  it("labels real-sensor samples MEASURED even when no rules summary exists", () => {
    const d = detail();
    expect(vitalsProvenance(d)).toEqual({ hasSamples: true, isMeasured: false, source: "mock" });
    // Presage session where every sample fell below min confidence: summary null, samples measured.
    const measured = detail({
      vitals: {
        samples: d.vitals.samples.map((s) => ({ ...s, source: "presage", is_measured: true })),
        summary: null,
        status: "low_quality",
      },
      result: { ...d.result, vitals: { ...d.result.vitals, status: "low_quality", summary: null } },
    });
    expect(vitalsProvenance(measured)).toEqual({
      hasSamples: true,
      isMeasured: true,
      source: "presage",
    });
    expect(
      vitalsProvenance(detail({ vitals: { samples: [], summary: null, status: "declined" } })),
    ).toEqual({ hasSamples: false, isMeasured: false, source: null });
  });

  it("derives a VS draft's badge from the VSMETHOD text on the same row", () => {
    expect(vsDraftIsMeasured(VS.fields)).toBe(false);
    expect(vsDraftIsMeasured({ VSMETHOD: "Contactless optical, camera-based" })).toBe(true);
    // The text wins over a contradictory or missing boolean.
    expect(vsDraftIsMeasured({ VSMETHOD: "Simulated", INTERIM_IS_MEASURED: true })).toBe(false);
    expect(
      vsDraftIsMeasured({
        VSMETHOD: "Contactless optical, camera-based",
        INTERIM_IS_MEASURED: false,
      }),
    ).toBe(true);
    expect(vsDraftIsMeasured({ INTERIM_IS_MEASURED: true })).toBe(true);
    expect(vsDraftIsMeasured({})).toBe(false);
  });

  it("computes the time left at stop from the timestamps the API always sends", () => {
    const clock = {
      due_at: "2026-10-11T18:05:00.000Z",
      stopped_at: "2026-10-10T18:12:00.000Z",
      seconds_remaining: null, // what the real API returns once stopped
    };
    expect(stoppedRemaining(clock)).toBe(23 * 3600 + 53 * 60);
    expect(stoppedRemaining({ ...clock, stopped_at: null })).toBeNull();
    expect(stoppedRemaining({ ...clock, due_at: "nope", seconds_remaining: 42 })).toBe(42);
  });

  it("never sends an empty attribution value and only sends what changed", () => {
    const none = { AESER: "", AEREL: "" };
    expect(attributionBody(none, { AESER: "Y", AEREL: "POSSIBLE" }, " note ")).toEqual({
      AESER: "Y",
      AEREL: "POSSIBLE",
      note: "note",
    });
    const recorded = { AESER: "Y", AEREL: "POSSIBLE" };
    // Resetting to the blank option is not a decision: nothing is sent.
    expect(attributionBody(recorded, { AESER: "", AEREL: "POSSIBLE" }, "")).toBeNull();
    expect(attributionBody(recorded, { AESER: "Y", AEREL: "POSSIBLE" }, "")).toBeNull();
    expect(attributionBody(recorded, { AESER: "Y", AEREL: "PROBABLE" }, "")).toEqual({
      AEREL: "PROBABLE",
    });
    expect(attributionBody(none, { AESER: "", AEREL: "" }, "just a note")).toBeNull();
  });

  it("lists version differences field by field", () => {
    const v2 = { ...AE, version: 2, fields: { ...AE.fields, AETOXGR: 3 } };
    expect(diffVersions(AE, v2)).toEqual([{ name: "AETOXGR", from: 2, to: 3 }]);
    expect(diffVersions(null, v2)).toEqual([]);
  });

  it("builds grade hover text from the CTCAE reference", () => {
    const ctcae = [
      {
        item_id: "shortness_of_breath",
        aedecod: "Dyspnea",
        meddra_code_mock: "MOCK-0001",
        grade_definitions: { "1": "a", "2": "b", "3": "c" },
      },
    ];
    expect(gradeHover(gradeDefinitions(ctcae, "Dyspnea"))).toBe("G1: a\nG2: b\nG3: c");
    expect(gradeDefinitions(ctcae, "Nausea")).toBeNull();
    expect(gradeDefinitions(null, "Dyspnea")).toBeNull();
  });

  it("computes countdown seconds and labels sponsor deadlines", () => {
    const now = Date.parse("2026-10-10T18:00:00.000Z");
    expect(secondsUntil("2026-10-10T19:00:00.000Z", now)).toBe(3600);
    expect(secondsUntil("nope", now)).toBeNull();
    expect(informationalLabel("fatal_or_life_threatening_7d")).toBe(
      "Fatal or life threatening 7-day",
    );
  });
});
