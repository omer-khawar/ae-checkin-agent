/**
 * Eval page against a mocked API (CONTRACTS.md §2.2 eval endpoints).
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";

import type {
  CheckInResult,
  EvalPersonaSummary,
  EvalResults,
  Persona,
} from "../../../../lib/types";
import { GATES_TABLE, ITEMS, ITEMS_TABLE_SHAPE } from "../../../../test/fixtures";
import { installMockFetch, type Route as MockRoute } from "../../../../test/mockFetch";
import { FALLBACK_GATE_PROMPTS } from "../../../../lib/gates";
import { Eval } from "../../Eval";
import { CustomResultView } from "../CustomResultView";
import { buildPersona, demoFormState, withResponse } from "../personaForm";
import { generateSamples, VITALS_PRESETS } from "../vitalsPresets";

const PERSONAS: EvalPersonaSummary[] = [
  {
    id: "T1-dyspnea-moderate",
    name: "Moderate shortness of breath, started loratadine",
    category: "tier1",
    hidden: false,
    description: "The demo persona.",
    expected_tier: 1,
  },
  {
    id: "T3-severe-dyspnea",
    name: "Severe shortness of breath",
    category: "tier3",
    hidden: false,
    description: "Red flag.",
    expected_tier: 3,
  },
  {
    id: "J-toggle-only-tachycardia-dyspnea",
    name: "Judge: toggle-only tachycardia",
    category: "judge",
    hidden: true,
    description: "Hidden judge persona.",
    expected_tier: 2,
  },
];

const RESULTS: EvalResults = {
  run_id: "01JRUN0000000000000000000A",
  ran_at: "2026-10-10T18:30:00.000Z",
  include_hidden: false,
  n_personas: 2,
  n_pass: 2,
  n_fail: 0,
  tier_metrics: {
    "0": { precision: 1, recall: 1, f1: 1, support: 0 },
    "1": { precision: 1, recall: 1, f1: 1, support: 1 },
    "2": { precision: 1, recall: 1, f1: 1, support: 0 },
    "3": { precision: 0.5, recall: 1, f1: 0.667, support: 1 },
  },
  grade_confusion: [
    [17, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    // The T3 persona's dyspnea came back G2: one off-diagonal cell.
    [0, 0, 1, 0],
  ],
  dedup_correct: { n: 1, correct: 1 },
  sae_clock_correct: { n: 2, correct: 2 },
  conmed_correct: { n: 1, correct: 1 },
  per_persona: [
    {
      persona_id: "T1-dyspnea-moderate",
      name: "Moderate shortness of breath, started loratadine",
      hidden: false,
      pass: true,
      expected: { tier: 1 },
      actual: { tier: 1 },
      mismatches: [],
      session_id: "01JSESSIONEVAL00000000000A",
    },
    {
      persona_id: "T3-severe-dyspnea",
      name: "Severe shortness of breath",
      hidden: false,
      pass: false,
      expected: { tier: 3 },
      actual: { tier: 2 },
      mismatches: ["tier: expected 3, got 2"],
      session_id: null,
    },
  ],
  markdown: "# Eval results\n\nAll good.",
};

function checkInResult(tier: number, sobGrade: number): CheckInResult {
  return {
    items: [
      {
        item_id: "shortness_of_breath",
        label: "Shortness of breath",
        aedecod: "Dyspnea",
        composite: sobGrade,
        provisional_grade: sobGrade,
        responses: [],
        evidence: [],
      },
      {
        item_id: "cough",
        label: "Cough",
        aedecod: "Cough",
        composite: 1,
        provisional_grade: 1,
        responses: [],
        evidence: [],
      },
    ],
    max_grade: sobGrade,
    base_tier: Math.min(2, Math.max(0, sobGrade - 1)),
    red_flag_tier_floor: tier === 3 ? 3 : 0,
    corroboration_bump: 0,
    escalation_tier: tier,
    stop_screen: tier === 3,
    page_oncall: tier === 3,
    seriousness_suspected: false,
    sae_clock: null,
    conmed: {
      verbatim: "loratadine",
      matched_name: "loratadine",
      match_kind: "exact",
      confidence: 1,
      distance: null,
      candidates: [],
    },
    vitals: {
      status: "simulated_ignored",
      eligible_sample_ids: [],
      ignored: [["01JSAMPLE1", "simulated source with demo toggle OFF"]],
      summary: {
        n_samples: 11,
        n_eligible: 0,
        pulse_median: 72,
        pulse_max: 74,
        breathing_median: 14,
        breathing_max: 15,
        hrv_median: null,
        is_measured: false,
        source: "mock",
        first_ts: "2026-10-10T18:00:20.000Z",
        last_ts: "2026-10-10T18:00:40.000Z",
      },
      rules_fired: [],
    },
    drafts: [
      { domain: "AE", fields: [], linked_ae_open_id: null, is_followup: false },
      { domain: "AE", fields: [], linked_ae_open_id: null, is_followup: false },
      { domain: "VS", fields: [], linked_ae_open_id: null, is_followup: false },
      { domain: "CM", fields: [], linked_ae_open_id: null, is_followup: false },
    ],
    rules_fired: [
      {
        rule_id: "grade.provisional.shortness_of_breath",
        category: "grading",
        description: `Shortness of breath composite ${sobGrade} → provisional grade ${sobGrade}.`,
        inputs: {},
        effect: `AETOXGR = ${sobGrade}`,
        evidence: [],
      },
      {
        rule_id: "tier.final",
        category: "escalation",
        description: `Final escalation tier ${tier}.`,
        inputs: {},
        effect: `tier = ${tier}`,
        evidence: [],
      },
    ],
    why: [],
  };
}

interface Opts {
  storedResults?: EvalResults | null;
  personasStatus?: number;
}

function routes(opts: Opts = {}): MockRoute[] {
  return [
    { method: "GET", path: "/api/v1/items", handler: () => ({ json: ITEMS }) },
    {
      method: "GET",
      path: "/api/v1/eval/personas",
      handler: () =>
        opts.personasStatus && opts.personasStatus >= 400
          ? {
              status: opts.personasStatus,
              json: { type: "about:blank", title: "Server Error", status: opts.personasStatus },
            }
          : { json: PERSONAS },
    },
    {
      method: "GET",
      path: "/api/v1/eval/results",
      handler: () =>
        opts.storedResults
          ? { json: opts.storedResults }
          : {
              status: 404,
              json: { type: "about:blank", title: "Not Found", status: 404, detail: "no run yet" },
            },
    },
    {
      method: "POST",
      path: "/api/v1/eval/run",
      handler: ({ body }) => {
        const b = body as { include_hidden?: boolean; persona_ids?: string[] };
        return { json: { ...RESULTS, include_hidden: Boolean(b.include_hidden) } };
      },
    },
    {
      method: "POST",
      path: "/api/v1/eval/run-custom",
      handler: ({ body }) => {
        const persona = (body as { persona: Persona }).persona;
        const sev = persona.responses.shortness_of_breath?.severity ?? 0;
        // A stand-in for the engine: Severe → Tier 3 red flag; Moderate → Tier 1.
        const tier = sev >= 3 ? 3 : sev === 2 ? 1 : 0;
        return {
          json: {
            persona,
            result: checkInResult(tier, Math.min(3, sev)),
            session_id: "01JSESSIONCUSTOM000000000A",
          },
        };
      },
    },
  ];
}

function renderEval() {
  return render(
    <MemoryRouter initialEntries={["/dashboard/eval"]}>
      <Routes>
        <Route path="/dashboard/eval" element={<Eval />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Eval page", () => {
  it("lists personas with expected tiers and marks hidden judge personas", async () => {
    installMockFetch(routes());
    renderEval();
    const table = await screen.findByTestId("persona-list");
    expect(
      within(table).getByText("Moderate shortness of breath, started loratadine"),
    ).toBeInTheDocument();
    expect(within(table).getAllByText("hidden")).toHaveLength(1);
    // Tier chips carry the tier number and name.
    expect(
      within(table).getAllByTitle("Tier 1: Review within 1 business day").length,
    ).toBeGreaterThan(0);
    expect(within(table).getByTitle("Tier 3: Urgent")).toBeInTheDocument();
    expect(screen.getByText("No run yet.", { exact: false })).toBeInTheDocument();
  });

  it("shows the stored run on load and labels it", async () => {
    installMockFetch(routes({ storedResults: RESULTS }));
    renderEval();
    expect(await screen.findByTestId("eval-results")).toBeInTheDocument();
    expect(screen.getByText("Showing the last stored run.")).toBeInTheDocument();
  });

  it("runs the shipped personas and renders tiles, tier metrics, confusion matrix and per-persona rows", async () => {
    const user = userEvent.setup();
    const mock = installMockFetch(routes());
    renderEval();
    await screen.findByTestId("persona-list");

    await user.click(screen.getByRole("button", { name: /Run the shipped personas \(2\)/ }));
    const results = await screen.findByTestId("eval-results");

    const runCall = mock.calls.find((c) => c.method === "POST" && c.path === "/api/v1/eval/run");
    expect(runCall?.body).toEqual({ include_hidden: false });

    expect(within(results).getByText("Personas run").nextSibling).toHaveTextContent("2");
    expect(within(results).getByText("Pass rate").nextSibling).toHaveTextContent("100%");

    const matrix = within(results).getByTestId("confusion-matrix");
    const g0 = within(matrix).getByTitle("Expected G0, actual G0: 17 (correct)");
    expect(g0).toHaveTextContent("17");
    expect(within(matrix).getByText(/19 \/ 20/)).toBeInTheDocument();
    expect(within(matrix).getByTitle("Expected G3, actual G2: 1")).toHaveTextContent("1");

    const perPersona = within(results).getByTestId("per-persona-table");
    expect(within(perPersona).getByText("pass")).toBeInTheDocument();
    expect(within(perPersona).getByText("fail")).toBeInTheDocument();
    expect(within(perPersona).getByText("tier: expected 3, got 2")).toBeInTheDocument();
    expect(within(perPersona).getByRole("link", { name: "open check-in" })).toHaveAttribute(
      "href",
      "/dashboard/checkins/01JSESSIONEVAL00000000000A",
    );
    // Time shows UTC on hover.
    expect(screen.getByTitle("2026-10-10T18:30:00.000Z (UTC)")).toBeInTheDocument();
    // Markdown block is there, collapsed.
    expect(screen.getByText(/Full report \(markdown/)).toBeInTheDocument();
  });

  it("runs only the hidden judge personas when asked", async () => {
    const user = userEvent.setup();
    const mock = installMockFetch(routes());
    renderEval();
    await screen.findByTestId("persona-list");
    await user.click(screen.getByRole("button", { name: /Run hidden judge personas \(1\)/ }));
    await screen.findByTestId("eval-results");
    const runCall = mock.calls.find((c) => c.method === "POST" && c.path === "/api/v1/eval/run");
    expect(runCall?.body).toEqual({
      include_hidden: true,
      persona_ids: ["J-toggle-only-tachycardia-dyspnea"],
    });
  });

  it("pre-fills the demo persona, runs it, and changing severity to Severe changes the tier", async () => {
    const user = userEvent.setup();
    const mock = installMockFetch(routes());
    renderEval();

    const severity = (await screen.findByLabelText(
      "Shortness of breath Severity",
    )) as HTMLSelectElement;
    expect(severity.value).toBe("2");
    // The ITEMS fixture gates carry no text_prompt, so the brief's fallback wording is used.
    expect(screen.getByLabelText(FALLBACK_GATE_PROMPTS.conmed_text)).toHaveValue("loratadine");
    // Preview is labeled simulated.
    expect(screen.getByTestId("sample-preview")).toBeInTheDocument();
    expect(screen.getAllByText("SIMULATED").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Run this persona" }));
    let result = await screen.findByTestId("custom-result");
    expect(within(result).getByTitle("Tier 1: Review within 1 business day")).toBeInTheDocument();
    expect(within(result).getByText("AE 2 · VS 1 · CM 1")).toBeInTheDocument();
    expect(within(result).getByRole("link", { name: "Open the replayed session" })).toHaveAttribute(
      "href",
      "/dashboard/checkins/01JSESSIONCUSTOM000000000A",
    );
    const firstPost = mock.calls.filter((c) => c.path === "/api/v1/eval/run-custom")[0];
    const sent = (firstPost.body as { persona: Persona }).persona;
    expect(sent.responses.shortness_of_breath).toEqual({ severity: 2, interference: 2 });
    expect(sent.responses.rash).toEqual({ presence: 0 });
    expect(sent.gates).toMatchObject({
      hospitalization: false,
      conmed_changed: true,
      conmed_text: "loratadine",
      conmed_direction: "started",
    });
    expect(sent.settings).toEqual({ simulated_as_measured: false });
    expect(sent.vitals_samples).toHaveLength(11);
    expect(sent.vitals_samples.every((s) => s.isMeasured === false && s.source === "mock")).toBe(
      true,
    );

    await user.selectOptions(severity, "3");
    await user.click(screen.getByRole("button", { name: "Run this persona" }));
    await waitFor(() => {
      result = screen.getByTestId("custom-result");
      expect(within(result).getByTitle("Tier 3: Urgent")).toBeInTheDocument();
    });
    expect(within(result).getByTestId("grade-shortness_of_breath")).toHaveTextContent("G3");
    expect(within(result).getByTestId("rules-fired")).toHaveTextContent("Final escalation tier 3.");
    // Every vitals value carries the SIMULATED word.
    expect(within(result).getAllByText("SIMULATED").length).toBeGreaterThanOrEqual(2);
  });

  it("sends the demo toggle and shows its warning", async () => {
    const user = userEvent.setup();
    const mock = installMockFetch(routes());
    renderEval();
    const toggle = await screen.findByLabelText("Treat simulated vitals as measured for this run");
    await user.click(toggle);
    expect(screen.getByRole("alert")).toHaveTextContent(/Warning/);
    await user.click(screen.getByRole("button", { name: "Run this persona" }));
    await screen.findByTestId("custom-result");
    const post = mock.calls.find((c) => c.path === "/api/v1/eval/run-custom");
    expect((post?.body as { persona: Persona }).persona.settings).toEqual({
      simulated_as_measured: true,
    });
  });

  it("shows an error banner when the persona catalogue fails", async () => {
    installMockFetch(routes({ personasStatus: 500 }));
    renderEval();
    expect(await screen.findByText("Could not load the persona catalogue")).toBeInTheDocument();
  });
});

/** `routes()` with one path's handler swapped out. */
function routesWith(
  method: MockRoute["method"],
  path: string,
  handler: MockRoute["handler"],
  opts: Opts = {},
): MockRoute[] {
  return [
    ...routes(opts).filter((r) => !(r.method === method && r.path === path)),
    { method, path, handler },
  ];
}

