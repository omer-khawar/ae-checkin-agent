/**
 * A visit brief shaped like CONTRACTS.md R3.2 for P-007 on the Monday-morning
 * seed (CLAUDE.md §00.6), plus some optional-extension fields on a few items so
 * both rendering paths (structured field vs. text fallback) are exercised.
 * Every participant and record here is synthetic.
 */
export const USUBJID = "R2810-ONC-1624-P-007";

export const ANSWER_SOB = "01JANSWER0000000000000SOB1";
export const ANSWER_RASH_1 = "01JANSWER000000000000RASH1";
export const ANSWER_RASH_2 = "01JANSWER000000000000RASH2";
export const CM_PRED = "01JDRAFTCM00000000000PRED1";
export const CLOCK_AESI = "01JCLOCK0000000000000AESI1";
export const NOTE_CALL = "01JNOTE00000000000000CALL1";
export const VS_1 = "01JVITALS000000000000000VS1";

export function briefJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    usubjid: USUBJID,
    display_label: "P-007",
    since: "2026-10-03",
    generated_at: "2026-10-12T12:00:00.000Z",
    sections: [
      {
        key: "new_side_effects",
        title: "New side effects",
        items: [
          {
            text: "Rash: grade 2, then grade 3 (provisional, investigator to confirm).",
            evidence_ids: [ANSWER_RASH_1, ANSWER_RASH_2],
            link: "/dashboard/checkins/01JSESSION000000000000RASH",
            grades: [
              { grade: 2, date: "2026-10-05", evidence_ids: [ANSWER_RASH_1] },
              { grade: 3, date: "2026-10-11", evidence_ids: [ANSWER_RASH_2] },
            ],
          },
          {
            // No `grades`: the trend comes from the text.
            text: "Shortness of breath: grade 2 (provisional).",
            evidence_ids: [ANSWER_SOB],
            link: null,
          },
        ],
      },
      {
        key: "open_aes",
        title: "Side effects still open",
        items: [
          {
            text: "Fatigue, ongoing since Sep 28.",
            evidence_ids: ["01JDRAFTAE0000000000FATIG"],
            link: null,
          },
        ],
      },
      {
        key: "med_changes",
        title: "Medication changes",
        items: [
          {
            text: "Started prednisone on Oct 10.",
            evidence_ids: [CM_PRED],
            link: "/dashboard/checkins/01JSESSION0000000000PRED",
            protocol_flag: "discouraged",
            protocol_section: "7.7.2",
            printed_page: 69,
            exception_text: "except in life-threatening emergencies or to treat irAEs",
            missing_fields: ["CMDOSE", "CMINDC"],
          },
          {
            // No `protocol_flag`: the chip comes from the text.
            text: "Started bevacizumab (not allowed by protocol).",
            evidence_ids: ["01JDRAFTCM00000000000BEVA1"],
            link: null,
          },
        ],
      },
      {
        key: "escalations_and_clocks",
        title: "Escalations and report clocks",
        items: [
          {
            text: "24-hour report clock started for rash.",
            evidence_ids: [CLOCK_AESI, ANSWER_RASH_2],
            link: "/dashboard/escalations",
            clock_kind: "aesi",
            due_at: "2026-10-12T09:00:00.000Z",
            status: "running",
          },
          {
            text: "Nurse call today for rash, not yet acknowledged.",
            evidence_ids: ["01JESC00000000000000000001"],
            link: null,
            tier: 2,
          },
        ],
      },
      {
        key: "notes",
        title: "Notes and calls",
        items: [
          {
            text: "Caregiver called about a new rash on the arms.",
            evidence_ids: [NOTE_CALL],
            link: "/dashboard/notes/01JNOTE00000000000000CALL1",
            note_type: "phone_call",
          },
        ],
      },
      {
        key: "vitals",
        title: "Vitals context",
        items: [
          {
            text: "Pulse about 74 per minute, breathing about 15 per minute (simulated).",
            evidence_ids: [VS_1],
            link: null,
            source: "mock",
          },
        ],
      },
    ],
    narrative: {
      kind: "visit_brief",
      writer: "template",
      sentences: [
        {
          text: "Since Oct 3, P-007 reported a rash that went from grade 2 to grade 3 (provisional, investigator to confirm).",
          evidence_ids: [ANSWER_RASH_1, ANSWER_RASH_2],
          section: "side_effects",
          template_id: "brief.side_effect_trend",
        },
        {
          text: "Prednisone was started; the protocol discourages systemic corticosteroids.",
          evidence_ids: [CM_PRED],
          section: "conmeds",
          template_id: "brief.conmed_flag",
        },
      ],
      text: "Since Oct 3, P-007 reported a rash … Prednisone was started; …",
    },
    questions_to_ask: [
      "Ask for the prednisone dose and why it was started.",
      { text: "Is the rash still there?", evidence_ids: [ANSWER_RASH_2], kind: "unresolved_ae" },
    ],
    ...overrides,
  };
}
