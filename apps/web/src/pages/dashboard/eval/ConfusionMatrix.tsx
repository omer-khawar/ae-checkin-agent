/**
 * 4×4 provisional-grade confusion matrix (rows = expected grade, cols = actual
 * grade; CONTRACTS.md §2.2 `EvalResults.grade_confusion`).
 *
 * Sequential heat shading per the dataviz method: one hue (the product teal),
 * light → dark, the zero cell receding to the surface. Steps were checked with
 * `validate_palette.js --ordinal`: monotone lightness, adjacent ΔL ≥ 0.06,
 * single hue. (The ordinal light-end 2:1 floor does not apply to a sequential
 * heatmap, where the lightest non-zero step is allowed to sit near the
 * surface; every cell also prints its count, so magnitude is never
 * colour-alone.) Text wears text tokens, never the series colour.
 *
 * It is a real <table>, so the "table view" is the chart itself.
 */
import { cx } from "../../../lib/format";

export interface ConfusionMatrixProps {
  /** `matrix[expected][actual]`, 4×4; tolerant of missing rows/cells. */
  matrix: number[][];
  /** Row/column labels; default G0..G3. */
  labels?: string[];
}

/** Teal ramp, light → dark, for counts > 0 (index by quartile of the max). */
const RAMP: ReadonlyArray<{ bg: string; darkText: boolean }> = [
  { bg: "#5eead4", darkText: true },
  { bg: "#14b8a6", darkText: true },
  { bg: "#0f766e", darkText: false },
  { bg: "#134e4a", darkText: false },
];

const DEFAULT_LABELS = ["G0", "G1", "G2", "G3"];

function cell(matrix: number[][], r: number, c: number): number {
  const v = matrix[r]?.[c];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function ConfusionMatrix({ matrix, labels = DEFAULT_LABELS }: ConfusionMatrixProps) {
  const n = labels.length;
  let max = 0;
  let total = 0;
  let diagonal = 0;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const v = cell(matrix, r, c);
      total += v;
      if (r === c) diagonal += v;
      if (v > max) max = v;
    }
  }

  const stepFor = (v: number): number => {
    if (v <= 0 || max <= 0) return -1;
    return Math.min(RAMP.length - 1, Math.ceil((v / max) * RAMP.length) - 1);
  };

  return (
    <div className="overflow-x-auto">
      <table
        className="border-separate border-spacing-0.5 text-table"
        data-testid="confusion-matrix"
      >
        <caption className="mb-2 text-left text-caption text-muted-foreground">
          Rows: expected grade from the answer key. Columns: actual provisional grade. Diagonal =
          correct.
          {total > 0 && (
            <>
              {" "}
              <span className="tnum font-medium text-foreground">
                {diagonal} / {total}
              </span>{" "}
              item grades on the diagonal.
            </>
          )}
        </caption>
        <thead>
          <tr>
            <th
              scope="col"
              className="h-8 bg-surface px-2 text-left text-caption font-medium text-muted-foreground"
            >
              expected ↓ / actual →
            </th>
            {labels.map((l) => (
              <th
                key={l}
                scope="col"
                className="tnum h-8 bg-surface px-2 text-center text-caption font-semibold text-foreground"
              >
                {l}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {labels.map((rowLabel, r) => (
            <tr key={rowLabel}>
              <th
                scope="row"
                className="tnum h-8 bg-surface px-2 text-left text-caption font-semibold text-foreground"
              >
                {rowLabel}
              </th>
              {labels.map((colLabel, c) => {
                const v = cell(matrix, r, c);
                const step = stepFor(v);
                const style = step < 0 ? undefined : { backgroundColor: RAMP[step].bg };
                const dark = step < 0 || RAMP[step].darkText;
                return (
                  <td
                    key={colLabel}
                    className={cx(
                      "tnum h-11 w-14 rounded-control border text-center align-middle",
                      step < 0
                        ? "border-border bg-surface-subtle text-muted-foreground"
                        : "border-transparent",
                      step >= 0 && (dark ? "text-foreground" : "text-white"),
                      r === c && "font-semibold ring-1 ring-inset ring-slate-900/20",
                    )}
                    style={style}
                    title={`Expected ${rowLabel}, actual ${colLabel}: ${v}${r === c ? " (correct)" : ""}`}
                    data-expected={rowLabel}
                    data-actual={colLabel}
                  >
                    {v}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
