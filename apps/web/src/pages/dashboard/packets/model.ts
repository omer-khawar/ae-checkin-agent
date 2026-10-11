/**
 * Pure helpers for the packet page: response normalisation, plain-language
 * labels, value formatting, evidence lookup and the deadline. No React, no
 * fetch, so every function is unit-tested in `__tests__/model.test.ts`.
 *
 * Nothing here decides anything clinical. Kind, status, deadline and missing
 * information all come from the API (the rules engine); this module only
 * decides how to say them in plain words.
 */
import type {
  NarrativeSentence,
  Packet,
  PacketChange,
  PacketClock,
  PacketDeadline,
  PacketEvidence,
  PacketField,
  PacketKind,
  PacketValue,
  WrittenText,
} from "./types";

// ---------------------------------------------------------------------------
// Plain-language labels
// ---------------------------------------------------------------------------

/** Plain name first (CLAUDE.md §00: speak to non-clinicians first). */
export const KIND_LABELS: Record<PacketKind, string> = {
  sae: "Serious event report",
  aesi: "Special-interest event report",
};

/** The regulatory abbreviation, kept one level deeper as a small badge. */
export const KIND_CODES: Record<PacketKind, string> = {
  sae: "SAE",
  aesi: "AESI",
};

export function kindLabel(kind: PacketKind): string {
  return KIND_LABELS[kind];
}

/** "Initial report" for sequence 0, "Follow-up n" otherwise. */
export function sequenceLabel(sequence: number): string {
  return sequence <= 0 ? "Initial report" : `Follow-up ${sequence}`;
}

/**
 * The one plain sentence at the top of the page saying why it exists.
 * Protocol R2810-ONC-1624 Amd 9 §9.4.2 (p. 91) for SAEs, §9.4.3 (p. 92) for AESIs.
 */
export function explainer(kind: PacketKind): string {
  const what =
    kind === "sae"
      ? "serious side effects"
      : "possible side effects of special interest (investigator to confirm)";
  return (
    `The study protocol requires ${what} to be reported to the sponsor within 24 hours; ` +
    "Interim pre-filled this draft from the evidence, and you are reviewing it before the investigator signs."
  );
}

export function writerLabel(writer: WrittenText["writer"]): string {
  return writer === "llm" ? "Written by Claude" : "Written by template";
}

const EVIDENCE_KIND_LABELS: Record<string, string> = {
  pro_response: "Check-in answer",
  gate_answer: "Check-in question",
  vitals_sample: "Vitals reading",
  rule: "Rule",
  table: "Reference table",
  chart_note: "Chart note",
  phone_call: "Phone call",
  draft: "Record draft",
  packet: "Earlier report",
  clock: "24-hour clock",
  user_edit: "Edited by a person",
};

