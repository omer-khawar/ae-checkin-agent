/**
 * Plain-language helpers (CLAUDE.md §00 "speak to non-clinicians first";
 * CONTRACTS.md R3.1 plain_language.json, R3.2 `labels`, R3.3).
 *
 * Plain words lead on screen; SDTM variable names and rule ids stay one click
 * deeper (a small monospace badge or a disclosure), never removed. Pure
 * functions only, shared by the check-in detail, note detail, escalations and
 * timeline pages.
 *
 * Lookup order everywhere: what the API sent (`labels`, `rule.plain`) → the
 * local copy of plain_language.json (`plainLanguageTable.ts`) → a humanized
 * fallback. Template filling mirrors `interim_rules.plain_language.rule_sentence`
 * so the same rule reads the same in the API and in the browser.
 */
import { tierStyle } from "../../../lib/format";
import type { Role } from "../../../lib/types";
import {
  PLAIN_CLOCK_KINDS,
  PLAIN_DOMAINS,
  PLAIN_EVIDENCE_KINDS,
  PLAIN_FIELDS,
  PLAIN_GRADES,
  PLAIN_INPUT_ALIASES,
  PLAIN_RENDER_AS,
  PLAIN_RULES,
  PLAIN_TIERS,
} from "./plainLanguageTable";
import type {
  ClockKind,
  ClockRow,
  ProtocolAssessment,
  ProtocolConMedFlag,
  ProtocolRef,
  RuleFiredPlain,
} from "./r34Types";

export type Labels = Record<string, string> | null | undefined;

// ---------------------------------------------------------------------------
// Field labels
// ---------------------------------------------------------------------------

/** "AETOXGR" → "Severity grade (provisional)". Unknown names are humanized. */
export function fieldLabel(name: string, labels?: Labels): string {
  const fromApi = labels?.[name];
  if (typeof fromApi === "string" && fromApi.trim()) return fromApi;
  const local = PLAIN_FIELDS[name];
  if (local) return local;
  const s = name
    .replace(/^INTERIM_/, "")
    .replace(/_/g, " ")
    .toLowerCase()
    .trim();
  return s ? s[0].toUpperCase() + s.slice(1) : name;
}

/** Fields that are provenance / bookkeeping rather than the record itself. */
export function isProvenanceField(name: string): boolean {
  return (
    name.startsWith("INTERIM_") &&
    // These two are decisions a coordinator acts on, so they stay in the main list.
    name !== "INTERIM_PROTOCOL_FLAG" &&
    name !== "INTERIM_CM_MISSING_FIELDS" &&
    name !== "INTERIM_AESI_SUSPECTED" &&
    name !== "INTERIM_IRAE"
  );
}

/** Identity fields a reader does not need first (still listed, one click deeper). */
export const IDENTITY_FIELDS = new Set(["STUDYID", "USUBJID", "AESEQ", "VSSEQ", "CMSEQ"]);

// ---------------------------------------------------------------------------
// Tiers, grades, domains, evidence kinds
// ---------------------------------------------------------------------------

/**
 * Explicit tier names (screenshots/README: Log, Review within 1 business day,
 * Nurse call today, Urgent): the same words as `TierChip`, so the chip and
 * the sentence never disagree.
 */
export function tierName(tier: number | null | undefined): string {
  if (tier === null || tier === undefined) return "not evaluated";
  if (tier >= 0 && tier <= 3) return tierStyle(tier).name;
  return `Tier ${tier}`;
}

/** The longer plain description of a tier (plain_language.json `tiers`), for hover text. */
export function tierDescription(tier: number | null | undefined): string | null {
  if (tier === null || tier === undefined) return null;
  return PLAIN_TIERS[String(tier)] ?? null;
}

/** 2 → "moderate" (NCI CTCAE v5.0 general grade words). */
export function gradeWord(grade: unknown): string | null {
  if (typeof grade !== "number") return null;
  return PLAIN_GRADES[String(grade)] ?? null;
}

