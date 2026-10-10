/**
 * Pure helpers behind the kiosk: item wording from the rules tables, the
 * optional temperature, verbatim gate bodies, USUBJID composition and the
 * answer book-keeping.
 */
import { describe, expect, it } from "vitest";

import { answerKey, flattenAnswers, missingAnswers } from "../lib/answers";
import {
  parseTemperature,
  promptFor,
  recallLine,
  stripLeadingIn,
  temperatureField,
  temperatureProblem,
} from "../lib/format";
import { buildGatesBody, gatePrompts, INITIAL_GATE_STATE } from "../lib/gates";
import { resolveUsubjid } from "../lib/participant";
import type { Item } from "../lib/types";
import { FEVER_ITEM_TABLE, GATES_TABLE, ITEMS, SOB_ITEM_TABLE } from "./fixtures";

describe("item wording from the rules table", () => {
  it("promptFor prefers prompts.<attr>, then attribute_prompts, then the generic fallback", () => {
    expect(promptFor(SOB_ITEM_TABLE, "severity")).toBe(
      "In the last 7 days, how bad was your shortness of breath when it was at its worst?",
    );
    const legacy: Item = {
      ...ITEMS.items[0],
      attribute_prompts: { severity: "Legacy severity stem" },
    };
    expect(promptFor(legacy, "severity")).toBe("Legacy severity stem");
    expect(promptFor(ITEMS.items[0], "severity")).toBe("How bad was it at its worst?");
  });

  it("drops the recall line when every prompt already states the window, else phrases it grammatically", () => {
    expect(recallLine(SOB_ITEM_TABLE, "in the last 7 days")).toBeNull();
    expect(recallLine(FEVER_ITEM_TABLE, "in the last 7 days")).toBeNull();
    // Fixture item without prompts: generic stems, so the helper line is needed,
    // and "in the last 7 days" must not become "Think about in the last 7 days."
    expect(recallLine(ITEMS.items[0], "in the last 7 days")).toBe("Think about the last 7 days.");
    expect(recallLine({ ...ITEMS.items[0], recall_window: "" }, "the last 7 days")).toBe(
      "Think about the last 7 days.",
    );
    expect(stripLeadingIn("In the last 7 days")).toBe("the last 7 days");
  });
});

describe("optional temperature (table-driven)", () => {
  it("reads label, unit and bounds from optional_fields and never invents bounds", () => {
    const f = temperatureField(FEVER_ITEM_TABLE);
    expect(f).toEqual({
      id: "temp_c",
      label: "If you took your temperature, what was the highest reading? (optional)",
      unit: "°C",
      min: 34,
      max: 43,
      note: "Participant-typed, not device-measured. Evidence only; it never changes the provisional grade.",
    });
    expect(temperatureField(SOB_ITEM_TABLE)).toBeNull();
    // Legacy shape and bare fever id: a field with no bounds.
    expect(temperatureField({ ...ITEMS.items[2], id: "fever_or_chills" })?.min).toBeUndefined();
    expect(
      temperatureField({
        ...ITEMS.items[2],
        optional_numeric: { id: "temp_c", label: "Temp", unit: "°F" },
      }),
    ).toMatchObject({ unit: "°F", min: undefined, max: undefined });
  });

  it("parseTemperature validates against the table's bounds", () => {
    const f = temperatureField(FEVER_ITEM_TABLE);
    expect(parseTemperature("", f)).toEqual({ kind: "empty" });
    expect(parseTemperature("   ", f)).toEqual({ kind: "empty" });
    expect(parseTemperature("38.5", f)).toEqual({ kind: "ok", value: 38.5 });
    expect(parseTemperature("3850", f)).toEqual({ kind: "out_of_range", value: 3850 });
    expect(parseTemperature("20", f)).toEqual({ kind: "out_of_range", value: 20 });
    expect(parseTemperature("abc", f)).toEqual({ kind: "invalid" });
    expect(parseTemperature("1e3", f)).toEqual({ kind: "invalid" });
    // Without bounds in the table nothing is out of range.
    expect(parseTemperature("3850", null)).toEqual({ kind: "ok", value: 3850 });
    expect(temperatureProblem({ kind: "out_of_range", value: 3850 }, f)).toBe(
      "Please enter a temperature between 34 and 43 °C, or leave this empty.",
    );
    expect(temperatureProblem({ kind: "invalid" }, f)).toBe(
      "Please enter a number in °C, or leave this empty.",
    );
    expect(temperatureProblem({ kind: "ok", value: 37 }, f)).toBeNull();
  });
});

