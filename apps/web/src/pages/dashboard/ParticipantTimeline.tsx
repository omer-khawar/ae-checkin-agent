/**
 * /dashboard/participants/:usubjid — participant timeline (CLAUDE.md §3.7.3,
 * CONTRACTS.md §2.2 `GET /participants/{usubjid}/timeline` + R2.4 `notes[]`).
 *
 * Sections, top to bottom:
 *   header     display label, USUBJID, enrolled date, "synthetic participant"
 *   symptoms   one sparkline per PRO-CTCAE item (provisional grade per check-in)
 *   vitals     pulse and breathing medians per check-in, dots labeled
 *              MEASURED / SIMULATED, with a spelled-out legend
 *   AEs        AEDECOD, first/last session links, ongoing vs resolved (the
 *              header chip and the card both count ongoing as "open")
 *   con-meds   verbatim CMTRT, matched CMDECOD, direction, match confidence
 *   notes      chart notes (R2.4) and logged phone calls (R4.1, phone icon +
 *              "Phone call" + who called), with date, author, type
 *   sessions   every check-in with its tier chip and vitals status
 *
 * Every derived value says where it came from (grade = participant answers via
 * the composite→grade table; vitals = median of eligible samples; CMDECOD = a
 * deterministic string match, not RxNorm), and every row links to the check-in
 * detail page where the full evidence lives. Nothing here is clinical advice.
 *
 * Header actions (CONTRACTS.md R3.3 / R4.1): "Visit brief" opens the
 * printable pre-visit brief (/dashboard/participants/:usubjid/brief, owned by
 * the brief page) and "Log a call" opens the quick call form for this
 * participant; a logged call is scanned like a chart note and the timeline
 * reloads so it appears under "Chart notes and calls".
 *
 * Plain words lead (CLAUDE.md §00): "Side effects", "Medication changes";
 * the SDTM names (AEDECOD, CMTRT, CMDECOD) stay as small badges.
 *
 * `GET /items` (no token needed) is fetched alongside the timeline only to
 * label the sparklines with the real short labels and CTCAE terms; when it
 * fails the page still renders with humanised item ids.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { Card } from "../../components/Card";
import { ErrorBanner } from "../../components/ErrorBanner";
import { MeasuredBadge } from "../../components/MeasuredBadge";
import { TierChip } from "../../components/TierChip";
import { getItems, getTimeline } from "../../lib/api";
import { cx, formatConfidence, Time, vitalsStatusLabel } from "../../lib/format";
import type { AEOpen, ChartNoteSummary, Item, Session, Timeline } from "../../lib/types";
import { LogCallForm, NoteTypeLabel } from "./notes/PhoneCall";
import { callSummary } from "./notes/phoneCallLabels";
import { SymptomSparkline, VitalsCharts } from "./timeline/charts";
import {
  buildSymptomSeries,
  checkinPath,
  directionLabel,
  formatDateOnly,
  itemMetaFromItems,
  notePath,
  sessionIndex,
  sessionsNewestFirst,
  sessionTs,
  vitalsRows,
} from "./timeline/series";
import { briefPath } from "../../lib/routes";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; error: unknown }
  | { kind: "ready"; data: Timeline };

export function ParticipantTimeline() {
  const { usubjid = "" } = useParams<{ usubjid: string }>();
  const navigate = useNavigate();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [items, setItems] = useState<Item[] | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [callOpen, setCallOpen] = useState(false);

  const retry = useCallback(() => setReloadKey((k) => k + 1), []);

  // Timeline: the page's data. Cancelled on unmount / param change so a slow
  // response for a previous participant never overwrites the current one.
  useEffect(() => {
    if (!usubjid) {
      setState({ kind: "error", error: new Error("No participant id in the URL") });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    getTimeline(usubjid)
      .then((data) => {
        if (!cancelled) setState({ kind: "ready", data: data as Timeline });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ kind: "error", error });
      });
    return () => {
      cancelled = true;
    };
  }, [usubjid, reloadKey]);

  // Items table: labels only; failure is silent (fallback labels are used).
  useEffect(() => {
    let cancelled = false;
    getItems()
      .then((res) => {
        if (!cancelled) setItems(res.items ?? []);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const openCheckin = useCallback(
    (sessionId: string) => navigate(checkinPath(sessionId)),
    [navigate],
  );

  if (state.kind === "loading") {
    return (
      <div className="space-y-4" aria-busy="true">
        <h1 className="text-2xl font-bold text-slate-900">Participant timeline</h1>
        <p className="text-sm text-slate-600" role="status">
          Loading timeline for <span className="font-mono">{usubjid}</span>…
        </p>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-slate-900">Participant timeline</h1>
        <ErrorBanner
          error={state.error}
          message={`Could not load the timeline for ${usubjid}`}
          onRetry={retry}
        />
        <p className="text-sm">
          <Link to="/dashboard" className="text-brand-700 underline">
            Back to the queue
          </Link>
        </p>
      </div>
    );
  }

  const data = state.data;
  const participant = data.participant;
  const sessions = sessionsNewestFirst(data.sessions);
  const byId = sessionIndex(data.sessions);
  const meta = itemMetaFromItems(items);
  const symptoms = buildSymptomSeries(data.symptom_series, meta);
  const vitals = vitalsRows(data.vitals_series);
  // `open_aes` is the dedup table (AEOpen); a row with ongoing=false has been
  // resolved but is kept for history. "Open" everywhere on this page means
  // ongoing, so the header chip and the card count the same thing.
  const allAes: AEOpen[] = Array.isArray(data.open_aes) ? data.open_aes : [];
  const openAes = allAes.filter((a) => a.ongoing !== false);
  const resolvedAes = allAes.length - openAes.length;
  const conmeds = Array.isArray(data.conmed_changes) ? data.conmed_changes : [];
  const notes: ChartNoteSummary[] = Array.isArray(data.notes) ? data.notes : [];
  const label = participant?.display_label || usubjid;
  const anyMeasured = vitals.some((v) => v.is_measured);
  const anySimulated = vitals.some((v) => !v.is_measured);

  return (
    <div className="space-y-6">
      {/* Header ------------------------------------------------------------ */}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm text-slate-600">
            <Link to="/dashboard" className="text-brand-700 underline">
              Queue
            </Link>{" "}
            <span aria-hidden="true">/</span> Participant timeline
          </p>
          <h1 className="mt-1 flex flex-wrap items-center gap-3 text-2xl font-bold text-slate-900">
            <span>{label}</span>
            <span
              className="rounded-md border border-violet-300 bg-violet-100 px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-violet-800"
              title="Synthetic participant generated by the seed script; no real person"
            >
              Synthetic participant
            </span>
          </h1>
          <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm text-slate-700 sm:grid-cols-[auto_1fr]">
            <dt className="font-medium text-slate-500">USUBJID</dt>
            <dd className="font-mono">{participant?.usubjid ?? usubjid}</dd>
            <dt className="font-medium text-slate-500">Study</dt>
            <dd className="font-mono">{participant?.study_id ?? "—"}</dd>
            <dt className="font-medium text-slate-500">Enrolled</dt>
            <dd>
              <Time iso={participant?.enrolled_at} />
            </dd>
          </dl>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex flex-wrap gap-2">
            <Link
              to={briefPath(participant?.usubjid ?? usubjid)}
              className="inline-flex min-h-9 items-center rounded-xl border border-brand-800 bg-brand-700 px-3 text-sm font-semibold text-white hover:bg-brand-800 focus-visible:ring-4"
              title="Everything since the last visit, on one printable page"
            >
              Visit brief
            </Link>
            <button
              type="button"
              onClick={() => setCallOpen((v) => !v)}
              aria-expanded={callOpen}
              aria-controls="timeline-log-call"
              className="inline-flex min-h-9 items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-900 hover:bg-slate-100 focus-visible:ring-4"
            >
              <PhoneGlyph />
              {callOpen ? "Close call form" : "Log a call"}
            </button>
          </div>
          <ul className="flex flex-wrap gap-2 text-sm" aria-label="Summary">
            <SummaryChip label="check-ins" value={sessions.length} />
            <SummaryChip label="open side effects" value={openAes.length} />
            <SummaryChip label="medication changes" value={conmeds.length} />
            <SummaryChip label="notes and calls" value={notes.length} />
          </ul>
        </div>
      </header>

      {callOpen && (
        <Card title={`Log a call about ${label}`} id="timeline-log-call">
          <LogCallForm
            usubjid={participant?.usubjid ?? usubjid}
            displayLabel={label}
            idPrefix="timeline-call"
            onLogged={() => retry()}
          />
        </Card>
      )}

      {/* Symptoms ---------------------------------------------------------- */}
      <Card
        title="Symptoms over time"
        aside={
          <span className="text-xs text-slate-600">
            Provisional CTCAE grade per check-in, from the participant&apos;s answers only
          </span>
        }
      >
        {symptoms.length === 0 ? (
          <Empty>No symptom reports yet for this participant.</Empty>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {symptoms.map((s) => (
              <SymptomSparkline key={s.itemId} series={s} onPointClick={openCheckin} />
            ))}
          </div>
        )}
        <p className="mt-3 text-xs text-slate-500">
          Grades are provisional (investigator to confirm) and come from the PRO-CTCAE composite
          score mapped through the composite→grade table. Vitals never change a grade. Open a
          check-in to see each answer and the rules that fired.
        </p>
      </Card>

      {/* Vitals ------------------------------------------------------------ */}
      <Card
        title="Vitals over time"
        aside={
          <span className="flex flex-wrap items-center gap-1.5 text-xs text-slate-600">
            {vitals.length > 0 && (
              <>
                {anyMeasured && <MeasuredBadge isMeasured />}
                {anySimulated && <MeasuredBadge isMeasured={false} />}
              </>
            )}
            <span>median per check-in</span>
          </span>
        }
      >
        {vitals.length === 0 ? (
          <Empty>
            No vitals recorded for this participant (camera off, source unavailable, or no eligible
            samples).
          </Empty>
        ) : (
          <VitalsCharts rows={vitals} onPointClick={openCheckin} />
        )}
        <p className="mt-3 text-xs text-slate-500">
          Each point is the median of the eligible samples captured during that check-in (VS domain{" "}
          <span className="font-mono">VSORRES</span>). Simulated values come from the mock vitals
          source and are labeled SIMULATED everywhere, including exports.
        </p>
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Open AEs -------------------------------------------------------- */}
        <Card
          title="Side effects (open and resolved)"
          aside={
            <span className="tnum text-xs text-slate-600" data-testid="ae-count">
              {openAes.length} open
              {resolvedAes > 0 && <> · {resolvedAes} resolved</>}
            </span>
          }
        >
          {allAes.length === 0 ? (
            <Empty>No AE records.</Empty>
          ) : (
            <ul className="divide-y divide-slate-100" data-testid="open-aes">
              {allAes.map((ae) => (
                <li key={ae.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <div className="font-semibold text-slate-900">
                      {ae.aedecod || "—"}{" "}
                      <span className="rounded border border-slate-200 bg-slate-50 px-1 font-mono text-[10px] font-normal text-slate-500">
                        AEDECOD
                      </span>
                    </div>
                    <div className="mt-0.5 text-xs text-slate-600">
                      First reported{" "}
                      <SessionTime iso={ae.first_reported_at} session={byId[ae.first_session_id]} />
                      {" · "}
                      Last reported{" "}
                      <SessionTime iso={ae.last_reported_at} session={byId[ae.last_session_id]} />
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 text-xs">
                      {ae.first_session_id && (
                        <Link
                          to={checkinPath(ae.first_session_id)}
                          className="text-brand-700 underline"
                        >
                          First check-in
                        </Link>
                      )}
                      {ae.last_session_id && ae.last_session_id !== ae.first_session_id && (
                        <Link
                          to={checkinPath(ae.last_session_id)}
                          className="text-brand-700 underline"
                        >
                          Latest follow-up
                        </Link>
                      )}
                    </div>
                  </div>
                  <span
                    className={cx(
                      "shrink-0 rounded-full border px-2 py-0.5 text-xs font-semibold",
                      ae.ongoing !== false
                        ? "border-amber-300 bg-amber-100 text-amber-900"
                        : "border-slate-300 bg-slate-100 text-slate-700",
                    )}
                    title="AEONGO: whether the event is still ongoing"
                  >
                    {ae.ongoing !== false ? "Ongoing" : "Resolved"}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-slate-500">
            Repeat reports of the same CTCAE term within the dedup window link to the open AE as
            follow-ups instead of creating a new record.
          </p>
        </Card>

        {/* Con-meds -------------------------------------------------------- */}
        <Card title="Medication changes" aside={<Count n={conmeds.length} />}>
          {conmeds.length === 0 ? (
            <Empty>No medication changes reported.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="conmeds">
                <caption className="sr-only">Concomitant medication changes</caption>
                <thead>
                  <tr className="text-left text-xs text-slate-500">
                    <th scope="col" className="py-1 pr-3 font-medium">
                      When
                    </th>
                    <th scope="col" className="py-1 pr-3 font-medium">
                      As reported, word for word{" "}
                      <span className="font-mono text-[10px]">CMTRT</span>
                    </th>
                    <th scope="col" className="py-1 pr-3 font-medium">
                      Standard name <span className="font-mono text-[10px]">CMDECOD</span>
                    </th>
                    <th scope="col" className="py-1 pr-3 font-medium">
                      Direction
                    </th>
                    <th scope="col" className="py-1 pr-3 font-medium">
                      Match confidence
                    </th>
                    <th scope="col" className="py-1 font-medium">
                      <span className="sr-only">Link</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {conmeds.map((c, i) => (
                    <tr key={`${c.session_id}-${i}`} className="border-t border-slate-100">
                      <td className="py-1.5 pr-3 text-slate-700">
                        <Time iso={c.ts} style="short" />
                      </td>
                      <td className="py-1.5 pr-3 font-mono text-slate-900">
                        &quot;{c.cmtrt}&quot;
                      </td>
                      <td className="py-1.5 pr-3">
                        {c.cmdecod ? (
                          <span className="font-mono">{c.cmdecod}</span>
                        ) : (
                          <span
                            className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-semibold text-amber-900"
                            title="No entry in the bundled medication list within edit distance 2; kept verbatim for the coordinator"
                          >
                            Unmatched, verbatim kept
                          </span>
                        )}
                      </td>
                      <td className="py-1.5 pr-3">{directionLabel(c.direction)}</td>
                      <td
                        className="tnum py-1.5 pr-3"
                        title="Deterministic string match (exact, case-insensitive, or Levenshtein ≤ 2) against the bundled list; not RxNorm"
                      >
                        {formatConfidence(c.confidence)}
                      </td>
                      <td className="py-1.5">
                        <Link to={checkinPath(c.session_id)} className="text-brand-700 underline">
                          Open
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-3 text-xs text-slate-500">
            The reported text is stored verbatim. The match is a deterministic string comparison
            against a bundled list (not RxNorm); unmatched names stay verbatim for review.
          </p>
        </Card>
      </div>

      {/* Chart notes --------------------------------------------------------- */}
      <Card title="Chart notes and calls" aside={<Count n={notes.length} />}>
        {notes.length === 0 ? (
          <Empty>No chart notes or phone calls yet for this participant.</Empty>
        ) : (
          <ul className="divide-y divide-slate-100" data-testid="chart-notes">
            {notes.map((n) => (
              <li key={n.id} className="py-2">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                  <span className="font-medium text-slate-900">
                    <NoteDate value={n.note_date} />
                  </span>
                  <span className="text-slate-700">{n.author || "Unknown author"}</span>
                  {n.note_type && (
                    <NoteTypeLabel
                      noteType={n.note_type}
                      className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700"
                    />
                  )}
                  {callSummary(n.caller, n.call_direction) && (
                    <span className="text-xs text-slate-600">
                      {callSummary(n.caller, n.call_direction)}
                    </span>
                  )}
                  {typeof n.escalation_tier === "number" && (
                    <TierChip tier={n.escalation_tier} short />
                  )}
                  <Link to={notePath(n.id)} className="text-xs text-brand-700 underline">
                    {n.note_type === "phone_call" ? "Open call" : "Open note"}
                  </Link>
                </div>
                {n.ingested_at && (
                  <div className="mt-0.5 text-xs text-slate-500">
                    Ingested <Time iso={n.ingested_at} style="short" />
                    {n.ingested_by && <> by {n.ingested_by}</>}
                  </div>
                )}
                {n.text && (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs text-brand-700 underline">
                      Note text (verbatim)
                    </summary>
                    <pre className="mt-1 whitespace-pre-wrap rounded bg-slate-50 p-2 font-sans text-xs text-slate-800">
                      {n.text}
                    </pre>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-slate-500">
          Notes are scanned by a deterministic pattern matcher (no language model); findings become
          drafts with the quoted span as evidence.
        </p>
      </Card>

      {/* Sessions ---------------------------------------------------------- */}
      <Card title="Check-ins" aside={<Count n={sessions.length} />} flush>
        {sessions.length === 0 ? (
          <div className="p-4">
            <Empty>No check-ins yet.</Empty>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="sessions">
              <caption className="sr-only">Check-ins, newest first</caption>
              <thead>
                <tr className="text-left text-xs text-slate-500">
                  <th scope="col" className="px-4 py-2 font-medium">
                    Completed
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Tier
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Camera
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Vitals
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    <span className="sr-only">Link</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <SessionRow key={s.id} session={s} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

/** Small decorative phone glyph for the "Log a call" button (the text carries the meaning). */
function PhoneGlyph() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className="h-3.5 w-3.5">
      <path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h1.148a1.5 1.5 0 0 1 1.465 1.175l.513 2.31a1.5 1.5 0 0 1-1.02 1.756l-.97.323a11.04 11.04 0 0 0 6.1 6.1l.323-.97a1.5 1.5 0 0 1 1.756-1.02l2.31.513A1.5 1.5 0 0 1 18 13.352V14.5a1.5 1.5 0 0 1-1.5 1.5H15C8.096 16 2.5 10.404 2.5 3.5V3.5Z" />
    </svg>
  );
}

function SummaryChip({ label, value }: { label: string; value: number }) {
  return (
    <li className="rounded-full border border-slate-200 bg-white px-3 py-1 text-slate-700">
      <span className="tnum font-semibold text-slate-900">{value}</span> {label}
    </li>
  );
}

function Count({ n }: { n: number }) {
  return (
    <span className="tnum text-xs text-slate-600">
      {n} {n === 1 ? "record" : "records"}
    </span>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-slate-600">{children}</p>;
}

/**
 * `ChartNote.note_date` (R2.4) is a calendar date ("2026-10-02"), not an
 * instant: it must read as Oct 02 in every timezone, so it bypasses `<Time>`
 * (which would show UTC midnight in local time, i.e. the previous evening in
 * the Americas). A real datetime still goes through `<Time>`.
 */
function NoteDate({ value }: { value?: string | null }) {
  const dateOnly = formatDateOnly(value);
  if (dateOnly && value) {
    return (
      <time dateTime={value} title={`${value} (calendar date, no time of day)`}>
        {dateOnly}
      </time>
    );
  }
  return <Time iso={value} style="short" fallback="Undated" />;
}

/** A timestamp for an AE, preferring the API's explicit value, then the linked session's time. */
function SessionTime({ iso, session }: { iso?: string | null; session?: Session }) {
  const value = iso ?? (session ? sessionTs(session) : null);
  return <Time iso={value} style="short" fallback="unknown time" />;
}

function SessionRow({ session: s }: { session: Session }) {
  const incomplete = !s.completed_at;
  return (
    <tr className="border-t border-slate-100">
      <td className="px-4 py-2 text-slate-900">
        {incomplete ? (
          <span className="text-slate-500">
            In progress (started <Time iso={s.started_at} style="short" />)
          </span>
        ) : (
          <Time iso={s.completed_at} style="short" />
        )}
        {s.is_eval && (
          <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">
            eval
          </span>
        )}
      </td>
      <td className="px-4 py-2">
        {typeof s.tier === "number" ? (
          <TierChip tier={s.tier} />
        ) : (
          <span className="text-xs text-slate-500">not yet evaluated</span>
        )}
      </td>
      <td className="px-4 py-2 text-slate-700">{s.consent_camera ? "Camera on" : "Camera off"}</td>
      <td className="px-4 py-2 text-slate-700">{vitalsStatusLabel(s.vitals_status)}</td>
      <td className="px-4 py-2 text-right">
        <Link
          to={checkinPath(s.id)}
          className="inline-flex min-h-9 items-center rounded-xl border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-900 hover:bg-slate-100"
        >
          Open
        </Link>
      </td>
    </tr>
  );
}
