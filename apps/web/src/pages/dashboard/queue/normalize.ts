/**
 * Turn a raw GET /queue row (R1 shape or R2.4 shape) into a `QueueRow`, and map
 * the filter state to the exact query the API receives.
 * Pure functions, no I/O; unit-tested in __tests__/normalize.test.ts.
 */
import { tierStyle } from "../../../lib/format";
import type { Domain, Participant, QueueQuery } from "../../../lib/types";
import type { QueueFilterState, QueueRow, QueueSource, RawQueueItem } from "./types";

const DOMAINS: Domain[] = ["AE", "VS", "CM"];

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** `source` wins; otherwise a note_id without a session_id means a chart note. */
export function inferSource(
  raw: Pick<RawQueueItem, "source" | "session_id" | "note_id">,
): QueueSource {
  if (raw.source === "chart_note") return "chart_note";
  if (raw.source === "check_in") return "check_in";
  if (!raw.session_id && raw.note_id) return "chart_note";
  return "check_in";
}

export function detailHref(
  source: QueueSource,
  sessionId: string | null,
  noteId: string | null,
): string {
  if (source === "chart_note" && noteId) return `/dashboard/notes/${encodeURIComponent(noteId)}`;
  if (sessionId) return `/dashboard/checkins/${encodeURIComponent(sessionId)}`;
  // Nothing to open; the table renders a disabled control for an empty href.
  return "";
}

export function normalizeQueueItem(raw: RawQueueItem): QueueRow {
  const sessionId = asString(raw.session_id);
  const noteId = asString(raw.note_id);
  const source = inferSource({ source: raw.source, session_id: sessionId, note_id: noteId });
  const tier = asNumber(raw.tier) ?? 0;
  const counts = {} as Record<Domain, number>;
  for (const d of DOMAINS) counts[d] = asNumber(raw.draft_counts?.[d]) ?? 0;

  const stoppedAt = asString(raw.sae_stopped_at) ?? asString(raw.sae_clock?.stopped_at) ?? null;
  const dueAt = asString(raw.sae_due_at) ?? asString(raw.sae_clock?.due_at) ?? null;
  const stopped = Boolean(stoppedAt) || raw.sae_clock_stopped === true;
  const hasClock = Boolean(raw.has_sae_clock) || Boolean(dueAt) || stopped;

  return {
    key: sessionId ?? noteId ?? `${raw.usubjid}:${raw.completed_at ?? ""}`,
    source,
    session_id: sessionId,
    note_id: noteId,
    usubjid: raw.usubjid ?? "",
    display_label: raw.display_label || raw.usubjid || "—",
    completed_at: asString(raw.completed_at),
    tier,
    tier_name: raw.tier_name || tierStyle(tier).name,
    max_grade: asNumber(raw.max_grade),
    vitals_status: asString(raw.vitals_status),
    is_measured: Boolean(raw.is_measured),
    has_sae_clock: hasClock,
    sae_due_at: dueAt,
    sae_stopped: stopped,
    sae_stopped_at: stoppedAt,
    escalation_acked: typeof raw.escalation_acked === "boolean" ? raw.escalation_acked : null,
    draft_counts: counts,
    draft_status_summary:
      typeof raw.draft_status_summary === "string" ? raw.draft_status_summary : "",
    href: detailHref(source, sessionId, noteId),
  };
}

/**
 * Resolve the participant filter text to the `usubjid` query param. A typed
 * display label (P-007) is mapped through the loaded participants list; a full
 * USUBJID or anything unmatched is sent as typed (the API may resolve labels
 * itself, CONTRACTS R2.3).
 */
export function resolveParticipantFilter(
  typed: string,
  participants: readonly Participant[],
): string | undefined {
  const t = typed.trim();
  if (!t) return undefined;
  const lower = t.toLowerCase();
  const hit = participants.find(
    (p) => p.display_label.toLowerCase() === lower || p.usubjid.toLowerCase() === lower,
  );
  return hit ? hit.usubjid : t;
}

/** Filter state → the exact `GET /queue` query (undefined fields are omitted). */
export function buildQueueQuery(
  f: QueueFilterState,
  participants: readonly Participant[],
  limit: number,
): QueueQuery {
  return {
    usubjid: resolveParticipantFilter(f.participant, participants),
    min_tier: f.minTier > 0 ? f.minTier : undefined,
    status: f.status,
    include_eval: f.includeEval,
    limit,
    offset: f.offset,
  };
}

/** True when every filter is at its default (the "Clear filters" button is disabled). */
export function isDefaultFilters(f: QueueFilterState): boolean {
  return !f.participant && f.minTier === 0 && f.status === "open" && !f.includeEval;
}

/**
 * True when a filter that NARROWS the result is set. `includeEval` only widens
 * and `status=open` is the default view, so neither counts: an empty result
 * under a narrowing filter is explained by the filter, not by an empty queue.
 */
export function hasNarrowingFilter(f: QueueFilterState): boolean {
  return f.participant.trim().length > 0 || f.minTier > 0;
}

/** Vitals statuses with no sample behind them: a MEASURED/SIMULATED badge would label nothing. */
const NO_SAMPLE_STATUSES = new Set(["unavailable", "declined", "pending"]);

export function hasVitalsSamples(row: Pick<QueueRow, "source" | "vitals_status">): boolean {
  if (row.source === "chart_note") return false;
  if (!row.vitals_status) return false;
  return !NO_SAMPLE_STATUSES.has(row.vitals_status);
}
