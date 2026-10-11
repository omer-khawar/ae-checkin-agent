/**
 * Typed view of the Synthea background chart the API sends under `baseline`
 * (timeline and brief). Read defensively: anything malformed becomes null.
 * Synthea is synthetic by construction, so `is_measured` is always false.
 */
export interface BaselineVital {
  median: number;
  unit: string;
  n_observations: number;
}

export interface SyntheaBaseline {
  label: string;
  is_measured: boolean;
  synthea_ref: string | null;
  sex: string | null;
  age_at_reference: number | null;
  nsclc_display: string | null;
  nsclc_diagnosis_date: string | null;
  comorbidities: string[];
  active_medications: string[];
  prior_cancer_therapy: string[];
  smoking: string | null;
  pulse_bpm: BaselineVital | null;
  breathing_bpm: BaselineVital | null;
}

function rec(x: unknown): Record<string, unknown> | null {
  return x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
}
function str(x: unknown): string | null {
  return typeof x === "string" && x.trim() !== "" ? x : null;
}
function num(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}
function strList(x: unknown): string[] {
  return Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : [];
}
function vital(x: unknown): BaselineVital | null {
  const r = rec(x);
  const median = num(r?.median);
  if (!r || median === null) return null;
  return { median, unit: str(r.unit) ?? "", n_observations: num(r.n_observations) ?? 0 };
}

/** The API's `baseline` object → a typed view, or null when there is none. */
export function normalizeBaseline(x: unknown): SyntheaBaseline | null {
  const r = rec(x);
  if (!r) return null;
  const therapy = Array.isArray(r.prior_cancer_therapy)
    ? r.prior_cancer_therapy
        .map((t) => (typeof t === "string" ? t : str(rec(t)?.ingredient)))
        .filter((t): t is string => t !== null)
    : [];
  return {
    // Whatever the server calls it, the label always says "simulated".
    label: str(r.label) ?? str(r.source) ?? "Synthea synthetic EHR (simulated)",
    // Synthea is synthetic by construction: never shown as measured.
    is_measured: false,
    synthea_ref: str(r.synthea_ref),
    sex: str(r.sex),
    age_at_reference: num(r.age_at_reference),
    nsclc_display: str(r.nsclc_display),
    nsclc_diagnosis_date: str(r.nsclc_diagnosis_date),
    comorbidities: strList(r.comorbidities),
    active_medications: strList(r.active_medications),
    prior_cancer_therapy: therapy,
    smoking: str(r.smoking),
    pulse_bpm: vital(r.pulse_bpm),
    breathing_bpm: vital(r.breathing_bpm),
  };
}
