/**
 * Packet fixtures in the exact JSON shape of CONTRACTS.md R3.2 / R4.2. Every
 * participant and value is synthetic.
 */
export const PACKET_ID = "01JPACKET0000000000000000A";
export const FOLLOWUP_ID = "01JPACKET0000000000000000B";
export const CLOCK_ID = "01JCLOCK00000000000000000A";
export const NOTE_ID = "01JNOTE000000000000000000E";
export const ANSWER_ID = "01JANSWER0000000000000000H";

/** A draft SAE packet for an ER visit found in a chart note. */
export function draftPacket(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PACKET_ID,
    clock_id: CLOCK_ID,
    kind: "sae",
    usubjid: "R2810-ONC-1624-P-004",
    display_label: "P-004",
    status: "draft",
    sequence: 0,
    parent_packet_id: null,
    changes_since_previous: [],
    version: 1,
    created_at: "2026-10-12T06:00:00.000Z",
    signed_by: null,
    signed_at: null,
    due_at: "2026-10-13T05:00:00.000Z",
    site_awareness_at: "2026-10-12T05:00:00.000Z",
    fields: [
      {
        name: "AETERM",
        plain_label: "Side effect, in the note's words",
        value: "shortness of breath",
        evidence: [
          {
            kind: "chart_note",
            id: NOTE_ID,
            ts: "2026-10-12T05:00:00.000Z",
            note: "worsening shortness of breath",
            quote: "worsening shortness of breath",
          },
        ],
      },
      {
        name: "SAE_HOSPITALIZATION",
        plain_label: "Hospital or ER visit",
        value: true,
        evidence: [
          {
            kind: "gate_answer",
            id: ANSWER_ID,
            ts: "2026-10-12T04:10:00.000Z",
            note: "Since your last visit, were you admitted to a hospital or seen in an emergency room? Yes",
          },
        ],
      },
      {
        name: "AEOUT",
        plain_label: "Outcome",
        value: null,
        evidence: [],
      },
    ],
    missing_information: ["Outcome of the event", "Date of last study drug dose"],
    narrative: {
      kind: "sae_narrative",
      writer: "template",
      sentences: [
        {
          text: "Participant P-004 was seen in the emergency room for shortness of breath.",
          evidence_ids: [NOTE_ID],
          section: "event",
          template_id: "sae.event.er_visit",
        },
        {
          text: "The participant reported a hospital or ER visit at the check-in.",
          evidence_ids: [ANSWER_ID, "01JUNKNOWN000000000000000Z"],
          section: "event",
        },
      ],
      text: "Participant P-004 was seen in the emergency room for shortness of breath. The participant reported a hospital or ER visit at the check-in.",
    },
    ...over,
  };
}

export function signedPacket(over: Record<string, unknown> = {}): Record<string, unknown> {
  return draftPacket({
    status: "signed",
    signed_by: "investigator",
    signed_at: "2026-10-12T09:30:00.000Z",
    clock_stopped_at: "2026-10-12T09:30:00.000Z",
    ...over,
  });
}

export function followUpPacket(): Record<string, unknown> {
  return draftPacket({
    id: FOLLOWUP_ID,
    sequence: 1,
    parent_packet_id: PACKET_ID,
    missing_information: ["Date of last study drug dose"],
    changes_since_previous: [
      {
        field: "AEOUT",
        before: null,
        after: "Recovering",
        evidence: [
          {
            kind: "phone_call",
            id: "01JCALL000000000000000000A",
            ts: "2026-10-13T14:00:00.000Z",
            note: "Caregiver says breathing is better",
            quote: "breathing is better",
          },
        ],
      },
    ],
    narrative: {
      kind: "sae_followup",
      writer: "template",
      sentences: [
        {
          text: "Follow-up 1: the outcome changed from not known to recovering.",
          evidence_ids: ["01JCALL000000000000000000A"],
        },
      ],
      text: "Follow-up 1: the outcome changed from not known to recovering.",
    },
  });
}
