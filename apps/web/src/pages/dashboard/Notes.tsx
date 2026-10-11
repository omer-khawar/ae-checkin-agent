/**
 * /dashboard/notes — chart-note ingestion (CONTRACTS.md R2.4; Regeneron "Better"
 * tier: "Check-In + Chart Scan").
 *
 * Left: the "Ingest a chart note" form, pre-filled with one of the synthetic
 * notes so the demo beat is one click. "Scan only (dry run)" calls POST /scan
 * and stores nothing; "Ingest" calls POST /notes, which stores the note, runs
 * the deterministic regex + NegEx scanner, drafts AE/CM rows and may create a
 * Tier-2 escalation or start the SAE clock.
 * Right: the note with highlighted spans, the findings tables and, after an
 * ingest, the drafts / escalation / Why list.
 * Then: "Log a call" (CONTRACTS.md R4.1): a call summary is stored as a note
 * with note_type "phone_call" and scanned exactly like a chart note.
 * Below: the paginated list of ingested notes and calls (calls carry a phone
 * icon and the words "Phone call").
 *
 * No LLM is involved anywhere: every highlight is a regex match from
 * `chartscan_lexicon.json`, and every exclusion names its NegEx cue.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";

import { Card } from "../../components/Card";
import { ErrorBanner } from "../../components/ErrorBanner";
import { Pagination } from "../../components/Pagination";
import { fetchAllPages, ingestNote, listNotes, listParticipants, scanNote } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { cx, Time } from "../../lib/format";
import type { ColumnDef } from "@tanstack/react-table";
import type {
  NoteIngestResponse,
  ChartNoteListItem,
  NotesPage,
  Participant,
  ScanResult,
} from "../../lib/types";
import { DraftsPanel } from "./notes/DraftsPanel";
import { HighlightedNote } from "./notes/HighlightedNote";
import { Outcome } from "./notes/Outcome";
import { LogCallForm, NoteTypeLabel } from "./notes/PhoneCall";
import { NoteErrorBanner } from "./notes/NoteErrorBanner";
import { DEFAULT_SAMPLE, NOTE_TYPES, SAMPLE_NOTES, type SampleNote } from "./notes/sampleNotes";
import { ScanTables } from "./notes/ScanTables";
import { WhyPanel } from "./notes/WhyPanel";
import { Badge } from "@/ui/badge";
import { tierBadgeKind } from "@/ui/badge-kinds";
import { Button } from "@/ui/button";
import { DataTable, type DataTableColumnMeta } from "@/ui/data-table";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/ui/sheet";
import { notify } from "@/ui/toast";

type Range = { start: number; end: number };

interface FormState {
  usubjid: string;
  note_date: string;
  author: string;
  note_type: string;
  text: string;
}

type Result =
  | { mode: "dry_run"; text: string; scan: ScanResult; ref_date: string }
  | { mode: "ingested"; data: NoteIngestResponse };

const LIST_PAGE_SIZE = 10;

/** Local calendar date as YYYY-MM-DD (a note date is a date, not an instant). */
function todayLocalIso(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function formFromSample(s: SampleNote, usubjid: string): FormState {
  return {
    usubjid,
    note_date: s.note_date,
    author: s.author,
    note_type: s.note_type,
    text: s.text,
  };
}

const LABEL = "block text-xs font-semibold uppercase tracking-wide text-muted-foreground";
const INPUT =
  "mt-1 w-full rounded-control border border-border-strong bg-surface px-3 py-2 text-sm text-foreground focus-visible:ring-4";

export function Notes() {
  const { hasRole } = useAuth();
  // CLAUDE.md §3.1: the investigator is read-only except AESER/AEREL. Ingesting
  // stores the note and creates drafts / an escalation / an audit event, so it
  // is a coordinator or admin action (CONTRACTS R2.4 "coordinator+"). The
  // dry-run scan stores nothing and stays open to every signed-in role.
  const canIngestRole = hasRole("coordinator", "admin");

  // --- participants -------------------------------------------------------
  const [participants, setParticipants] = useState<Participant[] | null>(null);
  const [participantsError, setParticipantsError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    fetchAllPages<Participant>((limit, offset) => listParticipants({ limit, offset }))
      .then((rows) => {
        if (cancelled) return;
        rows.sort((a, b) => a.display_label.localeCompare(b.display_label));
        setParticipants(rows);
      })
      .catch((e: unknown) => {
        if (!cancelled) setParticipantsError(e);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const participantsSettled = participants !== null || participantsError !== null;

  /**
   * Resolve a sample's "P-003" to the seeded participant's USUBJID.
   * - List loaded, label found → that USUBJID.
   * - List loaded, not found → "" so the select shows "Select…" and Ingest
   *   stays disabled (never file a note against a guessed participant).
   * - List unavailable (failed) → the label itself, so the fallback text input
   *   has something sensible to show and the operator can correct it.
   */
  const usubjidForLabel = useCallback(
    (label: string): string => {
      if (!participants) return participantsError ? label : "";
      const hit = participants.find((p) => p.display_label.toUpperCase() === label.toUpperCase());
      return hit ? hit.usubjid : "";
    },
    [participants, participantsError],
  );

  // --- form ---------------------------------------------------------------
  const [form, setForm] = useState<FormState>(() => formFromSample(DEFAULT_SAMPLE, ""));
  const [sampleId, setSampleId] = useState<string>(DEFAULT_SAMPLE.id);
  // A sample loaded before the participant list arrived still needs its
  // participant resolved. This is consumed exactly once per sample load and is
  // cleared by Clear, so an operator's own choice (including picking
  // "Select…" to think) is never overwritten afterwards.
  const [pendingSampleLabel, setPendingSampleLabel] = useState<string | null>(
    DEFAULT_SAMPLE.display_label,
  );

  useEffect(() => {
    if (pendingSampleLabel === null || !participantsSettled) return;
    const usubjid = usubjidForLabel(pendingSampleLabel);
    setPendingSampleLabel(null);
    // Fill only an empty field: the operator may have typed one while loading.
    setForm((f) => (f.usubjid ? f : { ...f, usubjid }));
  }, [participantsSettled, pendingSampleLabel, usubjidForLabel]);

  const loadSample = (id: string) => {
    setSampleId(id);
    const s = SAMPLE_NOTES.find((x) => x.id === id);
    if (!s) {
      // "—" picked: keep whatever is in the form, but drop any pending resolve.
      setPendingSampleLabel(null);
      return;
    }
    setForm(formFromSample(s, participantsSettled ? usubjidForLabel(s.display_label) : ""));
    setPendingSampleLabel(participantsSettled ? null : s.display_label);
    setResult(null);
    setSelectedRange(null);
    setActionError(null);
  };

  const clearForm = () => {
    setSampleId("");
    setPendingSampleLabel(null);
    setForm({
      usubjid: form.usubjid,
      note_date: todayLocalIso(),
      author: "",
      note_type: "progress_note",
      text: "",
    });
    setResult(null);
    setSelectedRange(null);
    setActionError(null);
  };

  /** The answer key for the sample currently in the box (exact text match only). */
  const answerKey = useMemo(
    () => SAMPLE_NOTES.find((s) => s.text === form.text)?.expected ?? null,
    [form.text],
  );

  // --- scan / ingest ------------------------------------------------------
  const [result, setResult] = useState<Result | null>(null);
  const [scanning, setScanning] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const [selectedRange, setSelectedRange] = useState<Range | null>(null);
  const [listVersion, setListVersion] = useState(0);
  const [ingestOpen, setIngestOpen] = useState(false);
  const [callOpen, setCallOpen] = useState(false);

  const textOk = form.text.trim().length > 0;
  const canIngest = textOk && form.usubjid.trim().length > 0 && form.note_date.length > 0;

  const onScan = async () => {
    if (!textOk || scanning) return;
    setScanning(true);
    setActionError(null);
    setSelectedRange(null);
    try {
      const scan = await scanNote({ text: form.text, ref_date: form.note_date || undefined });
      setResult({ mode: "dry_run", text: form.text, scan, ref_date: form.note_date });
    } catch (e) {
      setActionError(e);
    } finally {
      setScanning(false);
    }
  };

  const onIngest = async (e: FormEvent) => {
    e.preventDefault();
    if (!canIngest || ingesting) return;
    setIngesting(true);
    setActionError(null);
    setSelectedRange(null);
    try {
      const data = await ingestNote({
        usubjid: form.usubjid.trim(),
        note_date: form.note_date,
        author: form.author.trim(),
        note_type: form.note_type,
        text: form.text,
      });
      setResult({ mode: "ingested", data });
      setListVersion((v) => v + 1);
      const tier = data.escalation?.tier ?? 0;
      const title = `Note ingested: ${data.drafts.length} draft${data.drafts.length === 1 ? "" : "s"} created`;
      const description = data.escalation
        ? `Escalation tier ${tier} created${data.sae_clock ? "; SAE clock started" : ""}.`
        : "No escalation.";
      if (tier >= 2) notify.warning(title, { description });
      else notify.success(title, { description });
    } catch (err) {
      setActionError(err);
    } finally {
      setIngesting(false);
    }
  };

  // --- list ---------------------------------------------------------------
  const [listFilter, setListFilter] = useState<string>("");
  const [listOffset, setListOffset] = useState(0);
  const [list, setList] = useState<NotesPage | null>(null);
  const [listError, setListError] = useState<unknown>(null);
  const [listLoading, setListLoading] = useState(true);

  const loadList = useCallback(() => {
    let cancelled = false;
    setListLoading(true);
    setListError(null);
    listNotes({
      usubjid: listFilter || undefined,
      limit: LIST_PAGE_SIZE,
      offset: listOffset,
    })
      .then((page) => {
        if (!cancelled) setList(page);
      })
      .catch((e: unknown) => {
        if (!cancelled) setListError(e);
      })
      .finally(() => {
        if (!cancelled) setListLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [listFilter, listOffset]);

  useEffect(() => loadList(), [loadList, listVersion]);

  const participantLabel = (usubjid: string, fallback?: string) =>
    participants?.find((p) => p.usubjid === usubjid)?.display_label ?? fallback ?? usubjid;

  const columns = useMemo<ColumnDef<ChartNoteListItem>[]>(
    () => [
      {
        id: "participant",
        header: "Participant",
        enableSorting: false,
        meta: { width: "7rem" } satisfies DataTableColumnMeta,
        cell: ({ row: { original: n } }) => (
          <Link
            to={`/dashboard/participants/${encodeURIComponent(n.usubjid)}`}
            className="font-medium text-primary underline"
            title={n.usubjid}
          >
            {participantLabel(n.usubjid, n.display_label)}
          </Link>
        ),
      },
      {
        id: "date",
        header: "Note date",
        enableSorting: false,
        meta: { width: "7rem", tabular: true } satisfies DataTableColumnMeta,
        cell: ({ row }) => row.original.note_date || "—",
      },
      {
        id: "author",
        header: "Author",
        enableSorting: false,
        meta: { hideBelow: "lg" } satisfies DataTableColumnMeta,
        cell: ({ row }) => row.original.author || "—",
      },
      {
        id: "type",
        header: "Type",
        enableSorting: false,
        meta: {
          width: "9rem",
          cellClassName: "text-muted-foreground",
        } satisfies DataTableColumnMeta,
        cell: ({ row }) =>
          row.original.note_type ? <NoteTypeLabel noteType={row.original.note_type} /> : "—",
      },
      {
        id: "symptoms",
        header: "Symptoms",
        enableSorting: false,
        meta: { numeric: true, width: "5.5rem" } satisfies DataTableColumnMeta,
        cell: ({ row }) => row.original.n_symptoms ?? "—",
      },
      {
        id: "meds",
        header: "Meds",
        enableSorting: false,
        meta: { numeric: true, width: "4.5rem" } satisfies DataTableColumnMeta,
        cell: ({ row }) => row.original.n_meds ?? "—",
      },
      {
        id: "flags",
        header: "Red flags",
        enableSorting: false,
        meta: { numeric: true, width: "5.5rem", hideBelow: "lg" } satisfies DataTableColumnMeta,
        cell: ({ row }) => row.original.n_red_flags ?? "—",
      },
      {
        id: "drafts",
        header: "Drafts",
        enableSorting: false,
        meta: { numeric: true, width: "4.5rem" } satisfies DataTableColumnMeta,
        cell: ({ row }) => row.original.n_drafts ?? "—",
      },
      {
        id: "tier",
        header: "Tier",
        enableSorting: false,
        meta: { width: "14rem" } satisfies DataTableColumnMeta,
        cell: ({ row: { original: n } }) => {
          const kind = typeof n.tier === "number" ? tierBadgeKind(n.tier) : null;
          return kind ? <Badge kind={kind} size="sm" /> : "—";
        },
      },
      {
        id: "ingested",
        header: "Ingested",
        enableSorting: false,
        meta: {
          width: "9.5rem",
          tabular: true,
          hideBelow: "xl",
          cellClassName: "text-muted-foreground",
        } satisfies DataTableColumnMeta,
        cell: ({ row }) => <Time iso={row.original.ingested_at} style="short" />,
      },
      {
        id: "open",
        header: () => <span className="sr-only">Open</span>,
        enableSorting: false,
        meta: { width: "4rem", align: "end" } satisfies DataTableColumnMeta,
        cell: ({ row }) => (
          <Link
            to={`/dashboard/notes/${encodeURIComponent(row.original.id)}`}
            className="text-primary underline"
          >
            Open
          </Link>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [participants],
  );

  // --- render -------------------------------------------------------------
  const resultText = result
    ? result.mode === "dry_run"
      ? result.text
      : result.data.note.text
    : null;
  const resultScan = result ? (result.mode === "dry_run" ? result.scan : result.data.scan) : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-page font-semibold text-foreground">Chart notes and calls</h1>
          <p className="mt-1 max-w-3xl text-body text-muted-foreground">
            Paste a clinic note, or log a phone call, and the deterministic scanner (regex + NegEx
            exclusions, no language model) proposes AE and con-med drafts with the exact words each
            one came from. Everything stays a draft until a coordinator confirms it.{" "}
            <span className="font-medium text-foreground">
              All notes and participants are synthetic.
            </span>
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => setIngestOpen(true)}>
            Ingest a note
          </Button>
          <Button variant="secondary" onClick={() => setCallOpen(true)}>
            Log a call
          </Button>
        </div>
      </div>

      <Sheet open={ingestOpen} onOpenChange={setIngestOpen}>
        <SheetContent size="lg">
          <SheetHeader>
            <SheetTitle>Ingest a chart note</SheetTitle>
            <SheetDescription>
              Scan first to see the exact words each finding came from; nothing is stored until you
              ingest.
            </SheetDescription>
          </SheetHeader>
          <SheetBody>
            <div className="space-y-4">
              {/* ------------------------------------------------------------ form */}
              <Card
                title="Note details"
                aside={
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>Load sample</span>
                    <select
                      aria-label="Load a sample note"
                      value={sampleId}
                      onChange={(e) => loadSample(e.target.value)}
                      className="rounded-control border border-border-strong bg-surface px-2 py-1 text-xs text-foreground"
                    >
                      <option value="">—</option>
                      {SAMPLE_NOTES.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.id} · {s.display_label} · {s.note_type} · expect{" "}
                          {s.expected.escalation}
                        </option>
                      ))}
                    </select>
                  </label>
                }
              >
                <form
                  onSubmit={(e) => void onIngest(e)}
                  className="space-y-3"
                  aria-label="Ingest a chart note"
                >
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label htmlFor="note-participant" className={LABEL}>
                        Participant
                      </label>
                      {participants ? (
                        <select
                          id="note-participant"
                          value={form.usubjid}
                          onChange={(e) => setForm((f) => ({ ...f, usubjid: e.target.value }))}
                          className={INPUT}
                          required
                        >
                          <option value="">Select…</option>
                          {participants.map((p) => (
                            <option key={p.usubjid} value={p.usubjid} title={p.usubjid}>
                              {p.display_label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          id="note-participant"
                          value={form.usubjid}
                          onChange={(e) => setForm((f) => ({ ...f, usubjid: e.target.value }))}
                          placeholder={
                            participantsError ? "USUBJID or P-003" : "Loading participants…"
                          }
                          className={INPUT}
                          required
                        />
                      )}
                      {participantsError ? (
                        <p className="mt-1 text-xs text-danger-fg">
                          Participant list unavailable; type the USUBJID or label.
                        </p>
                      ) : null}
                    </div>
                    <div>
                      <label htmlFor="note-date" className={LABEL}>
                        Note date
                      </label>
                      <input
                        id="note-date"
                        type="date"
                        value={form.note_date}
                        onChange={(e) => setForm((f) => ({ ...f, note_date: e.target.value }))}
                        className={INPUT}
                        required
                      />
                    </div>
                    <div>
                      <label htmlFor="note-author" className={LABEL}>
                        Author
                      </label>
                      <input
                        id="note-author"
                        value={form.author}
                        onChange={(e) => setForm((f) => ({ ...f, author: e.target.value }))}
                        placeholder="e.g. Triage RN"
                        className={INPUT}
                      />
                    </div>
                    <div>
                      <label htmlFor="note-type" className={LABEL}>
                        Note type
                      </label>
                      <select
                        id="note-type"
                        value={
                          NOTE_TYPES.some((t) => t.value === form.note_type)
                            ? form.note_type
                            : "other"
                        }
                        onChange={(e) => setForm((f) => ({ ...f, note_type: e.target.value }))}
                        className={INPUT}
                      >
                        {NOTE_TYPES.map((t) => (
                          <option key={t.value} value={t.value}>
                            {t.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div>
                    <label htmlFor="note-text" className={LABEL}>
                      Note text
                    </label>
                    <textarea
                      id="note-text"
                      value={form.text}
                      onChange={(e) => setForm((f) => ({ ...f, text: e.target.value }))}
                      rows={9}
                      className={cx(INPUT, "font-mono text-[13px] leading-5")}
                      placeholder="Paste the chart note here…"
                      required
                    />
                    <div className="mt-1 flex justify-between text-xs text-muted-foreground">
                      <span className="tabular">{form.text.length} characters</span>
                      <span>Stored verbatim; only derived findings are drafted.</span>
                    </div>
                  </div>

                  {answerKey && (
                    <div
                      className="rounded-control border border-border bg-surface-subtle px-3 py-2 text-xs text-muted-foreground"
                      data-testid="answer-key"
                    >
                      <span className="font-semibold text-foreground">
                        Answer key for this sample:
                      </span>{" "}
                      AE terms {answerKey.ae_terms.length ? answerKey.ae_terms.join(", ") : "none"};
                      meds{" "}
                      {answerKey.meds.length
                        ? answerKey.meds.map(([d, c]) => `${d} (${c})`).join(", ")
                        : "none"}
                      ; escalation {answerKey.escalation}
                      {answerKey.serious ? "; serious (hospitalization)" : ""}.
                    </div>
                  )}

                  <NoteErrorBanner error={actionError} message="The request was not accepted" />

                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="secondary"
                      onClick={() => void onScan()}
                      disabled={!textOk || ingesting}
                      loading={scanning}
                    >
                      Scan only (dry run)
                    </Button>
                    <Button
                      type="submit"
                      disabled={!canIngest || !canIngestRole || scanning}
                      loading={ingesting}
                      title={
                        canIngestRole
                          ? undefined
                          : "Coordinator or admin only: ingesting stores the note and creates drafts"
                      }
                    >
                      Ingest
                    </Button>
                    {!canIngestRole && (
                      <span
                        className="rounded-full border border-border-strong bg-surface-subtle px-2 py-0.5 text-xs text-muted-foreground"
                        title="Only a coordinator or admin can ingest; the dry-run scan is still available"
                      >
                        ingest is coordinator/admin only · read-only for your role
                      </span>
                    )}
                    <Button variant="ghost" onClick={clearForm} disabled={scanning || ingesting}>
                      Clear
                    </Button>
                  </div>
                </form>
              </Card>

              {/* ---------------------------------------------------------- result */}
              <Card
                title={
                  result
                    ? result.mode === "dry_run"
                      ? "Scan result"
                      : "Ingested note"
                    : "Scan result"
                }
                aside={
                  result && (
                    <span
                      className={cx(
                        "rounded-full border px-2.5 py-0.5 text-xs font-semibold",
                        result.mode === "dry_run"
                          ? "border-border-strong bg-surface-subtle text-foreground"
                          : "border-green-300 bg-green-100 text-green-800",
                      )}
                    >
                      {result.mode === "dry_run"
                        ? "Dry run · nothing stored"
                        : "Stored · audit event written"}
                    </span>
                  )
                }
                flush
              >
                {!result && (
                  <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                    {scanning || ingesting
                      ? "Scanning…"
                      : "Run a dry-run scan or ingest the note to see highlighted findings here."}
                  </div>
                )}
                {result && resultText !== null && resultScan && (
                  <div className="divide-y divide-border">
                    <div className="p-4">
                      <HighlightedNote
                        text={resultText}
                        scan={resultScan}
                        selectedRange={selectedRange}
                        onSelectRange={setSelectedRange}
                      />
                      {result.mode === "dry_run" && (
                        <p className="mt-2 text-xs text-muted-foreground">
                          Onset dates are relative to the note date {result.ref_date || "(unset)"}.
                        </p>
                      )}
                    </div>

                    {result.mode === "ingested" && (
                      <div className="space-y-4 p-4">
                        <Outcome
                          noteId={result.data.note.id}
                          drafts={result.data.drafts}
                          escalation={result.data.escalation}
                          saeClock={result.data.sae_clock}
                        />
                      </div>
                    )}

                    <ScanTables
                      scan={resultScan}
                      selectedRange={selectedRange}
                      onSelectRange={setSelectedRange}
                    />

                    {result.mode === "ingested" && (
                      <div className="grid gap-4 p-4 xl:grid-cols-2">
                        <section aria-labelledby="ingested-drafts">
                          <h3
                            id="ingested-drafts"
                            className="mb-2 text-sm font-semibold text-foreground"
                          >
                            Drafts
                          </h3>
                          <DraftsPanel
                            drafts={result.data.drafts}
                            noteText={result.data.note.text}
                            onSelectRange={setSelectedRange}
                          />
                        </section>
                        <section aria-labelledby="ingested-why">
                          <h3
                            id="ingested-why"
                            className="mb-2 text-sm font-semibold text-foreground"
                          >
                            Why
                          </h3>
                          <WhyPanel why={result.data.why} rulesFired={result.data.rules_fired} />
                        </section>
                      </div>
                    )}
                  </div>
                )}
              </Card>
            </div>
          </SheetBody>
        </SheetContent>
      </Sheet>

      <Sheet open={callOpen} onOpenChange={setCallOpen}>
        <SheetContent size="md">
          <SheetHeader>
            <SheetTitle>Log a call</SheetTitle>
            <SheetDescription>
              Participant or caregiver phone call (stored as a phone-call note and scanned like a
              chart note).
            </SheetDescription>
          </SheetHeader>
          <SheetBody>
            <LogCallForm
              participants={participants}
              idPrefix="notes-call"
              onLogged={() => setListVersion((v) => v + 1)}
            />
          </SheetBody>
        </SheetContent>
      </Sheet>

      {/* --------------------------------------------------------------- list */}
      <Card
        title="Ingested notes and calls"
        aside={
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>Participant</span>
            <select
              aria-label="Filter notes by participant"
              value={listFilter}
              onChange={(e) => {
                setListFilter(e.target.value);
                setListOffset(0);
              }}
              className="rounded-control border border-border-strong bg-surface px-2 py-1 text-xs text-foreground"
            >
              <option value="">All</option>
              {(participants ?? []).map((p) => (
                <option key={p.usubjid} value={p.usubjid}>
                  {p.display_label}
                </option>
              ))}
            </select>
          </label>
        }
        flush
      >
        {listError ? (
          <div className="p-4">
            <ErrorBanner error={listError} message="Could not load notes" onRetry={loadList} />
          </div>
        ) : null}
        {!listError && listLoading && !list && (
          <p className="px-4 py-6 text-sm text-muted-foreground">Loading notes…</p>
        )}
        {!listError && list && list.items.length === 0 && (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            No notes ingested yet{listFilter ? " for this participant" : ""}.
          </p>
        )}
        {!listError && list && list.items.length > 0 && (
          <div data-testid="notes-table">
            <DataTable
              data={list.items}
              columns={columns}
              getRowId={(n) => n.id}
              caption="Ingested notes and calls"
              scrollX
            />
          </div>
        )}
        {list && list.total > 0 && (
          <Pagination
            className="border-t border-border px-4 py-3"
            total={list.total}
            limit={list.limit}
            offset={list.offset}
            onChange={({ offset }) => setListOffset(offset)}
          />
        )}
      </Card>
    </div>
  );
}
