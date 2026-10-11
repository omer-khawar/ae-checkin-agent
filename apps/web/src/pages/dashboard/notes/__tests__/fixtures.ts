/**
 * Fixtures shaped like the R2.4 payloads, built from sample note N3 so span
 * offsets are computed from the real text (never hand-typed).
 */
import { AUTH_STORAGE_KEY } from "../../../../lib/api";
import type { NoteIngestResponse, Paginated, Participant, ScanResult } from "../../../../lib/types";
import { SAMPLE_NOTES } from "../sampleNotes";

export const N3 = SAMPLE_NOTES.find((s) => s.id === "N3")!;
export const TEXT = N3.text;

export const STUDY_ID = "R2810-ONC-1624";
export const USUBJID_P003 = `${STUDY_ID}-P-003`;

export const PARTICIPANTS: Paginated<Participant> = {
  items: ["P-001", "P-003", "P-006"].map((label) => ({
    usubjid: `${STUDY_ID}-${label}`,
    study_id: STUDY_ID,
    enrolled_at: "2026-09-01T00:00:00.000Z",
    display_label: label,
  })),
  total: 3,
  limit: 100,
  offset: 0,
};

/** [start, end) of the first (or last) occurrence of `quote` in TEXT. */
export function span(quote: string, last = false): { span_start: number; span_end: number } {
  const i = last ? TEXT.lastIndexOf(quote) : TEXT.indexOf(quote);
  if (i < 0) throw new Error(`fixture quote not in text: ${quote}`);
  return { span_start: i, span_end: i + quote.length };
}

export const SCAN: ScanResult = {
  symptoms: [
    {
      term: "Dyspnea",
      quote: "SOB",
      ...span("SOB"),
      reason: "matched symptom pattern for Dyspnea",
      grade_hint: 2,
      grade_basis: "worsening cue 'increasing' -> provisional grade 2",
      onset_days: 7,
      worsening: true,
      excluded_reason: null,
    },
    {
      term: "Cough",
      quote: "Dry cough",
      ...span("Dry cough"),
      reason: "matched symptom pattern for Cough",
      grade_hint: null,
      grade_basis: "mentioned without a severity word",
      onset_days: 5,
      worsening: false,
      excluded_reason: null,
    },
  ],
  excluded_symptoms: [
    {
      term: "Cough",
      quote: "cough",
      ...span("cough", true),
      reason: "follows 'due to' (indication for holding lisinopril)",
      grade_hint: null,
      grade_basis: "",
      onset_days: null,
      worsening: false,
      excluded_reason: "indication",
    },
  ],
  meds: [
    {
      drug: "lisinopril",
      change: "stopped",
      quote: "Holding lisinopril",
      ...span("Holding lisinopril"),
      reason: "'holding' is a stop cue",
      excluded_reason: null,
    },
  ],
  excluded_meds: [],
  red_flags: [
    {
      level: "urgent",
      category: "dyspnea",
      quote: "increasing SOB",
      ...span("increasing SOB"),
      reason: "worsening shortness of breath",
    },
  ],
};

export const NOTE_ID = "01JNOTE0000000000000000003";
export const AE_DRAFT_ID = "01JDRAFTAE00000000000000001";
export const CM_DRAFT_ID = "01JDRAFTCM00000000000000001";