/** Plain label for an evidence kind; unknown kinds fall back to the raw kind. */
export function evidenceKindLabel(kind: string): string {
  return EVIDENCE_KIND_LABELS[kind] ?? kind.replace(/_/g, " ");
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** Display text for a field value. `null`/empty means not known yet. */
export function formatValue(value: PacketValue | undefined): string {
  if (value === null || value === undefined) return "Not known yet";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "None";
  const s = String(value);
  return s.trim() === "" ? "Not known yet" : s;
}

export function isEmptyValue(value: PacketValue | undefined): boolean {
  return (
    value === null ||
    value === undefined ||
    (typeof value === "string" && value.trim() === "") ||
    (Array.isArray(value) && value.length === 0)
  );
}

/** Text a person edits in the inline editor. */
export function valueToEditText(value: PacketValue): string {
  if (value === null) return "";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

/**
 * Turn editor text back into a value of the same type as the original:
 * empty → null; numbers stay numbers when the text parses; Yes/No for
 * booleans; comma lists for arrays; strings otherwise.
 */
export function parseEditText(text: string, original: PacketValue): PacketValue {
  const t = text.trim();
  if (t === "") return null;
  if (typeof original === "number") {
    const n = Number(t);
    return Number.isFinite(n) ? n : t;
  }
  if (typeof original === "boolean") {
    if (/^(y|yes|true)$/i.test(t)) return true;
    if (/^(n|no|false)$/i.test(t)) return false;
    return t;
  }
  if (Array.isArray(original)) {
    return t
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return t;
}

export function valuesEqual(a: PacketValue, b: PacketValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// Evidence lookup
// ---------------------------------------------------------------------------

/**
 * Every evidence pointer the packet carries, by id: field evidence, the
 * optional `evidence_index`, and the follow-up change list. Narrative sentences
 * cite ids only, so their chips resolve through this map.
 */
export function evidenceIndex(packet: Packet): Map<string, PacketEvidence> {
  const out = new Map<string, PacketEvidence>();
  const add = (e: PacketEvidence) => {
    if (e.id && !out.has(e.id)) out.set(e.id, e);
  };
  for (const f of packet.fields) f.evidence.forEach(add);
  for (const c of packet.changes_since_previous) c.evidence.forEach(add);
  const idx = packet.evidence_index;
  if (Array.isArray(idx)) idx.forEach(add);
  else if (idx) {
    for (const [id, e] of Object.entries(idx)) add({ ...e, id: e.id || id });
  }
  return out;
}

/** The verbatim words behind an evidence pointer, if any. */
export function evidenceQuote(e: PacketEvidence): string | null {
  if (e.quote && e.quote.trim()) return e.quote;
  if (e.kind === "chart_note" || e.kind === "phone_call") return e.note || null;
  return null;
}

/** Dashboard link to where the evidence lives, when the pointer says so. */
export function evidenceLink(e: PacketEvidence): string | null {
  if (e.note_id) return `/dashboard/notes/${encodeURIComponent(e.note_id)}`;
  if (e.kind === "chart_note" || e.kind === "phone_call") {
    return `/dashboard/notes/${encodeURIComponent(e.id)}`;
  }
  if (e.session_id) return `/dashboard/checkins/${encodeURIComponent(e.session_id)}`;
  return null;
}

/**
 * MEASURED / SIMULATED status of a field's value (screenshots/README rule 2:
 * the word appears next to every vitals value, always).
 *
 * - `true` / `false`: the field says so, or every vitals pointer behind it
 *   agrees on the same answer.
 * - `"not_stated"`: the value rests on vitals evidence but nothing says which;
 *   the page then shows "MEASURED / SIMULATED: not stated" instead of no word.
 * - `null`: not a vitals value (no vitals evidence and no flag).
 */
export function fieldMeasured(field: PacketField): boolean | "not_stated" | null {
  if (typeof field.is_measured === "boolean") return field.is_measured;
  const vitals = field.evidence.filter((e) => e.kind === "vitals_sample");
  if (vitals.length === 0) return null;
  const flags = new Set(vitals.map((e) => e.is_measured));
  if (flags.size === 1) {
    const only = [...flags][0];
    if (typeof only === "boolean") return only;
  }
  return "not_stated";
}

// ---------------------------------------------------------------------------
// Narrative
// ---------------------------------------------------------------------------

export interface NarrativeView {
  /** The text a reader should see now. */
  text: string;
  /** True when a person changed the generated draft. */
  editedByPerson: boolean;
  editedBy: string | null;
  editedAt: string | null;
  sentences: NarrativeSentence[];
}

export function joinSentences(sentences: NarrativeSentence[]): string {
  return sentences
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join(" ");
}

/**
 * What the narrative card shows. A person's edit wins over the generated
 * sentences; the generated sentences (with their evidence) stay visible one
 * click deeper so the reviewer can still check every claim.
 */
export function narrativeView(packet: Packet): NarrativeView {
  const n = packet.narrative;
  const generated = joinSentences(n.sentences);
  const edited = packet.narrative_edited;
  if (edited && edited.text.trim()) {
    return {
      text: edited.text,
      editedByPerson: edited.text.trim() !== generated,
      editedBy: edited.edited_by,
      editedAt: edited.edited_at,
      sentences: n.sentences,
    };
  }
  const text = n.text.trim() ? n.text : generated;
  return {
    text,
    // Covers an API that stores the person's text directly in narrative.text.
    editedByPerson: n.sentences.length > 0 && text.trim() !== generated,
    editedBy: null,
    editedAt: null,
    sentences: n.sentences,
  };
}

// ---------------------------------------------------------------------------
// Deadline
// ---------------------------------------------------------------------------

/** Deadline from the packet when present, otherwise from its clock row. */
export function resolveDeadline(packet: Packet, clocks: PacketClock[] | null): PacketDeadline {
  const clock = clocks?.find((c) => c.id === packet.clock_id) ?? null;
  return {
    siteAwarenessAt: packet.site_awareness_at ?? clock?.site_awareness_at ?? null,
    dueAt: packet.due_at ?? clock?.due_at ?? null,
    stoppedAt: packet.clock_stopped_at ?? clock?.stopped_at ?? null,
    decision: clock?.decision ?? null,
  };
}

/** Whole seconds from `nowMs` until `iso` (negative when past), or null. */
export function secondsUntil(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.round((t - nowMs) / 1000);
}

// ---------------------------------------------------------------------------
// Normalisation (defensive: the API is built in parallel)
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;

function isObj(x: unknown): x is Obj {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function str(x: unknown): string | null {
  return typeof x === "string" ? x : null;
}

function toValue(x: unknown): PacketValue {
  if (x === null || x === undefined) return null;
  if (typeof x === "string" || typeof x === "number" || typeof x === "boolean") return x;
  if (Array.isArray(x)) {
    return x.filter((v): v is string | number => typeof v === "string" || typeof v === "number");
  }
  return JSON.stringify(x);
}

export function normalizeEvidence(raw: unknown): PacketEvidence {
  const e = isObj(raw) ? raw : {};
  const measured = e.is_measured ?? e.isMeasured;
  return {
    kind: str(e.kind) ?? "unknown",
    id: str(e.id) ?? (typeof e.id === "number" ? String(e.id) : ""),
    ts: str(e.ts) ?? str(e.ts_utc),
    note: str(e.note) ?? "",
    quote: str(e.quote),
    span_start: typeof e.span_start === "number" ? e.span_start : null,
    span_end: typeof e.span_end === "number" ? e.span_end : null,
    is_measured: typeof measured === "boolean" ? measured : null,
    session_id: str(e.session_id),
    note_id: str(e.note_id),
  };
}

function evidenceList(raw: unknown): PacketEvidence[] {
  return Array.isArray(raw) ? raw.map(normalizeEvidence).filter((e) => e.id || e.note) : [];
}

function normalizeField(raw: unknown): PacketField | null {
  if (!isObj(raw)) return null;
  const name = str(raw.name);
  if (!name) return null;
  const measured = raw.is_measured;
  return {
    name,
    plain_label: str(raw.plain_label) ?? str(raw.label) ?? name,
    value: toValue(raw.value),
    evidence: evidenceList(raw.evidence),
    edited: raw.edited === true,
    is_measured: typeof measured === "boolean" ? measured : null,
  };
}

function normalizeSentence(raw: unknown): NarrativeSentence | null {
  if (typeof raw === "string") return { text: raw, evidence_ids: [] };
  if (!isObj(raw)) return null;
  const text = str(raw.text);
  if (text === null) return null;
  const ids = Array.isArray(raw.evidence_ids)
    ? raw.evidence_ids.map((x) => String(x)).filter(Boolean)
    : [];
  return {
    text,
    evidence_ids: ids,
    section: str(raw.section) ?? undefined,
    template_id: str(raw.template_id) ?? undefined,
  };
}

export function normalizeWritten(raw: unknown): WrittenText {
  const n = isObj(raw) ? raw : {};
  const sentences = Array.isArray(n.sentences)
    ? n.sentences.map(normalizeSentence).filter((s): s is NarrativeSentence => s !== null)
    : [];
  return {
    kind: str(n.kind) ?? "sae_narrative",
    writer: n.writer === "llm" ? "llm" : "template",
    sentences,
    text: str(n.text) ?? joinSentences(sentences),
    fallback_reason: str(n.fallback_reason),
  };
}

function normalizeChange(raw: unknown): PacketChange | null {
  if (!isObj(raw)) return null;
  const field = str(raw.field) ?? str(raw.name);
  if (!field) return null;
  return {
    field,
    plain_label: str(raw.plain_label) ?? undefined,
    before: toValue(raw.before),
    after: toValue(raw.after),
    evidence: evidenceList(raw.evidence),
  };
}

/** Some endpoints may wrap the packet (`{packet, mock_edc_ack}`); unwrap it. */
export function unwrapPacket(raw: unknown): unknown {
  if (isObj(raw) && isObj(raw.packet)) {
    const ackObj = raw.mock_edc_ack;
    const ack = isObj(ackObj) ? (str(ackObj.ack_id) ?? str(ackObj.id)) : null;
    return ack ? { ...raw.packet, mock_edc_ack_id: ack } : raw.packet;
  }
  return raw;
}

/** Any packet-like JSON → `Packet`. Throws only when there is no id at all. */
export function normalizePacket(raw: unknown): Packet {
  if (!isObj(raw) || !str(raw.id)) {
    throw new Error("The server's packet response had no id.");
  }
  const kind: PacketKind = raw.kind === "aesi" ? "aesi" : "sae";
  const fields = Array.isArray(raw.fields)
    ? raw.fields.map(normalizeField).filter((f): f is PacketField => f !== null)
    : [];
  const missing = Array.isArray(raw.missing_information)
    ? raw.missing_information.map((m) => (typeof m === "string" ? m : JSON.stringify(m)))
    : [];
  const changes = Array.isArray(raw.changes_since_previous)
    ? raw.changes_since_previous.map(normalizeChange).filter((c): c is PacketChange => c !== null)
    : [];
  const ne = raw.narrative_edited;
  const edited = isObj(ne)
    ? { text: str(ne.text) ?? "", edited_by: str(ne.edited_by), edited_at: str(ne.edited_at) }
    : null;
  let evidenceIdx: Packet["evidence_index"] = null;
  const ei = raw.evidence_index;
  if (Array.isArray(ei)) evidenceIdx = ei.map(normalizeEvidence);
  else if (isObj(ei)) {
    evidenceIdx = Object.fromEntries(Object.entries(ei).map(([k, v]) => [k, normalizeEvidence(v)]));
  }
  return {
    id: str(raw.id) as string,
    clock_id: str(raw.clock_id) ?? "",
    kind,
    usubjid: str(raw.usubjid) ?? "",
    status: raw.status === "signed" ? "signed" : "draft",
    fields,
    missing_information: missing,
    narrative: normalizeWritten(raw.narrative),
    created_at: str(raw.created_at),
    signed_by: str(raw.signed_by),
    signed_at: str(raw.signed_at),
    sequence: typeof raw.sequence === "number" ? raw.sequence : 0,
    parent_packet_id: str(raw.parent_packet_id),
    changes_since_previous: changes,
    display_label: str(raw.display_label),
    version: typeof raw.version === "number" ? raw.version : null,
    due_at: str(raw.due_at),
    site_awareness_at: str(raw.site_awareness_at),
    clock_stopped_at: str(raw.clock_stopped_at),
    narrative_edited: edited,
    evidence_index: evidenceIdx,
    followup_packet_ids: Array.isArray(raw.followup_packet_ids)
      ? raw.followup_packet_ids.filter((x): x is string => typeof x === "string")
      : null,
    mock_edc_ack_id: str(raw.mock_edc_ack_id),
  };
}

/** `GET /sae-clocks` may return a list or a paginated page; accept both. */
export function normalizeClocks(raw: unknown): PacketClock[] {
  const list = Array.isArray(raw) ? raw : isObj(raw) && Array.isArray(raw.items) ? raw.items : [];
  return list.filter(isObj).map((c) => ({
    id: str(c.id) ?? "",
    kind: c.kind === "aesi" ? "aesi" : c.kind === "sae" ? "sae" : undefined,
    usubjid: str(c.usubjid) ?? undefined,
    site_awareness_at: str(c.site_awareness_at),
    due_at: str(c.due_at),
    stopped_at: str(c.stopped_at),
    decision: str(c.decision),
  }));
}

/** Short participant label: the API's display label, else the USUBJID tail. */
export function participantLabel(packet: Packet): string {
  if (packet.display_label) return packet.display_label;
  const m = packet.usubjid.match(/(P-\d+)$/i);
  return m ? m[1].toUpperCase() : packet.usubjid || "Unknown participant";
}

// ---------------------------------------------------------------------------
// Browser file helpers
// ---------------------------------------------------------------------------

/**
 * Content-Security-Policy put at the top of the printable HTML before it is
 * shown. A blob: URL made by this page runs with the app's origin, so if the
 * server's print page ever echoed a chart-note quote or free-text answer
 * without escaping, a `<script>` or `onerror=` in it would run as the app.
 * With this policy no script runs at all (inline handlers included), nothing
 * is fetched except inline styles and data: images, and forms go nowhere.
 */
export const PRINT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; " +
  "script-src 'none'; base-uri 'none'; form-action 'none'";

/**
 * Insert the print CSP `<meta>` as the first element the parser sees after
 * the doctype (a meta CSP only governs what comes after it), so the policy
 * covers the whole server document.
 */
export function lockDownPrintHtml(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${PRINT_CSP}">`;
  const doctype = html.match(/^\s*<!doctype[^>]*>/i);
  if (doctype) {
    const rest = html.slice(doctype[0].length);
    return `${doctype[0]}${meta}${rest}`;
  }
  return `${meta}${html}`;
}

/**
 * Hand a Blob to the browser as a download (export endpoints need the bearer
 * token, so a plain link cannot fetch them). Returns false without object URLs.
 * Same behaviour as `audit/auditLib.ts#saveBlob`, duplicated so this folder
 * does not depend on another page's internals.
 */
export function saveBlob(blob: Blob, filename: string): boolean {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return false;
  const href = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = href;
    a.download = filename;
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    return true;
  } finally {
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  }
}
