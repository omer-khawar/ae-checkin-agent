/**
 * The outcome of `POST /eval/run-custom`: the tier and how it was reached, the
 * provisional grade per item, the vitals assessment (with the SIMULATED /
 * MEASURED word beside every value), the con-med match, draft counts, and every
 * rule that fired in plain English. Links to the replayed session so the judge
 * can open the full evidence view.
 *
 * Display only. "Provisional, investigator to confirm" is attached to every
 * grade (CLAUDE.md §3.4(b)); no text here is clinical advice.
 */
import { Link } from "react-router-dom";

import { Card } from "../../../components/Card";
import { MeasuredBadge } from "../../../components/MeasuredBadge";
import { TierChip } from "../../../components/TierChip";
import {
  cx,
  formatConfidence,
  formatVital,
  Time,
  tierStyle,
  vitalsStatusLabel,
} from "../../../lib/format";
import type {
  CheckInResult,
  Domain,
  ItemResult,
  RuleCategory,
  RuleFired,
} from "../../../lib/types";
import { EvidenceList, InputChips } from "./EvidenceList";

export interface CustomResultViewProps {
  result: CheckInResult;
  sessionId: string | null;
}

const CATEGORY_LABEL: Record<RuleCategory, string> = {
  scoring: "scoring",
  grading: "grading",
  red_flag: "red flag",
  vitals_quality: "vitals quality",
  corroboration: "corroboration",
  escalation: "escalation",
  seriousness: "seriousness",
  conmed: "con-med",
  dedup: "de-dup",
  drafting: "drafting",
};

function categoryLabel(c: RuleCategory | string): string {
  return (CATEGORY_LABEL as Record<string, string>)[c] ?? c;
}

function countDrafts(result: CheckInResult): Record<Domain, number> {
  const counts: Record<Domain, number> = { AE: 0, VS: 0, CM: 0 };
  for (const d of result.drafts ?? []) {
    if (d.domain in counts) counts[d.domain] += 1;
  }
  return counts;
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-3 py-2">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-600">{label}</div>
      <div className="mt-0.5 text-sm text-slate-900">{children}</div>
    </div>
  );
}

function RuleRow({ rule }: { rule: RuleFired }) {
  return (
    <li className="rounded-lg border border-slate-200 bg-white px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cx(
            "rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide",
            rule.category === "corroboration" && "bg-orange-100 text-orange-900",
            rule.category === "red_flag" && "bg-red-100 text-red-900",
            rule.category === "escalation" && "bg-amber-100 text-amber-900",
            rule.category === "vitals_quality" && "bg-violet-100 text-violet-900",
            !["corroboration", "red_flag", "escalation", "vitals_quality"].includes(
              rule.category,
            ) && "bg-slate-100 text-slate-700",
          )}
        >
          {categoryLabel(rule.category)}
        </span>
        <span className="font-mono text-xs text-slate-600">{rule.rule_id}</span>
      </div>
      <p className="mt-1 text-sm text-slate-900">{rule.description}</p>
      {rule.effect && <p className="mt-0.5 text-xs text-slate-600">Effect: {rule.effect}</p>}
      {/* The values the rule compared (and the thresholds it compared them
          against), then the answers / samples / tables it points at, so the
          Why list explains itself without leaving the page. */}
      <InputChips inputs={rule.inputs} label={`Inputs of ${rule.rule_id}`} />
      <EvidenceList evidence={rule.evidence} />
    </li>
  );
}

/**
 * Per-item disclosure: the raw answers (attribute = value, with timestamp and
 * answer id) and the evidence pointers behind the composite and grade.
 * Collapsed by default so the grade table stays compact.
 */
function ItemEvidence({ item }: { item: ItemResult }) {
  const responses = item.responses ?? [];
  const evidence = item.evidence ?? [];
  if (responses.length === 0 && evidence.length === 0) {
    return <span className="text-slate-500">—</span>;
  }
  return (
    <details className="text-xs font-normal text-slate-700">
      <summary className="cursor-pointer">
        {responses.length} answer{responses.length === 1 ? "" : "s"}
      </summary>
      {responses.length > 0 && (
        <ul className="mt-1 space-y-0.5 pl-1">
          {responses.map((r) => (
            <li key={r.answer_id} className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-mono text-slate-900">
                {r.attribute} = {r.value}
              </span>
              <Time iso={r.ts} style="time" className="text-slate-500" />
              <span className="font-mono text-[10px] text-slate-500">{r.answer_id}</span>
            </li>
          ))}
        </ul>
      )}
      <EvidenceList evidence={evidence} summary="evidence pointers" className="mt-1" />
    </details>
  );
}

