/**
 * Detail page against a mocked API (CONTRACTS.md §2.2 shapes).
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";

import { AUTH_STORAGE_KEY } from "../../../../lib/api";
import { resetAuthCache } from "../../../../lib/auth";
import type { CheckInDetail as CheckInDetailT, Draft, Role } from "../../../../lib/types";
import { installMockFetch, type Route as MockRoute } from "../../../../test/mockFetch";
import { CheckInDetail } from "../../CheckInDetail";
import {
  A_SOB_INT,
  A_SOB_SEV,
  AE,
  AE_DRAFT,
  CM,
  CM_DRAFT,
  detail,
  ESCALATION_ID,
  S1,
  S3,
  S4,
  SESSION_ID,
  withEscalationAndClock,
  withRepeatedRules,
} from "./fixture";

function signIn(role: Role) {
  sessionStorage.setItem(
    AUTH_STORAGE_KEY,
    JSON.stringify({
      token: `t.${role}`,
      role,
      display_name: role,
      expires_at: "2099-01-01T00:00:00.000Z",
    }),
  );
  resetAuthCache();
}

/**
 * A tiny stateful API: `GET /checkins` always returns `state.current`, so a
 * mutation route can update it exactly as the real API would and the page's
 * post-mutation reload sees the new state.
 */
