/**
 * Pure helpers for the check-in detail page (no React, no I/O).
 *
 * The page's whole "explains itself" behaviour rests on one idea: every derived
 * value on screen carries `Evidence[]` pointers whose `id`s are answer ids,
 * vitals sample ids, rule ids or table file names. Selecting a draft field (or a
 * rule) yields a `Set<string>` of those ids, and each row in the other columns
 * simply asks "is my id in the set?" to decide whether to highlight itself.
 *
 * Nothing here decides anything clinical. Labels, option wordings and grade
 * definitions come from the API (`/items`, `/reference/ctcae`); when they are
 * missing the page falls back to the PRO-CTCAE default wordings in `format.tsx`.
 */
import { DEFAULT_OPTIONS, optionsFor } from "../../../lib/format";
import type {
  Answer,
  Attribute,
  AttributionRequest,
  CheckInDetail,
  CtcaeTerm,
  Domain,
  Draft,
  DraftStatus,
  Evidence,
  EvidenceKind,
  Item,
  RuleCategory,
  RuleFired,
} from "../../../lib/types";

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

/** Gate answers are stored as Answer rows with these item ids (CONTRACTS §2.1). */
export const GATE_LABELS: Record<string, string> = {
  gate_hospitalization: "Admitted to a hospital or seen in an emergency room since last visit",
  gate_conmed: "Started or stopped any medication since last visit",
  gate_conmed_text: "Medication name, as typed",
  gate_conmed_direction: "Started, stopped or both",
  gate_other: "Anything else for the study team",
  gate_temp_c: "Temperature typed by the participant",
};

/** Gate fields whose text is free text: shown with the "verbatim, never parsed" marker. */
export const VERBATIM_GATES = new Set(["gate_other"]);
/** The con-med name is verbatim too, but it IS compared by string distance (never parsed). */
export const CONMED_TEXT_GATE = "gate_conmed_text";

export function isGateAnswer(a: Answer): boolean {
  return a.attribute === "gate" || a.item_id.startsWith("gate_");
}

/** Chronological order by server receipt time; client time breaks ties. Stable. */
export function sortAnswers(answers: Answer[]): Answer[] {
  return answers
    .map((a, i) => ({ a, i }))
    .sort((x, y) => {
      const t = Date.parse(x.a.ts_server) - Date.parse(y.a.ts_server);
      if (Number.isFinite(t) && t !== 0) return t;
      const c = Date.parse(x.a.ts_client) - Date.parse(y.a.ts_client);
      if (Number.isFinite(c) && c !== 0) return c;
      return x.i - y.i;
    })
    .map((x) => x.a);
}

/** "shortness_of_breath" → "Shortness of breath" when no table label is available. */
export function humanize(id: string): string {
  const s = id
    .replace(/^gate_/, "")
    .replace(/_/g, " ")
    .trim();
  return s ? s[0].toUpperCase() + s.slice(1) : id;
}

export function itemLabel(itemId: string, items: Item[] | null, detail: CheckInDetail): string {
  if (GATE_LABELS[itemId]) return GATE_LABELS[itemId];
  const fromTable = items?.find((i) => i.id === itemId);
  if (fromTable) return fromTable.label;
  const fromResult = detail.result?.items?.find((i) => i.item_id === itemId);
  if (fromResult) return fromResult.label;
  return humanize(itemId);
}

/** Option wording for an integer answer: the items table first, PRO-CTCAE defaults second. */
export function optionLabel(
  itemId: string,
  attribute: Attribute | "gate",
  value: number | null,
  items: Item[] | null,
): string | null {
  if (value === null || attribute === "gate") return null;
  const item = items?.find((i) => i.id === itemId);
  const options = item ? optionsFor(item, attribute) : DEFAULT_OPTIONS[attribute];
  return options.find((o) => o.value === value)?.label ?? null;
}

export interface GateDisplay {
  text: string;
  /** Free text stored verbatim and never parsed by software. */
  verbatim: boolean;
  /** Verbatim text that a deterministic string matcher compared (con-med name). */
  matchedOnly: boolean;
  empty: boolean;
}

