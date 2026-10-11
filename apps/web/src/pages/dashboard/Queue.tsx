/**
 * /dashboard — the coordinator queue (CLAUDE.md §3.7.1, CONTRACTS §2.2 + R2.4).
 *
 * - Rows come from GET /queue in server order (tier desc, completed_at desc) and
 *   are never re-sorted here; the heading says so.
 * - Filters live in the URL search params so the back button and a shared link
 *   restore them. Participant text is resolved to a USUBJID through
 *   GET /participants when it matches a display label.
 * - Auto-refreshes every 15 s (visible "updated hh:mm:ss"), and raises a toast
 *   when a Tier 3 item that was not in the previous fetch appears: that is the
 *   dashboard half of the mock pager.
 * - Every countdown chip ticks from one shared clock (`useNow`).
 * - Stage 2 (CONTRACTS R3.3 / R4): a "Since you were last here" row on top
 *   (`queue/SinceLastHere`), serious-event vs special-interest report chips,
 *   a "Phone call" source, and a "Brief" link per participant. Plain language
 *   leads; SDTM codes and tier numbers stay one step deeper.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { Button } from "@/ui/button";
import { Kbd } from "@/ui/kbd";
import { isTypingTarget } from "@/ui/keyboard";
import { notify } from "@/ui/toast";
import { CheckCheck, RefreshCw } from "lucide-react";

import { ErrorBanner } from "../../components/ErrorBanner";
import { Pagination } from "../../components/Pagination";
import { useToast } from "../../components/Toast";
import { DEFAULT_PAGE_SIZE, fetchAllPages, listParticipants } from "../../lib/api";
import { formatLocal, formatUtc } from "../../lib/format";
import type { Participant } from "../../lib/types";
import { BulkConfirmSheet } from "./queue/BulkConfirmSheet";
import { draftTotal } from "./queue/bulk";
import { buildQueueQuery, hasNarrowingFilter, inView } from "./queue/normalize";
import { SinceLastHere } from "./queue/SinceLastHere";
import { QueueFilters } from "./queue/QueueFilters";
import { QueueTable } from "./queue/QueueTable";
import { countLabel } from "./queue/summary";
import type { QueueFilterState, QueueRow, QueueView } from "./queue/types";
import { useNow } from "./queue/useNow";
import { DEFAULT_REFRESH_MS, useQueuePolling } from "./queue/useQueuePolling";

export interface QueueProps {
  /** Auto-refresh period; tests pass a short one. */
  refreshIntervalMs?: number;
  pageSize?: number;
}

// ---------------------------------------------------------------------------
// URL ⇄ filter state
// ---------------------------------------------------------------------------

function readFilters(sp: URLSearchParams): QueueFilterState {
  const minTier = Number.parseInt(sp.get("min_tier") ?? "0", 10);
  const offset = Number.parseInt(sp.get("offset") ?? "0", 10);
  const view = sp.get("view");
  return {
    view: view === "needs" || view === "serious" || view === "notes" ? view : "all",
    participant: sp.get("participant") ?? "",
    minTier: Number.isFinite(minTier) && minTier >= 1 && minTier <= 3 ? minTier : 0,
    status: sp.get("status") === "all" ? "all" : "open",
    includeEval: sp.get("include_eval") === "true",
    offset: Number.isFinite(offset) && offset > 0 ? offset : 0,
  };
}

