/**
 * Fixtures shaped like CONTRACTS.md R4.4 responses. All participants synthetic.
 */
import type { Draft } from "../../../../lib/types";
import type { QueryDetail, QueryRow } from "../types";

export const USUBJID = "R2810-ONC-1624-P-004";
export const DRAFT_CM = "01JDRAFTCM0000000000000004";
export const ANSWER_EV = "01JANSWER00000000000000004";
export const NOTE_EV = "01JNOTE0000000000000000004";

export const OPEN_ROW: QueryRow = {
  id: "01JQUERY000000000000000001",
  check_id: "query.cm_required_fields",
  domain: "CM",
  draft_id: DRAFT_CM,
  usubjid: USUBJID,
  display_label: "P-004",
  field: "CMDOSE",
  text: "Dose, dose unit and indication are missing for prednisone. Please provide them.",
  severity: "data",
  status: "open",
  raised_by: "edit-check",
  raised_at: "2026-10-06T08:00:00.000Z",
  age_hours: 96,
};

export const SAFETY_ROW: QueryRow = {
  id: "01JQUERY000000000000000002",
  check_id: null,
  domain: "AE",
  draft_id: "01JDRAFTAE0000000000000007",
  usubjid: "R2810-ONC-1624-P-007",
  field: "AESER",
  text: "Was this event serious? No signed report is on file.",
  severity: "safety",
  status: "open",
  raised_by: "admin",
  raised_at: "2026-10-10T06:00:00.000Z",
  age_hours: 2,
};

export const ANSWERED_ROW: QueryRow = {
  id: "01JQUERY000000000000000003",
  check_id: "query.ae_end_before_start",
  domain: "AE",
  draft_id: "01JDRAFTAE0000000000000003",
  usubjid: "R2810-ONC-1624-P-003",
  display_label: "P-003",
  field: "AEENDTC",
  text: "End date is before the start date.",
  severity: "data",
  status: "answered",
  raised_by: "edit-check",
  raised_at: "2026-10-08T08:00:00.000Z",
  age_hours: 50,
  answer_text: "Corrected: the end date was mistyped.",
  answer_evidence: [ANSWER_EV],
  answered_by: "coordinator",
  answered_at: "2026-10-08T12:00:00.000Z",
};

export const CM_DRAFT: Draft = {
  id: DRAFT_CM,
  session_id: "01JSESSION0000000000000004",
  usubjid: USUBJID,
  domain: "CM",
  version: 1,
  status: "confirmed",
  fields: {
    STUDYID: "R2810-ONC-1624",
    USUBJID,
    CMTRT: "prednisone",
    CMDECOD: "prednisone",
    CMDOSE: null,
    CMDOSU: null,
    CMINDC: null,
    CMSTDTC: "2026-10-09",
  },
  evidence: {
    CMDOSE: [
      {
        kind: "gate_answer",
        id: ANSWER_EV,
        ts: "2026-10-09T22:10:00.000Z",
        note: "Participant typed: started prednisone",
      },
    ],
  },
  linked_ae_open_id: null,
  is_followup: false,
  created_by: "system",
  created_at: "2026-10-09T22:11:00.000Z",
  supersedes_id: null,
  note: null,
};

export const OPEN_DETAIL: QueryDetail = {
  ...OPEN_ROW,
  evidence: [
    {
      kind: "protocol",
      id: "protocol:7.7:p69",
      ts: null,
      note: "Protocol §7.7 p.69: dose, unit, frequency, indication, start date are required.",
    },
  ],
  suggested_answer: {
    kind: "query_answer",
    writer: "template",
    text: "The participant reported starting prednisone on 2026-10-09. The dose and indication were not reported; the site will ask at the next contact.",
    sentences: [
      {
        text: "The participant reported starting prednisone on 2026-10-09.",
        evidence_ids: [ANSWER_EV],
      },
      {
        text: "The dose and indication were not reported; the site will ask at the next contact.",
        evidence_ids: ["protocol:7.7:p69", NOTE_EV],
      },
    ],
  },
};

export const ANSWERED_DETAIL: QueryDetail = {
  ...ANSWERED_ROW,
  suggested_answer: null,
  draft: {
    ...CM_DRAFT,
    id: ANSWERED_ROW.draft_id,
    domain: "AE",
    fields: { AEDECOD: "Rash", AESTDTC: "2026-10-01", AEENDTC: "2026-10-05" },
    evidence: {
      AEENDTC: [{ kind: "pro_response", id: ANSWER_EV, ts: null, note: "Rash answer" }],
    },
  },
};

/** Evidence on the CM record's term field (CMTRT), not on the queried CMDOSE. */
export const CMTRT_EV = "01JGATECMTRT00000000000004";

/**
 * R4.5's seeded demo shape: an open missing-dose query whose suggestion cites
 * the record label (CMTRT evidence) as well as the check's protocol pointer.
 */
export const CM_DRAFT_WITH_TERM_EV: Draft = {
  ...CM_DRAFT,
  evidence: {
    ...CM_DRAFT.evidence,
    CMTRT: [
      {
        kind: "gate_answer",
        id: CMTRT_EV,
        ts: "2026-10-09T22:09:00.000Z",
        note: "Medication named by the participant: prednisone",
      },
    ],
  },
};

export const OPEN_DETAIL_CITES_TERM: QueryDetail = {
  ...OPEN_DETAIL,
  fields: ["CMDOSE", "CMDOSU", "CMDOSFRQ", "CMINDC"],
  draft: CM_DRAFT_WITH_TERM_EV,
  suggested_answer: {
    kind: "query_answer",
    writer: "template",
    text: "This is about prednisone. The dose was not reported.",
    sentences: [
      { text: "This is about prednisone.", evidence_ids: [CMTRT_EV] },
      { text: "The dose was not reported.", evidence_ids: ["protocol:7.7:p69"] },
    ],
  },
};

/** An AE record carrying investigator-only and Interim-computed fields. */
export const AE_DRAFT_7: Draft = {
  ...CM_DRAFT,
  id: SAFETY_ROW.draft_id,
  usubjid: SAFETY_ROW.usubjid,
  session_id: "01JSESSION0000000000000007",
  domain: "AE",
  status: "draft",
  fields: {
    STUDYID: "R2810-ONC-1624",
    USUBJID: SAFETY_ROW.usubjid,
    AESEQ: 1,
    AETERM: "Shortness of breath",
    AEDECOD: "Dyspnea",
    AESTDTC: "2026-10-09",
    AEENDTC: null,
    AEONGO: "Y",
    AETOXGR: 3,
    AESER: null,
    AEREL: null,
    AEACN: null,
    AEOUT: null,
    INTERIM_IRAE: null,
    INTERIM_TIER: 3,
    INTERIM_RULES_FIRED: ["red_flag.hospitalization"],
  },
  evidence: {},
};

export const SAFETY_DETAIL: QueryDetail = {
  ...SAFETY_ROW,
  suggested_answer: null,
  draft: AE_DRAFT_7,
};
