/**
 * Types for the serious-event packet page (CONTRACTS.md R3.2 "Packets" and
 * R4.2 "Follow-up reports").
 *
 * The API for these endpoints is built in parallel (stage 2), so these types
 * are written against the contract and read defensively: fields the contract
 * names are required here, while a few helpful extras the page can use when the
 * API sends them (participant label, deadline, version, measured/simulated on
 * vitals evidence) are optional. `model.ts#normalizePacket` turns any response
 * into this shape so a missing optional key never crashes the page.
 *
 * Integrator: fold these into `src/lib/types.ts` once the API ships.
 */
import type { IsoUtc, Ulid } from "../../../lib/types";

/** `sae` = serious adverse event, `aesi` = adverse event of special interest. */
export type PacketKind = "sae" | "aesi";

export type PacketStatus = "draft" | "signed";

/**
 * One evidence pointer. Superset of `lib/types#Evidence`: the kind union is
 * open (the API may add kinds such as `chart_note` or `phone_call`), and the
 * optional `quote` / spans / `is_measured` are shown when present.
 */
export interface PacketEvidence {
  kind: string;
  id: string;
  ts: IsoUtc | null;
  note: string;
  /** Verbatim words from the source (chart note, call summary, answer text). */
  quote?: string | null;
  span_start?: number | null;
  span_end?: number | null;
  /** Vitals only: whether the sample came from a real sensor or a simulation. */
  is_measured?: boolean | null;
  /** Where the evidence lives, when the API can say (check-in session or note). */
  session_id?: Ulid | null;
  note_id?: Ulid | null;
}

/** A field value as the API sends it; displayed through `formatValue`. */
export type PacketValue = string | number | boolean | null | Array<string | number>;

export interface PacketField {
  /** SDTM variable or SAE-form field name, e.g. `AETERM`, `SAE_ONSET_DATE`. */
  name: string;
  /** Plain-language label shown first ("Side effect", "Started on"). */
  plain_label: string;
  value: PacketValue;
  evidence: PacketEvidence[];
  /** True when a person changed the pre-filled value (time-saved model). */
  edited?: boolean;
  /** Present for vitals fields; the page then shows MEASURED / SIMULATED. */
  is_measured?: boolean | null;
}

/** One sentence of generated text (interim_rules.narrative `Sentence`). */
export interface NarrativeSentence {
  text: string;
  evidence_ids: string[];
  section?: string;
  template_id?: string;
}

/** interim_rules.narrative `WrittenText` (CLAUDE.md §00.3). */
export interface WrittenText {
  kind: string;
  writer: "template" | "llm";
  sentences: NarrativeSentence[];
  text: string;
  fallback_reason?: string | null;
}

/** R4.2: one difference between this follow-up and the report before it. */
export interface PacketChange {
  field: string;
  plain_label?: string;
  before: PacketValue;
  after: PacketValue;
  evidence: PacketEvidence[];
}

export interface Packet {
  id: Ulid;
  clock_id: Ulid;
  kind: PacketKind;
  usubjid: string;
  status: PacketStatus;
  fields: PacketField[];
  missing_information: string[];
  narrative: WrittenText;
  created_at: IsoUtc | null;
  signed_by: string | null;
  signed_at: IsoUtc | null;
  /** R4.2: 0 = initial report, 1..n = follow-ups. */
  sequence: number;
  parent_packet_id: Ulid | null;
  /** R4.2: present on follow-ups (empty list on the initial report). */
  changes_since_previous: PacketChange[];

  // ---- Optional extras the page uses when the API sends them -------------
  display_label?: string | null;
  /** Packet version (PATCH creates a new one). */
  version?: number | null;
  /** 24-hour deadline; when absent the page reads the clock from /sae-clocks. */
  due_at?: IsoUtc | null;
  site_awareness_at?: IsoUtc | null;
  clock_stopped_at?: IsoUtc | null;
  /** Narrative text as a person last saved it, when it differs from the draft. */
  narrative_edited?: { text: string; edited_by: string | null; edited_at: IsoUtc | null } | null;
  /** Extra evidence the narrative cites that is not on any field. */
  evidence_index?: Record<string, PacketEvidence> | PacketEvidence[] | null;
  /** Ids of follow-up reports already started from this one. */
  followup_packet_ids?: Ulid[] | null;
  /** Mock-EDC acknowledgment id after signing. */
  mock_edc_ack_id?: string | null;
}

/** Body of `PATCH /packets/{id}` (versioned, audited). */
export interface PatchPacketRequest {
  /** Field name → new value. Only changed fields are sent. */
  fields?: Record<string, PacketValue>;
  /** The investigator's edited narrative text. */
  narrative_text?: string;
  note?: string;
}

/** Clock row as `GET /sae-clocks` returns it (R3.2 adds `kind`). */
export interface PacketClock {
  id: Ulid;
  kind?: PacketKind;
  usubjid?: string;
  site_awareness_at: IsoUtc | null;
  due_at: IsoUtc | null;
  stopped_at: IsoUtc | null;
  decision: string | null;
}

/** The deadline the header counts down to, wherever it came from. */
export interface PacketDeadline {
  siteAwarenessAt: IsoUtc | null;
  dueAt: IsoUtc | null;
  stoppedAt: IsoUtc | null;
  decision: string | null;
}
