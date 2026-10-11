/**
 * Evidence chips and the inspector card they open.
 *
 * Every pre-filled value and every narrative sentence on the packet page shows
 * small chips, one per evidence pointer. Activating a chip (click, Enter or
 * Space; it is a real <button>) shows that pointer in the inspector: what kind
 * of source it is, its id, the verbatim words, the time, and a link to the
 * source record when the pointer says where it lives. This is the "explains
 * itself" requirement: nothing on the page is a bare claim.
 */
import { Link } from "react-router-dom";

import { Panel as Card } from "./Panel";
import { Badge } from "@/ui/badge";
import { provenanceBadgeKind } from "@/ui/badge-kinds";
import { cx, Time } from "../../../lib/format";
import { evidenceKindLabel, evidenceLink, evidenceQuote } from "./model";
import type { PacketEvidence } from "../../../lib/types";

/** What the inspector shows: the pointer (or just an id that did not resolve) and where it was clicked. */
export interface EvidenceSelection {
  /** Unique key of the clicked chip, so the active chip can be outlined. */
  key: string;
  id: string;
  evidence: PacketEvidence | null;
  /** Plain words for what the evidence supports, e.g. "Started on" or "Narrative sentence 2". */
  context: string;
}

const KIND_CLASS: Record<string, string> = {
  pro_response: "bg-accent text-accent-foreground border-border-strong",
  gate_answer: "bg-accent text-accent-foreground border-border-strong",
  vitals_sample: "bg-simulated-bg text-simulated-fg border-simulated-border",
  rule: "bg-warning-bg text-warning-fg border-warning-border",
  table: "bg-surface-subtle text-foreground border-border-strong",
  chart_note: "bg-info-bg text-info-fg border-info-border",
  phone_call: "bg-info-bg text-info-fg border-info-border",
};

function kindClass(kind: string | null | undefined): string {
  return (kind && KIND_CLASS[kind]) || "bg-surface-subtle text-foreground border-border-strong";
}

export interface EvidenceChipsProps {
  /** Pointers to show; an entry may be a resolved pointer or a bare id. */
  items: Array<{ id: string; evidence: PacketEvidence | null }>;
  /** Prefix for chip keys, unique per row / sentence. */
  keyPrefix: string;
  context: string;
  selectedKey: string | null;
  onSelect: (s: EvidenceSelection) => void;
  emptyText?: string;
}

/** A row of evidence chips. Each chip is a button that opens the inspector. */
export function EvidenceChips({
  items,
  keyPrefix,
  context,
  selectedKey,
  onSelect,
  emptyText = "No evidence",
}: EvidenceChipsProps) {
  if (!items.length) {
    return <span className="text-caption italic text-muted-foreground">{emptyText}</span>;
  }
  return (
    <span className="inline-flex flex-wrap gap-1">
      {items.map((it, i) => {
        const key = `${keyPrefix}:${i}:${it.id}`;
        const active = key === selectedKey;
        const label = it.evidence ? evidenceKindLabel(it.evidence.kind) : "Evidence";
        return (
          <button
            key={key}
            type="button"
            onClick={() => onSelect({ key, id: it.id, evidence: it.evidence, context })}
            aria-pressed={active}
            aria-label={`Show evidence: ${label} ${it.id}`}
            title={`${label} · ${it.id}`}
            data-evidence-id={it.id}
            className={cx(
              "inline-flex items-center gap-1 whitespace-nowrap rounded-control border px-1.5 py-0.5 text-caption font-semibold",
              "hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600",
              kindClass(it.evidence?.kind),
              active && "ring-2 ring-brand-700",
            )}
          >
            <span>{label}</span>
            {it.evidence?.kind === "vitals_sample" && (
              <span className="font-bold uppercase">
                ·{" "}
                {typeof it.evidence.is_measured === "boolean"
                  ? it.evidence.is_measured
                    ? "MEASURED"
                    : "SIMULATED"
                  : "MEASURED / SIMULATED: not stated"}
              </span>
            )}
          </button>
        );
      })}
    </span>
  );
}