/** "Grade 2 · moderate" for a provisional grade value. */
export function gradeText(grade: unknown): string | null {
  if (typeof grade !== "number") return null;
  const w = gradeWord(grade);
  return w ? `Grade ${grade} · ${w}` : `Grade ${grade}`;
}

export function domainName(domain: string): string {
  return PLAIN_DOMAINS[domain] ?? domain;
}

export function evidenceKindName(kind: string): string {
  return PLAIN_EVIDENCE_KINDS[kind] ?? kind.replace(/_/g, " ");
}

// ---------------------------------------------------------------------------
// Draft card titles
// ---------------------------------------------------------------------------

/**
 * Plain card title, e.g. "Side effect: Dyspnea, moderate (grade 2, provisional)",
 * "Vital sign: Pulse Rate", "Medication change: loratadine".
 */
export function plainDraftTitle(domain: string, fields: Record<string, unknown>): string {
  if (domain === "AE") {
    const term = String(fields.AEDECOD ?? fields.AETERM ?? "unnamed");
    const g = fields.AETOXGR;
    const w = gradeWord(g);
    const grade =
      typeof g === "number" ? `, ${w ? `${w} ` : ""}(grade ${g}, provisional)` : " (grade not set)";
    return `Side effect: ${term}${grade}`;
  }
  if (domain === "VS") {
    return `Vital sign: ${String(fields.VSTEST ?? fields.VSTESTCD ?? "reading")}`;
  }
  if (domain === "CM") {
    return `Medication change: ${String(fields.CMTRT ?? fields.CMDECOD ?? "unnamed")}`;
  }
  return domain;
}

/** The small monospace SDTM badge text that sits beside a plain title ("AE 1", "VS PULSE", "CM"). */
export function sdtmBadge(domain: string, fields: Record<string, unknown>): string {
  if (domain === "AE") {
    const seq = fields.AESEQ;
    return seq !== null && seq !== undefined ? `AE ${String(seq)}` : "AE";
  }
  if (domain === "VS") return `VS ${String(fields.VSTESTCD ?? "")}`.trim();
  return domain;
}

// ---------------------------------------------------------------------------
// Rule sentences
// ---------------------------------------------------------------------------

const PLACEHOLDER = /\{([A-Za-z0-9_.]+)\}/g;
const MAX_VALUE_CHARS = 160;

/** Mirrors `plain_language._render`: plain text or null when the value counts as missing. */
function renderValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    if (Number.isInteger(value)) return String(value);
    return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  }
  if (typeof value === "string") {
    let text = value.split(/\s+/).filter(Boolean).join(" ");
    if (!text) return null;
    if (text.length > MAX_VALUE_CHARS) text = `${text.slice(0, MAX_VALUE_CHARS - 3).trimEnd()}...`;
    return text;
  }
  if (Array.isArray(value)) {
    const parts = value.map(renderValue).filter((p): p is string => p !== null);
    return parts.length ? parts.join(", ") : "none";
  }
  return null;
}

function asLabels(
  value: unknown,
  kind: "field_label" | "item_label",
  labels: Labels,
  itemLabel: (id: string) => string,
): unknown {
  const convert = (v: unknown) =>
    typeof v !== "string" ? v : kind === "field_label" ? fieldLabel(v, labels) : itemLabel(v);
  return Array.isArray(value) ? value.map(convert) : convert(value);
}

export interface RuleSentenceOptions {
  labels?: Labels;
  /** Item id → plain item label (for `{aesi_items}`); defaults to a humanized id. */
  itemLabel?: (id: string) => string;
}

