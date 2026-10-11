/**
 * Types for the CONTRACTS.md Revision 3 / Revision 4 additions that the
 * check-in detail, note detail, escalations and timeline pages render.
 *
 * `src/lib/types.ts` is owned by another wave, so the new shapes live here and
 * widen the shared ones. Every new field is optional: the pages must render
 * against both the R2 API (no protocol, no labels, no clock kind) and the R3/R4
 * API. Integrator: fold these into `src/lib/types.ts` and delete this file.
 */
import type {
  AttributionRequest,
  CheckInDetail,
  Evidence,
  IsoUtc,
  RuleFired,
  SAEClockRow,
  Ulid,
} from "../../../lib/types";

// ---------------------------------------------------------------------------
// Clocks (R3.2: SAEClock rows gain `kind`)
// ---------------------------------------------------------------------------

/** `sae` = suspected serious event; `aesi` = possible adverse event of special interest. */
export type ClockKind = "sae" | "aesi";

/**
 * A 24-hour report clock as any endpoint returns it. `session_id` is null for a
 * clock a chart note or phone call started (R2.4); `ae_draft_ids` / `has_ae_draft`
 * are optional hints a newer API may send so the page knows whether the
 * seriousness decision can go through an AE draft's attribution instead.
 */
export interface ClockRow extends Omit<SAEClockRow, "session_id"> {
  session_id: Ulid | null;
  note_id?: Ulid | null;
  kind?: ClockKind | string | null;
  overdue?: boolean;
  created_at?: IsoUtc | null;
  /** The report packet already opened for this clock, when the API joins it. */
  packet_id?: Ulid | null;
  ae_draft_ids?: Ulid[] | null;
  has_ae_draft?: boolean | null;
}

/** `PATCH /sae-clocks/{id}/stop` body (R4.3; investigator only). */
export interface StopClockRequest {
  /** e.g. "AESER = Y" or "AESER = N" (apps/api schemas.StopSaeClockRequest). */
  decision: string;
  note?: string;
}

// ---------------------------------------------------------------------------
// Packets (R3.2; only the bits these pages need)
// ---------------------------------------------------------------------------

/** `POST /packets {clock_id}` → the packet (created or existing). Only `id` is used here. */
export interface PacketRef {
  id: Ulid;
  clock_id?: Ulid;
  kind?: ClockKind | string;
  status?: "draft" | "signed" | string;
}

// ---------------------------------------------------------------------------
// Protocol assessment (R3.1 ProtocolAssessment, serialized by the rules package)
// ---------------------------------------------------------------------------

export interface ProtocolRef {
  section: string;
  printed_page: number;
}

export type ProtocolLevel = "prohibited" | "discouraged" | "permitted";

export interface ProtocolConMedFlag {
  level: ProtocolLevel | string;
  drug: string;
  matched_text?: string;
  matched_by?: string;
  protocol_ref?: ProtocolRef | null;
  /** The protocol sentence the classification rests on, verbatim. */
  quote?: string | null;
  /** For discouraged drugs: the protocol's exception wording, verbatim. */
  exception_text?: string | null;
  condition?: string | null;
  is_category?: boolean;
}

export interface ProtocolAssessment {
  protocol_id?: string;
  aesi_suspected?: boolean;
  aesi_items?: string[];
  aesi_reasons?: string[];
  conmed_flags?: ProtocolConMedFlag[];
  conmed_flag?: ProtocolLevel | string | null;
  conmed_notes?: string[];
  cm_missing_fields?: string[];
  tier_floor?: number;
  ae_reporting_window_end?: string | null;
  within_ae_reporting_window?: boolean | null;
  rules_fired?: RuleFired[];
}

// ---------------------------------------------------------------------------
// Check-in detail (R3.2 adds `protocol` and `labels`)
// ---------------------------------------------------------------------------

/** A rule row that may carry the API's own plain sentence (R3.1 plain_language.json). */
export interface RuleFiredPlain extends RuleFired {
  plain?: string | null;
  plain_sentence?: string | null;
}

export interface CheckInDetailR3 extends Omit<CheckInDetail, "sae_clock"> {
  sae_clock: ClockRow | null;
  /** R3.1: `CheckInResult.aesi_clock`, surfaced as a row when the API stores it. */
  aesi_clock?: ClockRow | null;
  /** Some builds return every clock of the session as one list. */
  clocks?: ClockRow[] | null;
  protocol?: ProtocolAssessment | null;
  /** SDTM variable → plain label (R3.2). */
  labels?: Record<string, string> | null;
  /** R3.2 kiosk: consent is covered by the enrollment ICF. */
  session: CheckInDetail["session"] & { consent_basis?: string | null };
}

// ---------------------------------------------------------------------------
// Attribution (R4.3 adds INTERIM_IRAE)
// ---------------------------------------------------------------------------

export type IraeValue = "Y" | "N";

export interface AttributionRequestR4 extends AttributionRequest {
  /** Investigator's immune-related assessment; null = not decided (protocol p. 91). */
  INTERIM_IRAE?: IraeValue | null;
}

// ---------------------------------------------------------------------------
// Phone calls (R4.1)
// ---------------------------------------------------------------------------

export type CallerKind = "participant" | "caregiver" | "other";
export type CallDirection = "inbound" | "outbound";

export const PHONE_CALL_NOTE_TYPE = "phone_call";

/** Evidence pointer as the R3/R4 endpoints may send it (adds `protocol`). */
export interface EvidenceR3 extends Omit<Evidence, "kind"> {
  kind: Evidence["kind"] | "chart_note" | "protocol" | string;
}
