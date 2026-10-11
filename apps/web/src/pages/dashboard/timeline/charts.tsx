/**
 * Charts for the participant timeline (Recharts).
 *
 * Design rules applied (dataviz guidance):
 * - One axis per chart. Pulse (~70/min) and breathing (~14/min) live on
 *   different scales, so they are two small multiples sharing the session
 *   x axis, never a dual-axis chart.
 * - Marks are thin: 2px lines, >= 8px dots with a 2px white "surface ring".
 *   Gridlines are solid hairlines one step off the surface.
 * - The symptom line is one hue (brand teal); the endpoint is direct-labeled
 *   with its grade and the rest is carried by the axis, tooltip and table.
 * - The vitals line is a de-emphasis gray: the dots carry the only meaning,
 *   MEASURED (green-700) vs SIMULATED (violet-700), the same meaning-colors
 *   as the app's badges. The pair was run through the palette validator
 *   (deutan ΔE 27, normal ΔE 36, contrast >= 3:1, all PASS). Colour is never
 *   the only channel: each vitals dot also carries the word (MEASURED /
 *   SIMULATED, abbreviated with a spelled-out <title> when points are dense),
 *   and a series that mixes both opens its table view by default.
 * - Every chart has a table-view twin (`<details>`), so nothing is gated on
 *   hover and keyboard users reach every value and link.
 * - Only the dots navigate (click a point or its hover highlight to open that
 *   check-in). The plot background is inert, so an incidental click to focus
 *   the window or dismiss a tooltip never navigates away.
 */
import { Link } from "react-router-dom";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { MeasuredBadge } from "../../../components/MeasuredBadge";
import { formatVital, Time } from "../../../lib/format";
import {
  checkinPath,
  formatTick,
  hasMetric,
  timeDomain,
  type SymptomRow,
  type SymptomSeries,
  type VitalsRow,
} from "./series";

// Colours (hex because SVG attributes cannot read Tailwind classes).
const LINE_BRAND = "#125d58"; // brand deep teal (D-044)
const LINE_MUTED = "#64748b"; // slate-500 (>= 3:1 on white)
const GRID = "#e2e8f0"; // slate-200
const AXIS_TEXT = "#475569"; // slate-600
const SURFACE = "#ffffff";
export const MEASURED_DOT = "#15803d"; // green-700
export const SIMULATED_DOT = "#6d28d9"; // violet-700

const GRADE_TICKS = [0, 1, 2, 3];

/**
 * What Recharts hands to a custom `dot` / `activeDot` renderer; typed locally
 * and narrowly. Both renderers receive the row as `payload`, which is how a
 * click on a point knows which session to open.
 */
interface DotRenderProps<Row> {
  key?: string;
  cx?: number;
  cy?: number;
  index?: number;
  payload?: Row;
  value?: number | null;
}

/** Above this many points the per-dot word is abbreviated so labels do not collide. */
const FULL_WORD_MAX_POINTS = 6;

// ---------------------------------------------------------------------------
// Symptom sparkline
// ---------------------------------------------------------------------------

export interface SymptomSparklineProps {
  series: SymptomSeries;
  /** Called with the session id when a point (or the plot near it) is clicked. */
  onPointClick?: (sessionId: string) => void;
}

function SymptomTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload?: SymptomRow }>;
}) {
  const row = active ? payload?.[0]?.payload : undefined;
  if (!row) return null;
  return (
    <div className="rounded-control border border-border bg-surface px-3 py-2 text-caption shadow-elev-2">
      <div className="text-table font-semibold text-foreground">
        Grade {row.grade}{" "}
        <span className="font-normal text-muted-foreground">
          (provisional, investigator to confirm)
        </span>
      </div>
      <div className="mt-0.5 text-muted-foreground">
        Composite {row.composite} from the participant&apos;s answers
      </div>
      <div className="mt-0.5 text-muted-foreground">
        <Time iso={row.ts} style="short" />
      </div>
      <div className="mt-1 text-muted-foreground">Click to open the check-in</div>
    </div>
  );
}

