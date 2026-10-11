/**
 * Side panel for one selected query.
 *
 * 1. The question, who raised it and how long it has waited.
 * 2. The record field it is about: current value and that field's evidence
 *    (click-to-evidence: any chip on the page highlights its row here).
 * 3. The suggested answer from the template writer, one sentence per line with
 *    evidence chips and a "Written by template" label.
 * 4. An answer editor prefilled with the suggestion, an optional "Also correct
 *    the field" (sent as `also_edit`, which the API turns into a new draft
 *    version), and the Answer button (coordinator, investigator or admin).
 *    Only fields the check-in page lets a coordinator edit are offered; the
 *    investigator-only decisions (AESER, AEREL, INTERIM_IRAE) are never
 *    offered and point at the check-in's investigator box instead.
 * 5. Admin, acting as the sponsor's monitor, can Close an answered query.
 *
 * Nothing leaves the site without a person pressing Answer.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { Button } from "../../../components/Button";
import { Card } from "../../../components/Card";
import { ErrorBanner } from "../../../components/ErrorBanner";
import { useToast } from "../../../components/Toast";
import { answerQuery, closeQuery, describeError, getDraft, getQuery } from "../../../lib/api";
import { cx, Time } from "../../../lib/format";
import type { Draft, QueryDetail, Role } from "../../../lib/types";
import { AgeChip, CodeBadge, EvidenceChip, SeverityChip, StatusChip } from "./bits";
import {
  ageHours,
  buildAnswer,
  currentValue,
  domainLabel,
  editableFields,
  evidenceIndex,
  evidenceKindLabel,
  fieldLabel,
  formatValue,
  isAgeAlert,
  participantLabel,
  queriedFieldBlock,
  queryFields,
  raisedBy,
  writtenEvidenceIds,
  type AnswerFormState,
  type IndexedEvidence,
} from "./model";
import { WrittenTextView } from "./WrittenTextView";

export interface QueryPanelProps {
  queryId: string;
  role: Role | null;
  nowMs: number;
  /** Called after an answer or close so the list and counts refresh. */
  onChanged: () => void;
  onDismiss: () => void;
}

const ANSWER_ROLES: Role[] = ["coordinator", "investigator", "admin"];

/**
 * `editField` starts empty: the field actually offered is resolved at render
 * time against the allowed list (queried field first when it is allowed), so
 * it can never default to a field the viewer may not correct.
 */
function emptyForm(detail: QueryDetail | null): AnswerFormState {
  return {
    text: detail?.suggested_answer?.text ?? "",
    citeSuggestion: true,
    alsoEdit: false,
    editField: "",
    editValue: "",
  };
}

/** Source record link: check-in detail or chart-note detail, when known. */
function recordLink(draft: Draft | null): { to: string; label: string } | null {
  if (!draft) return null;
  const noteId = (draft as Draft & { note_id?: string | null }).note_id;
  if (noteId)
    return { to: `/dashboard/notes/${encodeURIComponent(noteId)}`, label: "Open the note" };
  if (draft.session_id)
    return {
      to: `/dashboard/checkins/${encodeURIComponent(draft.session_id)}`,
      label: "Open the check-in",
    };
  return null;
}