/** Display form of a gate answer row. Yes/no gates use value_int; the rest use value_text. */
export function describeGate(a: Answer): GateDisplay {
  const base = { verbatim: false, matchedOnly: false, empty: false };
  if (a.item_id === "gate_hospitalization" || a.item_id === "gate_conmed") {
    if (a.value_int === null) return { ...base, text: "—", empty: true };
    return { ...base, text: a.value_int ? "Yes" : "No" };
  }
  if (a.item_id === "gate_temp_c") {
    const v = a.value_text ?? (a.value_int !== null ? String(a.value_int) : null);
    return v === null ? { ...base, text: "—", empty: true } : { ...base, text: `${v} °C` };
  }
  const text = a.value_text ?? "";
  if (!text) return { ...base, text: "(empty)", empty: true };
  if (VERBATIM_GATES.has(a.item_id)) return { ...base, text, verbatim: true };
  if (a.item_id === CONMED_TEXT_GATE) return { ...base, text, verbatim: true, matchedOnly: true };
  return { ...base, text };
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

export const DOMAIN_ORDER: Domain[] = ["AE", "VS", "CM"];

export const DOMAIN_TITLES: Record<Domain, string> = {
  AE: "AE — adverse events",
  VS: "VS — vital signs",
  CM: "CM — concomitant medications",
};

/**
 * Fields a coordinator may edit inline (CLAUDE.md §3.5). Identity, sequence and
 * INTERIM_* provenance fields are never editable; AESER/AEREL go through the
 * investigator attribution endpoint instead. CMTRT stays verbatim by design.
 */
export const EDITABLE_FIELDS: Record<Domain, string[]> = {
  AE: ["AETERM", "AEDECOD", "AESTDTC", "AEENDTC", "AEONGO", "AETOXGR", "AEACN", "AEOUT"],
  VS: ["VSORRES", "VSORRESU", "VSDTC", "VSSTAT"],
  CM: ["CMDECOD", "CMSTDTC", "CMENDTC", "CMSTAT"],
};

export const ATTRIBUTION_FIELDS = ["AESER", "AEREL"] as const;
export const AESER_OPTIONS = ["Y", "N"] as const;
export const AEREL_OPTIONS = [
  "NOT RELATED",
  "UNLIKELY",
  "POSSIBLE",
  "PROBABLE",
  "RELATED",
] as const;

/**
 * Body for PATCH /drafts/{id}/attribution. A key is included only when the
 * investigator picked a real option that differs from what is recorded: the
 * blank "— not decided —" choice is never sent (the API would store "" as the
 * SDTM value and still treat AESER as recorded), and an unchanged value is not
 * re-recorded. Returns null when there is nothing to record.
 */
export function attributionBody(
  current: { AESER: string; AEREL: string },
  picked: { AESER: string; AEREL: string },
  note: string,
): AttributionRequest | null {
  const body: AttributionRequest = {};
  const aeser = picked.AESER.trim();
  const aerel = picked.AEREL.trim();
  if (aeser !== "" && aeser !== current.AESER) body.AESER = aeser;
  if (aerel !== "" && aerel !== current.AEREL) body.AEREL = aerel;
  if (body.AESER === undefined && body.AEREL === undefined) return null;
  if (note.trim()) body.note = note.trim();
  return body;
}

/** Grades Interim may assign (CLAUDE.md §3.4b): G4/G5 are never assigned by this system. */
export const MAX_ASSIGNABLE_GRADE = 3;

export const PROVISIONAL_LABEL = "provisional, investigator to confirm";

export function isEditable(domain: Domain, field: string): boolean {
  return EDITABLE_FIELDS[domain].includes(field);
}

/** Current rows only: superseded versions live in the version history. */
export function groupDrafts(drafts: Draft[]): Record<Domain, Draft[]> {
  const out: Record<Domain, Draft[]> = { AE: [], VS: [], CM: [] };
  for (const d of drafts) {
    if (d.status === "superseded") continue;
    if (d.domain in out) out[d.domain].push(d);
  }
  const num = (v: unknown) => (typeof v === "number" ? v : Number.POSITIVE_INFINITY);
  out.AE.sort((a, b) => num(a.fields.AESEQ) - num(b.fields.AESEQ));
  out.VS.sort((a, b) =>
    String(a.fields.VSTESTCD ?? "").localeCompare(String(b.fields.VSTESTCD ?? "")),
  );
  out.CM.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return out;
}

/** Short heading for a draft card, e.g. "AE 2 · Dyspnea", "VS · PULSE", "CM · loratadine". */
export function draftTitle(d: Draft): string {
  const f = d.fields;
  if (d.domain === "AE") {
    const seq = f.AESEQ !== undefined && f.AESEQ !== null ? ` ${String(f.AESEQ)}` : "";
    return `AE${seq} · ${String(f.AEDECOD ?? f.AETERM ?? "")}`.trim();
  }
  if (d.domain === "VS") return `VS · ${String(f.VSTESTCD ?? "")}`.trim();
  return `CM · ${String(f.CMTRT ?? "")}`.trim();
}

/** R2.3: drafts carry `source`; older rows only have `fields.INTERIM_SOURCE`. */
export function draftSource(d: Draft): "check_in" | "chart_note" | string | null {
  const direct = (d as Draft & { source?: unknown }).source;
  if (typeof direct === "string") return direct;
  const fromFields = d.fields.INTERIM_SOURCE;
  return typeof fromFields === "string" ? fromFields : null;
}

/** Keep SDTM field order as the API sent it but push INTERIM_* provenance to the end. */
export function orderedFieldNames(d: Draft): string[] {
  const names = Object.keys(d.fields);
  const sdtm = names.filter((n) => !n.startsWith("INTERIM_"));
  const interim = names.filter((n) => n.startsWith("INTERIM_"));
  return [...sdtm, ...interim];
}

export const DRAFT_STATUS_STYLES: Record<DraftStatus, { label: string; className: string }> = {
  draft: { label: "Draft", className: "bg-slate-100 text-slate-800 border-slate-300" },
  confirmed: { label: "Confirmed", className: "bg-green-100 text-green-800 border-green-300" },
  rejected: { label: "Rejected", className: "bg-red-50 text-red-800 border-red-300" },
  superseded: { label: "Superseded", className: "bg-white text-slate-500 border-slate-300" },
};

export function draftStatusStyle(status: string): { label: string; className: string } {
  return (
    (DRAFT_STATUS_STYLES as Record<string, { label: string; className: string }>)[status] ?? {
      label: status,
      className: "bg-slate-100 text-slate-800 border-slate-300",
    }
  );
}

/** Human form of any field value. Objects/arrays are shown as compact JSON. */
export function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (typeof v === "string") return v === "" ? "(empty)" : v;
  if (Array.isArray(v)) return v.length ? v.map(formatValue).join(", ") : "(none)";
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Editor text for a field value (empty for null). */
export function editText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Fields whose edited text should be sent as a number. */
const NUMERIC_FIELDS = new Set(["AETOXGR", "VSORRES"]);

/**
 * Diff the editor against the original fields. Empty text means null; numeric
 * fields parse to numbers; everything else is sent as the trimmed string.
 * Returns only the keys whose value actually changed.
 */
export function changedFields(
  original: Record<string, unknown>,
  edited: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, text] of Object.entries(edited)) {
    const trimmed = text.trim();
    let next: unknown;
    if (trimmed === "") next = null;
    else if (NUMERIC_FIELDS.has(name) && /^[-+]?\d+(\.\d+)?$/.test(trimmed)) next = Number(trimmed);
    else next = trimmed;
    const prev = original[name] ?? null;
    if (next !== prev && !(typeof next === "number" && typeof prev === "number" && next === prev)) {
      out[name] = next;
    }
  }
  return out;
}

