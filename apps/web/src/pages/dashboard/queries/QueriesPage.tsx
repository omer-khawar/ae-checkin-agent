/**
 * Sponsor queries, `/dashboard/queries` (CONTRACTS.md R4.4; step 7 of the life
 * of a side effect in CLAUDE.md §00).
 *
 * After the site posts records to the sponsor's EDC, the sponsor's data checks
 * and monitors send questions back ("queries"). Interim lists them by status,
 * shows how long each has waited, and for each one shows the record field, its
 * evidence, and a suggested answer assembled by the template writer from that
 * evidence. A person edits and sends the answer; nothing is sent automatically.
 *
 * URL state (so other pages can deep-link): `?status=open|answered|closed`,
 * `?q=<query id>` for the open side panel, `?usubjid=` to filter one participant.
 *
 * Roles: coordinator, investigator and admin can answer; admin, acting as the
 * sponsor's monitor, can also raise and close queries. The API enforces this.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useSearchParams } from "react-router-dom";

import { Button } from "../../../components/Button";
import { Card } from "../../../components/Card";
import { ErrorBanner } from "../../../components/ErrorBanner";
import { Pagination } from "../../../components/Pagination";
import { DEFAULT_PAGE_SIZE } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { cx } from "../../../lib/format";
import { AGE_ALERT_HOURS, STATUS_LABELS } from "./model";
import { QueriesTable } from "./QueriesTable";
import { getQueryCounts, listQueries } from "./queriesApi";
import { QueryPanel } from "./QueryPanel";
import { RaiseQueryForm } from "./RaiseQueryForm";
import type { QueriesPage as QueriesPageData, QueryCounts, QueryStatus } from "./types";

const TABS: QueryStatus[] = ["open", "answered", "closed"];

const EMPTY_TEXT: Record<QueryStatus, string> = {
  open: "No open queries. Nothing is waiting on the site.",
  answered: "No answered queries waiting for the sponsor to close them.",
  closed: "No closed queries yet.",
};

function isStatus(x: string | null): x is QueryStatus {
  return x === "open" || x === "answered" || x === "closed";
}

/** Minute-resolution clock for the age column (ages are shown in whole hours). */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

export default function QueriesPage() {
  const { role } = useAuth();
  const [params, setParams] = useSearchParams();
  const status: QueryStatus = isStatus(params.get("status"))
    ? (params.get("status") as QueryStatus)
    : "open";
  const selectedId = params.get("q");
  const usubjid = params.get("usubjid") ?? undefined;

  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<QueriesPageData | null>(null);
  const [counts, setCounts] = useState<QueryCounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [raising, setRaising] = useState(false);
  const nowMs = useMinuteClock();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const updateParams = useCallback(
    (patch: Record<string, string | null>) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v === null) next.delete(k);
            else next.set(k, v);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const p = await listQueries(
          { status, usubjid, limit: DEFAULT_PAGE_SIZE, offset },
          ctrl.signal,
        );
        if (ctrl.signal.aborted) return;
        setPage(p);
        try {
          const c = await getQueryCounts(usubjid, p.counts, ctrl.signal);
          if (!ctrl.signal.aborted) setCounts(c);
        } catch {
          // Counts are a convenience; the list still renders without them.
          if (!ctrl.signal.aborted) setCounts(null);
        }
      } catch (e) {
        if (!ctrl.signal.aborted) {
          setPage(null);
          setError(e);
        }
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    })();
    return () => ctrl.abort();
  }, [status, usubjid, offset, reloadKey]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  /** Switch tab: back to the first page, panel closed. */
  function selectTab(t: QueryStatus) {
    setOffset(0);
    updateParams({ status: t, q: null });
  }

  function onTabKey(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const next = (i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length;
    selectTab(TABS[next]);
    tabRefs.current[next]?.focus();
  }

  const rows = page?.items ?? [];

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-slate-900">Sponsor queries</h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-600">
            A query is a question the drug company sends back about a record the site entered, such
            as a missing dose or dates that do not add up; the site answers it and, if needed,
            corrects the record.
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Ages turn red once an open query has waited more than {AGE_ALERT_HOURS} hours. Suggested
            answers are drafted from the record's evidence; a person reviews and sends every answer.
          </p>
        </div>
        {role === "admin" && !raising && (
          <Button onClick={() => setRaising(true)}>Raise query</Button>
        )}
      </header>

      {usubjid && (
        <div className="flex items-center gap-2 text-sm text-slate-700">
          <span>
            Showing one participant only: <span className="font-mono text-xs">{usubjid}</span>
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setOffset(0);
              updateParams({ usubjid: null, q: null });
            }}
          >
            Show everyone
          </Button>
        </div>
      )}

      {raising && role === "admin" && (
        <RaiseQueryForm
          onCancel={() => setRaising(false)}
          onRaised={(row) => {
            setRaising(false);
            setOffset(0);
            updateParams({ status: "open", q: row?.id ?? null });
            reload();
          }}
        />
      )}

      <div
        role="tablist"
        aria-label="Query status"
        className="flex gap-1 border-b border-slate-200"
      >
        {TABS.map((t, i) => {
          const active = t === status;
          return (
            <button
              key={t}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`query-tab-${t}`}
              aria-selected={active}
              aria-controls="query-tabpanel"
              tabIndex={active ? 0 : -1}
              onClick={() => selectTab(t)}
              onKeyDown={(e) => onTabKey(e, i)}
              className={cx(
                "-mb-px rounded-t-lg border-b-2 px-4 py-2 text-sm font-medium focus-visible:ring-2",
                active
                  ? "border-brand-700 text-brand-900"
                  : "border-transparent text-slate-600 hover:text-slate-900",
              )}
            >
              {STATUS_LABELS[t]}
              <span
                className="tnum ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700"
                data-testid={`count-${t}`}
              >
                {counts ? counts[t] : "–"}
              </span>
            </button>
          );
        })}
      </div>

      <div
        id="query-tabpanel"
        role="tabpanel"
        aria-labelledby={`query-tab-${status}`}
        className={cx("grid gap-4", selectedId && "xl:grid-cols-[minmax(0,1fr)_30rem]")}
      >
        <Card flush>
          {error ? (
            <div className="p-4">
              <ErrorBanner error={error} message="Could not load queries" onRetry={reload} />
            </div>
          ) : loading && !page ? (
            <p className="p-4 text-sm text-slate-500" role="status">
              Loading queries…
            </p>
          ) : rows.length === 0 ? (
            <p className="p-6 text-center text-sm text-slate-600">{EMPTY_TEXT[status]}</p>
          ) : (
            <>
              <QueriesTable
                rows={rows}
                selectedId={selectedId}
                onSelect={(id) => updateParams({ q: id })}
                nowMs={nowMs}
              />
              {page && page.total > page.limit && (
                <div className="border-t border-slate-200 p-3">
                  <Pagination
                    total={page.total}
                    limit={page.limit}
                    offset={page.offset}
                    onChange={(n) => setOffset(n.offset)}
                  />
                </div>
              )}
            </>
          )}
        </Card>

        {selectedId && (
          <QueryPanel
            key={selectedId}
            queryId={selectedId}
            role={role}
            nowMs={nowMs}
            onChanged={reload}
            onDismiss={() => updateParams({ q: null })}
          />
        )}
      </div>
    </div>
  );
}

export { QueriesPage };
