/**
 * Gate-question state and the small pure helpers behind the kiosk's three gate
 * screens (CLAUDE.md §3.2). Kept out of the component file so they can be unit
 * tested and reused by the eval "build your own persona" form later.
 */
import type { ConmedDirection, ConmedEntry, GateQuestion, GatesRequest } from "./types";

/** One "Add another medication" row. `text` is verbatim; never normalised on the client. */
export interface ConmedRow {
  text: string;
  direction: ConmedDirection | null;
}

export interface GateState {
  hospitalization: boolean | null;
  conmedChanged: boolean | null;
  /** One row per medication (R5.2); at least one row is always present. */
  conmeds: ConmedRow[];
  /** Verbatim free text; never parsed. */
  otherText: string;
}

/** The API caps `conmeds` at 10 entries and each text at 200 characters (R5.2). */
export const MAX_CONMEDS = 10;
export const MAX_CONMED_TEXT = 200;

export const EMPTY_CONMED_ROW: ConmedRow = { text: "", direction: null };

export const INITIAL_GATE_STATE: GateState = {
  hospitalization: null,
  conmedChanged: null,
  conmeds: [EMPTY_CONMED_ROW],
  otherText: "",
};

/**
 * R5.1: the first question after the study ID. Wording from GET /items when the
 * table carries `urgent_now`, else this fallback. Answer options are always Yes, No.
 */
export const URGENT_NOW_ID = "urgent_now";
export const FALLBACK_URGENT_LABEL =
  "Right now, are you having trouble breathing, or chest pain or tightness?";

/**
 * R5.1: a Severe (3) or Very severe (4) shortness-of-breath severity answer ends the
 * check-in at once, exactly like urgent_now = Yes. Item id and attribute are the
 * instrument's; the threshold is the "Severe" option's value.
 */
export const SEVERE_DYSPNEA = {
  itemId: "shortness_of_breath",
  attribute: "severity",
  minValue: 3,
} as const;

export function isSevereDyspnea(itemId: string, attribute: string, value: number): boolean {
  return (
    itemId === SEVERE_DYSPNEA.itemId &&
    attribute === SEVERE_DYSPNEA.attribute &&
    value >= SEVERE_DYSPNEA.minValue
  );
}

/** R5.1 fallback; the API's `stop_screen_text` (escalation_ladder.json) wins when present. */
export const FALLBACK_STOP_TEXT =
  "If you are having trouble breathing or chest pain right now, call 911 now. Your answers were saved. A member of the study team has been alerted and will contact you today.";

/** R5.1: shown if the API cannot be reached; makes no claim that anything was saved. */
export const UNSAVED_STOP_TEXT =
  "If you are having trouble breathing or chest pain right now, call 911 now. Please tell a member of the study team right away.";

/** Fictional 555-01xx number; the API's `site_phone` wins when present. */
export const FALLBACK_SITE_PHONE = "(732) 555-0142";

/** Yes always comes before No on every yes/no screen (R5.6). */
export function yesFirst<T extends { label: string }>(options: readonly T[]): T[] {
  const yes = options.filter((o) => o.label.trim().toLowerCase() === "yes");
  const no = options.filter((o) => o.label.trim().toLowerCase() === "no");
  if (yes.length === 0 || no.length === 0) return [...options];
  const rest = options.filter((o) => !yes.includes(o) && !no.includes(o));
  return [...yes, ...no, ...rest];
}

export const GATE_ORDER = ["hospitalization", "conmed", "other"] as const;
export type GateId = (typeof GATE_ORDER)[number];

/** Fallback wording, verbatim from CLAUDE.md §3.2; the API's `gates[].label` wins when present. */
export const FALLBACK_GATE_LABELS: Record<GateId, string> = {
  hospitalization:
    "Since your last visit, were you admitted to a hospital or seen in an emergency room?",
  conmed:
    "Have you started or stopped any medication, including over-the-counter, since your last visit?",
  other: "Is there anything else you want the study team to know?",
};

export const FALLBACK_GATE_PROMPTS = {
  conmed_text: "What is the name of the medication?",
  conmed_text_note: "Spelling does not need to be perfect; the study team will check it.",
  conmed_direction: "Did you start it, stop it, or both?",
  other_hint:
    "You can leave this empty. Whatever you write is passed to the study team exactly as typed.",
} as const;

