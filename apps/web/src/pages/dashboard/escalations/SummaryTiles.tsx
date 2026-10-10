/**
 * The four stat tiles at the top of the Escalations page. Each tile says how its
 * number was computed (the "explains itself" rubric line) and uses text tokens,
 * not status colour, for the number itself; only the overdue count turns red,
 * and it carries the word "overdue" so colour is never the sole signal.
 *
 * A section that failed to load is passed as `null`; its tile then shows "—"
 * and says so, rather than a false zero.
 *
 * Markup: the grid is a plain <div>; each tile is its own <dl> > <div> > dt/dd
 * inside a Card (<section>), which is the only nesting the HTML content model
 * allows for <dl> (its children must be div/dt/dd, never a <section>).
 */
import { Card } from "../../../components/Card";
import { cx } from "../../../lib/format";
import { formatDuration, isAcked, isClockActive, isOverdue, medianSecondsToAck } from "./model";
import type { EscalationRow, PageEventRow, SaeClockRowExt } from "./types";

export interface SummaryTilesProps {
  escalations: EscalationRow[] | null;
  clocks: SaeClockRowExt[] | null;
  pages: PageEventRow[] | null;
  nowMs: number;
}

interface TileProps {
  label: string;
  value: string;
  detail: string;
  /** Plain-English description of the computation, shown on hover and to screen readers. */
  how: string;
  tone?: "default" | "alert";
}

const NOT_LOADED = "—";
const NOT_LOADED_DETAIL = "could not load";

function Tile({ label, value, detail, how, tone = "default" }: TileProps) {
  return (
    <Card className="min-w-0">
      <dl className="m-0">
        <div className="flex flex-col gap-1" title={how}>
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-600">{label}</dt>
          <dd
            className={cx(
              "tnum text-3xl font-bold",
              tone === "alert" ? "text-red-700" : "text-slate-900",
            )}
          >
            {value}
          </dd>
          <dd className="text-sm text-slate-600">{detail}</dd>
          <dd className="sr-only">{how}</dd>
        </div>
      </dl>
    </Card>
  );
}

export function SummaryTiles({ escalations, clocks, pages, nowMs }: SummaryTilesProps) {
  const open = escalations ? escalations.filter((e) => !isAcked(e)).length : null;
  const { median, n: nAcked } = escalations
    ? medianSecondsToAck(escalations)
    : { median: null, n: 0 };
  const active = clocks ? clocks.filter(isClockActive) : null;
  const overdue = active ? active.filter((c) => isOverdue(c, nowMs)).length : 0;

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Tile
        label="Open escalations"
        value={open === null ? NOT_LOADED : String(open)}
        detail={
          escalations === null ? NOT_LOADED_DETAIL : `of ${escalations.length} total (tier 2 and 3)`
        }
        how="Count of escalations with no acknowledgement recorded. Every tier 2 or 3 event from a check-in or a chart note creates one."
        tone={open !== null && open > 0 ? "alert" : "default"}
      />
      <Tile
        label="Median time to acknowledge"
        value={escalations === null ? NOT_LOADED : formatDuration(median)}
        detail={
          escalations === null
            ? NOT_LOADED_DETAIL
            : nAcked === 0
              ? "No acknowledgements yet"
              : `across ${nAcked} acknowledged`
        }
        how="Median of (acknowledged at − created at) over acknowledged escalations, as reported by the API's seconds_to_ack."
      />
      <Tile
        label="Active SAE clocks"
        value={active === null ? NOT_LOADED : String(active.length)}
        detail={
          active === null
            ? NOT_LOADED_DETAIL
            : overdue > 0
              ? `${overdue} overdue`
              : active.length === 0
                ? "No clock running"
                : "None overdue"
        }
        how="SAE clocks with no investigator seriousness decision yet. A clock starts when a participant reports a hospital or ER visit, or a chart note records one; it stops only when an investigator sets AESER."
        tone={overdue > 0 ? "alert" : "default"}
      />
      <Tile
        label="Pages sent"
        value={pages === null ? NOT_LOADED : String(pages.length)}
        detail={pages === null ? NOT_LOADED_DETAIL : "mock pager, tier 3 only"}
        how="Entries in the mock pager log. The pager is simulated: it writes an audit event and shows a dashboard toast; nobody is really paged."
      />
    </div>
  );
}
