/**
 * Pure helpers for the visit-prep brief page. No React, no fetch: everything
 * here is unit-tested in `__tests__/model.test.ts`.
 *
 * Nothing in this file decides anything clinical. Grades, flags and clocks come
 * from the API (which gets them from the rules engine); these helpers only work
 * out how to *show* them, and fall back to reading the API's own plain-language
 * text when an optional structured field is missing.
 */
import type {
  Brief,
  BriefEvidenceRef,
  BriefGradePoint,
  BriefItem,
  BriefProtocolFlag,
  BriefQuestion,
  BriefSection,
  WrittenSentence,
  WrittenText,
} from "./types";

// ---------------------------------------------------------------------------
// Normalization (the API is new; be forgiving about shape, strict about types)
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : [];
}

const PROTOCOL_FLAGS: readonly BriefProtocolFlag[] = ["prohibited", "discouraged", "permitted"];
const TRENDS = ["up", "down", "same", "new"] as const;

function normalizeGrades(v: unknown): BriefGradePoint[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: BriefGradePoint[] = [];
  for (const g of v) {
    if (isObj(g) && num(g.grade) !== null) {
      out.push({
        grade: num(g.grade) as number,
        date: str(g.date),
        evidence_ids: strList(g.evidence_ids),
      });
    } else if (num(g) !== null) {
      out.push({ grade: g as number });
    }
  }
  return out;
}

/**
 * The line's plain-language text. The contract field is `text`; when a
 * narrative.py fact row is passed through without one, its own API-written
 * label is used instead (SideEffectFact/OpenAeFact `plain_label`, ClockFact
 * `event_label`, ConMedFact `name`). The page never composes text itself, so a
 * row with none of these (NoteFact, VitalsFact) is dropped; the API must send
 * `text` for those (see types.ts).
 */
function itemText(raw: Obj): string | null {
  return str(raw.text) ?? str(raw.plain_label) ?? str(raw.event_label) ?? str(raw.name);
}

function clockKindOf(v: unknown): BriefItem["clock_kind"] | undefined {
  return v === "sae" || v === "aesi" ? v : undefined;
}

export function normalizeItem(raw: unknown): BriefItem | null {
  if (typeof raw === "string")
    return raw.trim() ? { text: raw, evidence_ids: [], link: null } : null;
  if (!isObj(raw)) return null;
  const text = itemText(raw);
  if (!text) return null;
  const item: BriefItem = { text, evidence_ids: strList(raw.evidence_ids), link: str(raw.link) };
  const grades = normalizeGrades(raw.grades);
  if (grades) item.grades = grades;
  if (typeof raw.trend === "string" && (TRENDS as readonly string[]).includes(raw.trend)) {
    item.trend = raw.trend as BriefItem["trend"];
  }
  if (
    typeof raw.protocol_flag === "string" &&
    (PROTOCOL_FLAGS as readonly string[]).includes(raw.protocol_flag)
  ) {
    item.protocol_flag = raw.protocol_flag as BriefProtocolFlag;
  }
  item.protocol_section = str(raw.protocol_section);
  item.printed_page = num(raw.printed_page);
  item.exception_text = str(raw.exception_text);
  const missing = strList(raw.missing_fields);
  if (missing.length) item.missing_fields = missing;
  item.tier = num(raw.tier);
  if (typeof raw.acknowledged === "boolean") item.acknowledged = raw.acknowledged;
  // `clock_kind` is the page's name; narrative.py's ClockFact calls it `kind`.
  const clockKind = clockKindOf(raw.clock_kind) ?? clockKindOf(raw.kind);
  if (clockKind) item.clock_kind = clockKind;
  item.due_at = str(raw.due_at);
  item.status = str(raw.status);
  if (typeof raw.is_measured === "boolean") item.is_measured = raw.is_measured;
  item.source = str(raw.source);
  item.note_type = str(raw.note_type);
  item.ts = str(raw.ts);
  return item;
}