/** Only non-default values are written, so the default queue URL stays clean. */
function writeFilters(f: QueueFilterState): URLSearchParams {
  const sp = new URLSearchParams();
  if (f.view !== "all") sp.set("view", f.view);
  if (f.participant) sp.set("participant", f.participant);
  if (f.minTier > 0) sp.set("min_tier", String(f.minTier));
  if (f.status !== "open") sp.set("status", f.status);
  if (f.includeEval) sp.set("include_eval", "true");
  if (f.offset > 0) sp.set("offset", String(f.offset));
  return sp;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function Queue({
  refreshIntervalMs = DEFAULT_REFRESH_MS,
  pageSize = DEFAULT_PAGE_SIZE,
}: QueueProps = {}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => readFilters(searchParams), [searchParams]);
  const toast = useToast();

  const patchFilters = useCallback(
    (patch: Partial<QueueFilterState>) => {
      setSearchParams(writeFilters({ ...readFilters(searchParams), ...patch }), {
        replace: true,
      });
    },
    [searchParams, setSearchParams],
  );

  // Participants feed the filter datalist and the label → USUBJID resolution.
  // A failure here only degrades the datalist; the queue still loads.
  const [participants, setParticipants] = useState<Participant[]>([]);
  // Settled (ok or failed) once; see `queueEnabled` below.
  const [participantsReady, setParticipantsReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetchAllPages((limit, offset) => listParticipants({ limit, offset }), 100, 5)
      .then((list) => {
        if (!cancelled) setParticipants(list);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setParticipantsReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // CONTRACTS R2.3 only promises display-label resolution for POST /sessions,
  // so GET /queue must receive a USUBJID. A deep link such as
  // ?participant=P-007 therefore waits for the participants list before the
  // first fetch, instead of sending usubjid=P-007 and flashing an empty result.
  // With no participant filter there is nothing to resolve and the fetch starts
  // immediately; if the list fails to load, the typed text is sent as-is.
  const queueEnabled = participantsReady || !filters.participant.trim();

  const query = useMemo(
    () => buildQueueQuery(filters, participants, pageSize),
    [filters, participants, pageSize],
  );

  // Mock pager, dashboard side: a Tier 3 row that was not in the previous fetch
  // of the same query is a new urgent item (for a check-in, the API already
  // wrote the page event and the kiosk showed the stop screen). Title and body
  // both name the item's real source: check-in, chart note or phone call.
  const onRefresh = useCallback(
    (next: QueueRow[], prev: QueueRow[]) => {
      const seen = new Set(prev.map((r) => r.key));
      for (const row of next) {
        if (row.tier === 3 && !seen.has(row.key)) {
          toast.push({
            kind: "warning",
            title: `Page: new urgent ${SOURCE_WORD[row.source]} (Tier 3)`,
            message: `${row.display_label} · ${SOURCE_WORD[row.source]} completed ${formatLocal(row.completed_at, "time") || "just now"}. Open the queue row to acknowledge.`,
            durationMs: 15_000,
          });
        }
      }
    },
    [toast],
  );

  const { data, error, loading, refreshing, updatedAt, refresh } = useQueuePolling(query, {
    intervalMs: refreshIntervalMs,
    onRefresh,
    enabled: queueEnabled,
  });

  const anyClock = Boolean(data?.items.some((r) => r.clocks.some((c) => !c.stopped)));
  const now = useNow(anyClock);

  const allRows = useMemo(() => data?.items ?? [], [data]);
  const rows = useMemo(
    () => allRows.filter((r) => inView(r, filters.view)),
    [allRows, filters.view],
  );
  const counts = useMemo(() => {
    const out: Record<QueueView, number> = { all: 0, needs: 0, serious: 0, notes: 0 };
    for (const v of ["all", "needs", "serious", "notes"] as const) {
      out[v] = allRows.filter((r) => inView(r, v)).length;
    }
    return out;
  }, [allRows]);

  // The Refresh button re-counts the "since you were last here" row too.
  const [summaryKey, setSummaryKey] = useState(0);
  const refreshAll = useCallback(() => {
    refresh();
    setSummaryKey((k) => k + 1);
  }, [refresh]);

  // Bulk review: ticked rows -> confirmation sheet -> existing confirm endpoint per draft.
  const [selection, setSelection] = useState<Record<string, boolean>>({});
  const [sheetOpen, setSheetOpen] = useState(false);
  const selectedRows = useMemo(() => rows.filter((r) => selection[r.key]), [rows, selection]);

  // Page shortcuts: c = confirm drafts of the ticked rows, r = refresh. (j/k/Enter/x/Esc
  // live in the table.) Ignored while typing, with a modifier, or while a dialog is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (isTypingTarget(e.target)) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (e.key === "c" && selectedRows.length > 0) {
        e.preventDefault();
        setSheetOpen(true);
      } else if ((e.key === "j" || e.key === "k") && e.target === document.body) {
        // From the page body, j/k enters the table at the first row.
        const first = document.querySelector<HTMLElement>("tbody tr[data-row-id]");
        if (first) {
          e.preventDefault();
          first.focus();
        }
      } else if (e.key === "r") {
        e.preventDefault();
        refreshAll();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedRows.length, refreshAll]);

  const empty =
    data && rows.length === 0 ? <EmptyState filters={filters} total={data.total} /> : undefined;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h1 className="text-lg font-semibold text-foreground">Queue</h1>
        <div className="flex items-center gap-2 text-body text-muted-foreground">
          <span
            className="tabular"
            title={
              updatedAt
                ? `Last successful fetch ${formatUtc(updatedAt)} (UTC). Auto-refreshes every ${Math.round(refreshIntervalMs / 1000)} s.`
                : "Waiting for the first fetch"
            }
            // Deliberately NOT aria-live: it changes every 15 s and would
            // interrupt a screen-reader user for as long as the page is open.
          >
            {updatedAt ? `updated ${formatLocal(updatedAt, "time")}` : "not yet updated"}
            {refreshing && <span className="ml-1 text-subtle-foreground">· refreshing…</span>}
          </span>
          <Button
            size="sm"
            variant="secondary"
            onClick={refreshAll}
            loading={loading}
            leadingIcon={<RefreshCw />}
          >
            Refresh
          </Button>
        </div>
      </div>

      <SinceLastHere refreshKey={summaryKey} />

      <QueueFilters
        value={filters}
        participants={participants}
        onChange={patchFilters}
        counts={data ? counts : undefined}
      />

      {error ? (
        <ErrorBanner
          error={error}
          message={
            data
              ? "Could not refresh the queue; showing the last result"
              : "Could not load the queue"
          }
          onRetry={refreshAll}
        />
      ) : null}

      {loading ? (
        <div
          className="rounded-panel border border-border bg-surface px-4 py-12 text-center text-muted-foreground"
          role="status"
        >
          Loading queue…
        </div>
      ) : data && data.items.length === 0 ? (
        <div className="rounded-panel border border-border bg-surface">{empty}</div>
      ) : data ? (
        <>
          <QueueTable
            rows={rows}
            now={now}
            refreshing={refreshing}
            selection={selection}
            onSelectionChange={setSelection}
            emptyState={empty}
            bulkActions={({ rows: picked }) => (
              <Button
                size="sm"
                variant="primary"
                leadingIcon={<CheckCheck />}
                onClick={() => setSheetOpen(true)}
                title="Confirm every unconfirmed draft on the ticked items (shortcut: c)"
              >
                {`Confirm all drafts (${picked.reduce((n, r) => n + draftTotal(r), 0)})`}
              </Button>
            )}
          />
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted-foreground">
              <span>
                Order from the rules engine: most urgent first, then most recent. Sorting a column
                reorders this page only.
              </span>
              <span className="inline-flex items-center gap-1">
                <Kbd size="sm">j</Kbd>
                <Kbd size="sm">k</Kbd> move
              </span>
              <span className="inline-flex items-center gap-1">
                <Kbd size="sm">Enter</Kbd> open
              </span>
              <span className="inline-flex items-center gap-1">
                <Kbd size="sm">x</Kbd> select
              </span>
              <span className="inline-flex items-center gap-1">
                <Kbd size="sm">c</Kbd> confirm selected
              </span>
              <span className="inline-flex items-center gap-1">
                <Kbd size="sm">r</Kbd> refresh
              </span>
            </p>
            <Pagination
              total={data.total}
              limit={data.limit || pageSize}
              offset={data.offset}
              onChange={({ offset }) => patchFilters({ offset })}
            />
          </div>
        </>
      ) : null}

      <BulkConfirmSheet
        open={sheetOpen}
        rows={selectedRows}
        onOpenChange={setSheetOpen}
        onDone={(result, itemCount) => {
          setSelection({});
          refreshAll();
          const items = countLabel(itemCount, "item");
          if (result.failed === 0) {
            notify.success(`Confirmed ${countLabel(result.confirmed, "draft")}`, {
              description: `Across ${items}. Each confirmation is in the audit log.`,
            });
          } else {
            notify.warning(
              `Confirmed ${result.confirmed}, ${result.failed} could not be confirmed`,
              {
                description: "Open the items that remain in the queue and confirm them one by one.",
              },
            );
          }
        }}
      />
    </div>
  );
}

