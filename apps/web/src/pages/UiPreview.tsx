/**
 * /ui-preview: a living sheet of the Interim design system (UI revamp, phase 1).
 *
 * Shows every src/ui component on the real tokens, so a reviewer can check the look,
 * the contrast and the keyboard behaviour in a browser before phase 2 migrates the
 * pages. Nothing here calls the API: every row, participant and value is SYNTHETIC
 * and is labelled so on screen.
 *
 * Sections:
 *   (a) Tokens: colour swatches with computed WCAG contrast ratios, console + kiosk type scales.
 *   (b) Console chrome: app header with count badges, segmented control, buttons, badges,
 *       kbd hints, toasts, a sheet with an evidence-panel mock, the command menu (Ctrl/⌘K, /).
 *   (c) Worklist: DataTable with 25 synthetic queue-shaped rows, sorting, selection, bulk bar.
 *   (d) Kiosk: a [data-surface="kiosk"] frame at 1024 × 768 proportions with progress,
 *       question card, answer group, sticky action bar and the verbatim disclaimer.
 *
 * Glass is used only for chrome (header, palette, sheet, toasts, kiosk cards and bar);
 * data surfaces stay opaque (src/ui/README.md "Glass rules").
 */
import { type ColumnDef } from "@tanstack/react-table";
import {
  ChevronDown,
  ClipboardList,
  Download,
  FileText,
  ListChecks,
  PanelRight,
  Phone,
  Search,
  UserRound,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useMemo, useState } from "react";

import { AppHeader, AppHeaderBrand, AppHeaderNav, AppHeaderNavItem } from "@/ui/app-header";
import { Badge } from "@/ui/badge";
import { BADGE_KINDS, type BadgeKind, tierBadgeKind } from "@/ui/badge-kinds";
import { Button } from "@/ui/button";
import { CommandMenu, type CommandMenuItem } from "@/ui/command-menu";
import { DataTable, type DataTableColumnMeta } from "@/ui/data-table";
import {
  GlassCard,
  GlassCardContent,
  GlassCardDescription,
  GlassCardFooter,
  GlassCardHeader,
  GlassCardTitle,
} from "@/ui/glass-card";
import { Kbd, KbdCombo, KbdSequence } from "@/ui/kbd";
import { KioskActionBar } from "@/ui/kiosk/action-bar";
import { AnswerGroup, type AnswerOption } from "@/ui/kiosk/answer-group";
import { KioskProgress } from "@/ui/kiosk/progress";
import { QuestionCard } from "@/ui/kiosk/question-card";
import { SegmentedControl } from "@/ui/segmented-control";
import {
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/ui/sheet";
import { notify } from "@/ui/toast";
import { Toaster } from "@/ui/toaster";
import { useCommandMenu } from "@/ui/use-command-menu";

/* =========================================================================================
 * Contrast (WCAG 2.x relative luminance), computed from the hex values in tokens.css
 * ========================================================================================= */

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  );
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** "text" needs 4.5:1, "ui" (control edges, focus rings) 3:1, "decorative" has no minimum. */
type PairKind = "text" | "ui" | "decorative";

interface SwatchSpec {
  name: string;
  /** Tailwind class pair, spelled out for the content scanner. */
  swatchClass: string;
  sample: ReactNode;
  /** Hex of the swatch colour (mirrors tokens.css). */
  hex: string;
  /** What it is measured against. */
  pairLabel: string;
  pairHex: string;
  kind: PairKind;
}

const CONSOLE_SWATCHES: SwatchSpec[] = [
  {
    name: "background",
    swatchClass: "bg-background",
    sample: <span className="text-foreground">Aa</span>,
    hex: "#F3F7F7",
    pairLabel: "text #111827",
    pairHex: "#111827",
    kind: "text",
  },
  {
    name: "surface",
    swatchClass: "bg-surface",
    sample: <span className="text-foreground">Aa</span>,
    hex: "#FFFFFF",
    pairLabel: "text #111827",
    pairHex: "#111827",
    kind: "text",
  },
  {
    name: "surface-subtle",
    swatchClass: "bg-surface-subtle",
    sample: <span className="text-muted-foreground">Aa</span>,
    hex: "#EEF3F4",
    pairLabel: "text-muted #4B5563",
    pairHex: "#4B5563",
    kind: "text",
  },
  {
    name: "surface-selected",
    swatchClass: "bg-surface-selected",
    sample: <span className="text-foreground">Aa</span>,
    hex: "#E3F1EF",
    pairLabel: "text #111827",
    pairHex: "#111827",
    kind: "text",
  },
  {
    name: "text-muted",
    swatchClass: "bg-surface",
    sample: <span className="text-muted-foreground">Aa</span>,
    hex: "#4B5563",
    pairLabel: "on surface #FFFFFF",
    pairHex: "#FFFFFF",
    kind: "text",
  },
  {
    name: "text-subtle (lightest)",
    swatchClass: "bg-surface",
    sample: <span className="text-subtle-foreground">Aa</span>,
    hex: "#5F6B7A",
    pairLabel: "on surface #FFFFFF",
    pairHex: "#FFFFFF",
    kind: "text",
  },
  {
    name: "primary",
    swatchClass: "bg-primary",
    sample: <span className="text-primary-foreground">Aa</span>,
    hex: "#0F766E",
    pairLabel: "white text",
    pairHex: "#FFFFFF",
    kind: "text",
  },
  {
    name: "primary-strong",
    swatchClass: "bg-primary-strong",
    sample: <span className="text-primary-foreground">Aa</span>,
    hex: "#115E59",
    pairLabel: "white text",
    pairHex: "#FFFFFF",
    kind: "text",
  },
  {
    name: "accent (highlight)",
    swatchClass: "bg-accent",
    sample: <span className="text-accent-foreground">Aa</span>,
    hex: "#E6F2F1",
    pairLabel: "accent-fg #115E59",
    pairHex: "#115E59",
    kind: "text",
  },
  {
    name: "destructive",
    swatchClass: "bg-destructive",
    sample: <span className="text-destructive-foreground">Aa</span>,
    hex: "#B91C1C",
    pairLabel: "white text",
    pairHex: "#FFFFFF",
    kind: "text",
  },
  {
    name: "border-strong (inputs)",
    swatchClass: "bg-surface",
    sample: <span className="block size-8 rounded-control border-2 border-border-strong" />,
    hex: "#7B8794",
    pairLabel: "vs surface #FFFFFF",
    pairHex: "#FFFFFF",
    kind: "ui",
  },
  {
    name: "focus ring",
    swatchClass: "bg-background",
    sample: (
      <span className="block size-8 rounded-control bg-surface outline outline-2 outline-offset-2 outline-ring" />
    ),
    hex: "#0F766E",
    pairLabel: "vs background #F3F7F7",
    pairHex: "#F3F7F7",
    kind: "ui",
  },
  {
    name: "border (dividers)",
    swatchClass: "bg-surface",
    sample: <span className="block h-px w-10 bg-border" />,
    hex: "#D5DBE1",
    pairLabel: "vs surface #FFFFFF",
    pairHex: "#FFFFFF",
    kind: "decorative",
  },
];

