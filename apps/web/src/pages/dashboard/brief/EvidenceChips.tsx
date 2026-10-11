/**
 * Evidence chips: one small button per evidence id a line cites.
 *
 * Clicking a chip selects that evidence id for the whole page: every section
 * line, narrative sentence and question citing the same id is highlighted, and
 * the selection bar at the top names it and (when the API sends an evidence
 * lookup) links to the source record. Clicking again clears it. The chip text is
 * plain ("Answer …X7Q2KD"); the full id is in the tooltip and, with "Show
 * technical ids" on, in the chip itself.
 */
import { cx } from "../../../lib/format";
import { evidenceKindLabel, shortId } from "./model";
import type { BriefEvidenceRef } from "../../../lib/types";

export interface EvidenceChipsProps {
  ids: readonly string[];
  selected: string | null;
  onSelect: (id: string) => void;
  evidence?: Record<string, BriefEvidenceRef>;
  showTechnical?: boolean;
  className?: string;
}

export function EvidenceChips({
  ids,
  selected,
  onSelect,
  evidence,
  showTechnical,
  className,
}: EvidenceChipsProps) {
  if (ids.length === 0) {
    return (
      <span className={cx("text-caption italic text-muted-foreground", className)}>
        no evidence cited
      </span>
    );
  }
  return (
    <span className={cx("inline-flex flex-wrap items-center gap-1", className)}>
      {ids.map((id) => {
        const ref = evidence?.[id];
        const kind = evidenceKindLabel(id, ref);
        const active = selected === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onSelect(id)}
            aria-pressed={active}
            aria-label={`Evidence: ${kind} ${id}${active ? " (selected)" : ""}`}
            title={`${kind} · ${id}${ref?.note ? ` · ${ref.note}` : ""}\nClick to highlight everything on this page that cites it.`}
            data-evidence-id={id}
            className={cx(
              "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-caption leading-4 transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              "print:border-border-strong print:bg-surface print:text-muted-foreground",
              active
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border-strong bg-surface-subtle text-muted-foreground hover:border-primary hover:bg-accent",
            )}
          >
            <span className="font-semibold">{kind}</span>
            <span className="font-mono">{showTechnical ? id : shortId(id)}</span>
          </button>
        );
      })}
    </span>
  );
}
