/**
 * Form state for "build your own persona" and the mapping to the contract
 * `Persona` shape that `POST /eval/run-custom` accepts (CONTRACTS.md §2.2, §6).
 *
 * The form is pre-filled with the demo persona `T1-dyspnea-moderate` (CLAUDE.md
 * §11 step 6): one click runs it, and changing shortness-of-breath severity to
 * Severe moves the tier. The values below are copied from
 * `packages/rules/data/personas.json`; they are inputs, not rules.
 */
import type { Attribute, ConmedDirection, Item, Persona } from "../../../lib/types";
import {
  generateSamples,
  VITALS_PRESETS,
  type VitalsLevels,
  type VitalsPreset,
} from "./vitalsPresets";

export type ResponseMap = Record<string, Partial<Record<Attribute, number>>>;

export interface PersonaFormState {
  responses: ResponseMap;
  hospitalization: boolean;
  conmedChanged: boolean;
  /** Verbatim, exactly as typed. */
  conmedText: string;
  conmedDirection: ConmedDirection;
  /** Verbatim, never parsed. */
  otherText: string;
  /** Optional participant-typed temperature as text; "" = not provided. */
  tempC: string;
  preset: VitalsPreset;
  levels: VitalsLevels;
  /** The admin demo toggle, per-run (CLAUDE.md §3.4(d)). Default OFF. */
  simulatedAsMeasured: boolean;
}

export const DEMO_PERSONA_ID = "T1-dyspnea-moderate";

/** The demo persona's answers (everything not listed is 0 / "None"). */
export const DEMO_RESPONSES: ResponseMap = {
  shortness_of_breath: { severity: 2, interference: 2 },
  cough: { severity: 1, interference: 0 },
};

export function demoFormState(): PersonaFormState {
  return {
    responses: structuredClone(DEMO_RESPONSES),
    hospitalization: false,
    conmedChanged: true,
    conmedText: "loratadine",
    conmedDirection: "started",
    otherText: "",
    tempC: "",
    preset: "resting",
    levels: { ...VITALS_PRESETS.resting.defaults },
    simulatedAsMeasured: false,
  };
}

/** Value for one item attribute: the form's value, else 0 ("None"/"Never"/"No"). */
export function responseValue(state: PersonaFormState, itemId: string, attr: Attribute): number {
  return state.responses[itemId]?.[attr] ?? 0;
}

export function withResponse(
  state: PersonaFormState,
  itemId: string,
  attr: Attribute,
  value: number,
): PersonaFormState {
  return {
    ...state,
    responses: {
      ...state.responses,
      [itemId]: { ...(state.responses[itemId] ?? {}), [attr]: value },
    },
  };
}

/** Switching preset resets the editable levels to that preset's defaults. */
export function withPreset(state: PersonaFormState, preset: VitalsPreset): PersonaFormState {
  return { ...state, preset, levels: { ...VITALS_PRESETS[preset].defaults } };
}

/** Items in table order; defensive against an API that omits `order`. */
export function orderedItems(items: Item[]): Item[] {
  return [...items].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/**
 * Build the contract `Persona`. Every attribute of every item from `GET /items`
 * is sent explicitly (the personas table convention), so an item the judge did
 * not touch is an explicit 0, not a missing key.
 */
export function buildPersona(state: PersonaFormState, items: Item[]): Persona {
  const responses: ResponseMap = {};
  for (const item of orderedItems(items)) {
    const attrs = item.attributes.length ? item.attributes : (["severity"] as Attribute[]);
    responses[item.id] = {};
    for (const attr of attrs) {
      responses[item.id][attr] = responseValue(state, item.id, attr);
    }
  }
  const preset = VITALS_PRESETS[state.preset];
  const tempC = Number.parseFloat(state.tempC);
  const gates: Persona["gates"] = {
    hospitalization: state.hospitalization,
    conmed_changed: state.conmedChanged,
    other_text: state.otherText,
  };
  if (state.conmedChanged) {
    gates.conmed_text = state.conmedText;
    gates.conmed_direction = state.conmedDirection;
  }
  if (state.tempC.trim() !== "" && Number.isFinite(tempC)) gates.temp_c = tempC;

  return {
    // Unique per run so the server never confuses two custom runs' synthetic participants.
    id: `custom-${Date.now().toString(36)}`,
    name: "Custom persona (built on the Eval page)",
    category: "custom",
    hidden: false,
    description: "Ad-hoc persona built by a reviewer on the Eval page. No answer key.",
    consent_camera: preset.consentCamera,
    vitals_scenario: state.preset,
    settings: { simulated_as_measured: state.simulatedAsMeasured },
    setup: { prior_checkins: [] },
    responses,
    gates,
    vitals_samples: generateSamples(state.preset, state.levels),
  };
}
