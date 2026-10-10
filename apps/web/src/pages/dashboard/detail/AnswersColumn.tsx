/**
 * LEFT column: the participant's answers in the order they were received, then
 * the gate answers, then the vitals block (status, summary, raw samples).
 *
 * Rows carry `data-answer-id` / `data-sample-id` and highlight themselves when
 * their id is in `highlight` (the evidence set of whatever is selected in the
 * other columns). Raw samples are never averaged away: the full series is in a
 * collapsible table under the summary.
 */
import { useState } from "react";

import { Card } from "../../../components/Card";
import { MeasuredBadge } from "../../../components/MeasuredBadge";
import {
  cx,
  formatConfidence,
  formatVital,
  Time,
  vitalsStatusLabel,
  vsMethod,
} from "../../../lib/format";
import type { Answer, CheckInDetail, Item, VitalsSampleRow } from "../../../lib/types";
import { Chip, Disclosure } from "./bits";
import {
  describeGate,
  highlightClass,
  humanize,
  isGateAnswer,
  itemLabel,
  optionLabel,
  sortAnswers,
  vitalsProvenance,
} from "./model";

export interface AnswersColumnProps {
  detail: CheckInDetail;
  items: Item[] | null;
  highlight: Set<string>;
  /** Clicking a row makes it the "focused evidence" (highlights rules that used it). */
  onFocusId: (id: string) => void;
}

export function AnswersColumn({ detail, items, highlight, onFocusId }: AnswersColumnProps) {
  const ordered = sortAnswers(detail.answers ?? []);
  const pro = ordered.filter((a) => !isGateAnswer(a));
  const gates = ordered.filter(isGateAnswer);

  return (
    <div className="space-y-4">
      <Card
        title="Answers"
        aside={
          <span className="text-xs text-slate-500">
            {pro.length} item answer{pro.length === 1 ? "" : "s"} · in order received
          </span>
        }
        flush
      >
        {pro.length === 0 ? (
          <p className="p-4 text-sm text-slate-500">No item answers were recorded.</p>
        ) : (
          <ol className="divide-y divide-slate-100" aria-label="Item answers">
            {pro.map((a) => (
              <AnswerRow
                key={a.id}
                answer={a}
                label={itemLabel(a.item_id, items, detail)}
                option={optionLabel(a.item_id, a.attribute, a.value_int, items)}
                active={highlight.has(a.id)}
                onFocus={() => onFocusId(a.id)}
              />
            ))}
          </ol>
        )}
      </Card>

      <Card title="Gate questions" flush>
        {gates.length === 0 ? (
          <p className="p-4 text-sm text-slate-500">No gate answers were recorded.</p>
        ) : (
          <ol className="divide-y divide-slate-100" aria-label="Gate answers">
            {gates.map((a) => (
              <GateRow
                key={a.id}
                answer={a}
                label={itemLabel(a.item_id, items, detail)}
                active={highlight.has(a.id)}
                onFocus={() => onFocusId(a.id)}
              />
            ))}
          </ol>
        )}
      </Card>

      <VitalsBlock detail={detail} highlight={highlight} onFocusId={onFocusId} />
    </div>
  );
}

function AnswerRow({
  answer,
  label,
  option,
  active,
  onFocus,
}: {
  answer: Answer;
  label: string;
  option: string | null;
  active: boolean;
  onFocus: () => void;
}) {
  return (
    <li data-answer-id={answer.id} data-highlighted={active ? "true" : "false"}>
      <button
        type="button"
        onClick={onFocus}
        className={cx(
          "flex w-full items-start gap-3 px-4 py-2 text-left hover:bg-slate-50",
          highlightClass(active),
        )}
        aria-pressed={active}
        title={`Answer ${answer.id}`}
      >
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-slate-900">{label}</div>
          <div className="text-xs text-slate-600">
            <span className="capitalize">{answer.attribute}</span>
            <span aria-hidden="true"> · </span>
            <span className="font-medium text-slate-800">
              {option ?? humanize(String(answer.value_int ?? "—"))}
            </span>
            {answer.value_int !== null && (
              <span className="tnum text-slate-500"> ({answer.value_int})</span>
            )}
            {answer.value_text && <span className="text-slate-700"> · {answer.value_text}</span>}
          </div>
        </div>
        <div className="shrink-0 text-right text-[11px] text-slate-500">
          <Time iso={answer.ts_server} style="time" />
        </div>
      </button>
    </li>
  );
}