export function QueryPanel({ queryId, role, nowMs, onChanged, onDismiss }: QueryPanelProps) {
  const toast = useToast();
  const [detail, setDetail] = useState<QueryDetail | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftError, setDraftError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [form, setForm] = useState<AnswerFormState>(emptyForm(null));
  const [formError, setFormError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [busy, setBusy] = useState<"answer" | "close" | null>(null);
  const [activeEvidence, setActiveEvidence] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const evidenceListRef = useRef<HTMLDivElement>(null);

  // Load the query, then its draft when the API did not embed it.
  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setLoadError(null);
    setDraftError(null);
    setActionError(null);
    setFormError(null);
    setActiveEvidence(null);
    setMoreOpen(false);
    (async () => {
      try {
        const d = await getQuery(queryId, ctrl.signal);
        if (ctrl.signal.aborted) return;
        setDetail(d);
        setForm(emptyForm(d));
        if (d.draft) {
          setDraft(d.draft);
        } else {
          setDraft(null);
          try {
            const dr = await getDraft(d.draft_id);
            if (!ctrl.signal.aborted) setDraft(dr);
          } catch (e) {
            if (!ctrl.signal.aborted) setDraftError(e);
          }
        }
      } catch (e) {
        if (!ctrl.signal.aborted) {
          setDetail(null);
          setLoadError(e);
        }
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    })();
    return () => ctrl.abort();
  }, [queryId, reloadKey]);

  const evidence = useMemo(() => (detail ? evidenceIndex(detail, draft) : []), [detail, draft]);
  const evidenceById = useMemo(() => {
    const m = new Map<string, IndexedEvidence>();
    for (const e of evidence) m.set(e.id, e);
    return m;
  }, [evidence]);
  const primaryEvidence = evidence.filter((e) => e.primary);
  const moreEvidence = evidence.filter((e) => !e.primary);

  const selectEvidence = useCallback(
    (id: string) => {
      setActiveEvidence((cur) => (cur === id ? null : id));
      // A chip pointing at another field's evidence opens the disclosure.
      if (evidenceById.get(id)?.primary === false) {
        setMoreOpen(true);
      }
    },
    [evidenceById],
  );

  // Bring the highlighted row into view after it renders (the disclosure may
  // have just opened); jsdom has no scrollIntoView.
  useEffect(() => {
    if (!activeEvidence) return;
    const rows = evidenceListRef.current?.querySelectorAll<HTMLElement>("[data-evidence-row]");
    const el = rows
      ? Array.from(rows).find((r) => r.dataset.evidenceRow === activeEvidence)
      : undefined;
    if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
  }, [activeEvidence, moreOpen]);

  if (loading && !detail) {
    return (
      <Card title="Query">
        <p className="text-sm text-slate-500" role="status">
          Loading the query…
        </p>
      </Card>
    );
  }
  if (loadError || !detail) {
    return (
      <Card title="Query">
        <ErrorBanner
          error={loadError ?? "Query not found"}
          message="Could not load this query"
          onRetry={() => setReloadKey((k) => k + 1)}
        />
      </Card>
    );
  }

  const hours = ageHours(detail, nowMs);
  const who = raisedBy(detail);
  const value = currentValue(detail, draft);
  const canAnswer = detail.status === "open" && role !== null && ANSWER_ROLES.includes(role);
  const canClose = detail.status === "answered" && role === "admin";
  const suggestionIds = writtenEvidenceIds(detail.suggested_answer);
  const fields = editableFields(draft, detail.domain, detail.field);
  const block = queriedFieldBlock(draft, detail.domain, detail.field, role);
  const covered = queryFields(detail);
  // The field actually being corrected: the person's pick when allowed, else
  // the first allowed one (the queried field when it is allowed).
  const editField = fields.includes(form.editField) ? form.editField : (fields[0] ?? "");
  const link = recordLink(draft);
  const answerEvidenceIds = (detail.answer_evidence ?? []).map((e) =>
    typeof e === "string" ? e : e.id,
  );

  async function submitAnswer() {
    if (!detail) return;
    setFormError(null);
    setActionError(null);
    const built = buildAnswer({ ...form, editField }, detail.suggested_answer, draft);
    if (!built.ok) {
      setFormError(built.error);
      return;
    }
    setBusy("answer");
    try {
      await answerQuery(detail.id, built.body);
      toast.push({
        kind: "success",
        title: "Answer sent to the sponsor (mock)",
        message: built.body.also_edit
          ? `The record was also corrected (${fieldLabel(built.body.also_edit.field)}); a new version was saved.`
          : undefined,
      });
      setReloadKey((k) => k + 1);
      onChanged();
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(null);
    }
  }

  async function submitClose() {
    if (!detail) return;
    setActionError(null);
    setBusy("close");
    try {
      await closeQuery(detail.id);
      toast.push({ kind: "success", title: "Query closed" });
      setReloadKey((k) => k + 1);
      onChanged();
    } catch (e) {
      // Shown once, inline (the "Not closed" banner), like a failed answer.
      setActionError(e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card
      title={`Query for ${participantLabel(detail)}`}
      aside={
        <Button size="sm" variant="ghost" onClick={onDismiss} aria-label="Close the query panel">
          Close panel
        </Button>
      }
      data-testid="query-panel"
    >
      <div className="space-y-5">
        {/* 1. The question */}
        <section aria-label="The question">
          <p className="text-base font-medium text-slate-900">{detail.text}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-600">
            <SeverityChip severity={detail.severity} />
            <StatusChip status={detail.status} />
            <AgeChip hours={hours} alert={isAgeAlert(detail, hours)} />
            <span>
              Raised by {who.label} {who.code && <CodeBadge>{who.code}</CodeBadge>} ·{" "}
              <Time iso={detail.raised_at} style="short" />
            </span>
          </div>
        </section>

        {/* 2. The record field */}
        <section aria-label="The record" className="rounded-xl border border-slate-200 p-3">
          <h3 className="text-sm font-semibold text-slate-900">The record it is about</h3>
          <dl className="mt-2 grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-slate-500">Record</dt>
            <dd className="text-slate-900">
              {domainLabel(detail.domain)} <CodeBadge title="Draft id">{detail.draft_id}</CodeBadge>
            </dd>
            <dt className="text-slate-500">Field</dt>
            <dd className="text-slate-900">
              {fieldLabel(detail.field, detail.field_label)}{" "}
              <CodeBadge title="SDTM variable">{detail.field}</CodeBadge>
            </dd>
            {covered.length > 1 && (
              <>
                <dt className="text-slate-500">Also asks about</dt>
                <dd className="text-slate-900" data-testid="covered-fields">
                  {covered
                    .slice(1)
                    .map((f) => fieldLabel(f))
                    .join(", ")}
                </dd>
              </>
            )}
            <dt className="text-slate-500">Current value</dt>
            <dd className="font-medium text-slate-900" data-testid="current-value">
              {draft || detail.current_value !== undefined ? formatValue(value) : "—"}
              {draft && (
                <span className="ml-2 text-xs font-normal text-slate-500">
                  version {draft.version}, {draft.status}
                </span>
              )}
            </dd>
          </dl>
          {link && (
            <Link to={link.to} className="mt-2 inline-block text-xs text-brand-700 underline">
              {link.label}
            </Link>
          )}
          {draftError !== null && (
            <p className="mt-2 text-xs text-amber-800" role="status">
              The record itself could not be loaded ({describeError(draftError)}); the query can
              still be answered.
            </p>
          )}

          <div ref={evidenceListRef}>
            <h4 className="mt-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Evidence behind this field
            </h4>
            {primaryEvidence.length === 0 ? (
              <p className="mt-1 text-sm text-slate-500">
                No evidence is attached to this field. That is often what the query is about.
              </p>
            ) : (
              <EvidenceRows rows={primaryEvidence} active={activeEvidence} label="Evidence" />
            )}
            {moreEvidence.length > 0 && (
              <div className="mt-2">
                <button
                  type="button"
                  className="text-xs font-medium text-brand-700 underline focus-visible:ring-2"
                  aria-expanded={moreOpen}
                  aria-controls="query-more-evidence"
                  onClick={() => setMoreOpen((o) => !o)}
                >
                  {moreOpen ? "Hide" : "Show"} more evidence on this record ({moreEvidence.length})
                </button>
                {moreOpen && (
                  <div id="query-more-evidence" className="mt-1">
                    <EvidenceRows
                      rows={moreEvidence}
                      active={activeEvidence}
                      label="More evidence on this record"
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        </section>

        {/* 3 + 4. Suggested answer and the editor (open queries) */}
        {detail.status === "open" && (
          <section aria-label="Suggested answer">
            <h3 className="mb-2 text-sm font-semibold text-slate-900">Suggested answer</h3>
            {detail.suggested_answer ? (
              <WrittenTextView
                written={detail.suggested_answer}
                evidenceById={evidenceById}
                activeEvidenceId={activeEvidence}
                onSelectEvidence={selectEvidence}
              />
            ) : (
              <p className="text-sm text-slate-500">
                No suggestion for this query; write the answer below.
              </p>
            )}
          </section>
        )}

        {canAnswer && (
          <section aria-label="Answer" className="rounded-xl border border-slate-200 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label htmlFor="query-answer" className="text-sm font-semibold text-slate-900">
                Your answer
              </label>
              {detail.suggested_answer && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setForm((f) => ({ ...f, text: detail.suggested_answer?.text ?? "" }))
                  }
                >
                  Start again from the suggestion
                </Button>
              )}
            </div>
            <textarea
              id="query-answer"
              className="mt-1 w-full rounded-lg border border-slate-300 p-2 text-sm focus-visible:ring-2"
              rows={5}
              value={form.text}
              onChange={(e) => setForm((f) => ({ ...f, text: e.target.value }))}
            />
            {suggestionIds.length > 0 && (
              <label className="mt-2 flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={form.citeSuggestion}
                  onChange={(e) => setForm((f) => ({ ...f, citeSuggestion: e.target.checked }))}
                />
                Attach the evidence the suggestion cites ({suggestionIds.length})
              </label>
            )}

            {block && (
              <p
                className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700"
                data-testid="field-block"
                data-block-kind={block.kind}
              >
                {block.message}
                {block.kind === "investigator" && link && draft?.session_id && (
                  <>
                    {" "}
                    <Link to={link.to} className="text-brand-700 underline">
                      Open the check-in
                    </Link>
                  </>
                )}
              </p>
            )}

            {fields.length > 0 && (
              <label className="mt-2 flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={form.alsoEdit}
                  onChange={(e) => setForm((f) => ({ ...f, alsoEdit: e.target.checked }))}
                />
                Also correct the field
              </label>
            )}
            {form.alsoEdit && fields.length > 0 && (
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <label className="text-sm text-slate-700">
                  <span className="block text-xs font-medium text-slate-500">Field</span>
                  <select
                    className="mt-0.5 w-full rounded-lg border border-slate-300 bg-white p-2 text-sm"
                    aria-label="Field to correct"
                    value={editField}
                    onChange={(e) => setForm((f) => ({ ...f, editField: e.target.value }))}
                  >
                    {fields.map((f) => (
                      <option key={f} value={f}>
                        {fieldLabel(f)} ({f})
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-sm text-slate-700">
                  <span className="block text-xs font-medium text-slate-500">
                    New value (now: {formatValue(draft?.fields?.[editField])})
                  </span>
                  <input
                    className="mt-0.5 w-full rounded-lg border border-slate-300 p-2 text-sm"
                    aria-label="New value"
                    value={form.editValue}
                    onChange={(e) => setForm((f) => ({ ...f, editValue: e.target.value }))}
                    placeholder="Leave empty to clear the field"
                  />
                </label>
                <p className="text-xs text-slate-500 sm:col-span-2">
                  One field can be corrected per answer
                  {covered.length > 1 ? "; give the other details in the answer text" : ""}. The
                  correction is saved as a new version of the record; the old version is kept and
                  the change is written to the audit trail.
                </p>
              </div>
            )}

            {formError && (
              <p className="mt-2 text-sm text-red-700" role="alert">
                {formError}
              </p>
            )}
            <ErrorBanner error={actionError} message="The answer was not sent" className="mt-2" />
            <div className="mt-3 flex justify-end">
              <Button onClick={submitAnswer} busy={busy === "answer"} disabled={busy !== null}>
                Answer
              </Button>
            </div>
          </section>
        )}

        {detail.status === "open" && !canAnswer && (
          <p className="text-sm text-slate-500">
            Only a coordinator, investigator or admin can answer queries.
          </p>
        )}

        {/* 5. Answered / closed */}
        {detail.status !== "open" && (
          <section aria-label="Answer given" className="rounded-xl border border-slate-200 p-3">
            <h3 className="text-sm font-semibold text-slate-900">Answer given</h3>
            <p className="mt-1 whitespace-pre-wrap text-sm text-slate-900">
              {detail.answer_text || "(no answer text recorded)"}
            </p>
            {answerEvidenceIds.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {answerEvidenceIds.map((id) => (
                  <EvidenceChip
                    key={id}
                    id={id}
                    evidence={evidenceById.get(id)}
                    active={activeEvidence === id}
                    onSelect={selectEvidence}
                  />
                ))}
              </div>
            )}
            <p className="mt-2 text-xs text-slate-500">
              Answered by {detail.answered_by ?? "—"} ·{" "}
              <Time iso={detail.answered_at ?? null} style="short" />
              {detail.status === "closed" && (
                <>
                  {" "}
                  · Closed by {detail.closed_by ?? "—"} ·{" "}
                  <Time iso={detail.closed_at ?? null} style="short" />
                </>
              )}
            </p>
            {canClose && (
              <>
                <ErrorBanner error={actionError} message="Not closed" className="mt-2" />
                <div className="mt-3 flex justify-end">
                  <Button
                    variant="secondary"
                    onClick={submitClose}
                    busy={busy === "close"}
                    disabled={busy !== null}
                  >
                    Close query (as sponsor)
                  </Button>
                </div>
              </>
            )}
          </section>
        )}
      </div>
    </Card>
  );
}

/** A list of evidence rows; the row whose id is `active` is highlighted. */
function EvidenceRows({
  rows,
  active,
  label,
}: {
  rows: IndexedEvidence[];
  active: string | null;
  label: string;
}) {
  return (
    <ul className="mt-1 space-y-1" aria-label={label}>
      {rows.map((e) => (
        <li
          key={e.id}
          data-evidence-row={e.id}
          data-active={active === e.id ? "true" : "false"}
          className={cx(
            "rounded-lg border px-2 py-1.5 text-sm",
            active === e.id
              ? "border-brand-700 bg-brand-50 ring-2 ring-brand-700/30"
              : "border-slate-200",
          )}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-slate-800">{evidenceKindLabel(e.kind)}</span>
            <CodeBadge>{e.id}</CodeBadge>
            {e.ts && (
              <span className="text-xs text-slate-500">
                <Time iso={e.ts} style="short" />
              </span>
            )}
          </div>
          {e.note && <p className="mt-0.5 text-slate-700">{e.note}</p>}
        </li>
      ))}
    </ul>
  );
}