describe("gate wording and body", () => {
  it("gatePrompts maps the table's text_prompt / direction_prompt / note with fallbacks", () => {
    expect(gatePrompts(GATES_TABLE)).toEqual({
      conmedText: "Please type the name of the medication as it appears on the label.",
      conmedTextNote: "Spelling does not need to be perfect; the study team will check it.",
      conmedDirection: "Did you start it, stop it, or both?",
      otherNote: "Stored verbatim and never parsed by software. It is read by a person.",
    });
    expect(gatePrompts(ITEMS.gates)).toEqual({
      conmedText: "What is the name of the medication?",
      conmedTextNote: "Spelling does not need to be perfect; the study team will check it.",
      conmedDirection: "Did you start it, stop it, or both?",
      otherNote:
        "You can leave this empty. Whatever you write is passed to the study team exactly as typed.",
    });
    expect(
      gatePrompts([
        {
          id: "conmed",
          label: "x",
          prompts: { conmed_text: "Legacy text", conmed_direction: "D" },
        },
        { id: "other", label: "y", prompts: { other_hint: "Legacy hint" } },
      ]),
    ).toMatchObject({ conmedText: "Legacy text", conmedDirection: "D", otherNote: "Legacy hint" });
  });

  it("buildGatesBody sends con-med and free text verbatim and temp_c only when given", () => {
    const body = buildGatesBody(
      {
        ...INITIAL_GATE_STATE,
        hospitalization: false,
        conmedChanged: true,
        conmedText: "  loratadine ",
        conmedDirection: "started",
        otherText: " feeling ok\n",
      },
      38.5,
      "2026-10-10T18:00:00.000Z",
    );
    expect(body).toEqual({
      hospitalization: false,
      conmed_changed: true,
      conmed_text: "  loratadine ",
      conmed_direction: "started",
      other_text: " feeling ok\n",
      temp_c: 38.5,
      ts_client: "2026-10-10T18:00:00.000Z",
    });
    // Whitespace-only text is treated as empty; con-med text is dropped when the answer is No.
    const none = buildGatesBody(
      {
        ...INITIAL_GATE_STATE,
        hospitalization: true,
        conmedChanged: false,
        conmedText: "x",
        otherText: "   ",
      },
      null,
      "t",
    );
    expect(none).toEqual({ hospitalization: true, conmed_changed: false, ts_client: "t" });
  });
});

describe("resolveUsubjid", () => {
  it("composes {study_id}-{label} and keeps the label as the 404 fallback", () => {
    expect(resolveUsubjid(" p-007 ", "R2810-ONC-1624")).toEqual({
      primary: "R2810-ONC-1624-P-007",
      fallback: "P-007",
    });
  });
  it("passes a full USUBJID (or a bare id with no study loaded) through unchanged", () => {
    expect(resolveUsubjid("R2810-ONC-1624-P-007", "R2810-ONC-1624")).toEqual({
      primary: "R2810-ONC-1624-P-007",
      fallback: null,
    });
    expect(resolveUsubjid("r2810-onc-1624-p-007", "R2810-ONC-1624").primary).toBe(
      "R2810-ONC-1624-P-007",
    );
    expect(resolveUsubjid("P-007", null)).toEqual({ primary: "P-007", fallback: null });
    expect(resolveUsubjid("P-007", "")).toEqual({ primary: "P-007", fallback: null });
  });
});

describe("answer book-keeping", () => {
  it("keys answers by item:attribute and finds the ones the API never acknowledged", () => {
    expect(answerKey("cough", "severity")).toBe("cough:severity");
    const answers = {
      shortness_of_breath: { severity: 2, interference: 2 },
      cough: { severity: 1 },
    };
    expect(flattenAnswers(answers)).toEqual([
      { item_id: "shortness_of_breath", attribute: "severity", value: 2 },
      { item_id: "shortness_of_breath", attribute: "interference", value: 2 },
      { item_id: "cough", attribute: "severity", value: 1 },
    ]);
    const acked = new Set(["shortness_of_breath:severity"]);
    const pending = new Set(["cough:severity"]);
    expect(missingAnswers(answers, acked, pending)).toEqual([
      { item_id: "shortness_of_breath", attribute: "interference", value: 2 },
    ]);
    expect(
      missingAnswers(
        answers,
        new Set([
          "shortness_of_breath:severity",
          "shortness_of_breath:interference",
          "cough:severity",
        ]),
      ),
    ).toEqual([]);
  });
});
