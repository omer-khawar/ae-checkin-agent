/**
 * RIGHT column: the "Why" panel. Plain words first (CLAUDE.md §00): one
 * sentence for the alert level, then one plain sentence per rule that fired,
 * in engine order. The rule id, its category, the inputs it used and its
 * evidence pointers are one click deeper (select the rule to open them), never
 * removed. Below: the study-protocol box (R3.1), the escalation box
 * (acknowledge) and one box per 24-hour report clock (SAE or AESI) with a live
 * countdown, "Open report packet" and, when no side-effect record exists to
 * attribute, the investigator's "Record seriousness decision".
 *
 * Rules are rows that highlight when a selected draft field cites them, and
 * selecting a rule highlights its own evidence in the left column.
 */
import { useEffect, useState } from "react";

import { Button } from "../../../components/Button";
import { Card } from "../../../components/Card";
import { TierChip } from "../../../components/TierChip";
import { cx, formatCountdown, Time } from "../../../lib/format";
import type { CheckInDetail, Escalation, Evidence, Role } from "../../../lib/types";
import { CategoryChip, Chip, EvidenceList, SdtmBadge } from "./bits";
import { ClockActions } from "./ClockActions";
import {
  allRules,
  formatValue,
  highlightClass,
  informationalLabel,
  secondsUntil,
  stoppedRemaining,
  type Selection,
} from "./model";
import {
  clockChip,
  clockKind,
  clockName,
  clockNote,
  clocksOf,
  cmMissingText,
  protocolChip,
  ruleSentence,
  tierName,
  type Labels,
} from "./plain";
import type { CheckInDetailR3, ClockRow, ProtocolAssessment, RuleFiredPlain } from "./r34Types";

export interface WhyPanelProps {
  detail: CheckInDetail;
  selection: Selection;
  highlight: Set<string>;
  /** `index` is the rule's position in `allRules(detail)`; ids can repeat. */
  onSelectRule: (ruleId: string, index: number) => void;
  onFocusEvidence: (e: Evidence) => void;
  onAck: (escalation: Escalation) => Promise<void>;
  /** Signed-in role (packet / decision controls). */
  role?: Role | null;
  /** Item id → plain item label, for rule sentences that name items. */
  itemLabel?: (id: string) => string;
  /** A clock was stopped from this page (R4.3); the page reloads. */
  onClockStopped?: (clock: ClockRow) => void;
}

