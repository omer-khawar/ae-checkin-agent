/**
 * Pure helpers behind the brief page: normalization, trend arrows, protocol
 * flags, MEASURED/SIMULATED, evidence labels and the one-line summary.
 */
import { describe, expect, it } from "vitest";

import {
  countCiters,
  evidenceKindLabel,
  formatDay,
  gradeTrend,
  isEmptyBrief,
  isInternalLink,
  measuredOf,
  normalizeBrief,
  normalizeItem,
  normalizeWriter,
  normalizeWritten,
  PRINTABLE_CSP,
  protocolFlagOf,
  protocolRef,
  safeLink,
  sectionKind,
  shortId,
  summaryLine,
  toDateInput,
  withRestrictiveCsp,
  writerLabel,
  writerTitle,
} from "../model";
import type { BriefItem } from "../types";
import { ANSWER_RASH_2, briefJson, USUBJID } from "./fixture";

const item = (over: Partial<BriefItem>): BriefItem => ({
  text: "x",
  evidence_ids: [],
  link: null,
  ...over,
});

describe("normalizeBrief", () => {
  it("keeps the contract fields and the optional extensions", () => {
    const b = normalizeBrief(briefJson(), "fallback");
    expect(b.usubjid).toBe(USUBJID);
    expect(b.display_label).toBe("P-007");
    expect(b.sections).toHaveLength(6);
    expect(b.sections[0].items[0].grades?.map((g) => g.grade)).toEqual([2, 3]);
    expect(b.sections[2].items[0].protocol_flag).toBe("discouraged");
    expect(b.narrative?.writer).toBe("template");
    expect(b.narrative?.sentences).toHaveLength(2);
  });

  it("accepts string and object questions", () => {
    const b = normalizeBrief(briefJson(), "x");
    expect(b.questions_to_ask).toEqual([
      { text: "Ask for the prednisone dose and why it was started.", evidence_ids: [] },
      { text: "Is the rash still there?", evidence_ids: [ANSWER_RASH_2], kind: "unresolved_ae" },
    ]);
  });

  it("builds a question from narrative.py's QuestionFact shape", () => {
    const b = normalizeBrief(
      {
        questions_to_ask: [
          {
            kind: "cm_missing_fields",
            subject: "prednisone",
            details: ["dose", "indication"],
            evidence_ids: ["a"],
          },
        ],
      },
      "x",
    );
    expect(b.questions_to_ask[0].text).toBe("prednisone: dose, indication");
  });

  it("survives a missing or malformed body", () => {
    const b = normalizeBrief(null, USUBJID);
    expect(b).toMatchObject({
      usubjid: USUBJID,
      display_label: USUBJID,
      sections: [],
      narrative: null,
      questions_to_ask: [],
    });
    const c = normalizeBrief(
      { sections: [{ items: [{ evidence_ids: ["a"] }, "plain line", 4] }], narrative: "nope" },
      "x",
    );
    expect(c.sections[0].key).toBe("section_0");
    expect(c.sections[0].items).toEqual([{ text: "plain line", evidence_ids: [], link: null }]);
    expect(c.narrative).toBeNull();
  });

  it("drops non-string evidence ids and unknown enum values", () => {
    const b = normalizeBrief(
      {
        sections: [
          {
            key: "meds",
            title: "M",
            items: [
              { text: "t", evidence_ids: ["a", 3, ""], protocol_flag: "maybe", trend: "sideways" },
            ],
          },
        ],
      },
      "x",
    );
    const i = b.sections[0].items[0];
    expect(i.evidence_ids).toEqual(["a"]);
    expect(i.protocol_flag).toBeUndefined();
    expect(i.trend).toBeUndefined();
  });
});

