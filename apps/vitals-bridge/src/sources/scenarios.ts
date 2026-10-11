/**
 * Mock scenario table (CLAUDE.md §7.2).
 *
 * This is DATA, not logic: every number that shapes a simulated signal lives here with a
 * `rationale`, so a reviewer can see why the "post-exercise" pulse starts at 128 or why the
 * low-quality scenario never reaches confidence 0.5. `mock.ts` reads this table and contains no
 * physiological constants of its own.
 *
 * Signal model used by mock.ts for each metric:
 *   value(t) = target + (start - target) * exp(-t / tauS) + AR1(phi, sd)
 * where t is seconds since the current *collecting* stretch began (so a dropout recovery restarts
 * the curve), and AR1 is autocorrelated noise (see noise.ts) so the series drifts like a real
 * optical estimate instead of jittering like white noise.
 *
 * Confidence model:
 *   conf(t) = start + (end - start) * min(1, t / rampS) + AR1(0.7, jitterSd), clamped to [0.02, max]
 * Breathing and HRV confidences are derived from the same curve (x0.95 and x0.90): on a real
 * optical source the longer-window metrics are the less certain ones.
 *
 * Every sample the mock emits is `isMeasured: false` and `source: "mock"`; nothing here can be
 * mistaken for a measurement. The word "simulated" is carried in each scenario's description so
 * the UI and logs can show it next to the values.
 */

export type ScenarioName = 'resting' | 'post_exercise' | 'tachypnea' | 'low_quality' | 'dropout';

export const SCENARIO_NAMES: readonly ScenarioName[] = [
  'resting',
  'post_exercise',
  'tachypnea',
  'low_quality',
  'dropout',
] as const;

export const DEFAULT_SCENARIO: ScenarioName = 'resting';

export function isScenarioName(value: string): value is ScenarioName {
  return (SCENARIO_NAMES as readonly string[]).includes(value);
}

export interface MetricSpec {
  /** Value at the first collecting second. */
  start: number;
  /** Asymptote the signal decays toward (equal to `start` for a steady scenario). */
  target: number;
  /** e-folding time of the start→target transition in seconds (ignored when start === target). */
  tauS: number;
  /** Stationary standard deviation of the AR(1) noise added on top. */
  sd: number;
  /** AR(1) autocorrelation coefficient, 0 ≤ phi < 1; higher = smoother. */
  phi: number;
}

export interface ConfidenceSpec {
  start: number;
  end: number;
  /** Seconds over which confidence ramps from `start` to `end`; 0 = immediately at `end`. */
  rampS: number;
  jitterSd: number;
  /** Hard ceiling applied after noise (lets low_quality guarantee < 0.5). */
  max: number;
}

export interface FlagSpec {
  /** Quality flags drawn at random each second (one per second at most). */
  candidates: string[];
  /** Probability that *some* flag is attached to a given second. */
  perSecondProbability: number;
}

export interface DropoutSpec {
  /** Simulated second (1-based tick) at which the source goes to `error`. */
  errorAtS: number;
  /** How many seconds the error lasts before the source recovers to `collecting`. */
  errorForS: number;
  message: string;
}

export interface ScenarioSpec {
  name: ScenarioName;
  /** One line shown in logs/UI; always contains the word "simulated". */
  description: string;
  /** Why the numbers are what they are. */
  rationale: string;
  /** Ticks spent in `warming` before the first `collecting` sample (face lock latency). */
  warmupS: number;
  /** Cap for the reported `windowS` (grows 1..cap as the rolling average fills). */
  windowCapS: number;
  pulse: MetricSpec;
  breathing: MetricSpec;
  /** HRV RMSSD in ms; null when the scenario does not simulate HRV at all. */
  hrv: MetricSpec | null;
  conf: ConfidenceSpec;
  flags: FlagSpec | null;
  dropout: DropoutSpec | null;
}

/** Shared noise shape: phi 0.85 gives ~0.5 sd second-to-second change, i.e. visibly smooth. */
const SMOOTH = 0.85;

