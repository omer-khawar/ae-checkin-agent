/**
 * The 8 synthetic chart notes from the scanner's answer key
 * (`packages/rules/data/chartscan_answer_key.json`, `kind: "note"`; the same
 * text the seed ingests from `data/synthetic/chart_notes.json`). They are
 * embedded here so the "Ingest a chart note" form can be pre-filled with one
 * click and work offline; the web bundle cannot read files outside `src/`.
 *
 * All participants are synthetic (P-001 … P-012); the text was written by hand
 * for the demo and contains no real PHI. Source: Omer Khawar's
 * `ae-checkin-agent` (MIT), subject ids remapped to Interim participants.
 *
 * `expected` is the answer key, shown next to the form so a judge can compare
 * what the scanner found with what it should have found.
 */
export interface SampleNote {
  id: string;
  /** Participant display label the seed maps this note to. */
  display_label: string;
  note_date: string;
  author: string;
  note_type: string;
  text: string;
  expected: {
    ae_terms: string[];
    meds: Array<[drug: string, change: string]>;
    escalation: "none" | "urgent" | "emergency";
    serious?: boolean;
  };
}

export const SAMPLE_NOTES: SampleNote[] = [
  {
    id: "N3",
    display_label: "P-003",
    note_date: "2026-10-09",
    author: "Triage RN",
    note_type: "phone_note",
    text: "Daughter called: pt with increasing SOB over the past week, now with exertion after one flight of stairs. Dry cough x5 days. Advised to come in for evaluation. Holding lisinopril per PCP due to cough.",
    expected: {
      ae_terms: ["Dyspnea", "Cough"],
      meds: [["lisinopril", "stopped"]],
      escalation: "urgent",
    },
  },
  {
    id: "N1",
    display_label: "P-001",
    note_date: "2026-10-05",
    author: "J. Rivera, NP",
    note_type: "progress_note",
    text: "Oncology follow-up. Pt reports 3 days of diarrhea, 4-5 loose stools per day, started loperamide OTC. Mild nausea persists, taking ondansetron as needed. Denies fever, chills, or vomiting. Pt educated to call for fever > 100.4 or bloody stools.",
    expected: {
      ae_terms: ["Diarrhea", "Nausea"],
      meds: [
        ["loperamide", "started"],
        ["ondansetron", "taking"],
      ],
      escalation: "none",
    },
  },
  {
    id: "N2",
    display_label: "P-002",
    note_date: "2026-10-08",
    author: "Dermatology telehealth",
    note_type: "consult",
    text: "Maculopapular rash over trunk and upper arms, approx 15% BSA, pruritic. Started triamcinolone 0.1% cream BID and cetirizine 10 mg daily. No mucosal involvement, no blistering.",
    expected: {
      ae_terms: ["Rash maculo-papular", "Pruritus"],
      meds: [
        ["triamcinolone", "started"],
        ["cetirizine", "started"],
      ],
      escalation: "none",
    },
  },
  {
    id: "N4",
    display_label: "P-004",
    note_date: "2026-10-06",
    author: "Outside urgent care record",
    note_type: "outside_record",
    text: "Urgent care visit: dx acute sinusitis, prescribed amoxicillin-clavulanate 875 mg BID x10 days. Afebrile. Also reports mild headache.",
    expected: {
      ae_terms: ["Sinusitis", "Headache"],
      meds: [["amoxicillin-clavulanate", "started"]],
      escalation: "none",
    },
  },
  {
    id: "N5",
    display_label: "P-005",
    note_date: "2026-10-08",
    author: "Infusion RN",
    note_type: "progress_note",
    text: "Infusion visit. Pt c/o intermittent headaches, mild, and two small oral ulcers. Hx of migraines in her 20s. No nausea or vomiting. Continue current regimen.",
    expected: {
      ae_terms: ["Headache", "Mucositis oral"],
      meds: [],
      escalation: "none",
    },
  },
  {
    id: "N6",
    display_label: "P-006",
    note_date: "2026-10-08",
    author: "Hospital ED",
    note_type: "ed_note",
    text: "ED visit 10/08: brought in by wife for new confusion and decreased appetite x1 week. Admitted overnight for IV fluids. Dexamethasone discontinued.",
    expected: {
      ae_terms: ["Confusion", "Anorexia"],
      meds: [["dexamethasone", "stopped"]],
      escalation: "urgent",
      serious: true,
    },
  },
  {
    id: "N7",
    display_label: "P-001",
    note_date: "2026-10-09",
    author: "Research RN",
    note_type: "phone_note",
    text: "Nurse call: diarrhea improved on loperamide, now 2 stools/day. Nausea resolved.",
    expected: {
      ae_terms: ["Diarrhea", "Nausea"],
      meds: [["loperamide", "taking"]],
      escalation: "none",
    },
  },
  {
    id: "N8",
    display_label: "P-004",
    note_date: "2026-10-01",
    author: "J. Rivera, NP",
    note_type: "progress_note",
    text: "Routine visit. Feels well overall. Denies nausea, diarrhea, cough, or shortness of breath. Afebrile. Continue amlodipine.",
    expected: {
      ae_terms: [],
      meds: [["amlodipine", "taking"]],
      escalation: "none",
    },
  },
];

/** The note the form opens with: the Tier-2 demo beat (dyspnea + cough, urgent, med stopped). */
export const DEFAULT_SAMPLE = SAMPLE_NOTES[0];

/** Note types offered in the form; the API stores whatever string is sent. */
export const NOTE_TYPES: Array<{ value: string; label: string }> = [
  { value: "progress_note", label: "Progress note" },
  { value: "phone_note", label: "Phone note" },
  { value: "consult", label: "Consult" },
  { value: "outside_record", label: "Outside record" },
  { value: "ed_note", label: "ED note" },
  { value: "other", label: "Other" },
];
