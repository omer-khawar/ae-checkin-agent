/**
 * Small presentational pieces shared by the three detail columns: chips, the
 * evidence list, and a disclosure wrapper. Kept here (not in src/components)
 * because they are specific to the evidence-pointer model of this page.
 */
import type { ReactNode } from "react";

import { Time } from "../../../lib/format";
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
        "inline-flex items-center whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[11px] font-semibold",
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
  if (!evidence.length) return <p className="text-sm text-slate-500">{emptyText}</p>;
  return (
    <ol className={cx("space-y-1", compact ? "text-xs" : "text-sm")} aria-label="Evidence">
      {evidence.map((raw, i) => {
        const e = resolveEvidence(raw, detail);
        const inner = (
          <>
            <KindChip kind={e.kind} />
            <span className="break-all font-mono text-[11px] text-slate-600">{e.id}</span>
            {e.ts && (
              <span className="text-[11px] text-slate-500">
                <Time iso={e.ts} style="time" />
              </span>
            )}
            {e.note && <span className="w-full text-slate-800">{e.note}</span>}
          </>
        );
        return (
          <li key={`${e.kind}:${e.id}:${i}`} data-testid="evidence-row">
            {onFocusEvidence ? (
              <button
                type="button"
                onClick={() => onFocusEvidence(e)}
                className="flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg border border-transparent px-1.5 py-1 text-left hover:border-slate-300 hover:bg-slate-50"
                title="Highlight this evidence in the other columns"
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
      className={cx("group rounded-xl border border-slate-200 bg-white", className)}
      open={open}
      onToggle={(ev) => onToggle?.((ev.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer select-none rounded-xl px-3 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50">
        {summary}
      </summary>
      <div className="border-t border-slate-200 px-3 py-2">{children}</div>
    </details>
  );
}
