import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MeasuredBadge } from "../components/MeasuredBadge";
import { TierChip } from "../components/TierChip";
import {
  formatCountdown,
  formatUtc,
  normalizeOptions,
  Time,
  TIERS,
  tierStyle,
} from "../lib/format";

describe("TierChip", () => {
  it("renders the ladder names and colours from the table", () => {
    render(
      <>
        <TierChip tier={0} />
        <TierChip tier={1} />
        <TierChip tier={2} />
        <TierChip tier={3} />
      </>,
    );
    expect(screen.getByText("Log")).toBeInTheDocument();
    expect(screen.getByText("Review within 1 business day")).toBeInTheDocument();
    expect(screen.getByText("Nurse call today")).toBeInTheDocument();
    expect(screen.getByText("Urgent")).toBeInTheDocument();
    expect(screen.getByText("Urgent").closest("span[data-tier]")).toHaveClass("bg-red-600");
    expect(screen.getByText("Nurse call today").closest("span[data-tier]")).toHaveClass(
      "bg-orange-200",
    );
    expect(screen.getByText("Log").closest("span[data-tier]")).toHaveClass("bg-slate-200");
    expect(TIERS[1].color).toBe("amber");
  });

  it("falls back safely for unknown tiers", () => {
    expect(tierStyle(7).name).toBe("Unknown");
    expect(tierStyle(null).tier).toBe(0);
  });
});

describe("MeasuredBadge", () => {
  it("always renders the word", () => {
    const { rerender } = render(<MeasuredBadge isMeasured={false} source="mock" />);
    expect(screen.getByText("SIMULATED")).toBeInTheDocument();
    expect(screen.getByText("SIMULATED").closest("span[data-measured]")).toHaveClass(
      "bg-violet-100",
    );
    rerender(<MeasuredBadge isMeasured />);
    expect(screen.getByText("MEASURED")).toBeInTheDocument();
    expect(screen.getByText("MEASURED").closest("span[data-measured]")).toHaveClass("bg-green-100");
  });
});

describe("Time", () => {
  it("renders local time with UTC on hover", () => {
    render(<Time iso="2026-10-10T18:04:12.345Z" />);
    const el = screen.getByTitle("2026-10-10T18:04:12.345Z (UTC)");
    expect(el.tagName).toBe("TIME");
    expect(el).toHaveAttribute("datetime", "2026-10-10T18:04:12.345Z");
    expect(el.textContent).toMatch(/2026/);
  });

  it("shows a fallback for invalid input", () => {
    render(<Time iso="nope" fallback="n/a" />);
    expect(screen.getByText("n/a")).toBeInTheDocument();
    expect(formatUtc(null)).toBe("");
  });
});

describe("format helpers", () => {
  it("formatCountdown", () => {
    expect(formatCountdown(3600 * 5 + 60 * 7)).toBe("5h 07m");
    expect(formatCountdown(125)).toBe("2m 05s");
    expect(formatCountdown(-90)).toBe("overdue by 1m 30s");
    expect(formatCountdown(null)).toBe("—");
  });

  it("normalizeOptions accepts object and array forms and sorts by value", () => {
    expect(normalizeOptions({ Yes: 1, No: 0 }, "presence")).toEqual([
      { label: "No", value: 0 },
      { label: "Yes", value: 1 },
    ]);
    expect(
      normalizeOptions(
        [
          { label: "Mild", value: 1 },
          { label: "None", value: 0 },
        ],
        "severity",
      ),
    ).toEqual([
      { label: "None", value: 0 },
      { label: "Mild", value: 1 },
    ]);
    expect(normalizeOptions(undefined, "frequency")).toHaveLength(5);
  });
});
