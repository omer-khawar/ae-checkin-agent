/**
 * /dashboard/notes/:noteId — one ingested chart note (CONTRACTS.md R2.4).
 *
 * Left: the note text with highlighted spans and the scanner tables.
 * Middle: AE / CM drafts; clicking a field lists its evidence and outlines the
 *         quoted words in the note (same field → evidence pattern as the
 *         check-in detail page). Confirm / Reject go through the shared
 *         `/drafts/{id}` endpoints so the audit trail is identical.
 * Right: the Why panel (every rule fired, plain English, inputs).
 *
 * R3/R4 additions: phone calls (note_type "phone_call", R4.1) are labeled with
 * a phone icon and "Phone call" plus who called; draft fields lead with plain
 * labels (SDTM names one click deeper); a 24-hour report clock offers "Open
 * report packet" and, for the investigator when the note drafted no side
 * effect, "Record seriousness decision" (R4.3).
 */
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { Card } from "../../components/Card";
import { ErrorBanner } from "../../components/ErrorBanner";
import { confirmDraft, describeError, getNote, rejectDraft } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { Time } from "../../lib/format";
import { ClockActions } from "./detail/ClockActions";
import { DraftsPanel } from "./notes/DraftsPanel";
import { HighlightedNote } from "./notes/HighlightedNote";
import { normalizeDraft } from "./notes/normalize";
import { Outcome } from "./notes/Outcome";
import { NoteTypeLabel } from "./notes/PhoneCall";
import { callSummary, isPhoneCall } from "./notes/phoneCallLabels";
import { ScanTables } from "./notes/ScanTables";
import { WhyPanel } from "./notes/WhyPanel";
import type { NoteDetailResponse, NoteDraft } from "../../lib/types";
import { Badge } from "@/ui/badge";
import { tierBadgeKind } from "@/ui/badge-kinds";
import { notify } from "@/ui/toast";

type Range = { start: number; end: number };

export function NoteDetail() {
  const { noteId = "" } = useParams<{ noteId: string }>();
  const { hasRole, role } = useAuth();
  // Admin is non-clinical: only the coordinator and the investigator review drafts.
  const canReview = hasRole("coordinator", "investigator");

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
      notify.success(`${draft.domain} draft confirmed`);
    } catch (e) {
      notify.danger("Confirm failed", { description: describeError(e) });
    } finally {
      setBusyDraftId(null);
    }
  };

  const onReject = async (draft: NoteDraft, reason: string) => {
    setBusyDraftId(draft.id);
    try {
      const res = await rejectDraft(draft.id, reason);
      replaceDraft({ ...draft, ...normalizeDraft(res) });
      notify.info(`${draft.domain} draft rejected`);
    } catch (e) {
      notify.danger("Reject failed", { description: describeError(e) });
    } finally {
      setBusyDraftId(null);
    }
  };

  const backLink = (
    <Link to="/dashboard/notes" className="text-sm text-primary underline">
      ← All chart notes
    </Link>
  );

  if (loading && !data) {
    return (
      <div className="space-y-4">
        {backLink}
        <p className="text-sm text-muted-foreground">Loading note…</p>
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
  const phone = isPhoneCall(note.note_type);
  const caller = callSummary(note.caller, note.call_direction);
  // Whether an AE draft exists that the investigator can attribute instead of
  // recording the decision on the clock itself (R4.3).
  const hasAeDraft =
    sae_clock?.has_ae_draft ??
    (sae_clock?.ae_draft_ids
      ? sae_clock.ae_draft_ids.length > 0
      : drafts.some(
          (d) => d.domain === "AE" && d.status !== "rejected" && d.status !== "superseded",
        ));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          {backLink}
          <h1 className="mt-1 text-page font-semibold text-foreground">
            {phone ? "Phone call" : "Chart note"}{" "}
            <span className="font-normal text-muted-foreground">{phone ? "about" : "for"}</span>{" "}
            <Link
              to={`/dashboard/participants/${encodeURIComponent(note.usubjid)}`}
              className="text-primary underline"
              title={note.usubjid}
            >
              {label}
            </Link>
          </h1>
          <dl className="mt-1 flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground">
            <div>
              <dt className="inline text-muted-foreground">
                {phone ? "Call date " : "Note date "}
              </dt>
              <dd className="tabular inline">{note.note_date || "—"}</dd>
            </div>
            <div>
              <dt className="inline text-muted-foreground">Author </dt>
              <dd className="inline">{note.author || "—"}</dd>
            </div>
            <div>
              <dt className="inline text-muted-foreground">Type </dt>
              <dd className="inline">
                {note.note_type ? <NoteTypeLabel noteType={note.note_type} /> : "—"}
              </dd>
            </div>
            {caller && (
              <div>
                <dt className="inline text-muted-foreground">Call </dt>
                <dd className="inline">{caller}</dd>
              </div>
            )}
            <div>
              <dt className="inline text-muted-foreground">Ingested </dt>
              <dd className="inline">
                <Time iso={note.ingested_at} />
                {note.ingested_by ? ` by ${note.ingested_by}` : ""}
              </dd>
            </div>
            <div>
              <dt className="inline text-muted-foreground">Id </dt>
              <dd className="inline font-mono text-xs">{note.id}</dd>
            </div>
          </dl>
        </div>
        <div className="flex items-center gap-2">
          <Badge
            kind="synthetic-env"
            size="sm"
            label={phone ? "Synthetic call" : "Synthetic note"}
          />
          {(() => {
            const tier = escalation ? escalation.tier : note.tier;
            const kind = typeof tier === "number" ? tierBadgeKind(tier) : null;
            return kind ? <Badge kind={kind} /> : null;
          })()}
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
          {sae_clock && (
            <ClockActions
              className="mt-3"
              clock={sae_clock}
              role={role}
              hasAeDraft={hasAeDraft}
              onStopped={(stopped) =>
                setData((d) =>
                  d && d.sae_clock
                    ? {
                        ...d,
                        sae_clock: {
                          ...d.sae_clock,
                          stopped_at: stopped.stopped_at,
                          stopped_by: stopped.stopped_by,
                          decision: stopped.decision,
                          seconds_remaining: null,
                        },
                      }
                    : d,
                )
              }
            />
          )}
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
            <span className="tabular text-xs text-muted-foreground">
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
            labels={data.labels}
            protocol={data.protocol}
          />
        </Card>

        <Card title="Why">
          <WhyPanel why={why} rulesFired={rules_fired} labels={data.labels} isPhoneCall={phone} />
        </Card>
      </div>
    </div>
  );
}
