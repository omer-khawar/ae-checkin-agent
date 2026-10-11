/**
 * A CheckInDetail shaped exactly like CONTRACTS.md §2.2 for the demo persona
 * (P-007, moderate dyspnea, mild cough, started loratadine, simulated vitals).
 */
import type { CheckInDetail, Draft, Evidence, RuleFired } from "../../../../lib/types";

export const SESSION_ID = "01JDETAILSESSION0000000001";
export const A_SOB_SEV = "01JANSWERSOBSEV00000000001";
export const A_SOB_INT = "01JANSWERSOBINT00000000002";
export const A_COUGH_SEV = "01JANSWERCOUGHSEV000000003";
export const A_HOSP = "01JANSWERGATEHOSP000000004";
export const A_CONMED = "01JANSWERGATECONMED0000005";
export const A_CONMED_TEXT = "01JANSWERGATECMTEXT0000006";
export const A_OTHER = "01JANSWERGATEOTHER00000007";
export const S1 = "01JSAMPLE00000000000000001";
export const S2 = "01JSAMPLE00000000000000002";
export const AE_DRAFT = "01JDRAFTAE0000000000000001";
export const AE_DRAFT_COUGH = "01JDRAFTAE0000000000000002";
export const VS_DRAFT = "01JDRAFTVS0000000000000001";
export const CM_DRAFT = "01JDRAFTCM0000000000000001";
export const ESCALATION_ID = "01JESCALATION00000000000001";

const ev = (
  kind: Evidence["kind"],
  id: string,
  note: string,
  ts: string | null = null,
): Evidence => ({ kind, id, ts, note });

const sobSev = ev(
  "pro_response",
  A_SOB_SEV,
  "shortness_of_breath.severity = 2 (Moderate)",
  "2026-10-10T18:01:00.000Z",
);
const sobInt = ev(
  "pro_response",
  A_SOB_INT,
  "shortness_of_breath.interference = 2 (Somewhat)",
  "2026-10-10T18:01:10.000Z",
);
const coughSev = ev(
  "pro_response",
  A_COUGH_SEV,
  "cough.severity = 1 (Mild)",
  "2026-10-10T18:01:20.000Z",
);
const gradeRule = ev(
  "rule",
  "grade.provisional.shortness_of_breath",
  "provisional; grade from participant answers only",
);
const tierRule = ev("rule", "tier.final", "final tier");
const sample1 = ev("vitals_sample", S1, "pulse 72 (conf 0.90)", "2026-10-10T18:00:30.000Z");
const sample2 = ev("vitals_sample", S2, "pulse 74 (conf 0.92)", "2026-10-10T18:00:31.000Z");

export const RULES: RuleFired[] = [
  {
    rule_id: "score.composite.shortness_of_breath",
    category: "scoring",
    description:
      "Shortness of breath: severity 2, interference 2 -> composite 2 (Basch 2021 table)",
    inputs: { severity: 2, interference: 2, composite: 2 },
    effect: "composite = 2",
    evidence: [sobSev, sobInt],
  },
  {
    rule_id: "grade.provisional.shortness_of_breath",
    category: "grading",
    description:
      "Shortness of breath (Dyspnea): composite 2 -> provisional CTCAE grade 2 (investigator to confirm)",
    inputs: { composite: 2, grade: 2 },
    effect: "AETOXGR = 2",
    evidence: [sobSev, sobInt],
  },
  {
    rule_id: "vitals.simulated_ignored",
    category: "vitals_quality",
    description:
      "Vitals: all usable samples are SIMULATED (mock) and 'treat simulated as measured' is OFF",
    inputs: { source: "mock", n: 2 },
    effect: "not eligible for corroboration",
    evidence: [sample1, sample2],
  },
  {
    rule_id: "tier.base",
    category: "escalation",
    description: "Base tier 1 from highest provisional grade 2",
    inputs: { max_grade: 2, base_tier: 1 },
    effect: "tier = 1",
    evidence: [gradeRule],
  },
  {
    rule_id: "tier.final",
    category: "escalation",
    description:
      "Final escalation tier 1 (Coordinator review): Coordinator reviews within 1 business day.",
    inputs: { tier: 1 },
    effect: "tier = 1",
    evidence: [],
  },
  {
    rule_id: "conmed.exact",
    category: "conmed",
    description: "Con-med 'loratadine' matched exactly to 'loratadine' (confidence 1.0)",
    inputs: { verbatim: "loratadine", matched_name: "loratadine", confidence: 1 },
    effect: "CMDECOD = loratadine",
    evidence: [ev("gate_answer", A_CONMED_TEXT, "conmed_text = 'loratadine'")],
  },
];

