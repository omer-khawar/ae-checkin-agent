import { describe, expect, it } from "vitest";

import {
  exclusionWording,
  rangeForEvidence,
  segmentInRange,
  segmentText,
  spansFromScan,
  type HighlightSpan,
} from "../highlight";
import { SCAN, span, TEXT } from "./fixtures";

describe("segmentText", () => {
  it("returns the whole text as one plain segment when there are no spans", () => {
    const segs = segmentText("hello world", []);
    expect(segs).toEqual([{ start: 0, end: 11, text: "hello world", spans: [] }]);
  });

  it("cuts at every boundary and keeps overlapping spans on shared segments, priority first", () => {
    const text = "aa increasing SOB bb";
    const flag: HighlightSpan = {
      id: "red_flag:0",
      kind: "red_flag",
      start: 3,
      end: 17,
      label: "flag",
    };
    const sym: HighlightSpan = {
      id: "symptom:0",
      kind: "symptom",
      start: 14,
      end: 17,
      label: "sym",
    };
    const segs = segmentText(text, [sym, flag]);
    expect(segs.map((s) => s.text)).toEqual(["aa ", "increasing ", "SOB", " bb"]);
    expect(segs[1].spans.map((s) => s.id)).toEqual(["red_flag:0"]);
    // Both cover "SOB"; red flag outranks symptom.
    expect(segs[2].spans.map((s) => s.id)).toEqual(["red_flag:0", "symptom:0"]);
    expect(segs[3].spans).toEqual([]);
    // Round-trips the text exactly.
    expect(segs.map((s) => s.text).join("")).toBe(text);
  });

  it("ignores empty or inverted spans", () => {
    const segs = segmentText("abc", [
      { id: "x", kind: "med", start: 2, end: 2, label: "" },
      { id: "y", kind: "med", start: 3, end: 1, label: "" },
    ]);
    expect(segs).toHaveLength(1);
    expect(segs[0].spans).toEqual([]);
  });
});

describe("spansFromScan", () => {
  it("builds one span per finding, labelled by kind, and clamps to the text", () => {
    const spans = spansFromScan(SCAN, TEXT.length);
    expect(spans.map((s) => s.kind).sort()).toEqual(
      ["excluded", "med", "red_flag", "symptom", "symptom"].sort(),
    );
    const flag = spans.find((s) => s.kind === "red_flag")!;
    expect(flag.start).toBe(span("increasing SOB").span_start);
    expect(flag.label).toContain("urgent");
    const excluded = spans.find((s) => s.kind === "excluded")!;
    expect(excluded.title).toBe(exclusionWording("indication"));

    const clamped = spansFromScan(
      {
        ...SCAN,
        symptoms: [{ ...SCAN.symptoms[0], span_start: 5, span_end: 10_000 }],
        excluded_symptoms: [],
        meds: [],
        red_flags: [],
      },
      20,
    );
    expect(clamped).toHaveLength(1);
    expect(clamped[0].end).toBe(20);
  });

  it("drops a span that becomes empty after clamping", () => {
    const spans = spansFromScan(
      {
        symptoms: [{ ...SCAN.symptoms[0], span_start: 50, span_end: 60 }],
        excluded_symptoms: [],
        meds: [],
        excluded_meds: [],
        red_flags: [],
      },
      10,
    );
    expect(spans).toEqual([]);
  });
});

describe("rangeForEvidence / segmentInRange", () => {
  it("prefers explicit offsets, falls back to the quoted words, else null", () => {
    expect(rangeForEvidence(TEXT, { span_start: 3, span_end: 8, note: "zzz" })).toEqual({
      start: 3,
      end: 8,
    });
    // Case-insensitive fallback on the quoted words when no offsets are given.
    const cough = span("Dry cough");
    expect(rangeForEvidence(TEXT, { note: "dry COUGH" })).toEqual({
      start: cough.span_start,
      end: cough.span_end,
    });
    expect(rangeForEvidence(TEXT, { note: "not in the text at all" })).toBeNull();
    expect(rangeForEvidence(TEXT, { span_start: 10, span_end: 5, note: "" })).toBeNull();
    expect(rangeForEvidence("short", { span_start: 0, span_end: 99 })).toBeNull();
  });

  it("segmentInRange is inclusive of segments fully inside the range only", () => {
    const range = { start: 10, end: 20 };
    expect(segmentInRange({ start: 10, end: 20 }, range)).toBe(true);
    expect(segmentInRange({ start: 12, end: 15 }, range)).toBe(true);
    expect(segmentInRange({ start: 5, end: 15 }, range)).toBe(false);
    expect(segmentInRange({ start: 12, end: 15 }, null)).toBe(false);
  });

  it("exclusionWording covers every NegEx reason and has a generic fallback", () => {
    for (const r of [
      "negated",
      "historical",
      "hypothetical",
      "resolved",
      "allergy",
      "indication",
    ]) {
      expect(exclusionWording(r)).toMatch(/not drafted/);
    }
    expect(exclusionWording("weird")).toBe("Excluded: weird.");
    expect(exclusionWording(null)).toBe("Excluded by the scanner.");
  });
});
