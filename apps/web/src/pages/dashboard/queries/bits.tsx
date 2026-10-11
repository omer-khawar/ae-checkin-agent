/**
 * Small presentational pieces for the Queries page. Every chip carries its
 * meaning as a word, never colour alone.
 */
import { cx } from "../../../lib/format";
import { Badge } from "@/ui/badge";
import { queryStatusBadgeKind, querySeverityBadgeKind } from "@/ui/badge-kinds";
import {
  AGE_ALERT_HOURS,
  SEVERITY_HELP,
  SEVERITY_LABELS,
  STATUS_LABELS,
  evidenceKindLabel,
  formatAge,
  shortId,
} from "./model";
import type { QueryEvidence, QuerySeverity, QueryStatus } from "../../../lib/types";

export function SeverityChip({ severity }: { severity: QuerySeverity }) {
  return (
    <Badge
      kind={querySeverityBadgeKind(severity)}
      size="sm"
      label={SEVERITY_LABELS[severity] ?? severity}
      title={SEVERITY_HELP[severity]}
      data-severity={severity}
    />
  );
}

export function StatusChip({ status }: { status: QueryStatus }) {
  return (
    <Badge kind={queryStatusBadgeKind(status)} size="sm" label={STATUS_LABELS[status] ?? status} />
  );
}

/** Age in hours; red with the word "late" once an open query passes the threshold. */
export function AgeChip({ hours, alert }: { hours: number | null; alert: boolean }) {
  return (
    <span
      className={cx(
        "tabular whitespace-nowrap text-sm",
        alert ? "font-semibold text-danger-fg" : "text-muted-foreground",
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
      className="inline-block rounded bg-surface-subtle px-1.5 py-0.5 font-mono text-caption text-muted-foreground"
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
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-caption font-medium focus-visible:ring-2",
        !known && "border-warning-border bg-warning-bg text-warning-fg",
        known &&
          !active &&
          "border-border-strong bg-surface text-muted-foreground hover:bg-surface-subtle",
        known && active && "border-primary bg-surface-selected text-primary",
      )}
      data-evidence-chip={id}
    >
      <span>{label}</span>
      <span className="font-mono opacity-70">{shortId(id)}</span>
    </button>
  );
}