export const AE: Draft = {
  id: AE_DRAFT,
  session_id: SESSION_ID,
  usubjid: "R2810-ONC-1624-P-007",
  domain: "AE",
  version: 1,
  status: "draft",
  fields: {
    STUDYID: "R2810-ONC-1624",
    USUBJID: "R2810-ONC-1624-P-007",
    AESEQ: 1,
    AETERM: "Shortness of breath",
    AEDECOD: "Dyspnea",
    AESTDTC: "2026-10-10T18:01:00.000Z",
    AEENDTC: null,
    AEONGO: "Y",
    AETOXGR: 2,
    AESER: null,
    AEREL: null,
    AEACN: null,
    AEOUT: null,
    INTERIM_TIER: 1,
    INTERIM_RULES_FIRED: ["grade.provisional.shortness_of_breath", "tier.base", "tier.final"],
    INTERIM_PROVISIONAL: true,
    INTERIM_FOLLOWUP_OF: null,
    INTERIM_SOURCE: "check_in",
  },
  evidence: {
    AETERM: [sobSev, sobInt],
    AEDECOD: [
      sobSev,
      sobInt,
      ev(
        "table",
        "ctcae_terms.json",
        "shortness_of_breath -> Dyspnea (CTCAE v5.0; mock MedDRA code MOCK-0001)",
      ),
    ],
    AESTDTC: [sobSev, sobInt],
    AETOXGR: [gradeRule, sobSev, sobInt],
    INTERIM_TIER: [tierRule],
  },
  linked_ae_open_id: null,
  is_followup: false,
  created_by: "system",
  created_at: "2026-10-10T18:05:00.000Z",
  supersedes_id: null,
  note: null,
};

export const AE_COUGH: Draft = {
  ...AE,
  id: AE_DRAFT_COUGH,
  fields: {
    ...AE.fields,
    AESEQ: 2,
    AETERM: "Cough",
    AEDECOD: "Cough",
    AETOXGR: 1,
    INTERIM_FOLLOWUP_OF: "01JAEOPEN000000000000000001",
  },
  evidence: { AETERM: [coughSev], AETOXGR: [coughSev] },
  linked_ae_open_id: "01JAEOPEN000000000000000001",
  is_followup: true,
};

export const VS: Draft = {
  id: VS_DRAFT,
  session_id: SESSION_ID,
  usubjid: "R2810-ONC-1624-P-007",
  domain: "VS",
  version: 1,
  status: "draft",
  fields: {
    STUDYID: "R2810-ONC-1624",
    USUBJID: "R2810-ONC-1624-P-007",
    VSTESTCD: "PULSE",
    VSTEST: "Pulse Rate",
    VSORRES: 73,
    VSORRESU: "beats/min",
    VSDTC: "2026-10-10T18:00:31.000Z",
    VSMETHOD: "Simulated",
    VSSTAT: null,
    INTERIM_CONFIDENCE: 0.91,
    INTERIM_SOURCE: "mock",
    INTERIM_N_SAMPLES: 2,
    INTERIM_IS_MEASURED: false,
  },
  evidence: { VSORRES: [sample1, sample2], VSDTC: [sample2] },
  linked_ae_open_id: null,
  is_followup: false,
  created_by: "system",
  created_at: "2026-10-10T18:05:00.000Z",
  supersedes_id: null,
  note: null,
};

export const CM: Draft = {
  id: CM_DRAFT,
  session_id: SESSION_ID,
  usubjid: "R2810-ONC-1624-P-007",
  domain: "CM",
  version: 1,
  status: "draft",
  fields: {
    STUDYID: "R2810-ONC-1624",
    USUBJID: "R2810-ONC-1624-P-007",
    CMTRT: "loratadine",
    CMDECOD: "loratadine",
    CMSTDTC: "2026-10-10",
    CMENDTC: null,
    CMSTAT: null,
    INTERIM_MATCH_CONFIDENCE: 1,
    INTERIM_MATCH_KIND: "exact",
    INTERIM_SOURCE: "check_in",
  },
  evidence: {
    CMTRT: [ev("gate_answer", A_CONMED_TEXT, "conmed_text = 'loratadine'")],
    CMDECOD: [ev("rule", "conmed.exact", "exact match")],
  },
  linked_ae_open_id: null,
  is_followup: false,
  created_by: "system",
  created_at: "2026-10-10T18:05:00.000Z",
  supersedes_id: null,
  note: null,
};