function normalizeSection(raw: unknown, index: number): BriefSection | null {
  if (!isObj(raw)) return null;
  const key = str(raw.key) ?? `section_${index}`;
  const title = str(raw.title) ?? key.replace(/_/g, " ");
  const items = Array.isArray(raw.items)
    ? raw.items.map(normalizeItem).filter((i): i is BriefItem => i !== null)
    : [];
  return { key, title, items };
}

function normalizeSentence(raw: unknown): WrittenSentence | null {
  if (!isObj(raw)) return null;
  const text = str(raw.text);
  if (!text) return null;
  return {
    text,
    evidence_ids: strList(raw.evidence_ids),
    section: str(raw.section),
    template_id: str(raw.template_id),
  };
}

/**
 * Who wrote a piece of generated text. Only the two writers in the contract
 * (CLAUDE.md §00.3) are recognised, case-insensitively. Anything else (a
 * missing, misspelled or new writer name) is "unknown": the page must never
 * claim "Written by template … no AI" over text it cannot vouch for.
 */
export function normalizeWriter(v: unknown): WrittenText["writer"] {
  const w = typeof v === "string" ? v.trim().toLowerCase() : "";
  return w === "template" || w === "llm" ? w : "unknown";
}

export function normalizeWritten(raw: unknown): WrittenText | null {
  if (!isObj(raw)) return null;
  const sentences = Array.isArray(raw.sentences)
    ? raw.sentences.map(normalizeSentence).filter((s): s is WrittenSentence => s !== null)
    : [];
  const text = str(raw.text) ?? sentences.map((s) => s.text).join(" ");
  if (!text && sentences.length === 0) return null;
  return {
    kind: str(raw.kind) ?? "visit_brief",
    writer: normalizeWriter(raw.writer),
    sentences,
    text,
    fallback_reason: str(raw.fallback_reason),
  };
}

function normalizeQuestion(raw: unknown): BriefQuestion | null {
  if (typeof raw === "string") return raw.trim() ? { text: raw, evidence_ids: [] } : null;
  if (!isObj(raw)) return null;
  // narrative.py QuestionFact carries `subject` + `details` rather than `text`.
  const details = strList(raw.details);
  const text =
    str(raw.text) ??
    (str(raw.subject)
      ? `${raw.subject as string}${details.length ? `: ${details.join(", ")}` : ""}`
      : null);
  if (!text) return null;
  return { text, evidence_ids: strList(raw.evidence_ids), kind: str(raw.kind) };
}

function normalizeEvidenceMap(raw: unknown): Record<string, BriefEvidenceRef> | undefined {
  if (!isObj(raw)) return undefined;
  const out: Record<string, BriefEvidenceRef> = {};
  for (const [id, v] of Object.entries(raw)) {
    if (!isObj(v)) continue;
    out[id] = { kind: str(v.kind), ts: str(v.ts), note: str(v.note), link: str(v.link) };
  }
  return out;
}

/** Turn whatever the API sent into a `Brief` the page can render without guards. */
export function normalizeBrief(raw: unknown, fallbackUsubjid: string): Brief {
  const b: Obj = isObj(raw) ? raw : {};
  const sections = Array.isArray(b.sections)
    ? b.sections.map(normalizeSection).filter((s): s is BriefSection => s !== null)
    : [];
  const questions = Array.isArray(b.questions_to_ask)
    ? b.questions_to_ask.map(normalizeQuestion).filter((q): q is BriefQuestion => q !== null)
    : [];
  const usubjid = str(b.usubjid) ?? fallbackUsubjid;
  return {
    usubjid,
    display_label: str(b.display_label) ?? usubjid,
    since: str(b.since),
    generated_at: str(b.generated_at),
    sections,
    narrative: normalizeWritten(b.narrative),
    questions_to_ask: questions,
    summary: str(b.summary),
    next_visit: str(b.next_visit),
    evidence: normalizeEvidenceMap(b.evidence),
  };
}

