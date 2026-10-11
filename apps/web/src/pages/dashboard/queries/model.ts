/**
 * Pure helpers for the Queries page: plain-language labels, aging, evidence
 * resolution and the answer request. No React, no fetch; unit-tested in
 * `__tests__/model.test.ts`.
 *
 * Nothing here decides anything clinical. Which records get a query is decided
 * by the edit checks in `packages/rules/data/edit_checks.json` (server side);
 * this file only paints and packages what the API sends.
 */
import type {
  AnswerQueryRequest,
  Domain,
  Draft,
  QueryEvidence,
  QueryRow,
  QuerySeverity,
  QueryStatus,
  Role,
  WrittenText,
} from "../../../lib/types";
import { EDITABLE_FIELDS } from "../detail/model";

// ---------------------------------------------------------------------------
// Plain language (mirrors packages/rules/data/plain_language.json; the API's
// `field_label` wins whenever it is sent, so this is only the fallback)
// ---------------------------------------------------------------------------

export const DOMAIN_LABELS: Record<Domain, string> = {
  AE: "Side effect",
  VS: "Vital signs",
  CM: "Medication change",
};

/** SDTM variable → plain label, copied from plain_language.json `fields`. */
export const FIELD_LABELS: Record<string, string> = {
  STUDYID: "Study",
  USUBJID: "Participant",
  AESEQ: "Side-effect record number",
  AETERM: "Side effect, in the participant's or note's words",
  AEDECOD: "Side effect (standard term)",
  AESTDTC: "Started on",
  AEENDTC: "Ended on",
  AEONGO: "Still going on?",
  AETOXGR: "Severity grade (provisional)",
  AESER: "Serious? (investigator decides)",
  AEREL: "Related to the study drug? (investigator decides)",
  AEACN: "Change made to the study drug because of it",
  AEOUT: "Outcome",
  INTERIM_IRAE: "Immune-related? (investigator decides)",
  INTERIM_TIER: "Alert level",
  VSTESTCD: "Vital sign (short code)",
  VSTEST: "Vital sign",
  VSORRES: "Reading",
  VSORRESU: "Unit",
  VSDTC: "Measured at",
  VSMETHOD: "How it was measured (or simulated)",
  VSSTAT: "Reading not done",
  CMTRT: "Medication, as written",
  CMDECOD: "Medication (standard name)",
  CMDOSE: "Dose",
  CMDOSU: "Dose unit",
  CMDOSFRQ: "How often",
  CMINDC: "Taken for",
  CMROUTE: "How it is taken",
  CMSTDTC: "Started on",
  CMENDTC: "Stopped on",
  CMSTAT: "Not asked or not done",
  INTERIM_PROTOCOL_FLAG: "Study-protocol medication check",
  INTERIM_PROTOCOL_FLAGS: "Study-protocol medication checks",
  INTERIM_CM_MISSING_FIELDS: "Details still to collect",
};

export function fieldLabel(field: string, apiLabel?: string | null): string {
  if (apiLabel && apiLabel.trim()) return apiLabel;
  return FIELD_LABELS[field] ?? field;
}

export function domainLabel(domain: string): string {
  return (DOMAIN_LABELS as Record<string, string>)[domain] ?? domain;
}

/** Evidence kind → plain label (plain_language.json `evidence_kinds`). */
export const EVIDENCE_KIND_LABELS: Record<string, string> = {
  pro_response: "Participant's answer",
  gate_answer: "Participant's answer to a closing question",
  vitals_sample: "Vitals reading",
  rule: "Interim rule",
  table: "Reference table",
  chart_note: "Chart note",
  protocol: "Study protocol",
  draft: "Record",
  query: "Earlier query",
};

/** Plain fallback so an unexpected kind never shows a raw code as its label. */
export const UNKNOWN_EVIDENCE_LABEL = "Cited item";

export function evidenceKindLabel(kind: string): string {
  return EVIDENCE_KIND_LABELS[kind] ?? UNKNOWN_EVIDENCE_LABEL;
}

export const STATUS_LABELS: Record<QueryStatus, string> = {
  open: "Open",
  answered: "Answered",
  closed: "Closed",
};

export const SEVERITY_LABELS: Record<QuerySeverity, string> = {
  data: "Data",
  safety: "Safety",
};