const KIOSK_SWATCHES: SwatchSpec[] = [
  {
    name: "background",
    swatchClass: "bg-background",
    sample: <span className="text-foreground">Aa</span>,
    hex: "#F5F9F9",
    pairLabel: "text #0F172A",
    pairHex: "#0F172A",
    kind: "text",
  },
  {
    name: "surface (options)",
    swatchClass: "bg-surface",
    sample: <span className="text-foreground">Aa</span>,
    hex: "#FFFFFF",
    pairLabel: "text #0F172A",
    pairHex: "#0F172A",
    kind: "text",
  },
  {
    name: "text-muted (lightest)",
    swatchClass: "bg-surface",
    sample: <span className="text-muted-foreground">Aa</span>,
    hex: "#334155",
    pairLabel: "on surface #FFFFFF",
    pairHex: "#FFFFFF",
    kind: "text",
  },
  {
    name: "primary (Next, selected)",
    swatchClass: "bg-primary",
    sample: <span className="text-primary-foreground">Aa</span>,
    hex: "#115E59",
    pairLabel: "white text",
    pairHex: "#FFFFFF",
    kind: "text",
  },
  {
    name: "primary-strong (hover)",
    swatchClass: "bg-primary-strong",
    sample: <span className="text-primary-foreground">Aa</span>,
    hex: "#134E4A",
    pairLabel: "white text",
    pairHex: "#FFFFFF",
    kind: "text",
  },
  {
    name: "destructive (validation)",
    swatchClass: "bg-surface",
    sample: <span className="text-destructive">Aa</span>,
    hex: "#991B1B",
    pairLabel: "on surface #FFFFFF",
    pairHex: "#FFFFFF",
    kind: "text",
  },
  {
    name: "border-strong (option edge)",
    swatchClass: "bg-surface",
    sample: <span className="block size-8 rounded-control border-2 border-border-strong" />,
    hex: "#64748B",
    pairLabel: "vs surface #FFFFFF",
    pairHex: "#FFFFFF",
    kind: "ui",
  },
  {
    name: "focus ring (blue)",
    swatchClass: "bg-background",
    sample: (
      <span className="block size-8 rounded-control bg-surface outline outline-[3px] outline-offset-[3px] outline-ring" />
    ),
    hex: "#1E3A8A",
    pairLabel: "vs background #F5F9F9",
    pairHex: "#F5F9F9",
    kind: "ui",
  },
];

interface StatusSpec {
  name: string;
  chipClass: string;
  fg: string;
  bg: string;
}

const STATUS_SWATCHES: StatusSpec[] = [
  {
    name: "tier-0",
    chipClass: "border-tier-0-border bg-tier-0-bg text-tier-0-fg",
    fg: "#374151",
    bg: "#F3F4F6",
  },
  {
    name: "tier-1",
    chipClass: "border-tier-1-border bg-tier-1-bg text-tier-1-fg",
    fg: "#713F12",
    bg: "#FEF3C7",
  },
  {
    name: "tier-2",
    chipClass: "border-tier-2-border bg-tier-2-bg text-tier-2-fg",
    fg: "#7C2D12",
    bg: "#FFEDD5",
  },
  {
    name: "tier-3",
    chipClass: "border-tier-3-border bg-tier-3-bg text-tier-3-fg",
    fg: "#FFFFFF",
    bg: "#B91C1C",
  },
  {
    name: "measured",
    chipClass: "border-measured-border bg-measured-bg text-measured-fg",
    fg: "#14532D",
    bg: "#DCFCE7",
  },
  {
    name: "simulated",
    chipClass: "border-simulated-border bg-simulated-bg text-simulated-fg",
    fg: "#4C1D95",
    bg: "#EDE9FE",
  },
  {
    name: "sae",
    chipClass: "border-sae-border bg-sae-bg text-sae-fg",
    fg: "#991B1B",
    bg: "#FEF2F2",
  },
  {
    name: "aesi",
    chipClass: "border-aesi-border bg-aesi-bg text-aesi-fg",
    fg: "#075985",
    bg: "#E0F2FE",
  },
  {
    name: "neutral",
    chipClass: "border-neutral-border bg-neutral-bg text-neutral-fg",
    fg: "#374151",
    bg: "#F3F4F6",
  },
  {
    name: "info",
    chipClass: "border-info-border bg-info-bg text-info-fg",
    fg: "#1E40AF",
    bg: "#EFF6FF",
  },
  {
    name: "success",
    chipClass: "border-success-border bg-success-bg text-success-fg",
    fg: "#14532D",
    bg: "#DCFCE7",
  },
  {
    name: "warning",
    chipClass: "border-warning-border bg-warning-bg text-warning-fg",
    fg: "#713F12",
    bg: "#FEF3C7",
  },
  {
    name: "danger",
    chipClass: "border-danger-border bg-danger-bg text-danger-fg",
    fg: "#991B1B",
    bg: "#FEF2F2",
  },
];

function RatioLabel({ ratio, kind }: { ratio: number; kind: PairKind }) {
  const text = `${ratio.toFixed(2)}:1`;
  if (kind === "decorative") {
    return (
      <span className="tabular text-caption text-muted-foreground">
        {text} · decorative (no minimum)
      </span>
    );
  }
  const needed = kind === "text" ? 4.5 : 3;
  const pass = ratio >= needed;
  return (
    <span className="tabular text-caption text-muted-foreground">
      {text} · needs {needed}:1 ·{" "}
      <span className={pass ? "font-semibold text-foreground" : "font-semibold text-destructive"}>
        {pass ? "pass" : "FAIL"}
      </span>
    </span>
  );
}

