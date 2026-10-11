/**
 * Defensive readers for the chart-note API payloads.
 *
 * The contract (R2.4) fixes the field names, but the scanner was ported from a
 * teammate's repository whose dataclasses used older names (`grade`,
 * `onset_days_ago`, `action`, `mentioned_as`, `excluded`, `reasoning`). The
 * page is built against the contract and *also* accepts those aliases, so a
 * half-migrated API still renders instead of crashing the demo. Nothing here
 * invents data: an absent value becomes `null`, `false`, `""` or `[]`.
 */
import type { ReaderInfo, ReaderRejected, ScanWithReader } from "./readerTypes";
import type {
  ChartNote,
  ChartNoteListItem,
  Draft,
  ExcludedReason,
  MedChange,
  MedFinding,
  NoteDetailResponse,
  NoteDraft,
  NoteEscalation,
  NoteSAEClock,
  NotesPage,
  NotesQuery,
  ProtocolAssessment,
  RedFlag,
  RuleFired,
  RuleFiredPlain,
  SymptomFinding,
} from "../../../lib/types";

type Rec = Record<string, unknown>;

function isRec(x: unknown): x is Rec {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function str(x: unknown, fallback = ""): string {
  return typeof x === "string" ? x : fallback;
}

function num(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

function int(x: unknown, fallback: number): number {
  const n = num(x);
  return n === null ? fallback : Math.trunc(n);
}

function bool(x: unknown): boolean {
  return x === true;
}

function arr(x: unknown): unknown[] {
  return Array.isArray(x) ? x : [];
}

/** First defined value among alias keys. */
function pick(r: Rec, ...keys: string[]): unknown {
  for (const k of keys) if (r[k] !== undefined) return r[k];
  return undefined;
}

const EXCLUDED_REASONS: ExcludedReason[] = [
  "negated",
  "historical",
  "hypothetical",
  "resolved",
  "allergy",
  "indication",
];

function excludedReason(x: unknown): ExcludedReason | null {
  return typeof x === "string" && (EXCLUDED_REASONS as string[]).includes(x)
    ? (x as ExcludedReason)
    : null;
}

const MED_CHANGES: MedChange[] = ["started", "stopped", "changed", "taking"];

function medChange(x: unknown): MedChange {
  return typeof x === "string" && (MED_CHANGES as string[]).includes(x)
    ? (x as MedChange)
    : "taking";
}

/** R5.3: keep `found_by` when present (absent on older servers). */
function foundByProp(r: Rec): { found_by?: "scanner" | "gemini" | "both" } {
  const v = r.found_by;
  return v === "scanner" || v === "gemini" || v === "both" ? { found_by: v } : {};
}

function normalizeReader(x: unknown): ReaderInfo | null {
  if (!isRec(x)) return null;
  return {
    status: str(x.status, "off"),
    model: typeof x.model === "string" ? x.model : null,
    cached: x.cached === true,
    reason: typeof x.reason === "string" ? x.reason : null,
  };
}

function normalizeRejected(x: unknown): ReaderRejected[] {
  return arr(x)
    .filter(isRec)
    .map((e) => ({ quote: str(e.quote), reason: str(e.reason) }));
}

export function normalizeSymptom(raw: unknown): SymptomFinding {
  const r = isRec(raw) ? raw : {};
  const quote = str(pick(r, "quote", "mentioned_as"));
  const start = int(r.span_start, 0);
  return {
    term: str(r.term, "(unknown term)"),
    quote,
    span_start: start,
    span_end: int(r.span_end, start + quote.length),
    reason: str(pick(r, "reason", "reasoning")),
    grade_hint: num(pick(r, "grade_hint", "grade")),
    grade_basis: str(r.grade_basis),
    onset_days: num(pick(r, "onset_days", "onset_days_ago")),
    worsening: bool(r.worsening),
    excluded_reason: excludedReason(pick(r, "excluded_reason", "excluded")),
    ...foundByProp(r),
  };
}

export function normalizeMed(raw: unknown): MedFinding {
  const r = isRec(raw) ? raw : {};
  const quote = str(pick(r, "quote", "mentioned_as"));
  const start = int(r.span_start, 0);
  return {
    drug: str(r.drug, "(unknown drug)"),
    change: medChange(pick(r, "change", "action")),
    quote,
    span_start: start,
    span_end: int(r.span_end, start + quote.length),
    reason: str(pick(r, "reason", "reasoning")),
    excluded_reason: excludedReason(pick(r, "excluded_reason", "excluded")),
    ...foundByProp(r),
  };
}

export function normalizeRedFlag(raw: unknown): RedFlag {
  const r = isRec(raw) ? raw : {};
  const quote = str(r.quote);
  const start = int(r.span_start, 0);
  return {
    level: r.level === "emergency" ? "emergency" : "urgent",
    category: str(r.category, "red_flag"),
    quote,
    span_start: start,
    span_end: int(r.span_end, start + quote.length),
    reason: str(r.reason),
  };
}

export function normalizeScan(raw: unknown): ScanWithReader {
  const r = isRec(raw) ? raw : {};
  // A note detail may nest the scan; a dry-run returns it bare.
  const s = isRec(r.scan) && !("symptoms" in r) ? r.scan : r;
  const readerRaw = r.reader !== undefined ? r.reader : s.reader;
  const rejectedRaw = r.reader_rejected !== undefined ? r.reader_rejected : s.reader_rejected;
  return {
    ...(readerRaw !== undefined ? { reader: normalizeReader(readerRaw) } : {}),
    ...(rejectedRaw !== undefined ? { reader_rejected: normalizeRejected(rejectedRaw) } : {}),
    symptoms: arr(s.symptoms).map(normalizeSymptom),
    excluded_symptoms: arr(s.excluded_symptoms).map(normalizeSymptom),
    meds: arr(s.meds).map(normalizeMed),
    excluded_meds: arr(s.excluded_meds).map(normalizeMed),
    red_flags: arr(s.red_flags).map(normalizeRedFlag),
  };
}

/** "R2810-ONC-1624-P-007" → "P-007"; anything without the pattern is returned as is. */
export function labelFromUsubjid(usubjid: string): string {
  const m = /(P-\d{3})$/i.exec(usubjid);
  return m ? m[1].toUpperCase() : usubjid;
}

export function normalizeNote(raw: unknown): ChartNote {
  const r = isRec(raw) ? raw : {};
  const usubjid = str(r.usubjid);
  return {
    id: str(pick(r, "id", "note_id")),
    usubjid,
    display_label: str(r.display_label, labelFromUsubjid(usubjid)),
    note_date: str(r.note_date),
    author: str(r.author),
    note_type: str(r.note_type),
    text: str(r.text),
    ingested_at: str(r.ingested_at),
    ingested_by: str(r.ingested_by),
    tier: num(r.tier),
    caller: typeof r.caller === "string" ? r.caller : null,
    call_direction: typeof r.call_direction === "string" ? r.call_direction : null,
  };
}

export function normalizeDraft(raw: unknown): NoteDraft {
  const r = isRec(raw) ? raw : {};
  const evidence: NoteDraft["evidence"] = {};
  if (isRec(r.evidence)) {
    for (const [field, list] of Object.entries(r.evidence)) {
      evidence[field] = arr(list)
        .filter(isRec)
        .map((e) => ({
          kind: str(e.kind, "chart_note") as NoteDraft["evidence"][string][number]["kind"],
          id: str(e.id),
          ts: typeof e.ts === "string" ? e.ts : null,
          note: str(e.note),
          ...(num(e.span_start) !== null ? { span_start: num(e.span_start) as number } : {}),
          ...(num(e.span_end) !== null ? { span_end: num(e.span_end) as number } : {}),
        }));
    }
  }
  const domain = r.domain === "AE" || r.domain === "VS" || r.domain === "CM" ? r.domain : "AE";
  const statusRaw = r.status;
  const status: Draft["status"] =
    statusRaw === "confirmed" ||
    statusRaw === "rejected" ||
    statusRaw === "superseded" ||
    statusRaw === "draft"
      ? statusRaw
      : "draft";
  return {
    id: str(r.id),
    session_id: str(r.session_id),
    usubjid: str(r.usubjid),
    domain,
    version: int(r.version, 1),
    status,
    fields: isRec(r.fields) ? r.fields : {},
    evidence,
    linked_ae_open_id: typeof r.linked_ae_open_id === "string" ? r.linked_ae_open_id : null,
    is_followup: bool(r.is_followup),
    created_by: str(r.created_by),
    created_at: str(r.created_at),
    supersedes_id: typeof r.supersedes_id === "string" ? r.supersedes_id : null,
    note: typeof r.note === "string" ? r.note : null,
    note_id: typeof r.note_id === "string" ? r.note_id : null,
    source:
      r.source === "check_in"
        ? "check_in"
        : r.source === "phone_call"
          ? "phone_call"
          : "chart_note",
  };
}

function normalizeRule(raw: unknown): RuleFiredPlain {
  const r = isRec(raw) ? raw : {};
  return {
    // R3.1: the API may attach the plain sentence; kept so the Why panel leads with it.
    ...(typeof r.plain === "string" ? { plain: r.plain } : {}),
    rule_id: str(r.rule_id, "rule"),
    category: str(r.category, "drafting") as RuleFired["category"],
    description: str(r.description),
    inputs: isRec(r.inputs) ? r.inputs : {},
    effect: str(r.effect),
    evidence: arr(r.evidence)
      .filter(isRec)
      .map((e) => ({
        kind: str(e.kind, "rule") as RuleFired["evidence"][number]["kind"],
        id: str(e.id),
        ts: typeof e.ts === "string" ? e.ts : null,
        note: str(e.note),
      })),
  };
}

function strOrNull(x: unknown): string | null {
  return typeof x === "string" ? x : null;
}

/**
 * Escalation row attached to a note (shared dashboard shape, CONTRACTS §2.2).
 * Read field by field so a partial row (no `reasons`, `reasons: null`, …)
 * renders instead of crashing the outcome panel. `tier` defaults to 2: R2.4
 * says a note escalation is always tier 2 (notes never page / tier 3).
 */
export function normalizeEscalation(raw: unknown): NoteEscalation | null {
  if (!isRec(raw)) return null;
  return {
    id: str(raw.id),
    session_id: str(raw.session_id),
    usubjid: str(raw.usubjid),
    tier: int(raw.tier, 2),
    reasons: arr(raw.reasons).filter((x): x is string => typeof x === "string"),
    paged_at: strOrNull(raw.paged_at),
    acked_by: strOrNull(raw.acked_by),
    acked_at: strOrNull(raw.acked_at),
    seconds_to_ack: num(raw.seconds_to_ack),
    note_id: strOrNull(raw.note_id),
    source: raw.source === "check_in" ? "check_in" : "chart_note",
  };
}

/** SAE clock row attached to a note; same defensive treatment as the escalation. */
export function normalizeSaeClock(raw: unknown): NoteSAEClock | null {
  if (!isRec(raw)) return null;
  const informational: Record<string, string> = {};
  if (isRec(raw.informational)) {
    for (const [k, v] of Object.entries(raw.informational)) {
      if (typeof v === "string") informational[k] = v;
    }
  }
  return {
    id: str(raw.id),
    session_id: str(raw.session_id),
    usubjid: str(raw.usubjid),
    site_awareness_at: str(raw.site_awareness_at),
    due_at: str(raw.due_at),
    stopped_at: strOrNull(raw.stopped_at),
    stopped_by: strOrNull(raw.stopped_by),
    decision: strOrNull(raw.decision),
    seconds_remaining: num(raw.seconds_remaining),
    informational,
    note_id: strOrNull(raw.note_id),
    kind: strOrNull(raw.kind),
    packet_id: strOrNull(raw.packet_id),
    ...(Array.isArray(raw.ae_draft_ids)
      ? { ae_draft_ids: raw.ae_draft_ids.filter((x): x is string => typeof x === "string") }
      : {}),
    ...(typeof raw.has_ae_draft === "boolean" ? { has_ae_draft: raw.has_ae_draft } : {}),
  };
}

/**
 * `POST /notes` and `GET /notes/{id}` both return `{note, scan, drafts, …}`.
 * If an API ever returns the note's own fields at the top level, that is
 * accepted too (the note is then the whole object).
 */
export function normalizeNoteDetail(raw: unknown): NoteDetailResponse {
  const r = isRec(raw) ? raw : {};
  const noteSrc = isRec(r.note) ? r.note : r;
  const rules = arr(r.rules_fired).map(normalizeRule);
  const whyRaw = arr(r.why).filter((w): w is string => typeof w === "string");
  return {
    note: normalizeNote(noteSrc),
    scan: normalizeScan(r.scan ?? r),
    drafts: arr(r.drafts).map(normalizeDraft),
    escalation: normalizeEscalation(r.escalation),
    sae_clock: normalizeSaeClock(r.sae_clock),
    rules_fired: rules,
    // When the API omits `why`, fall back to the rules' own descriptions so the
    // panel is never empty while rules exist.
    why: whyRaw.length ? whyRaw : rules.map((x) => x.description).filter(Boolean),
    labels: isRec(r.labels)
      ? (Object.fromEntries(
          Object.entries(r.labels).filter(([, v]) => typeof v === "string"),
        ) as Record<string, string>)
      : null,
    protocol: isRec(r.protocol) ? (r.protocol as ProtocolAssessment) : null,
  };
}

export function normalizeNoteListItem(raw: unknown): ChartNoteListItem {
  const r = isRec(raw) ? raw : {};
  const note = normalizeNote(r);
  const scan = r.scan !== undefined && r.scan !== null ? normalizeScan(r.scan) : null;
  const counts = isRec(r.draft_counts) ? r.draft_counts : null;
  const draftCounts = counts
    ? {
        AE: int(counts.AE, 0),
        VS: int(counts.VS, 0),
        CM: int(counts.CM, 0),
      }
    : undefined;
  const nDrafts =
    num(r.n_drafts) ??
    (draftCounts ? draftCounts.AE + draftCounts.VS + draftCounts.CM : null) ??
    (Array.isArray(r.drafts) ? r.drafts.length : null);
  return {
    ...note,
    scan,
    n_symptoms: num(r.n_symptoms) ?? scan?.symptoms.length ?? undefined,
    n_meds: num(r.n_meds) ?? scan?.meds.length ?? undefined,
    n_red_flags: num(r.n_red_flags) ?? scan?.red_flags.length ?? undefined,
    n_drafts: nDrafts ?? undefined,
    draft_counts: draftCounts,
  };
}

export function normalizeNotesPage(raw: unknown, q: NotesQuery): NotesPage {
  // Accept a bare array as well as the contract's {items,total,limit,offset}.
  if (Array.isArray(raw)) {
    const items = raw.map(normalizeNoteListItem);
    return { items, total: items.length, limit: q.limit ?? Math.max(1, items.length), offset: 0 };
  }
  const r = isRec(raw) ? raw : {};
  const items = arr(r.items).map(normalizeNoteListItem);
  return {
    items,
    total: int(r.total, items.length),
    limit: int(r.limit, q.limit ?? 25),
    offset: int(r.offset, q.offset ?? 0),
  };
}