export const SEVERITY_HELP: Record<QuerySeverity, string> = {
  data: "A record-keeping question: something missing or inconsistent in the entry.",
  safety: "Touches a safety reporting duty (for example a serious event without a signed report).",
};

/** "P-007" from the API, else the last two dash-separated parts of the USUBJID. */
export function participantLabel(row: Pick<QueryRow, "usubjid" | "display_label">): string {
  if (row.display_label) return row.display_label;
  const parts = row.usubjid.split("-");
  return parts.length >= 2 ? parts.slice(-2).join("-") : row.usubjid;
}

/** Who raised it, in words, plus the machine id to show one click deeper. */
export function raisedBy(row: Pick<QueryRow, "check_id" | "raised_by">): {
  label: string;
  code: string | null;
} {
  if (row.check_id) return { label: "Automatic data check", code: row.check_id };
  if (row.raised_by === "admin") return { label: "Sponsor monitor", code: "admin" };
  return { label: row.raised_by || "Unknown", code: null };
}

// ---------------------------------------------------------------------------
// Aging
// ---------------------------------------------------------------------------

/**
 * A query open longer than this is shown in red. This is a workflow service
 * level for the demo (sponsors commonly ask for answers within a few working
 * days), not a clinical threshold. Logged in docs/DECISIONS.md by the integrator.
 */
export const AGE_ALERT_HOURS = 72;

/**
 * Whole hours the query has been (or was) waiting, measured from `raised_at`
 * to the answer/close time, or to `nowMs` while still open, so a page left
 * open keeps aging on the minute clock. The API's `age_hours` (a snapshot
 * taken when the list loaded) is used only when `raised_at` does not parse.
 * Null when neither is usable.
 */
export function ageHours(row: QueryRow, nowMs: number): number | null {
  const start = Date.parse(row.raised_at);
  if (Number.isNaN(start)) {
    return typeof row.age_hours === "number" && Number.isFinite(row.age_hours)
      ? Math.max(0, Math.floor(row.age_hours))
      : null;
  }
  const endIso =
    row.status === "answered"
      ? row.answered_at
      : row.status === "closed"
        ? (row.answered_at ?? row.closed_at)
        : null;
  const end = endIso ? Date.parse(endIso) : nowMs;
  const endMs = Number.isNaN(end) ? nowMs : end;
  return Math.max(0, Math.floor((endMs - start) / 3_600_000));
}

/** Only open queries go red: an answered one is no longer waiting on the site. */
export function isAgeAlert(row: QueryRow, hours: number | null): boolean {
  return row.status === "open" && hours !== null && hours > AGE_ALERT_HOURS;
}

export function formatAge(hours: number | null): string {
  if (hours === null) return "—";
  if (hours < 1) return "< 1 h";
  return `${hours} h`;
}

// ---------------------------------------------------------------------------
// Record value + evidence
// ---------------------------------------------------------------------------

/** Display any field value; null/empty reads as "(empty)" so a missing value is visible. */
export function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "(empty)";
  if (Array.isArray(v)) return v.length ? v.map((x) => formatValue(x)).join(", ") : "(empty)";
  if (typeof v === "object") return JSON.stringify(v);
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return String(v);
}

/** Current value of the queried field: the API's resolved value, else the draft's. */
export function currentValue(
  detail: { field: string; current_value?: unknown },
  draft: Draft | null,
): unknown {
  if (detail.current_value !== undefined) return detail.current_value;
  return draft?.fields?.[detail.field];
}

/** One evidence row in the panel. `primary` rows are about the queried field. */
export interface IndexedEvidence extends QueryEvidence {
  /**
   * True for the queried field's own evidence, the edit check's evidence and
   * the answer's resolved pointers; false for evidence on the record's other
   * fields (shown under "More evidence on this record").
   */
  primary: boolean;
}

function isPointer(e: unknown): e is QueryEvidence {
  return typeof e === "object" && e !== null && typeof (e as QueryEvidence).id === "string";
}

/**
 * Every evidence pointer the panel knows about, de-duplicated by id, in this
 * order:
 *   1. the queried field's evidence on the draft,
 *   2. the edit check's own evidence,
 *   3. resolved pointers attached to the answer,
 *   (primary rows, shown by default)
 *   4. pointers the API resolved for the suggested answer, if it sends them,
 *   5. the evidence on every other field of the draft, field by field,
 *   6. anything else in the API's top-level `evidence_index` map.
 *   (secondary rows, behind a disclosure)
 *
 * The template writer cites more than the queried field (the record's term
 * field, every field the check read, extra facts), so chips must resolve
 * against the whole record. Bare answer ids are never added as rows of their
 * own: they resolve against the draft's evidence, and an id found nowhere
 * shows the chip's "Not found" state instead of an invented "unknown" row.
 */
