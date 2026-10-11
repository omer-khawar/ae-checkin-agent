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
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { ErrorBanner } from "../../../components/ErrorBanner";
import { Pagination } from "../../../components/Pagination";
import { DEFAULT_PAGE_SIZE, getQueryCounts, listQueries } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { AGE_ALERT_HOURS, STATUS_LABELS } from "./model";
import { QueriesTable } from "./QueriesTable";
import { QueryPanel } from "./QueryPanel";
import { RaiseQueryForm } from "./RaiseQueryForm";
import { Button } from "@/ui/button";
import { isTypingTarget } from "@/ui/keyboard";
import { SegmentedControl } from "@/ui/segmented-control";
import { Sheet, SheetContent } from "@/ui/sheet";
import type { QueriesPage as QueriesPageData, QueryCounts, QueryStatus } from "../../../lib/types";

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

  const rows = page?.items ?? [];

  /** The next open query after the selected one (wraps to the first); null when none. */
  const nextOpenId = (() => {
    const open = rows.filter((r) => r.status === "open");
    if (open.length === 0) return null;
    const at = open.findIndex((r) => r.id === selectedId);
    const next = open[(at + 1) % open.length];
    return next && next.id !== selectedId ? next.id : null;
  })();

  const goNext = useCallback(() => {
    if (nextOpenId) updateParams({ q: nextOpenId });
  }, [nextOpenId, updateParams]);

  // "]" jumps to the next open query while the panel is open and nobody is typing.
  useEffect(() => {
    if (!selectedId) return;
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key !== "]" || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      e.preventDefault();
      goNext();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, goNext]);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-page font-semibold text-foreground">Sponsor queries</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            A query is a question the drug company sends back about a record the site entered, such
            as a missing dose or dates that do not add up; the site answers it and, if needed,
            corrects the record.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Ages turn red once an open query has waited more than {AGE_ALERT_HOURS} hours. Suggested
            answers are drafted from the record's evidence; a person reviews and sends every answer.
          </p>
        </div>
        {role === "admin" && !raising && (
          <Button onClick={() => setRaising(true)}>Raise query</Button>
        )}
      </header>

      {usubjid && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
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

      <SegmentedControl
        label="Query status"
        value={status}
        onValueChange={selectTab}
        options={TABS.map((t) => ({
          value: t,
          label: STATUS_LABELS[t],
          accessory: (
            <span className="tabular text-caption text-muted-foreground" data-testid={`count-${t}`}>
              {counts ? counts[t] : "–"}
            </span>
          ),
        }))}
      />

      <div id="query-tabpanel">
        <div className="overflow-hidden rounded-panel border border-border bg-surface">
          {error ? (
            <div className="p-4">
              <ErrorBanner error={error} message="Could not load queries" onRetry={reload} />
            </div>
          ) : loading && !page ? (
            <p className="p-4 text-sm text-muted-foreground" role="status">
              Loading queries…
            </p>
          ) : rows.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">{EMPTY_TEXT[status]}</p>
          ) : (
            <>
              <QueriesTable
                rows={rows}
                selectedId={selectedId}
                onSelect={(id) => updateParams({ q: id })}
                nowMs={nowMs}
              />
              {page && page.total > page.limit && (
                <div className="border-t border-border p-3">
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
        </div>

        <Sheet open={Boolean(selectedId)} onOpenChange={(o) => !o && updateParams({ q: null })}>
          <SheetContent size="lg">
            {selectedId && (
              <QueryPanel
                key={selectedId}
                queryId={selectedId}
                role={role}
                nowMs={nowMs}
                onChanged={reload}
                onDismiss={() => updateParams({ q: null })}
                onNext={nextOpenId ? goNext : null}
              />
            )}
          </SheetContent>
        </Sheet>
      </div>
    </div>
  );
}

export { QueriesPage };
