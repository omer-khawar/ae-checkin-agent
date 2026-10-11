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
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";

import { Button } from "@/ui/button";
import { isTypingTarget } from "@/ui/keyboard";
import { Kbd } from "@/ui/kbd";
import { SegmentedControl } from "@/ui/segmented-control";
import { ErrorBanner } from "../../components/ErrorBanner";
import { MeasuredBadge } from "../../components/MeasuredBadge";
import { TierChip } from "../../components/TierChip";
import { getItems, getTimeline } from "../../lib/api";
import { cx, formatConfidence, Time, vitalsStatusLabel } from "../../lib/format";
import type { AEOpen, ChartNoteSummary, Item, Session, Timeline } from "../../lib/types";
import { LogCallForm, NoteTypeLabel } from "./notes/PhoneCall";
import { callSummary } from "./notes/phoneCallLabels";
import { BaselineCard } from "./timeline/BaselineCard";
import { normalizeBaseline } from "./timeline/baseline";
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

const TABS = ["overview", "symptoms", "medicines", "notes", "reports"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABELS: Record<Tab, string> = {
  overview: "Overview",
  symptoms: "Symptoms",
  medicines: "Medicines",
  notes: "Notes & calls",
  reports: "Reports",
};

/** A flat, opaque data panel (data surfaces are never glass). */
function Panel({
  title,
  aside,
  children,
  flush,
  className,
  id,
  ...rest
}: {
  title?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  flush?: boolean;
  className?: string;
  id?: string;
  "data-testid"?: string;
}) {
  return (
    <section
      id={id}
      className={cx("rounded-panel border border-border bg-surface", className)}
      {...rest}
    >
      {(title || aside) && (
        <header className="flex min-h-row items-center justify-between gap-3 border-b border-border px-3 py-1.5">
          {title ? <h2 className="text-body font-semibold text-foreground">{title}</h2> : <span />}
          {aside}
        </header>
      )}
      <div className={flush ? "" : "p-3"}>{children}</div>
    </section>
  );
}

export function ParticipantTimeline() {
  const { usubjid = "" } = useParams<{ usubjid: string }>();
  const navigate = useNavigate();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [items, setItems] = useState<Item[] | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [callOpen, setCallOpen] = useState(false);
  const [params, setParams] = useSearchParams();
  const tabParam = params.get("tab");
  const tab: Tab = (TABS as readonly string[]).includes(tabParam ?? "")
    ? (tabParam as Tab)
    : "overview";
  const setTab = useCallback(
    (t: Tab) => setParams(t === "overview" ? {} : { tab: t }, { replace: true }),
    [setParams],
  );

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

  // Keyboard: 1-5 switch tabs, b opens the visit brief. Ignored while typing or with modifiers.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= TABS.length) {
        e.preventDefault();
        setTab(TABS[n - 1]);
      } else if (e.key === "b" && usubjid) {
        e.preventDefault();
        navigate(briefPath(usubjid));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setTab, navigate, usubjid]);

  const openCheckin = useCallback(
    (sessionId: string) => navigate(checkinPath(sessionId)),
    [navigate],
  );

  if (state.kind === "loading") {
    return (
      <div className="space-y-4" aria-busy="true">
        <h1 className="text-page font-semibold text-foreground">Participant timeline</h1>
        <p className="text-body text-muted-foreground" role="status">
          Loading timeline for <span className="font-mono">{usubjid}</span>…
        </p>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="space-y-4">
        <h1 className="text-page font-semibold text-foreground">Participant timeline</h1>
        <ErrorBanner
          error={state.error}
          message={`Could not load the timeline for ${usubjid}`}
          onRetry={retry}
        />
        <p className="text-sm">
          <Link to="/dashboard" className="text-primary underline">
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
  const baselineRaw =
    data.baseline ?? (participant as { baseline?: unknown } | undefined)?.baseline;
  const baseline = normalizeBaseline(baselineRaw);
  const nextVisit = (data as { next_visit?: string | null }).next_visit ?? null;
  const id = participant?.usubjid ?? usubjid;

  const count = (n: number) => (
    <span className="tabular text-caption text-muted-foreground">{n}</span>
  );
  const tabOptions = [
    { value: "overview" as const, label: TAB_LABELS.overview },
    { value: "symptoms" as const, label: TAB_LABELS.symptoms, accessory: count(symptoms.length) },
    { value: "medicines" as const, label: TAB_LABELS.medicines, accessory: count(conmeds.length) },
    { value: "notes" as const, label: TAB_LABELS.notes, accessory: count(notes.length) },
    { value: "reports" as const, label: TAB_LABELS.reports, accessory: count(sessions.length) },
  ];

  return (
    <div className="space-y-3">
      {/* Compact header ---------------------------------------------------- */}
      <header className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <p className="text-caption text-muted-foreground">
              <Link to="/dashboard" className="text-primary underline">
                Queue
              </Link>{" "}
              <span aria-hidden="true">/</span> Participant timeline
            </p>
            <h1 className="mt-0.5 flex flex-wrap items-center gap-2 text-page font-semibold text-foreground">
              <span>{label}</span>
              <span
                className="rounded-control border border-simulated-border bg-simulated-bg px-1.5 py-0.5 text-caption font-semibold uppercase tracking-wide text-simulated-fg"
                title="Synthetic participant generated by the seed script; no real person"
              >
                Synthetic participant
              </span>
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="primary">
              <Link
                to={briefPath(id)}
                title="Everything since the last visit, on one printable page (shortcut: B)"
              >
                Visit brief
              </Link>
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setCallOpen((v) => !v)}
              aria-expanded={callOpen}
              aria-controls="timeline-log-call"
              leadingIcon={<PhoneGlyph />}
            >
              {callOpen ? "Close call form" : "Log a call"}
            </Button>
          </div>
        </div>
        <dl className="flex flex-wrap items-center gap-x-5 gap-y-1 text-table text-muted-foreground">
          <MetaItem k="USUBJID">
            <span className="font-mono text-foreground">{id}</span>
          </MetaItem>
          <MetaItem k="Study">
            <span className="font-mono text-foreground">{participant?.study_id ?? "—"}</span>
          </MetaItem>
          <MetaItem k="Enrolled">
            <span className="text-foreground">
              <Time iso={participant?.enrolled_at} />
            </span>
          </MetaItem>
          {nextVisit && (
            <MetaItem k="Next visit">
              <span className="text-foreground">
                <Time iso={nextVisit} style="short" />
              </span>
            </MetaItem>
          )}
          {baseline && (
            <MetaItem k="Background chart">
              <span className="text-foreground">Synthea synthetic EHR (simulated)</span>
            </MetaItem>
          )}
        </dl>
        <ul className="flex flex-wrap gap-1.5 text-caption" aria-label="Summary">
          <SummaryChip label="check-ins" value={sessions.length} />
          <SummaryChip label="open side effects" value={openAes.length} />
          <SummaryChip label="medication changes" value={conmeds.length} />
          <SummaryChip label="notes and calls" value={notes.length} />
        </ul>
      </header>

      {callOpen && (
        <Panel title={`Log a call about ${label}`} id="timeline-log-call">
          <LogCallForm
            usubjid={id}
            displayLabel={label}
            idPrefix="timeline-call"
            onLogged={() => retry()}
          />
        </Panel>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <SegmentedControl
          label="Participant sections"
          options={tabOptions}
          value={tab}
          onValueChange={setTab}
        />
        <p className="flex items-center gap-1 text-caption text-muted-foreground">
          <span>Keys</span>
          <Kbd>1</Kbd>
          <span>to</span>
          <Kbd>5</Kbd>
          <span>switch section,</span>
          <Kbd>B</Kbd>
          <span>opens the visit brief</span>
        </p>
      </div>

      {/* Overview ---------------------------------------------------------- */}
      {tab === "overview" && (
        <div className="space-y-3" data-testid="tab-overview">
          <AesPanel allAes={allAes} openAes={openAes} resolvedAes={resolvedAes} byId={byId} />
          <BaselineCard baseline={baselineRaw} />
        </div>
      )}

      {/* Symptoms + vitals --------------------------------------------------- */}
      {tab === "symptoms" && (
        <div className="space-y-3" data-testid="tab-symptoms">
          <Panel
            title="Symptoms over time"
            aside={
              <span className="text-caption text-muted-foreground">
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
            <p className="mt-3 text-caption text-muted-foreground">
              Grades are provisional (investigator to confirm) and come from the PRO-CTCAE composite
              score mapped through the composite→grade table. Vitals never change a grade. Open a
              check-in to see each answer and the rules that fired.
            </p>
          </Panel>

          <Panel
            title="Vitals over time"
            aside={
              <span className="flex flex-wrap items-center gap-1.5 text-caption text-muted-foreground">
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
                No vitals recorded for this participant (camera off, source unavailable, or no
                eligible samples).
              </Empty>
            ) : (
              <VitalsCharts rows={vitals} onPointClick={openCheckin} />
            )}
            <p className="mt-3 text-caption text-muted-foreground">
              Each point is the median of the eligible samples captured during that check-in (VS
              domain <span className="font-mono">VSORRES</span>). Simulated values come from the
              mock vitals source and are labeled SIMULATED everywhere, including exports.
            </p>
          </Panel>
        </div>
      )}

      {/* Medicines ----------------------------------------------------------- */}
      {tab === "medicines" && (
        <Panel title="Medication changes" aside={<Count n={conmeds.length} />} flush>
          {conmeds.length === 0 ? (
            <div className="p-3">
              <Empty>No medication changes reported.</Empty>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-table" data-testid="conmeds">
                <caption className="sr-only">Concomitant medication changes</caption>
                <thead className="bg-surface-subtle">
                  <tr className="text-left text-caption text-muted-foreground">
                    <Th>When</Th>
                    <Th>
                      As reported, word for word <Code>CMTRT</Code>
                    </Th>
                    <Th>
                      Standard name <Code>CMDECOD</Code>
                    </Th>
                    <Th>Direction</Th>
                    <Th>Match confidence</Th>
                    <Th>
                      <span className="sr-only">Link</span>
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {conmeds.map((c, i) => (
                    <tr
                      key={`${c.session_id}-${i}`}
                      className="h-row border-t border-border hover:bg-surface-subtle"
                    >
                      <td className="tabular px-3 py-1 text-muted-foreground">
                        <Time iso={c.ts} style="short" />
                      </td>
                      <td className="px-3 py-1 font-mono text-foreground">&quot;{c.cmtrt}&quot;</td>
                      <td className="px-3 py-1">
                        {c.cmdecod ? (
                          <span className="font-mono">{c.cmdecod}</span>
                        ) : (
                          <span
                            className="rounded-control bg-warning-bg px-1.5 py-0.5 text-caption font-semibold text-warning-fg"
                            title="No entry in the bundled medication list within edit distance 2; kept verbatim for the coordinator"
                          >
                            Unmatched, verbatim kept
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-1">{directionLabel(c.direction)}</td>
                      <td
                        className="tabular px-3 py-1"
                        title="Deterministic string match (exact, case-insensitive, or Levenshtein ≤ 2) against the bundled list; not RxNorm"
                      >
                        {formatConfidence(c.confidence)}
                      </td>
                      <td className="px-3 py-1">
                        <Link to={checkinPath(c.session_id)} className="text-primary underline">
                          Open
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="border-t border-border p-3 text-caption text-muted-foreground">
            The reported text is stored verbatim. The match is a deterministic string comparison
            against a bundled list (not RxNorm); unmatched names stay verbatim for review.
          </p>
        </Panel>
      )}

      {/* Notes and calls ----------------------------------------------------- */}
      {tab === "notes" && (
        <Panel title="Chart notes and calls" aside={<Count n={notes.length} />}>
          {notes.length === 0 ? (
            <Empty>No chart notes or phone calls yet for this participant.</Empty>
          ) : (
            <ul className="divide-y divide-border" data-testid="chart-notes">
              {notes.map((n) => (
                <li key={n.id} className="py-2 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-body">
                    <span className="font-medium text-foreground">
                      <NoteDate value={n.note_date} />
                    </span>
                    <span className="text-muted-foreground">{n.author || "Unknown author"}</span>
                    {n.note_type && (
                      <NoteTypeLabel
                        noteType={n.note_type}
                        className="rounded-control bg-surface-subtle px-1.5 py-0.5 text-caption text-foreground"
                      />
                    )}
                    {callSummary(n.caller, n.call_direction) && (
                      <span className="text-caption text-muted-foreground">
                        {callSummary(n.caller, n.call_direction)}
                      </span>
                    )}
                    {typeof n.escalation_tier === "number" && (
                      <TierChip tier={n.escalation_tier} short />
                    )}
                    <Link to={notePath(n.id)} className="text-caption text-primary underline">
                      {n.note_type === "phone_call" ? "Open call" : "Open note"}
                    </Link>
                  </div>
                  {n.ingested_at && (
                    <div className="mt-0.5 text-caption text-muted-foreground">
                      Ingested <Time iso={n.ingested_at} style="short" />
                      {n.ingested_by && <> by {n.ingested_by}</>}
                    </div>
                  )}
                  {n.text && (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-caption text-primary underline">
                        Note text (verbatim)
                      </summary>
                      <pre className="mt-1 whitespace-pre-wrap rounded-control bg-surface-subtle p-2 font-sans text-table text-foreground">
                        {n.text}
                      </pre>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-caption text-muted-foreground">
            Notes are scanned by a deterministic pattern matcher (no language model); findings
            become drafts with the quoted span as evidence.
          </p>
        </Panel>
      )}

      {/* Reports: the brief and every check-in ------------------------------ */}
      {tab === "reports" && (
        <div className="space-y-3" data-testid="tab-reports">
          <Panel title="Visit brief">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="max-w-prose text-body text-muted-foreground">
                One printable page with everything since the last completed visit: new side effects,
                medication changes, open clocks, notes and the questions to ask.
              </p>
              <Button asChild variant="secondary">
                <Link to={briefPath(id)}>Open the brief</Link>
              </Button>
            </div>
          </Panel>
          <Panel title="Check-ins" aside={<Count n={sessions.length} />} flush>
            {sessions.length === 0 ? (
              <div className="p-3">
                <Empty>No check-ins yet.</Empty>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-table" data-testid="sessions">
                  <caption className="sr-only">Check-ins, newest first</caption>
                  <thead className="bg-surface-subtle">
                    <tr className="text-left text-caption text-muted-foreground">
                      <Th>Completed</Th>
                      <Th>Tier</Th>
                      <Th>Camera</Th>
                      <Th>Vitals</Th>
                      <Th>
                        <span className="sr-only">Link</span>
                      </Th>
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
          </Panel>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

function AesPanel({
  allAes,
  openAes,
  resolvedAes,
  byId,
}: {
  allAes: AEOpen[];
  openAes: AEOpen[];
  resolvedAes: number;
  byId: Record<string, Session>;
}) {
  return (
    <Panel
      title="Side effects (open and resolved)"
      aside={
        <span className="tabular text-caption text-muted-foreground" data-testid="ae-count">
          {openAes.length} open
          {resolvedAes > 0 && <> · {resolvedAes} resolved</>}
        </span>
      }
    >
      {allAes.length === 0 ? (
        <Empty>No AE records.</Empty>
      ) : (
        <ul className="divide-y divide-border" data-testid="open-aes">
          {allAes.map((ae) => (
            <li
              key={ae.id}
              className="flex flex-wrap items-start justify-between gap-2 py-2 first:pt-0 last:pb-0"
            >
              <div className="min-w-0">
                <div className="text-body font-semibold text-foreground">
                  {ae.aedecod || "—"} <Code>AEDECOD</Code>
                </div>
                <div className="mt-0.5 text-caption text-muted-foreground">
                  First reported{" "}
                  <SessionTime iso={ae.first_reported_at} session={byId[ae.first_session_id]} />
                  {" · "}
                  Last reported{" "}
                  <SessionTime iso={ae.last_reported_at} session={byId[ae.last_session_id]} />
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 text-caption">
                  {ae.first_session_id && (
                    <Link to={checkinPath(ae.first_session_id)} className="text-primary underline">
                      First check-in
                    </Link>
                  )}
                  {ae.last_session_id && ae.last_session_id !== ae.first_session_id && (
                    <Link to={checkinPath(ae.last_session_id)} className="text-primary underline">
                      Latest follow-up
                    </Link>
                  )}
                </div>
              </div>
              <span
                className={cx(
                  "shrink-0 rounded-control border px-2 py-0.5 text-caption font-semibold",
                  ae.ongoing !== false
                    ? "border-warning-border bg-warning-bg text-warning-fg"
                    : "border-border-strong bg-surface-subtle text-muted-foreground",
                )}
                title="AEONGO: whether the event is still ongoing"
              >
                {ae.ongoing !== false ? "Ongoing" : "Resolved"}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-caption text-muted-foreground">
        Repeat reports of the same CTCAE term within the dedup window link to the open AE as
        follow-ups instead of creating a new record.
      </p>
    </Panel>
  );
}

function MetaItem({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt>{k}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Th({ children }: { children: ReactNode }) {
  return (
    <th scope="col" className="px-3 py-1.5 font-medium">
      {children}
    </th>
  );
}

function Code({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-control border border-border bg-surface-subtle px-1 font-mono text-caption font-normal text-muted-foreground">
      {children}
    </span>
  );
}

/** Small decorative phone glyph for the "Log a call" button (the text carries the meaning). */
function PhoneGlyph() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className="h-4 w-4">
      <path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h1.148a1.5 1.5 0 0 1 1.465 1.175l.513 2.31a1.5 1.5 0 0 1-1.02 1.756l-.97.323a11.04 11.04 0 0 0 6.1 6.1l.323-.97a1.5 1.5 0 0 1 1.756-1.02l2.31.513A1.5 1.5 0 0 1 18 13.352V14.5a1.5 1.5 0 0 1-1.5 1.5H15C8.096 16 2.5 10.404 2.5 3.5V3.5Z" />
    </svg>
  );
}

function SummaryChip({ label, value }: { label: string; value: number }) {
  return (
    <li className="rounded-control border border-border bg-surface px-2 py-0.5 text-muted-foreground">
      <span className="tabular font-semibold text-foreground">{value}</span> {label}
    </li>
  );
}

function Count({ n }: { n: number }) {
  return (
    <span className="tabular text-caption text-muted-foreground">
      {n} {n === 1 ? "record" : "records"}
    </span>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-body text-muted-foreground">{children}</p>;
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
    <tr className="h-row border-t border-border hover:bg-surface-subtle">
      <td className="tabular px-3 py-1 text-foreground">
        {incomplete ? (
          <span className="text-muted-foreground">
            In progress (started <Time iso={s.started_at} style="short" />)
          </span>
        ) : (
          <Time iso={s.completed_at} style="short" />
        )}
        {s.is_eval && (
          <span className="ml-2 rounded-control bg-surface-subtle px-1.5 py-0.5 text-caption text-muted-foreground">
            eval
          </span>
        )}
      </td>
      <td className="px-3 py-1">
        {typeof s.tier === "number" ? (
          <TierChip tier={s.tier} />
        ) : (
          <span className="text-caption text-muted-foreground">not yet evaluated</span>
        )}
      </td>
      <td className="px-3 py-1 text-muted-foreground">
        {s.consent_camera ? "Camera on" : "Camera off"}
      </td>
      <td className="px-3 py-1 text-muted-foreground">{vitalsStatusLabel(s.vitals_status)}</td>
      <td className="px-3 py-1 text-right">
        <Button asChild size="sm" variant="secondary">
          <Link to={checkinPath(s.id)}>Open</Link>
        </Button>
      </td>
    </tr>
  );
}
