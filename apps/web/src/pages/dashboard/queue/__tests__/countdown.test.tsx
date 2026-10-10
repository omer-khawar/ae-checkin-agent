import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { formatRemaining, saeState, URGENT_THRESHOLD_MS } from "../countdown";
import { SaeCountdownChip } from "../SaeCountdownChip";

const NOW = Date.parse("2026-10-10T18:00:00.000Z");
const H = 3600_000;

describe("saeState", () => {
  it("is stopped, unknown or running", () => {
    expect(saeState(null, true, NOW)).toEqual({ kind: "stopped" });
    expect(saeState(null, false, NOW)).toEqual({ kind: "unknown" });
    expect(saeState("not a date", false, NOW)).toEqual({ kind: "unknown" });
    const s = saeState(new Date(NOW + 5 * H).toISOString(), false, NOW);
    expect(s).toEqual({ kind: "running", remainingMs: 5 * H, urgent: false, overdue: false });
  });

  it("turns urgent under 2 h and overdue past due", () => {
    const urgent = saeState(new Date(NOW + URGENT_THRESHOLD_MS - 1000).toISOString(), false, NOW);
    expect(urgent.kind === "running" && urgent.urgent).toBe(true);
    const over = saeState(new Date(NOW - 60_000).toISOString(), false, NOW);
    expect(over.kind === "running" && over.overdue && over.urgent).toBe(true);
  });
});

describe("formatRemaining", () => {
  it("uses hh:mm above an hour and mm:ss below", () => {
    expect(formatRemaining(23 * H + 14 * 60_000 + 59_000)).toEqual({
      text: "23:14",
      unit: "hrs",
      overdue: false,
    });
    expect(formatRemaining(45 * 60_000 + 12_000)).toEqual({
      text: "45:12",
      unit: "min",
      overdue: false,
    });
    expect(formatRemaining(-90_000)).toEqual({ text: "01:30", unit: "min", overdue: true });
    expect(formatRemaining(0)).toEqual({ text: "00:00", unit: "min", overdue: false });
  });
});

describe("SaeCountdownChip", () => {
  it("renders a calm chip with hours left and the due time on hover", () => {
    const due = new Date(NOW + 23 * H + 14 * 60_000).toISOString();
    render(<SaeCountdownChip dueAt={due} stopped={false} now={NOW} />);
    const chip = screen.getByLabelText("SAE report due in 23:14 hrs");
    expect(chip).toHaveAttribute("data-sae", "running");
    expect(chip).toHaveClass("bg-amber-100");
    expect(chip.title).toContain(due);
  });

  it("turns red under two hours and counts in mm:ss", () => {
    const due = new Date(NOW + 45 * 60_000 + 12_000).toISOString();
    render(<SaeCountdownChip dueAt={due} stopped={false} now={NOW} />);
    const chip = screen.getByLabelText("SAE report due in 45:12 min");
    expect(chip).toHaveAttribute("data-sae", "urgent");
    expect(chip).toHaveClass("bg-red-600");
  });

  it("shows overdue and stopped states", () => {
    const { rerender } = render(
      <SaeCountdownChip dueAt={new Date(NOW - 90_000).toISOString()} stopped={false} now={NOW} />,
    );
    expect(screen.getByLabelText("SAE report overdue by 01:30 min")).toHaveAttribute(
      "data-sae",
      "overdue",
    );
    rerender(
      <SaeCountdownChip dueAt={null} stopped stoppedAt="2026-10-10T17:00:00.000Z" now={NOW} />,
    );
    const stopped = screen.getByText("SAE clock stopped");
    expect(stopped).toHaveAttribute("data-sae", "stopped");
    expect(stopped.title).toContain("2026-10-10T17:00:00.000Z");
  });

  it("explains a clock with no due time instead of crashing", () => {
    render(<SaeCountdownChip dueAt={null} stopped={false} now={NOW} />);
    expect(screen.getByText("SAE clock running")).toHaveAttribute("data-sae", "unknown");
  });
});