function humanizeId(id: string): string {
  const s = id.replace(/_/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : id;
}

/**
 * One short plain sentence for a fired rule: the API's own `plain` text when
 * present, else the local template filled from `rule.inputs` (falling back to
 * the template's input-free sentence when a placeholder is missing), else the
 * engine's `description`.
 */
export function ruleSentence(rule: RuleFiredPlain, opts: RuleSentenceOptions = {}): string {
  const fromApi = rule.plain ?? rule.plain_sentence;
  if (typeof fromApi === "string" && fromApi.trim()) return fromApi;
  const text = PLAIN_RULES[rule.rule_id];
  if (!text) return rule.description || `Interim applied the rule '${rule.rule_id}'.`;
  const inputs = (rule.inputs ?? {}) as Record<string, unknown>;
  const itemLabel = opts.itemLabel ?? humanizeId;
  let missing = false;
  const sentence = text.sentence.replace(PLACEHOLDER, (_m, name: string) => {
    for (const key of [name, ...(PLAIN_INPUT_ALIASES[name] ?? [])]) {
      if (!(key in inputs)) continue;
      let value = inputs[key];
      const kind = PLAIN_RENDER_AS[name];
      if (kind) value = asLabels(value, kind, opts.labels, itemLabel);
      const rendered = renderValue(value);
      if (rendered !== null) return rendered;
    }
    missing = true;
    return "";
  });
  if (missing) return text.fallback;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

// ---------------------------------------------------------------------------
// Clocks
// ---------------------------------------------------------------------------

export function clockKind(clock: Pick<ClockRow, "kind"> | null | undefined): ClockKind {
  return clock?.kind === "aesi" ? "aesi" : "sae";
}

/** "Serious event report due" / "Special-interest event report due". */
export function clockName(kind: ClockKind): string {
  return PLAIN_CLOCK_KINDS[kind]?.name ?? (kind === "aesi" ? "AESI clock" : "SAE clock");
}

/** The short chip text: "SAE" / "AESI". */
export function clockChip(kind: ClockKind): string {
  return kind === "aesi" ? "AESI" : "SAE";
}

/** One-line plain explanation of a clock kind, with the protocol section. */
export function clockNote(kind: ClockKind): string {
  return (
    PLAIN_CLOCK_KINDS[kind]?.note ??
    (kind === "aesi"
      ? "Possible AESI, investigator to confirm. Reported within 24 hours."
      : "Serious adverse events are reported to the sponsor within 24 hours.")
  );
}

/**
 * Whether the "Record seriousness decision" control applies to this clock.
 *
 * Only a running SAE clock qualifies: a seriousness answer (AESER) is what stops
 * an SAE clock, and nothing else (apps/api services/drafts.py). A possible-AESI
 * clock asks a different question ("immune-related?"); it starts only from a
 * grade 3 or higher item, so it always has a side-effect record, and it is
 * dismissed through "Immune-related? No" on that record or by signing the
 * report packet. Stopping it with "AESER = N" would dismiss a special-interest
 * report through the wrong question, so it is never offered here.
 *
 * `hasAeDraft` true hides the control (the attribution box is the right place);
 * null (unknown, e.g. the Escalations page, where clock rows carry no hint)
 * still offers it, with neutral wording (see ClockActions).
 */
export function canRecordDecision(
  clock: ClockRow,
  role: Role | null,
  hasAeDraft: boolean | null,
): boolean {
  return (
    role === "investigator" &&
    clockKind(clock) === "sae" &&
    clock.stopped_at === null &&
    hasAeDraft !== true
  );
}

/** The parts of an attribution request that can stop a clock (R4.3). */
export interface AttributionClockInput {
  AESER?: string | null;
  INTERIM_IRAE?: string | null;
}

/**
 * What a saved attribution does to the source's 24-hour clocks, mirroring the
 * API (services/drafts.py): AESER stops a running SAE clock; INTERIM_IRAE = "N"
 * stops a running possible-AESI clock. Returns the sentences to show, or an
 * empty list when no running clock is affected (then say nothing about clocks).
 */
export function attributionClockEffects(
  body: AttributionClockInput,
  clocks: readonly Pick<ClockRow, "kind" | "stopped_at">[],
): string[] {
  const running = (kind: ClockKind) =>
    clocks.some((c) => c.stopped_at === null && clockKind(c) === kind);
  const out: string[] = [];
  if (body.AESER && running("sae")) {
    out.push(
      "The 24-hour serious-event report clock has been stopped by the seriousness decision.",
    );
  }
  if (body.INTERIM_IRAE === "N" && running("aesi")) {
    out.push(
      "The 24-hour special-interest report clock has been stopped: the investigator marked it not immune-related.",
    );
  }
  return out;
}

/**
 * The clocks an attribution on this draft can stop: the API stops only clocks of
 * the draft's own source (its check-in session or its note). A follow-up draft
 * linked from an earlier check-in therefore does not touch this page's clocks.
 */
export function clocksForDraft<C extends Pick<ClockRow, "session_id" | "note_id">>(
  clocks: readonly C[],
  draft: { session_id?: string | null; note_id?: string | null },
): C[] {
  return clocks.filter((c) => {
    if (draft.session_id) return c.session_id === draft.session_id;
    if (draft.note_id) return c.note_id === draft.note_id;
    return false;
  });
}

/**
 * The hint under "Save attribution": which answer stops which running clock.
 * Null when no clock of the source is running.
 */
export function attributionClockHint(
  clocks: readonly Pick<ClockRow, "kind" | "stopped_at">[],
): string | null {
  const kinds = new Set(clocks.filter((c) => c.stopped_at === null).map((c) => clockKind(c)));
  const parts: string[] = [];
  if (kinds.has("sae")) {
    parts.push('Deciding "Serious?" stops the 24-hour serious-event report clock.');
  }
  if (kinds.has("aesi")) {
    parts.push(
      'Answering "Immune-related? No" stops the 24-hour special-interest report clock; "Serious?" does not.',
    );
  }
  return parts.length ? parts.join(" ") : null;
}

/** The decision string the API stores (apps/api schemas.StopSaeClockRequest examples). */
export function decisionString(serious: "Y" | "N"): string {
  return `AESER = ${serious}`;
}

export const AESI_BANNER =
  "Possible special-interest event (report within 24 h, investigator to confirm)";

/** Every clock a check-in detail carries, de-duplicated by id (`sae_clock`, `aesi_clock`, `clocks[]`). */
export function clocksOf(detail: {
  sae_clock?: ClockRow | null;
  aesi_clock?: ClockRow | null;
  clocks?: ClockRow[] | null;
}): ClockRow[] {
  const out: ClockRow[] = [];
  const seen = new Set<string>();
  const add = (c: ClockRow | null | undefined, fallbackKind?: ClockKind) => {
    if (!c || !c.id || seen.has(c.id)) return;
    seen.add(c.id);
    out.push(c.kind || !fallbackKind ? c : { ...c, kind: fallbackKind });
  };
  add(detail.sae_clock);
  add(detail.aesi_clock, "aesi");
  for (const c of detail.clocks ?? []) add(c);
  return out;
}

// ---------------------------------------------------------------------------
// Protocol (R3.1)
// ---------------------------------------------------------------------------

/** Protocol sections the con-med levels come from when the API sends no citation (§7.7.1–7.7.2, p. 69). */
const LEVEL_SECTION: Record<string, string> = {
  prohibited: "7.7.1",
  discouraged: "7.7.2",
  permitted: "7.7.2",
};

export interface ProtocolChip {
  level: string;
  text: string;
  /** Hover text: the protocol's exception wording (discouraged) or quote. */
  title?: string;
  className: string;
}

function refText(ref: ProtocolRef | null | undefined, level: string): string {
  const section = ref?.section ?? LEVEL_SECTION[level];
  return section ? `§${section}` : "";
}

/**
 * The chip for a CM draft's protocol classification:
 * "Prohibited by protocol §7.7.1", "Discouraged by protocol §7.7.2" (exception
 * text on hover), "Allowed by protocol §7.7.2". The matching flag from the
 * check-in's ProtocolAssessment supplies the exact section and wording.
 */
export function protocolChip(
  level: unknown,
  flag?: ProtocolConMedFlag | null,
): ProtocolChip | null {
  if (typeof level !== "string" || !level) return null;
  const ref = refText(flag?.protocol_ref, level);
  const suffix = ref ? ` ${ref}` : "";
  if (level === "prohibited") {
    return {
      level,
      text: `Prohibited by protocol${suffix}`,
      title: flag?.quote ?? "Possible protocol deviation; coordinator to confirm.",
      className: "bg-red-100 text-red-900 border-red-300",
    };
  }
  if (level === "discouraged") {
    const exception = flag?.exception_text?.trim();
    return {
      level,
      text: `Discouraged by protocol${suffix}`,
      title: exception
        ? `Protocol exception: ${exception}`
        : "Discouraged except in the cases the protocol names.",
      className: "bg-amber-100 text-amber-900 border-amber-300",
    };
  }
  if (level === "permitted") {
    return {
      level,
      text: `Allowed by protocol${suffix}`,
      title: flag?.condition ?? flag?.quote ?? undefined,
      className: "bg-emerald-50 text-emerald-900 border-emerald-300",
    };
  }
  return {
    level,
    text: `Protocol: ${level}`,
    className: "bg-slate-100 text-slate-800 border-slate-300",
  };
}

/** The protocol flag (if any) that classifies this CM draft's drug. */
export function flagForDraft(
  fields: Record<string, unknown>,
  protocol: ProtocolAssessment | null | undefined,
): ProtocolConMedFlag | null {
  const flags = protocol?.conmed_flags ?? [];
  if (flags.length === 0) return null;
  const names = [fields.CMDECOD, fields.CMTRT]
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.toLowerCase());
  const level = fields.INTERIM_PROTOCOL_FLAG;
  const hit = flags.find(
    (f) =>
      names.some((n) => n === f.drug.toLowerCase() || n.includes(f.drug.toLowerCase())) ||
      (f.matched_text && names.some((n) => n.includes(String(f.matched_text).toLowerCase()))),
  );
  return hit ?? flags.find((f) => f.level === level) ?? null;
}

/**
 * The short words the coordinator needs for the medication form (protocol §7.7,
 * p. 69): "dose, frequency, indication". These read as a to-ask list, so they
 * are deliberately shorter than the plain field labels.
 */
export const CM_MISSING_WORDS: Record<string, string> = {
  CMTRT: "medication name",
  CMDECOD: "generic name",
  CMDOSE: "dose",
  CMDOSU: "dose unit",
  CMDOSFRQ: "frequency",
  CMINDC: "indication",
  CMROUTE: "route",
  CMSTDTC: "start date",
  CMENDTC: "stop date",
};

/** "Still needed for the medication form: dose, frequency, indication", or null when nothing is missing. */
export function cmMissingText(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const words = value
    .filter((v): v is string => typeof v === "string")
    .map((v) => CM_MISSING_WORDS[v] ?? fieldLabel(v).toLowerCase());
  return words.length ? `Still needed for the medication form: ${words.join(", ")}` : null;
}

/** True when an AE draft is flagged as a possible AESI (field or protocol assessment). */
export function isAesiDraft(
  fields: Record<string, unknown>,
  protocol?: ProtocolAssessment | null,
  itemIdForTerm?: (aedecod: string) => string | null,
): boolean {
  if (fields.INTERIM_AESI_SUSPECTED === true) return true;
  if (!protocol?.aesi_suspected || !protocol.aesi_items?.length) return false;
  const term = typeof fields.AEDECOD === "string" ? fields.AEDECOD : null;
  if (!term || !itemIdForTerm) return false;
  const id = itemIdForTerm(term);
  return id !== null && protocol.aesi_items.includes(id);
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** A field value in plain words (yes/no, tier names, plain field lists). */
export function plainValue(name: string, value: unknown, labels?: Labels): string | null {
  if (value === null || value === undefined) return null;
  if (name === "INTERIM_TIER" && typeof value === "number") {
    return `${tierName(value)} (tier ${value})`;
  }
  if (name === "INTERIM_CM_MISSING_FIELDS" && Array.isArray(value)) {
    return value.length
      ? value.map((v) => (typeof v === "string" ? fieldLabel(v, labels) : String(v))).join(", ")
      : "nothing missing";
  }
  if (
    (name === "AESER" || name === "AEONGO" || name === "INTERIM_IRAE") &&
    typeof value === "string"
  ) {
    if (value === "Y") return "Yes";
    if (value === "N") return "No";
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return null;
}
