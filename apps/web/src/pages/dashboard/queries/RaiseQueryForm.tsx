/**
 * "Raise query" for the admin acting as the sponsor's monitor (R4.4,
 * `POST /queries`). Pick a participant → one of their check-ins or notes → a
 * record (draft) → a field, then write the question. A record id can also be
 * pasted directly, which is quicker when the monitor already knows it.
 *
 * The lookups reuse existing endpoints (participants, queue, check-in detail,
 * note detail, draft); nothing new is needed on the API besides POST /queries.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { Button } from "@/ui/button";
import { Card } from "../../../components/Card";
import { ErrorBanner } from "../../../components/ErrorBanner";
import { useToast } from "../../../components/Toast";
import {
  getCheckIn,
  getDraft,
  getNote,
  getQueue,
  listParticipants,
  raiseQuery,
} from "../../../lib/api";
import { formatLocal } from "../../../lib/format";
import type { Draft, Participant, QueryRow, QuerySeverity } from "../../../lib/types";
import { domainLabel, fieldLabel, formatValue, SEVERITY_HELP, SEVERITY_LABELS } from "./model";

export interface RaiseQueryFormProps {
  onRaised: (row: QueryRow) => void;
  onCancel: () => void;
}

/** Queue rows as the API sends them: notes have `note_id` and a null `session_id`. */
interface RecordSource {
  key: string;
  session_id: string | null;
  note_id: string | null;
  label: string;
}

/** One-line description of a draft for the picker. */
function draftLabel(d: Draft): string {
  const f = d.fields ?? {};
  const name = (f.AEDECOD ?? f.AETERM ?? f.CMTRT ?? f.CMDECOD ?? f.VSTEST ?? f.VSTESTCD ?? "") as
    | string
    | number;
  return `${domainLabel(d.domain)}${name !== "" ? `: ${String(name)}` : ""} (v${d.version}, ${d.status})`;
}