export function CustomResultView({ result, sessionId }: CustomResultViewProps) {
  const tier = result.escalation_tier;
  const counts = countDrafts(result);
  const vitals = result.vitals;
  const summary = vitals?.summary ?? null;
  const rules = result.rules_fired ?? [];

  return (
    <div className="space-y-4" data-testid="custom-result">
      <div className="flex flex-wrap items-center gap-3">
        <TierChip tier={tier} className="text-sm" />
        <span className="text-sm text-slate-700">
          Escalation tier {tier}: {tierStyle(tier).name}
          {/* Two separate contract fields (CONTRACTS §1.3); each phrase states its own. */}
          {result.stop_screen && " · kiosk shows the stop screen"}
          {result.page_oncall && " · on-call paged"}
        </span>
        {sessionId && (
          <Link
            to={`/dashboard/checkins/${encodeURIComponent(sessionId)}`}
            className="ml-auto text-sm font-medium text-brand-700 underline"
          >
            Open the replayed session
          </Link>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Base tier (from grades)">
          {result.base_tier} <span className="text-slate-600">(max grade {result.max_grade})</span>
        </Stat>
        <Stat label="Red-flag floor">{result.red_flag_tier_floor}</Stat>
        <Stat label="Corroboration bump">
          +{result.corroboration_bump}{" "}
          <span className="text-slate-600">(vitals never change a grade)</span>
        </Stat>
        <Stat label="Drafts">
          AE {counts.AE} · VS {counts.VS} · CM {counts.CM}
        </Stat>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Provisional grade per item">
          <table className="w-full text-sm">
            <caption className="sr-only">Composite score and provisional grade per item</caption>
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-600">
                <th scope="col" className="py-1.5 pr-3">
                  Item
                </th>
                <th scope="col" className="py-1.5 pr-3">
                  CTCAE term
                </th>
                <th scope="col" className="py-1.5 pr-3 text-right">
                  Composite
                </th>
                <th scope="col" className="py-1.5 pr-3 text-right">
                  Grade
                </th>
                <th scope="col" className="py-1.5">
                  Evidence
                </th>
              </tr>
            </thead>
            <tbody>
              {(result.items ?? []).map((it) => (
                <tr
                  key={it.item_id}
                  className={cx(
                    "border-b border-slate-100",
                    it.provisional_grade > 0 && "font-medium",
                  )}
                  data-testid={`grade-${it.item_id}`}
                >
                  <td className="py-1.5 pr-3 text-slate-900">{it.label}</td>
                  <td className="py-1.5 pr-3 text-slate-700">{it.aedecod}</td>
                  <td className="tnum py-1.5 pr-3 text-right">{it.composite}</td>
                  <td className="tnum py-1.5 pr-3 text-right">
                    G{it.provisional_grade}
                    {it.provisional_grade > 0 && (
                      <span className="ml-1 text-xs font-normal text-slate-600">provisional</span>
                    )}
                  </td>
                  <td className="py-1.5 align-top">
                    <ItemEvidence item={it} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-slate-600">
            Grades are provisional, investigator to confirm. They come only from the answers.
          </p>
        </Card>

        <div className="space-y-4">
          <Card
            title="Vitals assessment"
            aside={
              summary ? (
                <MeasuredBadge isMeasured={summary.is_measured} source={summary.source} />
              ) : undefined
            }
          >
            <p className="text-sm text-slate-900">
              Status: <span className="font-medium">{vitalsStatusLabel(vitals?.status)}</span>
            </p>
            {summary ? (
              <dl className="mt-2 grid grid-cols-2 gap-2 text-sm">
                <div>
                  <dt className="text-xs uppercase tracking-wide text-slate-600">
                    Pulse (median / max)
                  </dt>
                  <dd className="tnum">
                    {formatVital(summary.pulse_median)} / {formatVital(summary.pulse_max)}{" "}
                    <span className="text-xs text-slate-600">beats/min</span>{" "}
                    <MeasuredBadge isMeasured={summary.is_measured} />
                  </dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-slate-600">
                    Breathing (median / max)
                  </dt>
                  <dd className="tnum">
                    {formatVital(summary.breathing_median)} / {formatVital(summary.breathing_max)}{" "}
                    <span className="text-xs text-slate-600">breaths/min</span>{" "}
                    <MeasuredBadge isMeasured={summary.is_measured} />
                  </dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-slate-600">
                    Samples eligible
                  </dt>
                  <dd className="tnum">
                    {summary.n_eligible} of {summary.n_samples}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-slate-600">Window</dt>
                  <dd>
                    <Time iso={summary.first_ts} style="time" /> –{" "}
                    <Time iso={summary.last_ts} style="time" />
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="mt-1 text-sm text-slate-600">
                No eligible samples; rules ran without vitals.
              </p>
            )}
            {vitals?.ignored?.length ? (
              <details className="mt-2 text-xs text-slate-700">
                <summary className="cursor-pointer">
                  {vitals.ignored.length} sample{vitals.ignored.length === 1 ? "" : "s"} ignored
                  (why)
                </summary>
                <ul className="mt-1 list-disc pl-4">
                  {vitals.ignored.map(([id, reason]) => (
                    <li key={id}>
                      <span className="font-mono">{id}</span>: {reason}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </Card>

          <Card title="Con-med and seriousness">
            {result.conmed ? (
              <p className="text-sm text-slate-900">
                <span className="font-mono">“{result.conmed.verbatim}”</span> →{" "}
                {result.conmed.matched_name ? (
                  <>
                    <span className="font-medium">{result.conmed.matched_name}</span> (
                    {result.conmed.match_kind}, confidence{" "}
                    {formatConfidence(result.conmed.confidence)})
                  </>
                ) : (
                  <span className="font-medium">unmatched, kept verbatim for the coordinator</span>
                )}
              </p>
            ) : (
              <p className="text-sm text-slate-600">No medication change reported.</p>
            )}
            <p className="mt-2 text-sm text-slate-900">
              Seriousness suspected:{" "}
              <span className="font-medium">{result.seriousness_suspected ? "yes" : "no"}</span>
              {result.sae_clock && (
                <>
                  {" "}
                  · SAE clock started, site-to-sponsor due <Time iso={result.sae_clock.due_at} />
                </>
              )}
            </p>
          </Card>
        </div>
      </div>

      <Card title={`Why: ${rules.length} rule${rules.length === 1 ? "" : "s"} fired`}>
        {rules.length ? (
          <ol className="space-y-2" data-testid="rules-fired">
            {rules.map((r, i) => (
              <RuleRow key={`${r.rule_id}-${i}`} rule={r} />
            ))}
          </ol>
        ) : (
          <p className="text-sm text-slate-600">No rules fired.</p>
        )}
      </Card>
    </div>
  );
}