/**
 * Empty result, explained. The copy names the actual cause: a narrowing filter
 * (participant / minimum tier), the default "open only" view, or a queue that
 * really has nothing in it. Saying "nothing recorded" under an active filter
 * would be false.
 */
function EmptyState({ filters, total }: { filters: QueueFilterState; total: number }) {
  if (total > 0 && filters.view !== "all") {
    return (
      <p className="text-body">
        Nothing on this page fits this view. Switch to All to see every item.
      </p>
    );
  }
  const narrowed = hasNarrowingFilter(filters);
  let detail: string;
  if (narrowed) {
    detail =
      filters.status === "open"
        ? "No open items for this participant / minimum tier. Switch Status to All to include confirmed and rejected ones, or Clear filters to see everything."
        : "No items for this participant / minimum tier. Clear filters to see everything.";
  } else if (filters.status === "open") {
    detail =
      "Open items are check-ins, chart notes and phone calls with drafts still awaiting review. Switch Status to All to see confirmed and rejected ones.";
  } else {
    detail = "Nothing has been recorded yet. Start a check-in from the kiosk.";
  }
  return (
    <div className="px-4 py-10 text-center text-muted-foreground" role="status">
      <p className="font-medium text-foreground">
        {narrowed || filters.status === "open"
          ? "No items match these filters."
          : "The queue is empty."}
      </p>
      <p className="mt-1 text-sm">{detail}</p>
    </div>
  );
}

/** Lower-case source words for the pager toast (title and body). */
const SOURCE_WORD: Record<QueueRow["source"], string> = {
  check_in: "check-in",
  chart_note: "chart note",
  phone_call: "phone call",
};
