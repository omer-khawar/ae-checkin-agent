/**
 * Small presentational pieces for the Queries page. Every chip carries its
 * meaning as a word, never colour alone.
 */
import { cx } from "../../../lib/format";
import {
  AGE_ALERT_HOURS,
  SEVERITY_HELP,
  SEVERITY_LABELS,
  STATUS_LABELS,
  evidenceKindLabel,
  formatAge,
  shortId,
} from "./model";
import type { QueryEvidence, QuerySeverity, QueryStatus } from "./types";

export function SeverityChip({ severity }: { severity: QuerySeverity }) {
  return (
    <span
      className={cx(
        "inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-semibold",
        severity === "safety"
          ? "border-red-300 bg-red-50 text-red-800"
          : "border-sky-300 bg-sky-50 text-sky-900",
      )}
      title={SEVERITY_HELP[severity]}
      data-severity={severity}
    >
      {SEVERITY_LABELS[severity] ?? severity}
    </span>
  );
}

export function StatusChip({ status }: { status: QueryStatus }) {
  return (
    <span
      className={cx(
        "inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-semibold",
        status === "open" && "border-amber-300 bg-amber-50 text-amber-900",
        status === "answered" && "border-brand-300 bg-brand-50 text-brand-900",
        status === "closed" && "border-slate-300 bg-slate-100 text-slate-700",
      )}
    >
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

/** Age in hours; red with the word "late" once an open query passes the threshold. */
export function AgeChip({ hours, alert }: { hours: number | null; alert: boolean }) {
  return (
    <span
      className={cx(
        "tnum whitespace-nowrap text-sm",
        alert ? "font-semibold text-red-700" : "text-slate-700",
      )}
      title={
        alert
          ? `Open longer than ${AGE_ALERT_HOURS} hours`
          : `Shown in red once open longer than ${AGE_ALERT_HOURS} hours`
      }
      data-age-alert={alert ? "true" : "false"}
    >
      {formatAge(hours)}
      {alert && <span className="ml-1 text-xs uppercase">late</span>}
    </span>
  );
}

/** The SDTM name / rule id, kept one click deeper as a small monospace badge. */
export function CodeBadge({ children, title }: { children: string; title?: string }) {
  return (
    <span
      className="inline-block rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600"
      title={title}
    >
      {children}
    </span>
  );
}

export interface EvidenceChipProps {
  id: string;
  evidence: QueryEvidence | undefined;
  active: boolean;
  onSelect: (id: string) => void;
}

/**
 * One cited evidence id. Clicking highlights the matching row in the record's
 * evidence list; an id the page cannot resolve is shown in amber and says so.
 */
export function EvidenceChip({ id, evidence, active, onSelect }: EvidenceChipProps) {
  const known = evidence !== undefined;
  const label = known ? evidenceKindLabel(evidence.kind) : "Not found";
  return (
    <button
      type="button"
      onClick={() => onSelect(id)}
      aria-pressed={active}
      title={
        known ? `${label}: ${evidence.note ?? id}` : `Evidence ${id} is not in this record's list`
      }
      className={cx(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium focus-visible:ring-2",
        !known && "border-amber-300 bg-amber-50 text-amber-900",
        known && !active && "border-slate-300 bg-white text-slate-700 hover:bg-slate-100",
        known && active && "border-brand-700 bg-brand-50 text-brand-900",
      )}
      data-evidence-chip={id}
    >
      <span>{label}</span>
      <span className="font-mono opacity-70">{shortId(id)}</span>
    </button>
  );
}
