/**
 * /dashboard/participants/:usubjid/brief — the visit-prep brief
 * (CLAUDE.md §00.4, step 8 of the life of a side effect; CONTRACTS.md R3.2/R3.3).
 *
 * One printable page for the investigator before the next visit: everything
 * since the cut-off date (default: the previous visit, chosen by the API),
 * grouped into the API's sections, a "questions to ask" checklist, and a
 * narrative paragraph whose every sentence cites its evidence.
 *
 * Plain language leads. Rule ids, SDTM names, section keys and full evidence
 * ids stay one click deeper behind "Show technical ids".
 *
 * Click-to-evidence: every line's text links to its record (when the API gives
 * a link) and every evidence chip highlights all lines on the page that cite
 * the same record, with a bar at the top naming it.
 *
 * Printing: "Print" calls window.print() (the user's own browser); the injected
 * print CSS hides the nav and controls but keeps the not-a-medical-device
 * footer. "Open printable version" fetches the server-rendered HTML
 * (GET /participants/{usubjid}/brief/print) with the bearer token and opens it
 * in a new tab as a blob URL, with a script-blocking CSP put first in the
 * document (a blob URL inherits this origin). The API's printable page must
 * therefore be fully escaped and self-contained (inline CSS, no scripts, no
 * relative assets).
 *
 * Nothing on this page decides anything; it shows what the API's rules decided.
 */
import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";

import { Button } from "../../../components/Button";
import { Card } from "../../../components/Card";
import { ErrorBanner } from "../../../components/ErrorBanner";
import { isApiError } from "../../../lib/api";
import { Time } from "../../../lib/format";
import { getBrief, getBriefPrintHtml } from "./briefApi";
import { BriefSectionCard } from "./BriefSectionCard";
import {
  countCiters,
  evidenceKindLabel,
  formatDay,
  isEmptyBrief,
  safeLink,
  summaryLine,
  toDateInput,
  withRestrictiveCsp,
} from "./model";
import { NarrativePanel } from "./NarrativePanel";
import { PRINT_CSS } from "./printCss";
import { QuestionsChecklist } from "./QuestionsChecklist";
import type { Brief } from "./types";

type LoadState =
  | { status: "loading"; brief: Brief | null }
  | { status: "ok"; brief: Brief }
  | { status: "error"; brief: Brief | null; error: unknown };