export function detail(overrides: Partial<CheckInDetail> = {}): CheckInDetail {
  const evidence_index: Record<string, Evidence> = {};
  for (const e of [sobSev, sobInt, coughSev, gradeRule, tierRule, sample1, sample2])
    evidence_index[e.id] = e;
  return {
    session: {
      id: SESSION_ID,
      usubjid: "R2810-ONC-1624-P-007",
      study_id: "R2810-ONC-1624",
      started_at: "2026-10-10T18:00:00.000Z",
      completed_at: "2026-10-10T18:05:00.000Z",
      consent_camera: true,
      vitals_status: "simulated_ignored",
      tier: 1,
      stop_screen_shown: false,
      is_eval: false,
    },
    participant: {
      usubjid: "R2810-ONC-1624-P-007",
      study_id: "R2810-ONC-1624",
      enrolled_at: "2026-08-01T00:00:00.000Z",
      display_label: "P-007",
    },
    answers: [
      {
        id: A_SOB_SEV,
        session_id: SESSION_ID,
        item_id: "shortness_of_breath",
        attribute: "severity",
        value_int: 2,
        value_text: null,
        ts_client: "2026-10-10T18:01:00.000Z",
        ts_server: "2026-10-10T18:01:00.100Z",
      },
      {
        id: A_SOB_INT,
        session_id: SESSION_ID,
        item_id: "shortness_of_breath",
        attribute: "interference",
        value_int: 2,
        value_text: null,
        ts_client: "2026-10-10T18:01:10.000Z",
        ts_server: "2026-10-10T18:01:10.100Z",
      },
      {
        id: A_COUGH_SEV,
        session_id: SESSION_ID,
        item_id: "cough",
        attribute: "severity",
        value_int: 1,
        value_text: null,
        ts_client: "2026-10-10T18:01:20.000Z",
        ts_server: "2026-10-10T18:01:20.100Z",
      },
      {
        id: A_HOSP,
        session_id: SESSION_ID,
        item_id: "gate_hospitalization",
        attribute: "gate",
        value_int: 0,
        value_text: null,
        ts_client: "2026-10-10T18:04:00.000Z",
        ts_server: "2026-10-10T18:04:00.100Z",
      },
      {
        id: A_CONMED,
        session_id: SESSION_ID,
        item_id: "gate_conmed",
        attribute: "gate",
        value_int: 1,
        value_text: null,
        ts_client: "2026-10-10T18:04:10.000Z",
        ts_server: "2026-10-10T18:04:10.100Z",
      },
      {
        id: A_CONMED_TEXT,
        session_id: SESSION_ID,
        item_id: "gate_conmed_text",
        attribute: "gate",
        value_int: null,
        value_text: "loratadine",
        ts_client: "2026-10-10T18:04:10.000Z",
        ts_server: "2026-10-10T18:04:10.200Z",
      },
      {
        id: A_OTHER,
        session_id: SESSION_ID,
        item_id: "gate_other",
        attribute: "gate",
        value_int: null,
        value_text: "Felt winded on the stairs.",
        ts_client: "2026-10-10T18:04:30.000Z",
        ts_server: "2026-10-10T18:04:30.100Z",
      },
    ],
    vitals: {
      samples: [
        {
          id: S1,
          session_id: SESSION_ID,
          ts_utc: "2026-10-10T18:00:30.000Z",
          source: "mock",
          is_measured: false,
          pulse_bpm: 72,
          pulse_conf: 0.9,
          breathing_bpm: 14,
          breathing_conf: 0.85,
          hrv_rmssd_ms: null,
          hrv_conf: null,
          window_s: 30,
          quality_flags: [],
        },
        {
          id: S2,
          session_id: SESSION_ID,
          ts_utc: "2026-10-10T18:00:31.000Z",
          source: "mock",
          is_measured: false,
          pulse_bpm: 74,
          pulse_conf: 0.92,
          breathing_bpm: 14,
          breathing_conf: 0.86,
          hrv_rmssd_ms: null,
          hrv_conf: null,
          window_s: 30,
          quality_flags: ["gate_pending_hrv"],
        },
      ],
      summary: {
        n_samples: 2,
        n_eligible: 2,
        pulse_median: 73,
        pulse_max: 74,
        breathing_median: 14,
        breathing_max: 14,
        hrv_median: null,
        is_measured: false,
        source: "mock",
        first_ts: "2026-10-10T18:00:30.000Z",
        last_ts: "2026-10-10T18:00:31.000Z",
      },
      status: "simulated_ignored",
    },
    result: {
      items: [
        {
          item_id: "shortness_of_breath",
          label: "Shortness of breath",
          aedecod: "Dyspnea",
          composite: 2,
          provisional_grade: 2,
          responses: [],
          evidence: [sobSev, sobInt],
        },
        {
          item_id: "cough",
          label: "Cough",
          aedecod: "Cough",
          composite: 1,
          provisional_grade: 1,
          responses: [],
          evidence: [coughSev],
        },
      ],
      max_grade: 2,
      base_tier: 1,
      red_flag_tier_floor: 0,
      corroboration_bump: 0,
      escalation_tier: 1,
      stop_screen: false,
      page_oncall: false,
      seriousness_suspected: false,
      sae_clock: null,
      conmed: {
        verbatim: "loratadine",
        matched_name: "loratadine",
        match_kind: "exact",
        confidence: 1,
        distance: 0,
        candidates: [["loratadine", 0]],
      },
      vitals: {
        status: "simulated_ignored",
        eligible_sample_ids: [S1, S2],
        ignored: [],
        summary: null,
        rules_fired: [],
      },
      drafts: [],
      rules_fired: RULES,
      why: RULES.map((r) => r.description),
    },
    drafts: [AE, AE_COUGH, VS, CM],
    escalation: null,
    sae_clock: null,
    ae_links: [
      {
        draft_id: AE_DRAFT_COUGH,
        ae_open_id: "01JAEOPEN000000000000000001",
        first_session_id: "01JPRIORSESSION000000000001",
      },
    ],
    rules_fired: RULES,
    why: RULES.map((r) => r.description),
    evidence_index,
    ...overrides,
  };
}