// ---------------------------------------------------------------------------
// Section kinds (how a section is decorated; the API's title is always shown)
// ---------------------------------------------------------------------------

export type SectionKind =
  | "side_effects"
  | "open_aes"
  | "meds"
  | "escalations"
  | "notes"
  | "vitals"
  | "other";

/** The visit-brief section keys in narrative_templates.json `sections`, mapped exactly. */
const KNOWN_SECTION_KINDS: Record<string, SectionKind> = {
  new_side_effects: "side_effects",
  open_aes: "open_aes",
  med_changes: "meds",
  escalations: "escalations",
  clocks: "escalations",
  notes: "notes",
  vitals: "vitals",
};

const OPEN_AE_KEY = /^open_(aes?|side_effects?|adverse_events?)$/;

/**
 * Classify a section by its key. Known keys match exactly; any other key is
 * matched by whole `_`-separated words, so "open_queries" or "open_packets" (R4)
 * fall through to "other" instead of being mistaken for open side effects.
 */
export function sectionKind(key: string): SectionKind {
  const k = key.trim().toLowerCase();
  const known = KNOWN_SECTION_KINDS[k];
  if (known) return known;
  if (OPEN_AE_KEY.test(k)) return "open_aes";
  const words = new Set(k.split(/[_\-\s]+/).filter(Boolean));
  const has = (...ws: string[]) => ws.some((w) => words.has(w));
  if (has("vital", "vitals")) return "vitals";
  if (has("escalation", "escalations", "clock", "clocks")) return "escalations";
  if (has("med", "meds", "medication", "medications", "conmed", "conmeds", "cm")) return "meds";
  if (has("note", "notes", "call", "calls")) return "notes";
  // "open_…" that is not an open-AE key (queries, packets, …) is not a side-effect list.
  if (!words.has("open") && (has("symptom", "symptoms", "ae", "aes") || /side_?effects?/.test(k)))
    return "side_effects";
  return "other";
}

// ---------------------------------------------------------------------------
// Grade trend (new side effects)
// ---------------------------------------------------------------------------

export type TrendDirection = "up" | "down" | "same" | "new";

export interface Trend {
  direction: TrendDirection;
  /** Provisional grades oldest → newest, as far as known. */
  grades: number[];
}

/**
 * The trend of one side effect's provisional grade. Uses, in order: the API's
 * explicit `trend`, the structured `grades[]`, then "grade N" mentions in the
 * item text. Returns null when nothing is known (no arrow is drawn).
 */
export function gradeTrend(item: BriefItem): Trend | null {
  const fromList = (item.grades ?? []).map((g) => g.grade);
  const fromText = fromList.length
    ? []
    : Array.from(item.text.matchAll(/\bgrade\s*(\d)\b/gi), (m) => Number(m[1]));
  const grades = fromList.length ? fromList : fromText;
  if (item.trend) return { direction: item.trend, grades };
  if (grades.length === 0) return null;
  if (grades.length === 1) return { direction: "new", grades };
  const last = grades[grades.length - 1];
  const prev = grades[grades.length - 2];
  return { direction: last > prev ? "up" : last < prev ? "down" : "same", grades };
}

export const TREND_STYLES: Record<TrendDirection, { arrow: string; label: string; cls: string }> = {
  up: { arrow: "↑", label: "Worse than last report", cls: "bg-red-50 text-red-800 border-red-300" },
  down: {
    arrow: "↓",
    label: "Better than last report",
    cls: "bg-green-50 text-green-800 border-green-300",
  },
  same: {
    arrow: "→",
    label: "Same as last report",
    cls: "bg-slate-50 text-slate-700 border-slate-300",
  },
  new: { arrow: "+", label: "First report", cls: "bg-brand-50 text-brand-900 border-brand-300" },
};

// ---------------------------------------------------------------------------
// Protocol flags (medication changes)
// ---------------------------------------------------------------------------

