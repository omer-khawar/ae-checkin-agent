/**
 * Gate-question state and the small pure helpers behind the kiosk's three gate
 * screens (CLAUDE.md §3.2). Kept out of the component file so they can be unit
 * tested and reused by the eval "build your own persona" form later.
 */
import type { ConmedDirection, GateQuestion, GatesRequest } from "./types";

export interface GateState {
  hospitalization: boolean | null;
  conmedChanged: boolean | null;
  /** Verbatim medication text; never normalised on the client. */
  conmedText: string;
  conmedDirection: ConmedDirection | null;
  /** Verbatim free text; never parsed. */
  otherText: string;
}

export const INITIAL_GATE_STATE: GateState = {
  hospitalization: null,
  conmedChanged: null,
  conmedText: "",
  conmedDirection: null,
  otherText: "",
};

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
    conmed_changed: state.conmedChanged === true,
    ts_client: tsClient,
  };
  if (state.conmedChanged === true) {
    if (state.conmedText.trim().length > 0) req.conmed_text = state.conmedText;
    if (state.conmedDirection) req.conmed_direction = state.conmedDirection;
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
      return state.conmedText.trim().length > 0 && state.conmedDirection !== null;
    case "other":
      return true;
    default:
      return false;
  }
}
