/**
 * Shared fixtures shaped like the API responses in CONTRACTS.md §2.1.
 */
import type {
  CompleteResponse,
  GateQuestion,
  Item,
  ItemsResponse,
  Session,
  Study,
} from "../lib/types";

export const STUDY: Study = {
  study_id: "R2810-ONC-1624",
  nct_id: "NCT03088540",
  title: "EMPOWER-Lung 1: cemiplimab in advanced NSCLC (public registry record)",
  sponsor: "Regeneron Pharmaceuticals",
  phase: "Phase 3",
  conditions: ["Non-small cell lung cancer"],
  interventions: ["cemiplimab"],
  fetched_at: "2026-10-10T00:00:00.000Z",
  source_url: "https://clinicaltrials.gov/study/NCT03088540",
  participants_note: "All participants are synthetic.",
};

/** Three items: two with (severity, interference), one presence-only. */
export const ITEMS: ItemsResponse = {
  recall_window: "the last 7 days",
  items: [
    {
      id: "shortness_of_breath",
      label: "Did you have shortness of breath?",
      short_label: "Shortness of breath",
      ctcae_term: "Dyspnea",
      attributes: ["severity", "interference"],
      // object form (label → int)
      response_options: {
        severity: { None: 0, Mild: 1, Moderate: 2, Severe: 3, "Very severe": 4 },
        interference: {
          "Not at all": 0,
          "A little bit": 1,
          Somewhat: 2,
          "Quite a bit": 3,
          "Very much": 4,
        },
      },
      recall_window: "in the last 7 days",
      order: 1,
    },
    {
      id: "cough",
      label: "Did you have a cough?",
      short_label: "Cough",
      ctcae_term: "Cough",
      attributes: ["severity", "interference"],
      // array form
      response_options: {
        severity: [
          { label: "None", value: 0 },
          { label: "Mild", value: 1 },
          { label: "Moderate", value: 2 },
          { label: "Severe", value: 3 },
          { label: "Very severe", value: 4 },
        ],
        interference: [
          { label: "Not at all", value: 0 },
          { label: "A little bit", value: 1 },
          { label: "Somewhat", value: 2 },
          { label: "Quite a bit", value: 3 },
          { label: "Very much", value: 4 },
        ],
      },
      recall_window: "in the last 7 days",
      order: 2,
    },
    {
      id: "rash",
      label: "Did you have a rash?",
      short_label: "Rash",
      ctcae_term: "Rash maculo-papular",
      attributes: ["presence"],
      response_options: { presence: { No: 0, Yes: 1 } },
      recall_window: "in the last 7 days",
      order: 3,
    },
  ],
  gates: [
    {
      id: "hospitalization",
      label: "Since your last visit, were you admitted to a hospital or seen in an emergency room?",
      kind: "yes_no",
    },
    {
      id: "conmed",
      label:
        "Have you started or stopped any medication, including over-the-counter, since your last visit?",
      kind: "yes_no_text",
    },
    {
      id: "other",
      label: "Is there anything else you want the study team to know?",
      kind: "free_text",
    },
  ],
};

/**
 * Rows in the exact shape of the shipped rules tables
 * (`packages/rules/data/proctcae_items.json` / `gate_questions.json`): `prompts`,
 * `optional_fields[]`, gate `text_prompt` / `direction_prompt` / `note`.
 */
export const SOB_ITEM_TABLE: Item = {
  id: "shortness_of_breath",
  order: 1,
  label: "Shortness of breath",
  short_label: "Breathing",
  ctcae_term: "Dyspnea",
  attributes: ["severity", "interference"],
  prompts: {
    severity: "In the last 7 days, how bad was your shortness of breath when it was at its worst?",
    interference:
      "In the last 7 days, how much did shortness of breath get in the way of your usual daily activities?",
  },
  response_options: {
    severity: { None: 0, Mild: 1, Moderate: 2, Severe: 3, "Very severe": 4 },
    interference: {
      "Not at all": 0,
      "A little bit": 1,
      Somewhat: 2,
      "Quite a bit": 3,
      "Very much": 4,
    },
  },
  recall_window: "in the last 7 days",
};

export const FEVER_ITEM_TABLE: Item = {
  id: "fever_or_chills",
  order: 9,
  label: "Fever or chills",
  short_label: "Fever",
  ctcae_term: "Fever",
  attributes: ["presence"],
  prompts: { presence: "In the last 7 days, did you have a fever or chills?" },
  response_options: { presence: { No: 0, Yes: 1 } },
  recall_window: "in the last 7 days",
  optional_fields: [
    {
      id: "temp_c",
      label: "If you took your temperature, what was the highest reading? (optional)",
      type: "number",
      unit: "°C",
      min: 34.0,
      max: 43.0,
      stored_as: "gates.temp_c",
      note: "Participant-typed, not device-measured. Evidence only; it never changes the provisional grade.",
    },
  ],
};

export const GATES_TABLE: GateQuestion[] = [
  {
    id: "hospitalization",
    order: 11,
    type: "yes_no",
    field: "hospitalization",
    label:
      "Since your last study visit, were you admitted to a hospital or seen in an emergency room?",
  },
  {
    id: "conmed",
    order: 12,
    type: "yes_no_with_text",
    field: "conmed_changed",
    label:
      "Since your last study visit, have you started or stopped any medication? This includes over-the-counter medicines, vitamins and supplements.",
    text_prompt: "Please type the name of the medication as it appears on the label.",
    text_note:
      "Stored exactly as typed. A deterministic string matcher proposes a normalized name; a coordinator confirms it.",
    direction_prompt: "Did you start it, stop it, or both?",
  },
  {
    id: "other",
    order: 13,
    type: "free_text",
    field: "other_text",
    label: "Is there anything else you would like the study team to know?",
    note: "Stored verbatim and never parsed by software. It is read by a person.",
  },
];

/** A two-item catalog in the shipped table's shape (dyspnea + fever with temperature). */
export const ITEMS_TABLE_SHAPE: ItemsResponse = {
  recall_window: "in the last 7 days",
  items: [SOB_ITEM_TABLE, FEVER_ITEM_TABLE],
  gates: GATES_TABLE,
};

export const SESSION_ID = "01JSESSION00000000000000AA";

export function session(overrides: Partial<Session> = {}): Session {
  return {
    id: SESSION_ID,
    usubjid: "P-007",
    study_id: STUDY.study_id,
    started_at: "2026-10-10T18:00:00.000Z",
    completed_at: null,
    consent_camera: true,
    vitals_status: "pending",
    tier: null,
    stop_screen_shown: false,
    is_eval: false,
    ...overrides,
  };
}

export const STOP_TEXT =
  "Thank you. A member of the study team will contact you today. If you feel you need urgent help right now, call 911 or go to the nearest emergency room.";

export function completeResponse(overrides: Partial<CompleteResponse> = {}): CompleteResponse {
  return {
    session_id: SESSION_ID,
    tier: 1,
    stop_screen: false,
    checkin_url: `/dashboard/checkins/${SESSION_ID}`,
    ...overrides,
  };
}
