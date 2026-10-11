/** R5.3: Gemini second-reader rendering (all fields optional). */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HighlightedNote } from "../HighlightedNote";
import { normalizeScan } from "../normalize";
import { readerStatusText } from "../readerTypes";
import { ScanTables } from "../ScanTables";

const TEXT = "Hypothyroidism, grade 2, likely immune-related. Loose stools started Imodium.";

function sf(term: string, quote: string, found_by?: string) {
  const i = TEXT.indexOf(quote);
  return {
    term,
    quote,
    span_start: i,
    span_end: i + quote.length,
    reason: "r",
    grade_hint: 2,
    grade_basis: "b",
    onset_days: null,
    worsening: false,
    excluded_reason: null,
    ...(found_by ? { found_by } : {}),
  };
}

const RAW = {
  symptoms: [
    sf("Hypothyroidism", "Hypothyroidism, grade 2", "gemini"),
    sf("Diarrhea", "Loose stools", "both"),
  ],
  excluded_symptoms: [],
  meds: [
    {
      drug: "loperamide",
      change: "started",
      quote: "Imodium",
      span_start: 70,
      span_end: 77,
      reason: "",
      excluded_reason: null,
      found_by: "scanner",
    },
  ],
  excluded_meds: [],
  red_flags: [],
  reader: { status: "cache", model: "gemini-2.5-flash", cached: true, reason: null },
  reader_rejected: [{ quote: "made up words", reason: "quote not found in the note" }],
};

describe("Gemini second reader", () => {
  it("status text covers on, off and error", () => {
    expect(
      readerStatusText({ status: "cache", model: "gemini-2.5-flash", cached: true, reason: null }),
    ).toBe("Gemini second reader: on (cached, gemini-2.5-flash)");
    expect(
      readerStatusText({ status: "off", model: null, cached: false, reason: "no key" }),
    ).toContain("off: rules-only reading");
    expect(
      readerStatusText({ status: "error", model: null, cached: false, reason: "timeout" }),
    ).toContain("rules-only");
  });

  it("normalizes found_by, reader and rejected", () => {
    const scan = normalizeScan(RAW);
    expect(scan.reader?.model).toBe("gemini-2.5-flash");
    expect(scan.reader_rejected).toHaveLength(1);
    expect((scan.symptoms[0] as { found_by?: string }).found_by).toBe("gemini");
  });

  it("renders status line, rejected list, badges and Gemini highlight", () => {
    const scan = normalizeScan(RAW);
    render(
      <>
        <HighlightedNote text={TEXT} scan={scan} />
        <ScanTables scan={scan} />
      </>,
    );
    expect(
      screen.getByText("Gemini second reader: on (cached, gemini-2.5-flash)"),
    ).toBeInTheDocument();
    expect(screen.getByText("Rejected by the quote check (1)")).toBeInTheDocument();
    expect(screen.getByText("“made up words”")).toBeInTheDocument();
    expect(screen.getAllByText("Found by Gemini · quote checked").length).toBeGreaterThan(0);
    const badges = screen.getAllByTestId("found-by").map((b) => b.getAttribute("data-found-by"));
    expect(badges).toEqual(["gemini", "both", "scanner"]);
    expect(document.querySelector('[data-kind="gemini"]')).not.toBeNull();
    expect(screen.getAllByTestId("gemini-mark").length).toBeGreaterThan(0);
  });

  it("renders old responses (no reader fields) without a reader panel", () => {
    const { reader: _r, reader_rejected: _x, ...old } = RAW;
    void _r;
    void _x;
    const scan = normalizeScan(old);
    render(<ScanTables scan={scan} />);
    expect(screen.queryByTestId("reader-panel")).toBeNull();
    expect(screen.getAllByTestId("found-by")[0]).toHaveAttribute("data-found-by", "gemini");
  });
});
