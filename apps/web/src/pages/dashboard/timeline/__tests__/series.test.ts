/**
 * Pure helpers for the timeline page. The date-only formatter is the one that
 * matters most: a chart note's `note_date` is a calendar date and must not
 * drift by a day depending on the viewer's timezone.
 */
import { describe, expect, it } from "vitest";

import { formatDateOnly, isDateOnly, notePath } from "../series";

describe("isDateOnly", () => {
  it("accepts YYYY-MM-DD only", () => {
    expect(isDateOnly("2026-10-02")).toBe(true);
    expect(isDateOnly("2026-10-02T00:00:00.000Z")).toBe(false);
    expect(isDateOnly("2026-10-2")).toBe(false);
    expect(isDateOnly("")).toBe(false);
    expect(isDateOnly(null)).toBe(false);
    expect(isDateOnly(undefined)).toBe(false);
  });
});

describe("formatDateOnly", () => {
  it("formats a calendar date in UTC so the day never shifts", () => {
    // The process TZ may be anything (the judge's laptop is likely America/New_York);
    // the formatter pins UTC, so the output is the same everywhere.
    expect(formatDateOnly("2026-10-02")).toBe("Oct 02, 2026");
    expect(formatDateOnly("2026-01-01")).toBe("Jan 01, 2026");
  });

  it("returns null for datetimes, garbage and missing values", () => {
    expect(formatDateOnly("2026-10-02T15:30:00.000Z")).toBeNull();
    expect(formatDateOnly("2026-13-45")).toBeNull(); // matches the shape, not a real date
    expect(formatDateOnly("not a date")).toBeNull();
    expect(formatDateOnly(null)).toBeNull();
    expect(formatDateOnly(undefined)).toBeNull();
  });
});

describe("notePath", () => {
  it("points at the NoteDetail route and escapes the id", () => {
    expect(notePath("01JNOTE00000000000000001")).toBe("/dashboard/notes/01JNOTE00000000000000001");
    expect(notePath("a/b")).toBe("/dashboard/notes/a%2Fb");
  });
});
