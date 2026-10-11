/**
 * Turn a raw GET /queue row (R1 shape or R2.4 shape) into a `QueueRow`, and map
 * the filter state to the exact query the API receives.
 * Pure functions, no I/O; unit-tested in __tests__/normalize.test.ts.
 */
import { tierStyle } from "../../../lib/format";
import type { Domain, Participant, QueueItem, QueueQuery, QueueSource } from "../../../lib/types";
import type { QueueClockKind, QueueClock, QueueFilterState, QueueRow } from "./types";

const DOMAINS: Domain[] = ["AE", "VS", "CM"];

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * `source` wins; otherwise a note_id without a session_id means a chart note.
 * A note whose `note_type` is "phone_call" (R4.1) is a logged call.
 */
export function inferSource(
  raw: Pick<QueueItem, "source" | "session_id" | "note_id"> & {
    note_type?: string | null;
  },
): QueueSource {
  if (raw.source === "phone_call") return "phone_call";
  let source: QueueSource;
  if (raw.source === "chart_note") source = "chart_note";
  else if (raw.source === "check_in") source = "check_in";
  else if (!raw.session_id && raw.note_id) source = "chart_note";
  else source = "check_in";
  if (source === "chart_note" && raw.note_type === "phone_call") return "phone_call";
  return source;
}

/** True for sources that are notes on the server (chart notes and logged calls). */
export function isNoteSource(source: QueueSource): boolean {
  return source === "chart_note" || source === "phone_call";
}

/**
 * "sae" or "aesi" only when the API says so. An absent or unrecognised kind is
 * "unknown": calling a special-interest clock a serious event (or the reverse)
 * would be a false regulatory label, so the chip stays neutral instead.
 */
export function clockKind(v: unknown): QueueClockKind {
  if (typeof v !== "string") return "unknown";
  const k = v.trim().toLowerCase();
  return k === "aesi" ? "aesi" : k === "sae" ? "sae" : "unknown";
}

/**
 * Every report clock on a row. `clocks[]` (R3.2) wins; otherwise the legacy
 * single-clock fields become one clock whose kind comes from `clock_kind`,
 * `sae_kind` or `sae_clock.kind` ("unknown" when none is sent).
 */
export function normalizeClocks(raw: QueueItem, rowKey: string): QueueClock[] {
  if (Array.isArray(raw.clocks) && raw.clocks.length > 0) {
    return raw.clocks.map((c, i) => {
      const stoppedAt = asString(c?.stopped_at);
      const id = asString(c?.id);
      return {
        key: id ?? `${rowKey}:clock${i}`,
        clock_id: id,
        kind: clockKind(c?.kind),
        due_at: asString(c?.due_at),
        stopped: Boolean(stoppedAt),
        stopped_at: stoppedAt,
        packet_id: asString(c?.packet_id),
      };
    });
  }
  const stoppedAt = asString(raw.sae_stopped_at) ?? asString(raw.sae_clock?.stopped_at) ?? null;
  const dueAt = asString(raw.sae_due_at) ?? asString(raw.sae_clock?.due_at) ?? null;
  const stopped = Boolean(stoppedAt) || raw.sae_clock_stopped === true || raw.sae_stopped === true;
  if (!(Boolean(raw.has_sae_clock) || Boolean(dueAt) || stopped)) return [];
  return [
    {
      key: `${rowKey}:clock`,
      clock_id: null,
      kind: clockKind(raw.clock_kind ?? raw.sae_kind ?? raw.sae_clock?.kind),
      due_at: dueAt,
      stopped,
      stopped_at: stoppedAt,
      packet_id: null,
    },
  ];
}

/**
 * Whether the item still needs a person. The API's `is_open` wins; otherwise a
 * pending draft or an unacknowledged escalation means yes.
 */
export function needsAction(raw: QueueItem): boolean {
  if (typeof raw.is_open === "boolean") return raw.is_open;
  if (raw.escalation_acked === false) return true;
  const summary = typeof raw.draft_status_summary === "string" ? raw.draft_status_summary : "";
  return /\bdraft\b/.test(summary);
}

export function detailHref(
  source: QueueSource,
  sessionId: string | null,
  noteId: string | null,
): string {
  if (isNoteSource(source) && noteId) return `/dashboard/notes/${encodeURIComponent(noteId)}`;
  if (sessionId) return `/dashboard/checkins/${encodeURIComponent(sessionId)}`;
  // Nothing to open; the table renders a disabled control for an empty href.
  return "";
}

/**
 * Where a click on a report-clock chip goes: the packet when one exists, else
 * the create-or-open packet route for the clock (PacketPage handles
 * `/dashboard/packets/new?clock=` with POST /packets {clock_id}), else nowhere.
 */
export function packetHref(
  packetId: string | null | undefined,
  clockId: string | null | undefined,
): string | null {
  if (packetId) return `/dashboard/packets/${encodeURIComponent(packetId)}`;
  if (clockId) return `/dashboard/packets/new?clock=${encodeURIComponent(clockId)}`;
  return null;
}

export function normalizeQueueItem(raw: QueueItem): QueueRow {
  const sessionId = asString(raw.session_id);
  const noteId = asString(raw.note_id);
  const source = inferSource({
    source: raw.source,
    session_id: sessionId,
    note_id: noteId,
    note_type: asString(raw.note_type),
  });
  const tier = asNumber(raw.tier) ?? 0;
  const counts = {} as Record<Domain, number>;
  for (const d of DOMAINS) counts[d] = asNumber(raw.draft_counts?.[d]) ?? 0;

  const key = sessionId ?? noteId ?? `${raw.usubjid}:${raw.completed_at ?? ""}`;
  const clocks = normalizeClocks(raw, key);
  // The legacy single-clock fields mirror the first clock so older callers keep working.
  const first = clocks[0] ?? null;

  return {
    key,
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
    has_sae_clock: clocks.length > 0,
    sae_due_at: first?.due_at ?? null,
    sae_stopped: first?.stopped ?? false,
    sae_stopped_at: first?.stopped_at ?? null,
    clocks,
    needs_action: needsAction(raw),
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
  if (isNoteSource(row.source)) return false;
  if (!row.vitals_status) return false;
  return !NO_SAMPLE_STATUSES.has(row.vitals_status);
}
