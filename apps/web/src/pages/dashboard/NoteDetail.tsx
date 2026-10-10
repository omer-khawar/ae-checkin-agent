/**
 * /dashboard/notes/:noteId — one ingested chart note (CONTRACTS.md R2.4).
 *
 * Left: the note text with highlighted spans and the scanner tables.
 * Middle: AE / CM drafts; clicking a field lists its evidence and outlines the
 *         quoted words in the note (same field → evidence pattern as the
 *         check-in detail page). Confirm / Reject go through the shared
 *         `/drafts/{id}` endpoints so the audit trail is identical.
 * Right: the Why panel (every rule fired, plain English, inputs).
 */
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { Card } from "../../components/Card";
import { ErrorBanner } from "../../components/ErrorBanner";
import { TierChip } from "../../components/TierChip";
import { useToast } from "../../components/Toast";
import { confirmDraft, describeError, rejectDraft } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { Time } from "../../lib/format";
import { getNote } from "./notes/apiNotes";
import { DraftsPanel } from "./notes/DraftsPanel";
import { HighlightedNote } from "./notes/HighlightedNote";
import { normalizeDraft } from "./notes/normalize";
import { Outcome } from "./notes/Outcome";
import { ScanTables } from "./notes/ScanTables";
import type { NoteDetailResponse, NoteDraft } from "./notes/types";
import { WhyPanel } from "./notes/WhyPanel";

type Range = { start: number; end: number };

export function NoteDetail() {
  const { noteId = "" } = useParams<{ noteId: string }>();
  const toast = useToast();
  const { hasRole } = useAuth();
  const canReview = hasRole("coordinator", "investigator", "admin");

  const [data, setData] = useState<NoteDetailResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [selectedRange, setSelectedRange] = useState<Range | null>(null);
  const [busyDraftId, setBusyDraftId] = useState<string | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getNote(noteId)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [noteId]);

  useEffect(() => load(), [load]);

  /** Swap one draft in place after a confirm/reject (the API returns the new row). */
  const replaceDraft = (updated: NoteDraft) =>
    setData((d) =>
      d
        ? {
            ...d,
            drafts: d.drafts.map((x) =>
              x.id === updated.id || x.id === updated.supersedes_id ? updated : x,
            ),
          }
        : d,
    );

  const onConfirm = async (draft: NoteDraft) => {
    setBusyDraftId(draft.id);
    try {
      const res = await confirmDraft(draft.id);
      replaceDraft({ ...draft, ...normalizeDraft(res) });
      toast.push({ kind: "success", title: `${draft.domain} draft confirmed` });
    } catch (e) {
      toast.push({ kind: "error", title: "Confirm failed", message: describeError(e) });
    } finally {
      setBusyDraftId(null);
    }
  };

  const onReject = async (draft: NoteDraft, reason: string) => {
    setBusyDraftId(draft.id);
    try {
      const res = await rejectDraft(draft.id, reason);
      replaceDraft({ ...draft, ...normalizeDraft(res) });
      toast.push({ kind: "info", title: `${draft.domain} draft rejected` });
    } catch (e) {
      toast.push({ kind: "error", title: "Reject failed", message: describeError(e) });
    } finally {
      setBusyDraftId(null);
    }
  };

  const backLink = (
    <Link to="/dashboard/notes" className="text-sm text-brand-700 underline">
      ← All chart notes
    </Link>
  );

  if (loading && !data) {
    return (
      <div className="space-y-4">
        {backLink}
        <p className="text-sm text-slate-500">Loading note…</p>
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="space-y-4">
        {backLink}
        <ErrorBanner
          error={error ?? "Note not found"}
          message="Could not load this note"
          onRetry={load}
        />
      </div>
    );
  }

  const { note, scan, drafts, escalation, sae_clock, rules_fired, why } = data;
  const label = note.display_label ?? note.usubjid;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          {backLink}
          <h1 className="mt-1 text-2xl font-bold text-slate-900">
            Chart note <span className="font-normal text-slate-600">for</span>{" "}
            <Link
              to={`/dashboard/participants/${encodeURIComponent(note.usubjid)}`}
              className="text-brand-700 underline"
              title={note.usubjid}
            >
              {label}
            </Link>
          </h1>
          <dl className="mt-1 flex flex-wrap gap-x-5 gap-y-1 text-sm text-slate-700">
            <div>
              <dt className="inline text-slate-500">Note date </dt>
              <dd className="tnum inline">{note.note_date || "—"}</dd>
            </div>
            <div>
              <dt className="inline text-slate-500">Author </dt>
              <dd className="inline">{note.author || "—"}</dd>
            </div>
            <div>
              <dt className="inline text-slate-500">Type </dt>
              <dd className="inline">{note.note_type || "—"}</dd>
            </div>
            <div>
              <dt className="inline text-slate-500">Ingested </dt>
              <dd className="inline">
                <Time iso={note.ingested_at} />
                {note.ingested_by ? ` by ${note.ingested_by}` : ""}
              </dd>
            </div>
            <div>
              <dt className="inline text-slate-500">Id </dt>
              <dd className="inline font-mono text-xs">{note.id}</dd>
            </div>
          </dl>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-violet-300 bg-violet-100 px-2.5 py-0.5 text-xs font-semibold text-violet-800">
            Synthetic note
          </span>
          {escalation ? (
            <TierChip tier={escalation.tier} />
          ) : typeof note.tier === "number" ? (
            <TierChip tier={note.tier} />
          ) : null}
        </div>
      </div>

      {(escalation || sae_clock) && (
        <Card>
          <Outcome
            noteId={note.id}
            drafts={drafts}
            escalation={escalation}
            saeClock={sae_clock}
            showDetailLink={false}
          />
        </Card>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)_minmax(0,0.85fr)]">
        <div className="space-y-4">
          <Card title="Note text">
            <HighlightedNote
              text={note.text}
              scan={scan}
              selectedRange={selectedRange}
              onSelectRange={setSelectedRange}
            />
          </Card>
          <Card title="Scanner findings" flush>
            <ScanTables
              scan={scan}
              selectedRange={selectedRange}
              onSelectRange={setSelectedRange}
            />
          </Card>
        </div>

        <Card
          title="Drafts"
          aside={
            <span className="tnum text-xs text-slate-600">
              {drafts.length} record{drafts.length === 1 ? "" : "s"}
            </span>
          }
        >
          <DraftsPanel
            drafts={drafts}
            noteText={note.text}
            onSelectRange={setSelectedRange}
            onConfirm={canReview ? onConfirm : undefined}
            onReject={canReview ? onReject : undefined}
            busyDraftId={busyDraftId}
          />
        </Card>

        <Card title="Why">
          <WhyPanel why={why} rulesFired={rules_fired} />
        </Card>
      </div>
    </div>
  );
}