const PROBLEM_500 = {
  status: 500,
  json: { type: "about:blank", title: "Server Error", status: 500, detail: "engine failed" },
};

/** A promise the test releases by hand, to hold a mocked endpoint open. */
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("Eval page (review fixes)", () => {
  it("posts only the clicked persona from a catalogue Run button", async () => {
    const user = userEvent.setup();
    const mock = installMockFetch(routes());
    renderEval();
    await screen.findByTestId("persona-list");
    await user.click(
      screen.getByRole("button", { name: "Run persona Judge: toggle-only tachycardia" }),
    );
    await screen.findByTestId("eval-results");
    const runCall = mock.find("POST", "/api/v1/eval/run")[0];
    expect(runCall.body).toEqual({
      include_hidden: true,
      persona_ids: ["J-toggle-only-tachycardia-dyspnea"],
    });
  });

  it("keeps the hidden button disabled until the catalogue has loaded (never sends an empty id list)", async () => {
    const g = gate();
    installMockFetch(
      routesWith("GET", "/api/v1/eval/personas", async () => {
        await g.promise;
        return { json: PERSONAS };
      }),
    );
    renderEval();
    const btn = await screen.findByRole("button", { name: /Run hidden judge personas/ });
    expect(btn).toBeDisabled();
    // The shipped-set button does not need the catalogue.
    expect(screen.getByRole("button", { name: /Run the shipped personas/ })).toBeEnabled();
    g.release();
    await waitFor(() => expect(btn).toBeEnabled());
    expect(btn).toHaveTextContent("Run hidden judge personas (1)");
  });

  it("shows a run-failed banner whose retry repeats the same run", async () => {
    const user = userEvent.setup();
    let fail = true;
    const mock = installMockFetch(
      routesWith("POST", "/api/v1/eval/run", () => (fail ? PROBLEM_500 : { json: RESULTS })),
    );
    renderEval();
    await screen.findByTestId("persona-list");
    await user.click(screen.getByRole("button", { name: /Run the shipped personas/ }));
    const banner = await screen.findByText("The eval run failed");
    expect(banner.parentElement).toHaveTextContent("HTTP 500");
    expect(screen.queryByText("Could not load the last stored run")).not.toBeInTheDocument();

    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByTestId("eval-results");
    expect(screen.queryByText("The eval run failed")).not.toBeInTheDocument();
    expect(mock.find("POST", "/api/v1/eval/run")).toHaveLength(2);
    expect(mock.find("POST", "/api/v1/eval/run")[1].body).toEqual({ include_hidden: false });
  });

  it("reports a failed stored-results load as a load error, not a failed run", async () => {
    installMockFetch(routesWith("GET", "/api/v1/eval/results", () => PROBLEM_500));
    renderEval();
    expect(await screen.findByText("Could not load the last stored run")).toBeInTheDocument();
    expect(screen.queryByText("The eval run failed")).not.toBeInTheDocument();
    expect(screen.queryByText("No run yet.", { exact: false })).not.toBeInTheDocument();
  });

  it("shows 'Loading last run…' and no empty state until GET /eval/results settles", async () => {
    const g = gate();
    installMockFetch(
      routesWith("GET", "/api/v1/eval/results", async () => {
        await g.promise;
        return { json: RESULTS };
      }),
    );
    renderEval();
    expect(screen.getByText("Loading last run…")).toBeInTheDocument();
    expect(screen.queryByText("No run yet.", { exact: false })).not.toBeInTheDocument();
    g.release();
    await screen.findByTestId("eval-results");
    expect(screen.getByText("Showing the last stored run.")).toBeInTheDocument();
    expect(screen.queryByText("Loading last run…")).not.toBeInTheDocument();
  });

  it("announces the run outcome in a one-line live status, not the whole results block", async () => {
    const user = userEvent.setup();
    installMockFetch(routes());
    renderEval();
    await screen.findByTestId("persona-list");
    await user.click(screen.getByRole("button", { name: /Run the shipped personas/ }));
    const results = await screen.findByTestId("eval-results");
    expect(results.closest("[aria-live]")).toBeNull();
    const status = screen.getByText("Run complete: 2 of 2 passed.");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveAttribute("role", "status");
  });

  it("shows an item-table error banner when GET /items fails", async () => {
    installMockFetch(routesWith("GET", "/api/v1/items", () => PROBLEM_500));
    renderEval();
    expect(await screen.findByText("Could not load the item table")).toBeInTheDocument();
  });

  it("takes gate wording from GET /items (the gate table), not from code", async () => {
    installMockFetch(routesWith("GET", "/api/v1/items", () => ({ json: ITEMS_TABLE_SHAPE })));
    renderEval();
    expect(await screen.findByLabelText(GATES_TABLE[0].label)).toBeInTheDocument();
    expect(screen.getByLabelText(GATES_TABLE[1].label)).toBeInTheDocument();
    expect(screen.getByLabelText(GATES_TABLE[1].text_prompt!)).toHaveValue("loratadine");
    expect(screen.getByLabelText(GATES_TABLE[1].direction_prompt!)).toHaveValue("started");
    const other = screen.getByLabelText(GATES_TABLE[2].label);
    expect(other).toHaveAccessibleDescription(GATES_TABLE[2].note);
  });

  it("'No camera' preset hides the sample preview and sends consent_camera:false", async () => {
    const user = userEvent.setup();
    const mock = installMockFetch(routes());
    renderEval();
    const preset = await screen.findByLabelText("Scenario preset");
    expect(screen.getByTestId("sample-preview")).toBeInTheDocument();
    await user.selectOptions(preset, "none");
    expect(screen.queryByTestId("sample-preview")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Run this persona" }));
    await screen.findByTestId("custom-result");
    const sent = (mock.find("POST", "/api/v1/eval/run-custom")[0].body as { persona: Persona })
      .persona;
    expect(sent.consent_camera).toBe(false);
    expect(sent.vitals_scenario).toBe("none");
    expect(sent.vitals_samples).toEqual([]);
  });

  it("'Reset to demo persona' restores the demo answers and clears the outcome", async () => {
    const user = userEvent.setup();
    installMockFetch(routes());
    renderEval();
    const severity = (await screen.findByLabelText(
      "Shortness of breath Severity",
    )) as HTMLSelectElement;
    await user.selectOptions(severity, "3");
    await user.click(screen.getByRole("button", { name: "Run this persona" }));
    await screen.findByTestId("custom-result");
    await user.click(screen.getByRole("button", { name: "Reset to demo persona" }));
    expect(severity.value).toBe("2");
    expect(screen.queryByTestId("custom-result")).not.toBeInTheDocument();
  });

  it("renders counterfactual replays and harness notices when the server sends them", async () => {
    const extended = {
      ...RESULTS,
      counterfactuals: [
        {
          persona_id: "J-toggle-only-tachycardia-dyspnea",
          label: "same inputs with the demo toggle OFF",
          settings: { simulated_as_measured: false },
          baseline_tier: 2,
          tier: 1,
          pass: true,
          mismatches: [],
          session_id: "01JSESSIONCF0000000000000A",
        },
      ],
      notices: ["T1-dyspnea-moderate: expected.vs_not_done is not compared by this harness"],
    } as EvalResults;
    installMockFetch(routes({ storedResults: extended }));
    renderEval();
    const table = await screen.findByTestId("counterfactual-table");
    expect(within(table).getByText("same inputs with the demo toggle OFF")).toBeInTheDocument();
    expect(within(table).getByTitle("Tier 2: Nurse call today")).toBeInTheDocument();
    expect(within(table).getByTitle("Tier 1: Review within 1 business day")).toBeInTheDocument();
    expect(within(table).getByText("pass")).toBeInTheDocument();
    expect(within(table).getByRole("link", { name: "open check-in" })).toHaveAttribute(
      "href",
      "/dashboard/checkins/01JSESSIONCF0000000000000A",
    );
    expect(screen.getByText(/expected\.vs_not_done is not compared/)).toBeInTheDocument();
  });
});

describe("CustomResultView", () => {
  function renderView(result: CheckInResult) {
    return render(
      <MemoryRouter>
        <CustomResultView result={result} sessionId="01JSESSIONCUSTOM000000000A" />
      </MemoryRouter>,
    );
  }

  it("shows each rule's inputs and evidence, and each item's answers and evidence", () => {
    const base = checkInResult(2, 2);
    const result: CheckInResult = {
      ...base,
      corroboration_bump: 1,
      items: [
        {
          ...base.items[0],
          responses: [
            {
              answer_id: "01JANSWER0000000000000001",
              item_id: "shortness_of_breath",
              attribute: "severity",
              value: 2,
              ts: "2026-10-10T18:00:05.000Z",
            },
            {
              answer_id: "01JANSWER0000000000000002",
              item_id: "shortness_of_breath",
              attribute: "interference",
              value: 2,
              ts: "2026-10-10T18:00:09.000Z",
            },
          ],
          evidence: [
            {
              kind: "pro_response",
              id: "01JANSWER0000000000000001",
              ts: "2026-10-10T18:00:05.000Z",
              note: "severity = Moderate (2)",
            },
            { kind: "table", id: "composite_scoring.json", ts: null, note: "two-attribute row" },
          ],
        },
        base.items[1],
      ],
      rules_fired: [
        {
          rule_id: "corr.tachypnea_dyspnea",
          category: "corroboration",
          description: "Breathing rate 26 ≥ 24 breaths/min corroborates reported dyspnea.",
          inputs: { breathing_max: 26, threshold_bpm: 24, composite: 2, is_measured: false },
          effect: "tier +1 (1 → 2)",
          evidence: [
            {
              kind: "vitals_sample",
              id: "01JSAMPLE0000000000000009",
              ts: "2026-10-10T18:00:36.000Z",
              note: "breathing 26 breaths/min (simulated, conf 0.9)",
            },
          ],
        },
      ],
    };
    renderView(result);

    const rules = screen.getByTestId("rules-fired");
    const inputs = within(rules).getByRole("list", { name: "Inputs of corr.tachypnea_dyspnea" });
    expect(within(inputs).getByText("threshold_bpm: 24")).toBeInTheDocument();
    expect(within(inputs).getByText("breathing_max: 26")).toBeInTheDocument();
    expect(within(inputs).getByText("is_measured: false")).toBeInTheDocument();
    expect(
      within(rules).getByText("breathing 26 breaths/min (simulated, conf 0.9)"),
    ).toBeInTheDocument();
    expect(within(rules).getByText("vitals_sample")).toBeInTheDocument();
    expect(within(rules).getByTitle("2026-10-10T18:00:36.000Z (UTC)")).toBeInTheDocument();

    const row = screen.getByTestId("grade-shortness_of_breath");
    expect(within(row).getByText("2 answers")).toBeInTheDocument();
    expect(within(row).getByText("severity = 2")).toBeInTheDocument();
    expect(within(row).getByText("interference = 2")).toBeInTheDocument();
    expect(within(row).getByText("severity = Moderate (2)")).toBeInTheDocument();
    expect(within(row).getByText("two-attribute row")).toBeInTheDocument();
    // The answer row and its evidence pointer share a timestamp: both carry UTC on hover.
    expect(within(row).getAllByTitle("2026-10-10T18:00:05.000Z (UTC)")).toHaveLength(2);
    expect(within(row).getByTitle("2026-10-10T18:00:09.000Z (UTC)")).toBeInTheDocument();
    // An item with no answers and no evidence shows a dash, not an empty disclosure.
    expect(within(screen.getByTestId("grade-cough")).getByText("—")).toBeInTheDocument();
  });

  it("reports the stop screen and the page from their own contract fields", () => {
    renderView({ ...checkInResult(3, 3), page_oncall: false });
    expect(screen.getByText(/kiosk shows the stop screen/)).toBeInTheDocument();
    expect(screen.queryByText(/on-call paged/)).not.toBeInTheDocument();
  });

  it("says on-call paged only when page_oncall is true", () => {
    renderView({ ...checkInResult(3, 3), stop_screen: false, page_oncall: true });
    expect(screen.getByText(/on-call paged/)).toBeInTheDocument();
    expect(screen.queryByText(/kiosk shows the stop screen/)).not.toBeInTheDocument();
  });
});

describe("vitals presets", () => {
  it("are deterministic, simulated, and follow the persona sample conventions", () => {
    const a = generateSamples("resting", VITALS_PRESETS.resting.defaults);
    const b = generateSamples("resting", VITALS_PRESETS.resting.defaults);
    expect(a).toEqual(b);
    expect(a).toHaveLength(11);
    for (const s of a) {
      expect(s.isMeasured).toBe(false);
      expect(s.source).toBe("mock");
      if (s.tsOffsetS < 30) {
        expect(s.breathingBpm).toBeUndefined();
        expect(s.windowS).toBe(12);
      } else {
        expect(s.breathingBpm).toBeGreaterThan(0);
        expect(s.windowS).toBe(30);
      }
    }
  });

  it("implausible preset sends a pulse outside the engine's plausibility bounds", () => {
    const s = generateSamples("implausible", VITALS_PRESETS.implausible.defaults);
    expect(Math.max(...s.map((x) => x.pulseBpm ?? 0))).toBeGreaterThan(180);
  });

  it("low_quality keeps confidence under 0.5 and attaches quality flags", () => {
    const s = generateSamples("low_quality", VITALS_PRESETS.low_quality.defaults);
    expect(s.every((x) => (x.pulseConf ?? 1) < 0.5)).toBe(true);
    expect(s.some((x) => x.qualityFlags.includes("face_not_found"))).toBe(true);
  });

  it("post_exercise decays toward a lower level", () => {
    const s = generateSamples("post_exercise", VITALS_PRESETS.post_exercise.defaults);
    expect(s[0].pulseBpm ?? 0).toBeGreaterThan(s[s.length - 1].pulseBpm ?? 0);
  });

  it("'none' sends no samples and no camera consent", () => {
    expect(generateSamples("none", VITALS_PRESETS.none.defaults)).toEqual([]);
    const state = { ...demoFormState(), preset: "none" as const };
    const p = buildPersona(state, ITEMS.items);
    expect(p.consent_camera).toBe(false);
    expect(p.vitals_samples).toEqual([]);
  });

  it("buildPersona sends every attribute of every item explicitly", () => {
    const state = withResponse(demoFormState(), "cough", "severity", 3);
    const p = buildPersona(state, ITEMS.items);
    expect(p.responses.cough).toEqual({ severity: 3, interference: 0 });
    expect(Object.keys(p.responses).sort()).toEqual(["cough", "rash", "shortness_of_breath"]);
  });
});