/** The item's protocol flag: the structured field, else the API's own wording. */
export function protocolFlagOf(item: BriefItem): BriefProtocolFlag | null {
  if (item.protocol_flag) return item.protocol_flag;
  const t = item.text.toLowerCase();
  if (/\bprohibited\b|\bnot allowed\b/.test(t)) return "prohibited";
  if (/\bdiscouraged\b/.test(t)) return "discouraged";
  if (/\bpermitted\b|\ballowed by (the )?protocol\b/.test(t)) return "permitted";
  return null;
}

export const PROTOCOL_FLAG_STYLES: Record<BriefProtocolFlag, { label: string; cls: string }> = {
  prohibited: { label: "Not allowed by protocol", cls: "bg-red-100 text-red-900 border-red-300" },
  discouraged: {
    label: "Discouraged by protocol",
    cls: "bg-amber-100 text-amber-900 border-amber-300",
  },
  permitted: { label: "Allowed by protocol", cls: "bg-green-100 text-green-900 border-green-300" },
};

/** "§7.7.1 p.69" when the API cites the protocol; null otherwise. */
export function protocolRef(item: BriefItem): string | null {
  const parts: string[] = [];
  if (item.protocol_section) parts.push(`§${item.protocol_section.replace(/^§/, "")}`);
  if (item.printed_page !== null && item.printed_page !== undefined)
    parts.push(`p.${item.printed_page}`);
  return parts.length ? parts.join(" ") : null;
}

/** Plain words for the protocol-required CM fields (protocol §7.7 p.69). */
export const CM_FIELD_PLAIN: Record<string, string> = {
  CMTRT: "medicine name",
  CMDOSE: "dose",
  CMDOSU: "dose unit",
  CMDOSFRQ: "how often",
  CMINDC: "reason taken",
  CMSTDTC: "start date",
  CMENDTC: "stop date",
};

export function plainCmField(name: string): string {
  return CM_FIELD_PLAIN[name] ?? name;
}

// ---------------------------------------------------------------------------
// Vitals: MEASURED / SIMULATED
// ---------------------------------------------------------------------------

/**
 * "not measured", "no measured vitals", "wasn't measured", "never been
 * measured", "without measured …": a negation up to two words before
 * "measured". ("unmeasured" never matches `\bmeasured\b` in the first place.)
 */