describe("sectionKind", () => {
  it.each([
    ["new_side_effects", "side_effects"],
    ["open_aes", "open_aes"],
    ["open_side_effects", "open_aes"],
    ["med_changes", "meds"],
    ["conmeds", "meds"],
    ["escalations_and_clocks", "escalations"],
    ["clocks", "escalations"],
    ["notes", "notes"],
    ["notes_and_calls", "notes"],
    ["vitals", "vitals"],
    ["something_else", "other"],
    // R4 keys containing "open" must not be mistaken for open side effects.
    ["open_queries", "other"],
    ["open_packets", "other"],
    ["open_clocks", "escalations"],
    ["open_adverse_events", "open_aes"],
    // Exact keys from narrative_templates.json.
    ["escalations", "escalations"],
    ["NEW_SIDE_EFFECTS", "side_effects"],
    ["symptoms", "side_effects"],
    ["immediate_actions", "other"],
  ])("%s → %s", (key, kind) => {
    expect(sectionKind(key)).toBe(kind);
  });

  it("gives an open_queries section its own empty text, not 'No open side effects'", () => {
    const b = normalizeBrief(
      { sections: [{ key: "open_queries", title: "Open sponsor queries", items: [] }] },
      "x",
    );
    expect(sectionKind(b.sections[0].key)).not.toBe("open_aes");
  });
});

describe("gradeTrend", () => {
  it("prefers the explicit trend", () => {
    expect(
      gradeTrend(item({ trend: "down", grades: [{ grade: 1 }, { grade: 3 }] }))?.direction,
    ).toBe("down");
  });
  it("compares the last two structured grades", () => {
    expect(gradeTrend(item({ grades: [{ grade: 1 }, { grade: 3 }] }))).toEqual({
      direction: "up",
      grades: [1, 3],
    });
    expect(gradeTrend(item({ grades: [{ grade: 3 }, { grade: 2 }] }))?.direction).toBe("down");
    expect(gradeTrend(item({ grades: [{ grade: 2 }, { grade: 2 }] }))?.direction).toBe("same");
    expect(gradeTrend(item({ grades: [{ grade: 2 }] }))?.direction).toBe("new");
  });
  it("falls back to 'grade N' in the text", () => {
    expect(gradeTrend(item({ text: "Nausea grade 1, now Grade 2" }))?.direction).toBe("up");
    expect(gradeTrend(item({ text: "Cough: grade 1 (provisional)" }))?.direction).toBe("new");
    expect(gradeTrend(item({ text: "Cough reported" }))).toBeNull();
  });
});

describe("protocol flags", () => {
  it("uses the structured flag, else the wording", () => {
    expect(protocolFlagOf(item({ protocol_flag: "permitted", text: "prohibited" }))).toBe(
      "permitted",
    );
    expect(protocolFlagOf(item({ text: "Started bevacizumab (not allowed by protocol)" }))).toBe(
      "prohibited",
    );
    expect(protocolFlagOf(item({ text: "Prednisone is discouraged" }))).toBe("discouraged");
    expect(protocolFlagOf(item({ text: "Denosumab, allowed by the protocol" }))).toBe("permitted");
    expect(protocolFlagOf(item({ text: "Started loratadine" }))).toBeNull();
  });
  it("formats the protocol reference", () => {
    expect(protocolRef(item({ protocol_section: "7.7.2", printed_page: 69 }))).toBe("§7.7.2 p.69");
    expect(protocolRef(item({ protocol_section: "§7.7" }))).toBe("§7.7");
    expect(protocolRef(item({}))).toBeNull();
  });
});

describe("measuredOf", () => {
  it("uses is_measured when present", () => {
    expect(measuredOf(item({ is_measured: true, text: "simulated" }))).toEqual({
      isMeasured: true,
      fromText: false,
    });
  });
  it("reads the text otherwise, and never claims MEASURED without a source saying so", () => {
    expect(measuredOf(item({ text: "Pulse 74 (simulated)" })).isMeasured).toBe(false);
    expect(measuredOf(item({ text: "Pulse 74, measured by camera" })).isMeasured).toBe(true);
    expect(measuredOf(item({ text: "Pulse 74" })).isMeasured).toBe(false);
  });
  it.each([
    "Vitals were not measured this period (camera off)",
    "No measured vitals since Oct 3",
    "Pulse wasn't measured",
    "Pulse wasn’t measured",
    "Breathing has never been measured",
    "Check-in completed without measured vitals",
    "Breathing not yet measured",
    "Unmeasured: camera declined",
  ])("negated wording is never MEASURED: %s", (text) => {
    expect(measuredOf(item({ text })).isMeasured).toBe(false);
  });
  it("still reads a plain positive cue as MEASURED", () => {
    expect(measuredOf(item({ text: "Pulse 74 bpm measured by camera at 09:12" })).isMeasured).toBe(
      true,
    );
  });
});

