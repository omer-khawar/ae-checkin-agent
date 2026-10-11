import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Badge } from "../badge";
import {
  BADGE_KINDS,
  draftBadgeKind,
  provenanceBadgeKind,
  queryStatusBadgeKind,
  querySeverityBadgeKind,
  tierBadgeKind,
  type BadgeKind,
} from "../badge-kinds";

const ALL_KINDS = Object.keys(BADGE_KINDS) as BadgeKind[];

describe("Badge", () => {
  it.each(ALL_KINDS)("%s renders an icon AND a word, never colour alone", (kind) => {
    const { container } = render(<Badge kind={kind} />);
    const root = container.querySelector("[data-slot='badge']") as HTMLElement;
    expect(root).toHaveAttribute("data-kind", kind);

    const svg = root.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute("aria-hidden", "true");

    const word = root.textContent?.trim() ?? "";
    expect(word.length).toBeGreaterThan(1);
    expect(word).toBe(BADGE_KINDS[kind].label);
    // Token classes only.
    expect(root.className).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(root.className).toContain(`bg-${BADGE_KINDS[kind].tone}-bg`);
  });

  it("uses the audit's tier words and shapes", () => {
    render(
      <>
        <Badge kind="tier-0" />
        <Badge kind="tier-1" />
        <Badge kind="tier-2" />
        <Badge kind="tier-3" />
      </>,
    );
    expect(screen.getByText("T0 · Log")).toBeInTheDocument();
    expect(screen.getByText("T1 · Review within 1 business day")).toBeInTheDocument();
    expect(screen.getByText("T2 · Nurse call today").parentElement).toHaveClass("border-2");
    expect(screen.getByText("T3 · Urgent").parentElement).toHaveClass(
      "bg-tier-3-bg",
      "text-tier-3-fg",
    );
  });

  it("short form shows the dense word but announces the full meaning", () => {
    const { container } = render(<Badge kind="tier-2" short />);
    const visible = screen.getByText("T2");
    expect(visible).toHaveAttribute("aria-hidden", "true");
    const sr = screen.getByText("Tier 2: Nurse call today.");
    expect(sr).toHaveClass("sr-only");
    expect(container.querySelector("[data-slot='badge']")).toHaveAttribute(
      "title",
      "Tier 2: Nurse call today.",
    );
  });

  it("short is ignored for kinds without a short word", () => {
    render(<Badge kind="confirmed" short />);
    expect(screen.getByText("Confirmed")).not.toHaveAttribute("aria-hidden");
  });

  it("measured / simulated are uppercase words with distinct icons and tones", () => {
    const { container } = render(
      <>
        <Badge kind="measured" />
        <Badge kind="simulated" detail="mock" />
      </>,
    );
    const [measured, simulated] = Array.from(
      container.querySelectorAll<HTMLElement>("[data-slot='badge']"),
    );
    expect(measured).toHaveClass("uppercase", "bg-measured-bg");
    expect(simulated).toHaveClass("uppercase", "bg-simulated-bg");
    expect(measured.querySelector("svg")?.outerHTML).not.toBe(
      simulated.querySelector("svg")?.outerHTML,
    );
    expect(screen.getByText("mock")).toHaveClass("normal-case", "tabular");
  });

  it("SAE clock shows a tabular countdown detail after the word", () => {
    render(<Badge kind="sae-clock" short detail="20:35" />);
    const detail = screen.getByText("20:35");
    expect(detail).toHaveAttribute("data-slot", "badge-detail");
    expect(detail).toHaveClass("tabular");
    expect(screen.getByText("SAE")).toBeInTheDocument();
  });

  it("label overrides the word but an empty label keeps the default word", () => {
    render(
      <>
        <Badge kind="simulated" label="Simulated · ignored for rules" />
        <Badge kind="draft" label="   " />
      </>,
    );
    expect(screen.getByText("Simulated · ignored for rules")).toBeInTheDocument();
    expect(screen.getByText("Draft")).toBeInTheDocument();
  });

  it("text never goes below 12px: console sizes use text-caption, kiosk uses the 16px role", () => {
    const { container } = render(
      <>
        <Badge kind="draft" size="sm" />
        <Badge kind="draft" size="md" />
        <Badge kind="simulated" size="lg" />
      </>,
    );
    const [sm, md, lg] = Array.from(container.querySelectorAll("[data-slot='badge']"));
    expect(sm).toHaveClass("text-caption");
    expect(md).toHaveClass("text-caption");
    expect(lg).toHaveClass("text-k-disclaimer");
    expect(container.innerHTML).not.toMatch(/text-\[(10|11)px\]/);
  });

  it("is static text, not a control", () => {
    render(<Badge kind="tier-1" />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("T1 · Review within 1 business day").closest("[tabindex]")).toBeNull();
  });
});

describe("badge kind mappers", () => {
  it("maps tiers 0..3 and refuses to guess for anything else", () => {
    expect([0, 1, 2, 3].map(tierBadgeKind)).toEqual(["tier-0", "tier-1", "tier-2", "tier-3"]);
    expect(tierBadgeKind(null)).toBeNull();
    expect(tierBadgeKind(undefined)).toBeNull();
    expect(tierBadgeKind(4)).toBeNull();
  });

  it("maps draft status, query severity/status and provenance", () => {
    expect(draftBadgeKind("superseded")).toBe("superseded");
    expect(querySeverityBadgeKind("safety")).toBe("query-safety");
    expect(querySeverityBadgeKind("data")).toBe("query-data");
    expect(queryStatusBadgeKind("answered")).toBe("query-answered");
    expect(provenanceBadgeKind(true)).toBe("measured");
    expect(provenanceBadgeKind(false)).toBe("simulated");
  });

  it("clinical kinds never use the UI-feedback colour families", () => {
    const clinical: BadgeKind[] = [
      "tier-0",
      "tier-1",
      "tier-2",
      "tier-3",
      "sae",
      "sae-clock",
      "aesi",
      "measured",
      "simulated",
      "query-safety",
    ];
    for (const k of clinical) {
      expect(["info", "success", "warning", "danger"]).not.toContain(BADGE_KINDS[k].tone);
    }
  });
});
