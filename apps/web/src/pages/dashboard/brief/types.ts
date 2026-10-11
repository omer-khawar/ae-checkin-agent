/**
 * Types for the visit-prep brief (CLAUDE.md §00.4, CONTRACTS.md R3.2/R3.3).
 *
 * The contract shape is:
 *
 *   GET /participants/{usubjid}/brief?since=YYYY-MM-DD →
 *     { usubjid, display_label, since, generated_at,
 *       sections: [{ key, title, items: [{ text, evidence_ids, link }] }],
 *       narrative: WrittenText, questions_to_ask: [str] }
 *
 * Everything marked "optional extension" below is NOT in the contract yet. The
 * page renders correctly without it (it falls back to reading the item text),
 * but when the API sends these fields the page shows richer chips: grade trend
 * arrows, protocol flags, MEASURED/SIMULATED from the record rather than the
 * text, clock kinds and due times.
 *
 * Mapping from `packages/rules/interim_rules/narrative.py` facts. These are NOT
 * passed through blindly; the API should send each item as below:
 *
 *   every item     text (REQUIRED, plain language), evidence_ids, link
 *                  A row without text falls back to plain_label → event_label →
 *                  name; with none of those (NoteFact, VitalsFact) it is dropped.
 *   SideEffectFact grades[{grade, date, evidence_ids}]   (plain_label → text)
 *   ConMedFact     protocol_flag, protocol_section, printed_page,
 *                  exception_text, missing_fields       (name → text)
 *   EscalationFact tier, acknowledged                   (tier_name is not read:
 *                  the page names tiers itself via TierChip; reason belongs in text)
 *   ClockFact      kind (or clock_kind) "sae"|"aesi", due_at, status
 *                                                       (event_label → text)
 *   NoteFact       note_type                            (text required)
 *   VitalsFact     is_measured (send it; without it the page reads the text and
 *                  defaults to SIMULATED), source       (text required)
 *   date / note_date are NOT read as `ts`: send `ts` as an ISO-8601 UTC instant.
 *
 * Integrator: fold these into `src/lib/types.ts` when `getBrief` moves to api.ts.
 */

/** One provisional grade at one point in time (narrative.py GradePoint). */
export interface BriefGradePoint {
  grade: number;
  /** YYYY-MM-DD or ISO-8601 UTC. */
  date?: string | null;
  evidence_ids?: string[];
}

export type BriefProtocolFlag = "prohibited" | "discouraged" | "permitted";
export type BriefClockKind = "sae" | "aesi";

/** One line in a brief section. `text` is already plain language. */
export interface BriefItem {
  text: string;
  evidence_ids: string[];
  /**
   * In-app route ("/dashboard/checkins/…") or absolute http(s) URL; null when
   * none. Any other scheme (javascript:, data:, …) is shown as plain text.
   */
  link: string | null;

  // ---- optional extensions (not in the contract yet; see file header) ----
  /** Provisional grades, oldest first (new side effects). */
  grades?: BriefGradePoint[];
  /** Explicit trend when the API computes it itself. */
  trend?: "up" | "down" | "same" | "new" | null;
  /** Protocol status of a medication change (protocol_rules.json §7.7). */
  protocol_flag?: BriefProtocolFlag | null;
  protocol_section?: string | null;
  printed_page?: number | null;
  /** Verbatim protocol exception text for a discouraged medication. */
  exception_text?: string | null;
  /** CM fields the coordinator still has to ask for (SDTM names). */
  missing_fields?: string[];
  /** Escalation tier 0..3 (escalations section). */
  tier?: number | null;
  /** Escalations: whether the site acknowledged it (narrative.py EscalationFact). */
  acknowledged?: boolean | null;
  /** Reporting clock kind (clocks section). */
  clock_kind?: BriefClockKind | null;
  due_at?: string | null;
  status?: string | null;
  /** Vitals context: whether the values came from a real sensor. */
  is_measured?: boolean | null;
  source?: string | null;
  /** Notes section: "phone_call", "er_note", … */
  note_type?: string | null;
  /** Any timestamp worth showing next to the line. */
  ts?: string | null;
}

export interface BriefSection {
  /** Stable machine key, e.g. "new_side_effects", "med_changes", "vitals". */
  key: string;
  /** Plain-language heading from the API. */
  title: string;
  items: BriefItem[];
}

/** One generated sentence and the evidence ids it cites (narrative.py Sentence). */
export interface WrittenSentence {
  text: string;
  evidence_ids: string[];
  section?: string | null;
  template_id?: string | null;
}

/** CLAUDE.md §00.3: the generated-text contract. */
export interface WrittenText {
  kind: string;
  /**
   * "template" | "llm" from the contract; "unknown" when the API sent anything
   * else, so the page never mislabels who wrote the text.
   */
  writer: "template" | "llm" | "unknown";
  sentences: WrittenSentence[];
  text: string;
  fallback_reason?: string | null;
}

/** A "question to ask at the visit". The contract sends strings; objects are tolerated. */
export interface BriefQuestion {
  text: string;
  evidence_ids: string[];
  /** narrative.py QuestionKind: cm_missing_fields | unresolved_ae | unsigned_packet | other. */
  kind?: string | null;
}

/** Optional extension: what an evidence id points at, so a chip can name and link it. */
export interface BriefEvidenceRef {
  kind?: string | null;
  ts?: string | null;
  note?: string | null;
  link?: string | null;
}

/** The normalized brief the page renders. */
export interface Brief {
  usubjid: string;
  display_label: string;
  /** YYYY-MM-DD cut-off actually used by the API. */
  since: string | null;
  generated_at: string | null;
  sections: BriefSection[];
  narrative: WrittenText | null;
  questions_to_ask: BriefQuestion[];

  // ---- optional extensions ----
  /** One-line plain summary; derived on the page when absent. */
  summary?: string | null;
  /** YYYY-MM-DD of the next scheduled visit, if the API knows it. */
  next_visit?: string | null;
  /** Lookup for evidence chips, keyed by evidence id. */
  evidence?: Record<string, BriefEvidenceRef>;
}