function SwatchGrid({ swatches }: { swatches: readonly SwatchSpec[] }) {
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-3">
      {swatches.map((s) => (
        <li key={s.name} className="overflow-hidden rounded-panel border border-border bg-surface">
          <div
            className={`flex h-16 items-center justify-center border-b border-border text-display font-semibold ${s.swatchClass}`}
          >
            {s.sample}
          </div>
          <div className="flex flex-col gap-0.5 px-3 py-2 font-console">
            <span className="text-body font-medium text-foreground">{s.name}</span>
            <span className="tabular font-mono text-caption text-muted-foreground">
              {s.hex} · {s.pairLabel}
            </span>
            <RatioLabel ratio={contrast(s.hex, s.pairHex)} kind={s.kind} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/* =========================================================================================
 * Type scales
 * ========================================================================================= */

const CONSOLE_TYPE = [
  {
    cls: "text-caption",
    token: "caption",
    px: 12,
    role: "Chips, meta, column headers",
    sample: "SAE 20:35 · P-007",
  },
  {
    cls: "text-table",
    token: "table",
    px: 13,
    role: "Table cells (tabular)",
    sample: "72/14 · 2 · 2 · 1 · 13:10",
  },
  {
    cls: "text-body",
    token: "body",
    px: 14,
    role: "Forms, Why panel",
    sample: "Tachypnea corroborates reported dyspnea.",
  },
  { cls: "text-title", token: "title", px: 16, role: "Panel title", sample: "AE 1 · Dyspnea" },
  { cls: "text-page", token: "page", px: 20, role: "Page heading (h1)", sample: "Queue" },
  { cls: "text-display", token: "display", px: 24, role: "Display", sample: "Interim" },
] as const;

const KIOSK_TYPE = [
  {
    cls: "text-k-disclaimer",
    token: "k-disclaimer",
    px: 16,
    role: "Disclaimer (verbatim)",
    sample: "It is not a medical device.",
  },
  {
    cls: "text-k-helper",
    token: "k-helper",
    px: 18,
    role: "Helper, eyebrow, counter",
    sample: "Question 3 of 13",
  },
  {
    cls: "text-k-body",
    token: "k-body",
    px: 20,
    role: "Body",
    sample: "Think about the last 7 days.",
  },
  { cls: "text-k-answer", token: "k-answer", px: 22, role: "Answer labels", sample: "Moderate" },
  { cls: "text-k-lead", token: "k-lead", px: 24, role: "Lead", sample: "Welcome back." },
  {
    cls: "text-k-question",
    token: "k-question",
    px: 30,
    role: "Question (H1)",
    sample: "How bad was it at its worst?",
  },
  { cls: "text-k-title", token: "k-title", px: 36, role: "Screen title", sample: "Thank you" },
] as const;

/* =========================================================================================
 * Synthetic worklist (25 queue-shaped rows; every value is invented)
 * ========================================================================================= */

type Source = "checkin" | "note" | "call";

interface RowSpec {
  usubjid: string;
  source: Source;
  /** Minutes before page load that the record arrived. */
  ago: number;
  tier: 0 | 1 | 2 | 3;
  acked?: boolean;
  grade: 0 | 1 | 2 | 3;
  /** [pulse, breathing] per minute, "declined" (camera declined), or null (not a check-in). */
  vitals: readonly [number, number] | "declined" | null;
  /** Report clock: minutes remaining at page load, or stopped. */
  clock?: { kind: "sae" | "aesi"; remainingMin: number } | { kind: "stopped" };
  drafts: readonly [ae: number, vs: number, cm: number];
}

const ROW_SPECS: readonly RowSpec[] = [
  {
    usubjid: "P-007",
    source: "checkin",
    ago: 12,
    tier: 3,
    acked: false,
    grade: 3,
    vitals: [118, 27],
    clock: { kind: "sae", remainingMin: 1428 },
    drafts: [2, 2, 1],
  },
  {
    usubjid: "P-011",
    source: "call",
    ago: 95,
    tier: 3,
    acked: true,
    grade: 3,
    vitals: null,
    clock: { kind: "sae", remainingMin: 1345 },
    drafts: [1, 0, 0],
  },
  {
    usubjid: "P-002",
    source: "checkin",
    ago: 1560,
    tier: 3,
    acked: true,
    grade: 2,
    vitals: [96, 22],
    clock: { kind: "stopped" },
    drafts: [1, 2, 0],
  },
  {
    usubjid: "P-004",
    source: "checkin",
    ago: 40,
    tier: 2,
    acked: false,
    grade: 3,
    vitals: [101, 19],
    clock: { kind: "aesi", remainingMin: 803 },
    drafts: [1, 2, 0],
  },
  {
    usubjid: "P-009",
    source: "note",
    ago: 130,
    tier: 2,
    acked: true,
    grade: 3,
    vitals: null,
    drafts: [1, 0, 1],
  },
  {
    usubjid: "P-012",
    source: "checkin",
    ago: 210,
    tier: 2,
    acked: false,
    grade: 2,
    vitals: [112, 26],
    drafts: [1, 2, 0],
  },
  {
    usubjid: "P-001",
    source: "checkin",
    ago: 1320,
    tier: 2,
    acked: true,
    grade: 3,
    vitals: [88, 17],
    drafts: [2, 2, 0],
  },
  {
    usubjid: "P-006",
    source: "call",
    ago: 300,
    tier: 2,
    acked: true,
    grade: 3,
    vitals: null,
    clock: { kind: "aesi", remainingMin: 190 },
    drafts: [1, 0, 0],
  },
  {
    usubjid: "P-003",
    source: "checkin",
    ago: 18,
    tier: 1,
    grade: 2,
    vitals: [74, 15],
    drafts: [1, 2, 1],
  },
  {
    usubjid: "P-005",
    source: "checkin",
    ago: 55,
    tier: 1,
    grade: 2,
    vitals: "declined",
    drafts: [1, 0, 0],
  },
  { usubjid: "P-008", source: "note", ago: 75, tier: 1, grade: 2, vitals: null, drafts: [1, 0, 0] },
  {
    usubjid: "P-010",
    source: "checkin",
    ago: 160,
    tier: 1,
    grade: 2,
    vitals: [80, 16],
    drafts: [2, 2, 1],
  },
  {
    usubjid: "P-007",
    source: "note",
    ago: 260,
    tier: 1,
    grade: 2,
    vitals: null,
    drafts: [1, 0, 0],
  },
  {
    usubjid: "P-002",
    source: "checkin",
    ago: 400,
    tier: 1,
    grade: 2,
    vitals: [69, 13],
    drafts: [1, 2, 0],
  },
  {
    usubjid: "P-011",
    source: "checkin",
    ago: 1500,
    tier: 1,
    grade: 2,
    vitals: [77, 14],
    drafts: [1, 2, 0],
  },
  {
    usubjid: "P-004",
    source: "call",
    ago: 1700,
    tier: 1,
    grade: 2,
    vitals: null,
    drafts: [0, 0, 1],
  },
  {
    usubjid: "P-001",
    source: "checkin",
    ago: 35,
    tier: 0,
    grade: 1,
    vitals: [70, 14],
    drafts: [1, 2, 0],
  },
  {
    usubjid: "P-006",
    source: "checkin",
    ago: 90,
    tier: 0,
    grade: 0,
    vitals: [66, 12],
    drafts: [0, 2, 0],
  },
  {
    usubjid: "P-009",
    source: "checkin",
    ago: 140,
    tier: 0,
    grade: 1,
    vitals: "declined",
    drafts: [1, 0, 0],
  },
  {
    usubjid: "P-012",
    source: "note",
    ago: 230,
    tier: 0,
    grade: 0,
    vitals: null,
    drafts: [0, 0, 0],
  },
  {
    usubjid: "P-003",
    source: "checkin",
    ago: 330,
    tier: 0,
    grade: 1,
    vitals: [72, 14],
    drafts: [1, 2, 0],
  },
  {
    usubjid: "P-005",
    source: "checkin",
    ago: 600,
    tier: 0,
    grade: 0,
    vitals: [75, 15],
    drafts: [0, 2, 1],
  },
  {
    usubjid: "P-008",
    source: "checkin",
    ago: 900,
    tier: 0,
    grade: 1,
    vitals: [81, 16],
    drafts: [1, 2, 0],
  },
  {
    usubjid: "P-010",
    source: "call",
    ago: 1200,
    tier: 0,
    grade: 0,
    vitals: null,
    drafts: [0, 0, 0],
  },
  {
    usubjid: "P-011",
    source: "checkin",
    ago: 2000,
    tier: 0,
    grade: 1,
    vitals: [71, 13],
    drafts: [1, 2, 0],
  },
];

interface WorkRow extends RowSpec {
  id: string;
  receivedAt: number;
  /** Absolute deadline (ms) for a running clock. */
  dueAt: number | null;
}

const MINUTE = 60_000;

function buildRows(loadedAt: number): WorkRow[] {
  return (
    ROW_SPECS.map((spec, index) => ({
      ...spec,
      id: `ci-${String(index + 1).padStart(2, "0")}`,
      receivedAt: loadedAt - spec.ago * MINUTE,
      dueAt:
        spec.clock && spec.clock.kind !== "stopped"
          ? loadedAt + spec.clock.remainingMin * MINUTE
          : null,
    }))
      // "Server" priority order: tier desc, then newest first.
      .sort((a, b) => b.tier - a.tier || b.receivedAt - a.receivedAt)
  );
}

const SOURCE_META: Record<Source, { word: string; icon: ReactNode }> = {
  checkin: { word: "Check-in", icon: <ClipboardList /> },
  note: { word: "Note", icon: <FileText /> },
  call: { word: "Call", icon: <Phone /> },
};

function hhmm(date: Date): string {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

function formatReceived(ts: number, now: number): string {
  const d = new Date(ts);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  if (sameDay) return hhmm(d);
  return `${d.toLocaleDateString([], { weekday: "short" })} ${hhmm(d)}`;
}

/**
 * Time left on a report clock, with units and a direction ("22h 25m left", "overdue 1h 05m"),
 * so it can never be read as a time of day next to the Received column (which is h:mm).
 */
function formatRemaining(ms: number): string {
  const overdue = ms < 0;
  const totalMin = Math.floor(Math.abs(ms) / MINUTE);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const span = h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
  return overdue ? `overdue ${span}` : `${span} left`;
}

/** Absolute due time for the clock's tooltip, e.g. "Due Sun 23:48 (2026-10-11T03:48:00.000Z)". */
function formatDue(dueAt: number, now: number): string {
  return `Due ${formatReceived(dueAt, now)} (${new Date(dueAt).toISOString()})`;
}

function clockRunning(row: WorkRow): boolean {
  return row.dueAt !== null;
}

/** Bulk confirm is allowed for T0/T1 rows without a running clock (audit Q-06). */
function canBulkConfirm(row: WorkRow): boolean {
  return row.tier <= 1 && !clockRunning(row);
}

function needsAction(row: WorkRow): boolean {
  return row.tier >= 2 ? row.acked !== true : row.tier === 1;
}

type WorklistView = "action" | "clocks" | "all";

function buildColumns(now: number): ColumnDef<WorkRow>[] {
  return [
    {
      id: "participant",
      header: "Participant",
      accessorFn: (r) => r.usubjid,
      meta: { rowHeader: true, width: "7.5rem" } satisfies DataTableColumnMeta,
      cell: ({ row }) => (
        <span className="font-semibold text-foreground">{row.original.usubjid}</span>
      ),
    },
    {
      id: "source",
      header: "Source",
      enableSorting: false,
      // Icon only below 1280px (the word stays for screen readers and as the tooltip).
      meta: { width: "auto" } satisfies DataTableColumnMeta,
      cell: ({ row }) => {
        const meta = SOURCE_META[row.original.source];
        return (
          <span
            title={meta.word}
            className="inline-flex items-center gap-1.5 text-muted-foreground [&_svg]:size-3.5"
          >
            <span aria-hidden="true" className="inline-flex">
              {meta.icon}
            </span>
            <span className="sr-only xl:not-sr-only">{meta.word}</span>
          </span>
        );
      },
    },
    {
      id: "received",
      header: "Received",
      accessorFn: (r) => r.receivedAt,
      meta: { width: "7rem", tabular: true } satisfies DataTableColumnMeta,
      cell: ({ row }) => (
        <time
          dateTime={new Date(row.original.receivedAt).toISOString()}
          title={new Date(row.original.receivedAt).toISOString()}
        >
          {formatReceived(row.original.receivedAt, now)}
        </time>
      ),
    },
    {
      id: "tier",
      header: "Tier",
      accessorFn: (r) => r.tier,
      meta: { width: "9rem" } satisfies DataTableColumnMeta,
      cell: ({ row }) => {
        const kind = tierBadgeKind(row.original.tier);
        const acked = row.original.acked;
        return (
          <span className="inline-flex items-center gap-1.5">
            {kind ? <Badge kind={kind} size="sm" short /> : <span>Unknown</span>}
            {row.original.tier >= 2 ? (
              <span className={acked ? "text-muted-foreground" : "font-semibold text-foreground"}>
                {acked ? "acked" : "not acked"}
              </span>
            ) : null}
          </span>
        );
      },
    },
    {
      id: "grade",
      header: "Max grade (prov.)",
      accessorFn: (r) => r.grade,
      // One line, so the sort arrow stays beside its own label.
      meta: {
        numeric: true,
        width: "10.5rem",
        headerClassName: "whitespace-nowrap",
      } satisfies DataTableColumnMeta,
      cell: ({ row }) =>
        row.original.grade === 0 ? (
          <span className="text-muted-foreground">none</span>
        ) : (
          <span className="font-medium">{row.original.grade}</span>
        ),
    },
    {
      id: "vitals",
      header: "Vitals (pulse/resp)",
      enableSorting: false,
      meta: { width: "11rem", tabular: true } satisfies DataTableColumnMeta,
      cell: ({ row }) => {
        const v = row.original.vitals;
        if (v === null) return <span className="text-muted-foreground">n/a</span>;
        if (v === "declined") return <span className="text-muted-foreground">camera declined</span>;
        return (
          <span className="inline-flex items-center gap-1.5">
            <span>
              {v[0]}/{v[1]}
            </span>
            <Badge
              kind="simulated"
              size="sm"
              title="Simulated vitals (mock source): context only, ignored for rules."
            />
          </span>
        );
      },
    },
    {
      id: "clock",
      header: "Report clock",
      accessorFn: (r) => (r.dueAt === null ? Number.POSITIVE_INFINITY : r.dueAt),
      meta: { width: "10rem", tabular: true } satisfies DataTableColumnMeta,
      cell: ({ row }) => {
        const r = row.original;
        if (r.clock?.kind === "stopped")
          return <Badge kind="clock-stopped" size="sm" label="Stopped" />;
        if (r.dueAt === null || !r.clock)
          return <span className="text-muted-foreground">none</span>;
        return (
          <Badge
            kind={r.clock.kind === "sae" ? "sae-clock" : "aesi"}
            size="sm"
            short
            detail={formatRemaining(r.dueAt - now)}
            title={`${BADGE_KINDS[r.clock.kind === "sae" ? "sae-clock" : "aesi"].description} ${formatDue(r.dueAt, now)}.`}
          />
        );
      },
    },
    {
      id: "drafts",
      header: "Drafts AE/VS/CM",
      enableSorting: false,
      // Low priority: hidden below 1280px so the worklist never scrolls sideways at 1024px.
      meta: { numeric: true, width: "8.5rem", hideBelow: "xl" } satisfies DataTableColumnMeta,
      cell: ({ row }) => {
        const [ae, vs, cm] = row.original.drafts;
        return (
          <>
            <span aria-hidden="true">
              {ae} · {vs} · {cm}
            </span>
            <span className="sr-only">{`AE ${ae}, VS ${vs}, CM ${cm}`}</span>
          </>
        );
      },
    },
  ];
}

/* =========================================================================================
 * Kiosk mock
 * ========================================================================================= */

const SEVERITY: AnswerOption<number>[] = [
  { value: 0, label: "None" },
  { value: 1, label: "Mild" },
  { value: 2, label: "Moderate" },
  { value: 3, label: "Severe" },
  { value: 4, label: "Very severe" },
];

const INTERFERENCE: AnswerOption<number>[] = [
  { value: 0, label: "Not at all" },
  { value: 1, label: "A little bit" },
  { value: 2, label: "Somewhat" },
  { value: 3, label: "Quite a bit" },
  { value: 4, label: "Very much" },
];

const KIOSK_QUESTIONS = [
  {
    eyebrow: "Shortness of breath",
    title: "In the last 7 days, how bad was your shortness of breath at its worst?",
    options: SEVERITY,
  },
  {
    eyebrow: "Shortness of breath",
    title:
      "In the last 7 days, how much did shortness of breath get in the way of your usual activities?",
    options: INTERFERENCE,
  },
  {
    eyebrow: "Cough",
    title: "In the last 7 days, how bad was your cough at its worst?",
    options: SEVERITY,
  },
] as const;

/** The real check-in has 10 items + 3 gate questions; the preview stops after the first three. */
const KIOSK_TOTAL = 13;

function KioskMock() {
  const baseId = useId();
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<(number | null)[]>(() => KIOSK_QUESTIONS.map(() => null));
  const [error, setError] = useState(false);
  const [interacted, setInteracted] = useState(false);
  const [large, setLarge] = useState<"standard" | "large">("standard");

  const done = step >= KIOSK_QUESTIONS.length;
  const question = KIOSK_QUESTIONS[Math.min(step, KIOSK_QUESTIONS.length - 1)]!;
  const titleId = `${baseId}-q${step}`;

  const next = () => {
    setInteracted(true);
    if (done) {
      setAnswers(KIOSK_QUESTIONS.map(() => null));
      setStep(0);
      return;
    }
    if (answers[step] === null || answers[step] === undefined) {
      setError(true);
      return;
    }
    setError(false);
    setStep((s) => s + 1);
  };

  const back = () => {
    setInteracted(true);
    setError(false);
    setStep((s) => Math.max(0, s - 1));
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3 font-console">
        <SegmentedControl
          label="Kiosk text size"
          size="sm"
          value={large}
          onValueChange={setLarge}
          options={[
            { value: "standard", label: "Standard text (20px root)" },
            { value: "large", label: "Larger text (24px root)" },
          ]}
        />
        <span className="text-caption text-muted-foreground">
          Frame is 1024 × 768 at full width; content scrolls under the sticky glass bar.
        </span>
      </div>

      <div
        role="region"
        aria-label="Kiosk preview, 1024 by 768"
        data-surface="kiosk"
        data-text-size={large === "large" ? "large" : undefined}
        className="relative mx-auto flex aspect-[4/3] w-full max-w-[1024px] flex-col overflow-y-auto rounded-sheet border border-border-strong/40 bg-background bg-[radial-gradient(900px_420px_at_15%_0%,rgb(var(--accent)/0.10),transparent_70%)] shadow-elev-2"
      >
        <div className="flex flex-1 flex-col gap-6 px-6 pb-8 pt-6">
          <div className="mx-auto flex w-full max-w-k-content flex-col gap-4">
            {done ? null : (
              <KioskProgress current={step + 1} total={KIOSK_TOTAL} announce={interacted} />
            )}
            <div className="flex flex-wrap items-center gap-3 rounded-panel border border-border bg-surface px-4 py-2 text-k-helper">
              <span className="font-semibold">Pulse</span>
              <span className="tabular">72 /min</span>
              <span aria-hidden="true" className="text-muted-foreground">
                ·
              </span>
              <span className="font-semibold">Breathing</span>
              <span className="text-muted-foreground">collecting…</span>
              <Badge kind="simulated" size="lg" className="ml-auto" detail="mock" />
            </div>
          </div>

          {done ? (
            <QuestionCard
              title="Thank you"
              titleSize="screen"
              headingLevel={2}
              description="This is the end of the preview questions. Nothing was saved."
              focusKey={interacted ? "done" : undefined}
            />
          ) : (
            <QuestionCard
              key={step}
              eyebrow={question.eyebrow}
              title={question.title}
              headingLevel={2}
              titleId={titleId}
              description="Choose one answer."
              focusKey={interacted ? step : undefined}
            >
              <AnswerGroup<number>
                name={`${baseId}-answer-${step}`}
                aria-labelledby={titleId}
                options={question.options}
                value={answers[step] ?? null}
                onValueChange={(v) => {
                  setError(false);
                  setAnswers((prev) => prev.map((a, i) => (i === step ? v : a)));
                }}
                error={error ? "Please choose an answer" : undefined}
              />
            </QuestionCard>
          )}
        </div>

        <KioskActionBar
          onNext={next}
          onBack={back}
          showBack={!done && step > 0}
          nextLabel={done ? "Start again" : "Next"}
        />
      </div>
    </div>
  );
}

/* =========================================================================================
 * Page helpers
 * ========================================================================================= */

function Section({
  id,
  title,
  lead,
  children,
}: {
  id: string;
  title: string;
  lead: ReactNode;
  children: ReactNode;
}) {
  const headingId = `${id}-heading`;
  return (
    <section id={id} aria-labelledby={headingId} className="flex scroll-mt-20 flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h2 id={headingId} className="text-page text-foreground">
          {title}
        </h2>
        <p className="max-w-3xl text-body text-muted-foreground">{lead}</p>
      </header>
      {children}
    </section>
  );
}

function Panel({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col gap-3 rounded-panel border border-border bg-surface p-4 ${className ?? ""}`}
    >
      <h3 className="text-title text-foreground">{title}</h3>
      {children}
    </div>
  );
}

function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView?.({ block: "start" });
}

const BADGE_KIND_LIST = Object.keys(BADGE_KINDS) as BadgeKind[];

/* =========================================================================================
 * Evidence sheet (mock)
 * ========================================================================================= */

const EVIDENCE = [
  {
    badge: <Badge kind="neutral" label="Answer" />,
    text: "Shortness of breath · severity = Moderate (2)",
    id: "ANS-01JA7Q3M2K8V",
    ts: "13:10:42 UTC",
  },
  {
    badge: <Badge kind="neutral" label="Answer" />,
    text: "Shortness of breath · interference = Somewhat (2)",
    id: "ANS-01JA7Q3P9D1C",
    ts: "13:10:51 UTC",
  },
  {
    badge: <Badge kind="rule" />,
    text: "composite_score: severity 2 + interference 2 → composite 2 (Basch 2020 table)",
    id: "RULE-composite_score",
    ts: "13:12:03 UTC",
  },
  {
    badge: <Badge kind="rule" />,
    text: "composite_to_grade: composite 2 → grade 2 (provisional)",
    id: "RULE-composite_to_grade",
    ts: "13:12:03 UTC",
  },
  {
    badge: <Badge kind="simulated" />,
    text: "Breathing 14 /min, confidence 0.92, 30 s window. Context only: vitals never change a grade.",
    id: "VS-01JA7Q3T4H6E",
    ts: "13:10:58 UTC",
  },
] as const;

function EvidenceSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger asChild>
        <Button variant="secondary" leadingIcon={<PanelRight />}>
          Open evidence sheet
        </Button>
      </SheetTrigger>
      <SheetContent side="right" size="md">
        <SheetHeader>
          <SheetTitle>Evidence for AETOXGR</SheetTitle>
          <SheetDescription>
            AE 1 · Dyspnea · P-007 check-in (synthetic preview data)
          </SheetDescription>
        </SheetHeader>
        <SheetBody className="flex flex-col gap-4">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-panel border border-border bg-surface p-3 text-body">
            <dt className="font-mono text-caption text-muted-foreground">AETERM</dt>
            <dd>Shortness of breath</dd>
            <dt className="font-mono text-caption text-muted-foreground">AEDECOD</dt>
            <dd>Dyspnea</dd>
            <dt className="font-mono text-caption text-muted-foreground">AETOXGR</dt>
            <dd className="tabular">
              <span className="font-semibold">2</span> (provisional, investigator to confirm)
            </dd>
            <dt className="font-mono text-caption text-muted-foreground">INTERIM_TIER</dt>
            <dd>
              <Badge kind="tier-1" size="sm" />
            </dd>
          </dl>
          <div className="flex flex-col gap-2">
            <h3 className="text-title text-foreground">Evidence ({EVIDENCE.length})</h3>
            <ol className="flex flex-col gap-2">
              {EVIDENCE.map((e) => (
                <li
                  key={e.id}
                  className="flex flex-col gap-1.5 rounded-panel border border-border bg-surface p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    {e.badge}
                    <span className="tabular ml-auto text-caption text-muted-foreground">
                      {e.ts}
                    </span>
                  </div>
                  <p className="text-body text-foreground">{e.text}</p>
                  <span className="font-mono text-caption text-muted-foreground">{e.id}</span>
                </li>
              ))}
            </ol>
          </div>
        </SheetBody>
        <SheetFooter>
          <SheetClose asChild>
            <Button>Close</Button>
          </SheetClose>
          <Button
            variant="primary"
            onClick={() => {
              onOpenChange(false);
              notify.success("Draft confirmed (preview)", {
                description: "AE 1 · Dyspnea, grade 2 (provisional) · P-007. Nothing was saved.",
                undo: () => notify.info("Confirmation undone (preview)"),
              });
            }}
          >
            Confirm draft
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

/* =========================================================================================
 * Page
 * ========================================================================================= */

export default function UiPreview() {
  const [loadedAt] = useState(() => Date.now());
  const [now, setNow] = useState(loadedAt);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const rows = useMemo(() => buildRows(loadedAt), [loadedAt]);
  const columns = useMemo(() => buildColumns(now), [now]);

  const [view, setView] = useState<WorklistView>("all");
  const [density, setDensity] = useState<"compact" | "comfortable">("compact");
  const [demoFilter, setDemoFilter] = useState<"open" | "acked" | "all">("open");
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const menu = useCommandMenu({ slash: true });

  const counts = useMemo(
    () => ({
      action: rows.filter(needsAction).length,
      clocks: rows.filter(clockRunning).length,
      all: rows.length,
    }),
    [rows],
  );
  const visibleRows = useMemo(
    () =>
      view === "action"
        ? rows.filter(needsAction)
        : view === "clocks"
          ? rows.filter(clockRunning)
          : rows,
    [rows, view],
  );

  const commandItems = useMemo<CommandMenuItem[]>(() => {
    const sections: [string, string][] = [
      ["tokens", "Tokens"],
      ["chrome", "Console chrome"],
      ["worklist", "Worklist"],
      ["kiosk", "Kiosk"],
    ];
    const participants = [...new Set(ROW_SPECS.map((r) => r.usubjid))].sort();
    return [
      ...sections.map(([id, label]) => ({
        id: `go-${id}`,
        label,
        group: "Go to",
        hint: "Section of this preview",
        onSelect: () => scrollToSection(id),
      })),
      ...participants.map((p) => ({
        id: p,
        label: p,
        group: "Participants",
        icon: <UserRound />,
        hint: "Synthetic participant",
        keywords: ["participant", "usubjid"],
        onSelect: () =>
          notify.info(`Would open the ${p} timeline`, { description: "Preview only." }),
      })),
      {
        id: "action-evidence",
        label: "Open evidence sheet",
        group: "Actions",
        icon: <PanelRight />,
        keywords: ["why", "evidence", "drawer"],
        // Let the palette close and return focus before the sheet takes it.
        onSelect: () => window.setTimeout(() => setEvidenceOpen(true), 0),
      },
      {
        id: "action-density",
        label: "Toggle table density",
        group: "Actions",
        icon: <ListChecks />,
        hint: "Compact 36px · Comfortable 44px",
        onSelect: () => setDensity((d) => (d === "compact" ? "comfortable" : "compact")),
      },
      {
        id: "action-toast",
        label: "Show a sample toast",
        group: "Actions",
        onSelect: () =>
          notify.info("Escalation paged (preview)", { description: "Tier 3 · P-007 · mock pager" }),
      },
    ];
  }, []);

  return (
    <div
      data-surface="console"
      className="min-h-screen bg-background bg-[radial-gradient(1100px_520px_at_8%_-8%,rgb(var(--accent)/0.09),transparent_70%)] font-console text-foreground"
    >
      <AppHeader
        brand={<AppHeaderBrand>Interim</AppHeaderBrand>}
        nav={
          <AppHeaderNav label="Preview sections">
            <AppHeaderNavItem href="#tokens">Tokens</AppHeaderNavItem>
            <AppHeaderNavItem href="#chrome">Chrome</AppHeaderNavItem>
            <AppHeaderNavItem href="#worklist" count={counts.action} countLabel="need action">
              Worklist
            </AppHeaderNavItem>
            <AppHeaderNavItem href="#kiosk">Kiosk</AppHeaderNavItem>
          </AppHeaderNav>
        }
        search={
          <Button
            size="sm"
            leadingIcon={<Search />}
            onClick={menu.toggle}
            aria-keyshortcuts="Control+K Meta+K /"
            data-command-menu-trigger=""
          >
            Jump to…
            <KbdCombo keys={["Ctrl", "K"]} className="ml-1" />
          </Button>
        }
        study={
          <Badge
            kind="synthetic-env"
            title="Every value on this page is synthetic."
          />
        }
        actions={
          <Button
            size="sm"
            variant="ghost"
            leadingIcon={<UserRound />}
            trailingIcon={<ChevronDown />}
          >
            Preview
          </Button>
        }
      />

      <main
        id="main"
        className="mx-auto flex max-w-[1440px] flex-col gap-12 px-4 pb-24 pt-8 xl:px-6"
      >
        <header className="flex flex-col gap-2">
          <h1 className="text-display text-foreground">Interim design system preview</h1>
          <p className="max-w-3xl text-body text-muted-foreground">
            Phase 1 of the UI revamp: tokens and components only. Glass is used for chrome (this
            header, the command menu, sheets, toasts, kiosk cards and the kiosk bar); data surfaces
            stay opaque. All participants and values on this page are synthetic.
          </p>
        </header>

        {/* (a) Tokens --------------------------------------------------------------------- */}
        <Section
          id="tokens"
          title="Tokens"
          lead="Ratios are computed live from the hex values in tokens.css (WCAG 2.x). Text needs 4.5:1; control edges and focus rings need 3:1."
        >
          <Panel title="Console colours">
            <SwatchGrid swatches={CONSOLE_SWATCHES} />
          </Panel>
          <Panel title="Kiosk colours">
            <div data-surface="kiosk" className="text-body">
              <SwatchGrid swatches={KIOSK_SWATCHES} />
            </div>
          </Panel>
          <Panel title="Status chips (word + icon + colour)">
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-3">
              {STATUS_SWATCHES.map((s) => (
                <li
                  key={s.name}
                  className="flex items-center gap-3 rounded-panel border border-border px-3 py-2"
                >
                  <span
                    className={`inline-flex h-6 items-center rounded-control border px-2 text-caption font-medium ${s.chipClass}`}
                  >
                    {s.name}
                  </span>
                  <RatioLabel ratio={contrast(s.fg, s.bg)} kind="text" />
                </li>
              ))}
            </ul>
          </Panel>
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Console type scale (Inter, tabular figures in data)">
              <ul className="flex flex-col divide-y divide-border">
                {CONSOLE_TYPE.map((t) => (
                  <li key={t.token} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2">
                    <span className="tabular w-28 shrink-0 font-mono text-caption text-muted-foreground">
                      {t.token} · {t.px}px
                    </span>
                    <span className={`tabular min-w-0 flex-1 text-foreground ${t.cls}`}>
                      {t.sample}
                    </span>
                    <span className="w-full text-caption text-muted-foreground sm:w-auto">
                      {t.role}
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
            <Panel title="Kiosk type scale (Atkinson Hyperlegible, 20px root)">
              <ul data-surface="kiosk" className="flex flex-col divide-y divide-border">
                {KIOSK_TYPE.map((t) => (
                  <li key={t.token} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2">
                    <span className="tabular w-32 shrink-0 font-mono text-caption text-muted-foreground">
                      {t.token} · {t.px}px
                    </span>
                    <span className={`min-w-0 flex-1 text-foreground ${t.cls}`}>{t.sample}</span>
                    <span className="w-full font-console text-caption text-muted-foreground sm:w-auto">
                      {t.role}
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          </div>
        </Section>

        {/* (b) Console chrome --------------------------------------------------------------- */}
        <Section
          id="chrome"
          title="Console chrome"
          lead="The 48px glass app bar, controls and overlays. Scroll the frame below to see table rows pass under the frosted header."
        >
          <Panel title="App header (product navigation, with count badges)">
            <div className="relative h-56 overflow-y-auto rounded-panel border border-border bg-background">
              <AppHeader
                skipToId={null}
                brand={<AppHeaderBrand>Interim</AppHeaderBrand>}
                nav={
                  <AppHeaderNav label="Primary (demo)">
                    <AppHeaderNavItem href="#worklist" active count={7} countLabel="need action">
                      Queue
                    </AppHeaderNavItem>
                    <AppHeaderNavItem
                      href="#chrome"
                      active={false}
                      count={2}
                      countLabel="not acknowledged"
                      urgent
                    >
                      Escalations
                    </AppHeaderNavItem>
                    <AppHeaderNavItem href="#chrome" active={false} count={1} countLabel="open">
                      Queries
                    </AppHeaderNavItem>
                    <AppHeaderNavItem href="#chrome" active={false}>
                      Notes
                    </AppHeaderNavItem>
                  </AppHeaderNav>
                }
                search={
                  <Button size="sm" leadingIcon={<Search />} onClick={menu.toggle}>
                    Jump to…
                    <Kbd className="ml-1">/</Kbd>
                  </Button>
                }
                study={
                  <span className="flex items-center gap-2">
                    <Button size="sm" variant="ghost" trailingIcon={<ChevronDown />}>
                      <span>R2810-ONC-1624 · NCT03088540</span>
                    </Button>
                    <Badge
                      kind="synthetic-env"
                      size="sm"
                      title="All participants are synthetic."
                    />
                  </span>
                }
                actions={
                  <Button
                    size="sm"
                    variant="ghost"
                    leadingIcon={<UserRound />}
                    trailingIcon={<ChevronDown />}
                  >
                    Coordinator
                  </Button>
                }
              />
              <ul
                aria-label="Content beneath the header (synthetic)"
                className="flex flex-col gap-1 p-3"
              >
                {rows.slice(0, 12).map((r) => (
                  <li
                    key={r.id}
                    className="tabular flex h-row items-center gap-3 rounded-control border border-border bg-surface px-3 text-table"
                  >
                    <span className="w-14 font-semibold">{r.usubjid}</span>
                    {tierBadgeKind(r.tier) ? (
                      <Badge kind={tierBadgeKind(r.tier)!} size="sm" />
                    ) : null}
                    <span className="ml-auto text-muted-foreground">
                      {formatReceived(r.receivedAt, now)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </Panel>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Segmented control">
              <SegmentedControl
                label="Show escalations"
                value={demoFilter}
                onValueChange={setDemoFilter}
                options={[
                  {
                    value: "open",
                    label: "Open",
                    accessory: <span className="tabular text-muted-foreground">3</span>,
                  },
                  {
                    value: "acked",
                    label: "Acknowledged",
                    accessory: <span className="tabular text-muted-foreground">5</span>,
                  },
                  {
                    value: "all",
                    label: "All",
                    accessory: <span className="tabular text-muted-foreground">8</span>,
                  },
                ]}
              />
              <SegmentedControl
                label="Code labels"
                size="sm"
                value="both"
                onValueChange={() => undefined}
                options={[
                  { value: "plain", label: "Plain" },
                  { value: "both", label: "Both" },
                  { value: "codes", label: "Codes" },
                  { value: "raw", label: "Raw JSON", disabled: true },
                ]}
              />
              <p className="text-caption text-muted-foreground">
                Arrow keys move and select; Home/End jump; disabled options are skipped.
              </p>
            </Panel>

            <Panel title="Keyboard hints">
              <dl className="grid grid-cols-[1fr_auto] items-center gap-x-6 gap-y-2 text-body">
                <dt>Open the command menu</dt>
                <dd>
                  <KbdCombo keys={["Ctrl", "K"]} />{" "}
                  <span className="text-muted-foreground">or</span>{" "}
                  <KbdCombo keys={["⌘", "K"]} connector="plus" />
                </dd>
                <dt>Jump to… (not while typing)</dt>
                <dd>
                  <Kbd>/</Kbd>
                </dd>
                <dt>Go to queue</dt>
                <dd>
                  <KbdSequence keys={["G", "Q"]} />
                </dd>
                <dt>Next / previous row</dt>
                <dd className="flex gap-1">
                  <Kbd>j</Kbd>
                  <Kbd>k</Kbd>
                </dd>
                <dt>Next item</dt>
                <dd>
                  <Kbd>]</Kbd>
                </dd>
                <dt>Close a sheet or menu</dt>
                <dd>
                  <Kbd>Esc</Kbd>
                </dd>
              </dl>
            </Panel>
          </div>

          <Panel title="Buttons (console 28/32px; kiosk 64/72px sizes are in the kiosk frame)">
            <div className="flex flex-col gap-3">
              {(["md", "sm"] as const).map((size) => (
                <div key={size} className="flex flex-wrap items-center gap-2">
                  <span className="w-10 font-mono text-caption text-muted-foreground">{size}</span>
                  <Button size={size} variant="primary">
                    Confirm
                  </Button>
                  <Button size={size} variant="secondary">
                    Edit
                  </Button>
                  <Button size={size} variant="ghost">
                    Cancel
                  </Button>
                  <Button size={size} variant="danger">
                    Reject
                  </Button>
                  <Button size={size} variant="destructive">
                    Yes, reject
                  </Button>
                  <Button size={size} variant="glass">
                    Glass
                  </Button>
                  <Button size={size} variant="primary" loading>
                    Saving
                  </Button>
                  <Button size={size} variant="secondary" disabled>
                    Disabled
                  </Button>
                </div>
              ))}
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-10 font-mono text-caption text-muted-foreground">misc</span>
                <Button size="icon" variant="secondary" aria-label="Download bundle">
                  <Download />
                </Button>
                <Button variant="secondary" leadingIcon={<Download />}>
                  Export CSV
                </Button>
                <Button asChild variant="ghost">
                  <a href="#worklist">Link styled as a button</a>
                </Button>
                <Button variant="secondary" trailingIcon={<Kbd>C</Kbd>}>
                  Confirm
                </Button>
              </div>
            </div>
          </Panel>

          <Panel title="Badges (every kind; icon + word, colour third)">
            <div className="flex flex-wrap gap-2">
              {BADGE_KIND_LIST.map((kind) => (
                <Badge key={kind} kind={kind} />
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-caption text-muted-foreground">dense:</span>
              {(["tier-0", "tier-1", "tier-2", "tier-3", "sae", "aesi"] as const).map((kind) => (
                <Badge key={kind} kind={kind} size="sm" short />
              ))}
              <Badge kind="sae-clock" size="sm" short detail="20h 35m left" />
              <Badge kind="aesi" size="sm" short detail="overdue 12m" />
              <Badge kind="simulated" size="sm" label="Simulated · ignored for rules" />
            </div>
            <div data-surface="kiosk" className="flex flex-wrap items-center gap-3">
              <span className="font-mono text-caption text-muted-foreground">kiosk (lg):</span>
              <Badge kind="measured" size="lg" detail="presage" />
              <Badge kind="simulated" size="lg" detail="mock" />
            </div>
          </Panel>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Toasts (glass, polite live region)">
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() =>
                    notify.success("Draft confirmed", {
                      description: "AE 1 · Dyspnea, grade 2 (provisional) · P-007",
                    })
                  }
                >
                  Success
                </Button>
                <Button
                  onClick={() =>
                    notify.warning("Draft rejected", {
                      description: "CM 1 · loratadine · P-003",
                      undo: () => notify.info("Rejection undone"),
                    })
                  }
                >
                  Warning with Undo
                </Button>
                <Button
                  onClick={() =>
                    notify.info("Escalation paged", {
                      description: "Tier 3 · P-007 · on-call (mock pager)",
                    })
                  }
                >
                  Info
                </Button>
                <Button
                  variant="danger"
                  onClick={() =>
                    notify.danger("Export failed", {
                      description: "The mock EDC did not answer. Nothing was sent.",
                    })
                  }
                >
                  Error (stays)
                </Button>
              </div>
              <p className="text-caption text-muted-foreground">
                Success 5 s, info 6 s, warning 8 s, errors stay until dismissed; toasts with Undo
                last at least 10 s.
              </p>
            </Panel>

            <Panel title="Sheet and command menu">
              <div className="flex flex-wrap gap-2">
                <EvidenceSheet open={evidenceOpen} onOpenChange={setEvidenceOpen} />
                <Button leadingIcon={<Search />} onClick={() => menu.setOpen(true)}>
                  Open command menu
                </Button>
              </div>
              <p className="text-caption text-muted-foreground">
                The sheet traps focus and returns it on close; the evidence inside stays on opaque
                panels. The command menu opens with Ctrl/⌘K or /.
              </p>
            </Panel>
          </div>

          <Panel title="Glass card (login, welcome and question cards)">
            <div className="rounded-panel bg-[linear-gradient(135deg,rgb(var(--accent)/0.16),rgb(var(--accent)/0.04)_55%,rgb(var(--surface-subtle)))] p-6">
              <GlassCard as="section" strength="strong" className="mx-auto max-w-md">
                <GlassCardHeader>
                  <div className="flex flex-col gap-1">
                    <GlassCardTitle>Sign in to Interim</GlassCardTitle>
                    <GlassCardDescription>
                      Demo roles: coordinator, investigator, admin.
                    </GlassCardDescription>
                  </div>
                </GlassCardHeader>
                <GlassCardContent className="text-body text-muted-foreground">
                  Glass frames the card; the form fields inside stay opaque.
                </GlassCardContent>
                <GlassCardFooter>
                  <Button variant="primary">Continue as coordinator</Button>
                  <Button variant="ghost">Open kiosk</Button>
                </GlassCardFooter>
              </GlassCard>
            </div>
          </Panel>
        </Section>

        {/* (c) Worklist ---------------------------------------------------------------------- */}
        <Section
          id="worklist"
          title="Worklist"
          lead="DataTable with 25 synthetic queue rows: 36px rows, 13px tabular cells, sticky header under the app bar, whole-row open (click or Enter), j/k movement, sortable headers and bulk selection (T0/T1 without a running clock only)."
        >
          <DataTable<WorkRow>
            caption="Synthetic worklist: check-ins, notes and calls by participant, with tier, grade, vitals, report clock and draft counts."
            data={visibleRows}
            columns={columns}
            getRowId={(r) => r.id}
            getRowLabel={(r) => `${r.usubjid} ${SOURCE_META[r.source].word.toLowerCase()}`}
            density={density}
            stickyTop="var(--appbar-h)"
            selectable
            canSelectRow={canBulkConfirm}
            selectDisabledReason="Tier 2+ and running clocks are reviewed one at a time."
            onRowActivate={(r) =>
              notify.info(`Would open ${r.usubjid} ${SOURCE_META[r.source].word.toLowerCase()}`, {
                description: "Preview only.",
              })
            }
            bulkActions={({ rows: selected, clear }) => (
              <>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => {
                    notify.success(
                      `Confirmed drafts of ${selected.length} ${selected.length === 1 ? "row" : "rows"} (preview)`,
                      {
                        description:
                          "One audit event per draft would be written. Nothing was saved.",
                      },
                    );
                    clear();
                  }}
                >
                  Confirm drafts ({selected.length})
                </Button>
                <Button
                  size="sm"
                  leadingIcon={<Download />}
                  onClick={() => notify.info(`Export of ${selected.length} rows (preview)`)}
                >
                  Export CSV
                </Button>
              </>
            )}
            toolbar={
              <div className="flex flex-wrap items-center gap-3">
                <SegmentedControl<WorklistView>
                  label="Worklist view"
                  value={view}
                  onValueChange={setView}
                  options={[
                    {
                      value: "action",
                      label: "Needs action",
                      accessory: (
                        <span className="tabular text-muted-foreground">{counts.action}</span>
                      ),
                    },
                    {
                      value: "clocks",
                      label: "Clocks running",
                      accessory: (
                        <span className="tabular text-muted-foreground">{counts.clocks}</span>
                      ),
                    },
                    {
                      value: "all",
                      label: "All",
                      accessory: (
                        <span className="tabular text-muted-foreground">{counts.all}</span>
                      ),
                    },
                  ]}
                />
                <SegmentedControl
                  label="Row density"
                  size="sm"
                  value={density}
                  onValueChange={setDensity}
                  options={[
                    { value: "compact", label: "Compact 36" },
                    { value: "comfortable", label: "Comfortable 44" },
                  ]}
                />
                <span className="text-caption text-muted-foreground">
                  Sorted by: priority (tier, then newest). Click a header to sort; a third click
                  restores priority.
                </span>
              </div>
            }
          />
          <p className="text-caption text-muted-foreground">
            Vitals are pulse/breathing per minute from the mock source, labelled SIMULATED: context
            only, never used by the rules. Report clock shows the time left with units ("22h 25m
            left", or "overdue 1h 05m"); hover for the absolute due time. Drafts are AE · VS · CM
            counts (column shown from 1280px wide).
          </p>
        </Section>

        {/* (d) Kiosk --------------------------------------------------------------------------- */}
        <Section
          id="kiosk"
          title="Kiosk"
          lead='The participant surface ([data-surface="kiosk"]): Atkinson Hyperlegible at a 20px root, 64px answer rows, solid #115E59 + check for the selected answer, a blue focus ring, and the sticky glass action bar with the disclaimer word for word. Next stays enabled and validates on tap.'
        >
          <KioskMock />
        </Section>
      </main>

      <CommandMenu
        open={menu.open}
        onOpenChange={menu.setOpen}
        items={commandItems}
        groups={["Go to", "Participants", "Actions"]}
      />
      <Toaster />
    </div>
  );
}