export const INGEST: NoteIngestResponse = {
  note: {
    id: NOTE_ID,
    usubjid: USUBJID_P003,
    display_label: "P-003",
    note_date: N3.note_date,
    author: N3.author,
    note_type: N3.note_type,
    text: TEXT,
    ingested_at: "2026-10-10T15:04:05.000Z",
    ingested_by: "coordinator",
    tier: 2,
  },
  scan: SCAN,
  drafts: [
    {
      id: AE_DRAFT_ID,
      session_id: "",
      usubjid: USUBJID_P003,
      domain: "AE",
      version: 1,
      status: "draft",
      fields: {
        STUDYID: STUDY_ID,
        USUBJID: USUBJID_P003,
        AESEQ: 1,
        AETERM: "SOB",
        AEDECOD: "Dyspnea",
        AESTDTC: "2026-10-02",
        AEENDTC: null,
        AEONGO: "Y",
        AETOXGR: 2,
        AESER: null,
        AEREL: null,
        INTERIM_SOURCE: "chart_note",
        INTERIM_TIER: 2,
        INTERIM_RULES_FIRED: ["chartscan.symptom", "chartscan.red_flag"],
      },
      evidence: {
        AETERM: [
          {
            kind: "chart_note",
            id: NOTE_ID,
            ts: "2026-10-10T15:04:05.000Z",
            note: "SOB",
            ...span("SOB"),
          },
        ],
        AETOXGR: [
          {
            kind: "chart_note",
            id: NOTE_ID,
            ts: "2026-10-10T15:04:05.000Z",
            note: "worsening cue 'increasing' -> provisional grade 2",
            ...span("increasing SOB"),
          },
        ],
        AESTDTC: [
          {
            kind: "rule",
            id: "chartscan.onset",
            ts: null,
            note: "note_date 2026-10-09 minus 7 days",
          },
        ],
      },
      linked_ae_open_id: null,
      is_followup: false,
      created_by: "coordinator",
      created_at: "2026-10-10T15:04:05.000Z",
      supersedes_id: null,
      note: null,
      note_id: NOTE_ID,
      source: "chart_note",
    },
    {
      id: CM_DRAFT_ID,
      session_id: "",
      usubjid: USUBJID_P003,
      domain: "CM",
      version: 1,
      status: "draft",
      fields: {
        STUDYID: STUDY_ID,
        USUBJID: USUBJID_P003,
        CMTRT: "Holding lisinopril",
        CMDECOD: "lisinopril",
        CMSTDTC: null,
        CMENDTC: "2026-10-09",
        INTERIM_SOURCE: "chart_note",
        INTERIM_DIRECTION: "stopped",
      },
      evidence: {
        CMTRT: [
          {
            kind: "chart_note",
            id: NOTE_ID,
            ts: "2026-10-10T15:04:05.000Z",
            note: "Holding lisinopril",
            ...span("Holding lisinopril"),
          },
        ],
      },
      linked_ae_open_id: null,
      is_followup: false,
      created_by: "coordinator",
      created_at: "2026-10-10T15:04:05.000Z",
      supersedes_id: null,
      note: null,
      note_id: NOTE_ID,
      source: "chart_note",
    },
  ],
  escalation: {
    id: "01JESC00000000000000000003",
    session_id: "",
    usubjid: USUBJID_P003,
    tier: 2,
    reasons: ["urgent red flag: dyspnea (worsening shortness of breath)"],
    paged_at: null,
    acked_by: null,
    acked_at: null,
    seconds_to_ack: null,
    note_id: NOTE_ID,
    source: "chart_note",
  },
  sae_clock: null,
  rules_fired: [
    {
      rule_id: "chartscan.red_flag",
      category: "red_flag",
      description: "Urgent red flag 'dyspnea' matched “increasing SOB”; escalation tier floor = 2.",
      inputs: { level: "urgent", category: "dyspnea" },
      effect: "tier floor = 2",
      evidence: [],
    },
  ],
  why: [
    "Symptom pattern for Dyspnea matched “SOB”; drafted AE (provisional G2 from 'increasing').",
    "Urgent red flag 'dyspnea' matched “increasing SOB”; escalation tier floor = 2.",
  ],
};

export const NOTES_PAGE = {
  items: [
    {
      ...INGEST.note,
      n_symptoms: 2,
      n_meds: 1,
      n_red_flags: 1,
      draft_counts: { AE: 1, VS: 0, CM: 1 },
    },
  ],
  total: 1,
  limit: 10,
  offset: 0,
};

export function signInAs(role: "coordinator" | "investigator" | "admin" = "coordinator") {
  sessionStorage.setItem(
    AUTH_STORAGE_KEY,
    JSON.stringify({
      token: "tok-test",
      role,
      display_name: "Test user",
      expires_at: "2099-01-01T00:00:00.000Z",
    }),
  );
}
