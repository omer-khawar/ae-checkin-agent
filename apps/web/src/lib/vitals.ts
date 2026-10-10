/**
 * Display gating for vitals values (CLAUDE.md §3.3). Pure, so the panel's rules
 * can be unit tested without rendering.
 *
 * A metric value is shown only when:
 *   1. the bridge says the timing gate elapsed (`published.<metric>`),
 *   2. the value exists,
 *   3. the bridge did not flag it `low_conf_<metric>`, and
 *   4. its confidence (when reported) is >= the threshold.
 *
 * Two further verdicts are derived here:
 *   - `metricSlot()`  — what the slot says when no value is shown
 *     ("collecting…" while the gate is pending or the signal is weak,
 *     "not available" when the gate has elapsed and the source has no value for
 *     that metric, e.g. a source without HRV).
 *   - `signalQuality()` — the header dot. During the timing gate the bridge
 *     strips confidences (CONTRACTS.md §3.1), so quality is judged only from
 *     metrics that are actually published; before any is, it says "Collecting",
 *     never "Signal is weak".
 */
export interface MetricGateInput {
  value: number | undefined;
  conf: number | undefined;
  published: boolean;
}

/**
 * Used only until the bridge's `hello` (which carries `minConf` from the
 * bridge's `VITALS_MIN_CONF`, default 0.6 per CONTRACTS.md §3). Not a clinical
 * threshold: the rules engine applies its own from `vitals_corroboration.json`.
 */
export const FALLBACK_MIN_CONF = 0.6;

/** Flags that mean "the picture is degraded" rather than "not ready yet". */
export const DEGRADED_FLAGS: ReadonlySet<string> = new Set([
  "face_not_found",
  "low_light",
  "motion",
  "talking",
]);

export type MetricKey = "pulse" | "breathing" | "hrv";

export const METRIC_KEYS: readonly MetricKey[] = ["pulse", "breathing", "hrv"];

export function gatePendingFlag(metric: MetricKey): string {
  return `gate_pending_${metric}`;
}

export function lowConfFlag(metric: MetricKey): string {
  return `low_conf_${metric}`;
}

export function metricReady(
  view: MetricGateInput,
  minConf: number,
  flags: string[],
  lowConf: string,
): boolean {
  if (!view.published) return false;
  if (view.value === undefined || !Number.isFinite(view.value)) return false;
  if (flags.includes(lowConf)) return false;
  if (view.conf === undefined) return true; // source gave no confidence; the bridge already gated it
  return view.conf >= minConf;
}

export type MetricSlot = "value" | "collecting" | "not_available";

export interface MetricSlotInput extends MetricGateInput {
  metric: MetricKey;
  /** Seconds of continuous collection reported by the bridge. */
  elapsedS: number;
  /** The metric's timing gate in seconds (from `hello.gates`). */
  gateS: number;
}

/**
 * What a metric slot shows.
 *   - "value"          the number (all four gating conditions hold)
 *   - "not_available"  the gate has elapsed but the source has no value for it
 *   - "collecting"     otherwise (gate pending, or weak signal that may improve)
 */
export function metricSlot(input: MetricSlotInput, minConf: number, flags: string[]): MetricSlot {
  if (metricReady(input, minConf, flags, lowConfFlag(input.metric))) return "value";
  const gatePending = flags.includes(gatePendingFlag(input.metric)) || input.elapsedS < input.gateS;
  if (!gatePending && (input.value === undefined || !Number.isFinite(input.value))) {
    return "not_available";
  }
  return "collecting";
}

export type SignalQuality = "unavailable" | "collecting" | "degraded" | "good";

export interface SignalQualityInput {
  /** Socket down, source error, or the kiosk's session is not being captured. */
  unavailable: boolean;
  /** Whether any sample has arrived yet. */
  hasSample: boolean;
  flags: string[];
  /** Per published metric (published flag true): its confidence, if reported. */
  publishedConfs: Array<number | undefined>;
  /** Metrics the bridge marked `low_conf_<metric>` among those with a value. */
  lowConfPublished: boolean;
}

/**
 * Header verdict. Gate-pending metrics carry no confidence at all, so they are
 * never counted against the signal; a sample with nothing published yet is
 * "collecting", not "weak". A degraded-capture flag (face lost, motion, …) is
 * reported as weak at any time, because it describes the picture, not the gate.
 */
export function signalQuality(input: SignalQualityInput, minConf: number): SignalQuality {
  if (input.unavailable) return "unavailable";
  if (!input.hasSample) return "collecting";
  if (input.flags.some((f) => DEGRADED_FLAGS.has(f))) return "degraded";
  if (input.lowConfPublished) return "degraded";
  if (input.publishedConfs.length === 0) return "collecting";
  const weak = input.publishedConfs.some((c) => c !== undefined && c < minConf);
  return weak ? "degraded" : "good";
}

export const QUALITY_TEXT: Record<SignalQuality, string> = {
  unavailable: "No signal",
  collecting: "Collecting",
  degraded: "Signal is weak",
  good: "Good signal",
};