/** The card that shows one evidence pointer in full. */
export function EvidenceInspector({
  selection,
  onClear,
}: {
  selection: EvidenceSelection | null;
  onClear: () => void;
}) {
  return (
    <Card
      title="Evidence"
      aside={
        selection ? (
          <button
            type="button"
            onClick={onClear}
            className="rounded px-2 py-0.5 text-body text-muted-foreground hover:bg-surface-subtle focus-visible:ring-2 focus-visible:ring-brand-600"
          >
            Clear
          </button>
        ) : undefined
      }
    >
      <div aria-live="polite" data-testid="evidence-inspector">
        {!selection ? (
          <p className="text-body text-muted-foreground">
            Click any evidence chip next to a value or a sentence to see exactly where it came from.
          </p>
        ) : (
          <EvidenceDetails selection={selection} />
        )}
      </div>
    </Card>
  );
}

function EvidenceDetails({ selection }: { selection: EvidenceSelection }) {
  const e = selection.evidence;
  if (!e) {
    return (
      <div className="space-y-2 text-body">
        <p className="text-muted-foreground">Supports: {selection.context}</p>
        <p>
          Evidence id <code className="font-mono text-caption">{selection.id}</code>
        </p>
        <p className="text-muted-foreground">
          This packet does not include the details for this id. It can be looked up in the audit
          trail.
        </p>
      </div>
    );
  }
  const quote = evidenceQuote(e);
  const link = evidenceLink(e);
  const isVitals = e.kind === "vitals_sample";
  return (
    <dl className="space-y-2 text-body">
      <div>
        <dt className="text-caption font-semibold uppercase tracking-wide text-muted-foreground">
          Supports
        </dt>
        <dd>{selection.context}</dd>
      </div>
      <div>
        <dt className="text-caption font-semibold uppercase tracking-wide text-muted-foreground">
          Source
        </dt>
        <dd className="flex flex-wrap items-center gap-2">
          <span
            className={cx(
              "rounded-control border px-1.5 py-0.5 text-caption font-semibold",
              kindClass(e.kind),
            )}
          >
            {evidenceKindLabel(e.kind)}
          </span>
          {isVitals &&
            (typeof e.is_measured === "boolean" ? (
              <Badge
                kind={provenanceBadgeKind(e.is_measured)}
                size="sm"
                label={e.is_measured ? "MEASURED" : "SIMULATED"}
              />
            ) : (
              <span className="text-caption font-semibold uppercase text-foreground">
                MEASURED / SIMULATED: not stated
              </span>
            ))}
        </dd>
      </div>
      {quote && (
        <div>
          <dt className="text-caption font-semibold uppercase tracking-wide text-muted-foreground">
            Exact words
          </dt>
          <dd>
            <blockquote className="border-l-4 border-sky-300 bg-sky-50 px-3 py-1.5 italic text-foreground">
              “{quote}”
            </blockquote>
          </dd>
        </div>
      )}
      {e.note && e.note !== quote && (
        <div>
          <dt className="text-caption font-semibold uppercase tracking-wide text-muted-foreground">
            Note
          </dt>
          <dd className="text-foreground">{e.note}</dd>
        </div>
      )}
      <div>
        <dt className="text-caption font-semibold uppercase tracking-wide text-muted-foreground">
          Recorded
        </dt>
        <dd>
          <Time iso={e.ts} fallback="Time not recorded" />
        </dd>
      </div>
      <div>
        <dt className="text-caption font-semibold uppercase tracking-wide text-muted-foreground">
          Evidence id
        </dt>
        <dd>
          <code className="break-all font-mono text-caption text-foreground">{e.id || "—"}</code>
        </dd>
      </div>
      {link && (
        <div>
          <Link
            to={link}
            className="text-body font-semibold text-primary underline underline-offset-2 hover:text-primary-strong"
          >
            Open the source record
          </Link>
        </div>
      )}
    </dl>
  );
}
