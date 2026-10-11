/**
 * /dashboard/checkins/:sessionId — the "explains itself" page (CLAUDE.md §3.7.2).
 *
 * Three columns (stacked on narrow screens):
 *   LEFT    answers in order + gate answers + vitals (summary and raw samples)
 *   MIDDLE  AE / VS / CM drafts; every field is clickable → its Evidence[]
 *   RIGHT   "Why": every rule fired, escalation box, SAE clock
 *
 * One piece of state ties the columns together: `selection` (a draft field or
 * a rule). Its evidence ids become `highlight`, and every answer row, vitals
 * sample row and rule row lights up when its id is in that set. Clicking an
 * answer or a sample does the reverse: it highlights the rules that cite it.
 *
 * Plain language first (CLAUDE.md §00, CONTRACTS.md R3.2/R3.3): field labels
 * come from the API's `labels` map (local fallback table in detail/plain.ts),
 * SDTM names sit in small monospace badges, and the Why panel leads with one
 * plain sentence per rule. Protocol flags (possible AESI, prohibited /
 * discouraged medications, missing medication-form fields), the report packet
 * entry point and the investigator's immune-related choice (R4.3) are here too.
 *
 * This file owns the API mutations (confirm / reject / patch / attribution /
 * ack) and the toasts; the columns under ./detail/ only render.
 */
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { Button } from "../../components/Button";
import { ErrorBanner } from "../../components/ErrorBanner";
import { MeasuredBadge } from "../../components/MeasuredBadge";
import { TierChip } from "../../components/TierChip";
import { useToast } from "../../components/Toast";
import { ackEscalation, confirmDraft, isApiError, patchDraft, rejectDraft } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { Time, vitalsStatusLabel } from "../../lib/format";
import type { CheckInDetail as CheckInDetailT, Draft, Escalation, Evidence } from "../../lib/types";
import { AnswersColumn } from "./detail/AnswersColumn";
import { DraftsColumn, type DraftActions } from "./detail/DraftsColumn";
import {
  allRules,
  highlightSet,
  selectionEvidence,
  vitalsProvenance,
  type Selection,
} from "./detail/model";
import { attributionClockEffects, clocksForDraft, clocksOf, tierName } from "./detail/plain";
import { briefPath, patchAttributionR4 } from "./detail/r34Api";
import type { AttributionRequestR4, CheckInDetailR3 } from "./detail/r34Types";
import { useCheckIn } from "./detail/useCheckIn";
import { WhyPanel } from "./detail/WhyPanel";