export function RaiseQueryForm({ onRaised, onCancel }: RaiseQueryFormProps) {
  const toast = useToast();
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [participantsError, setParticipantsError] = useState<unknown>(null);
  const [usubjid, setUsubjid] = useState("");
  const [sources, setSources] = useState<RecordSource[]>([]);
  const [sourceKey, setSourceKey] = useState("");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [draftId, setDraftId] = useState("");
  const [pastedId, setPastedId] = useState("");
  const [pasted, setPasted] = useState<Draft | null>(null);
  const [field, setField] = useState("");
  const [severity, setSeverity] = useState<QuerySeverity>("data");
  const [text, setText] = useState("");
  const [lookupError, setLookupError] = useState<unknown>(null);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [submitError, setSubmitError] = useState<unknown>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Participants once.
  useEffect(() => {
    let cancelled = false;
    listParticipants({ limit: 100 })
      .then((p) => {
        if (!cancelled) setParticipants(p.items);
      })
      .catch((e) => {
        if (!cancelled) setParticipantsError(e);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Participant → their check-ins and notes.
  useEffect(() => {
    setSources([]);
    setSourceKey("");
    setDrafts([]);
    setDraftId("");
    if (!usubjid) return;
    let cancelled = false;
    setLookupBusy(true);
    setLookupError(null);
    getQueue({ usubjid, status: "all", limit: 100 })
      .then((page) => {
        if (cancelled) return;
        const rows = page.items as unknown as Array<{
          session_id: string | null;
          note_id?: string | null;
          source?: string;
          completed_at: string;
        }>;
        setSources(
          rows.map((r) => {
            const isNote = Boolean(r.note_id) || r.source === "chart_note";
            return {
              key: (r.note_id ?? r.session_id ?? r.completed_at) as string,
              session_id: r.session_id ?? null,
              note_id: r.note_id ?? null,
              label: `${isNote ? "Note" : "Check-in"} · ${formatLocal(r.completed_at, "short")}`,
            };
          }),
        );
      })
      .catch((e) => {
        if (!cancelled) setLookupError(e);
      })
      .finally(() => {
        if (!cancelled) setLookupBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [usubjid]);

  // Check-in or note → its drafts (superseded versions hidden).
  useEffect(() => {
    setDrafts([]);
    setDraftId("");
    const src = sources.find((s) => s.key === sourceKey);
    if (!src) return;
    let cancelled = false;
    setLookupBusy(true);
    setLookupError(null);
    const load: Promise<Draft[]> = src.note_id
      ? getNote(src.note_id).then((n) => n.drafts as unknown as Draft[])
      : src.session_id
        ? getCheckIn(src.session_id).then((c) => c.drafts)
        : Promise.resolve([]);
    load
      .then((ds) => {
        if (!cancelled) setDrafts(ds.filter((d) => d.status !== "superseded"));
      })
      .catch((e) => {
        if (!cancelled) setLookupError(e);
      })
      .finally(() => {
        if (!cancelled) setLookupBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sourceKey, sources]);

  const selectedDraft = pasted ?? drafts.find((d) => d.id === draftId) ?? null;
  const fieldOptions = useMemo(
    () =>
      Object.keys(selectedDraft?.fields ?? {})
        .filter((k) => k !== "STUDYID" && k !== "USUBJID")
        .sort(),
    [selectedDraft],
  );

  useEffect(() => {
    setField((cur) => (fieldOptions.includes(cur) ? cur : (fieldOptions[0] ?? "")));
  }, [fieldOptions]);

  async function loadPasted() {
    const id = pastedId.trim();
    if (!id) return;
    setLookupBusy(true);
    setLookupError(null);
    try {
      setPasted(await getDraft(id));
    } catch (e) {
      setPasted(null);
      setLookupError(e);
    } finally {
      setLookupBusy(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setSubmitError(null);
    if (!selectedDraft) return setFormError("Pick the record the question is about.");
    if (!field) return setFormError("Pick the field the question is about.");
    if (!text.trim()) return setFormError("Write the question.");
    setBusy(true);
    try {
      const row = await raiseQuery({
        draft_id: selectedDraft.id,
        field,
        text: text.trim(),
        severity,
      });
      toast.push({ kind: "success", title: "Query raised", message: "It is now in the Open tab." });
      onRaised(row);
    } catch (err) {
      setSubmitError(err);
    } finally {
      setBusy(false);
    }
  }

  const selectClass =
    "mt-0.5 w-full rounded-control border border-border-strong bg-surface p-2 text-sm";

  return (
    <Card title="Raise a query (acting as the sponsor's monitor)" data-testid="raise-query">
      <form onSubmit={submit} className="space-y-3">
        <ErrorBanner error={participantsError} message="Could not load participants" />
        <div className="grid gap-3 md:grid-cols-3">
          <label className="text-sm text-muted-foreground">
            <span className="block text-xs font-medium text-muted-foreground">Participant</span>
            <select
              className={selectClass}
              aria-label="Participant"
              value={usubjid}
              onChange={(e) => {
                setPasted(null);
                setUsubjid(e.target.value);
              }}
            >
              <option value="">Choose…</option>
              {participants.map((p) => (
                <option key={p.usubjid} value={p.usubjid}>
                  {p.display_label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm text-muted-foreground">
            <span className="block text-xs font-medium text-muted-foreground">
              Check-in or note
            </span>
            <select
              className={selectClass}
              aria-label="Check-in or note"
              value={sourceKey}
              onChange={(e) => {
                setPasted(null);
                setSourceKey(e.target.value);
              }}
              disabled={!usubjid}
            >
              <option value="">
                {usubjid && sources.length === 0 && !lookupBusy ? "None found" : "Choose…"}
              </option>
              {sources.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm text-muted-foreground">
            <span className="block text-xs font-medium text-muted-foreground">Record</span>
            <select
              className={selectClass}
              aria-label="Record"
              value={draftId}
              onChange={(e) => {
                setPasted(null);
                setDraftId(e.target.value);
              }}
              disabled={!sourceKey}
            >
              <option value="">Choose…</option>
              {drafts.map((d) => (
                <option key={d.id} value={d.id}>
                  {draftLabel(d)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1 text-sm text-muted-foreground">
            <span className="block text-xs font-medium text-muted-foreground">
              Or paste a record id
            </span>
            <input
              className="mt-0.5 w-full rounded-control border border-border-strong p-2 font-mono text-sm"
              value={pastedId}
              onChange={(e) => setPastedId(e.target.value)}
              placeholder="01J…"
            />
          </label>
          <Button size="sm" variant="secondary" onClick={loadPasted} disabled={!pastedId.trim()}>
            Load record
          </Button>
        </div>
        {lookupBusy && (
          <p className="text-xs text-muted-foreground" role="status">
            Loading…
          </p>
        )}
        <ErrorBanner error={lookupError} message="Lookup failed" />

        {selectedDraft && (
          <div className="rounded-control bg-surface-subtle p-2 text-sm text-muted-foreground">
            Selected: {draftLabel(selectedDraft)}{" "}
            <span className="font-mono text-xs text-muted-foreground">{selectedDraft.id}</span>
          </div>
        )}

        <div className="grid gap-3 md:grid-cols-2">
          <label className="text-sm text-muted-foreground">
            <span className="block text-xs font-medium text-muted-foreground">Field</span>
            <select
              className={selectClass}
              aria-label="Field"
              value={field}
              onChange={(e) => setField(e.target.value)}
              disabled={!selectedDraft}
            >
              {fieldOptions.length === 0 && <option value="">Pick a record first</option>}
              {fieldOptions.map((f) => (
                <option key={f} value={f}>
                  {fieldLabel(f)} ({f}) = {formatValue(selectedDraft?.fields?.[f])}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="text-sm text-muted-foreground">
            <legend className="text-xs font-medium text-muted-foreground">Kind</legend>
            <div className="mt-1 flex gap-4">
              {(["data", "safety"] as QuerySeverity[]).map((s) => (
                <label key={s} className="flex items-center gap-1.5" title={SEVERITY_HELP[s]}>
                  <input
                    type="radio"
                    name="query-severity"
                    value={s}
                    checked={severity === s}
                    onChange={() => setSeverity(s)}
                  />
                  {SEVERITY_LABELS[s]}
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        <label className="block text-sm text-muted-foreground">
          <span className="block text-xs font-medium text-muted-foreground">
            Question for the site
          </span>
          <textarea
            className="mt-0.5 w-full rounded-control border border-border-strong p-2 text-sm"
            rows={3}
            aria-label="Question for the site"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="e.g. Please provide the dose and the reason this medication was started."
          />
        </label>

        {formError && (
          <p className="text-sm text-danger-fg" role="alert">
            {formError}
          </p>
        )}
        <ErrorBanner error={submitError} message="The query was not raised" />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            Raise query
          </Button>
        </div>
      </form>
    </Card>
  );
}