export function evidenceIndex(
  detail: Pick<QueryRow, "field" | "evidence" | "answer_evidence"> & {
    suggested_answer?: WrittenText | null;
    evidence_index?: Record<string, unknown> | null;
  },
  draft: Draft | null,
): IndexedEvidence[] {
  const out: IndexedEvidence[] = [];
  const seen = new Set<string>();
  const add = (e: unknown, primary: boolean) => {
    if (!isPointer(e) || seen.has(e.id)) return;
    seen.add(e.id);
    out.push({ ...e, kind: typeof e.kind === "string" ? e.kind : "", primary });
  };
  const draftEvidence = (draft?.evidence ?? {}) as unknown as Record<string, unknown>;
  const fieldEv = (name: string): unknown[] => {
    const v = draftEvidence[name];
    return Array.isArray(v) ? v : [];
  };

  fieldEv(detail.field).forEach((e) => add(e, true));
  (detail.evidence ?? []).forEach((e) => add(e, true));
  (detail.answer_evidence ?? []).forEach((e) => {
    if (typeof e !== "string") add(e, true);
  });
  (detail.suggested_answer?.evidence ?? []).forEach((e) => add(e, false));
  for (const name of Object.keys(draftEvidence)) {
    if (name !== detail.field) fieldEv(name).forEach((e) => add(e, false));
  }
  const index = detail.evidence_index;
  if (index && typeof index === "object" && !Array.isArray(index)) {
    for (const [id, e] of Object.entries(index)) {
      // Older payloads may omit the id inside the pointer; the key is the id.
      if (typeof e === "object" && e !== null) add({ ...(e as object), id }, false);
    }
  }
  return out;
}

/** All distinct evidence ids cited by a written text, in sentence order. */
export function writtenEvidenceIds(w: WrittenText | null | undefined): string[] {
  if (!w) return [];
  const out: string[] = [];
  for (const s of w.sentences ?? []) {
    for (const id of s.evidence_ids ?? []) if (!out.includes(id)) out.push(id);
  }
  return out;
}

export function writerLabel(w: Pick<WrittenText, "writer">): string {
  return w.writer === "llm" ? "Written by Claude" : "Written by template";
}

/** Short, stable rendering of a ULID-ish id for chips ("…7K3Q"). */
export function shortId(id: string): string {
  return id.length > 10 ? `…${id.slice(-6)}` : id;
}

// ---------------------------------------------------------------------------
// Answer request
// ---------------------------------------------------------------------------

export interface AnswerFormState {
  text: string;
  /** Attach the evidence ids the suggestion cites. */
  citeSuggestion: boolean;
  alsoEdit: boolean;
  editField: string;
  editValue: string;
}

/**
 * Keep the field's type when correcting it: a number stays a number if the new
 * text parses as one; everything else is sent as typed text. An empty box
 * clears the field (null).
 */
export function coerceValue(raw: string, previous: unknown): unknown {
  const t = raw.trim();
  if (t === "") return null;
  if (typeof previous === "number" && /^[-+]?\d+(\.\d+)?$/.test(t)) return Number(t);
  return t;
}

export type AnswerBuild = { ok: true; body: AnswerQueryRequest } | { ok: false; error: string };

/** Validate the answer form and build `POST /queries/{id}/answer`'s body. */
export function buildAnswer(
  form: AnswerFormState,
  suggestion: WrittenText | null,
  draft: Draft | null,
): AnswerBuild {
  const text = form.text.trim();
  if (!text) return { ok: false, error: "Write an answer before sending it." };
  const body: AnswerQueryRequest = { answer_text: text };
  const ids = form.citeSuggestion ? writtenEvidenceIds(suggestion) : [];
  if (ids.length) body.evidence_ids = ids;
  if (form.alsoEdit) {
    if (!form.editField) return { ok: false, error: "Pick the field to correct." };
    body.also_edit = {
      field: form.editField,
      value: coerceValue(form.editValue, draft?.fields?.[form.editField]),
    };
  }
  return { ok: true, body };
}

