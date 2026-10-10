/**
 * Formatting helpers and the small lookup tables that give colours a meaning.
 *
 * - `<Time/>` shows local time with the UTC string on hover (CONTRACTS.md conventions).
 * - `TIERS` is the escalation ladder's display table (CLAUDE.md §3.4(e)).
 * - `measuredLabel()` / `MEASURED_STYLES` back the MEASURED / SIMULATED badge.
 *
 * Nothing here decides anything clinical; the API sends tiers and the UI only
 * looks up how to paint them.
 */
import type { Attribute, Item, ResponseOption, ResponseOptionsRaw, VitalsStatus } from "./types";

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

const LOCAL_FMT = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const LOCAL_SHORT_FMT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

const LOCAL_TIME_FMT = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function parseIso(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export type TimeStyle = "full" | "short" | "time";

/** Local-time rendering of a UTC ISO string; empty string for null/invalid. */
export function formatLocal(iso: string | null | undefined, style: TimeStyle = "full"): string {
  const d = parseIso(iso);
  if (!d) return "";
  if (style === "short") return LOCAL_SHORT_FMT.format(d);
  if (style === "time") return LOCAL_TIME_FMT.format(d);
  return LOCAL_FMT.format(d);
}

/** Canonical UTC form (ms precision, Z suffix) or "" for invalid input. */
export function formatUtc(iso: string | null | undefined): string {
  const d = parseIso(iso);
  return d ? d.toISOString() : "";
}

export interface TimeProps {
  iso: string | null | undefined;
  style?: TimeStyle;
  /** Shown when `iso` is null/invalid. */
  fallback?: string;
  className?: string;
}

/**
 * `<time>` element: local time as text, UTC on hover (title) and in `dateTime`.
 */
export function Time({ iso, style = "full", fallback = "—", className }: TimeProps) {
  const local = formatLocal(iso, style);
  if (!local) {
    return <span className={className}>{fallback}</span>;
  }
  const utc = formatUtc(iso);
  return (
    <time dateTime={utc} title={`${utc} (UTC)`} className={className}>
      {local}
    </time>
  );
}

/** "1h 23m" / "45s" / "overdue by 12m" style countdown for SAE clocks. */
export function formatCountdown(secondsRemaining: number | null | undefined): string {
  if (
    secondsRemaining === null ||
    secondsRemaining === undefined ||
    !Number.isFinite(secondsRemaining)
  ) {
    return "—";
  }
  const overdue = secondsRemaining < 0;
  const s = Math.abs(Math.round(secondsRemaining));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  let text: string;
  if (h > 0) text = `${h}h ${String(m).padStart(2, "0")}m`;
  else if (m > 0) text = `${m}m ${String(sec).padStart(2, "0")}s`;
  else text = `${sec}s`;
  return overdue ? `overdue by ${text}` : text;
}

/** Seconds → "m:ss" for the kiosk's capture timer. */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------

export interface TierStyle {
  tier: 0 | 1 | 2 | 3;
  name: string;
  /** Shorter label for chips in dense tables. */
  short: string;
  /** Tailwind colour family, for prose / docs. */
  color: "slate" | "amber" | "orange" | "red";
  /** Full class string for the chip (kept literal so Tailwind can see it). */
  chipClass: string;
  /** Class for a small dot/accent. */
  dotClass: string;
}

/**
 * Escalation ladder display table (CLAUDE.md §3.4(e)):
 * 0 Log · 1 Review within 1 business day · 2 Nurse call today · 3 Urgent.
 */
export const TIERS: Record<0 | 1 | 2 | 3, TierStyle> = {
  0: {
    tier: 0,
    name: "Log",
    short: "Log",
    color: "slate",
    chipClass: "bg-slate-200 text-slate-800 border-slate-300",
    dotClass: "bg-slate-400",
  },
  1: {
    tier: 1,
    name: "Review within 1 business day",
    short: "Review 1 business day",
    color: "amber",
    chipClass: "bg-amber-200 text-amber-900 border-amber-300",
    dotClass: "bg-amber-500",
  },
  2: {
    tier: 2,
    name: "Nurse call today",
    short: "Nurse call today",
    color: "orange",
    chipClass: "bg-orange-200 text-orange-900 border-orange-300",
    dotClass: "bg-orange-500",
  },
  3: {
    tier: 3,
    name: "Urgent",
    short: "Urgent",
    color: "red",
    chipClass: "bg-red-600 text-white border-red-700",
    dotClass: "bg-red-600",
  },
};

/** Clamp any number (or null) to a known tier style; unknown → Tier 0 style with name "Unknown". */
export function tierStyle(tier: number | null | undefined): TierStyle {
  if (tier === 0 || tier === 1 || tier === 2 || tier === 3) return TIERS[tier];
  return { ...TIERS[0], name: "Unknown", short: "Unknown" };
}

// ---------------------------------------------------------------------------
// Measured / simulated
// ---------------------------------------------------------------------------

export type MeasuredWord = "MEASURED" | "SIMULATED";

/** The word is always shown; never an icon alone (CLAUDE.md §13). */
export function measuredLabel(isMeasured: boolean): MeasuredWord {
  return isMeasured ? "MEASURED" : "SIMULATED";
}

export const MEASURED_STYLES: Record<MeasuredWord, { badgeClass: string; title: string }> = {
  MEASURED: {
    badgeClass: "bg-green-100 text-green-800 border-green-300",
    title: "Captured from a real sensor",
  },
  SIMULATED: {
    badgeClass: "bg-violet-100 text-violet-800 border-violet-300",
    title: "Synthetic signal from the mock vitals source; not a measurement",
  },
};

/** VSMETHOD text as the API exports it, for display next to a badge. */
export function vsMethod(isMeasured: boolean): string {
  return isMeasured ? "Contactless optical, camera-based" : "Simulated";
}

export const VITALS_STATUS_LABELS: Record<VitalsStatus, string> = {
  pending: "Pending",
  ok: "OK",
  unavailable: "Unavailable",
  low_quality: "Low quality",
  implausible: "Implausible (ignored)",
  simulated_ignored: "Simulated (ignored for rules)",
  declined: "Camera declined",
};

export function vitalsStatusLabel(status: VitalsStatus | string | null | undefined): string {
  if (!status) return "—";
  return (VITALS_STATUS_LABELS as Record<string, string>)[status] ?? status;
}

// ---------------------------------------------------------------------------
// PRO-CTCAE items
// ---------------------------------------------------------------------------

/** Participant-facing prompts per attribute, used when the item carries none. */
export const ATTRIBUTE_PROMPTS: Record<Attribute, string> = {
  frequency: "How often did you have it?",
  severity: "How bad was it at its worst?",
  interference: "How much did it get in the way of your usual daily activities?",
  presence: "Did you have it?",
};

/** Default option wordings (PRO-CTCAE style), used only if the API omits options. */
export const DEFAULT_OPTIONS: Record<Attribute, ResponseOption[]> = {
  frequency: [
    { label: "Never", value: 0 },
    { label: "Rarely", value: 1 },
    { label: "Occasionally", value: 2 },
    { label: "Frequently", value: 3 },
    { label: "Almost constantly", value: 4 },
  ],
  severity: [
    { label: "None", value: 0 },
    { label: "Mild", value: 1 },
    { label: "Moderate", value: 2 },
    { label: "Severe", value: 3 },
    { label: "Very severe", value: 4 },
  ],
  interference: [
    { label: "Not at all", value: 0 },
    { label: "A little bit", value: 1 },
    { label: "Somewhat", value: 2 },
    { label: "Quite a bit", value: 3 },
    { label: "Very much", value: 4 },
  ],
  presence: [
    { label: "No", value: 0 },
    { label: "Yes", value: 1 },
  ],
};

/** Normalise `label → int` objects or `{label, value}` arrays into an ordered array. */
export function normalizeOptions(
  raw: ResponseOptionsRaw | undefined,
  attribute: Attribute,
): ResponseOption[] {
  if (!raw) return DEFAULT_OPTIONS[attribute];
  if (Array.isArray(raw)) {
    const arr = raw.filter((o) => o && typeof o.label === "string" && Number.isFinite(o.value));
    return arr.length ? [...arr].sort((a, b) => a.value - b.value) : DEFAULT_OPTIONS[attribute];
  }
  const entries = Object.entries(raw).filter(([, v]) => Number.isFinite(v));
  if (!entries.length) return DEFAULT_OPTIONS[attribute];
  return entries.map(([label, value]) => ({ label, value })).sort((a, b) => a.value - b.value);
}

export function optionsFor(item: Item, attribute: Attribute): ResponseOption[] {
  return normalizeOptions(item.response_options?.[attribute], attribute);
}

/**
 * The question stem for one attribute: the rules table's `prompts.<attribute>`
 * wins, then the legacy `attribute_prompts`, then a generic fallback.
 */
export function promptFor(item: Item, attribute: Attribute): string {
  return (
    item.prompts?.[attribute] ?? item.attribute_prompts?.[attribute] ?? ATTRIBUTE_PROMPTS[attribute]
  );
}

/** "in the last 7 days" → "the last 7 days" (the table phrases it with a leading "in"). */
export function stripLeadingIn(window: string): string {
  return window.trim().replace(/^in\s+/i, "");
}

/**
 * The "Think about the last 7 days." helper line under an item heading, or
 * `null` when every prompt on the screen already states the recall window
 * (the shipped table's stems all start "In the last 7 days, …", so the line
 * would be redundant there).
 */
export function recallLine(item: Item, fallbackWindow: string): string | null {
  const raw = (item.recall_window || fallbackWindow || "").trim();
  if (!raw) return null;
  const phrase = stripLeadingIn(raw).toLowerCase();
  const attrs = item.attributes.length ? item.attributes : (["severity"] as Attribute[]);
  const allPromptsCarryWindow =
    phrase.length > 0 && attrs.every((a) => promptFor(item, a).toLowerCase().includes(phrase));
  if (allPromptsCarryWindow) return null;
  return `Think about ${stripLeadingIn(raw)}.`;
}

// ---------------------------------------------------------------------------
// Optional typed temperature (fever_or_chills)
// ---------------------------------------------------------------------------

export interface TemperatureField {
  id: string;
  label: string;
  unit: string;
  /** Plausibility bounds from the table; undefined when the table omits them. */
  min: number | undefined;
  max: number | undefined;
  note: string | undefined;
}

const FALLBACK_TEMP_LABEL = "If you measured your temperature, you can type it here (optional)";
const FALLBACK_TEMP_UNIT = "°C";

/**
 * The item's optional temperature field, read from the rules table
 * (`optional_fields[]`, or the legacy `optional_numeric`). Returns `null` for
 * items without one. Bounds come from the table only; code never supplies a
 * clinical number.
 */
export function temperatureField(item: Item): TemperatureField | null {
  const fromTable = item.optional_fields?.find(
    (f) => f.id === "temp_c" || f.stored_as === "gates.temp_c" || f.type === "number",
  );
  if (fromTable) {
    return {
      id: fromTable.id,
      label: fromTable.label || FALLBACK_TEMP_LABEL,
      unit: fromTable.unit ?? FALLBACK_TEMP_UNIT,
      min: Number.isFinite(fromTable.min) ? fromTable.min : undefined,
      max: Number.isFinite(fromTable.max) ? fromTable.max : undefined,
      note: fromTable.note,
    };
  }
  if (item.optional_numeric) {
    return {
      id: item.optional_numeric.id,
      label: item.optional_numeric.label || FALLBACK_TEMP_LABEL,
      unit: item.optional_numeric.unit || FALLBACK_TEMP_UNIT,
      min: undefined,
      max: undefined,
      note: undefined,
    };
  }
  // CLAUDE.md §3.2: fever_or_chills carries an optional measured temperature even
  // if an API strips the table's optional_fields. No bounds are invented here.
  if (item.id === "fever_or_chills") {
    return {
      id: "temp_c",
      label: FALLBACK_TEMP_LABEL,
      unit: FALLBACK_TEMP_UNIT,
      min: undefined,
      max: undefined,
      note: undefined,
    };
  }
  return null;
}

export type ParsedTemperature =
  | { kind: "empty" }
  | { kind: "ok"; value: number }
  | { kind: "invalid" }
  | { kind: "out_of_range"; value: number };

/** Parse the temperature box against the table's bounds. Whitespace-only is "empty". */
export function parseTemperature(raw: string, field: TemperatureField | null): ParsedTemperature {
  const text = raw.trim();
  if (!text) return { kind: "empty" };
  if (!/^[-+]?\d+(\.\d+)?$/.test(text)) return { kind: "invalid" };
  const value = Number.parseFloat(text);
  if (!Number.isFinite(value)) return { kind: "invalid" };
  if (field) {
    if (field.min !== undefined && value < field.min) return { kind: "out_of_range", value };
    if (field.max !== undefined && value > field.max) return { kind: "out_of_range", value };
  }
  return { kind: "ok", value };
}

/** Participant-facing message for a temperature the kiosk will not accept. */
export function temperatureProblem(
  parsed: ParsedTemperature,
  field: TemperatureField | null,
): string | null {
  if (parsed.kind === "ok" || parsed.kind === "empty") return null;
  const unit = field?.unit ?? FALLBACK_TEMP_UNIT;
  if (
    parsed.kind === "out_of_range" &&
    field &&
    field.min !== undefined &&
    field.max !== undefined
  ) {
    return `Please enter a temperature between ${field.min} and ${field.max} ${unit}, or leave this empty.`;
  }
  return `Please enter a number in ${unit}, or leave this empty.`;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** Round a vitals value for display: integers for bpm, one decimal for ms. */
export function formatVital(value: number | null | undefined, decimals = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toFixed(decimals);
}

/** 0..1 → "93%" */
export function formatConfidence(conf: number | null | undefined): string {
  if (conf === null || conf === undefined || !Number.isFinite(conf)) return "—";
  return `${Math.round(conf * 100)}%`;
}

/** Join class names, skipping falsy values. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
