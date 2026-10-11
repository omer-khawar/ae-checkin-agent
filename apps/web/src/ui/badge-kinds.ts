/**
 * Badge kinds: the single table that says what every status chip in Interim means,
 * which colour token family it uses, which Lucide icon it carries and which word it
 * shows. `badge.tsx` renders from this table; nothing else should invent chip colours.
 *
 * Source of the values: docs/ui-audit/UI_AUDIT.md "Status chips" + src/ui/README.md
 * contrast table. Rules this table enforces:
 *   - Every chip has a word. The icon is extra; colour is third.
 *   - Clinical meaning (tier, SAE, AESI, provenance) never reuses the UI-feedback
 *     families (info/success/warning/danger), so a hue never means two clinical things.
 *   - Workflow states (draft, confirmed, rejected, acknowledged, clock stopped, rule,
 *     reference, query status) are NEUTRAL and told apart by icon + word, per the audit.
 *   - A "safety" query (touches a safety reporting duty) uses the SAE family on
 *     purpose: it is the same meaning ("a reporting duty is at stake").
 *   - The kiosk may only show `measured` / `simulated` (README "Surfaces").
 */
import {
  Activity,
  Ban,
  BookOpen,
  Check,
  CheckCheck,
  Circle,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleX,
  Clock,
  FlaskConical,
  GitBranch,
  History,
  Info,
  MessageSquare,
  MessageSquareReply,
  OctagonAlert,
  Pencil,
  Phone,
  ShieldAlert,
  Siren,
  Star,
  Tag,
  Timer,
  TimerOff,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";

/** Colour token families from tailwind.config.js (`bg-{tone}-bg text-{tone}-fg border-{tone}-border`). */
export type BadgeTone =
  | "tier-0"
  | "tier-1"
  | "tier-2"
  | "tier-3"
  | "measured"
  | "simulated"
  | "sae"
  | "aesi"
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger";

export interface BadgeKindSpec {
  tone: BadgeTone;
  icon: LucideIcon;
  /** Visible word (full form). */
  label: string;
  /** Visible word in dense tables; the full label is still announced to screen readers. */
  short?: string;
  /** Full meaning, for the tooltip and the screen-reader text when `short` is shown. */
  description: string;
  /** Uppercase word (provenance badges: MEASURED / SIMULATED). */
  uppercase?: boolean;
}

export const BADGE_KINDS = {
  // Escalation tiers (dashboard only; never on the kiosk).
  "tier-0": {
    tone: "tier-0",
    icon: Circle,
    label: "T0 · Log",
    short: "T0",
    description: "Tier 0: Log. No symptom above grade 1; no notification.",
  },
  "tier-1": {
    tone: "tier-1",
    icon: Clock,
    label: "T1 · Review within 1 business day",
    short: "T1",
    description: "Tier 1: Coordinator review within 1 business day.",
  },
  "tier-2": {
    tone: "tier-2",
    icon: Phone,
    label: "T2 · Nurse call today",
    short: "T2",
    description: "Tier 2: Nurse call today.",
  },
  "tier-3": {
    tone: "tier-3",
    icon: Siren,
    label: "T3 · Urgent",
    short: "T3",
    description: "Tier 3: Urgent. On-call role paged.",
  },

  // Provenance (allowed on the kiosk).
  measured: {
    tone: "measured",
    icon: Activity,
    label: "Measured",
    description: "Measured by a real sensor.",
    uppercase: true,
  },
  simulated: {
    tone: "simulated",
    icon: FlaskConical,
    label: "Simulated",
    description: "Simulated data (mock source). Not a measurement.",
    uppercase: true,
  },

  // Environment label (app header): the whole site runs on synthetic participants. NEUTRAL
  // on purpose: purple stays reserved for simulated MEASUREMENTS (data provenance above).
  "synthetic-env": {
    tone: "neutral",
    icon: CircleDashed,
    label: "Synthetic data",
    description:
      "Environment: every participant and value here is synthetic. No real patient data.",
  },

  // Seriousness and special interest.
  sae: {
    tone: "sae",
    icon: OctagonAlert,
    label: "SAE suspected",
    short: "SAE",
    description: "Serious adverse event suspected. Investigator decision required.",
  },
  "sae-clock": {
    tone: "sae",
    icon: Timer,
    label: "SAE report due",
    short: "SAE",
    description:
      "SAE clock running: the site must report to the sponsor within 24 hours of awareness.",
  },
  aesi: {
    tone: "aesi",
    icon: Star,
    label: "AESI (possible)",
    short: "AESI",
    description: "Possible adverse event of special interest.",
  },
  "clock-stopped": {
    tone: "neutral",
    icon: TimerOff,
    label: "Clock stopped",
    description: "Reporting clock stopped by an investigator decision.",
  },

  // Draft states (Draft.status).
  draft: {
    tone: "neutral",
    icon: Pencil,
    label: "Draft",
    description: "Draft: not yet confirmed by a coordinator.",
  },
  confirmed: {
    tone: "neutral",
    icon: CircleCheck,
    label: "Confirmed",
    description: "Confirmed by a coordinator.",
  },
  rejected: {
    tone: "neutral",
    icon: Ban,
    label: "Rejected",
    description: "Rejected by a coordinator.",
  },
  superseded: {
    tone: "neutral",
    icon: History,
    label: "Superseded",
    description: "Superseded by a newer version of this draft.",
  },
  acknowledged: {
    tone: "neutral",
    icon: Check,
    label: "Acknowledged",
    description: "Escalation acknowledged.",
  },
  rule: {
    tone: "neutral",
    icon: GitBranch,
    label: "Rule",
    description: "A deterministic rule fired.",
  },
  reference: {
    tone: "neutral",
    icon: BookOpen,
    label: "Reference",
    description: "Reference information (public source).",
  },

  // Data queries: severity (QuerySeverity) and status (QueryStatus).
  "query-data": {
    tone: "neutral",
    icon: MessageSquare,
    label: "Data query",
    short: "Data",
    description: "Data query: a record-keeping question.",
  },
  "query-safety": {
    tone: "sae",
    icon: ShieldAlert,
    label: "Safety query",
    short: "Safety",
    description: "Safety query: touches a safety reporting duty.",
  },
  "query-open": {
    tone: "neutral",
    icon: CircleDot,
    label: "Open",
    description: "Query open, awaiting an answer.",
  },
  "query-answered": {
    tone: "neutral",
    icon: MessageSquareReply,
    label: "Answered",
    description: "Query answered, awaiting closure.",
  },
  "query-closed": {
    tone: "neutral",
    icon: CheckCheck,
    label: "Closed",
    description: "Query closed.",
  },

  // UI feedback only (toasts, banners, "saved", "export failed"); never clinical meaning.
  info: { tone: "info", icon: Info, label: "Info", description: "Information." },
  success: { tone: "success", icon: CircleCheck, label: "Done", description: "Succeeded." },
  warning: { tone: "warning", icon: TriangleAlert, label: "Warning", description: "Warning." },
  danger: { tone: "danger", icon: CircleX, label: "Error", description: "Error." },
  neutral: { tone: "neutral", icon: Tag, label: "Note", description: "Note." },
} as const satisfies Record<string, BadgeKindSpec>;

export type BadgeKind = keyof typeof BADGE_KINDS;

/**
 * Escalation tier 0..3 → badge kind. A missing or out-of-range tier returns null so the
 * caller shows "Unknown" instead of silently rendering it as T0 (Log).
 */
export function tierBadgeKind(tier: number | null | undefined): BadgeKind | null {
  switch (tier) {
    case 0:
      return "tier-0";
    case 1:
      return "tier-1";
    case 2:
      return "tier-2";
    case 3:
      return "tier-3";
    default:
      return null;
  }
}

/** Draft.status → badge kind. */
export function draftBadgeKind(
  status: "draft" | "confirmed" | "rejected" | "superseded",
): BadgeKind {
  return status;
}

/** QuerySeverity → badge kind. */
export function querySeverityBadgeKind(severity: "data" | "safety"): BadgeKind {
  return severity === "safety" ? "query-safety" : "query-data";
}

/** QueryStatus → badge kind. */
export function queryStatusBadgeKind(status: "open" | "answered" | "closed"): BadgeKind {
  return `query-${status}`;
}

/** Provenance → badge kind. */
export function provenanceBadgeKind(isMeasured: boolean): BadgeKind {
  return isMeasured ? "measured" : "simulated";
}