const NEGATED_MEASURED =
  /(?:\b(?:not|no|never|without|nothing)|n't)\s+(?:[a-z]+\s+){0,2}measured\b/;

/**
 * Whether a vitals line is measured. The structured `is_measured` wins; else the
 * API's text: "simulated" → SIMULATED; an un-negated "measured" → MEASURED.
 * Anything else (no cue, or negated wording such as "not measured") is
 * SIMULATED: the page never claims a real measurement that no source asserted.
 */
export function measuredOf(item: BriefItem): { isMeasured: boolean; fromText: boolean } {
  if (typeof item.is_measured === "boolean")
    return { isMeasured: item.is_measured, fromText: false };
  const t = item.text.toLowerCase().replace(/[’‘]/g, "'");
  if (/\bsimulated\b/.test(t)) return { isMeasured: false, fromText: true };
  if (NEGATED_MEASURED.test(t)) return { isMeasured: false, fromText: true };
  if (/\bmeasured\b/.test(t)) return { isMeasured: true, fromText: true };
  return { isMeasured: false, fromText: true };
}

// ---------------------------------------------------------------------------
// Clocks and notes
// ---------------------------------------------------------------------------

export const CLOCK_LABELS: Record<"sae" | "aesi", { chip: string; plain: string }> = {
  sae: { chip: "SAE", plain: "24-hour report: possible serious event" },
  aesi: {
    chip: "AESI",
    plain: "24-hour report: possible event of special interest, investigator to confirm",
  },
};

const NOTE_TYPE_LABELS: Record<string, string> = {
  phone_call: "Phone call",
  er_note: "ER note",
  ed_note: "ER note",
  urgent_care: "Urgent care",
  progress_note: "Clinic note",
  discharge_summary: "Discharge summary",
};

export function noteTypeLabel(t: string | null | undefined): string | null {
  if (!t) return null;
  return NOTE_TYPE_LABELS[t] ?? t.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export const QUESTION_KIND_LABELS: Record<string, string> = {
  cm_missing_fields: "Missing medication details",
  unresolved_ae: "Side effect still open",
  unsigned_packet: "Report not signed yet",
};

// ---------------------------------------------------------------------------
// Evidence chips
// ---------------------------------------------------------------------------

const EVIDENCE_KIND_LABELS: Record<string, string> = {
  pro_response: "Answer",
  gate_answer: "Answer",
  vitals_sample: "Vitals",
  rule: "Rule",
  table: "Table",
  chart_note: "Note",
  phone_call: "Call",
  draft: "Record",
  packet: "Report",
  clock: "Clock",
  escalation: "Escalation",
  session: "Check-in",
};

/** "Answer", "Rule", … for a chip; uses the evidence map when present, else the id's shape. */
export function evidenceKindLabel(id: string, ref?: BriefEvidenceRef): string {
  if (ref?.kind) return EVIDENCE_KIND_LABELS[ref.kind] ?? ref.kind.replace(/_/g, " ");
  if (/:gate_/.test(id)) return "Answer";
  if (/^[a-z][a-z_]*(\.[a-z0-9_]+)+$/.test(id)) return "Rule";
  return "Record";
}

/** A short, still-unique-enough handle for an id: rule ids whole, ULIDs as "…X7Q2KD". */
export function shortId(id: string): string {
  if (/^[a-z][a-z_]*(\.[a-z0-9_]+)+$/.test(id)) return id;
  return id.length > 10 ? `…${id.slice(-6)}` : id;
}

/** True when `ids` cites the selected evidence id. */
export function cites(ids: readonly string[], selected: string | null): boolean {
  return selected !== null && ids.includes(selected);
}

/** How many lines on the page (items, sentences, questions) cite `id`. */
export function countCiters(brief: Brief, id: string): number {
  let n = 0;
  for (const s of brief.sections) for (const i of s.items) if (i.evidence_ids.includes(id)) n++;
  for (const s of brief.narrative?.sentences ?? []) if (s.evidence_ids.includes(id)) n++;
  for (const q of brief.questions_to_ask) if (q.evidence_ids.includes(id)) n++;
  return n;
}

/** The generated-text label (CLAUDE.md §00.3). */
export function writerLabel(writer: WrittenText["writer"]): string {
  if (writer === "llm") return "Written by Claude";
  if (writer === "template") return "Written by template";
  return "Writer unknown";
}

/** The writer label's tooltip: what each writer means, never a guess. */
export function writerTitle(writer: WrittenText["writer"]): string {
  if (writer === "llm") return "Drafted by Claude; every cited evidence id and quote was checked";
  if (writer === "template")
    return "Assembled by a fixed template from the cited records only; no AI";
  return "The API did not say which writer produced this text; treat it as unreviewed";
}

// ---------------------------------------------------------------------------
// Links and dates
// ---------------------------------------------------------------------------

/** In-app route ("/dashboard/…") vs external URL. Protocol-relative "//x" and "/\x" are external. */
export function isInternalLink(link: string): boolean {
  return /^\/(?![/\\])/.test(link);
}

export type SafeLink = { kind: "internal"; to: string } | { kind: "external"; href: string };

/**
 * Vet a link from the API before it becomes clickable. Only in-app routes
 * ("/dashboard/…") and absolute http(s) URLs are allowed; `javascript:`,
 * `data:`, `blob:`, protocol-relative and anything unparsable return null and
 * the caller renders plain text. Links can originate in ingested notes or
 * source data, and the dashboard origin holds the bearer token.
 */
export function safeLink(link: string | null | undefined): SafeLink | null {
  if (!link) return null;
  // Control characters and whitespace can hide a scheme from naive checks.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f]/.test(link)) return null;
  if (isInternalLink(link)) return { kind: "internal", to: link };
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  return url.protocol === "https:" || url.protocol === "http:"
    ? { kind: "external", href: url.href }
    : null;
}

/**
 * The CSP put at the top of the server's printable HTML before it is opened as
 * a blob: URL. A blob URL inherits this page's origin, so without it any script
 * in that HTML (say, an unescaped chart-note quote) would run with access to the
 * dashboard's sessionStorage token. No scripts, no plugins, no forms, no <base>;
 * inline styles and data: images still render.
 */
export const PRINTABLE_CSP =
  "default-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'; " +
  "form-action 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";

/**
 * Put a restrictive CSP <meta> first in the document (right after a leading
 * doctype, so standards mode is kept). A later, looser CSP in the HTML cannot
 * relax it: multiple policies only ever intersect.
 */
export function withRestrictiveCsp(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${PRINTABLE_CSP}">`;
  const m = /^\s*<!doctype[^>]*>/i.exec(html);
  if (m) return `${m[0]}${meta}${html.slice(m[0].length)}`;
  return `${meta}${html}`;
}

/** "2026-10-03" (or a full ISO string) → the date part, for <input type="date">. */
export function toDateInput(value: string | null | undefined): string {
  const m = value ? /^(\d{4}-\d{2}-\d{2})/.exec(value) : null;
  return m ? m[1] : "";
}

const DAY_FMT = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
});