export function WhyPanel({
  detail,
  selection,
  highlight,
  onSelectRule,
  onFocusEvidence,
  onAck,
  role = null,
  itemLabel,
  onClockStopped,
}: WhyPanelProps) {
  const r3 = detail as unknown as CheckInDetailR3;
  const r = detail.result;
  const rules = allRules(detail);
  const tier = r?.escalation_tier ?? detail.session?.tier;
  const protocolFloor = (r as unknown as { protocol_tier_floor?: number } | null)
    ?.protocol_tier_floor;
  const clocks = clocksOf(r3);
  const hasAeDraft = (detail.drafts ?? []).some(
    (d) => d.domain === "AE" && d.status !== "rejected" && d.status !== "superseded",
  );
  return (
    <div className="space-y-4">
      <Card title="Why" aside={<TierChip tier={tier} />}>
        {r ? (
          <>
            <p className="text-sm font-medium text-slate-900" data-testid="why-plain">
              Alert level: {tierName(r.escalation_tier)}.{" "}
              <span className="font-normal text-slate-700">
                The highest grade was {r.max_grade} (provisional, investigator to confirm)
                {r.red_flag_tier_floor > r.base_tier && "; a warning sign raised the level"}
                {typeof protocolFloor === "number" &&
                  protocolFloor > r.base_tier &&
                  "; a study-protocol check raised the level"}
                {r.corroboration_bump > 0 && "; vitals added one step"}.
              </span>
              {r.stop_screen && (
                <span className="ml-1 text-red-700">The participant saw the stop screen.</span>
              )}
              {r.page_oncall && <span className="ml-1 text-red-700">On-call was paged.</span>}
              {r.seriousness_suspected && (
                <span className="ml-1 font-semibold text-red-700">
                  This may be a serious event.
                </span>
              )}
            </p>
            <details className="mt-1 text-xs text-slate-600">
              <summary className="cursor-pointer text-brand-700 underline">
                How the alert level was computed
              </summary>
              <p className="mt-1 text-slate-800" data-testid="why-summary">
                Tier <span className="tnum font-semibold">{r.escalation_tier}</span> = base{" "}
                <span className="tnum font-semibold">{r.base_tier}</span> (from max provisional
                grade <span className="tnum font-semibold">{r.max_grade}</span>), red-flag floor{" "}
                <span className="tnum font-semibold">{r.red_flag_tier_floor}</span>
                {typeof protocolFloor === "number" && (
                  <>
                    , protocol floor <span className="tnum font-semibold">{protocolFloor}</span>
                  </>
                )}
                , vitals bump <span className="tnum font-semibold">+{r.corroboration_bump}</span>
              </p>
            </details>
          </>
        ) : (
          <p className="text-sm text-slate-500">No rules result on this check-in.</p>
        )}
        <p className="mt-1 text-xs text-slate-500">
          Grades come only from the participant&apos;s answers; vitals can move the alert level by
          at most one step and never change a grade.
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
                labels={r3.labels}
                itemLabel={itemLabel}
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

      {r3.protocol && <ProtocolBox protocol={r3.protocol} itemLabel={itemLabel} />}
      <EscalationBox escalation={detail.escalation} onAck={onAck} />
      {clocks.length === 0 ? (
        <Card title="24-hour report clock">
          <p className="text-sm text-slate-500">
            No 24-hour report clock: no hospital or emergency-room visit was reported, and no
            possible special-interest event was found.
          </p>
        </Card>
      ) : (
        clocks.map((c) => (
          <ClockBox
            key={c.id}
            clock={c}
            role={role}
            hasAeDraft={c.has_ae_draft ?? (c.ae_draft_ids ? c.ae_draft_ids.length > 0 : hasAeDraft)}
            onStopped={onClockStopped}
          />
        ))
      )}
    </div>
  );
}