function GateRow({
  answer,
  label,
  active,
  onFocus,
}: {
  answer: Answer;
  label: string;
  active: boolean;
  onFocus: () => void;
}) {
  const g = describeGate(answer);
  return (
    <li data-answer-id={answer.id} data-highlighted={active ? "true" : "false"}>
      <button
        type="button"
        onClick={onFocus}
        className={cx(
          "flex w-full items-start gap-3 px-4 py-2 text-left hover:bg-slate-50",
          highlightClass(active),
        )}
        aria-pressed={active}
        title={`Answer ${answer.id}`}
      >
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-slate-900">{label}</div>
          <div
            className={cx(
              "mt-0.5 text-sm",
              g.verbatim
                ? "whitespace-pre-wrap rounded bg-slate-50 px-2 py-1 font-mono text-slate-800"
                : "text-slate-800",
              g.empty && "text-slate-500",
            )}
          >
            {g.text}
          </div>
          {g.verbatim && (
            <div className="mt-1 flex flex-wrap gap-1">
              <Chip className="bg-slate-100 text-slate-700 border-slate-300">
                {g.matchedOnly
                  ? "verbatim · compared by string distance only, never parsed"
                  : "verbatim, never parsed"}
              </Chip>
            </div>
          )}
        </div>
        <div className="shrink-0 text-right text-[11px] text-slate-500">
          <Time iso={answer.ts_server} style="time" />
        </div>
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Vitals
// ---------------------------------------------------------------------------

function VitalsBlock({
  detail,
  highlight,
  onFocusId,
}: {
  detail: CheckInDetail;
  highlight: Set<string>;
  onFocusId: (id: string) => void;
}) {
  const samples = detail.vitals?.samples ?? [];
  const summary = detail.vitals?.summary ?? detail.result?.vitals?.summary ?? null;
  const status =
    detail.result?.vitals?.status ?? detail.vitals?.status ?? detail.session?.vitals_status;
  const ignored = new Map<string, string>(
    (detail.result?.vitals?.ignored ?? []).map(([id, why]) => [id, why]),
  );
  const eligible = new Set(detail.result?.vitals?.eligible_sample_ids ?? []);
  // Shared with the page header so the two badges can never disagree.
  const { isMeasured, source } = vitalsProvenance(detail);
  const [open, setOpen] = useState(false);

  return (
    <Card
      title="Vitals"
      aside={
        <span className="flex items-center gap-2">
          <Chip
            className="bg-slate-100 text-slate-800 border-slate-300"
            title="Vitals status from the rules engine"
          >
            {vitalsStatusLabel(status)}
          </Chip>
          {samples.length > 0 && <MeasuredBadge isMeasured={isMeasured} source={source} />}
        </span>
      }
    >
      {!detail.session?.consent_camera && (
        <p className="mb-2 text-sm text-slate-600">
          Camera consent was declined; the check-in ran without vitals.
        </p>
      )}
      {samples.length === 0 ? (
        <p className="text-sm text-slate-500">No vitals samples were captured for this session.</p>
      ) : (
        <>
          {summary ? (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
              <Stat
                label="Pulse median"
                value={formatVital(summary.pulse_median)}
                unit="beats/min"
                isMeasured={isMeasured}
              />
              <Stat
                label="Pulse max"
                value={formatVital(summary.pulse_max)}
                unit="beats/min"
                isMeasured={isMeasured}
              />
              <Stat
                label="Breathing median"
                value={formatVital(summary.breathing_median)}
                unit="breaths/min"
                isMeasured={isMeasured}
              />
              <Stat
                label="Breathing max"
                value={formatVital(summary.breathing_max)}
                unit="breaths/min"
                isMeasured={isMeasured}
              />
              <Stat
                label="HRV median"
                value={formatVital(summary.hrv_median)}
                unit="ms"
                isMeasured={isMeasured}
              />
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Samples</dt>
                <dd className="tnum text-slate-900">
                  {summary.n_eligible} usable of {summary.n_samples}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="text-sm text-slate-500">
              No summary: no sample was usable for the rules.
            </p>
          )}
          <p className="mt-2 text-xs text-slate-600">
            Method: <span className="font-medium">{vsMethod(isMeasured)}</span>
            {source && (
              <>
                {" "}
                · source <span className="font-mono">{source}</span>
              </>
            )}
            {summary?.first_ts && (
              <>
                {" "}
                · <Time iso={summary.first_ts} style="time" /> →{" "}
                <Time iso={summary.last_ts} style="time" />
              </>
            )}
          </p>
          {ignored.size > 0 && (
            <p className="mt-1 text-xs text-slate-600">
              {ignored.size} sample{ignored.size === 1 ? "" : "s"} ignored for rules (reasons in the
              table).
            </p>
          )}

          <Disclosure
            className="mt-3"
            open={open}
            onToggle={setOpen}
            summary={<span>Raw samples ({samples.length}) — never averaged away</span>}
          >
            <div className="overflow-x-auto">
              <table className="w-full text-xs" aria-label="Raw vitals samples">
                <thead className="text-left text-slate-500">
                  <tr>
                    <th className="py-1 pr-2 font-medium">Time</th>
                    <th className="py-1 pr-2 font-medium">Pulse / conf</th>
                    <th className="py-1 pr-2 font-medium">Breathing / conf</th>
                    <th className="py-1 pr-2 font-medium">HRV / conf</th>
                    <th className="py-1 pr-2 font-medium">Window</th>
                    <th className="py-1 pr-2 font-medium">Source</th>
                    <th className="py-1 pr-2 font-medium">Flags / rules</th>
                  </tr>
                </thead>
                <tbody>
                  {samples.map((s) => (
                    <SampleRow
                      key={s.id}
                      sample={s}
                      active={highlight.has(s.id)}
                      ignoredReason={ignored.get(s.id) ?? null}
                      eligible={eligible.has(s.id)}
                      onFocus={() => onFocusId(s.id)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </Disclosure>
        </>
      )}
    </Card>
  );
}

function Stat({
  label,
  value,
  unit,
  isMeasured,
}: {
  label: string;
  value: string;
  unit: string;
  isMeasured: boolean;
}) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="flex flex-wrap items-center gap-1.5">
        <span className="tnum text-lg font-semibold text-slate-900">{value}</span>
        <span className="text-xs text-slate-500">{unit}</span>
        {value !== "—" && <MeasuredBadge isMeasured={isMeasured} />}
      </dd>
    </div>
  );
}

function SampleRow({
  sample,
  active,
  ignoredReason,
  eligible,
  onFocus,
}: {
  sample: VitalsSampleRow;
  active: boolean;
  ignoredReason: string | null;
  eligible: boolean;
  onFocus: () => void;
}) {
  return (
    <tr
      data-sample-id={sample.id}
      data-highlighted={active ? "true" : "false"}
      className={cx(
        "border-t border-slate-100 align-top",
        highlightClass(active),
        ignoredReason && "text-slate-500",
      )}
    >
      <td className="py-1 pr-2">
        <button
          type="button"
          onClick={onFocus}
          className="tnum rounded px-1 text-left hover:bg-slate-100"
          title={`Sample ${sample.id}`}
          aria-pressed={active}
        >
          <Time iso={sample.ts_utc} style="time" />
        </button>
      </td>
      <td className="tnum py-1 pr-2">
        {formatVital(sample.pulse_bpm)}{" "}
        <span className="text-slate-500">/ {formatConfidence(sample.pulse_conf)}</span>
      </td>
      <td className="tnum py-1 pr-2">
        {formatVital(sample.breathing_bpm)}{" "}
        <span className="text-slate-500">/ {formatConfidence(sample.breathing_conf)}</span>
      </td>
      <td className="tnum py-1 pr-2">
        {formatVital(sample.hrv_rmssd_ms)}{" "}
        <span className="text-slate-500">/ {formatConfidence(sample.hrv_conf)}</span>
      </td>
      <td className="tnum py-1 pr-2">{sample.window_s}s</td>
      <td className="py-1 pr-2">
        <MeasuredBadge isMeasured={sample.is_measured} source={sample.source} />
      </td>
      <td className="py-1 pr-2">
        <div className="flex flex-wrap gap-1">
          {(sample.quality_flags ?? []).map((f) => (
            <Chip key={f} className="bg-slate-100 text-slate-700 border-slate-300">
              {f}
            </Chip>
          ))}
          {ignoredReason ? (
            <Chip className="bg-red-50 text-red-800 border-red-300" title={ignoredReason}>
              ignored: {ignoredReason}
            </Chip>
          ) : eligible ? (
            <Chip className="bg-green-100 text-green-800 border-green-300">used by rules</Chip>
          ) : null}
        </div>
      </td>
    </tr>
  );
}
