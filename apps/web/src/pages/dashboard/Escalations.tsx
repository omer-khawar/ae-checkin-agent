/**
 * /dashboard/escalations — every tier ≥ 2 event with acknowledgement times
 * (CLAUDE.md §3.7.4), the SAE clocks (§3.4(f)) and the mock pager log.
 *
 * Data: GET /escalations, POST /escalations/{id}/ack, GET /sae-clocks, GET /pages
 * (CONTRACTS.md §2.2). R3.2 / R4.3: each 24-hour clock shows its kind (SAE or
 * possible AESI), "Open report packet" (POST /packets) and, for the
 * investigator, "Record seriousness decision" (PATCH /sae-clocks/{id}/stop)
 * when no side-effect record exists to attribute. Nothing on this page is computed by a model: tiers and
 * reasons come verbatim from the rules engine via the API; the only arithmetic
 * here is elapsed time and a median.
 *
 * The three loads are independent: a section whose endpoint failed shows its own
 * error banner (with retry) while the others render normally. Only when all
 * three fail does the page collapse to a single banner.
 */
import { useMemo, useState } from "react";

import { Card } from "../../components/Card";
import { ErrorBanner } from "../../components/ErrorBanner";
import { Pagination } from "../../components/Pagination";
import { ackEscalation, DEFAULT_PAGE_SIZE, describeError } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { EscalationsTable } from "./escalations/EscalationsTable";
import {
  clampOffset,
  filterEscalations,
  isAcked,
  sortClocks,
  sortEscalations,
} from "./escalations/model";
import { PagerLog } from "./escalations/PagerLog";
import { SaeClocksTable } from "./escalations/SaeClocksTable";
import { SummaryTiles } from "./escalations/SummaryTiles";
import type { AckFilter } from "./escalations/types";
import { useEscalationsData } from "./escalations/useEscalationsData";
import { useNow } from "./escalations/useNow";
import type { EscalationRow } from "../../lib/types";
import { Button } from "@/ui/button";
import { SegmentedControl } from "@/ui/segmented-control";
import { notify } from "@/ui/toast";

const FILTERS: Array<{ id: AckFilter; label: string }> = [
  { id: "open", label: "Open" },
  { id: "acked", label: "Acknowledged" },
  { id: "all", label: "All" },
];

const PAGER_PAGE_SIZE = 10;