export function SymptomSparkline({ series, onPointClick }: SymptomSparklineProps) {
  const rows = series.rows;
  const domain = timeDomain(rows.map((r) => r.t));
  const tableId = `symptom-table-${series.itemId}`;

  // The dot (and its hover twin, which Recharts draws on top) is the only click
  // target; the plot background does nothing.
  const click = onPointClick
    ? (row: SymptomRow | undefined) => row && onPointClick(row.session_id)
    : undefined;

  const renderDot = (p: DotRenderProps<SymptomRow>, r: number) => {
    const { cx: x, cy: y, index, payload } = p;
    if (x === undefined || y === undefined) return <g key={p.key ?? index} />;
    return (
      <circle
        key={p.key ?? index}
        cx={x}
        cy={y}
        r={r}
        fill={LINE_BRAND}
        stroke={SURFACE}
        strokeWidth={2}
        style={click ? { cursor: "pointer" } : undefined}
        data-session-id={payload?.session_id}
        onClick={click ? () => click(payload) : undefined}
      />
    );
  };

  return (
    <div
      className="rounded-panel border border-border bg-surface p-3"
      data-testid={`sparkline-${series.itemId}`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="truncate text-table font-semibold text-foreground" title={series.label}>
          {series.label}
        </h3>
        {series.latest ? (
          <span className="tabular shrink-0 text-caption text-muted-foreground">
            latest{" "}
            <span className="font-semibold text-foreground" data-testid="latest-grade">
              G{series.latest.grade}
            </span>
            {series.maxGrade > series.latest.grade && <> · max G{series.maxGrade}</>}
          </span>
        ) : (
          <span className="shrink-0 text-caption text-muted-foreground">no reports</span>
        )}
      </div>
      {series.ctcaeTerm && (
        <div
          className="truncate text-caption text-muted-foreground"
          title={`CTCAE term: ${series.ctcaeTerm}`}
        >
          {series.ctcaeTerm}
        </div>
      )}

      {rows.length === 0 ? (
        <div
          className="mt-2 flex h-[110px] items-center justify-center rounded bg-surface-subtle text-caption text-muted-foreground"
          role="img"
          aria-label={`${series.label}: no reports yet`}
        >
          No reports yet
        </div>
      ) : (
        <div
          className="mt-2"
          role="img"
          aria-label={`${series.label}: provisional grade per check-in, ${rows.length} point${rows.length === 1 ? "" : "s"}, latest grade ${series.latest?.grade ?? 0}; every point is listed with a link in the table view below`}
          aria-describedby={tableId}
          data-testid={`sparkline-plot-${series.itemId}`}
        >
          <ResponsiveContainer
            width="100%"
            height={110}
            initialDimension={{ width: 320, height: 110 }}
          >
            <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: -16 }}>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis
                dataKey="t"
                type="number"
                scale="time"
                domain={domain}
                tickFormatter={formatTick}
                tick={{ fontSize: 10, fill: AXIS_TEXT }}
                axisLine={{ stroke: GRID }}
                tickLine={false}
                minTickGap={24}
              />
              <YAxis
                domain={[0, 3]}
                ticks={GRADE_TICKS}
                tick={{ fontSize: 10, fill: AXIS_TEXT }}
                axisLine={false}
                tickLine={false}
                width={40}
                tickFormatter={(v: number) => `G${v}`}
              />
              <Tooltip
                content={<SymptomTooltip />}
                cursor={{ stroke: GRID, strokeWidth: 1 }}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="grade"
                stroke={LINE_BRAND}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                dot={(p: DotRenderProps<SymptomRow>) => renderDot(p, 4)}
                // Recharts types a function activeDot as `(props: unknown) => Element`;
                // it receives the same {cx, cy, payload} shape as `dot`.
                activeDot={(p: unknown) => renderDot(p as DotRenderProps<SymptomRow>, 6)}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {rows.length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer text-caption text-primary underline">
            Table view
          </summary>
          <table id={tableId} className="mt-1 w-full text-caption">
            <caption className="sr-only">{series.label}: grade per check-in</caption>
            <thead>
              <tr className="text-left text-muted-foreground">
                <th scope="col" className="py-0.5 pr-2 font-medium">
                  Check-in
                </th>
                <th scope="col" className="py-0.5 pr-2 font-medium">
                  Composite
                </th>
                <th scope="col" className="py-0.5 pr-2 font-medium">
                  Grade
                </th>
                <th scope="col" className="py-0.5 font-medium">
                  <span className="sr-only">Link</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.session_id} className="border-t border-border">
                  <td className="py-0.5 pr-2">
                    <Time iso={r.ts} style="short" />
                  </td>
                  <td className="tabular py-0.5 pr-2">{r.composite}</td>
                  <td className="tabular py-0.5 pr-2">G{r.grade}</td>
                  <td className="py-0.5">
                    <Link to={checkinPath(r.session_id)} className="text-primary underline">
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Vitals small multiples
// ---------------------------------------------------------------------------

export interface VitalsChartsProps {
  rows: VitalsRow[];
  onPointClick?: (sessionId: string) => void;
}

/** Legend that spells the words: colour is never the only channel. */
export function MeasuredLegend() {
  return (
    <ul
      className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-muted-foreground"
      aria-label="Legend"
    >
      <li className="flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className="inline-block h-2.5 w-2.5 rounded-full"
          style={{ backgroundColor: MEASURED_DOT }}
        />
        <MeasuredBadge isMeasured />
        <span>captured from a sensor</span>
      </li>
      <li className="flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className="inline-block h-2.5 w-2.5 rounded-full"
          style={{ backgroundColor: SIMULATED_DOT }}
        />
        <MeasuredBadge isMeasured={false} />
        <span>synthetic signal from the mock source</span>
      </li>
    </ul>
  );
}

interface VitalsTooltipProps {
  active?: boolean;
  payload?: Array<{ payload?: VitalsRow }>;
  metric: "pulse_median" | "breathing_median";
  unit: string;
}

function VitalsTooltip({ active, payload, metric, unit }: VitalsTooltipProps) {
  const row = active ? payload?.[0]?.payload : undefined;
  if (!row) return null;
  const value = row[metric];
  return (
    <div className="rounded-control border border-border bg-surface px-3 py-2 text-caption shadow-elev-2">
      <div className="flex items-center gap-2">
        <span className="tabular text-table font-semibold text-foreground">
          {formatVital(value)} <span className="font-normal text-muted-foreground">{unit}</span>
        </span>
        <MeasuredBadge isMeasured={row.is_measured} source={row.source} />
      </div>
      <div className="mt-0.5 text-muted-foreground">
        Median of eligible samples in this check-in
      </div>
      <div className="mt-0.5 text-muted-foreground">
        <Time iso={row.ts} style="short" />
      </div>
      <div className="mt-1 text-muted-foreground">Click to open the check-in</div>
    </div>
  );
}

interface OneVitalsChartProps extends VitalsChartsProps {
  metric: "pulse_median" | "breathing_median";
  title: string;
  unit: string;
  domain: [number, number];
}

function OneVitalsChart({ rows, metric, title, unit, domain, onPointClick }: OneVitalsChartProps) {
  const present = hasMetric(rows, metric);
  const pointCount = rows.filter((r) => r[metric] !== null).length;
  const abbreviate = pointCount > FULL_WORD_MAX_POINTS;

  const click = onPointClick
    ? (row: VitalsRow | undefined) => row && onPointClick(row.session_id)
    : undefined;

  /**
   * Each point is a dot plus the word above it, so a screenshot of the chart
   * (no legend, no hover) still says which values are simulated. `r` differs
   * for the resting dot and the hover twin Recharts draws over it.
   */
  const renderDot = (p: DotRenderProps<VitalsRow>, r: number) => {
    const { cx: x, cy: y, index, payload } = p;
    if (x === undefined || y === undefined || !payload || payload[metric] === null) {
      return <g key={p.key ?? index} />;
    }
    const measured = payload.is_measured;
    const word = measured ? "MEASURED" : "SIMULATED";
    const colour = measured ? MEASURED_DOT : SIMULATED_DOT;
    return (
      <g
        key={p.key ?? index}
        style={click ? { cursor: "pointer" } : undefined}
        data-session-id={payload.session_id}
        data-measured={measured ? "true" : "false"}
        onClick={click ? () => click(payload) : undefined}
      >
        <circle cx={x} cy={y} r={r} fill={colour} stroke={SURFACE} strokeWidth={2} />
        <text
          x={x}
          y={y - r - 4}
          textAnchor="middle"
          fontSize={9}
          fontWeight={700}
          fill={colour}
          style={{ letterSpacing: "0.04em" }}
          data-testid="point-label"
        >
          {abbreviate && <title>{word}</title>}
          {abbreviate ? (measured ? "MEAS" : "SIM") : word}
        </text>
      </g>
    );
  };

  return (
    <div data-testid={`vitals-chart-${metric}`}>
      <h3 className="text-table font-semibold text-foreground">
        {title}{" "}
        <span className="font-normal text-muted-foreground">({unit}, median per check-in)</span>
      </h3>
      {!present ? (
        <div
          className="mt-2 flex h-[140px] items-center justify-center rounded bg-surface-subtle text-caption text-muted-foreground"
          role="img"
          aria-label={`${title}: no values recorded`}
        >
          No {title.toLowerCase()} values recorded
        </div>
      ) : (
        <div
          className="mt-2"
          role="img"
          aria-label={`${title} median per check-in in ${unit}; each point is labeled MEASURED or SIMULATED, and listed with a link in the table view below`}
          data-testid={`vitals-plot-${metric}`}
        >
          <ResponsiveContainer
            width="100%"
            height={150}
            initialDimension={{ width: 480, height: 150 }}
          >
            {/* Top margin leaves room for the word above the highest point. */}
            <LineChart data={rows} margin={{ top: 22, right: 28, bottom: 0, left: -8 }}>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis
                dataKey="t"
                type="number"
                scale="time"
                domain={domain}
                tickFormatter={formatTick}
                tick={{ fontSize: 10, fill: AXIS_TEXT }}
                axisLine={{ stroke: GRID }}
                tickLine={false}
                minTickGap={24}
              />
              <YAxis
                tick={{ fontSize: 10, fill: AXIS_TEXT }}
                axisLine={false}
                tickLine={false}
                width={40}
                domain={["auto", "auto"]}
                allowDecimals={false}
              />
              <Tooltip
                content={<VitalsTooltip metric={metric} unit={unit} />}
                cursor={{ stroke: GRID, strokeWidth: 1 }}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey={metric}
                stroke={LINE_MUTED}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                connectNulls={false}
                dot={(p: DotRenderProps<VitalsRow>) => renderDot(p, 4.5)}
                activeDot={(p: unknown) => renderDot(p as DotRenderProps<VitalsRow>, 6)}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

export function VitalsCharts({ rows, onPointClick }: VitalsChartsProps) {
  const domain = timeDomain(rows.map((r) => r.t));
  // A mixed series is where the per-point words matter most, so its table
  // (with the badge and source per row) starts expanded instead of collapsed.
  const mixed = rows.some((r) => r.is_measured) && rows.some((r) => !r.is_measured);
  return (
    <div className="space-y-4">
      <MeasuredLegend />
      <OneVitalsChart
        rows={rows}
        metric="pulse_median"
        title="Pulse"
        unit="beats/min"
        domain={domain}
        onPointClick={onPointClick}
      />
      <OneVitalsChart
        rows={rows}
        metric="breathing_median"
        title="Breathing"
        unit="breaths/min"
        domain={domain}
        onPointClick={onPointClick}
      />
      <details open={mixed} data-testid="vitals-table-details">
        <summary className="cursor-pointer text-caption text-primary underline">Table view</summary>
        <div className="mt-1 overflow-x-auto">
          <table className="w-full text-caption" data-testid="vitals-table">
            <caption className="sr-only">Vitals medians per check-in</caption>
            <thead>
              <tr className="text-left text-muted-foreground">
                <th scope="col" className="py-1 pr-3 font-medium">
                  Check-in
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  Pulse (beats/min)
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  Breathing (breaths/min)
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  Measured / simulated
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  Source
                </th>
                <th scope="col" className="py-1 font-medium">
                  <span className="sr-only">Link</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.session_id} className="border-t border-border">
                  <td className="py-1 pr-3">
                    <Time iso={r.ts} style="short" />
                  </td>
                  <td className="tabular py-1 pr-3">{formatVital(r.pulse_median)}</td>
                  <td className="tabular py-1 pr-3">{formatVital(r.breathing_median)}</td>
                  <td className="py-1 pr-3">
                    <MeasuredBadge isMeasured={r.is_measured} />
                  </td>
                  <td className="py-1 pr-3 font-mono">{r.source ?? "—"}</td>
                  <td className="py-1">
                    <Link to={checkinPath(r.session_id)} className="text-primary underline">
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