function routes(d: CheckInDetailT, extra: MockRoute[] = []) {
  const state = { current: d };
  const replaceDraft = (next: Draft) => {
    const drafts = state.current.drafts.map((x) =>
      x.id === next.id
        ? next
        : x.id === next.supersedes_id
          ? { ...x, status: "superseded" as const }
          : x,
    );
    if (!drafts.some((x) => x.id === next.id)) drafts.push(next);
    state.current = { ...state.current, drafts };
  };
  const list: MockRoute[] = [
    {
      method: "GET",
      path: `/api/v1/checkins/${SESSION_ID}`,
      handler: () => ({ json: state.current }),
    },
    {
      method: "GET",
      path: "/api/v1/items",
      handler: () => ({ json: { items: [], gates: [], recall_window: "in the last 7 days" } }),
    },
    {
      method: "GET",
      path: "/api/v1/reference/ctcae",
      handler: () => ({
        json: [
          {
            item_id: "shortness_of_breath",
            aedecod: "Dyspnea",
            meddra_code_mock: "MOCK-0001",
            grade_definitions: {
              "1": "with moderate exertion",
              "2": "with minimal exertion",
              "3": "at rest",
            },
          },
        ],
      }),
    },
    ...extra,
  ];
  return { list, state, replaceDraft };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/dashboard/checkins/${SESSION_ID}`]}>
      <Routes>
        <Route path="/dashboard/checkins/:sessionId" element={<CheckInDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** The rule row buttons for a rule id (rule ids sit one click deeper, so select by data attribute). */
const ruleButtons = (ruleId: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>(`[data-rule-id="${ruleId}"] > button`));

const aeCard = () =>
  screen.getByRole("heading", { name: /Side effect: Dyspnea/ }).closest("section")!;

describe("CheckInDetail", () => {
  beforeEach(() => signIn("coordinator"));

  it("renders answers in order, drafts with provisional labels, and the Why panel", async () => {
    installMockFetch(routes(detail()).list);
    renderPage();
    expect(await screen.findByRole("heading", { name: /P-007/ })).toBeInTheDocument();

    // Left: answers with option wording and the verbatim marker on free text.
    const answers = screen.getByRole("list", { name: "Item answers" });
    const rows = within(answers).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Shortness of breath");
    expect(rows[0]).toHaveTextContent("Moderate");
    expect(rows[2]).toHaveTextContent("Mild");
    expect(screen.getByText("verbatim, never parsed")).toBeInTheDocument();
    expect(screen.getByText(/compared by string distance only, never parsed/)).toBeInTheDocument();

    // Vitals: SIMULATED is labeled beside every value, and the raw table exists.
    const vitals = screen.getByRole("heading", { name: "Vitals" }).closest("section")!;
    expect(within(vitals).getAllByText("SIMULATED").length).toBeGreaterThanOrEqual(3);
    expect(within(vitals).queryByText("MEASURED")).not.toBeInTheDocument();
    expect(within(vitals).getByText(/never averaged away/)).toBeInTheDocument();

    // Middle: AE / VS / CM groups, provisional label on AETOXGR, follow-up link.
    expect(screen.getByRole("heading", { name: /Side effect: Dyspnea/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /VS PULSE/ })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /Medication change: loratadine/ }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText("provisional, investigator to confirm").length,
    ).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/Follow-up of a side effect already on record/)).toBeInTheDocument();
    // The VS number itself carries the SIMULATED word, not only the method row and the title.
    const vsCard = screen.getByRole("heading", { name: /VS PULSE/ }).closest("section")!;
    const vsorres = vsCard.querySelector('tr[data-field="VSORRES"]')!;
    expect(vsorres).toHaveTextContent("73");
    expect(within(vsorres as HTMLElement).getByText("SIMULATED")).toBeInTheDocument();
    expect(
      within(vsCard.querySelector('tr[data-field="VSMETHOD"]') as HTMLElement).getByText(
        "SIMULATED",
      ),
    ).toBeInTheDocument();
    expect(within(vsCard).queryByText("MEASURED")).not.toBeInTheDocument();

    // Right: summary line and every rule in order.
    expect(screen.getByTestId("why-summary")).toHaveTextContent("Tier 1 = base 1");
    const rules = within(screen.getByRole("list", { name: "Rules fired" })).getAllByRole(
      "listitem",
    );
    expect(rules).toHaveLength(6);
    expect(rules[0]).toHaveAttribute("data-rule-id", "score.composite.shortness_of_breath");
    expect(rules[5]).toHaveAttribute("data-rule-id", "conmed.exact");

    // Coordinator sees attribution read-only.
    expect(within(aeCard()).getByText(/investigator only/)).toBeInTheDocument();
    expect(within(aeCard()).queryByRole("combobox", { name: /AESER/ })).not.toBeInTheDocument();
  });

  it("clicking a draft field reveals its evidence and highlights answers and rules", async () => {
    installMockFetch(routes(detail()).list);
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("heading", { name: /P-007/ });

    await user.click(within(aeCard()).getByRole("button", { name: /\(AETOXGR\): show evidence/ }));
    const panel = await screen.findByTestId("evidence-panel");
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Evidence for Severity grade (provisional) (AETOXGR)",
    );
    expect(within(panel).getAllByTestId("evidence-row")).toHaveLength(3);
    expect(panel).toHaveTextContent("shortness_of_breath.severity = 2 (Moderate)");

    const sev = document.querySelector(`[data-answer-id="${A_SOB_SEV}"]`)!;
    const int = document.querySelector(`[data-answer-id="${A_SOB_INT}"]`)!;
    const cough = document.querySelector('[data-answer-id="01JANSWERCOUGHSEV000000003"]')!;
    expect(sev).toHaveAttribute("data-highlighted", "true");
    expect(int).toHaveAttribute("data-highlighted", "true");
    expect(cough).toHaveAttribute("data-highlighted", "false");
    expect(
      document.querySelector('[data-rule-id="grade.provisional.shortness_of_breath"]'),
    ).toHaveAttribute("data-highlighted", "true");
    expect(document.querySelector('[data-rule-id="tier.base"]')).toHaveAttribute(
      "data-highlighted",
      "false",
    );

    // Selecting a rule highlights the samples it cites.
    await user.click(ruleButtons("vitals.simulated_ignored")[0]);
    expect(document.querySelector(`[data-sample-id="${S1}"]`)).toHaveAttribute(
      "data-highlighted",
      "true",
    );
    expect(sev).toHaveAttribute("data-highlighted", "false");
  });

  it("lists every occurrence of a repeated rule and selects each one on its own", async () => {
    installMockFetch(routes(withRepeatedRules()).list);
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("heading", { name: /P-007/ });

    const list = screen.getByRole("list", { name: "Rules fired" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(10);
    expect(document.querySelectorAll('[data-rule-id="draft.ae"]')).toHaveLength(2);
    expect(document.querySelectorAll('[data-rule-id="vitals.implausible"]')).toHaveLength(2);

    // The second draft.ae (cough) highlights the cough answer, not the dyspnea answers.
    const draftAe = ruleButtons("draft.ae");
    expect(draftAe).toHaveLength(2);
    await user.click(draftAe[1]);
    expect(draftAe[1]).toHaveAttribute("aria-expanded", "true");
    expect(draftAe[0]).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector('[data-answer-id="01JANSWERCOUGHSEV000000003"]')).toHaveAttribute(
      "data-highlighted",
      "true",
    );
    expect(document.querySelector(`[data-answer-id="${A_SOB_SEV}"]`)).toHaveAttribute(
      "data-highlighted",
      "false",
    );
    // Each implausible-sample rule points at its own sample.
    const implausible = ruleButtons("vitals.implausible");
    await user.click(implausible[0]);
    expect(rows[6]).toHaveTextContent(`sample_id${S3}`);
    await user.click(implausible[1]);
    expect(rows[7]).toHaveTextContent(`sample_id${S4}`);
    expect(implausible[0]).toHaveAttribute("aria-expanded", "false");
  });

  it("labels the header MEASURED when real-sensor samples produced no summary", async () => {
    const d = detail();
    const measured = detail({
      session: { ...d.session, vitals_status: "low_quality" },
      vitals: {
        samples: d.vitals.samples.map((s) => ({ ...s, source: "presage", is_measured: true })),
        summary: null,
        status: "low_quality",
      },
      result: { ...d.result, vitals: { ...d.result.vitals, status: "low_quality", summary: null } },
    });
    installMockFetch(routes(measured).list);
    renderPage();
    const heading = await screen.findByRole("heading", { name: /P-007/ });
    expect(within(heading).getByText("MEASURED")).toBeInTheDocument();
    expect(within(heading).getByText("presage")).toBeInTheDocument();
    const vitals = screen.getByRole("heading", { name: "Vitals" }).closest("section")!;
    expect(within(vitals).getAllByText("MEASURED").length).toBeGreaterThanOrEqual(1);
    // Header and Vitals card agree (the fixture's VS draft is still mock-derived, so it keeps its own word).
    expect(within(heading).queryByText("SIMULATED")).not.toBeInTheDocument();
    expect(within(vitals).queryByText("SIMULATED")).not.toBeInTheDocument();
  });

  it("keeps reject reason fields distinct when two cards are open at once", async () => {
    installMockFetch(routes(detail()).list);
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("heading", { name: /P-007/ });

    const cmCard = screen
      .getByRole("heading", { name: /Medication change: loratadine/ })
      .closest("section")!;
    await user.click(within(aeCard()).getByRole("button", { name: "Reject" }));
    await user.click(within(cmCard).getByRole("button", { name: "Reject" }));
    const fields = screen.getAllByLabelText("Reject this draft");
    expect(fields).toHaveLength(2);
    expect(fields[0].id).not.toBe(fields[1].id);
    // The CM card's label resolves to the CM card's own textarea.
    const cmField = within(cmCard).getByLabelText("Reject this draft");
    expect(cmCard.contains(cmField)).toBe(true);
    await user.type(cmField, "CM note");
    expect(within(aeCard()).getByLabelText("Reject this draft")).toHaveValue("");
    expect(cmField).toHaveValue("CM note");
  });

  it("never sends an empty attribution value once a decision is recorded", async () => {
    signIn("investigator");
    const recorded: Draft = { ...AE, fields: { ...AE.fields, AESER: "Y", AEREL: "POSSIBLE" } };
    const d = detail({ drafts: [recorded, CM] });
    const api = routes(d);
    const mock = installMockFetch([
      ...api.list,
      {
        method: "PATCH",
        path: `/api/v1/drafts/${AE_DRAFT}/attribution`,
        handler: ({ body }) => {
          const next: Draft = {
            ...recorded,
            fields: { ...recorded.fields, ...(body as Record<string, unknown>) },
          };
          api.replaceDraft(next);
          return { json: next };
        },
      },
    ]);
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("heading", { name: /P-007/ });
    const card = aeCard();
    const aeser = within(card).getByRole("combobox", { name: /AESER/ });
    // The blank choice is disabled once a value is recorded: attribution is a decision.
    expect(within(aeser).getByRole("option", { name: "— not decided —" })).toBeDisabled();
    expect(within(card).getByRole("button", { name: "Save attribution" })).toBeDisabled();

    await user.selectOptions(within(card).getByRole("combobox", { name: /AEREL/ }), "PROBABLE");
    await user.click(within(card).getByRole("button", { name: "Save attribution" }));
    await waitFor(() =>
      expect(mock.find("PATCH", `/api/v1/drafts/${AE_DRAFT}/attribution`)).toHaveLength(1),
    );
    const body = mock.find("PATCH", `/api/v1/drafts/${AE_DRAFT}/attribution`)[0].body as Record<
      string,
      unknown
    >;
    expect(body).toEqual({ AEREL: "PROBABLE" });
    expect("AESER" in body).toBe(false);
  });

  it("confirms in one click and rejects only with a reason", async () => {
    const confirmed: Draft = { ...AE, status: "confirmed" };
    const rejected: Draft = { ...CM, status: "rejected" };
    const api = routes(detail());
    const mock = installMockFetch([
      ...api.list,
      {
        method: "POST",
        path: `/api/v1/drafts/${AE_DRAFT}/confirm`,
        handler: () => (api.replaceDraft(confirmed), { json: confirmed }),
      },
      {
        method: "POST",
        path: `/api/v1/drafts/${CM_DRAFT}/reject`,
        handler: () => (api.replaceDraft(rejected), { json: rejected }),
      },
    ]);
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("heading", { name: /P-007/ });

    await user.click(within(aeCard()).getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(mock.find("POST", `/api/v1/drafts/${AE_DRAFT}/confirm`)).toHaveLength(1),
    );
    // One click, no form: the audit note is optional and not asked for.
    expect(mock.find("POST", `/api/v1/drafts/${AE_DRAFT}/confirm`)[0].body ?? {}).toEqual({});
    expect(mock.find("POST", `/api/v1/drafts/${AE_DRAFT}/confirm`)[0].headers.authorization).toBe(
      "Bearer t.coordinator",
    );
    expect(await within(aeCard()).findByText("Confirmed")).toBeInTheDocument();

    const cmCard = screen
      .getByRole("heading", { name: /Medication change: loratadine/ })
      .closest("section")!;
    await user.click(within(cmCard).getByRole("button", { name: "Reject" }));
    const rejectBtn = screen.getByRole("button", { name: "Reject draft" });
    expect(rejectBtn).toBeDisabled();
    await user.type(screen.getByLabelText("Reject this draft"), "Duplicate of a chart-note entry");
    await user.click(rejectBtn);
    await waitFor(() =>
      expect(mock.find("POST", `/api/v1/drafts/${CM_DRAFT}/reject`)).toHaveLength(1),
    );
    expect(mock.find("POST", `/api/v1/drafts/${CM_DRAFT}/reject`)[0].body).toEqual({
      reason: "Duplicate of a chart-note entry",
    });
  });

  it("edits only changed fields, refuses grade 4, and shows the new version", async () => {
    const v2: Draft = {
      ...AE,
      id: "01JDRAFTAE0000000000000V02",
      version: 2,
      supersedes_id: AE_DRAFT,
      fields: { ...AE.fields, AETOXGR: 3 },
    };
    const api = routes(detail());
    const mock = installMockFetch([
      ...api.list,
      {
        method: "PATCH",
        path: `/api/v1/drafts/${AE_DRAFT}`,
        handler: () => (api.replaceDraft(v2), { json: v2 }),
      },
      {
        method: "GET",
        path: `/api/v1/drafts/${v2.id}/versions`,
        handler: () => ({ json: [AE, v2] }),
      },
    ]);
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("heading", { name: /P-007/ });

    await user.click(within(aeCard()).getByRole("button", { name: "Edit" }));
    const grade = screen.getByRole("textbox", { name: /AETOXGR/ });
    await user.clear(grade);
    await user.type(grade, "4");
    expect(screen.getByText(/never assigns a grade above 3/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save as new version" })).toBeDisabled();
    await user.clear(grade);
    await user.type(grade, "3");
    await user.type(
      screen.getByLabelText("Audit note (optional)"),
      "Participant described dyspnea at rest",
    );
    await user.click(screen.getByRole("button", { name: "Save as new version" }));

    await waitFor(() => expect(mock.find("PATCH", `/api/v1/drafts/${AE_DRAFT}`)).toHaveLength(1));
    expect(mock.find("PATCH", `/api/v1/drafts/${AE_DRAFT}`)[0].body).toEqual({
      fields: { AETOXGR: 3 },
      note: "Participant described dyspnea at rest",
    });
    expect(await within(aeCard()).findByText("v2")).toBeInTheDocument();
    expect(within(aeCard()).getByText("Grade 3")).toBeInTheDocument();

    // Version history loads lazily and shows the diff.
    await user.click(within(aeCard()).getByText(/Version history/));
    const versions = await screen.findByRole("list", { name: "Draft versions" });
    // Direct children only: each version row nests its own <ul> of field diffs.
    expect(
      within(versions)
        .getAllByRole("listitem")
        .filter((li) => li.parentElement === versions),
    ).toHaveLength(2);
    expect(versions).toHaveTextContent("AETOXGR: 2 → 3");
  });

  it("lets an investigator set AESER/AEREL and acknowledge an escalation", async () => {
    signIn("investigator");
    const d = withEscalationAndClock();
    const attributed: Draft = { ...AE, fields: { ...AE.fields, AESER: "Y", AEREL: "POSSIBLE" } };
    const api = routes(d);
    const acked = {
      ...d.escalation!,
      acked_by: "investigator",
      acked_at: "2026-10-10T18:10:00.000Z",
      seconds_to_ack: 299,
    };
    const mock = installMockFetch([
      ...api.list,
      {
        method: "PATCH",
        path: `/api/v1/drafts/${AE_DRAFT}/attribution`,
        handler: () => {
          api.replaceDraft(attributed);
          // Setting AESER stops the SAE clock (CONTRACTS §2.2).
          // Mirrors the real API: seconds_remaining is null once stopped
          // (services/common.py), so the page must derive "At stop" itself.
          api.state.current = {
            ...api.state.current,
            sae_clock: {
              ...api.state.current.sae_clock!,
              due_at: "2026-10-11T18:05:00.000Z",
              stopped_at: "2026-10-10T18:12:00.000Z",
              stopped_by: "investigator",
              decision: "Y",
              seconds_remaining: null,
            },
          };
          return { json: attributed };
        },
      },
      {
        method: "POST",
        path: `/api/v1/escalations/${ESCALATION_ID}/ack`,
        handler: () => {
          api.state.current = { ...api.state.current, escalation: acked };
          return { json: acked };
        },
      },
      {
        method: "GET",
        path: "/api/v1/reference/label",
        handler: () => ({
          json: {
            drug: "LIBTAYO (cemiplimab-rwlc)",
            section: "adverse_reactions",
            text: "Immune-mediated pneumonitis occurred in …",
            source_url: "https://example.invalid/label",
            fetched_at: "2026-10-10T00:00:00.000Z",
            note: "public label excerpt, reference only",
          },
        }),
      },
    ]);
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("heading", { name: /P-007/ });

    // SAE clock and escalation boxes are populated.
    expect(screen.getByTestId("sae-countdown")).toHaveTextContent(/59m|1h/);
    expect(screen.getByText("Informational sponsor deadlines")).toBeInTheDocument();
    expect(screen.getByText("hospitalization or emergency-room visit = yes")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Acknowledge escalation" }));
    await waitFor(() =>
      expect(mock.find("POST", `/api/v1/escalations/${ESCALATION_ID}/ack`)).toHaveLength(1),
    );
    const escCard = screen.getByRole("heading", { name: "Escalation" }).closest("section")!;
    await waitFor(() => expect(escCard).toHaveTextContent(/by investigator at/));
    expect(
      within(escCard).queryByRole("button", { name: "Acknowledge escalation" }),
    ).not.toBeInTheDocument();

    // Attribution controls are live for the investigator.
    const card = aeCard();
    await user.selectOptions(within(card).getByRole("combobox", { name: /AESER/ }), "Y");
    await user.selectOptions(within(card).getByRole("combobox", { name: /AEREL/ }), "POSSIBLE");
    await user.click(within(card).getByRole("button", { name: "Save attribution" }));
    await waitFor(() =>
      expect(mock.find("PATCH", `/api/v1/drafts/${AE_DRAFT}/attribution`)).toHaveLength(1),
    );
    expect(mock.find("PATCH", `/api/v1/drafts/${AE_DRAFT}/attribution`)[0].body).toEqual({
      AESER: "Y",
      AEREL: "POSSIBLE",
    });
    // The reload after attribution shows the stopped clock.
    const saeCard = screen
      .getByRole("heading", { name: /Serious-event report clock/ })
      .closest("section")!;
    await waitFor(() => expect(saeCard).toHaveTextContent("stopped"));
    expect(saeCard).toHaveTextContent(/by investigator/);
    // 24 h window from 18:05 the day before, stopped at 18:12: 23h 53m were left.
    expect(within(saeCard).getByTestId("sae-countdown")).toHaveTextContent("23h 53m");

    // The label excerpt is collapsed until opened, then fetched once.
    expect(mock.find("GET", "/api/v1/reference/label")).toHaveLength(0);
    await user.click(
      within(card).getAllByText("Reference safety information (public label excerpt)")[0],
    );
    expect(await screen.findByText(/Immune-mediated pneumonitis/)).toBeInTheDocument();
    expect(mock.find("GET", "/api/v1/reference/label")).toHaveLength(1);
  });

  it("shows a not-found state with a way back to the queue", async () => {
    installMockFetch([
      {
        method: "GET",
        path: `/api/v1/checkins/${SESSION_ID}`,
        handler: () => ({
          status: 404,
          json: { type: "about:blank", title: "Not Found", status: 404, detail: "no such session" },
        }),
      },
      {
        method: "GET",
        path: "/api/v1/items",
        handler: () => ({ json: { items: [], gates: [], recall_window: "" } }),
      },
      { method: "GET", path: "/api/v1/reference/ctcae", handler: () => ({ json: [] }) },
    ]);
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("Check-in not found");
    expect(screen.getByRole("link", { name: "Back to the queue" })).toBeInTheDocument();
  });

  it("renders without vitals, drafts, escalation or rules (sparse payload)", async () => {
    const sparse = detail({
      drafts: [],
      rules_fired: [],
      why: [],
      vitals: { samples: [], summary: null, status: "declined" },
      session: { ...detail().session, consent_camera: false, vitals_status: "declined" },
      result: {
        ...detail().result,
        rules_fired: [],
        vitals: {
          status: "unavailable",
          eligible_sample_ids: [],
          ignored: [],
          summary: null,
          rules_fired: [],
        },
      },
      evidence_index: {},
    });
    installMockFetch(routes(sparse).list);
    renderPage();
    await screen.findByRole("heading", { name: /P-007/ });
    expect(screen.getByText(/No vitals samples were captured/)).toBeInTheDocument();
    expect(screen.getByText(/No drafts were generated/)).toBeInTheDocument();
    expect(screen.getByText("No rules fired.")).toBeInTheDocument();
    expect(screen.getByText(/No escalation was raised/)).toBeInTheDocument();
    expect(screen.getByText(/No 24-hour report clock/)).toBeInTheDocument();
  });
});
