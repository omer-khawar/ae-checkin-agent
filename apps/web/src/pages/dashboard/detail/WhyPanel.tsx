/**
 * RIGHT column: the "Why" panel. Every rule that fired, in engine order, with
 * its category, id, plain-English description, the inputs it used, its effect
 * and its evidence pointers; a one-line tier summary on top; then the
 * escalation box (acknowledge) and the SAE clock box (live countdown).
 *
 * Rules are rows that highlight when a selected draft field cites them, and
 * selecting a rule highlights its own evidence in the left column.
 */
import { useEffect, useState } from "react";

import { Button } from "../../../components/Button";
import { Card } from "../../../components/Card";
import { TierChip } from "../../../components/TierChip";
import { cx, formatCountdown, Time } from "../../../lib/format";
import type {
  CheckInDetail,
  Escalation,
  Evidence,
  RuleFired,
  SAEClockRow,
} from "../../../lib/types";
import { CategoryChip, Chip, EvidenceList } from "./bits";
import {
  allRules,
  formatValue,
  highlightClass,
  informationalLabel,
  secondsUntil,
  stoppedRemaining,
  type Selection,
} from "./model";

export interface WhyPanelProps {
  detail: CheckInDetail;
  selection: Selection;
  highlight: Set<string>;
  /** `index` is the rule's position in `allRules(detail)`; ids can repeat. */
  onSelectRule: (ruleId: string, index: number) => void;
  onFocusEvidence: (e: Evidence) => void;
  onAck: (escalation: Escalation) => Promise<void>;
}

export function WhyPanel({
  detail,
  selection,
  highlight,
  onSelectRule,
  onFocusEvidence,
  onAck,
}: WhyPanelProps) {
  const r = detail.result;
  const rules = allRules(detail);
  return (
    <div className="space-y-4">
      <Card title="Why" aside={<TierChip tier={r?.escalation_tier ?? detail.session?.tier} />}>
        {r ? (
          <p className="text-sm text-slate-800" data-testid="why-summary">
            Tier <span className="tnum font-semibold">{r.escalation_tier}</span> = base{" "}
            <span className="tnum font-semibold">{r.base_tier}</span> (from max provisional grade{" "}
            <span className="tnum font-semibold">{r.max_grade}</span>), red-flag floor{" "}
            <span className="tnum font-semibold">{r.red_flag_tier_floor}</span>, vitals bump{" "}
            <span className="tnum font-semibold">+{r.corroboration_bump}</span>
            {r.stop_screen && <span className="ml-1 text-red-700">· stop screen shown</span>}
            {r.page_oncall && <span className="ml-1 text-red-700">· on-call paged</span>}
            {r.seriousness_suspected && (
              <span className="ml-1 font-semibold text-red-700">· seriousness suspected</span>
            )}
          </p>
        ) : (
          <p className="text-sm text-slate-500">No rules result on this check-in.</p>
        )}
        <p className="mt-1 text-xs text-slate-500">
          Grades come only from the participant&apos;s answers; vitals can move the tier by at most
          one step and never change a grade.
        </p>

        {rules.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">No rules fired.</p>
        ) : (
          <ol className="mt-3 space-y-1.5" aria-label="Rules fired">
            {rules.map((rule, i) => (
              <RuleRow
                key={`${rule.rule_id}:${i}`}
                index={i + 1}
                rule={rule}
                detail={detail}
                selected={
                  selection?.kind === "rule" &&
                  selection.index === i &&
                  selection.ruleId === rule.rule_id
                }
                cited={highlight.has(rule.rule_id)}
                onSelect={() => onSelectRule(rule.rule_id, i)}
                onFocusEvidence={onFocusEvidence}
              />
            ))}
          </ol>
        )}
      </Card>

      <EscalationBox escalation={detail.escalation} onAck={onAck} />
      <SaeClockBox clock={detail.sae_clock} />
    </div>
  );
}

