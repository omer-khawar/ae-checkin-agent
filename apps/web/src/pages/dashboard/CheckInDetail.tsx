/**
 * /dashboard/checkins/:sessionId — the "explains itself" page (CLAUDE.md §3.7.2), laid out as a
 * master-detail workbench for a trained coordinator (UI_AUDIT "Check-in detail").
 *
 *   HEADER  participant, received, tier, 24-hour clocks with countdown + "Open report packet",
 *           "Confirm remaining (N)", Plain/Codes label mode
 *   LEFT    answers + gate answers + vitals as compact rows (raw samples behind a disclosure)
 *   MAIN    AE / VS / CM drafts as dense tables; one-click Confirm moves to the next draft
 *   RIGHT   Why: a compact rule table (plain-English toggle), protocol, escalation, clocks
 *
 * Clicking any draft field opens a side sheet listing its Evidence (answer, vitals sample, rule,
 * chart-note quote) and highlights the source row in the other columns. The sheet is not modal,
 * so the highlighted rows stay visible and clickable.
 *
 * Keyboard (ignored while typing): c confirm · e edit · r reject · a acknowledge ·
 * ] / [ next / previous draft · j next queue item.
 *
 * This file owns the API mutations (confirm / reject / patch / attribution / ack) and the toasts;
 * the columns under ./detail/ only render.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { Badge } from "@/ui/badge";
import { tierBadgeKind } from "@/ui/badge-kinds";
import { Button } from "@/ui/button";
import { isTypingTarget } from "@/ui/keyboard";
import { Kbd } from "@/ui/kbd";
import { SegmentedControl } from "@/ui/segmented-control";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/ui/sheet";

import { ErrorBanner } from "../../components/ErrorBanner";
import { useToast } from "../../components/Toast";
import {
  ackEscalation,
  confirmDraft,
  fetchWholeQueue,
  isApiError,
  patchAttribution,
  patchDraft,
  rejectDraft,
} from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { formatCountdown, Time, vitalsStatusLabel } from "../../lib/format";
import { briefPath } from "../../lib/routes";
import type {
  AttributionRequest,
  CheckInDetail as CheckInDetailT,
  CheckInDetailR3,
  ClockRow,
  Draft,
  Escalation,
  Evidence,
} from "../../lib/types";
import { AnswersColumn } from "./detail/AnswersColumn";
import { EvidenceList, Prov } from "./detail/bits";
import { ClockActions } from "./detail/ClockActions";
import { DraftsColumn, type DraftActions, type DraftModeRequest } from "./detail/DraftsColumn";
import {
  allRules,
  highlightSet,
  secondsUntil,
  selectionEvidence,
  vitalsProvenance,
  type Selection,
} from "./detail/model";
import { actionableDrafts, neighbourDraftId, nextQueueSession } from "./detail/nav";
import {
  attributionClockEffects,
  clockChip,
  clockKind,
  clockName,
  clocksForDraft,
  clocksOf,
  fieldLabel,
  tierName,
} from "./detail/plain";
import { useCheckIn } from "./detail/useCheckIn";
import { useLabelMode } from "./detail/useLabelMode";
import { WhyPanel } from "./detail/WhyPanel";

export function CheckInDetail() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const { role } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const { detail, items, ctcae, loading, error, reload, setDetail } = useCheckIn(sessionId);
  const [labelMode, setLabelMode] = useLabelMode();

  const [selection, setSelection] = useState<Selection>(null);
  /** Extra ids to highlight when the user clicks an answer/sample/evidence pointer directly. */
  const [focusedId, setFocusedId] = useState<string | null>(null);
  /** The draft the shortcuts act on. */
  const [activeId, setActiveId] = useState<string | null>(null);
  const [request, setRequest] = useState<DraftModeRequest | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const focusAfterRender = useRef<string | null>(null);
  const nonce = useRef(0);

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

  const todo = useMemo(() => actionableDrafts(detail?.drafts ?? []), [detail?.drafts]);
  const effectiveActive = todo.some((d) => d.id === activeId) ? activeId : (todo[0]?.id ?? null);

  const selectField = (draftId: string, field: string) => {
    setFocusedId(null);
    setActiveId(draftId);
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
    attribution: async (draft, body: AttributionRequest) => {
      // Which running clocks this answer stops, by kind, before the reload
      // refreshes them (AESER → SAE clock, INTERIM_IRAE = N → AESI clock; API
      // services/drafts.py). No running clock of that kind → nothing is said.
      const effects = attributionClockEffects(
        body,
        detail ? clocksForDraft(clocksOf(detail as unknown as CheckInDetailR3), draft) : [],
      );
      applyDraft(await patchAttribution(draft.id, body));
      toast.push({
        kind: "success",
        title: "Investigator assessment recorded",
        message: effects.length ? effects.join(" ") : undefined,
      });
      reload();
    },
  };

  /** Move the shortcuts (and keyboard focus) to a draft card. */
  const goToDraft = useCallback((id: string | null) => {
    if (!id) return;
    setActiveId(id);
    focusAfterRender.current = id;
  }, []);

  // After a render that changed the active draft, move DOM focus to its card.
  useEffect(() => {
    const id = focusAfterRender.current;
    if (!id) return;
    const el = document.querySelector<HTMLElement>(`[data-draft-id="${id}"]`);
    if (el) {
      focusAfterRender.current = null;
      el.focus({ preventScroll: true });
      el.scrollIntoView?.({ block: "nearest" });
    }
  });

  /** One-click confirm: confirm, then focus the next draft that still needs a person. */
  const confirmAndAdvance = async (draft: Draft) => {
    const next = neighbourDraftId(todo, draft.id, 1);
    await actions.confirm(draft, "");
    goToDraft(next);
  };

  const confirmRemaining = async () => {
    setBulkBusy(true);
    try {
      let n = 0;
      for (const d of todo) {
        applyDraft(await confirmDraft(d.id));
        n += 1;
      }
      toast.push({
        kind: "success",
        title: `${n} draft${n === 1 ? "" : "s"} confirmed`,
        message: "Each confirmation is its own audit event.",
      });
      reload();
    } catch (e) {
      toast.push({
        kind: "error",
        title: "Not all drafts were confirmed",
        message: e instanceof Error ? e.message : String(e),
      });
      reload();
    } finally {
      setBulkBusy(false);
    }
  };

  const ack = async (esc: Escalation) => {
    const updated = await ackEscalation(esc.id);
    setDetail((d) => ({ ...d, escalation: updated }));
    toast.push({ kind: "success", title: "Escalation acknowledged" });
  };

  const [nextBusy, setNextBusy] = useState(false);
  const goNextItem = useCallback(async () => {
    if (!sessionId || nextBusy) return;
    setNextBusy(true);
    try {
      const { rows } = await fetchWholeQueue();
      const next = nextQueueSession(rows, sessionId);
      if (!next) {
        toast.push({
          kind: "info",
          title: "Nothing else needs review",
          message: "The queue is clear.",
        });
      } else {
        navigate(
          next.kind === "session"
            ? `/dashboard/checkins/${encodeURIComponent(next.id)}`
            : `/dashboard/notes/${encodeURIComponent(next.id)}`,
        );
      }
    } catch (e) {
      toast.push({
        kind: "error",
        title: "Could not load the queue",
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setNextBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, nextBusy, navigate]);

  // Single-key shortcuts. Ignored while typing, with modifiers, or with no drafts to act on.
  const keyState = useRef({ todo, effectiveActive, detail, role, ack, goNextItem, goToDraft });
  keyState.current = { todo, effectiveActive, detail, role, ack, goNextItem, goToDraft };
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.defaultPrevented || ev.ctrlKey || ev.metaKey || ev.altKey) return;
      if (isTypingTarget(ev.target)) return;
      const st = keyState.current;
      const draft = st.todo.find((d) => d.id === st.effectiveActive) ?? null;
      const ask = (mode: "edit" | "reject") => {
        if (!draft || st.role === null) return;
        nonce.current += 1;
        setRequest({ draftId: draft.id, mode, nonce: nonce.current });
      };
      switch (ev.key) {
        case "c":
          if (!draft || st.role === null) return;
          ev.preventDefault();
          void confirmAndAdvanceRef.current(draft).catch((e: unknown) =>
            toast.push({
              kind: "error",
              title: "The draft was not confirmed",
              message: e instanceof Error ? e.message : String(e),
            }),
          );
          return;
        case "e":
          ev.preventDefault();
          ask("edit");
          return;
        case "r":
          ev.preventDefault();
          ask("reject");
          return;
        case "a": {
          const esc = st.detail?.escalation;
          if (!esc || esc.acked_at !== null || st.role === null) return;
          ev.preventDefault();
          void st
            .ack(esc)
            .catch(() =>
              toast.push({ kind: "error", title: "The escalation was not acknowledged" }),
            );
          return;
        }
        case "]":
        case "[":
          ev.preventDefault();
          st.goToDraft(neighbourDraftId(st.todo, st.effectiveActive, ev.key === "]" ? 1 : -1));
          return;
        case "j":
          ev.preventDefault();
          void st.goNextItem();
          return;
        default:
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const confirmAndAdvanceRef = useRef(confirmAndAdvance);
  confirmAndAdvanceRef.current = confirmAndAdvance;

  // ---- states --------------------------------------------------------------
  if (loading && !detail) {
    return (
      <div className="space-y-3" aria-busy="true">
        <h1 className="text-page font-semibold text-foreground">Check-in</h1>
        <p className="text-muted-foreground" role="status">
          Loading check-in {sessionId}…
        </p>
      </div>
    );
  }
  if (error && !detail) {
    const notFound = isApiError(error) && error.isNotFound;
    return (
      <div className="space-y-4">
        <h1 className="text-page font-semibold text-foreground">Check-in</h1>
        <ErrorBanner
          error={error}
          message={notFound ? "Check-in not found" : "Could not load this check-in"}
          onRetry={reload}
        />
        <p>
          <Link to="/dashboard" className="text-primary underline">
            Back to the queue
          </Link>
        </p>
      </div>
    );
  }
  if (!detail) return null;

  const sheetOpen = selection?.kind === "field";
  const allDone = todo.length === 0 && (detail.drafts ?? []).some((d) => d.status === "confirmed");

  return (
    <div className="space-y-3" data-testid="checkin-detail">
      <Header
        detail={detail}
        role={role}
        remaining={todo.length}
        bulkBusy={bulkBusy}
        onConfirmRemaining={() => void confirmRemaining()}
        onReload={reload}
        loading={loading}
        labelMode={labelMode}
        onLabelMode={setLabelMode}
        onClockStopped={reload}
      />
      {error !== null && (
        <ErrorBanner
          error={error}
          message="Refresh failed; showing the last loaded version"
          onRetry={reload}
        />
      )}
      {allDone && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 rounded-panel border border-success-border bg-success-bg px-3 py-2 text-table text-success-fg"
          data-testid="all-reviewed"
        >
          <span>Every draft on this check-in has been reviewed.</span>
          <Button
            size="sm"
            variant="primary"
            loading={nextBusy}
            onClick={() => void goNextItem()}
            title="Open the next item that needs review (j)"
          >
            Next item
            <span aria-hidden="true" className="ml-1 opacity-80">
              <Kbd>j</Kbd>
            </span>
          </Button>
        </div>
      )}
      <div className="grid gap-3 lg:grid-cols-[260px_minmax(0,1fr)] xl:grid-cols-[280px_minmax(0,1fr)_340px]">
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
            onConfirm={confirmAndAdvance}
            activeId={effectiveActive}
            onActivate={setActiveId}
            request={request}
            showCodes={labelMode === "codes"}
          />
        </div>
        <div className="min-w-0 lg:col-span-2 xl:col-span-1">
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

      <Sheet
        open={sheetOpen}
        modal={false}
        onOpenChange={(open) => {
          if (!open) setSelection(null);
        }}
      >
        <SheetContent
          size="sm"
          overlayClassName="hidden"
          onInteractOutside={(e) => e.preventDefault()}
        >
          {selection?.kind === "field" && (
            <EvidenceSheetBody
              detail={detail}
              selection={selection}
              onFocusEvidence={focusEvidence}
              labels={(detail as unknown as CheckInDetailR3).labels}
            />
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function EvidenceSheetBody({
  detail,
  selection,
  onFocusEvidence,
  labels,
}: {
  detail: CheckInDetailT;
  selection: Extract<Selection, { kind: "field" }>;
  onFocusEvidence: (e: Evidence) => void;
  labels: CheckInDetailR3["labels"];
}) {
  const plain = fieldLabel(selection.field, labels);
  const evidence = selectionEvidence(selection, detail);
  return (
    <>
      <SheetHeader>
        <SheetTitle>
          Evidence for {plain}{" "}
          <span className="font-mono text-caption font-normal text-muted-foreground">
            ({selection.field})
          </span>
        </SheetTitle>
        <SheetDescription>
          Where this value came from. Pick a source to highlight it in the answers, vitals and
          rules.
        </SheetDescription>
      </SheetHeader>
      <SheetBody>
        <div
          className="rounded-panel border border-border bg-surface p-2"
          data-testid="evidence-panel"
        >
          <EvidenceList
            evidence={evidence}
            detail={detail}
            onFocusEvidence={onFocusEvidence}
            compact
          />
        </div>
      </SheetBody>
    </>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

/** A running or stopped 24-hour clock as one badge: "SAE report due · 22h 25m left". */
function ClockPill({ clock }: { clock: ClockRow }) {
  const running = clock.stopped_at === null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  const kind = clockKind(clock);
  if (!running) {
    return <Badge kind="clock-stopped" size="sm" label={`${clockChip(kind)} clock stopped`} />;
  }
  const remaining = secondsUntil(clock.due_at, now) ?? clock.seconds_remaining;
  const overdue = remaining !== null && remaining < 0;
  return (
    <Badge
      kind={kind === "aesi" ? "aesi" : "sae-clock"}
      size="sm"
      label={kind === "aesi" ? "AESI report due" : "SAE report due"}
      detail={
        overdue ? `overdue ${formatCountdown(remaining)}` : `${formatCountdown(remaining)} left`
      }
      title={`${clockName(kind)} within 24 hours of the site knowing`}
    />
  );
}

function Header({
  detail,
  role,
  remaining,
  bulkBusy,
  onConfirmRemaining,
  onReload,
  loading,
  labelMode,
  onLabelMode,
  onClockStopped,
}: {
  detail: CheckInDetailT;
  role: ReturnType<typeof useAuth>["role"];
  remaining: number;
  bulkBusy: boolean;
  onConfirmRemaining: () => void;
  onReload: () => void;
  loading: boolean;
  labelMode: "plain" | "codes";
  onLabelMode: (m: "plain" | "codes") => void;
  onClockStopped: () => void;
}) {
  const s = detail.session;
  const p = detail.participant;
  const tier = detail.result?.escalation_tier ?? s?.tier ?? null;
  const r3 = detail as unknown as CheckInDetailR3;
  const consentBasis = r3.session?.consent_basis;
  const allClocks = clocksOf(r3);
  const runningClocks = allClocks.filter((c) => c.stopped_at === null);
  // Same derivation as the Vitals card, so header and card never disagree
  // (the summary is null when no sample was usable, but the samples still
  // carry their own is_measured / source).
  const vitals = vitalsProvenance(detail);
  const tierKind = tierBadgeKind(tier);
  const hasAeDraft = (detail.drafts ?? []).some(
    (d) => d.domain === "AE" && d.status !== "rejected" && d.status !== "superseded",
  );
  return (
    <header className="space-y-1">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <nav aria-label="Breadcrumb" className="text-caption text-subtle-foreground">
            <Link to="/dashboard" className="text-primary underline">
              Queue
            </Link>
            <span aria-hidden="true"> / </span>
            check-in <span className="font-mono">{s?.id}</span>
          </nav>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <SegmentedControl
            label="Field labels"
            size="sm"
            value={labelMode}
            onValueChange={onLabelMode}
            options={[
              { value: "plain", label: "Plain" },
              { value: "codes", label: "Codes" },
            ]}
          />
          {s?.usubjid && (
            <Button asChild size="sm" variant="secondary">
              <Link to={briefPath(s.usubjid)}>Visit brief</Link>
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={onReload} loading={loading}>
            Refresh
          </Button>
          {role !== null && remaining > 0 && (
            <Button
              size="sm"
              variant="primary"
              loading={bulkBusy}
              onClick={onConfirmRemaining}
              title="Confirm every draft that is still waiting; each is its own audit event"
            >
              Confirm remaining ({remaining})
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h1 className="flex flex-wrap items-center gap-2 text-page font-semibold text-foreground">
          <Link
            to={`/dashboard/participants/${encodeURIComponent(s?.usubjid ?? "")}`}
            className="hover:underline"
            title={s?.usubjid}
          >
            {p?.display_label ?? s?.usubjid ?? "Participant"}
          </Link>
          {tierKind && (
            <Badge
              kind={tierKind}
              size="md"
              title={tier !== null ? `Alert level: ${tierName(tier)}` : undefined}
            />
          )}
          {s?.is_eval && <Badge kind="neutral" size="sm" label="eval session" />}
          {vitals.hasSamples && <Prov isMeasured={vitals.isMeasured} source={vitals.source} />}
        </h1>
        {allClocks.map((c) => (
          <span key={c.id} className="flex items-center gap-1">
            <ClockPill clock={c} />
            {c.stopped_at === null && (
              <ClockActions
                packetOnly
                compact
                clock={c}
                role={role}
                hasAeDraft={c.has_ae_draft ?? hasAeDraft}
                onStopped={onClockStopped}
              />
            )}
          </span>
        ))}
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-caption text-muted-foreground">
        <span>
          Received <Time iso={s?.completed_at ?? s?.started_at} />
        </span>
        <span>
          Started <Time iso={s?.started_at} />
        </span>
        <span title={tier !== null ? `Alert level: ${tierName(tier)}` : undefined}>
          {consentBasis === "enrollment_icf" || consentBasis
            ? `Consent: enrollment consent form${s?.consent_camera === false ? " · camera off" : ""}`
            : `Camera: ${s?.consent_camera ? "on" : "off"}`}
        </span>
        <span>
          Vitals:{" "}
          {vitalsStatusLabel(
            detail.result?.vitals?.status ?? detail.vitals?.status ?? s?.vitals_status,
          )}
        </span>
        {s?.stop_screen_shown && (
          <span className="font-medium text-danger-fg">Stop screen was shown</span>
        )}
        <span>Participant is synthetic</span>
        {runningClocks.length > 0 && (
          <span className="font-medium text-danger-fg">
            {runningClocks.length === 1
              ? "A 24-hour report clock is running"
              : `${runningClocks.length} 24-hour report clocks are running`}
          </span>
        )}
      </div>
    </header>
  );
}