/** Validation for the inline editor; returns a message or null. */
export function editProblem(name: string, text: string): string | null {
  const trimmed = text.trim();
  if (name === "AETOXGR" && trimmed !== "") {
    if (!/^\d+$/.test(trimmed)) return "Grade must be a whole number.";
    const g = Number(trimmed);
    if (g > MAX_ASSIGNABLE_GRADE) {
      return `Interim never assigns a grade above ${MAX_ASSIGNABLE_GRADE}; grades 4 and 5 are recorded by the investigator in the EDC.`;
    }
  }
  if (name === "VSORRES" && trimmed !== "" && !/^[-+]?\d+(\.\d+)?$/.test(trimmed)) {
    return "Result must be a number.";
  }
  return null;
}

/** Field-by-field differences between two versions (for the version history). */
export function diffVersions(
  prev: Draft | null,
  next: Draft,
): Array<{ name: string; from: unknown; to: unknown }> {
  if (!prev) return [];
  const names = new Set([...Object.keys(prev.fields), ...Object.keys(next.fields)]);
  const out: Array<{ name: string; from: unknown; to: unknown }> = [];
  for (const n of names) {
    const a = prev.fields[n] ?? null;
    const b = next.fields[n] ?? null;
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ name: n, from: a, to: b });
  }
  return out;
}