describe("normalizeItem with narrative.py fact rows", () => {
  it("reads ClockFact's `kind` as the clock kind, and event_label as the text", () => {
    const i = normalizeItem({
      kind: "aesi",
      event_label: "Rash, grade 3 (provisional)",
      due_at: "2026-10-11T09:00:00Z",
      status: "running",
      evidence_ids: ["c1"],
    });
    expect(i).toMatchObject({
      text: "Rash, grade 3 (provisional)",
      clock_kind: "aesi",
      due_at: "2026-10-11T09:00:00Z",
      status: "running",
    });
  });
  it("prefers clock_kind over kind, and ignores unknown kinds", () => {
    expect(normalizeItem({ text: "t", clock_kind: "sae", kind: "aesi" })?.clock_kind).toBe("sae");
    expect(normalizeItem({ text: "t", kind: "visit_brief" })?.clock_kind).toBeUndefined();
  });
  it("uses plain_label or name when text is missing, and keeps acknowledged", () => {
    expect(normalizeItem({ term: "Dyspnea", plain_label: "Shortness of breath" })?.text).toBe(
      "Shortness of breath",
    );
    expect(normalizeItem({ name: "prednisone", direction: "started" })?.text).toBe("prednisone");
    expect(normalizeItem({ text: "Tier 2", tier: 2, acknowledged: false })?.acknowledged).toBe(
      false,
    );
  });
  it("drops a fact row that has no text of its own (the page never composes text)", () => {
    expect(normalizeItem({ note_type: "phone_call", evidence_ids: ["n1"] })).toBeNull();
    expect(normalizeItem({ is_measured: true, source: "presage" })).toBeNull();
  });
});

describe("writer labels", () => {
  it("accepts only the contract writers, case-insensitively", () => {
    expect(normalizeWriter("template")).toBe("template");
    expect(normalizeWriter("LLM")).toBe("llm");
    expect(normalizeWriter(" Template ")).toBe("template");
  });
  it("never labels an unknown writer as the template", () => {
    for (const w of ["claude", "gpt", "", undefined, null, 3]) {
      expect(normalizeWriter(w)).toBe("unknown");
    }
    const n = normalizeWritten({ writer: "claude", text: "Some text." });
    expect(n?.writer).toBe("unknown");
    expect(writerLabel("unknown")).toBe("Writer unknown");
    expect(writerTitle("unknown")).not.toMatch(/template|no AI/i);
  });
});

describe("safeLink", () => {
  it("allows in-app routes and http(s) URLs", () => {
    expect(safeLink("/dashboard/checkins/1")).toEqual({
      kind: "internal",
      to: "/dashboard/checkins/1",
    });
    expect(safeLink("https://clinicaltrials.gov/study/NCT03088540")).toEqual({
      kind: "external",
      href: "https://clinicaltrials.gov/study/NCT03088540",
    });
  });
  it.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    " javascript:alert(1)",
    "java\tscript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "blob:https://x/1",
    "vbscript:x",
    "//evil.example",
    "/\\evil.example",
    "dashboard/relative",
    "",
    null,
  ])("refuses %s", (link) => {
    expect(safeLink(link)).toBeNull();
  });
});

