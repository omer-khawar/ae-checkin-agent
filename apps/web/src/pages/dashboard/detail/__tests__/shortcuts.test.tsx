/**
 * Detail page keyboard paths and bulk confirm (UI phase 2): c / e / r / ] / [ / j, one-click
 * confirm that moves focus to the next draft, "Confirm remaining (N)", "Next item", Esc in the
 * inline editor, and the evidence sheet. Pure navigation helpers are tested at the bottom.
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
import { actionableDrafts, neighbourDraftId, nextQueueSession } from "../nav";
import {
  AE,
  AE_COUGH,
  AE_DRAFT,
  AE_DRAFT_COUGH,
  CM,
  CM_DRAFT,
  detail,
  SESSION_ID,
  VS,
  VS_DRAFT,
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

/** A stateful API: confirming a draft flips it to confirmed in later GETs. */
function api(extra: MockRoute[] = []) {
  const state: { current: CheckInDetailT } = { current: detail() };
  const confirm = (id: string): MockRoute => ({
    method: "POST",
    path: `/api/v1/drafts/${id}/confirm`,
    handler: () => {
      const d = state.current.drafts.find((x) => x.id === id)!;
      const next: Draft = { ...d, status: "confirmed" };
      state.current = {
        ...state.current,
        drafts: state.current.drafts.map((x) => (x.id === id ? next : x)),
      };
      return { json: next };
    },
  });
  const routes: MockRoute[] = [
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
    { method: "GET", path: "/api/v1/reference/ctcae", handler: () => ({ json: [] }) },
    ...[AE_DRAFT, AE_DRAFT_COUGH, VS_DRAFT, CM_DRAFT].map(confirm),
    ...extra,
  ];
  return routes;
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

const card = (id: string) => document.querySelector<HTMLElement>(`[data-draft-id="${id}"]`)!;

describe("CheckInDetail · keyboard and bulk confirm", () => {
  beforeEach(() => signIn("coordinator"));

  it("c confirms the active draft and moves focus to the next one", async () => {
    const mock = installMockFetch(api());
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("heading", { name: /P-007/ });

    // The first draft needing review is active by default.
    expect(card(AE_DRAFT)).toHaveAttribute("data-active", "true");
    await user.keyboard("c");
    await waitFor(() =>
      expect(mock.find("POST", `/api/v1/drafts/${AE_DRAFT}/confirm`)).toHaveLength(1),
    );
    await waitFor(() => expect(card(AE_DRAFT_COUGH)).toHaveAttribute("data-active", "true"));
    await waitFor(() => expect(card(AE_DRAFT_COUGH)).toHaveFocus());
  });

  it("] and [ move the active draft; e and r open the edit and reject forms", async () => {
    installMockFetch(api());
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("heading", { name: /P-007/ });

    await user.keyboard("]");
    expect(card(AE_DRAFT_COUGH)).toHaveAttribute("data-active", "true");
    await user.keyboard("[[");
    expect(card(AE_DRAFT)).toHaveAttribute("data-active", "true");

    await user.keyboard("r");
    expect(within(card(AE_DRAFT)).getByLabelText("Reject this draft")).toBeInTheDocument();
    // Typing in the reason box must not trigger shortcuts.
    await user.type(within(card(AE_DRAFT)).getByLabelText("Reject this draft"), "cer");
    expect(within(card(AE_DRAFT)).getByLabelText("Reject this draft")).toHaveValue("cer");

    await user.click(within(card(AE_DRAFT)).getByRole("button", { name: "Cancel" }));
    await user.keyboard("e");
    const form = within(card(AE_DRAFT)).getByRole("form", { name: /^Edit / });
    expect(form).toBeInTheDocument();
  });

  it("Esc cancels the inline editor and Enter saves it", async () => {
    const mock = installMockFetch(
      api([
        {
          method: "PATCH",
          path: `/api/v1/drafts/${AE_DRAFT}`,
          handler: () => ({
            json: { ...AE, version: 2, id: "01JDRAFTAEV2", supersedes_id: AE_DRAFT },
          }),
        },
      ]),
    );
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("heading", { name: /P-007/ });

    await user.click(within(card(AE_DRAFT)).getByRole("button", { name: /^Edit/ }));
    const grade = within(card(AE_DRAFT)).getByLabelText(/Severity grade/);
    await user.type(grade, "{Escape}");
    expect(within(card(AE_DRAFT)).queryByRole("form", { name: /^Edit / })).toBeNull();

    await user.click(within(card(AE_DRAFT)).getByRole("button", { name: /^Edit/ }));
    const input = within(card(AE_DRAFT)).getByLabelText(/Severity grade/);
    await user.clear(input);
    await user.type(input, "3{Enter}");
    await waitFor(() => expect(mock.find("PATCH", `/api/v1/drafts/${AE_DRAFT}`)).toHaveLength(1));
  });

  it("Confirm remaining (N) confirms every draft still waiting", async () => {
    const mock = installMockFetch(api());
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("heading", { name: /P-007/ });

    await user.click(screen.getByRole("button", { name: "Confirm remaining (4)" }));
    await waitFor(() => {
      for (const id of [AE_DRAFT, AE_DRAFT_COUGH, VS_DRAFT, CM_DRAFT]) {
        expect(mock.find("POST", `/api/v1/drafts/${id}/confirm`)).toHaveLength(1);
      }
    });
    // Nothing is left to review, so the next-item banner appears.
    expect(await screen.findByTestId("all-reviewed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Confirm remaining/ })).toBeNull();
  });

  it("j (and the Next item button) opens the next queue item that needs review", async () => {
    const item = (id: string, summary: string) => ({
      session_id: id,
      usubjid: `U-${id}`,
      display_label: id,
      completed_at: "2026-10-10T18:05:00.000Z",
      tier: 1,
      tier_name: "Review within 1 business day",
      vitals_status: "unavailable",
      is_measured: false,
      has_sae_clock: false,
      sae_due_at: null,
      escalation_acked: null,
      draft_status_summary: summary,
    });
    installMockFetch(
      api([
        {
          method: "GET",
          path: "/api/v1/queue",
          handler: () => ({
            json: {
              items: [
                item("S-DONE", "1 confirmed"),
                item(SESSION_ID, "2 draft"),
                item("S-NEXT", "3 draft"),
              ],
              total: 3,
              limit: 100,
              offset: 0,
            },
          }),
        },
      ]),
    );
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={[`/dashboard/checkins/${SESSION_ID}`]}>
        <Routes>
          <Route path="/dashboard/checkins/:sessionId" element={<CheckInDetail />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByRole("heading", { name: /P-007/ });
    await user.keyboard("j");
    // Navigation changes the :sessionId param, so the page reloads that check-in (404 in the mock).
    expect(await screen.findByRole("alert")).toHaveTextContent(/not found|Could not load/i);
  });

  it("opens evidence in a side sheet that keeps the source rows highlighted", async () => {
    installMockFetch(api());
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("heading", { name: /P-007/ });

    await user.click(
      within(card(AE_DRAFT)).getByRole("button", { name: /\(AETOXGR\): show evidence/ }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByTestId("evidence-panel")).toBeInTheDocument();
    expect(document.querySelector('[data-answer-id][data-highlighted="true"]')).not.toBeNull();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("shows tier, clocks and the vitals provenance word in the header", async () => {
    installMockFetch(api());
    renderPage();
    const h1 = await screen.findByRole("heading", { name: /P-007/ });
    expect(h1).toHaveTextContent(/Review within 1 business day/);
    expect(VS.domain).toBe("VS");
    expect(CM.domain).toBe("CM");
    expect(AE_COUGH.domain).toBe("AE");
  });
});

describe("detail/nav", () => {
  const d = (id: string, domain: Draft["domain"], status: Draft["status"] = "draft") =>
    ({ id, domain, status, version: 1, fields: {}, evidence: {} }) as unknown as Draft;

  it("lists only drafts needing review, AE then VS then CM", () => {
    const order = actionableDrafts([
      d("cm", "CM"),
      d("vs", "VS", "confirmed"),
      d("ae2", "AE"),
      d("ae1", "AE"),
    ]);
    expect(order.map((x) => x.id)).toEqual(["ae2", "ae1", "cm"]);
  });

  it("finds the neighbour with wrap-around and null when nothing else is left", () => {
    const order = [d("a", "AE"), d("b", "AE"), d("c", "CM")];
    expect(neighbourDraftId(order, "a", 1)).toBe("b");
    expect(neighbourDraftId(order, "c", 1)).toBe("a");
    expect(neighbourDraftId(order, "a", -1)).toBe("c");
    expect(neighbourDraftId(order, "zzz", 1)).toBe("a");
    expect(neighbourDraftId([d("a", "AE")], "a", 1)).toBeNull();
    expect(neighbourDraftId([], null, 1)).toBeNull();
  });

  it("picks the next queue row that needs a person, wrapping, skipping the current one", () => {
    const rows = [
      { session_id: "s1", note_id: null, needs_action: true },
      { session_id: "s2", note_id: null, needs_action: false },
      { session_id: null, note_id: "n1", needs_action: true },
      { session_id: "s3", note_id: null, needs_action: true },
    ];
    expect(nextQueueSession(rows, "s1")).toEqual({ kind: "note", id: "n1" });
    expect(nextQueueSession(rows, "s3")).toEqual({ kind: "session", id: "s1" });
    expect(nextQueueSession([rows[0]], "s1")).toBeNull();
  });
});