/** Versions oldest → newest regardless of the order the API returns them. */
export function sortVersions(versions: Draft[]): Draft[] {
  return [...versions].sort(
    (a, b) => a.version - b.version || a.created_at.localeCompare(b.created_at),
  );
}

// ---------------------------------------------------------------------------
// Evidence and highlighting
// ---------------------------------------------------------------------------

/**
 * A rule selection is addressed by its position in `allRules()`, not by
 * `rule_id` alone: the engine legitimately fires the same id several times per
 * check-in (`draft.ae` per AE draft, `draft.vs` per VS metric, `dedup.new_ae`
 * per graded item, `vitals.implausible` per offending sample), and each
 * occurrence carries its own inputs and evidence. `ruleId` is kept alongside
 * the index as a guard against a stale index after a reload.
 */
export type Selection =
  | { kind: "field"; draftId: string; field: string }
  | { kind: "rule"; ruleId: string; index: number }
  | null;

/** The Evidence[] behind the current selection (empty when nothing is selected). */
export function selectionEvidence(sel: Selection, detail: CheckInDetail): Evidence[] {
  if (!sel) return [];
  if (sel.kind === "field") {
    const d = detail.drafts.find((x) => x.id === sel.draftId);
    return d?.evidence?.[sel.field] ?? [];
  }
  const rule = ruleAt(sel, allRules(detail));
  return rule?.evidence ?? [];
}

/** The rule a selection points at: the row at `index` when its id still matches, else the first row with that id. */
export function ruleAt(
  sel: { ruleId: string; index: number },
  rules: RuleFired[],
): RuleFired | null {
  const byIndex = rules[sel.index];
  if (byIndex && byIndex.rule_id === sel.ruleId) return byIndex;
  return rules.find((r) => r.rule_id === sel.ruleId) ?? null;
}

/** Row highlight classes shared by answers, samples and rules (Tailwind literal so it is compiled). */
export function highlightClass(active: boolean): string {
  return active ? "bg-amber-50 ring-2 ring-amber-400 ring-inset" : "";
}

/** Ids to highlight: the evidence ids plus, for a field selection, the rule ids it cites. */
export function highlightSet(evidence: Evidence[]): Set<string> {
  const s = new Set<string>();
  for (const e of evidence) if (e && typeof e.id === "string") s.add(e.id);
  return s;
}

/**
 * Every rule the API reports, in engine order, repeats included.
 *
 * `GET /checkins/{id}` returns the same list under `rules_fired` and
 * `result.rules_fired` (CONTRACTS §2.2), so the two are alternatives, never
 * merged: merging them would double every rule, and de-duplicating by id would
 * silently drop the legitimate repeats described on `Selection`.
 */
export function allRules(detail: CheckInDetail): RuleFired[] {
  const top = (detail.rules_fired ?? []).filter(Boolean);
  if (top.length > 0) return top;
  return (detail.result?.rules_fired ?? []).filter(Boolean);
}

/** Resolve an evidence pointer through `evidence_index` when the draft's copy is thin. */
export function resolveEvidence(e: Evidence, detail: CheckInDetail): Evidence {
  const idx = detail.evidence_index?.[e.id];
  if (!idx) return e;
  return { ...idx, ...e, note: e.note || idx.note, ts: e.ts ?? idx.ts };
}

export const EVIDENCE_KIND_LABELS: Record<EvidenceKind | "chart_note", string> = {
  pro_response: "answer",
  gate_answer: "gate answer",
  vitals_sample: "vitals sample",
  rule: "rule",
  table: "table",
  chart_note: "chart note",
};

export function evidenceKindLabel(kind: string): string {
  return (EVIDENCE_KIND_LABELS as Record<string, string>)[kind] ?? kind;
}

export const RULE_CATEGORY_STYLES: Record<RuleCategory, string> = {
  scoring: "bg-slate-100 text-slate-800 border-slate-300",
  grading: "bg-sky-100 text-sky-900 border-sky-300",
  red_flag: "bg-red-100 text-red-900 border-red-300",
  vitals_quality: "bg-violet-100 text-violet-900 border-violet-300",
  corroboration: "bg-orange-100 text-orange-900 border-orange-300",
  escalation: "bg-amber-100 text-amber-900 border-amber-300",
  seriousness: "bg-red-600 text-white border-red-700",
  conmed: "bg-emerald-100 text-emerald-900 border-emerald-300",
  dedup: "bg-indigo-100 text-indigo-900 border-indigo-300",
  drafting: "bg-slate-100 text-slate-700 border-slate-300",
};

