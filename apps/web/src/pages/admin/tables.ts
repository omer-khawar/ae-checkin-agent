/**
 * Display tables for the admin page. DATA, not logic (CLAUDE.md §13): every
 * line shown next to a selector carries where it comes from and why.
 *
 * - `MOCK_SCENARIOS` mirrors the bridge's own table
 *   (`apps/vitals-bridge/src/sources/scenarios.ts`); the physiology line is the
 *   one the operator reads before picking a scenario for a demo.
 * - `VITALS_SOURCES` describes the three adapter slots (CLAUDE.md §7) and what
 *   each needs before the bridge can run it.
 * - `diffSettings()` is the only function here: it turns the form's draft into
 *   the minimal `PUT /admin/settings` body so the audit event's `changed`
 *   block lists exactly what the admin touched.
 */
import type { Settings, SettingsUpdate, VitalsSourceName } from "../../lib/types";

// ---------------------------------------------------------------------------
// Mock scenarios
// ---------------------------------------------------------------------------

export interface ScenarioRow {
  id: string;
  label: string;
  /** One line of physiology the operator reads before picking it. */
  physiology: string;
  /** Why the numbers are what they are; shown on hover / expanded. */
  rationale: string;
  /** What the demo uses it for. */
  demoUse: string;
}

export const SCENARIO_TABLE_SOURCE =
  "apps/vitals-bridge/src/sources/scenarios.ts (the mock source's own table; CLAUDE.md §7.2)";

export const MOCK_SCENARIOS: readonly ScenarioRow[] = [
  {
    id: "resting",
    label: "Resting",
    physiology:
      "Resting adult: pulse ~72, breathing ~14; confidence ramps 0.3 → 0.95 over the first 15 s.",
    rationale:
      "Resting adult norms (pulse 60–100, breathing 12–20) put these values mid-range, so no corroboration rule can fire. HRV RMSSD ~42 ms is a typical resting value.",
    demoUse: "Demo baseline (DEMO.md step 2).",
  },
  {
    id: "post_exercise",
    label: "Post-exercise",
    physiology:
      "Recovery after exertion: pulse 128 → 90 and breathing 27 → 18 over ~90 s (the “jumping jacks” demo).",
    rationale:
      "Heart rate recovers faster than ventilation after light exertion, so pulse decays with tau 45 s and breathing with tau 150 s. Both stay above the corroboration thresholds (pulse ≥ 110, breathing ≥ 24) when their timing gates open and inside plausibility bounds (35–180 / 5–45), so the demo shows a tier bump, not an implausible-vitals flag. Occasional “motion” flags.",
    demoUse:
      "Shows the corroboration rule raising the tier while the grade stays put (DEMO.md step 5).",
  },
  {
    id: "tachypnea",
    label: "Tachypnea",
    physiology: "Steady fast breathing: pulse ~98, breathing ~26, confidence 0.9 from the start.",
    rationale:
      "Breathing ≥ 24 with reported dyspnea is the “tachypnea corroborates reported dyspnea” rule; pulse 98 stays below the 110 tachycardia threshold so exactly one corroboration rule fires and the +1 tier cap is easy to explain.",
    demoUse: "Single corroboration rule; eval personas in the tier-3 group.",
  },
  {
    id: "low_quality",
    label: "Low quality",
    physiology:
      "Poor capture: confidence never reaches 0.5, intermittent face_not_found / low_light flags.",
    rationale:
      "Exercises vitals_status = low_quality end to end: the bridge keeps the values but flags them low_conf_*, the kiosk hides them, the rules ignore them with a logged reason.",
    demoUse: "Edge-case persona: low-quality vitals ignored.",
  },
  {
    id: "dropout",
    label: "Dropout",
    physiology:
      "Camera dropout: good signal for 20 s, source error for 10 s, then recovery; timing gates restart after the error.",
    rationale:
      "An error status resets the timing gates (bridge gate.ts): after recovery pulse reappears 12 s later and breathing 30 s later. Confidence re-ramps from 0.5 because a camera that has already locked once re-locks quickly.",
    demoUse: "Shows that the check-in continues when vitals drop out.",
  },
];

export function scenarioRow(id: string | null | undefined): ScenarioRow | undefined {
  return MOCK_SCENARIOS.find((s) => s.id === id);
}

