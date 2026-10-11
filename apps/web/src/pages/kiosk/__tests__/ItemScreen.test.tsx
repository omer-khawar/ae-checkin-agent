/**
 * Regression (intake e2e walkthrough): the symptom screens said "Question 1 of 10"
 * and then the first gate said "Question 11 of 13". The counter must count every
 * screen of the check-in (items + gates) when the flow passes `screenTotal`.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { Item } from "../../../lib/types";
import { ItemScreen } from "../ItemScreen";

const item = {
  id: "cough",
  order: 2,
  label: "Cough",
  short_label: "Cough",
  ctcae_term: "Cough",
  attributes: ["severity"],
  prompts: { severity: "In the last 7 days, how bad was your cough?" },
  response_options: { severity: { None: 0, Mild: 1 } },
  recall_window: "in the last 7 days",
} as unknown as Item;

function renderScreen(extra: { screenTotal?: number }) {
  render(
    <ItemScreen
      item={item}
      index={9}
      total={10}
      {...extra}
      recallWindow="the last 7 days"
      values={{}}
      onSelect={() => undefined}
      tempC=""
      onTempChange={() => undefined}
      canBack
      onBack={() => undefined}
      canNext={false}
      nextBusy={false}
      onNext={() => undefined}
      error={null}
      onRetry={() => undefined}
    />,
  );
}

describe("ItemScreen question counter", () => {
  it("counts gate screens too when screenTotal is given", () => {
    renderScreen({ screenTotal: 13 });
    expect(screen.getByText(/Question 10 of 13/)).toBeInTheDocument();
    // The last symptom item still says "Continue" (gates follow).
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
  });

  it("falls back to the item count", () => {
    renderScreen({});
    expect(screen.getByText(/Question 10 of 10/)).toBeInTheDocument();
  });
});