export function ruleCategoryClass(category: string): string {
  return (
    (RULE_CATEGORY_STYLES as Record<string, string>)[category] ??
    "bg-slate-100 text-slate-800 border-slate-300"
  );
}

// ---------------------------------------------------------------------------
// Measured / simulated provenance
// ---------------------------------------------------------------------------

export interface VitalsProvenance {
  hasSamples: boolean;
  isMeasured: boolean;
  source: string | null;
}

/**
 * One answer to "were this session's vitals measured or simulated?", used by
 * the page header and the Vitals card so the two can never disagree.
 *
 * The rules summary is authoritative when present. It is null whenever no
 * sample was usable (low_quality / implausible / unavailable), and in that
 * case the raw samples still say where they came from: a real sensor that
 * produced only low-confidence samples is still MEASURED, not SIMULATED.
 */
export function vitalsProvenance(detail: CheckInDetail): VitalsProvenance {
  const samples = detail.vitals?.samples ?? [];
  const summary = detail.vitals?.summary ?? detail.result?.vitals?.summary ?? null;
  return {
    hasSamples: samples.length > 0,
    isMeasured: summary?.is_measured ?? samples.some((s) => s.is_measured),
    source: summary?.source ?? samples[0]?.source ?? null,
  };
}

/** VSMETHOD text the rules package writes for simulated sources (CONTRACTS §1.4). */
export const VSMETHOD_SIMULATED = "Simulated";

/**
 * Measured/simulated for a VS draft's badge. The `VSMETHOD` string is the
 * SDTM-visible claim on the same row, so it wins: the badge beside
 * "Contactless optical, camera-based" must read MEASURED and the badge beside
 * "Simulated" must read SIMULATED whatever `INTERIM_IS_MEASURED` says (or if
 * an older API omits it). Without a VSMETHOD string the boolean decides, and
 * an absent boolean is treated as simulated, never as measured.
 */
export function vsDraftIsMeasured(fields: Record<string, unknown>): boolean {
  const method = fields.VSMETHOD;
  if (typeof method === "string" && method.trim() !== "") {
    return method.trim().toLowerCase() !== VSMETHOD_SIMULATED.toLowerCase();
  }
  return fields.INTERIM_IS_MEASURED === true;
}

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

/** CTCAE grade definitions for a draft's AEDECOD, or null when the reference is absent. */
export function gradeDefinitions(
  ctcae: CtcaeTerm[] | null,
  aedecod: unknown,
): Record<string, string> | null {
  if (!ctcae || typeof aedecod !== "string") return null;
  const row = ctcae.find((t) => t.aedecod.toLowerCase() === aedecod.toLowerCase());
  if (!row) return null;
  const defs: Record<string, string> = {};
  for (const [g, text] of Object.entries(row.grade_definitions ?? {})) {
    if (typeof text === "string" && text) defs[g] = text;
  }
  return Object.keys(defs).length ? defs : null;
}

/** Multi-line hover text "G1: … / G2: …" from a definitions map. */
export function gradeHover(defs: Record<string, string> | null): string | undefined {
  if (!defs) return undefined;
  return Object.entries(defs)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([g, t]) => `G${g}: ${t}`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Clocks
// ---------------------------------------------------------------------------

/** Whole seconds from `nowMs` until `iso` (negative when past); null when unparsable. */
export function secondsUntil(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.round((t - nowMs) / 1000);
}

/**
 * Seconds of the 24 h window that were left when an investigator stopped the
 * SAE clock. The API nulls `seconds_remaining` once `stopped_at` is set, so
 * this is computed from the two timestamps the row always carries; the server
 * snapshot is only a fallback for an unparsable timestamp. Null while running.
 */
export function stoppedRemaining(clock: {
  due_at: string | null;
  stopped_at: string | null;
  seconds_remaining: number | null;
}): number | null {
  if (!clock.stopped_at) return null;
  const stoppedMs = Date.parse(clock.stopped_at);
  if (Number.isFinite(stoppedMs)) {
    const fromTimestamps = secondsUntil(clock.due_at, stoppedMs);
    if (fromTimestamps !== null) return fromTimestamps;
  }
  return clock.seconds_remaining;
}

/** Human key for the informational sponsor deadlines, e.g. "fatal_or_life_threatening_7d". */
export function informationalLabel(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/\b(\d+)d\b/g, "$1-day")
    .replace(/^\w/, (c) => c.toUpperCase());
}