export function gateLabel(questions: GateQuestion[], id: GateId): string {
  return questions.find((q) => q.id === id)?.label ?? FALLBACK_GATE_LABELS[id];
}

export interface GatePrompts {
  conmedText: string;
  /** Participant-facing helper under the medication box. */
  conmedTextNote: string;
  conmedDirection: string;
  otherNote: string;
}

/**
 * Sub-prompt wording for the con-med and free-text screens. The shipped
 * `gate_questions.json` uses `text_prompt` / `direction_prompt` / `note`; the
 * legacy `prompts.{conmed_text, conmed_direction, other_hint}` map is honoured
 * too, and the brief's wording is the last fallback.
 *
 * `text_note` is deliberately NOT shown to participants: in the table it is a
 * documentation note ("A deterministic string matcher proposes…"), not kiosk
 * copy (CLAUDE.md §3.8: no clinical jargon on the kiosk).
 */
export function gatePrompts(questions: GateQuestion[]): GatePrompts {
  const conmed = questions.find((q) => q.id === "conmed");
  const other = questions.find((q) => q.id === "other");
  return {
    conmedText:
      conmed?.text_prompt ?? conmed?.prompts?.conmed_text ?? FALLBACK_GATE_PROMPTS.conmed_text,
    conmedTextNote: FALLBACK_GATE_PROMPTS.conmed_text_note,
    conmedDirection:
      conmed?.direction_prompt ??
      conmed?.prompts?.conmed_direction ??
      FALLBACK_GATE_PROMPTS.conmed_direction,
    otherNote: other?.note ?? other?.prompts?.other_hint ?? FALLBACK_GATE_PROMPTS.other_hint,
  };
}

/**
 * The body for `POST /sessions/{id}/gates` (CONTRACTS.md §2.1).
 *
 * Verbatim rule (CLAUDE.md §3.2, §3.4(g)): `conmed_text` and `other_text` are
 * sent exactly as typed, whitespace included. `trim()` is used only to decide
 * whether a field is empty enough to omit. `temp_c` is the caller's already
 * validated value (fever present AND inside the table's bounds), or null.
 */
export function buildGatesBody(
  state: GateState,
  tempC: number | null,
  tsClient: string,
): GatesRequest {
  const req: GatesRequest = {
    hospitalization: state.hospitalization === true,
    urgent_now: false,
    conmed_changed: state.conmedChanged === true,
    ts_client: tsClient,
  };
  if (state.conmedChanged === true) {
    const rows = state.conmeds.filter((r) => r.text.trim().length > 0 && r.direction !== null);
    if (rows.length > 0) {
      req.conmeds = rows.map(
        (r): ConmedEntry => ({
          text: r.text.slice(0, MAX_CONMED_TEXT),
          direction: r.direction as ConmedDirection,
        }),
      );
      // Old servers read the single text field: all medicines joined, one direction.
      req.conmed_text = rows.map((r) => r.text).join(", ");
      const dirs = new Set(rows.map((r) => r.direction));
      req.conmed_direction = dirs.size === 1 ? (rows[0].direction as ConmedDirection) : "both";
    }
  }
  if (state.otherText.trim().length > 0) req.other_text = state.otherText;
  if (tempC !== null && Number.isFinite(tempC)) req.temp_c = tempC;
  return req;
}

/** Whether the gate at `index` has enough input to move on. */
export function gateComplete(state: GateState, index: number): boolean {
  switch (GATE_ORDER[index]) {
    case "hospitalization":
      return state.hospitalization !== null;
    case "conmed":
      if (state.conmedChanged === null) return false;
      if (state.conmedChanged === false) return true;
      return state.conmeds.every((r) => r.text.trim().length > 0 && r.direction !== null);
    case "other":
      return true;
    default:
      return false;
  }
}

/** The urgent_now question wording: the table's label when the API sends one, else the R5.1 text. */
export function urgentLabel(questions: GateQuestion[]): string {
  return questions.find((q) => q.id === URGENT_NOW_ID)?.label ?? FALLBACK_URGENT_LABEL;
}