describe("printable HTML CSP", () => {
  it("puts a script-blocking CSP right after the doctype", () => {
    const out = withRestrictiveCsp("<!doctype html><title>B</title><script>x()</script>");
    expect(out.startsWith('<!doctype html><meta http-equiv="Content-Security-Policy"')).toBe(true);
    expect(out).toContain("script-src 'none'");
    expect(out).toContain("<script>x()</script>");
  });
  it("prepends when there is no doctype", () => {
    expect(withRestrictiveCsp("<p>hi</p>")).toMatch(
      /^<meta http-equiv="Content-Security-Policy"[^>]*><p>hi<\/p>$/,
    );
  });
  it("blocks scripts and base, allows inline styles", () => {
    expect(PRINTABLE_CSP).toMatch(/script-src 'none'/);
    expect(PRINTABLE_CSP).toMatch(/base-uri 'none'/);
    expect(PRINTABLE_CSP).toMatch(/style-src 'unsafe-inline'/);
  });
});

describe("evidence labels", () => {
  it("names chips from the lookup or the id shape", () => {
    expect(evidenceKindLabel("x", { kind: "chart_note" })).toBe("Note");
    expect(evidenceKindLabel("01JS:gate_hospitalized")).toBe("Answer");
    expect(evidenceKindLabel("protocol.aesi_suspected")).toBe("Rule");
    expect(evidenceKindLabel("01JANSWER0000000000000SOB1")).toBe("Record");
  });
  it("shortens ULIDs but not rule ids", () => {
    expect(shortId("01JANSWER0000000000000SOB1")).toBe("…00SOB1");
    expect(shortId("protocol.aesi_suspected")).toBe("protocol.aesi_suspected");
    expect(shortId("abc")).toBe("abc");
  });
  it("counts every line citing an id", () => {
    const b = normalizeBrief(briefJson(), "x");
    // section items: rash + clock; sentence: 1; question: 1
    expect(countCiters(b, ANSWER_RASH_2)).toBe(4);
  });
});

describe("dates, links, labels", () => {
  it("handles date-only and ISO values without a timezone shift", () => {
    expect(toDateInput("2026-10-03")).toBe("2026-10-03");
    expect(toDateInput("2026-10-03T23:59:00Z")).toBe("2026-10-03");
    expect(toDateInput(null)).toBe("");
    expect(formatDay("2026-10-03")).toMatch(/3/);
    expect(formatDay("2026-10-03")).toMatch(/2026/);
    expect(formatDay("not a date")).toBe("not a date");
  });
  it("tells in-app routes from external links", () => {
    expect(isInternalLink("/dashboard/checkins/1")).toBe(true);
    expect(isInternalLink("//evil.example")).toBe(false);
    expect(isInternalLink("/\\evil.example")).toBe(false);
    expect(isInternalLink("https://clinicaltrials.gov")).toBe(false);
  });
  it("labels the writer", () => {
    expect(writerLabel("template")).toBe("Written by template");
    expect(writerLabel("llm")).toBe("Written by Claude");
    expect(writerLabel("unknown")).toBe("Writer unknown");
  });
});

describe("summaryLine", () => {
  it("prefers the API's summary", () => {
    expect(summaryLine(normalizeBrief(briefJson({ summary: "From the API." }), "x"))).toBe(
      "From the API.",
    );
  });
  it("counts what is on the page, with protocol flags", () => {
    const line = summaryLine(normalizeBrief(briefJson(), "x"));
    expect(line).toMatch(/^Since .*2026: /);
    expect(line).toContain("2 new side effects");
    expect(line).toContain("1 open side effect");
    expect(line).toContain("2 medication changes (2 flagged against the protocol)");
    expect(line).toContain("2 escalations or report clocks");
    expect(line).toContain("1 note or call");
    expect(line).toContain("2 questions to ask");
  });
  it("says nothing new when every section is empty", () => {
    const b = normalizeBrief(
      briefJson({ sections: [{ key: "notes", title: "Notes", items: [] }], questions_to_ask: [] }),
      "x",
    );
    expect(isEmptyBrief(b)).toBe(true);
    expect(summaryLine(b)).toMatch(/nothing new was recorded\.$/);
  });
});
