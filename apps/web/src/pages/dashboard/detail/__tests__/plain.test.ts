/**
 * Pure plain-language helpers (detail/plain.ts): labels, rule sentences that
 * mirror interim_rules.plain_language.rule_sentence, protocol chips, missing
 * medication-form fields, clock merging and the clock-decision gate.
 */
import { describe, expect, it } from "vitest";

import {
  attributionClockEffects,
  attributionClockHint,
  canRecordDecision,
  clocksForDraft,
  clocksOf,
  cmMissingText,
  decisionString,
  fieldLabel,
  plainDraftTitle,
  protocolChip,
  ruleSentence,
  tierName,
} from "../plain";
import type { ClockRow } from "../../../../lib/types";

const clock = (over: Partial<ClockRow> = {}): ClockRow => ({
  id: "C1",
  session_id: null,
  usubjid: "P",
  site_awareness_at: "2026-10-10T00:00:00Z",
  due_at: "2026-10-11T00:00:00Z",
  stopped_at: null,
  stopped_by: null,
  decision: null,
  seconds_remaining: 1,
  informational: {},
  ...over,
});

describe("plain helpers", () => {
  it("labels fields from the API first, the local table second, a humanized name last", () => {
    expect(fieldLabel("AETOXGR", { AETOXGR: "From API" })).toBe("From API");
    expect(fieldLabel("AETOXGR")).toBe("Severity grade (provisional)");
    expect(fieldLabel("INTERIM_SOMETHING_NEW")).toBe("Something new");
  });

  it("uses the explicit tier names", () => {
    expect(tierName(0)).toBe("Log");
    expect(tierName(1)).toBe("Review within 1 business day");
    expect(tierName(3)).toBe("Urgent");
  });

  it("fills rule templates from inputs, with aliases, labels and fallbacks", () => {
    const base = { category: "conmed", description: "engine text", effect: "", evidence: [] };
    expect(
      ruleSentence({
        ...base,
        rule_id: "conmed.exact",
        inputs: { verbatim: "Claritin", matched_name: "loratadine" },
      } as never),
    ).toBe("The medication 'Claritin' was found in the medication list as loratadine.");
    // Missing placeholder → the input-free fallback, never a half sentence.
    expect(ruleSentence({ ...base, rule_id: "conmed.exact", inputs: {} } as never)).toBe(
      "The medication was found in the medication list.",
    );
    // render_as field_label + alias cm_missing_fields → missing_fields.
    expect(
      ruleSentence({
        ...base,
        rule_id: "protocol.cm_fields_missing",
        inputs: { cm_missing_fields: ["CMDOSE", "CMINDC"] },
      } as never),
    ).toBe("The medication record still needs: Dose, Taken for.");
    // A leading placeholder is capitalized.
    expect(
      ruleSentence({
        ...base,
        rule_id: "protocol.conmed_permitted",
        inputs: { drug: "denosumab" },
      } as never),
    ).toBe("Denosumab is allowed by the study protocol.");
    // Unknown rule → the engine's description; API plain text beats everything.
    expect(ruleSentence({ ...base, rule_id: "x.y", inputs: {} } as never)).toBe("engine text");
    expect(
      ruleSentence({ ...base, rule_id: "conmed.exact", inputs: {}, plain: "API says" } as never),
    ).toBe("API says");
  });

  it("builds protocol chips with sections and exception hover text", () => {
    expect(protocolChip("prohibited")?.text).toBe("Prohibited by protocol §7.7.1");
    const d = protocolChip("discouraged", {
      level: "discouraged",
      drug: "prednisone",
      exception_text: "except to treat an irAE.",
    });
    expect(d?.text).toBe("Discouraged by protocol §7.7.2");
    expect(d?.title).toBe("Protocol exception: except to treat an irAE.");
    expect(protocolChip(null)).toBeNull();
  });

  it("lists the missing medication-form fields in short words", () => {
    expect(cmMissingText(["CMDOSE", "CMDOSFRQ", "CMINDC"])).toBe(
      "Still needed for the medication form: dose, frequency, indication",
    );
    expect(cmMissingText([])).toBeNull();
    expect(cmMissingText(undefined)).toBeNull();
  });

  it("titles drafts in plain words", () => {
    expect(plainDraftTitle("AE", { AEDECOD: "Diarrhea", AETOXGR: 3 })).toBe(
      "Side effect: Diarrhea, severe (grade 3, provisional)",
    );
    expect(plainDraftTitle("CM", { CMTRT: "prednisone" })).toBe("Medication change: prednisone");
  });

  it("merges sae_clock, aesi_clock and clocks[] without duplicates", () => {
    const sae = clock({ id: "S" });
    const aesi = clock({ id: "A" });
    const merged = clocksOf({ sae_clock: sae, aesi_clock: aesi, clocks: [sae] });
    expect(merged.map((c) => [c.id, c.kind ?? "sae"])).toEqual([
      ["S", "sae"],
      ["A", "aesi"],
    ]);
  });

  it("offers the clock decision only to an investigator, on a running clock with no AE draft", () => {
    expect(canRecordDecision(clock(), "investigator", false)).toBe(true);
    expect(canRecordDecision(clock(), "investigator", null)).toBe(true);
    expect(canRecordDecision(clock(), "investigator", true)).toBe(false);
    expect(canRecordDecision(clock(), "coordinator", false)).toBe(false);
    expect(canRecordDecision(clock({ stopped_at: "x" }), "investigator", false)).toBe(false);
    expect(decisionString("Y")).toBe("AESER = Y");
  });

  it("never offers the seriousness decision on a possible-AESI clock (it asks 'immune-related?')", () => {
    // The real API row: kind "aesi" and no has_ae_draft / ae_draft_ids hint.
    expect(canRecordDecision(clock({ kind: "aesi" }), "investigator", null)).toBe(false);
    expect(canRecordDecision(clock({ kind: "aesi" }), "investigator", false)).toBe(false);
    expect(canRecordDecision(clock({ kind: "sae" }), "investigator", null)).toBe(true);
  });

  it("describes only the clocks an attribution actually stops, by kind", () => {
    const sae = clock({ id: "S", kind: "sae" });
    const aesi = clock({ id: "A", kind: "aesi" });
    // AESER stops the SAE clock only.
    expect(attributionClockEffects({ AESER: "Y" }, [sae, aesi])).toEqual([
      expect.stringMatching(/serious-event report clock has been stopped/),
    ]);
    // AESER with only an AESI clock running: nothing is stopped.
    expect(attributionClockEffects({ AESER: "Y" }, [aesi])).toEqual([]);
    // No clock at all: nothing to say.
    expect(attributionClockEffects({ AESER: "N" }, [])).toEqual([]);
    // INTERIM_IRAE = N stops the AESI clock; Y does not.
    expect(attributionClockEffects({ INTERIM_IRAE: "N" }, [sae, aesi])).toEqual([
      expect.stringMatching(/special-interest report clock has been stopped/),
    ]);
    expect(attributionClockEffects({ INTERIM_IRAE: "Y" }, [aesi])).toEqual([]);
    // A stopped clock is not stopped again.
    expect(attributionClockEffects({ AESER: "Y" }, [clock({ stopped_at: "x" })])).toEqual([]);
  });

  it("hints which answer stops which running clock", () => {
    expect(attributionClockHint([])).toBeNull();
    expect(attributionClockHint([clock({ kind: "sae", stopped_at: "x" })])).toBeNull();
    expect(attributionClockHint([clock({ kind: "sae" })])).toMatch(/^Deciding "Serious\?" stops/);
    const aesiOnly = attributionClockHint([clock({ kind: "aesi" })]);
    expect(aesiOnly).toMatch(/Immune-related\? No/);
    expect(aesiOnly).not.toMatch(/^Deciding "Serious\?" stops/);
  });

  it("limits attribution clocks to the draft's own source", () => {
    const here = clock({ id: "H", session_id: "S1" });
    const other = clock({ id: "O", session_id: "S0" });
    const note = clock({ id: "N", session_id: null, note_id: "N1" });
    expect(clocksForDraft([here, other, note], { session_id: "S1" }).map((c) => c.id)).toEqual([
      "H",
    ]);
    expect(
      clocksForDraft([here, note], { session_id: null, note_id: "N1" }).map((c) => c.id),
    ).toEqual(["N"]);
  });
});
