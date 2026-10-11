/**
 * Types for the sponsor-query endpoints (CONTRACTS.md R4.4, step 7 of the life
 * of a side effect). The API for these does not exist yet; the shapes below
 * follow the contract and are deliberately tolerant (optional extras the API
 * may add, such as `display_label`, `field_label`, `age_hours`, `draft`), so the
 * page renders with either the minimal or the enriched response.
 *
 * Integrator: fold these into `src/lib/types.ts` together with the wrappers in
 * `queriesApi.ts`.
 */
import type { Domain, Draft, Paginated } from "../../../lib/types";

export type QueryStatus = "open" | "answered" | "closed";

/** "data" = a record-keeping question; "safety" = touches a safety reporting duty. */
export type QuerySeverity = "data" | "safety";

/**
 * One evidence pointer. Wider than `lib/types` `Evidence` because queries can
 * cite chart notes (R2.4), protocol pages (R3.1) and other queries' answers.
 */
export interface QueryEvidence {
  kind: string;
  id: string;
  ts?: string | null;
  note?: string | null;
  span_start?: number;
  span_end?: number;
}

/** One sentence of generated text and the evidence ids it cites (CLAUDE.md §00.3). */
export interface WrittenSentence {
  text: string;
  evidence_ids: string[];
}

/** Output of the text writer (`interim_rules.narrative.WrittenText`). */
export interface WrittenText {
  kind: string;
  writer: "template" | "llm";
  sentences: WrittenSentence[];
  text: string;
  fallback_reason?: string | null;
  /**
   * Optional: the resolved pointers for every id the sentences cite. Asked of
   * the API stage so chips resolve even for evidence the page did not load.
   */
  evidence?: QueryEvidence[] | null;
}

/** A row of `GET /queries` (contract `Query` table + optional display extras). */
export interface QueryRow {
  id: string;
  /** Edit-check id ("query.*") or null for a manual query raised by a person. */
  check_id: string | null;
  domain: Domain;
  draft_id: string;
  usubjid: string;
  /** "P-007" when the API joins it; the page falls back to the USUBJID tail. */
  display_label?: string | null;
  /** SDTM variable name, e.g. "CMDOSE". */
  field: string;
  /**
   * Every field the edit check read, `field` first (QueryCandidate.fields),
   * e.g. all the missing CM details. Optional; the page falls back to `field`.
   */
  fields?: string[] | null;
  /** Plain label for `field` when the API sends one (R3.1 plain_language.json). */
  field_label?: string | null;
  text: string;
  severity: QuerySeverity;
  status: QueryStatus;
  /** "edit-check" or the user id of the person who raised it. */
  raised_by: string;
  raised_at: string;
  /** Hours since `raised_at`, computed by the API ("aging in hours"). */
  age_hours?: number | null;
  answer_text?: string | null;
  /** Evidence ids (or resolved pointers) attached to the answer. */
  answer_evidence?: Array<string | QueryEvidence> | null;
  answered_by?: string | null;
  answered_at?: string | null;
  closed_by?: string | null;
  closed_at?: string | null;
  /** Edit-check evidence (QueryCandidate.evidence) when the API includes it. */
  evidence?: QueryEvidence[] | null;
}

/** `GET /queries/{id}`: the row plus the template writer's suggested answer. */
export interface QueryDetail extends QueryRow {
  suggested_answer: WrittenText | null;
  /** Current draft (latest version) when the API embeds it; otherwise fetched. */
  draft?: Draft | null;
  /** Current value of `field` when the API resolves it. */
  current_value?: unknown;
}

export interface QueryCounts {
  open: number;
  answered: number;
  closed: number;
}

/** `GET /queries` page; `counts` is an optional convenience the API may add. */
export interface QueriesPage extends Paginated<QueryRow> {
  counts?: Partial<QueryCounts> | null;
}

export interface QueriesListQuery {
  status?: QueryStatus;
  usubjid?: string;
  limit?: number;
  offset?: number;
}

/** `POST /queries` (admin acting as the sponsor's monitor). */
export interface RaiseQueryRequest {
  draft_id: string;
  field: string;
  text: string;
  severity: QuerySeverity;
}

/** `POST /queries/{id}/answer` (coordinator, investigator or admin). */
export interface AnswerQueryRequest {
  answer_text: string;
  evidence_ids?: string[];
  /** Also correct the record: creates a new draft version (audited). */
  also_edit?: { field: string; value: unknown };
}