// ---------------------------------------------------------------------------
// Which fields "Also correct the field" may touch
// ---------------------------------------------------------------------------

/**
 * Only an investigator decides these (CLAUDE.md §3.1, R4.3), and only through
 * the attribution box on the check-in, which stops the 24-hour clock and is
 * audited as `draft.attribution`. They are never offered in `also_edit`, not
 * even to an investigator, because `also_edit` is an ordinary edit.
 */
export const INVESTIGATOR_ONLY_FIELDS: readonly string[] = ["AESER", "AEREL", "INTERIM_IRAE"];

/**
 * R3.1 `cm_required_fields` that the base CM edit list lacks. Offered when
 * the draft carries the key (even as null) or the query covers the field (the
 * API accepts a covered field as new); otherwise the API answers 422.
 */
export const CM_DETAIL_FIELDS: readonly string[] = ["CMDOSE", "CMDOSU", "CMDOSFRQ", "CMINDC"];

/**
 * Fields a person may correct from the query panel: the same list the
 * check-in page lets a coordinator edit (`EDITABLE_FIELDS` in
 * detail/model.ts) plus the R3.1 CM details when present on the draft. Never
 * identity, provenance or Interim-computed fields (INTERIM_*, AESEQ), never
 * CMTRT (kept verbatim by design), never the investigator-only fields. The
 * queried field comes first when it is allowed.
 *
 * With no draft loaded the base list is offered as-is (those fields exist on
 * every draft of the domain); the CM details need the draft to confirm them.
 */
export function editableFields(
  draft: Draft | null,
  domain: Domain,
  queried: string,
  covered: readonly string[] = [],
): string[] {
  const base = (EDITABLE_FIELDS as Record<string, string[] | undefined>)[domain] ?? [];
  const keys = draft ? new Set(Object.keys(draft.fields ?? {})) : null;
  // The API lets an answer fill in a field the query itself covers even when the
  // record has no key for it yet (`allow_new_fields` in services/queries.py), so
  // a "dose is missing" query can be answered by entering the dose.
  const coveredSet = new Set(covered);
  const allowed = base.filter((f) => keys === null || keys.has(f) || coveredSet.has(f));
  if (domain === "CM" && keys) {
    for (const f of CM_DETAIL_FIELDS) {
      if ((keys.has(f) || coveredSet.has(f)) && !allowed.includes(f)) allowed.push(f);
    }
  }
  const safe = allowed.filter((f) => !INVESTIGATOR_ONLY_FIELDS.includes(f));
  return safe.includes(queried) ? [queried, ...safe.filter((f) => f !== queried)] : safe;
}

/** Why the queried field itself cannot be corrected here (null = it can). */
export interface FieldBlock {
  kind: "investigator" | "not_on_record" | "not_editable";
  message: string;
}

export function queriedFieldBlock(
  draft: Draft | null,
  domain: Domain,
  queried: string,
  role: Role | null,
  covered: readonly string[] = [],
): FieldBlock | null {
  if (!queried) return null;
  if (INVESTIGATOR_ONLY_FIELDS.includes(queried)) {
    return {
      kind: "investigator",
      message:
        role === "investigator"
          ? "Record this decision in the investigator box on the check-in: that path stops the 24-hour clock and is audited as your decision. It is not changed from a query answer."
          : "An investigator records this, in the investigator box on the check-in. It cannot be changed from a query answer.",
    };
  }
  if (editableFields(draft, domain, queried, covered).includes(queried)) return null;
  if (draft && !(queried in (draft.fields ?? {}))) {
    return {
      kind: "not_on_record",
      message:
        "This record has no place for that detail yet, so it cannot be filled in from here. Answer in words; the site adds it when the record is updated.",
    };
  }
  return {
    kind: "not_editable",
    message:
      "This field is filled in by Interim or kept exactly as written, so it is not corrected from here.",
  };
}

/**
 * Every field the query covers, queried field first: the API's `fields`
 * (the edit check's list) when it sends one, else just the queried field.
 */
export function queryFields(detail: Pick<QueryRow, "field" | "fields">): string[] {
  const out: string[] = [];
  for (const f of [detail.field, ...(detail.fields ?? [])]) {
    if (typeof f === "string" && f && !out.includes(f)) out.push(f);
  }
  return out;
}
