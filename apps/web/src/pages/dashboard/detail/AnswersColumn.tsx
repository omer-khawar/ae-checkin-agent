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

import {
  cx,
  formatConfidence,
  formatVital,
  Time,
  vitalsStatusLabel,
  vsMethod,
} from "../../../lib/format";
import type { Answer, CheckInDetail, Item, VitalsSampleRow } from "../../../lib/types";
import { Chip, Disclosure, Panel, Prov } from "./bits";
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
    <div className="space-y-3">
      <Panel
        title="Answers"
        aside={
          <span className="text-caption text-subtle-foreground">
            {pro.length} item answer{pro.length === 1 ? "" : "s"} · in order received
          </span>
        }
        flush
      >
        {pro.length === 0 ? (
          <p className="p-3 text-table text-subtle-foreground">No item answers were recorded.</p>
        ) : (
          <ol className="divide-y divide-border" aria-label="Item answers">
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
      </Panel>

      <Panel title="Gate questions" flush>
        {gates.length === 0 ? (
          <p className="p-3 text-table text-subtle-foreground">No gate answers were recorded.</p>
        ) : (
          <ol className="divide-y divide-border" aria-label="Gate answers">
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
      </Panel>

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
          "flex min-h-row w-full items-center gap-2 px-3 py-1 text-left text-table hover:bg-surface-subtle",
          highlightClass(active),
        )}
        aria-pressed={active}
        title={`Answer ${answer.id}`}
      >
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-foreground">{label}</div>
          <div className="text-caption text-muted-foreground">
            <span className="capitalize">{answer.attribute}</span>
            <span aria-hidden="true"> · </span>
            <span className="font-medium text-foreground">
              {option ?? humanize(String(answer.value_int ?? "—"))}
            </span>
            {answer.value_int !== null && (
              <span className="tabular text-subtle-foreground"> ({answer.value_int})</span>
            )}
            {answer.value_text && <span className="text-foreground"> · {answer.value_text}</span>}
          </div>
        </div>
        <div className="tabular shrink-0 text-right text-caption text-subtle-foreground">
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
          "flex min-h-row w-full items-start gap-2 px-3 py-1.5 text-left text-table hover:bg-surface-subtle",
          highlightClass(active),
        )}
        aria-pressed={active}
        title={`Answer ${answer.id}`}
      >
        <div className="min-w-0 flex-1">
          <div className="font-medium text-foreground">{label}</div>
          <div
            className={cx(
              "mt-0.5",
              g.verbatim
                ? "whitespace-pre-wrap rounded-control bg-surface-subtle px-2 py-1 font-mono text-foreground"
                : "text-foreground",
              g.empty && "text-subtle-foreground",
            )}
          >
            {g.text}
          </div>
          {g.verbatim && (
            <div className="mt-1 flex flex-wrap gap-1">
              <Chip className="border-neutral-border bg-neutral-bg text-neutral-fg">
                {g.matchedOnly
                  ? "verbatim · compared by string distance only, never parsed"
                  : "verbatim, never parsed"}
              </Chip>
            </div>
          )}
        </div>
        <div className="tabular shrink-0 text-right text-caption text-subtle-foreground">
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
    <Panel
      title="Vitals"
      aside={
        <span className="flex items-center gap-2">
          <Chip
            className="border-neutral-border bg-neutral-bg text-neutral-fg"
            title="Vitals status from the rules engine"
          >
            {vitalsStatusLabel(status)}
          </Chip>
          {samples.length > 0 && <Prov isMeasured={isMeasured} source={source} />}
        </span>
      }
    >
      {!detail.session?.consent_camera && (
        <p className="mb-2 text-table text-muted-foreground">
          Camera was turned off; the check-in ran without vitals.
        </p>
      )}
      {samples.length === 0 ? (
        <p className="text-table text-subtle-foreground">
          No vitals samples were captured for this session.
        </p>
      ) : (
        <>
          {summary ? (
            <dl className="divide-y divide-border text-table">
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
              <div className="flex min-h-row items-center gap-2 py-1">
                <dt className="w-32 shrink-0 text-muted-foreground">Samples</dt>
                <dd className="tabular text-foreground">
                  {summary.n_eligible} usable of {summary.n_samples}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="text-table text-subtle-foreground">
              No summary: no sample was usable for the rules.
            </p>
          )}
          <p className="mt-2 text-caption text-muted-foreground">
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
            <p className="mt-1 text-caption text-muted-foreground">
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
              <table className="w-full text-caption" aria-label="Raw vitals samples">
                <thead className="text-left text-subtle-foreground">
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
    </Panel>
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
    <div className="flex min-h-row items-center gap-2 py-1">
      <dt className="w-32 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        <span className="tabular font-semibold text-foreground">{value}</span>
        <span className="text-caption text-subtle-foreground">{unit}</span>
        {value !== "—" && <Prov isMeasured={isMeasured} />}
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
        "border-t border-border align-top",
        highlightClass(active),
        ignoredReason && "text-subtle-foreground",
      )}
    >
      <td className="py-1 pr-2">
        <button
          type="button"
          onClick={onFocus}
          className="tabular whitespace-nowrap rounded px-1 text-left hover:bg-surface-subtle"
          title={`Sample ${sample.id}`}
          aria-pressed={active}
        >
          <Time iso={sample.ts_utc} style="time" />
        </button>
      </td>
      <td className="tabular py-1 pr-2">
        {formatVital(sample.pulse_bpm)}{" "}
        <span className="text-subtle-foreground">/ {formatConfidence(sample.pulse_conf)}</span>
      </td>
      <td className="tabular py-1 pr-2">
        {formatVital(sample.breathing_bpm)}{" "}
        <span className="text-subtle-foreground">/ {formatConfidence(sample.breathing_conf)}</span>
      </td>
      <td className="tabular py-1 pr-2">
        {formatVital(sample.hrv_rmssd_ms)}{" "}
        <span className="text-subtle-foreground">/ {formatConfidence(sample.hrv_conf)}</span>
      </td>
      <td className="tabular py-1 pr-2">{sample.window_s}s</td>
      <td className="py-1 pr-2">
        <Prov isMeasured={sample.is_measured} source={sample.source} />
      </td>
      <td className="py-1 pr-2">
        <div className="flex flex-wrap gap-1">
          {(sample.quality_flags ?? []).map((f) => (
            <Chip key={f} className="border-neutral-border bg-neutral-bg text-neutral-fg">
              {f}
            </Chip>
          ))}
          {ignoredReason ? (
            <Chip
              className="border-danger-border bg-danger-bg text-danger-fg"
              title={ignoredReason}
            >
              ignored: {ignoredReason}
            </Chip>
          ) : eligible ? (
            <Chip className="border-success-border bg-success-bg text-success-fg">
              used by rules
            </Chip>
          ) : null}
        </div>
      </td>
    </tr>
  );
}