// ---------------------------------------------------------------------------
// Vitals sources (adapter slots)
// ---------------------------------------------------------------------------

export interface SourceRow {
  id: VitalsSourceName;
  label: string;
  /** What `VitalsSample.isMeasured` is for this source; drives the badge. */
  isMeasured: boolean;
  description: string;
  /** What the operator must have in place before the bridge can start it. */
  requirements: string | null;
  status: "implemented" | "implemented_untested" | "stub";
}

/** Repository path of the adapter reference; shown as text (the SPA does not serve docs). */
export const VITALS_SOURCES_DOC = "docs/VITALS_SOURCES.md";

export const VITALS_SOURCES: readonly SourceRow[] = [
  {
    id: "mock",
    label: "Mock (simulated)",
    isMeasured: false,
    description:
      "Scenario-driven synthetic pulse, breathing and HRV at 1 Hz. Every sample is labelled SIMULATED.",
    requirements: null,
    status: "implemented",
  },
  {
    id: "presage",
    label: "Presage SmartSpectra (camera)",
    isMeasured: true,
    description:
      "Contactless optical vitals from the webcam via the SmartSpectra Node SDK. Samples are labelled MEASURED. Frames never leave the bridge; only derived metrics do.",
    requirements:
      "Run `npm run install:presage` in apps/vitals-bridge (the SDK is not in package.json) and set PRESAGE_API_KEY. Needs a supported OS (Linux x64/arm64, Windows x64, Apple Silicon).",
    status: "implemented_untested",
  },
  {
    id: "arduino",
    label: "Arduino (serial contact sensor)",
    isMeasured: true,
    description: "Newline-delimited JSON from a MAX30102 / DS18B20 sketch over a serial port.",
    requirements:
      "Not yet implemented: the slot exists; set SERIALPORT and implement sources/arduino.ts.",
    status: "stub",
  },
];

export const SOURCE_STATUS_LABELS: Record<SourceRow["status"], string> = {
  implemented: "implemented",
  implemented_untested: "implemented, not yet tested against a live camera",
  stub: "stub (not implemented)",
};

export function sourceRow(id: string | null | undefined): SourceRow | undefined {
  return VITALS_SOURCES.find((s) => s.id === id);
}

/**
 * The settings row records the operator's choice (audited), but the bridge
 * process picks its source at startup; the note is shown beside the selector.
 */
export const SOURCE_RESTART_NOTE =
  "Saving records the choice (audited) and publishes it on GET /settings/public, but the bridge process selects its source at startup. Restart it with `npm run bridge -- --source <name>` (or VITALS_SOURCE=<name>) for the change to take effect.";

// ---------------------------------------------------------------------------
// Simulated-as-measured
// ---------------------------------------------------------------------------

/** Verbatim warning from the page spec; shown whenever the toggle is ON or about to be. */
export const SIMULATED_AS_MEASURED_WARNING =
  "Demo only. Simulated vitals will be eligible for corroboration rules; exports still say Simulated.";

// ---------------------------------------------------------------------------
// Draft → PUT body
// ---------------------------------------------------------------------------

export interface SettingsDraft {
  vitals_source: string;
  mock_scenario: string;
  simulated_as_measured: boolean;
}

export function draftFrom(saved: Settings): SettingsDraft {
  return {
    vitals_source: String(saved.vitals_source ?? "mock"),
    mock_scenario: String(saved.mock_scenario ?? "resting"),
    simulated_as_measured: saved.simulated_as_measured === true,
  };
}

/** Only the keys that differ from `saved`; an empty object means nothing to save. */
export function diffSettings(saved: Settings, draft: SettingsDraft): SettingsUpdate {
  const base = draftFrom(saved);
  const out: SettingsUpdate = {};
  if (draft.vitals_source !== base.vitals_source) out.vitals_source = draft.vitals_source;
  if (draft.mock_scenario !== base.mock_scenario) out.mock_scenario = draft.mock_scenario;
  if (draft.simulated_as_measured !== base.simulated_as_measured) {
    out.simulated_as_measured = draft.simulated_as_measured;
  }
  return out;
}

export function hasChanges(update: SettingsUpdate): boolean {
  return Object.keys(update).length > 0;
}
