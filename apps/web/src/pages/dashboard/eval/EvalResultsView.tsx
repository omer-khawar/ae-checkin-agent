/**
 * Renders one `EvalResults` (CONTRACTS.md §2.2): pass/fail tiles, per-tier
 * precision/recall/F1, the 4×4 grade confusion matrix, the three correctness
 * counters, the per-persona table with a link to each replayed session, and the
 * server's markdown report as a collapsed block.
 *
 * Everything shown is the server's number; this component formats and never
 * recomputes a metric (the eval harness is the single source of truth for
 * "did the rules do what the answer key says").
 */
import { Link } from "react-router-dom";

import { Card } from "../../../components/Card";
import { TierChip } from "../../../components/TierChip";
import { cx, Time } from "../../../lib/format";
import type {
  EvalPersonaSummary,
  EvalPerPersona,
  EvalResults,
  TierMetrics,
} from "../../../lib/types";
import { ConfusionMatrix } from "./ConfusionMatrix";
import { readExtras, type EvalCounterfactual } from "./evalExtras";

export interface EvalResultsViewProps {
  results: EvalResults;
  /** Persona catalogue, to show category + expected tier next to each row. */
  personas?: EvalPersonaSummary[];
}

const TIER_KEYS = ["0", "1", "2", "3"] as const;

/** 0..1 → "100%" / "87.5%"; "—" when the server sends nothing. */
function pct(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  const v = x * 100;
  return `${Number.isInteger(v) ? v : v.toFixed(1)}%`;
}

/** Read a tier out of the loosely typed expected/actual records. */
function tierOf(rec: Record<string, unknown> | undefined): number | null {
  const t = rec?.tier;
  return typeof t === "number" ? t : null;
}

function Tile({
  label,
  value,
  tone = "neutral",
  hint,
}: {
  label: string;
  value: string;
  tone?: "neutral" | "good" | "bad";
  hint?: string;
}) {
  return (
    <div
      className={cx(
        "rounded-xl border px-4 py-3",
        tone === "good" && "border-green-300 bg-green-50",
        tone === "bad" && "border-red-300 bg-red-50",
        tone === "neutral" && "border-slate-200 bg-white",
      )}
      title={hint}
    >
      <div className="text-xs font-medium uppercase tracking-wide text-slate-600">{label}</div>
      <div className="tnum mt-1 text-2xl font-semibold text-slate-900">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-slate-600">{hint}</div>}
    </div>
  );
}

function CorrectnessTile({ label, c }: { label: string; c?: { n: number; correct: number } }) {
  if (!c) return <Tile label={label} value="—" hint="not reported" />;
  const ok = c.n === 0 || c.correct === c.n;
  return (
    <Tile
      label={label}
      value={c.n === 0 ? "n/a" : `${c.correct} / ${c.n}`}
      tone={c.n === 0 ? "neutral" : ok ? "good" : "bad"}
      hint={c.n === 0 ? "no persona exercises this" : ok ? "all correct" : "mismatch, see table"}
    />
  );
}