/**
 * A calendar date in local words ("Sat, Oct 3, 2026"). Built from the Y-M-D parts
 * so a date-only value is never shifted a day by the UTC → local conversion.
 */
export function formatDay(value: string | null | undefined): string {
  const d = toDateInput(value);
  if (!d) return value ?? "";
  const [y, m, day] = d.split("-").map(Number);
  const date = new Date(y, m - 1, day);
  return Number.isNaN(date.getTime()) ? d : DAY_FMT.format(date);
}

// ---------------------------------------------------------------------------
// One-line summary
// ---------------------------------------------------------------------------

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The header's one-line summary: the API's `summary` if sent, else counts of
 * what is on the page. Counts only, never a judgement.
 */
export function summaryLine(brief: Brief): string {
  if (brief.summary) return brief.summary;
  const count = (kind: SectionKind) =>
    brief.sections
      .filter((s) => sectionKind(s.key) === kind)
      .reduce((n, s) => n + s.items.length, 0);
  const parts: string[] = [];
  const se = count("side_effects");
  if (se) parts.push(plural(se, "new side effect", "new side effects"));
  const open = count("open_aes");
  if (open) parts.push(plural(open, "open side effect", "open side effects"));
  const medItems = brief.sections
    .filter((s) => sectionKind(s.key) === "meds")
    .flatMap((s) => s.items);
  if (medItems.length) {
    const flagged = medItems.filter((i) => {
      const f = protocolFlagOf(i);
      return f === "prohibited" || f === "discouraged";
    }).length;
    parts.push(
      plural(medItems.length, "medication change", "medication changes") +
        (flagged ? ` (${flagged} flagged against the protocol)` : ""),
    );
  }
  const esc = count("escalations");
  if (esc) parts.push(plural(esc, "escalation or report clock", "escalations or report clocks"));
  const notes = count("notes");
  if (notes) parts.push(plural(notes, "note or call", "notes or calls"));
  const q = brief.questions_to_ask.length;
  if (q) parts.push(plural(q, "question to ask", "questions to ask"));
  const since = brief.since ? `Since ${formatDay(brief.since)}` : "Since the last visit";
  if (!parts.length) return `${since}: nothing new was recorded.`;
  return `${since}: ${parts.join(", ")}.`;
}

/** True when every section is empty (the page shows a calm "nothing new" state). */
export function isEmptyBrief(brief: Brief): boolean {
  return brief.sections.every((s) => s.items.length === 0);
}