export function Escalations() {
  const { data, errors, allFailed, loading, reload, replaceEscalation, replaceClock } =
    useEscalationsData();
  const nowMs = useNow(1000);
  const { hasRole, role } = useAuth();
  // Admin is non-clinical: only the coordinator and the investigator acknowledge.
  const canAck = hasRole("coordinator", "investigator");

  const [filter, setFilter] = useState<AckFilter>("open");
  const [escOffset, setEscOffset] = useState(0);
  const [pagerOffset, setPagerOffset] = useState(0);
  const [ackingId, setAckingId] = useState<string | null>(null);
  const [ackError, setAckError] = useState<unknown>(null);

  // `null` = that section failed to load (its error is in `errors`).
  const escalations = useMemo(
    () => (data?.escalations ? sortEscalations(data.escalations) : null),
    [data],
  );
  const filtered = useMemo(
    () => (escalations ? filterEscalations(escalations, filter) : []),
    [escalations, filter],
  );
  // The row set shrinks when a row is acknowledged under the "Open" filter, so
  // the stored offset is clamped to the last real page before slicing.
  const safeEscOffset = clampOffset(escOffset, filtered.length, DEFAULT_PAGE_SIZE);
  const escPage = filtered.slice(safeEscOffset, safeEscOffset + DEFAULT_PAGE_SIZE);

  const clocks = useMemo(() => (data?.clocks ? sortClocks(data.clocks) : null), [data]);

  const pages = useMemo(
    () =>
      data?.pages ? [...data.pages].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)) : null,
    [data],
  );
  const pageCount = pages?.length ?? 0;
  const safePagerOffset = clampOffset(pagerOffset, pageCount, PAGER_PAGE_SIZE);
  const pagerPage = pages ? pages.slice(safePagerOffset, safePagerOffset + PAGER_PAGE_SIZE) : [];

  const openCount = escalations ? escalations.filter((e) => !isAcked(e)).length : 0;
  const totalCount = escalations?.length ?? 0;

  function changeFilter(next: AckFilter) {
    setFilter(next);
    setEscOffset(0);
  }

  async function handleAck(row: EscalationRow) {
    setAckingId(row.id);
    setAckError(null);
    try {
      const updated = await ackEscalation(row.id);
      // Keep any API-only fields (source, created_at) the ack response may omit.
      replaceEscalation({ ...row, ...updated });
      notify.success(`Escalation acknowledged for ${row.usubjid}`, {
        description: `Recorded in the audit log as escalation.acked by ${updated.acked_by ?? "you"}.`,
      });
    } catch (e) {
      setAckError(e);
      notify.danger("Could not acknowledge", { description: describeError(e) });
    } finally {
      setAckingId(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-page font-semibold text-foreground">Escalations</h1>
          <p className="mt-1 max-w-3xl text-body text-muted-foreground">
            Every tier 2 (nurse call today) and tier 3 (urgent) event, the reasons the rules engine
            recorded for it, and who acknowledged it when. Acknowledging writes an audit event; it
            does not change any draft or grade.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={reload} loading={loading}>
          Refresh
        </Button>
      </div>

      {loading && !data && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading escalations, SAE clocks and the pager log…
        </p>
      )}

      {data && allFailed && (
        <ErrorBanner
          error={errors.escalations}
          message="Could not load escalations, SAE clocks or the pager log"
          onRetry={reload}
        />
      )}

      {data && !allFailed && (
        <>
          <SummaryTiles escalations={escalations} clocks={clocks} pages={pages} nowMs={nowMs} />

          <Card
            flush
            title="Escalations"
            aside={
              escalations ? (
                <SegmentedControl
                  label="Filter escalations"
                  size="sm"
                  value={filter}
                  onValueChange={changeFilter}
                  options={FILTERS.map((f) => ({
                    value: f.id,
                    label: `${f.label} (${
                      f.id === "open"
                        ? openCount
                        : f.id === "acked"
                          ? totalCount - openCount
                          : totalCount
                    })`,
                  }))}
                />
              ) : null
            }
          >
            {escalations === null ? (
              <ErrorBanner
                error={errors.escalations}
                message="Could not load escalations"
                className="m-4"
                onRetry={reload}
              />
            ) : (
              <>
                {ackError ? (
                  <ErrorBanner
                    error={ackError}
                    message="Acknowledgement failed"
                    className="m-4"
                    onRetry={() => setAckError(null)}
                    retryLabel="Dismiss"
                  />
                ) : null}
                {escPage.length === 0 ? (
                  <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                    {filter === "open"
                      ? "No open escalations. Tier 2 and 3 events appear here as soon as a check-in completes or a chart note is scanned."
                      : filter === "acked"
                        ? "Nothing has been acknowledged yet."
                        : "No escalations yet."}
                  </p>
                ) : (
                  <EscalationsTable
                    rows={escPage}
                    nowMs={nowMs}
                    canAck={canAck}
                    ackingId={ackingId}
                    onAck={handleAck}
                  />
                )}
                {filtered.length > DEFAULT_PAGE_SIZE && (
                  <Pagination
                    className="border-t border-border px-4 py-3"
                    total={filtered.length}
                    limit={DEFAULT_PAGE_SIZE}
                    offset={safeEscOffset}
                    onChange={({ offset }) => setEscOffset(offset)}
                  />
                )}
              </>
            )}
          </Card>

          <Card
            flush
            title="24-hour report clocks (SAE and possible AESI)"
            aside={
              <span className="text-xs text-muted-foreground">
                Site obligation: report to sponsor within 24 h of becoming aware (protocol §9.4.2,
                §9.4.3)
              </span>
            }
          >
            {clocks === null ? (
              <ErrorBanner
                error={errors.clocks}
                message="Could not load SAE clocks"
                className="m-4"
                onRetry={reload}
              />
            ) : clocks.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                No SAE clock has been started. One starts when a participant answers yes to the
                hospital / emergency-room question, a chart note or call records a hospitalisation,
                or a possible special-interest event (grade 3 on a potentially immune-related
                symptom) is reported.
              </p>
            ) : (
              <SaeClocksTable
                rows={clocks}
                nowMs={nowMs}
                role={role}
                onClockStopped={replaceClock}
              />
            )}
          </Card>

          <Card
            flush
            title="Mock pager log"
            aside={
              <span className="text-xs text-muted-foreground">
                Simulated: tier 3 writes an audit event and a dashboard toast
              </span>
            }
          >
            {pages === null ? (
              <ErrorBanner
                error={errors.pages}
                message="Could not load the pager log"
                className="m-4"
                onRetry={reload}
              />
            ) : pagerPage.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                No pages sent. The pager fires only for tier 3 (urgent) check-ins.
              </p>
            ) : (
              <PagerLog rows={pagerPage} />
            )}
            {pageCount > PAGER_PAGE_SIZE && (
              <Pagination
                className="border-t border-border px-4 py-3"
                total={pageCount}
                limit={PAGER_PAGE_SIZE}
                offset={safePagerOffset}
                onChange={({ offset }) => setPagerOffset(offset)}
              />
            )}
          </Card>
        </>
      )}
    </div>
  );
}
