/**
 * Small presentational pieces shared by the three detail columns: chips, the
 * evidence list, and a disclosure wrapper. Kept here (not in src/components)
 * because they are specific to the evidence-pointer model of this page.
 */
import type { HTMLAttributes, ReactNode } from "react";

import { Time } from "../../../lib/format";
import { Badge } from "@/ui/badge";
import { provenanceBadgeKind } from "@/ui/badge-kinds";
import { cx } from "../../../lib/format";
import type { CheckInDetail, Evidence } from "../../../lib/types";
import { evidenceKindLabel, resolveEvidence, ruleCategoryClass } from "./model";

export function Chip({
  className,
  children,
  title,
}: {
  className?: string;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex h-5 items-center whitespace-nowrap rounded-control border px-1.5 text-caption font-medium leading-none",
        className,
      )}
      title={title}
    >
      {children}
    </span>
  );
}

/**
 * The SDTM variable / domain / rule id, one step behind the plain words
 * (CLAUDE.md §00): small, monospace, never removed.
 */
export function SdtmBadge({
  children,
  title,
  className,
}: {
  children: ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-control border border-border bg-surface-subtle px-1 font-mono text-caption font-normal text-muted-foreground",
        className,
      )}
      title={title}
    >
      {children}
    </span>
  );
}

export function CategoryChip({ category }: { category: string }) {
  return <Chip className={ruleCategoryClass(category)}>{category.replace(/_/g, " ")}</Chip>;
}

const KIND_CLASS: Record<string, string> = {
  pro_response: "bg-brand-50 text-brand-900 border-brand-300",
  gate_answer: "bg-brand-50 text-brand-900 border-brand-300",
  vitals_sample: "bg-violet-50 text-violet-900 border-violet-300",
  rule: "bg-amber-50 text-amber-900 border-amber-300",
  table: "bg-slate-100 text-slate-700 border-slate-300",
  chart_note: "bg-sky-50 text-sky-900 border-sky-300",
  protocol: "bg-teal-50 text-teal-900 border-teal-300",
};

export function KindChip({ kind }: { kind: string }) {
  return (
    <Chip className={KIND_CLASS[kind] ?? "bg-slate-100 text-slate-700 border-slate-300"}>
      {evidenceKindLabel(kind)}
    </Chip>
  );
}

export interface EvidenceListProps {
  evidence: Evidence[];
  detail: CheckInDetail;
  /** Called when the user activates one pointer (to highlight it elsewhere). */
  onFocusEvidence?: (e: Evidence) => void;
  emptyText?: string;
  compact?: boolean;
}

/** The Evidence[] behind a value: kind, id, timestamp, note; each row is a button. */
export function EvidenceList({
  evidence,
  detail,
  onFocusEvidence,
  emptyText = "No evidence pointers (value is null until a human decides).",
  compact,
}: EvidenceListProps) {
  if (!evidence.length) return <p className="text-table text-subtle-foreground">{emptyText}</p>;
  return (
    <ol className={cx("space-y-1", compact ? "text-caption" : "text-table")} aria-label="Evidence">
      {evidence.map((raw, i) => {
        const e = resolveEvidence(raw, detail);
        const inner = (
          <>
            <KindChip kind={e.kind} />
            <span className="break-all font-mono text-caption text-muted-foreground">{e.id}</span>
            {e.ts && (
              <span className="text-caption text-subtle-foreground">
                <Time iso={e.ts} style="time" />
              </span>
            )}
            {e.note && <span className="w-full text-foreground">{e.note}</span>}
          </>
        );
        return (
          <li key={`${e.kind}:${e.id}:${i}`} data-testid="evidence-row">
            {onFocusEvidence ? (
              <button
                type="button"
                onClick={() => onFocusEvidence(e)}
                className="flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg border border-transparent px-1.5 py-1 text-left hover:border-border-strong hover:bg-surface-subtle"
                title="Highlight this source in the answers, vitals and rules"
              >
                {inner}
              </button>
            ) : (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-1.5 py-1">
                {inner}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** Native <details> so it is keyboard accessible with zero JS. */
export function Disclosure({
  summary,
  children,
  open,
  onToggle,
  className,
}: {
  summary: ReactNode;
  children: ReactNode;
  open?: boolean;
  onToggle?: (open: boolean) => void;
  className?: string;
}) {
  return (
    <details
      className={cx("group rounded-panel border border-border bg-surface", className)}
      open={open}
      onToggle={(ev) => onToggle?.((ev.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer select-none rounded-panel px-3 py-1.5 text-table font-medium text-foreground hover:bg-surface-subtle">
        {summary}
      </summary>
      <div className="border-t border-border px-3 py-2">{children}</div>
    </details>
  );
}

/**
 * Opaque, flat panel for the detail page (data surface: no glass). `section` with an `h2`,
 * so screen readers and tests find each block by its heading. `dense` drops the body padding.
 */
export function Panel({
  title,
  aside,
  flush,
  className,
  children,
  ...rest
}: Omit<HTMLAttributes<HTMLElement>, "title"> & {
  title?: ReactNode;
  aside?: ReactNode;
  flush?: boolean;
}) {
  return (
    <section className={cx("rounded-panel border border-border bg-surface", className)} {...rest}>
      {(title || aside) && (
        <header className="flex min-h-9 items-center justify-between gap-2 border-b border-border px-3 py-1.5">
          {title ? <h2 className="text-table font-semibold text-foreground">{title}</h2> : <span />}
          {aside}
        </header>
      )}
      <div className={flush ? "" : "p-3"}>{children}</div>
    </section>
  );
}

/** MEASURED / SIMULATED as a word beside a vital (ui Badge: icon + uppercase word + source). */
export function Prov({
  isMeasured,
  source,
  className,
}: {
  isMeasured: boolean;
  source?: string | null;
  className?: string;
}) {
  return (
    <Badge
      kind={provenanceBadgeKind(isMeasured)}
      size="sm"
      label={isMeasured ? "MEASURED" : "SIMULATED"}
      detail={source ?? undefined}
      className={className}
      data-measured={isMeasured ? "true" : "false"}
    />
  );
}