export function CheckInDetail() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const { role } = useAuth();
  const toast = useToast();
  const { detail, items, ctcae, loading, error, reload, setDetail } = useCheckIn(sessionId);

  const [selection, setSelection] = useState<Selection>(null);
  /** Extra ids to highlight when the user clicks an answer/sample/evidence pointer directly. */
  const [focusedId, setFocusedId] = useState<string | null>(null);

  // The evidence set behind the selection, plus the focused id and the rules that cite it.
  const highlight = useMemo(() => {
    if (!detail) return new Set<string>();
    const set = highlightSet(selectionEvidence(selection, detail));
    if (focusedId) {
      set.add(focusedId);
      for (const r of allRules(detail)) {
        if ((r.evidence ?? []).some((e) => e.id === focusedId)) set.add(r.rule_id);
      }
    }
    return set;
  }, [detail, selection, focusedId]);

  // Item labels for plain rule sentences and the AESI item match (optional data).
  const itemLabel = useMemo(() => {
    const byId = new Map((items ?? []).map((i) => [i.id, i.label]));
    return (id: string) => byId.get(id) ?? id.replace(/_/g, " ");
  }, [items]);
  const itemIdForTerm = useMemo(() => {
    const byTerm = new Map((items ?? []).map((i) => [i.ctcae_term?.toLowerCase(), i.id]));
    return (term: string) => byTerm.get(term.toLowerCase()) ?? null;
  }, [items]);

  const selectField = (draftId: string, field: string) => {
    setFocusedId(null);
    setSelection((s) =>
      s?.kind === "field" && s.draftId === draftId && s.field === field
        ? null
        : { kind: "field", draftId, field },
    );
  };
  // Rules are selected by position: the same rule_id can fire more than once
  // (one draft.ae per AE draft, one vitals.implausible per sample), and each
  // occurrence must be selectable on its own.
  const selectRule = (ruleId: string, index: number) => {
    setFocusedId(null);
    setSelection((s) =>
      s?.kind === "rule" && s.index === index && s.ruleId === ruleId
        ? null
        : { kind: "rule", ruleId, index },
    );
  };
  const focusId = (id: string) => setFocusedId((cur) => (cur === id ? null : id));
  const focusEvidence = (e: Evidence) => {
    if (e.kind === "rule") {
      // An evidence pointer carries only the id, so it addresses the first occurrence.
      const index = detail ? allRules(detail).findIndex((r) => r.rule_id === e.id) : -1;
      if (index >= 0) selectRule(e.id, index);
      else focusId(e.id);
    } else {
      focusId(e.id);
    }
  };

  /** Swap the returned draft into the list: it either replaces its own id or supersedes a row. */
  const applyDraft = (next: Draft) =>
    setDetail((d) => {
      const drafts = d.drafts.map((x) =>
        x.id === next.id
          ? next
          : x.id === next.supersedes_id
            ? { ...x, status: "superseded" as const }
            : x,
      );
      if (!drafts.some((x) => x.id === next.id)) drafts.push(next);
      return { ...d, drafts };
    });

  const actions: DraftActions = {
    confirm: async (draft, note) => {
      applyDraft(await confirmDraft(draft.id, note || undefined));
      toast.push({ kind: "success", title: `${draft.domain} draft confirmed` });
      reload();
    },
    reject: async (draft, reason) => {
      applyDraft(await rejectDraft(draft.id, reason));
      toast.push({ kind: "info", title: `${draft.domain} draft rejected` });
      reload();
    },
    patch: async (draft, fields, note) => {
      const next = await patchDraft(draft.id, fields, note || undefined);
      applyDraft(next);
      setSelection(null);
      toast.push({ kind: "success", title: `${draft.domain} draft saved as v${next.version}` });
      reload();
    },
    attribution: async (draft, body: AttributionRequestR4) => {
      // Which running clocks this answer stops, by kind, before the reload
      // refreshes them (AESER → SAE clock, INTERIM_IRAE = N → AESI clock; API
      // services/drafts.py). No running clock of that kind → nothing is said.
      const effects = attributionClockEffects(
        body,
        detail ? clocksForDraft(clocksOf(detail as unknown as CheckInDetailR3), draft) : [],
      );
      applyDraft(await patchAttributionR4(draft.id, body));
      toast.push({
        kind: "success",
        title: "Investigator assessment recorded",
        message: effects.length ? effects.join(" ") : undefined,
      });
      reload();
    },
  };

  const ack = async (esc: Escalation) => {
    const updated = await ackEscalation(esc.id);
    setDetail((d) => ({ ...d, escalation: updated }));
    toast.push({ kind: "success", title: "Escalation acknowledged" });
  };

  // ---- states --------------------------------------------------------------
  if (loading && !detail) {
    return (
      <div className="space-y-3" aria-busy="true">
        <h1 className="text-2xl font-bold text-slate-900">Check-in</h1>
        <p className="text-slate-600" role="status">
          Loading check-in {sessionId}…
        </p>
      </div>
    );
  }
  if (error && !detail) {
    const notFound = isApiError(error) && error.isNotFound;
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-slate-900">Check-in</h1>
        <ErrorBanner
          error={error}
          message={notFound ? "Check-in not found" : "Could not load this check-in"}
          onRetry={reload}
        />
        <p>
          <Link to="/dashboard" className="text-brand-700 underline">
            Back to the queue
          </Link>
        </p>
      </div>
    );
  }
  if (!detail) return null;

  return (
    <div className="space-y-4">
      <Header detail={detail} onReload={reload} loading={loading} />
      {error !== null && (
        <ErrorBanner
          error={error}
          message="Refresh failed; showing the last loaded version"
          onRetry={reload}
        />
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="min-w-0">
          <AnswersColumn detail={detail} items={items} highlight={highlight} onFocusId={focusId} />
        </div>
        <div className="min-w-0">
          <DraftsColumn
            detail={detail}
            role={role}
            ctcae={ctcae}
            itemIdForTerm={itemIdForTerm}
            selection={selection}
            highlight={highlight}
            onSelectField={selectField}
            onFocusEvidence={focusEvidence}
            actions={actions}
          />
        </div>
        <div className="min-w-0">
          <WhyPanel
            detail={detail}
            selection={selection}
            highlight={highlight}
            onSelectRule={selectRule}
            onFocusEvidence={focusEvidence}
            onAck={ack}
            role={role}
            itemLabel={itemLabel}
            onClockStopped={() => reload()}
          />
        </div>
      </div>
    </div>
  );
}

function Header({
  detail,
  onReload,
  loading,
}: {
  detail: CheckInDetailT;
  onReload: () => void;
  loading: boolean;
}) {
  const s = detail.session;
  const p = detail.participant;
  const tier = detail.result?.escalation_tier ?? s?.tier ?? null;
  const r3 = detail as unknown as CheckInDetailR3;
  const consentBasis = r3.session?.consent_basis;
  const runningClocks = clocksOf(r3).filter((c) => c.stopped_at === null);
  // Same derivation as the Vitals card, so header and card never disagree
  // (the summary is null when no sample was usable, but the samples still
  // carry their own is_measured / source).
  const vitals = vitalsProvenance(detail);
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="text-xs text-slate-500">
          <Link to="/dashboard" className="text-brand-700 underline">
            Queue
          </Link>
          <span aria-hidden="true"> / </span>
          check-in <span className="font-mono">{s?.id}</span>
        </div>
        <h1 className="mt-0.5 flex flex-wrap items-center gap-2 text-2xl font-bold text-slate-900">
          <Link
            to={`/dashboard/participants/${encodeURIComponent(s?.usubjid ?? "")}`}
            className="hover:underline"
            title={s?.usubjid}
          >
            {p?.display_label ?? s?.usubjid ?? "Participant"}
          </Link>
          <TierChip tier={tier} />
          {s?.is_eval && (
            <span className="rounded-md border border-slate-300 bg-slate-100 px-1.5 py-0.5 text-[11px] font-semibold text-slate-700">
              eval session
            </span>
          )}
          {vitals.hasSamples && (
            <MeasuredBadge isMeasured={vitals.isMeasured} source={vitals.source} size="md" />
          )}
        </h1>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-sm text-slate-600">
          <span>
            Started <Time iso={s?.started_at} />
          </span>
          <span>
            Completed <Time iso={s?.completed_at} fallback="not completed" />
          </span>
          <span title={tier !== null ? `Alert level: ${tierName(tier)}` : undefined}>
            {consentBasis === "enrollment_icf" || consentBasis
              ? `Consent: enrollment consent form${s?.consent_camera === false ? " · camera off" : ""}`
              : `Camera consent: ${s?.consent_camera ? "yes" : "no"}`}
          </span>
          <span>
            Vitals:{" "}
            {vitalsStatusLabel(
              detail.result?.vitals?.status ?? detail.vitals?.status ?? s?.vitals_status,
            )}
          </span>
          {s?.stop_screen_shown && (
            <span className="font-medium text-red-700">Stop screen was shown</span>
          )}
          <span className="text-violet-800">Participant is synthetic</span>
          {runningClocks.length > 0 && (
            <span className="font-medium text-red-700">
              {runningClocks.length === 1
                ? "A 24-hour report clock is running"
                : `${runningClocks.length} 24-hour report clocks are running`}
            </span>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {s?.usubjid && (
          <Link
            to={briefPath(s.usubjid)}
            className="inline-flex min-h-9 items-center rounded-xl border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-900 hover:bg-slate-100 focus-visible:ring-4"
          >
            Visit brief
          </Link>
        )}
        <Button size="sm" variant="secondary" onClick={onReload} busy={loading}>
          Refresh
        </Button>
      </div>
    </header>
  );
}
