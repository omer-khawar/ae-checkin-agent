/**
 * Check-in detail, CONTRACTS.md R3 / R4 additions against a mocked API:
 * plain labels (API `labels` map first, local table second) with SDTM badges,
 * plain rule sentences with rule ids one click deeper, protocol flags (AESI,
 * discouraged con-med with exception text, missing medication-form fields),
 * "Open report packet", the investigator's immune-related choice, and the
 * seriousness decision on a clock with no side-effect record.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";

import { ToastProvider } from "../../../../components/Toast";
import { AUTH_STORAGE_KEY } from "../../../../lib/api";
import { resetAuthCache } from "../../../../lib/auth";
import type { CheckInDetail as CheckInDetailT, Role } from "../../../../lib/types";
import { installMockFetch, type Route as MockRoute } from "../../../../test/mockFetch";
import { CheckInDetail } from "../../CheckInDetail";
import { AE, AE_DRAFT, CM, SESSION_ID, withEscalationAndClock } from "./fixture";

const CLOCK_ID = "01JSAECLOCK0000000000000001";
const AESI_CLOCK_ID = "01JAESICLOCK000000000000001";

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

function baseRoutes(d: unknown, extra: MockRoute[] = []): MockRoute[] {
  return [
    { method: "GET", path: `/api/v1/checkins/${SESSION_ID}`, handler: () => ({ json: d }) },
    {
      method: "GET",
      path: "/api/v1/items",
      handler: () => ({
        json: {
          items: [
            {
              id: "shortness_of_breath",
              label: "Shortness of breath",
              short_label: "Breath",
              ctcae_term: "Dyspnea",
              attributes: ["severity", "interference"],
              response_options: {},
              recall_window: "in the last 7 days",
              order: 1,
            },
          ],
          gates: [],
          recall_window: "in the last 7 days",
        },
      }),
    },
    { method: "GET", path: "/api/v1/reference/ctcae", handler: () => ({ json: [] }) },
    ...extra,
  ];
}

/** R3 payload: protocol assessment, API labels, a discouraged steroid, an AESI clock. */
function r3Detail(): CheckInDetailT {
  const d = withEscalationAndClock();
  const cm = {
    ...CM,
    fields: {
      ...CM.fields,
      CMTRT: "prednisone",
      CMDECOD: "prednisone",
      INTERIM_PROTOCOL_FLAG: "discouraged",
      INTERIM_CM_MISSING_FIELDS: ["CMDOSE", "CMDOSFRQ", "CMINDC"],
    },
  };
  const ae = { ...AE, fields: { ...AE.fields, AETOXGR: 3, INTERIM_AESI_SUSPECTED: true } };
  return {
    ...d,
    drafts: [ae, cm],
    labels: { AETOXGR: "How bad it is (provisional grade)" },
    protocol: {
      protocol_id: "R2810-ONC-1624",
      aesi_suspected: true,
      aesi_items: ["shortness_of_breath"],
      aesi_reasons: ["grade 3 on a potentially immune-related item"],
      conmed_flags: [
        {
          level: "discouraged",
          drug: "prednisone",
          protocol_ref: { section: "7.7.2", printed_page: 69 },
          quote: "It is recommended that patients do not receive …",
          exception_text:
            "except in the case of a life-threatening emergency and/or to treat an irAE.",
        },
      ],
      conmed_flag: "discouraged",
      cm_missing_fields: ["CMDOSE", "CMDOSFRQ", "CMINDC"],
      tier_floor: 0,
    },
    aesi_clock: {
      ...d.sae_clock!,
      id: AESI_CLOCK_ID,
      kind: "aesi",
    },
  } as unknown as CheckInDetailT;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/dashboard/checkins/${SESSION_ID}`]}>
      <Routes>
        <Route path="/dashboard/checkins/:sessionId" element={<CheckInDetail />} />
        <Route path="/dashboard/packets/:id" element={<p>Packet page stub</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

const aeCard = () =>
  screen.getByRole("heading", { name: /Side effect: Dyspnea/ }).closest("section")!;
const cmCard = () =>
  screen.getByRole("heading", { name: /Medication change: prednisone/ }).closest("section")!;

describe("CheckInDetail · plain language and protocol (R3)", () => {
  beforeEach(() => signIn("coordinator"));

  it("leads with plain labels from the API, keeps SDTM names as badges", async () => {
    installMockFetch(baseRoutes(r3Detail()));
    renderPage();
    await screen.findByRole("heading", { name: /P-007/ });

    // Card title is plain; the SDTM code is a badge in the same heading.
    const heading = screen.getByRole("heading", {
      name: /Side effect: Dyspnea, severe \(grade 3, provisional\)/,
    });
    expect(within(heading).getByText("AE 1")).toBeInTheDocument();
    // The API label wins over the local table; the SDTM name is one click deeper
    // ("Show EDC codes"), visually hidden until then but still read aloud.
    const grade = aeCard().querySelector('tr[data-field="AETOXGR"]') as HTMLElement;
    expect(grade).toHaveTextContent("How bad it is (provisional grade)");
    expect(grade).toHaveTextContent("Grade 3 · severe");
    const code = () => grade.querySelector('[data-sdtm-code="AETOXGR"]') as HTMLElement;
    expect(code()).toHaveClass("sr-only");
    await userEvent.setup().click(screen.getByRole("checkbox", { name: /Show EDC codes/ }));
    expect(code()).not.toHaveClass("sr-only");
    expect(code()).toHaveClass("font-mono");
    // A field the API did not label uses the local plain_language.json copy.
    const term = aeCard().querySelector('tr[data-field="AEDECOD"]') as HTMLElement;
    expect(term).toHaveTextContent("Side effect (standard term)");
    // Identity / provenance fields are one click deeper, not removed.
    expect(aeCard().querySelector('tr[data-field="STUDYID"]')).toBeNull();
    await userEvent.setup().click(within(aeCard()).getByRole("button", { name: /more field/ }));
    expect(aeCard().querySelector('tr[data-field="STUDYID"]')).not.toBeNull();
  });

  it("shows the AESI banner, the discouraged chip with its exception, and missing CM fields", async () => {
    installMockFetch(baseRoutes(r3Detail()));
    renderPage();
    await screen.findByRole("heading", { name: /P-007/ });

    expect(within(aeCard()).getByTestId("aesi-banner")).toHaveTextContent(
      "Possible special-interest event (report within 24 h, investigator to confirm)",
    );
    const chip = within(cmCard()).getByTestId("protocol-chip");
    expect(chip).toHaveTextContent("Discouraged by protocol §7.7.2");
    expect(chip).toHaveAttribute(
      "title",
      "Protocol exception: except in the case of a life-threatening emergency and/or to treat an irAE.",
    );
    expect(within(cmCard()).getByTestId("cm-missing")).toHaveTextContent(
      "Still needed for the medication form: dose, frequency, indication",
    );
    // The protocol box in the Why column repeats the exception verbatim.
    expect(screen.getByRole("list", { name: "Protocol checks" })).toHaveTextContent(
      "Protocol exception:",
    );
    // Both clocks render with their kind.
    expect(screen.getByRole("heading", { name: /Serious-event report clock/ })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /Special-interest event report clock/ }),
    ).toBeInTheDocument();
  });

  it("Why panel: plain sentence first, rule id and inputs one click deeper", async () => {
    installMockFetch(baseRoutes(r3Detail()));
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("heading", { name: /P-007/ });

    const row = document.querySelector('[data-rule-id="conmed.exact"]') as HTMLElement;
    expect(row).toHaveTextContent(
      "The medication 'loratadine' was found in the medication list as loratadine.",
    );
    expect(within(row).queryByTestId("rule-details")).not.toBeInTheDocument();
    expect(row).not.toHaveTextContent("conmed.exact");
    await user.click(within(row).getByRole("button"));
    const details = within(row).getByTestId("rule-details");
    expect(details).toHaveTextContent("conmed.exact");
    expect(within(details).getByText("verbatim")).toBeInTheDocument();
    expect(screen.getByTestId("why-plain")).toHaveTextContent(
      "Alert level: Review within 1 business day",
    );
  });

  it("Open report packet posts the clock id and navigates to the packet page", async () => {
    const mock = installMockFetch(
      baseRoutes(r3Detail(), [
        {
          method: "POST",
          path: "/api/v1/packets",
          handler: () => ({ json: { id: "01JPACKET", clock_id: CLOCK_ID, kind: "sae" } }),
        },
      ]),
    );
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("heading", { name: /P-007/ });
    const saeCard = screen
      .getByRole("heading", { name: /Serious-event report clock/ })
      .closest("section")!;
    await user.click(within(saeCard).getByRole("button", { name: "Open report packet" }));
    expect(await screen.findByText("Packet page stub")).toBeInTheDocument();
    expect(mock.find("POST", "/api/v1/packets")[0].body).toEqual({ clock_id: CLOCK_ID });
  });

  it("shows an error and stays when the packet cannot be opened", async () => {
    installMockFetch(
      baseRoutes(r3Detail(), [
        {
          method: "POST",
          path: "/api/v1/packets",
          handler: () => ({
            status: 403,
            json: { type: "about:blank", title: "Forbidden", status: 403 },
          }),
        },
      ]),
    );
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("heading", { name: /P-007/ });
    await user.click(screen.getAllByRole("button", { name: "Open report packet" })[0]);
    expect(await screen.findByText("Could not open the report packet")).toBeInTheDocument();
  });
});

describe("CheckInDetail · investigator assessment (R4.3)", () => {
  beforeEach(() => signIn("investigator"));

  it("sends INTERIM_IRAE with the attribution (Not decided is a choice)", async () => {
    const d = r3Detail();
    const mock = installMockFetch(
      baseRoutes(d, [
        {
          method: "PATCH",
          path: `/api/v1/drafts/${AE_DRAFT}/attribution`,
          handler: ({ body }) => ({
            json: { ...AE, fields: { ...AE.fields, ...(body as object) } },
          }),
        },
      ]),
    );
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("heading", { name: /P-007/ });
    const irae = within(aeCard()).getByRole("combobox", { name: /Immune-related\?/ });
    expect(within(irae).getByRole("option", { name: "Not decided" })).toBeInTheDocument();
    await user.selectOptions(irae, "Y");
    await user.click(within(aeCard()).getByRole("button", { name: "Save attribution" }));
    await waitFor(() =>
      expect(mock.find("PATCH", `/api/v1/drafts/${AE_DRAFT}/attribution`)).toHaveLength(1),
    );
    expect(mock.find("PATCH", `/api/v1/drafts/${AE_DRAFT}/attribution`)[0].body).toEqual({
      INTERIM_IRAE: "Y",
    });
  });

  it("records a seriousness decision on a clock with no side-effect record, after confirming", async () => {
    // Hospital visit with every symptom at zero: a clock but no AE draft.
    const d = withEscalationAndClock();
    const noAe = { ...d, drafts: d.drafts.filter((x) => x.domain !== "AE") };
    const mock = installMockFetch(
      baseRoutes(noAe, [
        {
          method: "PATCH",
          path: `/api/v1/sae-clocks/${CLOCK_ID}/stop`,
          handler: ({ body }) => ({
            json: {
              ...d.sae_clock,
              stopped_at: "2026-10-10T18:20:00.000Z",
              stopped_by: "investigator",
              decision: (body as { decision: string }).decision,
              seconds_remaining: null,
            },
          }),
        },
      ]),
    );
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("heading", { name: /P-007/ });
    await user.click(screen.getByRole("button", { name: "Record seriousness decision" }));
    const form = screen.getByRole("form", { name: "Record seriousness decision" });
    expect(within(form).getByRole("button", { name: "Continue" })).toBeDisabled();
    await user.click(within(form).getByRole("radio", { name: "Not serious" }));
    await user.type(within(form).getByLabelText(/Reason/), "fall at home, not related");
    await user.click(within(form).getByRole("button", { name: "Continue" }));
    // In-page confirmation; nothing sent yet.
    expect(screen.getByTestId("decision-confirm")).toHaveTextContent("AESER = N");
    expect(mock.find("PATCH", `/api/v1/sae-clocks/${CLOCK_ID}/stop`)).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Yes, record decision" }));
    await waitFor(() =>
      expect(mock.find("PATCH", `/api/v1/sae-clocks/${CLOCK_ID}/stop`)).toHaveLength(1),
    );
    expect(mock.find("PATCH", `/api/v1/sae-clocks/${CLOCK_ID}/stop`)[0].body).toEqual({
      decision: "AESER = N",
      note: "fall at home, not related",
    });
  });

  it("hides the clock decision when a side-effect record can be attributed instead", async () => {
    installMockFetch(baseRoutes(withEscalationAndClock()));
    renderPage();
    await screen.findByRole("heading", { name: /P-007/ });
    expect(screen.queryByRole("button", { name: "Record seriousness decision" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open report packet" })).toBeInTheDocument();
  });
});

describe("CheckInDetail · clock copy follows what the API actually stops (R4.3)", () => {
  beforeEach(() => signIn("investigator"));

  function renderWithToasts() {
    return render(
      <MemoryRouter initialEntries={[`/dashboard/checkins/${SESSION_ID}`]}>
        <ToastProvider>
          <Routes>
            <Route path="/dashboard/checkins/:sessionId" element={<CheckInDetail />} />
          </Routes>
        </ToastProvider>
      </MemoryRouter>,
    );
  }

  const attributionRoute = (): MockRoute => ({
    method: "PATCH",
    path: `/api/v1/drafts/${AE_DRAFT}/attribution`,
    handler: ({ body }) => ({ json: { ...AE, fields: { ...AE.fields, ...(body as object) } } }),
  });

  it("names both running clocks in the hint, and only the AESI clock when Immune-related = No", async () => {
    installMockFetch(baseRoutes(r3Detail(), [attributionRoute()]));
    const user = userEvent.setup();
    renderWithToasts();
    await screen.findByRole("heading", { name: /P-007/ });
    const hint = within(aeCard()).getByTestId("attribution-clock-hint");
    expect(hint).toHaveTextContent(
      'Deciding "Serious?" stops the 24-hour serious-event report clock',
    );
    expect(hint).toHaveTextContent('"Immune-related? No" stops the 24-hour special-interest');
    await user.selectOptions(
      within(aeCard()).getByRole("combobox", { name: /Immune-related\?/ }),
      "N",
    );
    await user.click(within(aeCard()).getByRole("button", { name: "Save attribution" }));
    expect(
      await screen.findByText(/special-interest report clock has been stopped/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/serious-event report clock has been stopped/)).toBeNull();
  });

  it("says nothing about clocks when no clock is running", async () => {
    const d = withEscalationAndClock();
    const noClock = { ...d, sae_clock: null } as unknown as CheckInDetailT;
    installMockFetch(baseRoutes(noClock, [attributionRoute()]));
    const user = userEvent.setup();
    renderWithToasts();
    await screen.findByRole("heading", { name: /P-007/ });
    expect(within(aeCard()).queryByTestId("attribution-clock-hint")).toBeNull();
    await user.selectOptions(within(aeCard()).getByRole("combobox", { name: /Serious\?/ }), "N");
    await user.click(within(aeCard()).getByRole("button", { name: "Save attribution" }));
    expect(await screen.findByText("Investigator assessment recorded")).toBeInTheDocument();
    expect(screen.queryByText(/clock has been stopped/)).toBeNull();
  });

  it("does not announce the ticking countdown; only the overdue crossing is a status", async () => {
    const d = withEscalationAndClock();
    const overdue = {
      ...d,
      sae_clock: { ...d.sae_clock!, due_at: new Date(Date.now() - 60_000).toISOString() },
    } as unknown as CheckInDetailT;
    installMockFetch(baseRoutes(overdue));
    renderWithToasts();
    await screen.findByRole("heading", { name: /P-007/ });
    const countdown = screen.getByTestId("sae-countdown");
    expect(countdown).not.toHaveAttribute("aria-live");
    expect(countdown.closest("[aria-live]")).toBeNull();
    expect(screen.getByTestId("clock-threshold-status")).toHaveTextContent(/overdue/);
  });
});
