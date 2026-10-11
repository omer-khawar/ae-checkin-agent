/**
 * The note text with scanner spans painted on it.
 *
 * - Symptoms (amber), medications (sky), red flags (red underline) and excluded
 *   mentions (muted, struck through) each get a distinct style; the exclusion
 *   reason is in the tooltip.
 * - `selectedRange` outlines the words a clicked draft field or table row
 *   points at, so "every field points at its evidence" is visible, not implied.
 * - Overlapping spans are handled by `segmentText`; the tooltip lists every
 *   finding covering the segment.
 */
import { useMemo } from "react";

import { cx } from "../../../lib/format";
import { segmentInRange, segmentText, spansFromScan, type SpanKind } from "./highlight";
import type { ScanResult } from "../../../lib/types";

export interface HighlightedNoteProps {
  text: string;
  scan: ScanResult | null;
  selectedRange?: { start: number; end: number } | null;
  /** Click on a highlighted segment selects its range (optional). */
  onSelectRange?: (range: { start: number; end: number } | null) => void;
  /** Show the colour legend above the text (default true). */
  legend?: boolean;
  className?: string;
}

const KIND_CLASS: Record<SpanKind, string> = {
  red_flag:
    "bg-red-100 text-danger-fg underline decoration-red-500 decoration-2 underline-offset-2",
  symptom: "bg-warning-bg text-warning-fg",
  med: "bg-sky-100 text-sky-900",
  excluded: "bg-surface-subtle text-muted-foreground line-through decoration-slate-400",
  gemini:
    "bg-violet-100 text-violet-900 underline decoration-violet-500 decoration-dotted decoration-2 underline-offset-2",
};

/** Small mark after a segment that both the scanner and Gemini found. */
function GeminiMark() {
  return (
    <sup
      className="ml-0.5 rounded bg-violet-100 px-1 text-[10px] font-semibold text-violet-900"
      data-testid="gemini-mark"
      title="Also found by Gemini · quote checked"
    >
      G
    </sup>
  );
}

const LEGEND: Array<{ kind: SpanKind; label: string; hint: string }> = [
  { kind: "symptom", label: "Symptom", hint: "CTCAE term matched; drafted as an AE" },
  { kind: "med", label: "Medication", hint: "Lexicon drug matched; drafted as a CM row" },
  {
    kind: "red_flag",
    label: "Red flag",
    hint: "Urgent / emergency pattern; raises the escalation",
  },
  {
    kind: "gemini",
    label: "Found by Gemini · quote checked",
    hint: "Second reader; its exact words were found in the note",
  },
  {
    kind: "excluded",
    label: "Excluded",
    hint: "Negated, historical, hypothetical, resolved, allergy or indication; not drafted",
  },
];

export function HighlightLegend({ className }: { className?: string }) {
  return (
    <ul className={cx("flex flex-wrap gap-2 text-xs", className)} aria-label="Highlight legend">
      {LEGEND.map((l) => (
        <li key={l.kind} className="flex items-center gap-1">
          <span className={cx("rounded px-1.5 py-0.5 font-medium", KIND_CLASS[l.kind])}>
            {l.label}
          </span>
          <span className="text-muted-foreground">{l.hint}</span>
        </li>
      ))}
    </ul>
  );
}

export function HighlightedNote({
  text,
  scan,
  selectedRange = null,
  onSelectRange,
  legend = true,
  className,
}: HighlightedNoteProps) {
  const segments = useMemo(() => {
    const spans = scan ? spansFromScan(scan, text.length) : [];
    return segmentText(text, spans);
  }, [text, scan]);

  if (!text.trim()) {
    return <p className={cx("text-sm text-muted-foreground", className)}>No note text.</p>;
  }

  return (
    <div className={className}>
      {legend && scan && <HighlightLegend className="mb-3" />}
      <p
        className="whitespace-pre-wrap text-title leading-7 text-foreground"
        data-testid="highlighted-note"
      >
        {segments.map((seg) => {
          const selected = segmentInRange(seg, selectedRange);
          if (seg.spans.length === 0) {
            return (
              <span
                key={seg.start}
                className={cx(selected && "rounded bg-surface-selected ring-2 ring-brand-700")}
                data-selected={selected || undefined}
              >
                {seg.text}
              </span>
            );
          }
          const top = seg.spans[0];
          const both = seg.spans.some((x) => x.foundBy === "both") && seg.end === top.end;
          const title = seg.spans
            .map((s) => (s.title ? `${s.label}: ${s.title}` : s.label))
            .join("\n");
          const cls = cx(
            "rounded-sm px-0.5",
            KIND_CLASS[top.kind],
            selected && "ring-2 ring-brand-700 ring-offset-1",
            onSelectRange && "cursor-pointer focus-visible:ring-4",
          );
          const common = {
            title,
            "data-kind": top.kind,
            "data-span-ids": seg.spans.map((s) => s.id).join(" "),
            "data-selected": selected || undefined,
            "aria-label": title,
          };
          // A clickable segment is a real <button> so keyboard users can reach it.
          if (onSelectRange) {
            return (
              <button
                key={seg.start}
                type="button"
                className={cx(cls, "inline border-0 bg-transparent p-0 font-inherit")}
                onClick={() => onSelectRange({ start: top.start, end: top.end })}
                aria-pressed={selected}
                {...common}
              >
                <mark className={cx("bg-transparent", KIND_CLASS[top.kind])}>{seg.text}</mark>
                {both && <GeminiMark />}
              </button>
            );
          }
          return (
            <span key={seg.start}>
              <mark className={cls} {...common}>
                {seg.text}
              </mark>
              {both && <GeminiMark />}
            </span>
          );
        })}
      </p>
    </div>
  );
}
