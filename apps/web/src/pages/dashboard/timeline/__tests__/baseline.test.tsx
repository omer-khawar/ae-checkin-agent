/**
 * Regression: the Synthea background chart the API sends under `baseline` was
 * not rendered anywhere (timeline or brief). It must render, and always say
 * "simulated".
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { normalizeBaseline } from "../baseline";
import { BaselineCard } from "../BaselineCard";

const BASELINE = {
  label: "Synthea synthetic EHR (simulated)",
  source: "Synthea synthetic EHR (simulated)",
  is_measured: false,
  synthea_ref: "8a7d60834788",
  sex: "male",
  age_at_reference: 67,
  nsclc_display: "Non-small cell carcinoma of lung, TNM stage 1 (disorder)",
  nsclc_diagnosis_date: "2025-02-02",
  comorbidities: ["Anemia (disorder)", "Essential hypertension (disorder)"],
  active_medications: ["clopidogrel", "insulin"],
  prior_cancer_therapy: [{ ingredient: "cisplatin", n_administrations: 106 }],
  smoking: "former",
  pulse_bpm: { median: 83.0, unit: "beats/min", n_observations: 3 },
  breathing_bpm: { median: 13.0, unit: "breaths/min", n_observations: 3 },
};

describe("BaselineCard", () => {
  it("renders the Synthea baseline labeled simulated", () => {
    render(<BaselineCard baseline={BASELINE} />);
    const card = screen.getByTestId("synthea-baseline");
    expect(card).toHaveTextContent("Synthea synthetic EHR (simulated)");
    expect(card).toHaveTextContent("SIMULATED");
    expect(card).toHaveTextContent("83 beats/min (median of 3 visits)");
    expect(card).toHaveTextContent("cisplatin");
    expect(card).toHaveTextContent("67-year-old male");
  });

  it("never shows a baseline as measured and always says simulated", () => {
    const b = normalizeBaseline({ ...BASELINE, is_measured: true, label: "Synthea" });
    expect(b?.is_measured).toBe(false);
    render(<BaselineCard baseline={{ ...BASELINE, is_measured: true, label: "Synthea" }} />);
    expect(screen.getByTestId("synthea-baseline")).toHaveTextContent("Synthea (simulated)");
  });

  it("renders nothing without a baseline", () => {
    const { container } = render(<BaselineCard baseline={null} />);
    expect(container).toBeEmptyDOMElement();
    expect(normalizeBaseline("nope")).toBeNull();
  });
});
