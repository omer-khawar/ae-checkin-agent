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
import { Badge } from "@/ui/badge";
import { tierBadgeKind } from "@/ui/badge-kinds";
import { cx, formatCountdown, Time } from "../../../lib/format";
import type {
  CheckInDetail,
  CheckInDetailR3,
  ClockRow,
  Escalation,
  Evidence,
  ProtocolAssessment,
  Role,
  RuleFiredPlain,
} from "../../../lib/types";
import { CategoryChip, Chip, EvidenceList, Panel, SdtmBadge } from "./bits";
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
  const [plain, setPlain] = useState(true);
  const hasAeDraft = (detail.drafts ?? []).some(
    (d) => d.domain === "AE" && d.status !== "rejected" && d.status !== "superseded",
  );
  return (
    <div className="space-y-3">
      <Panel title="Why" aside={tierChip(tier)}>
        {r ? (
          <>
            <p className="text-table font-medium text-foreground" data-testid="why-plain">
              Alert level: {tierName(r.escalation_tier)}.{" "}
              <span className="font-normal text-muted-foreground">
                The highest grade was {r.max_grade} (provisional, investigator to confirm)
                {r.red_flag_tier_floor > r.base_tier && "; a warning sign raised the level"}
                {typeof protocolFloor === "number" &&
                  protocolFloor > r.base_tier &&
                  "; a study-protocol check raised the level"}
                {r.corroboration_bump > 0 && "; vitals added one step"}.
              </span>
              {r.stop_screen && (
                <span className="ml-1 text-danger-fg">The participant saw the stop screen.</span>
              )}
              {r.page_oncall && <span className="ml-1 text-danger-fg">On-call was paged.</span>}
              {r.seriousness_suspected && (
                <span className="ml-1 font-semibold text-danger-fg">
                  This may be a serious event.
                </span>
              )}
            </p>
            <details className="mt-1 text-caption text-muted-foreground">
              <summary className="cursor-pointer text-primary underline">
                How the alert level was computed
              </summary>
              <p className="mt-1 text-foreground" data-testid="why-summary">
                Tier <span className="tabular font-semibold">{r.escalation_tier}</span> = base{" "}
                <span className="tabular font-semibold">{r.base_tier}</span> (from max provisional
                grade <span className="tabular font-semibold">{r.max_grade}</span>), red-flag floor{" "}
                <span className="tabular font-semibold">{r.red_flag_tier_floor}</span>
                {typeof protocolFloor === "number" && (
                  <>
                    , protocol floor <span className="tabular font-semibold">{protocolFloor}</span>
                  </>
                )}
                , vitals bump <span className="tabular font-semibold">+{r.corroboration_bump}</span>
              </p>
            </details>
          </>
        ) : (
          <p className="text-table text-subtle-foreground">No rules result on this check-in.</p>
        )}
        <p className="mt-1 text-caption text-subtle-foreground">
          Grades come only from the participant&apos;s answers; vitals can move the alert level by
          at most one step and never change a grade.
        </p>

        {rules.length === 0 ? (
          <p className="mt-3 text-table text-subtle-foreground">No rules fired.</p>
        ) : (
          <>
            <label className="mt-3 flex items-center gap-1.5 text-caption text-muted-foreground">
              <input
                type="checkbox"
                checked={plain}
                onChange={(e) => setPlain(e.target.checked)}
                className="size-3.5"
              />
              Explain in plain English
            </label>
            <div
              className="mt-1 grid grid-cols-[1fr_auto] gap-x-2 border-b border-border px-2 pb-1 text-caption font-medium text-subtle-foreground"
              aria-hidden="true"
            >
              <span>Rule</span>
              <span>Kind</span>
            </div>
            <ol className="divide-y divide-border" aria-label="Rules fired">
              {rules.map((rule, i) => (
                <RuleRow
                  key={`${rule.rule_id}:${i}`}
                  index={i + 1}
                  rule={rule}
                  detail={detail}
                  labels={r3.labels}
                  itemLabel={itemLabel}
                  plain={plain}
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
          </>
        )}
      </Panel>

      {r3.protocol && <ProtocolBox protocol={r3.protocol} itemLabel={itemLabel} />}
      <EscalationBox escalation={detail.escalation} onAck={onAck} />
      {clocks.length === 0 ? (
        <Panel title="24-hour report clock">
          <p className="text-table text-subtle-foreground">
            No 24-hour report clock: no hospital or emergency-room visit was reported, and no
            possible special-interest event was found.
          </p>
        </Panel>
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
  plain,
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
  plain: boolean;
  selected: boolean;
  cited: boolean;
  onSelect: () => void;
  onFocusEvidence: (e: Evidence) => void;
}) {
  const inputs = Object.entries(rule.inputs ?? {});
  const active = selected || cited;
  const sentence = ruleSentence(rule, { labels, itemLabel });
  const inputsTitle = inputs.length
    ? `Inputs: ${inputs.map(([k, v]) => `${k} = ${formatValue(v)}`).join("; ")}`
    : "Show the rule id, its inputs and the evidence it used";
  return (
    <li
      data-rule-id={rule.rule_id}
      data-highlighted={active ? "true" : "false"}
      className={cx(highlightClass(active))}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-expanded={selected}
        className="grid min-h-row w-full grid-cols-[1fr_auto] items-start gap-x-2 px-2 py-1 text-left text-table hover:bg-surface-subtle"
        title={inputsTitle}
      >
        <span className="min-w-0 text-foreground">
          <span className="tabular mr-1 text-caption text-subtle-foreground">{index}.</span>
          {plain ? sentence : <span className="font-mono text-caption">{rule.rule_id}</span>}
          {cited && !selected && (
            <Chip className="ml-1.5 border-info-border bg-info-bg text-info-fg">
              cited by selected field
            </Chip>
          )}
        </span>
        <span className="flex items-center gap-1">
          <CategoryChip category={rule.category} />
        </span>
      </button>
      {selected && (
        <div className="space-y-1.5 px-2 pb-2 pl-6" data-testid="rule-details">
          <div className="flex flex-wrap items-center gap-1.5 text-caption text-muted-foreground">
            Rule <SdtmBadge>{rule.rule_id}</SdtmBadge>
          </div>
          {rule.description && rule.description !== sentence && (
            <p className="text-caption text-foreground">Engine description: {rule.description}</p>
          )}
          {rule.effect && (
            <p className="text-caption text-foreground">
              Effect: <span className="font-medium">{rule.effect}</span>
            </p>
          )}
          {inputs.length > 0 && (
            <dl
              className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-caption"
              aria-label="Rule inputs"
            >
              {inputs.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="font-mono text-muted-foreground">{k}</dt>
                  <dd className="break-words text-foreground">{formatValue(v)}</dd>
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

function tierChip(tier: number | null | undefined, short?: boolean) {
  const kind = tierBadgeKind(tier);
  return kind ? <Badge kind={kind} short={short} size="sm" /> : null;
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
    <Panel
      title="Study protocol"
      aside={
        protocol.protocol_id ? <SdtmBadge title="Protocol">{protocol.protocol_id}</SdtmBadge> : null
      }
    >
      {nothing && <p className="text-table text-subtle-foreground">No protocol rule applied.</p>}
      <ul className="space-y-2 text-table" aria-label="Protocol checks">
        {protocol.aesi_suspected && (
          <li className="rounded-control border border-aesi-border bg-aesi-bg px-2 py-1.5 text-aesi-fg">
            <span className="font-medium">
              Possible special-interest event (report within 24 h, investigator to confirm)
            </span>
            {aesiItems.length > 0 && <span>: {aesiItems.join(", ")}</span>}
            {(protocol.aesi_reasons ?? []).length > 0 && (
              <ul className="mt-1 list-disc pl-5 text-caption text-aesi-fg">
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
                    "inline-flex rounded-md border px-1.5 py-0.5 text-caption font-semibold",
                    chip.className,
                  )}
                  title={chip.title}
                >
                  {chip.text}
                </span>
                <span className="font-medium text-foreground">{f.drug}</span>
                {f.protocol_ref && (
                  <span className="text-caption text-subtle-foreground">
                    p. {f.protocol_ref.printed_page}
                  </span>
                )}
              </div>
              {f.exception_text && (
                <p className="mt-0.5 text-caption text-foreground">
                  Protocol exception: <q>{f.exception_text}</q>
                </p>
              )}
            </li>
          );
        })}
        {missing.length > 0 && (
          <li className="text-caption text-foreground">{cmMissingText(missing)}</li>
        )}
        {protocol.within_ae_reporting_window === false && (
          <li className="text-caption text-warning-fg">
            Outside the protocol&apos;s side-effect reporting window (90 days after the last dose;
            protocol §9.4.1).
          </li>
        )}
      </ul>
    </Panel>
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
      <Panel title="Escalation">
        <p className="text-table text-subtle-foreground">
          No escalation was raised for this check-in.
        </p>
      </Panel>
    );
  }
  const acked = escalation.acked_at !== null;
  return (
    <Panel title="Escalation" aside={tierChip(escalation.tier, true)}>
      <ul
        className="list-disc space-y-0.5 pl-5 text-table text-foreground"
        aria-label="Escalation reasons"
      >
        {(escalation.reasons ?? []).map((reason, i) => (
          <li key={i}>{reason}</li>
        ))}
        {(!escalation.reasons || escalation.reasons.length === 0) && (
          <li className="text-subtle-foreground">No reasons recorded.</li>
        )}
      </ul>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-caption">
        <dt className="text-muted-foreground">Paged</dt>
        <dd>
          {escalation.paged_at ? (
            <Time iso={escalation.paged_at} />
          ) : (
            <span className="text-subtle-foreground">not paged (below Urgent)</span>
          )}
        </dd>
        <dt className="text-muted-foreground">Acknowledged</dt>
        <dd>
          {acked ? (
            <>
              by <span className="font-medium">{escalation.acked_by}</span> at{" "}
              <Time iso={escalation.acked_at} />
              {escalation.seconds_to_ack !== null && (
                <span className="tabular text-muted-foreground">
                  {" "}
                  ({formatCountdown(escalation.seconds_to_ack)} after the page)
                </span>
              )}
            </>
          ) : (
            <span className="font-medium text-warning-fg">not yet</span>
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
            <p role="alert" className="mt-1 text-caption text-danger-fg">
              {error}
            </p>
          )}
        </div>
      )}
    </Panel>
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
    <Panel
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
      <p className="text-table text-foreground">
        {clockName(kind)} within 24 hours of the site knowing.
      </p>
      <p className="mt-0.5 text-caption text-muted-foreground">
        {kind === "aesi" ? (
          <>{clockNote("aesi")}</>
        ) : (
          <>
            Seriousness is <strong>suspected</strong>, not decided. The clock stops only when an
            investigator records the seriousness decision.
          </>
        )}
      </p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-table">
        <dt className="text-caption text-muted-foreground">Site aware at</dt>
        <dd>
          <Time iso={clock.site_awareness_at} />
        </dd>
        <dt className="text-caption text-muted-foreground">Report due</dt>
        <dd>
          <Time iso={clock.due_at} />
        </dd>
        <dt className="text-caption text-muted-foreground">{running ? "Remaining" : "At stop"}</dt>
        <dd
          className={cx(
            "tabular text-body font-semibold",
            overdue ? "text-danger-fg" : "text-foreground",
          )}
          data-testid="sae-countdown"
        >
          {/* Deliberately NOT aria-live: it re-renders every second and would be
              read out continuously. The status region below changes only when
              the clock crosses its due time. */}
          {formatCountdown(remaining)}
        </dd>
        {!running && (
          <>
            <dt className="text-caption text-muted-foreground">Stopped</dt>
            <dd className="text-table">
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
        hidePacket
        className="mt-2"
        clock={clock}
        role={role}
        hasAeDraft={hasAeDraft}
        onStopped={onStopped}
      />
      {info.length > 0 && (
        <div className="mt-3">
          <h3 className="text-caption font-semibold uppercase tracking-wide text-muted-foreground">
            Informational sponsor deadlines
          </h3>
          <p className="text-caption text-subtle-foreground">
            21 CFR 312.32; owned by the sponsor, not by Interim.
          </p>
          <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-caption">
            {info.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted-foreground">{informationalLabel(k)}</dt>
                <dd>{/^\d{4}-\d{2}-\d{2}/.test(v) ? <Time iso={v} /> : v}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </Panel>
  );
}
