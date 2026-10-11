/**
 * Packet page against a mocked API (the R3/R4 endpoints are being built in
 * parallel). Mounted without the Layout, so only this page is exercised; the
 * not-a-medical-device footer comes from Layout.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { ToastProvider } from "../../../../components/Toast";
import { AUTH_STORAGE_KEY } from "../../../../lib/api";
import { resetAuthCache } from "../../../../lib/auth";
import type { Role } from "../../../../lib/types";
import { installMockFetch, type Route as MockRoute } from "../../../../test/mockFetch";
import PacketPage from "../PacketPage";
import {
  ANSWER_ID,
  CLOCK_ID,
  draftPacket,
  FOLLOWUP_ID,
  followUpPacket,
  NOTE_ID,
  PACKET_ID,
  signedPacket,
} from "./fixtures";

const NOW = Date.parse("2026-10-12T07:00:00.000Z");

function signIn(role: Role) {
  sessionStorage.setItem(
    AUTH_STORAGE_KEY,
    JSON.stringify({
      token: "t",
      role,
      display_name: role,
      expires_at: "2099-01-01T00:00:00.000Z",
    }),
  );
  resetAuthCache();
}

function renderAt(path: string) {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/dashboard/packets/:id" element={<PacketPage />} />
          <Route path="/dashboard" element={<div>Queue page</div>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

const packetPath = new RegExp(`^/api/v1/packets/([^/]+)$`);

function routes(packets: Record<string, Record<string, unknown>>, extra: MockRoute[] = []) {
  const store = { ...packets };
  const list: MockRoute[] = [
    ...extra,
    {
      method: "GET",
      path: packetPath,
      handler: ({ params }) =>
        store[params[0]]
          ? { json: store[params[0]] }
          : { status: 404, json: { type: "about:blank", title: "Not Found", status: 404 } },
    },
  ];
  return { list, store };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PacketPage: header and fields", () => {
  it("leads with plain language, a live deadline and the why sentence", async () => {
    signIn("coordinator");
    installMockFetch(routes({ [PACKET_ID]: draftPacket() }).list);
    renderAt(`/dashboard/packets/${PACKET_ID}`);

    expect(
      await screen.findByRole("heading", { level: 1, name: /Serious event report/ }),
    ).toBeInTheDocument();
    // Abbreviation one level deeper, as a small badge.
    expect(screen.getByText("SAE")).toBeInTheDocument();
    expect(screen.getByTestId("sequence-label")).toHaveTextContent("Initial report");
    expect(screen.getByTestId("status-label")).toHaveTextContent("Draft, not signed");
    expect(screen.getByTestId("packet-explainer")).toHaveTextContent(/within 24 hours/);
    // 2026-10-13T05:00Z due, now 2026-10-12T07:00Z → 22h left.
    expect(screen.getByTestId("deadline")).toHaveTextContent("22h 00m left");
    expect(screen.getAllByText(/P-004/).length).toBeGreaterThan(0);

    // Plain label first, SDTM name as a badge.
    const row = document.querySelector('[data-field="AETERM"]') as HTMLElement;
    expect(within(row).getByText("Side effect, in the note's words")).toBeInTheDocument();
    expect(within(row).getByText("AETERM")).toBeInTheDocument();
    expect(within(row).getByText("shortness of breath")).toBeInTheDocument();

    // Unknown values are said plainly.
    const outcome = document.querySelector('[data-field="AEOUT"]') as HTMLElement;
    expect(within(outcome).getByText("Not known yet")).toBeInTheDocument();

    // Missing information checklist.
    const missing = screen.getByRole("list", { name: "Information still needed" });
    expect(within(missing).getAllByRole("listitem")).toHaveLength(2);
    expect(within(missing).getByText("Outcome of the event")).toBeInTheDocument();
  });

  it("shows a field's evidence (kind, quote, time, id, source link) on click", async () => {
    signIn("coordinator");
    installMockFetch(routes({ [PACKET_ID]: draftPacket() }).list);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderAt(`/dashboard/packets/${PACKET_ID}`);

    const row = (await screen.findByText("AETERM")).closest("tr") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: /Show evidence: Chart note/ }));

    const inspector = screen.getByTestId("evidence-inspector");
    expect(within(inspector).getByText(/worsening shortness of breath/)).toBeInTheDocument();
    expect(within(inspector).getByText(NOTE_ID)).toBeInTheDocument();
    expect(within(inspector).getByText("Side effect, in the note's words")).toBeInTheDocument();
    expect(within(inspector).getByRole("link", { name: "Open the source record" })).toHaveAttribute(
      "href",
      `/dashboard/notes/${NOTE_ID}`,
    );
    expect(within(inspector).getByText(/2026|Oct/)).toBeInTheDocument();
  });
});

describe("PacketPage: narrative", () => {
  it("labels the writer, marks the text as a draft and resolves sentence evidence", async () => {
    signIn("coordinator");
    installMockFetch(routes({ [PACKET_ID]: draftPacket() }).list);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderAt(`/dashboard/packets/${PACKET_ID}`);

    expect(await screen.findByTestId("writer-label")).toHaveTextContent("Written by template");
    expect(screen.getByText(/not final until the investigator/)).toBeInTheDocument();

    const sentences = screen.getByRole("list", { name: "Narrative sentences with evidence" });
    const second = within(sentences).getAllByRole("listitem")[1];
    // One id resolves to the gate answer on a field, one does not resolve.
    await user.click(within(second).getByRole("button", { name: new RegExp(ANSWER_ID) }));
    const inspector = screen.getByTestId("evidence-inspector");
    expect(within(inspector).getByText("Check-in question")).toBeInTheDocument();
    expect(within(inspector).getByText("Narrative sentence 2")).toBeInTheDocument();

    await user.click(within(second).getByRole("button", { name: /01JUNKNOWN/ }));
    expect(within(inspector).getByText(/does not include the details/)).toBeInTheDocument();

    // A coordinator cannot rewrite the narrative.
    expect(screen.queryByRole("button", { name: "Edit narrative" })).not.toBeInTheDocument();
  });

  it("says when Claude's draft was rejected", async () => {
    signIn("coordinator");
    const p = draftPacket();
    p.narrative = {
      ...(p.narrative as Record<string, unknown>),
      fallback_reason: "a quote was not verbatim",
    };
    installMockFetch(routes({ [PACKET_ID]: p }).list);
    renderAt(`/dashboard/packets/${PACKET_ID}`);
    expect(await screen.findByText(/a quote was not verbatim/)).toBeInTheDocument();
  });
});

describe("PacketPage: editing and saving", () => {
  it("stages field edits and saves them in one versioned PATCH", async () => {
    signIn("coordinator");
    const { list, store } = routes({ [PACKET_ID]: draftPacket() });
    const mock = installMockFetch([
      {
        method: "PATCH",
        path: `/api/v1/packets/${PACKET_ID}`,
        handler: ({ body }) => {
          const b = body as { fields: Record<string, unknown> };
          const p = draftPacket({ version: 2 });
          (p.fields as Array<Record<string, unknown>>)[2] = {
            name: "AEOUT",
            plain_label: "Outcome",
            value: b.fields.AEOUT,
            evidence: [],
            edited: true,
          };
          store[PACKET_ID] = p;
          return { json: p };
        },
      },
      ...list,
    ]);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderAt(`/dashboard/packets/${PACKET_ID}`);

    const save = await screen.findByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    // Coordinators edit but cannot sign: no Sign control at all, a plain note instead.
    expect(screen.queryByRole("button", { name: "Sign" })).not.toBeInTheDocument();
    expect(screen.getByText("Only the investigator can sign this report.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Edit Outcome" }));
    await user.type(screen.getByLabelText("New value for Outcome"), "Recovering");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(screen.getByText(/Changed, not saved yet/)).toBeInTheDocument();
    expect(screen.getByText(/Unsaved changes: 1 field/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mock.find("PATCH", `/api/v1/packets/${PACKET_ID}`)).toHaveLength(1));
    expect(mock.find("PATCH", `/api/v1/packets/${PACKET_ID}`)[0].body).toEqual({
      fields: { AEOUT: "Recovering" },
    });
    expect(await screen.findByText("Version 2")).toBeInTheDocument();
    expect(screen.getByText("Edited by a person")).toBeInTheDocument();
    expect(screen.queryByText(/Changed, not saved yet/)).not.toBeInTheDocument();
  });

  it("lets the investigator rewrite the narrative and saves it as narrative_text", async () => {
    signIn("investigator");
    const { list } = routes({ [PACKET_ID]: draftPacket() });
    const mock = installMockFetch([
      {
        method: "PATCH",
        path: `/api/v1/packets/${PACKET_ID}`,
        handler: ({ body }) => ({
          json: draftPacket({
            version: 2,
            narrative_edited: {
              text: (body as { narrative_text: string }).narrative_text,
              edited_by: "investigator",
              edited_at: "2026-10-12T07:01:00.000Z",
            },
          }),
        }),
      },
      ...list,
    ]);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderAt(`/dashboard/packets/${PACKET_ID}`);

    await user.click(await screen.findByRole("button", { name: "Edit narrative" }));
    const area = screen.getByLabelText("Narrative text (your edit)");
    await user.clear(area);
    await user.type(area, "Seen in the ER on 12 Oct for breathlessness.");
    // Sign is blocked while there are unsaved edits.
    expect(screen.getByRole("button", { name: "Sign" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mock.find("PATCH", `/api/v1/packets/${PACKET_ID}`)).toHaveLength(1));
    expect(mock.find("PATCH", `/api/v1/packets/${PACKET_ID}`)[0].body).toEqual({
      narrative_text: "Seen in the ER on 12 Oct for breathlessness.",
    });
    expect(await screen.findByTestId("narrative-current")).toHaveTextContent(
      "Seen in the ER on 12 Oct for breathlessness.",
    );
    // The generated sentences stay one click deeper.
    expect(screen.getByText(/Generated sentences and their evidence \(2\)/)).toBeInTheDocument();
  });

  it("shows the save error without losing staged edits", async () => {
    signIn("coordinator");
    const { list } = routes({ [PACKET_ID]: draftPacket() });
    installMockFetch([
      {
        method: "PATCH",
        path: `/api/v1/packets/${PACKET_ID}`,
        handler: () => ({
          status: 422,
          json: {
            type: "about:blank",
            title: "Unprocessable Entity",
            status: 422,
            detail: "bad value",
          },
        }),
      },
      ...list,
    ]);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderAt(`/dashboard/packets/${PACKET_ID}`);
    await user.click(await screen.findByRole("button", { name: "Edit Outcome" }));
    await user.type(screen.getByLabelText("New value for Outcome"), "x");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/bad value/)).toBeInTheDocument();
    expect(screen.getByText(/Changed, not saved yet/)).toBeInTheDocument();
  });
});

describe("PacketPage: signing", () => {
  it("confirms in-page (no window.confirm), then signs and stops the clock", async () => {
    signIn("investigator");
    const confirmSpy = vi.spyOn(window, "confirm");
    const { list, store } = routes({ [PACKET_ID]: draftPacket() });
    const mock = installMockFetch([
      {
        method: "POST",
        path: `/api/v1/packets/${PACKET_ID}/sign`,
        handler: () => {
          store[PACKET_ID] = signedPacket();
          return { json: { packet: signedPacket(), mock_edc_ack: { ack_id: "EDC-ACK-7" } } };
        },
      },
      ...list,
    ]);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderAt(`/dashboard/packets/${PACKET_ID}`);

    await user.click(await screen.findByRole("button", { name: "Sign" }));
    const panel = screen.getByTestId("sign-confirm");
    expect(within(panel).getByText(/Nothing is sent to a real sponsor/)).toBeInTheDocument();
    expect(within(panel).getByText(/2 items are still listed as missing/)).toBeInTheDocument();
    const yes = within(panel).getByRole("button", { name: "Yes, sign the report" });
    expect(yes).toBeDisabled();
    await user.click(within(panel).getByLabelText(/I have reviewed every field/));
    await user.click(yes);

    await waitFor(() =>
      expect(mock.find("POST", `/api/v1/packets/${PACKET_ID}/sign`)).toHaveLength(1),
    );
    expect(await screen.findByTestId("status-label")).toHaveTextContent("Signed");
    expect(screen.getByText("Reported (mock)")).toBeInTheDocument();
    expect(screen.getByText("EDC-ACK-7")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start follow-up report" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit Outcome" })).not.toBeInTheDocument();
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("can cancel the confirmation", async () => {
    signIn("investigator");
    installMockFetch(routes({ [PACKET_ID]: draftPacket() }).list);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderAt(`/dashboard/packets/${PACKET_ID}`);
    await user.click(await screen.findByRole("button", { name: "Sign" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("sign-confirm")).not.toBeInTheDocument();
  });
});

describe("PacketPage: follow-up reports (R4.2)", () => {
  it("starts a follow-up from a signed packet and shows what changed", async () => {
    signIn("coordinator");
    const { list, store } = routes({ [PACKET_ID]: signedPacket() });
    const mock = installMockFetch([
      {
        method: "POST",
        path: `/api/v1/packets/${PACKET_ID}/follow-up`,
        handler: () => {
          store[FOLLOWUP_ID] = followUpPacket();
          return { json: followUpPacket() };
        },
      },
      ...list,
    ]);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderAt(`/dashboard/packets/${PACKET_ID}`);

    expect(
      await screen.findByText(/This report is signed and can no longer be changed/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start follow-up report" }));

    await waitFor(() =>
      expect(mock.find("POST", `/api/v1/packets/${PACKET_ID}/follow-up`)).toHaveLength(1),
    );
    await waitFor(() =>
      expect(screen.getByTestId("sequence-label")).toHaveTextContent("Follow-up 1"),
    );
    expect(
      screen.getByRole("heading", { name: "Changes since the previous report" }),
    ).toBeInTheDocument();
    const change = document.querySelector('[data-change="AEOUT"]') as HTMLElement;
    // Plain label taken from the matching field.
    expect(within(change).getByText("Outcome")).toBeInTheDocument();
    expect(within(change).getByText("Not known yet")).toBeInTheDocument();
    expect(within(change).getByText("Recovering")).toBeInTheDocument();
    await user.click(within(change).getByRole("button", { name: /Show evidence: Phone call/ }));
    expect(
      within(screen.getByTestId("evidence-inspector")).getByText(/breathing is better/, {
        selector: "blockquote",
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the previous report" })).toHaveAttribute(
      "href",
      `/dashboard/packets/${PACKET_ID}`,
    );
  });
});

describe("PacketPage: deadline fallback, create-from-clock, errors, files", () => {
  it("reads the deadline from /sae-clocks when the packet omits it", async () => {
    signIn("coordinator");
    const { list } = routes({
      [PACKET_ID]: draftPacket({ due_at: null, site_awareness_at: null }),
    });
    installMockFetch([
      {
        method: "GET",
        path: "/api/v1/sae-clocks",
        handler: ({ url }) => {
          expect(url.searchParams.get("active")).toBe("false");
          return {
            json: [
              {
                id: CLOCK_ID,
                kind: "sae",
                site_awareness_at: "2026-10-12T05:00:00.000Z",
                due_at: "2026-10-12T08:00:00.000Z",
                stopped_at: null,
                decision: null,
              },
            ],
          };
        },
      },
      ...list,
    ]);
    renderAt(`/dashboard/packets/${PACKET_ID}`);
    expect(await screen.findByText("1h 00m left")).toBeInTheDocument();
  });

  it("creates the packet for a clock and replaces the URL", async () => {
    signIn("coordinator");
    const { list } = routes({ [PACKET_ID]: draftPacket() });
    const mock = installMockFetch([
      { method: "POST", path: "/api/v1/packets", handler: () => ({ json: draftPacket() }) },
      ...list,
    ]);
    renderAt(`/dashboard/packets/new?clock=${CLOCK_ID}`);
    expect(
      await screen.findByRole("heading", { level: 1, name: /Serious event report/ }),
    ).toBeInTheDocument();
    expect(mock.find("POST", "/api/v1/packets")[0].body).toEqual({ clock_id: CLOCK_ID });
  });

  it("shows a not-found state", async () => {
    signIn("coordinator");
    installMockFetch(routes({}).list);
    renderAt(`/dashboard/packets/NOPE`);
    expect(await screen.findByText("This report does not exist.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("offers a retry on a server error", async () => {
    signIn("coordinator");
    let calls = 0;
    installMockFetch([
      {
        method: "GET",
        path: packetPath,
        handler: () => {
          calls += 1;
          return calls === 1
            ? { status: 500, json: { type: "about:blank", title: "Server Error", status: 500 } }
            : { json: draftPacket() };
        },
      },
    ]);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderAt(`/dashboard/packets/${PACKET_ID}`);
    await user.click(await screen.findByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: /Serious event report/ }),
    ).toBeInTheDocument();
  });

  it("labels an AESI packet in plain words", async () => {
    signIn("coordinator");
    installMockFetch(routes({ [PACKET_ID]: draftPacket({ kind: "aesi" }) }).list);
    renderAt(`/dashboard/packets/${PACKET_ID}`);
    expect(
      await screen.findByRole("heading", { level: 1, name: /Special-interest event report/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("AESI")).toBeInTheDocument();
    expect(screen.getByTestId("packet-explainer")).toHaveTextContent(/investigator to confirm/);
  });

  it("prints through an authenticated fetch and exports JSON", async () => {
    signIn("coordinator");
    const fakeWin = { location: { href: "" }, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(fakeWin as unknown as Window);
    // jsdom cannot navigate to a download; the click itself is what we need.
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    // jsdom has no object URLs; stub them for this test and put them back after.
    const original = {
      create: Object.getOwnPropertyDescriptor(URL, "createObjectURL"),
      revoke: Object.getOwnPropertyDescriptor(URL, "revokeObjectURL"),
    };
    onTestFinished(() => {
      for (const [key, desc] of [
        ["createObjectURL", original.create],
        ["revokeObjectURL", original.revoke],
      ] as const) {
        if (desc) Object.defineProperty(URL, key, desc);
        else delete (URL as unknown as Record<string, unknown>)[key];
      }
    });
    Object.defineProperty(URL, "createObjectURL", {
      value: vi.fn(() => "blob:packet"),
      configurable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
    const { list } = routes({ [PACKET_ID]: draftPacket() });
    const mock = installMockFetch([
      {
        method: "GET",
        path: `/api/v1/packets/${PACKET_ID}/print`,
        handler: () => ({
          text: "<html><body>Packet</body></html>",
          headers: { "Content-Type": "text/html" },
        }),
      },
      {
        method: "GET",
        path: `/api/v1/packets/${PACKET_ID}/export.json`,
        handler: () => ({ json: draftPacket() }),
      },
      ...list,
    ]);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderAt(`/dashboard/packets/${PACKET_ID}`);

    await user.click(await screen.findByRole("button", { name: "Print" }));
    await waitFor(() => expect(fakeWin.location.href).toBe("blob:packet"));
    const printCall = mock.find("GET", `/api/v1/packets/${PACKET_ID}/print`)[0];
    expect(printCall.headers.authorization).toBe("Bearer t");

    await user.click(screen.getByRole("button", { name: "Export JSON" }));
    await waitFor(() =>
      expect(mock.find("GET", `/api/v1/packets/${PACKET_ID}/export.json`)).toHaveLength(1),
    );
    expect(await screen.findByText(`packet-${PACKET_ID}.json downloaded`)).toBeInTheDocument();
    expect(anchorClick).toHaveBeenCalled();
  });
});