function TierMetricsTable({ metrics }: { metrics: EvalResults["tier_metrics"] | undefined }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">Precision, recall and F1 per escalation tier</caption>
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-600">
            <th scope="col" className="py-2 pr-3">
              Tier
            </th>
            <th scope="col" className="py-2 pr-3 text-right">
              Precision
            </th>
            <th scope="col" className="py-2 pr-3 text-right">
              Recall
            </th>
            <th scope="col" className="py-2 pr-3 text-right">
              F1
            </th>
            <th scope="col" className="py-2 text-right">
              Support
            </th>
          </tr>
        </thead>
        <tbody>
          {TIER_KEYS.map((k) => {
            const m: TierMetrics | undefined = metrics?.[k];
            return (
              <tr key={k} className="border-b border-slate-100">
                <td className="py-2 pr-3">
                  <TierChip tier={Number(k)} />
                </td>
                <td className="tnum py-2 pr-3 text-right">{pct(m?.precision)}</td>
                <td className="tnum py-2 pr-3 text-right">{pct(m?.recall)}</td>
                <td className="tnum py-2 pr-3 text-right">{pct(m?.f1)}</td>
                <td className="tnum py-2 text-right">{m?.support ?? "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PerPersonaTable({
  rows,
  personas,
}: {
  rows: EvalPerPersona[];
  personas: EvalPersonaSummary[];
}) {
  const byId = new Map(personas.map((p) => [p.id, p]));
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" data-testid="per-persona-table">
        <caption className="sr-only">Result per persona</caption>
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-600">
            <th scope="col" className="py-2 pr-3">
              Persona
            </th>
            <th scope="col" className="py-2 pr-3">
              Category
            </th>
            <th scope="col" className="py-2 pr-3">
              Expected tier
            </th>
            <th scope="col" className="py-2 pr-3">
              Actual tier
            </th>
            <th scope="col" className="py-2 pr-3">
              Result
            </th>
            <th scope="col" className="py-2 pr-3">
              Mismatches
            </th>
            <th scope="col" className="py-2">
              Session
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const meta = byId.get(r.persona_id);
            const expectedTier = tierOf(r.expected) ?? meta?.expected_tier ?? null;
            const actualTier = tierOf(r.actual);
            return (
              <tr key={r.persona_id} className="border-b border-slate-100 align-top">
                <td className="py-2 pr-3">
                  <div className="font-medium text-slate-900">{r.name}</div>
                  <div className="font-mono text-xs text-slate-600">
                    {r.persona_id}
                    {r.hidden && (
                      <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 font-sans text-[11px] font-semibold text-slate-700">
                        hidden judge persona
                      </span>
                    )}
                  </div>
                </td>
                <td className="py-2 pr-3 text-slate-700">{meta?.category ?? "—"}</td>
                <td className="py-2 pr-3">
                  {expectedTier === null ? "—" : <TierChip tier={expectedTier} short />}
                </td>
                <td className="py-2 pr-3">
                  {actualTier === null ? "—" : <TierChip tier={actualTier} short />}
                </td>
                <td className="py-2 pr-3">
                  <span
                    className={cx(
                      "rounded-md border px-2 py-0.5 text-xs font-bold uppercase",
                      r.pass
                        ? "border-green-300 bg-green-100 text-green-800"
                        : "border-red-300 bg-red-100 text-red-800",
                    )}
                  >
                    {r.pass ? "pass" : "fail"}
                  </span>
                </td>
                <td className="py-2 pr-3 text-slate-700">
                  {r.mismatches?.length ? (
                    <ul className="list-disc space-y-0.5 pl-4">
                      {r.mismatches.map((m, i) => (
                        <li key={i} className="font-mono text-xs">
                          {m}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className="text-slate-500">none</span>
                  )}
                </td>
                <td className="py-2">
                  {r.session_id ? (
                    <Link
                      to={`/dashboard/checkins/${encodeURIComponent(r.session_id)}`}
                      className="text-brand-700 underline"
                    >
                      open check-in
                    </Link>
                  ) : (
                    <span className="text-slate-500">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Settings-toggle replays (CONTRACTS R2.2): the same persona re-run with the
 * demo toggle flipped. Baseline tier → new tier makes "the tier moved, the
 * grade did not" visible without opening the markdown.
 */
function CounterfactualTable({ rows }: { rows: EvalCounterfactual[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" data-testid="counterfactual-table">
        <caption className="sr-only">Counterfactual replays with settings toggled</caption>
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-600">
            <th scope="col" className="py-2 pr-3">
              Persona
            </th>
            <th scope="col" className="py-2 pr-3">
              Counterfactual
            </th>
            <th scope="col" className="py-2 pr-3">
              Tier: baseline → replay
            </th>
            <th scope="col" className="py-2 pr-3">
              Result
            </th>
            <th scope="col" className="py-2 pr-3">
              Mismatches
            </th>
            <th scope="col" className="py-2">
              Session
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c, i) => (
            <tr key={`${c.persona_id}-${i}`} className="border-b border-slate-100 align-top">
              <td className="py-2 pr-3 font-mono text-xs text-slate-700">{c.persona_id}</td>
              <td className="py-2 pr-3 text-slate-900">
                {c.label}
                {c.settings && Object.keys(c.settings).length > 0 && (
                  <div className="mt-0.5 font-mono text-[11px] text-slate-600">
                    {JSON.stringify(c.settings)}
                  </div>
                )}
              </td>
              <td className="py-2 pr-3">
                <span className="inline-flex items-center gap-1.5">
                  <TierChip tier={c.baseline_tier} short />
                  <span aria-hidden="true">→</span>
                  <span className="sr-only">then</span>
                  <TierChip tier={c.tier} short />
                </span>
              </td>
              <td className="py-2 pr-3">
                <span
                  className={cx(
                    "rounded-md border px-2 py-0.5 text-xs font-bold uppercase",
                    c.pass
                      ? "border-green-300 bg-green-100 text-green-800"
                      : "border-red-300 bg-red-100 text-red-800",
                  )}
                >
                  {c.pass ? "pass" : "fail"}
                </span>
              </td>
              <td className="py-2 pr-3 text-slate-700">
                {c.mismatches?.length ? (
                  <ul className="list-disc space-y-0.5 pl-4">
                    {c.mismatches.map((m, j) => (
                      <li key={j} className="font-mono text-xs">
                        {m}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="text-slate-500">none</span>
                )}
              </td>
              <td className="py-2">
                {c.session_id ? (
                  <Link
                    to={`/dashboard/checkins/${encodeURIComponent(c.session_id)}`}
                    className="text-brand-700 underline"
                  >
                    open check-in
                  </Link>
                ) : (
                  <span className="text-slate-500">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-slate-600">
        Each replay also checks the invariant that a settings change never moves a provisional
        grade; a violation shows as a mismatch.
      </p>
    </div>
  );
}

export function EvalResultsView({ results, personas = [] }: EvalResultsViewProps) {
  const { counterfactuals, notices } = readExtras(results);
  const n = results.n_personas ?? results.per_persona?.length ?? 0;
  const nPass = results.n_pass ?? 0;
  const nFail = results.n_fail ?? Math.max(0, n - nPass);
  const allPass = n > 0 && nFail === 0;

  return (
    <div className="space-y-4" data-testid="eval-results">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-600">
        <span>
          Run <span className="font-mono">{results.run_id}</span>
        </span>
        <span>
          at <Time iso={results.ran_at} />
        </span>
        <span>
          {results.include_hidden ? "including hidden judge personas" : "shipped personas only"}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Personas run" value={String(n)} />
        <Tile label="Passed" value={String(nPass)} tone={allPass ? "good" : "neutral"} />
        <Tile label="Failed" value={String(nFail)} tone={nFail > 0 ? "bad" : "good"} />
        <Tile
          label="Pass rate"
          value={n === 0 ? "—" : pct(nPass / n)}
          tone={allPass ? "good" : nFail > 0 ? "bad" : "neutral"}
          hint="100% is the shipping bar (CLAUDE.md §8)"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Per-tier precision / recall / F1">
          <TierMetricsTable metrics={results.tier_metrics} />
        </Card>
        <Card title="Grade confusion matrix (expected vs actual)">
          <ConfusionMatrix matrix={results.grade_confusion ?? []} />
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <CorrectnessTile label="De-duplication" c={results.dedup_correct} />
        <CorrectnessTile label="SAE clock" c={results.sae_clock_correct} />
        <CorrectnessTile label="Con-med matching" c={results.conmed_correct} />
      </div>

      <Card title="Per persona" flush>
        <div className="p-4">
          {results.per_persona?.length ? (
            <PerPersonaTable rows={results.per_persona} personas={personas} />
          ) : (
            <p className="text-sm text-slate-600">The server returned no per-persona rows.</p>
          )}
        </div>
      </Card>

      {counterfactuals.length > 0 && (
        <Card title={`Counterfactuals (${counterfactuals.length}): same inputs, settings toggled`}>
          <CounterfactualTable rows={counterfactuals} />
        </Card>
      )}

      {notices.length > 0 && (
        <details className="rounded-2xl border border-slate-200 bg-white shadow-card">
          <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-slate-900">
            Harness notices ({notices.length})
          </summary>
          <ul className="list-disc space-y-0.5 border-t border-slate-200 px-4 py-3 pl-8 font-mono text-xs text-slate-700">
            {notices.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </details>
      )}

      {results.markdown && (
        <details className="rounded-2xl border border-slate-200 bg-white shadow-card">
          <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-slate-900">
            Full report (markdown, as written to docs/eval/results.md)
          </summary>
          <pre className="overflow-x-auto whitespace-pre-wrap border-t border-slate-200 px-4 py-3 font-mono text-xs text-slate-800">
            {results.markdown}
          </pre>
        </details>
      )}
    </div>
  );
}