export const MOCK_SCENARIOS: Readonly<Record<ScenarioName, ScenarioSpec>> = {
  resting: {
    name: 'resting',
    description: 'Simulated resting adult: pulse ~72, breathing ~14, confidence ramps 0.3→0.95.',
    rationale:
      'CLAUDE.md §7.2: pulse ~72±3, breathing ~14±1, confidence ramps from 0.3 to 0.95 over the ' +
      'first 15 s. Resting adult norms (pulse 60–100, breathing 12–20) put these values mid-range ' +
      'so no corroboration rule can fire; this is the demo baseline. HRV RMSSD ~42 ms is a typical ' +
      'resting value for a middle-aged adult.',
    warmupS: 1,
    windowCapS: 30,
    pulse: { start: 72, target: 72, tauS: 1, sd: 3, phi: SMOOTH },
    breathing: { start: 14, target: 14, tauS: 1, sd: 1, phi: SMOOTH },
    hrv: { start: 42, target: 42, tauS: 1, sd: 4, phi: 0.9 },
    conf: { start: 0.3, end: 0.95, rampS: 15, jitterSd: 0.01, max: 0.98 },
    flags: null,
    dropout: null,
  },
  post_exercise: {
    name: 'post_exercise',
    description:
      'Simulated post-exercise recovery: pulse 128→90 and breathing 27→18 over ~90 s (the "jumping jacks" demo).',
    rationale:
      'CLAUDE.md §7.2: pulse starts ~128 decaying toward 90 over 90 s, breathing ~27 decaying toward ' +
      '18. Recovery after light exertion is roughly exponential; heart rate recovers faster than ' +
      'ventilation (parasympathetic reactivation vs. the slower CO2 washout), so pulse uses ' +
      'tau = 45 s (~119 when the 12 s pulse gate opens, ~95 at 90 s) and breathing tau = 150 s ' +
      '(~25 when the 30 s breathing gate opens, ~23 at 90 s). The constants are chosen so that the ' +
      'values the rules engine can actually see (the bridge nulls each metric until its timing gate ' +
      'elapses) are still above the corroboration thresholds in vitals_corroboration.json ' +
      '(pulse ≥ 110, breathing ≥ 24): both rules fire, the tier bumps, the grade does not. Values ' +
      'stay inside plausibility bounds (35–180 / 5–45) on purpose so the demo shows a tier bump, ' +
      'not an implausible-vitals flag. Occasional "motion" flags: post-exercise subjects fidget.',
    warmupS: 1,
    windowCapS: 30,
    pulse: { start: 128, target: 90, tauS: 45, sd: 2.5, phi: SMOOTH },
    breathing: { start: 27, target: 18, tauS: 150, sd: 1, phi: SMOOTH },
    hrv: { start: 18, target: 35, tauS: 60, sd: 3, phi: 0.9 },
    conf: { start: 0.3, end: 0.85, rampS: 10, jitterSd: 0.02, max: 0.95 },
    flags: { candidates: ['motion'], perSecondProbability: 0.15 },
    dropout: null,
  },
  tachypnea: {
    name: 'tachypnea',
    description: 'Simulated steady tachypnea: pulse ~98, breathing ~26, confidence 0.9.',
    rationale:
      'CLAUDE.md §7.2: pulse ~98, breathing ~26 steady, conf 0.9. Breathing ≥ 24 with reported ' +
      'dyspnea is the "tachypnea corroborates reported dyspnea" rule; pulse 98 stays below the 110 ' +
      'tachycardia threshold so only ONE corroboration rule fires and the +1 tier cap is easy to ' +
      'explain. Confidence sits at 0.9 from the first second so the gates, not confidence, decide ' +
      'when values appear.',
    warmupS: 1,
    windowCapS: 30,
    pulse: { start: 98, target: 98, tauS: 1, sd: 2, phi: SMOOTH },
    breathing: { start: 26, target: 26, tauS: 1, sd: 0.8, phi: SMOOTH },
    hrv: { start: 30, target: 30, tauS: 1, sd: 3, phi: 0.9 },
    conf: { start: 0.9, end: 0.9, rampS: 0, jitterSd: 0.01, max: 0.95 },
    flags: null,
    dropout: null,
  },
  low_quality: {
    name: 'low_quality',
    description:
      'Simulated poor capture: confidence never reaches 0.5, intermittent face_not_found / low_light flags.',
    rationale:
      'CLAUDE.md §7.2: conf stays < 0.5 with face_not_found/low_light intermittently. Exercises the ' +
      'vitals_status = "low_quality" path end to end: the bridge keeps the values but flags them ' +
      'low_conf_*, the UI hides them, the rules ignore them with a logged reason. Seconds flagged ' +
      'face_not_found carry no values at all (no face, no pulse). Noise is wider (phi 0.7) because ' +
      'a weak optical signal is a noisy one.',
    warmupS: 2,
    windowCapS: 30,
    pulse: { start: 75, target: 75, tauS: 1, sd: 8, phi: 0.7 },
    breathing: { start: 15, target: 15, tauS: 1, sd: 3, phi: 0.7 },
    hrv: null,
    conf: { start: 0.2, end: 0.35, rampS: 5, jitterSd: 0.06, max: 0.49 },
    flags: { candidates: ['face_not_found', 'low_light'], perSecondProbability: 0.45 },
    dropout: null,
  },
  dropout: {
    name: 'dropout',
    description:
      'Simulated camera dropout: good signal for 20 s, source error for 10 s, then recovery.',
    rationale:
      'CLAUDE.md §7.2: good for 20 s then status error for 10 s then recovers. Demonstrates that an ' +
      'error status resets the timing gates (gate.ts): after recovery, pulse reappears only 12 s ' +
      'later, breathing 30 s later. Confidence ramps from 0.5 (not 0.3) because a camera that has ' +
      'already locked once re-locks quickly.',
    warmupS: 1,
    windowCapS: 30,
    pulse: { start: 74, target: 74, tauS: 1, sd: 3, phi: SMOOTH },
    breathing: { start: 15, target: 15, tauS: 1, sd: 1, phi: SMOOTH },
    hrv: { start: 40, target: 40, tauS: 1, sd: 4, phi: 0.9 },
    conf: { start: 0.5, end: 0.95, rampS: 5, jitterSd: 0.01, max: 0.98 },
    flags: null,
    dropout: { errorAtS: 21, errorForS: 10, message: 'camera stream lost (simulated dropout)' },
  },
};