function RuleRow({
  index,
  rule,
  detail,
  labels,
  itemLabel,
  selected,
  cited,
  onSelect,
  onFocusEvidence,
}: {
  index: number;
  rule: RuleFiredPlain;
  detail: CheckInDetail;
  labels: Labels;
  itemLabel?: (id: string) => string;
  selected: boolean;
  cited: boolean;
  onSelect: () => void;
  onFocusEvidence: (e: Evidence) => void;
}) {
  const inputs = Object.entries(rule.inputs ?? {});
  const active = selected || cited;
  const sentence = ruleSentence(rule, { labels, itemLabel });
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
        title="Show the rule id, its inputs and the evidence it used"
      >
        <span className="flex items-start gap-1.5">
          <span className="tnum mt-0.5 text-[11px] text-slate-500">{index}.</span>
          <span className="min-w-0 flex-1 text-sm text-slate-900">{sentence}</span>
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-1.5 pl-4">
          <CategoryChip category={rule.category} />
          {cited && !selected && (
            <Chip className="bg-amber-100 text-amber-900 border-amber-300">
              cited by selected field
            </Chip>
          )}
        </span>
      </button>
      {selected && (
        <div className="space-y-1.5 px-2 pb-2 pl-6" data-testid="rule-details">
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-600">
            Rule <SdtmBadge>{rule.rule_id}</SdtmBadge>
          </div>
          {rule.description && rule.description !== sentence && (
            <p className="text-xs text-slate-700">Engine description: {rule.description}</p>
          )}
          {rule.effect && (
            <p className="text-xs text-slate-700">
              Effect: <span className="font-medium">{rule.effect}</span>
            </p>
          )}
          {inputs.length > 0 && (
            <dl
              className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs"
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
          <EvidenceList
            evidence={rule.evidence ?? []}
            detail={detail}
            onFocusEvidence={onFocusEvidence}
            compact
            emptyText="This rule cites no pointers."
          />
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Study protocol (R3.1 ProtocolAssessment)
// ---------------------------------------------------------------------------

function ProtocolBox({
  protocol,
  itemLabel,
}: {
  protocol: ProtocolAssessment;
  itemLabel?: (id: string) => string;
}) {
  const flags = protocol.conmed_flags ?? [];
  const missing = protocol.cm_missing_fields ?? [];
  const aesiItems = (protocol.aesi_items ?? []).map((id) => (itemLabel ? itemLabel(id) : id));
  const nothing =
    !protocol.aesi_suspected &&
    flags.length === 0 &&
    missing.length === 0 &&
    protocol.within_ae_reporting_window === undefined;
  return (
    <Card
      title="Study protocol"
      aside={
        protocol.protocol_id ? <SdtmBadge title="Protocol">{protocol.protocol_id}</SdtmBadge> : null
      }
    >
      {nothing && <p className="text-sm text-slate-500">No protocol rule applied.</p>}
      <ul className="space-y-2 text-sm" aria-label="Protocol checks">
        {protocol.aesi_suspected && (
          <li className="rounded-lg border border-red-200 bg-red-50 px-2 py-1.5 text-red-900">
            <span className="font-medium">
              Possible special-interest event (report within 24 h, investigator to confirm)
            </span>
            {aesiItems.length > 0 && <span>: {aesiItems.join(", ")}</span>}
            {(protocol.aesi_reasons ?? []).length > 0 && (
              <ul className="mt-1 list-disc pl-5 text-xs text-red-800">
                {(protocol.aesi_reasons ?? []).map((reason, i) => (
                  <li key={i}>{reason}</li>
                ))}
              </ul>
            )}
          </li>
        )}
        {flags.map((f, i) => {
          const chip = protocolChip(f.level, f);
          if (!chip) return null;
          return (
            <li key={`${f.drug}-${i}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={cx(
                    "inline-flex rounded-md border px-1.5 py-0.5 text-xs font-semibold",
                    chip.className,
                  )}
                  title={chip.title}
                >
                  {chip.text}
                </span>
                <span className="font-medium text-slate-900">{f.drug}</span>
                {f.protocol_ref && (
                  <span className="text-xs text-slate-500">p. {f.protocol_ref.printed_page}</span>
                )}
              </div>
              {f.exception_text && (
                <p className="mt-0.5 text-xs text-slate-700">
                  Protocol exception: <q>{f.exception_text}</q>
                </p>
              )}
            </li>
          );
        })}
        {missing.length > 0 && <li className="text-xs text-slate-800">{cmMissingText(missing)}</li>}
        {protocol.within_ae_reporting_window === false && (
          <li className="text-xs text-amber-800">
            Outside the protocol&apos;s side-effect reporting window (90 days after the last dose;
            protocol §9.4.1).
          </li>
        )}
      </ul>
    </Card>
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
            <span className="text-slate-500">not paged (below Urgent)</span>
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
// 24-hour report clock (SAE or AESI)
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

function ClockBox({
  clock,
  role,
  hasAeDraft,
  onStopped,
}: {
  clock: ClockRow;
  role: Role | null;
  hasAeDraft: boolean;
  onStopped?: (clock: ClockRow) => void;
}) {
  const running = clock.stopped_at === null;
  const now = useNow(running);
  const kind = clockKind(clock);
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
      title={
        <span className="flex flex-wrap items-center gap-2">
          {kind === "aesi" ? "Special-interest event report clock" : "Serious-event report clock"}
          <SdtmBadge title={clockName(kind)}>{clockChip(kind)}</SdtmBadge>
        </span>
      }
      data-clock-kind={kind}
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
      <p className="text-sm text-slate-800">
        {clockName(kind)} within 24 hours of the site knowing.
      </p>
      <p className="mt-0.5 text-xs text-slate-600">
        {kind === "aesi" ? (
          <>{clockNote("aesi")}</>
        ) : (
          <>
            Seriousness is <strong>suspected</strong>, not decided. The clock stops only when an
            investigator records the seriousness decision.
          </>
        )}
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
        >
          {/* Deliberately NOT aria-live: it re-renders every second and would be
              read out continuously. The status region below changes only when
              the clock crosses its due time. */}
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
      <span className="sr-only" role="status" data-testid="clock-threshold-status">
        {overdue ? `${clockName(kind)}: overdue.` : ""}
      </span>
      <ClockActions
        className="mt-3"
        clock={clock}
        role={role}
        hasAeDraft={hasAeDraft}
        onStopped={onStopped}
      />
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
