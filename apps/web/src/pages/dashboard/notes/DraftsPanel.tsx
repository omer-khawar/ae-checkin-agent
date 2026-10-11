/**
 * Chart-note drafts (AE / CM, SDTM-shaped) with the field → evidence pattern:
 * every field is a button; the selected field lists its `Evidence[]` and tells
 * the parent which words of the note to outline. Optional Confirm / Reject
 * actions call back into the page (which owns the API call and the toast).
 *
 * Plain language first (CLAUDE.md §00, R3.3): each field leads with its plain
 * label ("Severity grade (provisional)") and keeps the SDTM variable in a small
 * monospace line beneath; protocol flags (possible AESI, prohibited /
 * discouraged medication, missing medication-form fields) sit above the fields.
 */
import { useState } from "react";

import { Button } from "../../../components/Button";
import { cx, Time } from "../../../lib/format";
import {
  AESI_BANNER,
  cmMissingText,
  evidenceKindName,
  fieldLabel,
  flagForDraft,
  gradeWord,
  plainDraftTitle,
  plainValue,
  protocolChip,
  sdtmBadge,
  type Labels,
} from "../detail/plain";
import { rangeForEvidence } from "./highlight";
import type { Evidence, NoteDraft, ProtocolAssessment } from "../../../lib/types";

type Range = { start: number; end: number };

export interface DraftsPanelProps {
  drafts: NoteDraft[];
  noteText: string;
  onSelectRange?: (range: Range | null) => void;
  /** When provided, Confirm / Reject buttons appear on draft-status rows. */
  onConfirm?: (draft: NoteDraft) => Promise<void> | void;
  onReject?: (draft: NoteDraft, reason: string) => Promise<void> | void;
  /** Id of a draft currently being confirmed/rejected (disables its buttons). */
  busyDraftId?: string | null;
  /** R3.2 plain labels from the API (local table otherwise). */
  labels?: Labels;
  /** R3.1 protocol assessment, when the API sends one for the note. */
  protocol?: ProtocolAssessment | null;
}

const STATUS_CLASS: Record<string, string> = {
  draft: "bg-amber-100 text-amber-900 border-amber-300",
  confirmed: "bg-green-100 text-green-800 border-green-300",
  rejected: "bg-slate-200 text-slate-700 border-slate-300",
  superseded: "bg-slate-100 text-slate-500 border-slate-200",
};

/** The SDTM columns to show first; everything else follows alphabetically. */
const FIELD_ORDER = [
  "STUDYID",
  "USUBJID",
  "AESEQ",
  "AETERM",
  "AEDECOD",
  "AESTDTC",
  "AEENDTC",
  "AEONGO",
  "AETOXGR",
  "AESER",
  "AEREL",
  "CMTRT",
  "CMDECOD",
  "CMSTDTC",
  "CMENDTC",
  "CMSTAT",
  "INTERIM_SOURCE",
  "INTERIM_TIER",
  "INTERIM_DIRECTION",
  "INTERIM_RULES_FIRED",
  "INTERIM_MATCH_CONFIDENCE",
  "INTERIM_NCT_ID",
];

function orderedFields(fields: Record<string, unknown>): Array<[string, unknown]> {
  const rank = (k: string) => {
    const i = FIELD_ORDER.indexOf(k);
    return i === -1 ? FIELD_ORDER.length : i;
  };
  return Object.entries(fields).sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
}

