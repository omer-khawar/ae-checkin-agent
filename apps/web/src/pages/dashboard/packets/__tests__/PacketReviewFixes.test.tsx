/**
 * Regression tests for the packet-page review findings:
 *  1. Signing never covers text other than what the server holds (the page
 *     freezes while the sign confirmation is open).
 *  2. MEASURED / SIMULATED is always a visible word next to a vitals value.
 *  3. Follow-up reports never count down a 24-hour clock that is already stopped.
 *  4. A packet that already has a follow-up opens it instead of starting another.
 *  5. Role gating matches the API (admin edits fields; only the investigator sees Sign).
 *  6. A person's narrative rewrite is labelled as theirs, not the writer's.
 *  7. Print HTML is shown under a no-script CSP and its object URL is revoked.
 *  8. The history card's description list holds only dt/dd groups.
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
import { fieldMeasured, lockDownPrintHtml, normalizePacket, PRINT_CSP } from "../model";
import PacketPage from "../PacketPage";
import { HistoryCard, SignConfirm } from "../PacketParts";
import {
  CLOCK_ID,
  draftPacket,
  FOLLOWUP_ID,
  followUpPacket,
  PACKET_ID,
  signedPacket,
} from "./fixtures";

const NOW = Date.parse("2026-10-12T07:00:00.000Z");
const packetPath = /^\/api\/v1\/packets\/([^/]+)$/;

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
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

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

/** A vitals field as R3.2 shapes it, optionally with the `is_measured` extras. */
function vitalsPacket(fieldMeasuredFlag: boolean | undefined, evidenceFlag: boolean | undefined) {
  const p = draftPacket();
  const ev: Record<string, unknown> = {
    kind: "vitals_sample",
    id: "01JVITALS00000000000000000",
    ts: "2026-10-12T04:00:00.000Z",
    note: "pulse median 118",
  };
  if (evidenceFlag !== undefined) ev.is_measured = evidenceFlag;
  const field: Record<string, unknown> = {
    name: "VSORRES_PULSE",
    plain_label: "Pulse at check-in",
    value: 118,
    evidence: [ev],
  };
  if (fieldMeasuredFlag !== undefined) field.is_measured = fieldMeasuredFlag;
  (p.fields as unknown[]).push(field);
  return p;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// 1. Sign confirmation freezes the page
// ---------------------------------------------------------------------------

describe("signing never covers unsaved text", () => {
  it("hides every edit control while the confirmation is open", async () => {
    signIn("investigator");
    const { list } = routes({ [PACKET_ID]: draftPacket() });
    installMockFetch(list);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderAt(`/dashboard/packets/${PACKET_ID}`);

    // Investigator edits fields and the narrative before confirming.
    expect(await screen.findByRole("button", { name: "Edit Outcome" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit narrative" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Sign" }));
    expect(screen.getByTestId("sign-confirm")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit Outcome" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit narrative" })).not.toBeInTheDocument();
    expect(screen.getByText(/Editing is paused while the signature/)).toBeInTheDocument();

    // Cancel gives the controls back.
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Edit narrative" })).toBeInTheDocument();
  });

  it("hides an open (unchanged) narrative editor during confirmation and clears it after signing", async () => {
    signIn("investigator");
    const { list, store } = routes({ [PACKET_ID]: draftPacket() });
    const mock = installMockFetch([
      {
        method: "POST",
        path: `/api/v1/packets/${PACKET_ID}/sign`,
        handler: () => {
          store[PACKET_ID] = signedPacket();
          return { json: signedPacket() };
        },
      },
      ...list,
    ]);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderAt(`/dashboard/packets/${PACKET_ID}`);

    // Open the editor without changing the text: the page is not dirty, so Sign is allowed.
    await user.click(await screen.findByRole("button", { name: "Edit narrative" }));
    expect(screen.getByLabelText("Narrative text (your edit)")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign" }));
    // The text area cannot be typed into while the signature is being confirmed.
    expect(screen.queryByLabelText("Narrative text (your edit)")).not.toBeInTheDocument();

    const panel = screen.getByTestId("sign-confirm");
    await user.click(within(panel).getByLabelText(/I have reviewed every field/));
    await user.click(within(panel).getByRole("button", { name: "Yes, sign the report" }));

    await waitFor(() =>
      expect(mock.find("POST", `/api/v1/packets/${PACKET_ID}/sign`)).toHaveLength(1),
    );
    expect(mock.find("PATCH", `/api/v1/packets/${PACKET_ID}`)).toHaveLength(0);
    expect(await screen.findByTestId("status-label")).toHaveTextContent("Signed");
    // No leftover editor, no "unsaved" bar, no "changed, not saved" rows.
    expect(screen.queryByLabelText("Narrative text (your edit)")).not.toBeInTheDocument();
    expect(screen.queryByText(/Unsaved changes/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Changed, not saved yet/)).not.toBeInTheDocument();
  });

  it("SignConfirm blocks the signature while the page holds unsaved edits", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <SignConfirm
        packet={normalizePacket(draftPacket())}
        missingCount={0}
        dirty
        busy={false}
        onConfirm={onConfirm}
        onCancel={() => undefined}
      />,
    );
    await user.click(screen.getByLabelText(/I have reviewed every field/));
    expect(screen.getByRole("button", { name: "Yes, sign the report" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(/unsaved changes/);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. MEASURED / SIMULATED next to every vitals value
// ---------------------------------------------------------------------------

describe("vitals values always carry the measured/simulated word", () => {
  it("fieldMeasured reads the field flag, else agreeing evidence, else 'not_stated'", () => {
    const fieldOf = (p: Record<string, unknown>) =>
      normalizePacket(p).fields.find((f) => f.name === "VSORRES_PULSE")!;
    expect(fieldMeasured(fieldOf(vitalsPacket(true, undefined)))).toBe(true);
    expect(fieldMeasured(fieldOf(vitalsPacket(undefined, false)))).toBe(false);
    expect(fieldMeasured(fieldOf(vitalsPacket(undefined, undefined)))).toBe("not_stated");
    // Not a vitals value at all.
    expect(fieldMeasured(normalizePacket(draftPacket()).fields[0])).toBeNull();
  });

  it("shows SIMULATED when the API says so", async () => {
    signIn("coordinator");
    installMockFetch(routes({ [PACKET_ID]: vitalsPacket(false, false) }).list);
    renderAt(`/dashboard/packets/${PACKET_ID}`);
    const row = (await screen.findByText("VSORRES_PULSE")).closest("tr") as HTMLElement;
    expect(within(row).getByText("118")).toBeInTheDocument();
    // Badge next to the value, and the word on the evidence chip.
    expect(within(row).getByText("SIMULATED")).toBeInTheDocument();
    expect(
      within(row).getByRole("button", { name: /Show evidence: Vitals reading/ }),
    ).toHaveTextContent(/SIMULATED/);
  });

  it("says 'not stated' visibly when a contract-shaped vitals field has no flag", async () => {
    signIn("coordinator");
    installMockFetch(routes({ [PACKET_ID]: vitalsPacket(undefined, undefined) }).list);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderAt(`/dashboard/packets/${PACKET_ID}`);
    const row = (await screen.findByText("VSORRES_PULSE")).closest("tr") as HTMLElement;
    const badge = row.querySelector('[data-measured="not_stated"]') as HTMLElement;
    expect(badge).toHaveTextContent("MEASURED / SIMULATED: not stated");
    const chip = within(row).getByRole("button", { name: /Show evidence: Vitals reading/ });
    expect(chip).toHaveTextContent("MEASURED / SIMULATED: not stated");
    await user.click(chip);
    expect(
      within(screen.getByTestId("evidence-inspector")).getByText(
        "MEASURED / SIMULATED: not stated",
      ),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 3 + 4. Follow-ups: no countdown, wording, and no duplicate follow-ups
// ---------------------------------------------------------------------------

describe("follow-up reports", () => {
  it("never shows an overdue countdown, and the confirmation does not promise to stop the clock", async () => {
    signIn("investigator");
    // The API copied the original due_at (now 30h in the past) onto the follow-up.
    const fu = followUpPacket();
    fu.due_at = "2026-10-11T01:00:00.000Z";
    const { list } = routes({ [FOLLOWUP_ID]: fu }, [
      {
        method: "GET",
        path: "/api/v1/sae-clocks",
        handler: () => ({
          json: [
            {
              id: CLOCK_ID,
              kind: "sae",
              site_awareness_at: "2026-10-10T01:00:00.000Z",
              due_at: "2026-10-11T01:00:00.000Z",
              stopped_at: "2026-10-10T20:00:00.000Z",
              decision: "reported (mock)",
            },
          ],
        }),
      },
    ]);
    installMockFetch(list);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderAt(`/dashboard/packets/${FOLLOWUP_ID}`);

    const box = await screen.findByTestId("deadline");
    expect(box).toHaveTextContent("Stopped by the initial report");
    expect(box).not.toHaveTextContent(/overdue|left/i);
    await waitFor(() => expect(box).toHaveTextContent("Initial report sent"));

    await user.click(screen.getByRole("button", { name: "Sign" }));
    const panel = screen.getByTestId("sign-confirm");
    expect(panel).toHaveTextContent(/already stopped by the initial report/);
    expect(panel).not.toHaveTextContent("The 24-hour clock stops");
    expect(within(panel).getByRole("button", { name: "Yes, sign the follow-up" })).toBeDisabled();
  });

  it("opens the existing follow-up instead of starting a second one", async () => {
    signIn("coordinator");
    const { list } = routes({
      [PACKET_ID]: signedPacket({ followup_packet_ids: [FOLLOWUP_ID] }),
      [FOLLOWUP_ID]: followUpPacket(),
    });
    const mock = installMockFetch(list);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderAt(`/dashboard/packets/${PACKET_ID}`);

    const open = await screen.findByRole("button", { name: "Open follow-up 1" });
    expect(
      screen.queryByRole("button", { name: "Start follow-up report" }),
    ).not.toBeInTheDocument();
    await user.click(open);
    await waitFor(() =>
      expect(screen.getByTestId("sequence-label")).toHaveTextContent("Follow-up 1"),
    );
    expect(mock.find("POST", `/api/v1/packets/${PACKET_ID}/follow-up`)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Role gating
// ---------------------------------------------------------------------------

describe("role gating matches the API", () => {
  it("lets an admin edit fields but shows no Sign or narrative editing", async () => {
    signIn("admin");
    installMockFetch(routes({ [PACKET_ID]: draftPacket() }).list);
    renderAt(`/dashboard/packets/${PACKET_ID}`);
    expect(await screen.findByRole("button", { name: "Edit Outcome" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit narrative" })).not.toBeInTheDocument();
    expect(screen.getByText("Only the investigator can sign this report.")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 6. Narrative authorship label
// ---------------------------------------------------------------------------

describe("narrative authorship", () => {
  it("labels a person's rewrite as theirs and keeps the writer label on the generated sentences", async () => {
    signIn("investigator");
    installMockFetch(
      routes({
        [PACKET_ID]: signedPacket({
          narrative_edited: {
            text: "Seen in the ER on 12 Oct for breathlessness.",
            edited_by: "Dr Rivera",
            edited_at: "2026-10-12T09:00:00.000Z",
          },
        }),
      }).list,
    );
    renderAt(`/dashboard/packets/${PACKET_ID}`);
    expect(await screen.findByTestId("writer-label")).toHaveTextContent(
      "Edited by Dr Rivera (from a template draft)",
    );
    expect(screen.getByTestId("generated-writer-label")).toHaveTextContent("Written by template");
  });
});

// ---------------------------------------------------------------------------
// 7. Print isolation
// ---------------------------------------------------------------------------

describe("print isolation", () => {
  it("lockDownPrintHtml puts a no-script CSP first (after any doctype)", () => {
    const withDoctype = lockDownPrintHtml(
      "<!DOCTYPE html><html><head></head><body>x</body></html>",
    );
    expect(
      withDoctype.startsWith('<!DOCTYPE html><meta http-equiv="Content-Security-Policy"'),
    ).toBe(true);
    const bare = lockDownPrintHtml("<p>x</p>");
    expect(bare.startsWith("<meta http-equiv")).toBe(true);
    expect(PRINT_CSP).toContain("script-src 'none'");
    expect(PRINT_CSP).not.toContain("unsafe-eval");
    // Inline handlers are blocked because no 'unsafe-inline' is granted to scripts.
    expect(PRINT_CSP).not.toMatch(/script-src[^;]*unsafe-inline/);
  });

  it("opens the print page under the CSP, cuts the opener and revokes the object URL", async () => {
    signIn("coordinator");
    const fakeWin: { location: { href: string }; close: () => void; opener: unknown } = {
      location: { href: "" },
      close: vi.fn(),
      opener: window,
    };
    vi.spyOn(window, "open").mockReturnValue(fakeWin as unknown as Window);
    const blobs: Blob[] = [];
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
      value: vi.fn((b: Blob) => {
        blobs.push(b);
        return "blob:print";
      }),
      configurable: true,
    });
    const revoke = vi.fn();
    Object.defineProperty(URL, "revokeObjectURL", { value: revoke, configurable: true });

    const { list } = routes({ [PACKET_ID]: draftPacket() }, [
      {
        method: "GET",
        path: `/api/v1/packets/${PACKET_ID}/print`,
        handler: () => ({
          text: "<!doctype html><html><body><img src=x onerror=alert(1)></body></html>",
          headers: { "Content-Type": "text/html" },
        }),
      },
    ]);
    installMockFetch(list);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderAt(`/dashboard/packets/${PACKET_ID}`);

    await user.click(await screen.findByRole("button", { name: "Print" }));
    await waitFor(() => expect(fakeWin.location.href).toBe("blob:print"));
    expect(fakeWin.opener).toBeNull();
    // jsdom's Blob has no .text(); read it the old way.
    const html = await new Promise<string>((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.readAsText(blobs[0]);
    });
    expect(html).toContain(`content="${PRINT_CSP}"`);
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(html.indexOf("<img"));

    vi.advanceTimersByTime(60_000);
    expect(revoke).toHaveBeenCalledWith("blob:print");
  });
});

// ---------------------------------------------------------------------------
// 8. History card markup
// ---------------------------------------------------------------------------

describe("history card markup", () => {
  it("keeps only dt/dd groups inside the description list", () => {
    const packet = normalizePacket(
      followUpPacket() as Record<string, unknown> & { followup_packet_ids?: string[] },
    );
    packet.followup_packet_ids = ["01JPACKET0000000000000000C"];
    const { container } = render(
      <MemoryRouter>
        <HistoryCard packet={packet} />
      </MemoryRouter>,
    );
    const dl = container.querySelector("dl") as HTMLElement;
    for (const child of Array.from(dl.children)) {
      expect(child.tagName).toBe("DIV");
      for (const inner of Array.from(child.children)) {
        expect(["DT", "DD"]).toContain(inner.tagName);
      }
    }
    // The previous-report link and the id line still render, outside the list.
    const link = screen.getByRole("link", { name: "Open the previous report" });
    expect(dl.contains(link)).toBe(false);
    expect(screen.getByText(/^packet /)).toBeInTheDocument();
  });
});