/**
 * Rules the engine legitimately fires more than once per check-in: one
 * `draft.ae` per AE draft, one `vitals.implausible` per offending sample. Each
 * occurrence has its own inputs and evidence, so the Why panel must list all
 * of them (finding: de-duplicating by rule_id hid the cough AE's drafting rule).
 */
export const S3 = "01JSAMPLE00000000000000003";
export const S4 = "01JSAMPLE00000000000000004";
export const REPEATED_RULES: RuleFired[] = [
  {
    rule_id: "vitals.implausible",
    category: "vitals_quality",
    description: "Sample pulse 190 bpm is outside physiological plausibility (35-180); ignored",
    inputs: { sample_id: S3, pulse_bpm: 190 },
    effect: "sample ignored for rules",
    evidence: [ev("vitals_sample", S3, "pulse 190 (conf 0.90)", "2026-10-10T18:00:32.000Z")],
  },
  {
    rule_id: "vitals.implausible",
    category: "vitals_quality",
    description: "Sample breathing 48/min is outside physiological plausibility (5-45); ignored",
    inputs: { sample_id: S4, breathing_bpm: 48 },
    effect: "sample ignored for rules",
    evidence: [ev("vitals_sample", S4, "breathing 48 (conf 0.88)", "2026-10-10T18:00:33.000Z")],
  },
  {
    rule_id: "draft.ae",
    category: "drafting",
    description: "AE draft 1: Dyspnea, provisional grade 2",
    inputs: { aedecod: "Dyspnea", aetoxgr: 2 },
    effect: "AE draft created",
    evidence: [sobSev, sobInt],
  },
  {
    rule_id: "draft.ae",
    category: "drafting",
    description: "AE draft 2: Cough, provisional grade 1",
    inputs: { aedecod: "Cough", aetoxgr: 1 },
    effect: "AE draft created",
    evidence: [coughSev],
  },
];

/** The demo detail plus the repeated rules above (10 rule rows in all). */
export function withRepeatedRules(): CheckInDetail {
  const rules = [...RULES, ...REPEATED_RULES];
  const base = detail();
  return {
    ...base,
    rules_fired: rules,
    result: { ...base.result, rules_fired: rules },
    why: rules.map((r) => r.description),
  };
}

export function withEscalationAndClock(): CheckInDetail {
  return detail({
    escalation: {
      id: ESCALATION_ID,
      session_id: SESSION_ID,
      usubjid: "R2810-ONC-1624-P-007",
      tier: 3,
      reasons: ["hospitalization or emergency-room visit = yes"],
      paged_at: "2026-10-10T18:05:01.000Z",
      acked_by: null,
      acked_at: null,
      seconds_to_ack: null,
    },
    sae_clock: {
      id: "01JSAECLOCK0000000000000001",
      session_id: SESSION_ID,
      usubjid: "R2810-ONC-1624-P-007",
      site_awareness_at: "2026-10-10T18:05:00.000Z",
      due_at: new Date(Date.now() + 3600_000).toISOString(),
      stopped_at: null,
      stopped_by: null,
      decision: null,
      seconds_remaining: 3600,
      informational: {
        fatal_or_life_threatening_7d: "2026-10-17T18:05:00.000Z",
        other_serious_15d: "2026-10-25T18:05:00.000Z",
      },
    },
  });
}
