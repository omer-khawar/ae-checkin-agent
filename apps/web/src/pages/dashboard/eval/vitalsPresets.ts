/**
 * Client-side vitals presets for the "build your own persona" form
 * (CLAUDE.md §8, §11 step 6).
 *
 * The form needs a small, believable, DETERMINISTIC list of bridge-shaped
 * samples to send with a custom persona. It mirrors the conventions of
 * `packages/rules/data/personas.json` (`schema.vitals_samples`): one sample
 * every 2 s from t = 20 s, pulse only (windowS 12) before t = 30 s, pulse +
 * breathing (windowS 30) from t = 30 s. Eleven samples, t = 20 … 40 s.
 *
 * Nothing here is a rule. The preset numbers are demo INPUTS the judge can
 * edit; the engine on the server decides plausibility, confidence eligibility
 * and corroboration from its own JSON tables. Every sample is `isMeasured:
 * false` and `source: "mock"` because nothing on this page ever touches a
 * sensor; the SIMULATED badge beside the preview says so.
 *
 * The "wobble" arrays replace random noise so two runs with the same inputs
 * send byte-identical samples (the eval must be reproducible).
 */
import type { PersonaVitalsSample } from "../../../lib/types";

export type VitalsPreset =
  | "resting"
  | "post_exercise"
  | "tachypnea"
  | "low_quality"
  | "implausible"
  | "none";

export const VITALS_PRESET_ORDER: readonly VitalsPreset[] = [
  "resting",
  "post_exercise",
  "tachypnea",
  "low_quality",
  "implausible",
  "none",
] as const;

/** The three numbers the judge can edit after picking a preset. */
export interface VitalsLevels {
  /** Pulse at the first sample (beats/min). */
  pulse: number;
  /** Breathing rate at the first breathing sample (breaths/min). */
  breathing: number;
  /** Confidence 0..1 reported on every metric. */
  confidence: number;
}

export interface VitalsPresetSpec {
  id: VitalsPreset;
  label: string;
  /** One line shown under the selector. Always says "simulated". */
  description: string;
  defaults: VitalsLevels;
  /** Whether the preset implies camera consent (no samples ⇒ no consent). */
  consentCamera: boolean;
}

export const VITALS_PRESETS: Record<VitalsPreset, VitalsPresetSpec> = {
  resting: {
    id: "resting",
    label: "Resting",
    description: "Simulated resting adult: pulse about 72, breathing about 14, good confidence.",
    defaults: { pulse: 72, breathing: 14, confidence: 0.9 },
    consentCamera: true,
  },
  post_exercise: {
    id: "post_exercise",
    label: "Post-exercise",
    description:
      "Simulated 'just did jumping jacks': pulse starts about 128 and breathing about 27, both settling over the capture.",
    defaults: { pulse: 128, breathing: 27, confidence: 0.9 },
    consentCamera: true,
  },
  tachypnea: {
    id: "tachypnea",
    label: "Fast breathing",
    description: "Simulated steady fast breathing: pulse about 98, breathing about 26.",
    defaults: { pulse: 98, breathing: 26, confidence: 0.9 },
    consentCamera: true,
  },
  low_quality: {
    id: "low_quality",
    label: "Low quality",
    description:
      "Simulated poor capture: confidence stays about 0.4 with face_not_found / low_light flags, so the engine ignores the samples.",
    defaults: { pulse: 75, breathing: 15, confidence: 0.4 },
    consentCamera: true,
  },
  implausible: {
    id: "implausible",
    label: "Implausible",
    description:
      "Simulated sensor nonsense: pulse about 190, which the engine flags as implausible and ignores for rules.",
    defaults: { pulse: 190, breathing: 20, confidence: 0.9 },
    consentCamera: true,
  },
  none: {
    id: "none",
    label: "No camera",
    description: "Camera declined: no samples at all; the check-in runs without vitals.",
    defaults: { pulse: 0, breathing: 0, confidence: 0 },
    consentCamera: false,
  },
};

/** Sample offsets from session start, as the shipped personas use them. */
export const SAMPLE_OFFSETS_S: readonly number[] = [20, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40];

/** Breathing appears once the 30 s averaging window has filled (CLAUDE.md §3.3). */
const BREATHING_FROM_S = 30;
const PULSE_WINDOW_S = 12;
const BREATHING_WINDOW_S = 30;

/** Fixed small wobbles (beats/min, breaths/min) standing in for physiological noise. */
const PULSE_WOBBLE = [0, 1, 0, -1, 0, 1, 2, 1, 0, 0, -1];
const BREATHING_WOBBLE = [0, 0, 1, 0, -1, 0, 0, 1, 0, 0, 0];
/** Confidence ramps up a little over the capture, as the mock source does. */
const CONF_RAMP = [-0.04, -0.02, 0, 0.01, 0.02, 0.03, 0.03, 0.04, 0.04, 0.05, 0.05];
/** low_quality flags rotate so the preview looks like intermittent face loss. */
const LOW_QUALITY_FLAGS: readonly string[][] = [["face_not_found"], ["low_light"], []];

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

/**
 * Post-exercise recovery: exponential decay from `start` toward `start × ratio`
 * with a 90 s e-folding time, so the 20 s capture shows a visible but
 * incomplete settle (the mock source uses the same shape).
 */
function recover(start: number, ratio: number, tS: number): number {
  const target = start * ratio;
  return target + (start - target) * Math.exp(-tS / 90);
}

/**
 * Generate the sample list for a preset and the (possibly edited) levels.
 * Pure and deterministic: same inputs, same output, always.
 */
export function generateSamples(preset: VitalsPreset, levels: VitalsLevels): PersonaVitalsSample[] {
  if (preset === "none") return [];
  const conf = clamp01(levels.confidence);
  return SAMPLE_OFFSETS_S.map((tsOffsetS, i) => {
    const tS = tsOffsetS - SAMPLE_OFFSETS_S[0];
    let pulse = levels.pulse + PULSE_WOBBLE[i];
    let breathing = levels.breathing + BREATHING_WOBBLE[i];
    if (preset === "post_exercise") {
      pulse = recover(levels.pulse, 0.7, tS) + PULSE_WOBBLE[i];
      breathing = recover(levels.breathing, 0.67, tS) + BREATHING_WOBBLE[i];
    }
    const hasBreathing = tsOffsetS >= BREATHING_FROM_S;
    const sampleConf = clamp01(conf + CONF_RAMP[i]);
    const sample: PersonaVitalsSample = {
      tsOffsetS,
      source: "mock",
      isMeasured: false,
      pulseBpm: Math.round(pulse),
      pulseConf: round2(sampleConf),
      windowS: hasBreathing ? BREATHING_WINDOW_S : PULSE_WINDOW_S,
      qualityFlags:
        preset === "low_quality" ? [...LOW_QUALITY_FLAGS[i % LOW_QUALITY_FLAGS.length]] : [],
    };
    if (hasBreathing) {
      sample.breathingBpm = Math.round(breathing);
      sample.breathingConf = round2(clamp01(sampleConf - 0.05));
    }
    return sample;
  });
}

/** Parse a number input, falling back to the preset default when blank/invalid. */
export function parseLevel(raw: string, fallback: number): number {
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}
