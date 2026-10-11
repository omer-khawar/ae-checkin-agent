import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { formatRemaining, plainRemaining, saeState, URGENT_THRESHOLD_MS } from "../countdown";
import { SaeCountdownChip } from "../SaeCountdownChip";

const NOW = Date.parse("2026-10-10T18:00:00.000Z");
const H = 3600_000;

/**
 * The chip whose screen-reader sentence is `spoken`. The sentence is real text
 * in an sr-only span (not an aria-label on a generic span, which screen readers
 * ignore), so it is found with getByText and walked up to the chip.
 */
function chipBySpoken(spoken: string | RegExp): HTMLElement {
  const sr = screen.getByText(spoken);
  expect(sr).toHaveClass("sr-only");
  const chip = sr.closest<HTMLElement>("[data-sae]");
  if (!chip) throw new Error("spoken text is not inside a chip");
  return chip;
}

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

describe("plainRemaining", () => {
  it("reads hh:mm above an hour, minutes below, and speaks both", () => {
    expect(plainRemaining(21 * H + 14 * 60_000 + 59_000)).toEqual({
      text: "21:14",
      spoken: "21 hours 14 minutes",
      overdue: false,
    });
    expect(plainRemaining(1 * H + 1 * 60_000)).toEqual({
      text: "01:01",
      spoken: "1 hour 1 minute",
      overdue: false,
    });
    expect(plainRemaining(42 * 60_000 + 5_000)).toEqual({
      text: "42 min",
      spoken: "42 minutes",
      overdue: false,
    });
    expect(plainRemaining(30_000)).toEqual({
      text: "under 1 min",
      spoken: "under 1 minute",
      overdue: false,
    });
    expect(plainRemaining(-(65 * 60_000))).toEqual({
      text: "01:05",
      spoken: "1 hour 5 minutes",
      overdue: true,
    });
  });
});

describe("SaeCountdownChip (report clock)", () => {
  it("leads with plain language for a serious event, SAE one step deeper", () => {
    const due = new Date(NOW + 23 * H + 14 * 60_000).toISOString();
    render(<SaeCountdownChip dueAt={due} stopped={false} now={NOW} />);
    const chip = chipBySpoken("Serious event: report due in 23 hours 14 minutes");
    expect(chip).toHaveAttribute("data-sae", "running");
    expect(chip).toHaveAttribute("data-clock-kind", "sae");
    expect(chip).toHaveClass("bg-amber-100");
    expect(chip).toHaveTextContent("Serious event — report due in 23:14");
    // The abbreviation is a small badge, and the hover names it with the protocol section.
    expect(chip).toHaveTextContent("SAE");
    expect(chip.title).toContain("SAE (serious adverse event)");
    expect(chip.title).toContain("§9.4.2");
    expect(chip.title).toContain(due);
  });

  it("names a special-interest event clock and its protocol section", () => {
    const due = new Date(NOW + 5 * H + 3 * 60_000).toISOString();
    render(<SaeCountdownChip kind="aesi" dueAt={due} stopped={false} now={NOW} />);
    const chip = chipBySpoken("Special-interest event: report due in 5 hours 3 minutes");
    expect(chip).toHaveTextContent("Special-interest event — report due in 05:03");
    expect(chip).toHaveTextContent("AESI");
    expect(chip).toHaveAttribute("data-clock-kind", "aesi");
    expect(chip.title).toContain("investigator to confirm");
    expect(chip.title).toContain("§9.4.3");
  });

  it("turns red under two hours and counts in minutes", () => {
    const due = new Date(NOW + 45 * 60_000 + 12_000).toISOString();
    render(<SaeCountdownChip dueAt={due} stopped={false} now={NOW} />);
    const chip = chipBySpoken("Serious event: report due in 45 minutes");
    expect(chip).toHaveAttribute("data-sae", "urgent");
    expect(chip).toHaveClass("bg-red-600");
    expect(chip).toHaveTextContent("report due in 45 min");
  });

  it("shows overdue and stopped states", () => {
    const { rerender } = render(
      <SaeCountdownChip dueAt={new Date(NOW - 90_000).toISOString()} stopped={false} now={NOW} />,
    );
    expect(chipBySpoken("Serious event: report overdue by 1 minute")).toHaveAttribute(
      "data-sae",
      "overdue",
    );
    rerender(
      <SaeCountdownChip dueAt={null} stopped stoppedAt="2026-10-10T17:00:00.000Z" now={NOW} />,
    );
    const stopped = screen.getByText(/Serious event — clock stopped/);
    expect(stopped).toHaveAttribute("data-sae", "stopped");
    expect(stopped.title).toContain("2026-10-10T17:00:00.000Z");
  });

  it("explains a clock with no due time instead of crashing", () => {
    render(<SaeCountdownChip dueAt={null} stopped={false} now={NOW} />);
    expect(screen.getByText(/report clock running/)).toHaveAttribute("data-sae", "unknown");
  });

  it("makes no SAE/AESI claim when the kind is unknown", () => {
    const due = new Date(NOW + 23 * H + 12 * 60_000).toISOString();
    render(<SaeCountdownChip kind="unknown" dueAt={due} stopped={false} now={NOW} />);
    const chip = chipBySpoken("24-hour report: due in 23 hours 12 minutes");
    expect(chip).toHaveAttribute("data-clock-kind", "unknown");
    expect(chip).toHaveTextContent("24-hour report — due in 23:12");
    expect(chip).not.toHaveTextContent(/Serious event|Special-interest|SAE|AESI/);
    expect(chip.title).not.toContain("§9.4");
  });

  it("is announced by its text, not by an aria-label on a generic span", () => {
    const due = new Date(NOW + 3 * H).toISOString();
    const { container } = render(<SaeCountdownChip dueAt={due} stopped={false} now={NOW} />);
    const chip = container.querySelector<HTMLElement>("[data-sae]");
    expect(chip).not.toBeNull();
    expect(chip).not.toHaveAttribute("aria-label");
    expect(chip).not.toHaveAttribute("aria-hidden");
    // Only the terse hh:mm and the badge are hidden; a spoken sentence replaces them.
    const spoken = within(chip as HTMLElement).getByText(
      "Serious event: report due in 3 hours 0 minutes",
    );
    expect(spoken).toHaveClass("sr-only");
    expect(spoken).not.toHaveAttribute("aria-hidden");
  });

  it("opens a pre-filled packet for a clock that has none yet", () => {
    const due = new Date(NOW + 3 * H).toISOString();
    render(
      <MemoryRouter>
        <SaeCountdownChip
          dueAt={due}
          stopped={false}
          now={NOW}
          clockId="01JCLOCK000000000000000001"
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: /Serious event: report due in/ })).toHaveAttribute(
      "href",
      "/dashboard/packets/new?clock=01JCLOCK000000000000000001",
    );
  });

  it("is not a link when there is neither a packet nor a clock id", () => {
    const due = new Date(NOW + 3 * H).toISOString();
    render(
      <MemoryRouter>
        <SaeCountdownChip dueAt={due} stopped={false} now={NOW} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("links to the report packet when the API sends one", () => {
    const due = new Date(NOW + 3 * H).toISOString();
    render(
      <MemoryRouter>
        <SaeCountdownChip
          dueAt={due}
          stopped={false}
          now={NOW}
          packetId="01JPACKET0000000000000001"
        />
      </MemoryRouter>,
    );
    const link = screen.getByRole("link", { name: /Serious event/ });
    expect(link).toHaveAttribute("href", "/dashboard/packets/01JPACKET0000000000000001");
  });
});
