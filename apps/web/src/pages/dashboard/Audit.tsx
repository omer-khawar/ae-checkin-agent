/**
 * /dashboard/audit — the append-only, hash-chained event log with a verify
 * badge (CLAUDE.md §3.6, §3.7.5; CONTRACTS.md §2.2 `GET /audit`, `GET /audit/verify`).
 *
 * Layout: Verify panel on top, then the exports card (exports are audited, so
 * they belong next to the log), then filters + the event table + pagination.
 *
 * Filtering: `entity_type`, `entity_id` and `action` all go to the server
 * (`routers/audit.py` matches each exactly), so a filter searches the whole log,
 * not the current page. The action box offers a datalist of every action the
 * API emits because the match is exact.
 *
 * Refetching (Verify, an export, Refresh) keeps the current table on screen and
 * shows a small "Refreshing…" status, so expanded payloads do not collapse and
 * the viewport does not jump mid-demo. Only the first load shows the loading row.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import { Button } from "@/pages/admin/SysUI";
import { Panel as Card, PageHead } from "@/pages/admin/SysUI";
import { ErrorBanner } from "../../components/ErrorBanner";
import { Pagination } from "../../components/Pagination";
import { DEFAULT_PAGE_SIZE, listAudit } from "../../lib/api";
import type { AuditEvent, Paginated } from "../../lib/types";
import { KNOWN_ACTIONS, KNOWN_ENTITY_TYPES, sortNewestFirst } from "./audit/auditLib";
import { EventsTable } from "./audit/EventsTable";
import { ExportsCard } from "./audit/ExportsCard";
import { VerifyPanel } from "./audit/VerifyPanel";

interface ServerQuery {
  entity_type: string;
  entity_id: string;
  action: string;
  limit: number;
  offset: number;
}

const PAGE_SIZES = [25, 50, 100] as const;

export function Audit() {
  // Server-side query (drives the fetch). Draft inputs live separately so typing
  // does not refetch until the form is submitted.
  const [query, setQuery] = useState<ServerQuery>({
    entity_type: "",
    entity_id: "",
    action: "",
    limit: DEFAULT_PAGE_SIZE,
    offset: 0,
  });
  const [draftType, setDraftType] = useState("");
  const [draftId, setDraftId] = useState("");
  const [draftAction, setDraftAction] = useState("");

  const [data, setData] = useState<Paginated<AuditEvent> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listAudit({
      entity_type: query.entity_type,
      entity_id: query.entity_id,
      action: query.action,
      limit: query.limit,
      offset: query.offset,
    })
      .then((page) => {
        if (cancelled) return;
        setData(page);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [query, reloadKey]);

  const sorted = useMemo(() => (data ? sortNewestFirst(data.items ?? []) : []), [data]);

  function applyFilters(ev: FormEvent) {
    ev.preventDefault();
    setQuery((q) => ({
      ...q,
      entity_type: draftType.trim(),
      entity_id: draftId.trim(),
      action: draftAction.trim(),
      offset: 0,
    }));
  }

  function clearFilters() {
    setDraftType("");
    setDraftId("");
    setDraftAction("");
    setQuery((q) => ({ ...q, entity_type: "", entity_id: "", action: "", offset: 0 }));
  }

  const serverFiltered = Boolean(query.entity_type || query.entity_id || query.action);
  const total = data?.total ?? 0;
  // First load vs. a refetch with a table already on screen.
  const initialLoading = loading && data === null;
  const refreshing = loading && data !== null;

  return (
    <div className="space-y-4">
      <PageHead
        title="Audit trail"
        actions={
          <Button variant="secondary" size="sm" onClick={reload} disabled={loading}>
            Refresh events
          </Button>
        }
      >
        Append-only log of every answer, vitals batch, rule firing, edit, confirmation, page and
        export (ALCOA+). Edits never overwrite; they add a version and an event.
      </PageHead>

      <VerifyPanel onVerified={reload} />

      <ExportsCard onExported={reload} />

      <Card
        title="Events"
        aside={
          <span className="tnum flex items-center gap-2 text-table text-muted-foreground">
            {refreshing && (
              <span
                role="status"
                className="text-caption text-muted-foreground"
                data-testid="events-refreshing"
              >
                Refreshing…
              </span>
            )}
            <span data-testid="events-total">
              {data ? `${total} total${serverFiltered ? " (filtered)" : ""}` : ""}
            </span>
          </span>
        }
        flush
      >
        <form
          onSubmit={applyFilters}
          className="flex flex-wrap items-end gap-3 border-b border-border px-4 py-3 text-table"
          aria-label="Filter events"
        >
          <div className="flex flex-col gap-1">
            <label htmlFor="filter-entity-type" className="font-medium text-foreground">
              Entity type
            </label>
            <input
              id="filter-entity-type"
              list="audit-entity-types"
              value={draftType}
              onChange={(e) => setDraftType(e.target.value)}
              placeholder="e.g. session"
              className="w-40 rounded-control border border-input h-8 bg-surface px-2 font-mono text-table"
            />
            <datalist id="audit-entity-types">
              {KNOWN_ENTITY_TYPES.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="filter-entity-id" className="font-medium text-foreground">
              Entity id
            </label>
            <input
              id="filter-entity-id"
              value={draftId}
              onChange={(e) => setDraftId(e.target.value)}
              placeholder="ULID or USUBJID"
              className="w-64 rounded-control border border-input h-8 bg-surface px-2 font-mono text-table"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="filter-action" className="font-medium text-foreground">
              Action <span className="font-normal text-muted-foreground">(exact name)</span>
            </label>
            <input
              id="filter-action"
              list="audit-actions"
              value={draftAction}
              onChange={(e) => setDraftAction(e.target.value)}
              placeholder="e.g. draft.confirmed"
              className="w-52 rounded-control border border-input h-8 bg-surface px-2 font-mono text-table"
            />
            <datalist id="audit-actions">
              {KNOWN_ACTIONS.map((a) => (
                <option key={a} value={a} />
              ))}
            </datalist>
          </div>
          <div className="flex items-center gap-2">
            <Button type="submit" variant="primary" size="sm">
              Apply
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={clearFilters}>
              Clear
            </Button>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <label htmlFor="page-size" className="text-muted-foreground">
              Per page
            </label>
            <select
              id="page-size"
              value={query.limit}
              onChange={(e) =>
                setQuery((q) => ({ ...q, limit: Number(e.target.value), offset: 0 }))
              }
              className="rounded-control border border-input bg-surface px-2 py-1"
            >
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
        </form>

        {error ? (
          <ErrorBanner
            error={error}
            message="Could not load audit events"
            onRetry={reload}
            className="m-4"
          />
        ) : null}

        {initialLoading && !error && (
          <p className="px-4 py-8 text-center text-table text-muted-foreground" role="status">
            Loading events…
          </p>
        )}

        {!initialLoading && !error && data && sorted.length === 0 && (
          <p className="px-4 py-8 text-center text-table text-muted-foreground">
            {serverFiltered
              ? "No events match these filters. The action filter is an exact match; pick one from the list."
              : "No audit events yet. The first event is written when the demo data is seeded."}
          </p>
        )}

        {/* Kept mounted during a refetch so expanded payload rows survive (see header). */}
        {!initialLoading && !error && sorted.length > 0 && <EventsTable events={sorted} />}

        {data && (
          <Pagination
            total={total}
            limit={data.limit || query.limit}
            offset={data.offset ?? query.offset}
            onChange={({ limit, offset }) => setQuery((q) => ({ ...q, limit, offset }))}
            className="border-t border-border px-4 py-3"
          />
        )}
      </Card>
    </div>
  );
}