function valueText(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (Array.isArray(v)) return v.length ? v.map(String).join(", ") : "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function EvidenceList({ items }: { items: Evidence[] }) {
  if (items.length === 0) {
    return <p className="text-xs text-slate-500">No evidence recorded for this field.</p>;
  }
  return (
    <ul className="space-y-1.5" data-testid="evidence-list">
      {items.map((e, i) => (
        <li key={`${e.kind}-${e.id}-${i}`} className="text-xs text-slate-700">
          <span
            className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-700"
            title={e.kind}
          >
            {evidenceKindName(e.kind)}
          </span>{" "}
          <span className="font-mono text-[11px] text-slate-500">{e.id}</span>
          {e.ts && (
            <>
              {" · "}
              <Time iso={e.ts} style="short" />
            </>
          )}
          {e.note && <div className="mt-0.5 text-slate-800">{e.note}</div>}
          {typeof e.span_start === "number" && typeof e.span_end === "number" && (
            <div className="text-[11px] text-slate-500">
              chars {e.span_start}–{e.span_end}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function DraftCard({
  draft,
  noteText,
  onSelectRange,
  onConfirm,
  onReject,
  busy,
  labels,
  protocol,
}: {
  draft: NoteDraft;
  noteText: string;
  labels?: Labels;
  protocol?: ProtocolAssessment | null;
  onSelectRange?: (range: Range | null) => void;
  onConfirm?: DraftsPanelProps["onConfirm"];
  onReject?: DraftsPanelProps["onReject"];
  busy: boolean;
}) {
  const [selectedField, setSelectedField] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  const select = (name: string) => {
    const next = selectedField === name ? null : name;
    setSelectedField(next);
    if (!onSelectRange) return;
    if (!next) {
      onSelectRange(null);
      return;
    }
    // First evidence item that can be located in the note wins.
    const ev = draft.evidence[next] ?? [];
    for (const e of ev) {
      const r = rangeForEvidence(noteText, e);
      if (r) {
        onSelectRange(r);
        return;
      }
    }
    onSelectRange(null);
  };

  const fields = orderedFields(draft.fields);
  const flag = draft.domain === "CM" ? flagForDraft(draft.fields, protocol) : null;
  const canAct = draft.status === "draft" && (onConfirm || onReject);

  return (
    <article
      className="rounded-xl border border-slate-200 bg-white"
      aria-label={`${draft.domain} draft ${draft.id}`}
      data-testid={`draft-${draft.domain}`}
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-slate-900">
            {plainDraftTitle(draft.domain, draft.fields)}
          </span>
          <span
            className="rounded border border-slate-200 bg-slate-50 px-1 font-mono text-[10px] text-slate-600"
            title="SDTM domain"
          >
            {sdtmBadge(draft.domain, draft.fields)}
          </span>
          <span
            className={cx(
              "rounded-full border px-2 py-0.5 text-xs font-semibold",
              STATUS_CLASS[draft.status] ?? STATUS_CLASS.draft,
            )}
          >
            {draft.status}
          </span>
          <span className="text-xs text-slate-500">v{draft.version}</span>
          {draft.is_followup && (
            <span
              className="rounded-full border border-brand-300 bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-900"
              title={
                draft.linked_ae_open_id
                  ? `Linked to open AE ${draft.linked_ae_open_id} (same term within the dedup window)`
                  : "Linked to an existing open AE"
              }
            >
              Follow-up of a side effect already on record
            </span>
          )}
        </div>
        <span className="font-mono text-[11px] text-slate-500">{draft.id}</span>
      </header>

      {/*
        Valid <dl> structure: each row is a <div> whose direct children are the
        <dt> (field name) and <dd> (value + evidence). The buttons live INSIDE
        dt/dd, mirroring the check-in detail page (detail/DraftsColumn.tsx),
        so the name/value pairing survives for assistive technology. The dt
        button carries the full accessible label; the dd button is a second
        click target for the value, out of the tab order so each field is one
        tab stop.
      */}
      <ProtocolNotes draft={draft} protocol={protocol} />

      <dl className="divide-y divide-slate-100">
        {fields.map(([name, value]) => {
          const ev = draft.evidence[name] ?? [];
          const sel = selectedField === name;
          const plain = fieldLabel(name, labels);
          const chip = name === "INTERIM_PROTOCOL_FLAG" ? protocolChip(value, flag) : null;
          const word = name === "AETOXGR" ? gradeWord(value) : null;
          const shown =
            name === "AETOXGR" && typeof value === "number"
              ? `Grade ${value}${word ? ` · ${word}` : ""}`
              : chip
                ? chip.text
                : (plainValue(name, value, labels) ?? valueText(value));
          return (
            <div
              key={name}
              data-field={name}
              data-selected={sel ? "true" : "false"}
              className={cx("flex flex-wrap items-start gap-x-3 px-3 py-1.5", sel && "bg-brand-50")}
            >
              <dt className="w-44 shrink-0">
                <button
                  type="button"
                  onClick={() => select(name)}
                  aria-pressed={sel}
                  aria-label={`${plain} (${name}): ${shown}. Show evidence`}
                  title={`Show evidence for ${plain} (${name})`}
                  className="w-full rounded text-left hover:text-brand-800 hover:underline focus-visible:ring-4"
                >
                  <span className="block text-xs font-medium text-slate-800">{plain}</span>
                  <span className="font-mono text-[10px] text-slate-500">{name}</span>
                  <span className="tnum ml-1 rounded bg-slate-100 px-1 text-[10px] text-slate-600">
                    {ev.length} ev
                  </span>
                </button>
              </dt>
              <dd className="min-w-0 flex-1">
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => select(name)}
                  aria-label={`Value of ${plain} (${name}): ${shown}. Show evidence`}
                  className="w-full break-words rounded text-left text-sm text-slate-900 hover:bg-slate-50"
                >
                  {chip ? (
                    <span
                      className={cx(
                        "inline-flex rounded-md border px-1.5 py-0.5 text-xs font-semibold",
                        chip.className,
                      )}
                      title={chip.title}
                    >
                      {chip.text}
                    </span>
                  ) : (
                    shown
                  )}
                  {name === "AETOXGR" && value !== null && value !== undefined && value !== "" && (
                    <span className="ml-1 text-xs text-slate-500">
                      (provisional, investigator to confirm)
                    </span>
                  )}
                </button>
                {sel && (
                  <div className="mt-1 border-t border-brand-100 bg-brand-50/50 px-2 py-2">
                    <EvidenceList items={ev} />
                  </div>
                )}
              </dd>
            </div>
          );
        })}
      </dl>

      {canAct && (
        <footer className="flex flex-wrap items-center gap-2 border-t border-slate-200 px-3 py-2">
          {onConfirm && (
            <Button size="sm" onClick={() => void onConfirm(draft)} busy={busy} disabled={busy}>
              Confirm
            </Button>
          )}
          {onReject && !rejecting && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setRejecting(true)}
              disabled={busy}
            >
              Reject…
            </Button>
          )}
          {onReject && rejecting && (
            <form
              className="flex flex-1 flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!reason.trim()) return;
                void onReject(draft, reason.trim());
                setRejecting(false);
              }}
            >
              <label className="sr-only" htmlFor={`reject-${draft.id}`}>
                Reason for rejecting
              </label>
              <input
                id={`reject-${draft.id}`}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Reason (required)"
                className="min-w-[12rem] flex-1 rounded-lg border border-slate-300 px-2 py-1 text-sm"
              />
              <Button size="sm" variant="danger" type="submit" disabled={!reason.trim() || busy}>
                Reject
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setRejecting(false)}>
                Cancel
              </Button>
            </form>
          )}
        </footer>
      )}
    </article>
  );
}

export function DraftsPanel({
  drafts,
  noteText,
  onSelectRange,
  onConfirm,
  onReject,
  busyDraftId,
  labels,
  protocol,
}: DraftsPanelProps) {
  if (drafts.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        No drafts were created from this note (nothing non-excluded was found).
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-600">
        Click a field to see the evidence it points at; the quoted words are outlined in the note.
        Drafts stay drafts until a coordinator confirms them.
      </p>
      {drafts.map((d) => (
        <DraftCard
          key={d.id}
          draft={d}
          noteText={noteText}
          onSelectRange={onSelectRange}
          onConfirm={onConfirm}
          onReject={onReject}
          busy={busyDraftId === d.id}
          labels={labels}
          protocol={protocol}
        />
      ))}
    </div>
  );
}

/**
 * What the study protocol says about a note's draft (R3.1), in plain words:
 * the possible-AESI banner on an AE, the prohibited / discouraged chip (with
 * the protocol's exception text on hover) and the missing medication-form
 * fields on a CM.
 */
function ProtocolNotes({
  draft,
  protocol,
}: {
  draft: NoteDraft;
  protocol?: ProtocolAssessment | null;
}) {
  if (draft.domain === "AE") {
    if (draft.fields.INTERIM_AESI_SUSPECTED !== true) return null;
    return (
      <p
        className="border-b border-red-100 bg-red-50 px-3 py-2 text-sm font-medium text-red-900"
        data-testid="aesi-banner"
      >
        {AESI_BANNER}
      </p>
    );
  }
  if (draft.domain !== "CM") return null;
  const flag = flagForDraft(draft.fields, protocol);
  const chip = protocolChip(draft.fields.INTERIM_PROTOCOL_FLAG ?? flag?.level, flag);
  const missing = cmMissingText(draft.fields.INTERIM_CM_MISSING_FIELDS);
  if (!chip && !missing) return null;
  return (
    <div
      className="space-y-1 border-b border-slate-100 bg-slate-50 px-3 py-2"
      data-testid="cm-protocol"
    >
      {chip && (
        <span
          className={cx(
            "inline-flex rounded-md border px-1.5 py-0.5 text-xs font-semibold",
            chip.className,
          )}
          title={chip.title}
          tabIndex={chip.title ? 0 : undefined}
          data-testid="protocol-chip"
        >
          {chip.text}
        </span>
      )}
      {missing && (
        <p className="text-xs text-slate-800" data-testid="cm-missing">
          {missing}
        </p>
      )}
    </div>
  );
}