/** Today as YYYY-MM-DD in local time (the date picker's max). */
function todayLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default function BriefPage() {
  const { usubjid = "" } = useParams<{ usubjid: string }>();
  const [params, setParams] = useSearchParams();
  const sinceParam = params.get("since");
  const since = sinceParam && DATE_RE.test(sinceParam) ? sinceParam : null;

  const [state, setState] = useState<LoadState>({ status: "loading", brief: null });
  const [reloadKey, setReloadKey] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [showTechnical, setShowTechnical] = useState(false);
  const [printBusy, setPrintBusy] = useState(false);
  const [printError, setPrintError] = useState<unknown>(null);
  /** Blob URL of the printable HTML when the browser blocked the new tab. */
  const [blockedUrl, setBlockedUrl] = useState<string | null>(null);
  const blobUrls = useRef<string[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);

  // ---- load (re-runs when the participant, the cut-off or "retry" changes) ----
  useEffect(() => {
    if (!usubjid) return;
    const ctrl = new AbortController();
    // Keep the previous brief on screen while a new cut-off loads (no flash).
    setState((prev) => ({ status: "loading", brief: prev.brief }));
    getBrief(usubjid, { since, signal: ctrl.signal })
      .then((brief) => {
        if (!ctrl.signal.aborted) setState({ status: "ok", brief });
      })
      .catch((error: unknown) => {
        if (ctrl.signal.aborted) return;
        setState((prev) => ({ status: "error", brief: prev.brief, error }));
      });
    return () => ctrl.abort();
  }, [usubjid, since, reloadKey]);

  // A new brief means the old evidence selection may not exist any more.
  useEffect(() => {
    setSelected(null);
  }, [usubjid, since]);

  // Revoke any blob URLs we created when the page goes away.
  useEffect(() => {
    const urls = blobUrls.current;
    return () => {
      for (const u of urls) URL.revokeObjectURL(u);
    };
  }, []);

  // Escape clears the evidence highlight.
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  // Bring the first line citing the selected evidence into view.
  useEffect(() => {
    if (!selected) return;
    const el = rootRef.current?.querySelector<HTMLElement>('[data-cited="true"]');
    el?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [selected]);

  const onSelectEvidence = useCallback((id: string) => {
    setSelected((cur) => (cur === id ? null : id));
  }, []);

  const onSinceChange = (e: ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    if (!v) {
      clearSince();
      return;
    }
    if (!DATE_RE.test(v)) return; // partial typing in browsers without a picker
    const next = new URLSearchParams(params);
    next.set("since", v);
    setParams(next, { replace: true });
  };

  function clearSince() {
    const next = new URLSearchParams(params);
    next.delete("since");
    setParams(next, { replace: true });
  }

  async function openPrintable() {
    setPrintBusy(true);
    setPrintError(null);
    setBlockedUrl(null);
    try {
      const html = await getBriefPrintHtml(usubjid, { since });
      // The blob: URL shares this page's origin (and its sessionStorage token),
      // so the printable HTML is opened with scripts disabled by a CSP <meta>,
      // whatever the server sent. The page must be self-contained: relative
      // links and assets do not resolve against a blob: URL.
      const url = URL.createObjectURL(new Blob([withRestrictiveCsp(html)], { type: "text/html" }));
      blobUrls.current.push(url);
      const win = window.open(url, "_blank");
      if (!win) setBlockedUrl(url);
    } catch (e) {
      setPrintError(e);
    } finally {
      setPrintBusy(false);
    }
  }

  // ---- render ----
  const brief = state.brief;

  if (!usubjid) {
    return <ErrorBanner error="No participant id in the address." message="Missing participant" />;
  }

  if (!brief) {
    if (state.status === "error") {
      const notFound = isApiError(state.error) && state.error.isNotFound;
      return (
        <div className="space-y-4" data-brief-root>
          <ErrorBanner
            error={state.error}
            message={
              notFound
                ? `No participant found for “${usubjid}”`
                : `Could not build the visit brief for ${usubjid}`
            }
            onRetry={notFound ? undefined : () => setReloadKey((k) => k + 1)}
          />
          <Link to="/dashboard" className="text-sm text-brand-700 underline">
            Back to the queue
          </Link>
        </div>
      );
    }
    return (
      <Card>
        <div role="status" aria-busy="true" className="flex items-center gap-3 text-slate-700">
          <span
            aria-hidden="true"
            className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-brand-700 border-t-transparent"
          />
          Building the visit brief for <span className="font-mono">{usubjid}</span>…
        </div>
      </Card>
    );
  }

  const sinceValue = since ?? toDateInput(brief.since);
  const selectedRef = selected ? brief.evidence?.[selected] : undefined;
  // Only in-app routes and http(s) URLs become links (no javascript:, data:, …).
  const selectedLink = safeLink(selectedRef?.link);
  const selectedCount = selected ? countCiters(brief, selected) : 0;
  const empty = isEmptyBrief(brief);

  return (
    <div ref={rootRef} className="space-y-5" data-brief-root>
      <style>{PRINT_CSS}</style>

      {/* ---- header ---- */}
      <header className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Visit brief
            </p>
            <h1 className="text-2xl font-bold text-slate-900">
              {brief.display_label}
              {brief.display_label !== brief.usubjid && (
                <span className="ml-2 align-middle font-mono text-xs font-normal text-slate-500">
                  {brief.usubjid}
                </span>
              )}
            </h1>
            <p className="mt-0.5 text-sm text-slate-700">
              Since <strong>{brief.since ? formatDay(brief.since) : "the last visit"}</strong>
              {brief.next_visit && (
                <>
                  {" "}
                  · next visit <strong>{formatDay(brief.next_visit)}</strong>
                </>
              )}
              {brief.generated_at && (
                <>
                  {" "}
                  · generated <Time iso={brief.generated_at} style="short" />
                </>
              )}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2" data-print-hide>
            <Button variant="secondary" size="sm" onClick={() => window.print()}>
              Print
            </Button>
            <Button variant="secondary" size="sm" busy={printBusy} onClick={openPrintable}>
              Open printable version
            </Button>
            <Link
              to={`/dashboard/participants/${encodeURIComponent(usubjid)}`}
              className="rounded px-2 py-1 text-sm text-brand-700 underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              Participant timeline
            </Link>
          </div>
        </div>

        <p className="rounded-xl border border-brand-200 bg-brand-50 px-4 py-3 text-base text-slate-900 print:border-slate-300 print:bg-white">
          {summaryLine(brief)}
        </p>

        {/* Print-only context lines (the dashboard header with this note is hidden in print). */}
        <p className="hidden text-xs text-slate-600 print:block">
          All participants are synthetic. Grades are provisional; the investigator confirms.
        </p>

        <div
          className="flex flex-wrap items-end gap-x-4 gap-y-2 text-sm text-slate-700"
          data-print-hide
        >
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-slate-600">Show everything since</span>
            <input
              type="date"
              value={sinceValue}
              max={todayLocal()}
              onChange={onSinceChange}
              className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            />
          </label>
          {since && (
            <Button variant="ghost" size="sm" onClick={clearSince}>
              Use the last visit date
            </Button>
          )}
          <label className="flex items-center gap-2 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={showTechnical}
              onChange={(e) => setShowTechnical(e.target.checked)}
              className="h-4 w-4 rounded border-slate-400"
            />
            Show technical ids
          </label>
          {state.status === "loading" && (
            <span role="status" className="text-xs text-slate-500">
              Updating…
            </span>
          )}
        </div>

        {state.status === "error" && (
          <ErrorBanner
            error={state.error}
            message="Could not refresh the brief; showing the previous one"
            onRetry={() => setReloadKey((k) => k + 1)}
          />
        )}
        {printError !== null && (
          <ErrorBanner error={printError} message="Could not open the printable version" />
        )}
        {blockedUrl && (
          <p className="text-sm text-slate-700" data-print-hide>
            Your browser blocked the new tab.{" "}
            <a
              href={blockedUrl}
              target="_blank"
              rel="noreferrer"
              className="text-brand-700 underline"
            >
              Open the printable version
            </a>
          </p>
        )}
      </header>

      {/* ---- evidence selection bar ---- */}
      {selected && (
        <div
          className="sticky top-2 z-10 flex flex-wrap items-center gap-3 rounded-xl border border-brand-300 bg-white px-4 py-2 text-sm shadow-card"
          data-print-hide
          aria-live="polite"
        >
          <span>
            Highlighting {selectedCount} {selectedCount === 1 ? "line" : "lines"} that cite{" "}
            <strong>{evidenceKindLabel(selected, selectedRef)}</strong>{" "}
            <span className="font-mono text-xs">{selected}</span>
            {selectedRef?.ts && (
              <>
                {" "}
                · <Time iso={selectedRef.ts} style="short" />
              </>
            )}
            {selectedRef?.note && <span className="text-slate-600"> · “{selectedRef.note}”</span>}
          </span>
          {selectedLink &&
            (selectedLink.kind === "internal" ? (
              <Link to={selectedLink.to} className="text-brand-700 underline">
                Open the source record
              </Link>
            ) : (
              <a
                href={selectedLink.href}
                target="_blank"
                rel="noreferrer"
                className="text-brand-700 underline"
              >
                Open the source record
              </a>
            ))}
          <Button variant="ghost" size="sm" onClick={() => setSelected(null)} className="ml-auto">
            Clear (Esc)
          </Button>
        </div>
      )}

      {empty && (
        <p className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">
          Nothing new was recorded{brief.since ? ` since ${formatDay(brief.since)}` : ""}. Pick an
          earlier date to see more.
        </p>
      )}

      {/* ---- body: sections left, questions + narrative right ---- */}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] print:block print:space-y-4">
        <div className="space-y-4">
          {brief.sections.map((section, i) => (
            <BriefSectionCard
              key={`${section.key}-${i}`}
              section={section}
              index={i}
              since={brief.since}
              selected={selected}
              onSelectEvidence={onSelectEvidence}
              evidence={brief.evidence}
              showTechnical={showTechnical}
            />
          ))}
        </div>
        <div className="space-y-4">
          <QuestionsChecklist
            key={`${brief.usubjid}-${brief.since ?? ""}`}
            questions={brief.questions_to_ask}
            selected={selected}
            onSelectEvidence={onSelectEvidence}
            evidence={brief.evidence}
            showTechnical={showTechnical}
          />
          <NarrativePanel
            narrative={brief.narrative}
            selected={selected}
            onSelectEvidence={onSelectEvidence}
            evidence={brief.evidence}
            showTechnical={showTechnical}
          />
        </div>
      </div>
    </div>
  );
}