function RuleRow({
  index,
  rule,
  detail,
  selected,
  cited,
  onSelect,
  onFocusEvidence,
}: {
  index: number;
  rule: RuleFired;
  detail: CheckInDetail;
  selected: boolean;
  cited: boolean;
  onSelect: () => void;
  onFocusEvidence: (e: Evidence) => void;
}) {
  const inputs = Object.entries(rule.inputs ?? {});
  const active = selected || cited;
  return (
    <li
      data-rule-id={rule.rule_id}
      data-highlighted={active ? "true" : "false"}
      className={cx("rounded-lg", highlightClass(active))}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-expanded={selected}
        className="w-full rounded-lg px-2 py-1.5 text-left hover:bg-slate-50"
        title="Show this rule's inputs and highlight its evidence"
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="tnum text-[11px] text-slate-500">{index}.</span>
          <CategoryChip category={rule.category} />
          <span className="font-mono text-[11px] text-slate-600">{rule.rule_id}</span>
          {cited && !selected && (
            <Chip className="bg-amber-100 text-amber-900 border-amber-300">
              cited by selected field
            </Chip>
          )}
        </div>
        <p className="mt-0.5 text-sm text-slate-900">{rule.description}</p>
        {rule.effect && (
          <p className="mt-0.5 text-xs text-slate-700">
            Effect: <span className="font-medium">{rule.effect}</span>
          </p>
        )}
      </button>
      {selected && (
        <div className="px-2 pb-2">
          {inputs.length > 0 && (
            <dl
              className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs"
              aria-label="Rule inputs"
            >
              {inputs.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="font-mono text-slate-600">{k}</dt>
                  <dd className="break-words text-slate-900">{formatValue(v)}</dd>
                </div>
              ))}
            </dl>
          )}
          <div className="mt-1.5">
            <EvidenceList
              evidence={rule.evidence ?? []}
              detail={detail}
              onFocusEvidence={onFocusEvidence}
              compact
              emptyText="This rule cites no pointers."
            />
          </div>
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

function EscalationBox({
  escalation,
  onAck,
}: {
  escalation: Escalation | null;
  onAck: (e: Escalation) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!escalation) {
    return (
      <Card title="Escalation">
        <p className="text-sm text-slate-500">No escalation was raised for this check-in.</p>
      </Card>
    );
  }
  const acked = escalation.acked_at !== null;
  return (
    <Card title="Escalation" aside={<TierChip tier={escalation.tier} short />}>
      <ul
        className="list-disc space-y-0.5 pl-5 text-sm text-slate-800"
        aria-label="Escalation reasons"
      >
        {(escalation.reasons ?? []).map((reason, i) => (
          <li key={i}>{reason}</li>
        ))}
        {(!escalation.reasons || escalation.reasons.length === 0) && (
          <li className="text-slate-500">No reasons recorded.</li>
        )}
      </ul>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        <dt className="text-slate-600">Paged</dt>
        <dd>
          {escalation.paged_at ? (
            <Time iso={escalation.paged_at} />
          ) : (
            <span className="text-slate-500">not paged (below Tier 3)</span>
          )}
        </dd>
        <dt className="text-slate-600">Acknowledged</dt>
        <dd>
          {acked ? (
            <>
              by <span className="font-medium">{escalation.acked_by}</span> at{" "}
              <Time iso={escalation.acked_at} />
              {escalation.seconds_to_ack !== null && (
                <span className="tnum text-slate-600">
                  {" "}
                  ({formatCountdown(escalation.seconds_to_ack)} after the page)
                </span>
              )}
            </>
          ) : (
            <span className="font-medium text-orange-800">not yet</span>
          )}
        </dd>
      </dl>
      {!acked && (
        <div className="mt-3">
          <Button
            size="sm"
            busy={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onAck(escalation);
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Acknowledge escalation
          </Button>
          {error && (
            <p role="alert" className="mt-1 text-xs text-red-700">
              {error}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// SAE clock
// ---------------------------------------------------------------------------

/** Ticks once a second while the clock is running; frozen when stopped. */
function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  return now;
}

function SaeClockBox({ clock }: { clock: SAEClockRow | null }) {
  const running = clock !== null && clock.stopped_at === null;
  const now = useNow(running);
  if (!clock) {
    return (
      <Card title="SAE clock">
        <p className="text-sm text-slate-500">
          No SAE clock: no hospitalization or ER visit was reported.
        </p>
      </Card>
    );
  }
  // Running: live computation from due_at, falling back to the server's
  // snapshot. Stopped: the API nulls seconds_remaining, so "At stop" is the
  // gap between stopped_at and due_at.
  const remaining = running
    ? (secondsUntil(clock.due_at, now) ?? clock.seconds_remaining)
    : stoppedRemaining(clock);
  const overdue = running && remaining !== null && remaining < 0;
  const info = Object.entries(clock.informational ?? {});
  return (
    <Card
      title="SAE clock"
      aside={
        <Chip
          className={
            running
              ? overdue
                ? "bg-red-600 text-white border-red-700"
                : "bg-red-100 text-red-900 border-red-300"
              : "bg-green-100 text-green-800 border-green-300"
          }
        >
          {running ? (overdue ? "overdue" : "running") : "stopped"}
        </Chip>
      }
    >
      <p className="text-xs text-slate-600">
        Seriousness is <strong>suspected</strong>, not decided. The site-to-sponsor clock (24 h from
        site awareness) stops only when an investigator records AESER.
      </p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
        <dt className="text-xs text-slate-600">Site aware at</dt>
        <dd>
          <Time iso={clock.site_awareness_at} />
        </dd>
        <dt className="text-xs text-slate-600">Report due</dt>
        <dd>
          <Time iso={clock.due_at} />
        </dd>
        <dt className="text-xs text-slate-600">{running ? "Remaining" : "At stop"}</dt>
        <dd
          className={cx("tnum text-lg font-semibold", overdue ? "text-red-700" : "text-slate-900")}
          data-testid="sae-countdown"
          aria-live={running ? "polite" : undefined}
        >
          {formatCountdown(remaining)}
        </dd>
        {!running && (
          <>
            <dt className="text-xs text-slate-600">Stopped</dt>
            <dd className="text-sm">
              <Time iso={clock.stopped_at} /> by{" "}
              <span className="font-medium">{clock.stopped_by ?? "—"}</span>
              {clock.decision && (
                <>
                  {" "}
                  · decision <span className="font-mono">{clock.decision}</span>
                </>
              )}
            </dd>
          </>
        )}
      </dl>
      {info.length > 0 && (
        <div className="mt-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600">
            Informational sponsor deadlines
          </h3>
          <p className="text-[11px] text-slate-500">
            21 CFR 312.32; owned by the sponsor, not by Interim.
          </p>
          <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
            {info.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-slate-600">{informationalLabel(k)}</dt>
                <dd>{/^\d{4}-\d{2}-\d{2}/.test(v) ? <Time iso={v} /> : v}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </Card>
  );
}
