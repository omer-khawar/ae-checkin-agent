/**
 * Pure logic for painting scanner spans onto note text.
 *
 * Spans can overlap (a red-flag regex often covers the same words as a symptom
 * match), so the text is cut at every span boundary and each resulting segment
 * carries the full set of spans that cover it. The renderer then picks one
 * visual style by priority (red flag > symptom > med > excluded) and lists
 * every label in the tooltip, so no finding is hidden by another.
 *
 * No I/O, no React: unit-tested in `__tests__/highlight.test.ts`.
 */
import type { ScanResult } from "../../../lib/types";
import { foundByOf, type FoundBy } from "./readerTypes";

export type SpanKind = "symptom" | "med" | "red_flag" | "excluded" | "gemini";

export interface HighlightSpan {
  /** Stable id, e.g. "symptom:0", used for selection. */
  id: string;
  kind: SpanKind;
  start: number;
  end: number;
  /** Short label shown in the tooltip, e.g. "Dyspnea (symptom)". */
  label: string;
  /** Longer explanation, e.g. the exclusion reason. */
  title?: string;
  /** R5.3: who found it; "both" gets a small Gemini mark. */
  foundBy?: FoundBy;
}

export interface Segment {
  start: number;
  end: number;
  text: string;
  /** Spans covering this segment, highest priority first. Empty = plain text. */
  spans: HighlightSpan[];
}

const PRIORITY: Record<SpanKind, number> = {
  red_flag: 0,
  gemini: 1,
  symptom: 2,
  med: 3,
  excluded: 4,
};

const EXCLUSION_WORDING: Record<string, string> = {
  negated: "Negated in the note (e.g. “denies …”); not drafted.",
  historical: "Historical mention (past history); not drafted.",
  hypothetical: "Hypothetical or conditional mention (e.g. “call if …”); not drafted.",
  resolved: "Reported as resolved; not drafted as a new event.",
  allergy: "Listed as an allergy, not a medication change; not drafted.",
  indication: "Mentioned as an indication for a drug, not an event; not drafted.",
};

export function exclusionWording(reason: string | null | undefined): string {
  if (!reason) return "Excluded by the scanner.";
  return EXCLUSION_WORDING[reason] ?? `Excluded: ${reason}.`;
}

function byNote(f: unknown): string {
  const fb = foundByOf(f);
  if (fb === "gemini") return ", found by Gemini, quote checked";
  if (fb === "both") return ", found by scanner and Gemini";
  return "";
}

/** Build the span list a `ScanResult` implies, clamped to the text length. */
export function spansFromScan(scan: ScanResult, textLength: number): HighlightSpan[] {
  const out: HighlightSpan[] = [];
  const clamp = (n: number) => Math.max(0, Math.min(textLength, Math.trunc(n)));
  const push = (s: HighlightSpan) => {
    const start = clamp(s.start);
    const end = clamp(s.end);
    if (end > start) out.push({ ...s, start, end });
  };
  scan.red_flags.forEach((f, i) =>
    push({
      id: `red_flag:${i}`,
      kind: "red_flag",
      start: f.span_start,
      end: f.span_end,
      label: `Red flag · ${f.level} · ${f.category}`,
      title: f.reason,
    }),
  );
  scan.symptoms.forEach((f, i) =>
    push({
      id: `symptom:${i}`,
      kind: foundByOf(f) === "gemini" ? "gemini" : "symptom",
      foundBy: foundByOf(f),
      start: f.span_start,
      end: f.span_end,
      label: `${f.term} (symptom${byNote(f)})`,
      title: f.reason,
    }),
  );
  scan.meds.forEach((f, i) =>
    push({
      id: `med:${i}`,
      kind: foundByOf(f) === "gemini" ? "gemini" : "med",
      foundBy: foundByOf(f),
      start: f.span_start,
      end: f.span_end,
      label: `${f.drug} · ${f.change} (medication${byNote(f)})`,
      title: f.reason,
    }),
  );
  scan.excluded_symptoms.forEach((f, i) =>
    push({
      id: `excluded_symptom:${i}`,
      kind: "excluded",
      start: f.span_start,
      end: f.span_end,
      label: `${f.term} (excluded: ${f.excluded_reason ?? "excluded"})`,
      title: exclusionWording(f.excluded_reason),
    }),
  );
  scan.excluded_meds.forEach((f, i) =>
    push({
      id: `excluded_med:${i}`,
      kind: "excluded",
      start: f.span_start,
      end: f.span_end,
      label: `${f.drug} (excluded: ${f.excluded_reason ?? "excluded"})`,
      title: exclusionWording(f.excluded_reason),
    }),
  );
  return out;
}

/**
 * Cut `text` at every span boundary. Segments outside every span have
 * `spans: []`. Overlapping spans share segments; each segment's `spans` is
 * sorted by kind priority then by start offset.
 */
export function segmentText(text: string, spans: HighlightSpan[]): Segment[] {
  const n = text.length;
  const cuts = new Set<number>([0, n]);
  for (const s of spans) {
    if (s.end <= s.start) continue;
    cuts.add(Math.max(0, Math.min(n, s.start)));
    cuts.add(Math.max(0, Math.min(n, s.end)));
  }
  const points = [...cuts].sort((a, b) => a - b);
  const segments: Segment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i];
    const end = points[i + 1];
    if (end <= start) continue;
    const covering = spans
      .filter((s) => s.start <= start && s.end >= end && s.end > s.start)
      .sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || a.start - b.start);
    segments.push({ start, end, text: text.slice(start, end), spans: covering });
  }
  return segments;
}

/** True when the segment lies inside the selected [start, end) range. */
export function segmentInRange(
  seg: Pick<Segment, "start" | "end">,
  range: { start: number; end: number } | null,
): boolean {
  if (!range) return false;
  return seg.start >= range.start && seg.end <= range.end && range.end > range.start;
}

/**
 * Locate evidence in the text: prefer explicit offsets, else the first
 * occurrence of the quoted words (case-insensitive). Null when neither works.
 */
export function rangeForEvidence(
  text: string,
  ev: { span_start?: number; span_end?: number; note?: string },
): { start: number; end: number } | null {
  if (
    typeof ev.span_start === "number" &&
    typeof ev.span_end === "number" &&
    ev.span_end > ev.span_start &&
    ev.span_start >= 0 &&
    ev.span_end <= text.length
  ) {
    return { start: ev.span_start, end: ev.span_end };
  }
  const quote = (ev.note ?? "").trim();
  if (!quote) return null;
  const idx = text.toLowerCase().indexOf(quote.toLowerCase());
  if (idx < 0) return null;
  return { start: idx, end: idx + quote.length };
}
