/**
 * Visit-brief page against a mocked API (the R3.2 endpoints do not exist yet).
 * Mounted without the Layout, so the nav and the disclaimer footer are not part
 * of these tests; the print CSS that keeps the footer is asserted as text.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installMockFetch, type MockResult } from "../../../../test/mockFetch";
import BriefPage from "../BriefPage";
import { PRINT_CSS } from "../printCss";
import { ANSWER_RASH_2, briefJson, CM_PRED, USUBJID } from "./fixture";

const BRIEF_PATH = `/api/v1/participants/${USUBJID}/brief`;
const PRINT_PATH = `${BRIEF_PATH}/print`;

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname + loc.search}</div>;
}

function mount(entry = `/dashboard/participants/${USUBJID}/brief`) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/dashboard/participants/:usubjid/brief" element={<BriefPage />} />
        <Route path="*" element={<div>other page</div>} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}

function mockBrief(handler: (since: string | null) => MockResult = () => ({ json: briefJson() })) {
  return installMockFetch([
    {
      method: "GET",
      path: BRIEF_PATH,
      handler: ({ url }) => handler(url.searchParams.get("since")),
    },
    {
      method: "GET",
      path: PRINT_PATH,
      handler: () => ({ text: "<!doctype html><title>Brief</title><p>printable</p>" }),
    },
  ]);
}

beforeEach(() => {
  // jsdom has no blob URLs and no print dialog.
  URL.createObjectURL = vi.fn(() => "blob:brief-1");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BriefPage", () => {
  it("shows a loading state, then the header with label, cut-off and summary", async () => {
    mockBrief();
    mount();
    expect(screen.getByRole("status")).toHaveTextContent(/Building the visit brief/);
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("P-007");
    expect(screen.getByText(USUBJID)).toBeInTheDocument();
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.parentElement?.textContent).toMatch(/Since .*2026.*generated/);
    expect(screen.getByText(/2 new side effects/)).toBeInTheDocument();
    expect(screen.getByText(/flagged against the protocol/)).toBeInTheDocument();
  });

  it("renders every section with its plain-language decorations", async () => {
    mockBrief();
    const { container } = mount();
    await screen.findByRole("heading", { level: 1 });

    // Sections come from the API, titles verbatim.
    for (const t of [
      "New side effects",
      "Side effects still open",
      "Medication changes",
      "Escalations and report clocks",
      "Notes and calls",
      "Vitals context",
    ]) {
      expect(screen.getByRole("heading", { name: t })).toBeInTheDocument();
    }

    // Grade trend: structured grades (2 → 3) and text fallback (single grade = first report).
    const trends = Array.from(container.querySelectorAll("[data-trend]")).map((e) =>
      e.getAttribute("data-trend"),
    );
    expect(trends).toEqual(["up", "new"]);
    expect(screen.getByText("Worse than last report")).toBeInTheDocument();
    expect(screen.getByText(/grade 2 → 3/)).toBeInTheDocument();

    // Protocol chips: structured "discouraged" with its reference, text-derived "prohibited".
    expect(screen.getByText("Discouraged by protocol")).toBeInTheDocument();
    expect(screen.getByText("§7.7.2 p.69")).toBeInTheDocument();
    expect(screen.getByText("Not allowed by protocol")).toBeInTheDocument();
    expect(screen.getByText(/Protocol exception: “except in life-threatening/)).toBeInTheDocument();
    expect(screen.getByText("Still need: dose, reason taken")).toBeInTheDocument();

    // Escalations: explicit tier name and the AESI clock in plain words.
    expect(screen.getByText("Nurse call today")).toBeInTheDocument();
    expect(screen.getByText("AESI")).toBeInTheDocument();
    expect(
      screen.getByText(/possible event of special interest, investigator to confirm/),
    ).toBeInTheDocument();

    // Notes: note type in words. Vitals: the word SIMULATED beside the value.
    expect(screen.getByText("Phone call")).toBeInTheDocument();
    const vitals = screen
      .getByRole("heading", { name: "Vitals context" })
      .closest("section") as HTMLElement;
    expect(within(vitals).getByText("SIMULATED")).toBeInTheDocument();
    expect(screen.getByText("Context only. Vitals never change a grade.")).toBeInTheDocument();
  });

  it("links each item to its record", async () => {
    mockBrief();
    mount();
    const link = await screen.findByRole("link", { name: /Rash: grade 2, then grade 3/ });
    expect(link).toHaveAttribute("href", "/dashboard/checkins/01JSESSION000000000000RASH");
    await userEvent.click(link);
    expect(screen.getByTestId("location")).toHaveTextContent(
      "/dashboard/checkins/01JSESSION000000000000RASH",
    );
  });

  it("shows the narrative with per-sentence evidence and the writer label", async () => {
    mockBrief();
    mount();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.getByText("Written by template")).toBeInTheDocument();
    const sentences = screen.getByRole("list", { name: "Sentences" });
    const items = within(sentences).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(
      within(items[1]).getByRole("button", { name: `Evidence: Record ${CM_PRED}` }),
    ).toBeInTheDocument();
  });

  it("never labels text from an unknown writer as the template", async () => {
    mockBrief(() => ({
      json: briefJson({
        narrative: {
          kind: "visit_brief",
          writer: "claude",
          sentences: [{ text: "One sentence.", evidence_ids: ["a1"] }],
          text: "One sentence.",
        },
      }),
    }));
    mount();
    const label = await screen.findByText("Writer unknown");
    expect(label).toHaveAttribute("data-writer", "unknown");
    expect(label.getAttribute("title")).not.toMatch(/no AI/);
    expect(screen.queryByText("Written by template")).not.toBeInTheDocument();
  });

  it("renders unsafe item and evidence links as plain text", async () => {
    mockBrief(() => ({
      json: briefJson({
        sections: [
          {
            key: "notes",
            title: "Notes and calls",
            items: [
              { text: "Planted line", evidence_ids: [CM_PRED], link: "javascript:alert(1)" },
              { text: "Data line", evidence_ids: [], link: "data:text/html,<b>x</b>" },
              { text: "Registry line", evidence_ids: [], link: "https://clinicaltrials.gov/x" },
            ],
          },
        ],
        evidence: { [CM_PRED]: { kind: "chart_note", link: "javascript:alert(2)" } },
      }),
    }));
    const { container } = mount();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("link", { name: "Planted line" })).not.toBeInTheDocument();
    expect(screen.getByText("Planted line")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Data line" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Registry line" })).toHaveAttribute(
      "href",
      "https://clinicaltrials.gov/x",
    );
    await userEvent.click(screen.getAllByRole("button", { name: `Evidence: Note ${CM_PRED}` })[0]);
    expect(screen.queryByRole("link", { name: "Open the source record" })).not.toBeInTheDocument();
    for (const a of Array.from(container.querySelectorAll("a"))) {
      expect(a.getAttribute("href") ?? "").not.toMatch(/^\s*(javascript|data):/i);
    }
  });

  it("decorates a ClockFact row passed with `kind` and an open_queries section correctly", async () => {
    mockBrief(() => ({
      json: briefJson({
        sections: [
          {
            key: "clocks",
            title: "24-hour clocks",
            items: [
              {
                kind: "aesi",
                event_label: "Rash, grade 3 (provisional)",
                due_at: "2026-10-11T09:00:00Z",
                status: "running",
                evidence_ids: ["c1"],
              },
            ],
          },
          { key: "open_queries", title: "Open sponsor queries", items: [] },
        ],
      }),
    }));
    mount();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.getByText("Rash, grade 3 (provisional)")).toBeInTheDocument();
    expect(screen.getByText("AESI")).toBeInTheDocument();
    expect(screen.queryByText(/No open side effects/)).not.toBeInTheDocument();
    expect(screen.getByText(/^Nothing recorded/)).toBeInTheDocument();
  });

  it("shows a fallback reason when Claude's text was rejected", async () => {
    mockBrief(() => ({
      json: briefJson({
        narrative: {
          kind: "visit_brief",
          writer: "template",
          fallback_reason: "a cited id did not resolve",
          sentences: [{ text: "One sentence.", evidence_ids: ["a1"] }],
          text: "One sentence.",
        },
      }),
    }));
    mount();
    expect(
      await screen.findByText(/Claude's draft was not used \(a cited id did not resolve\)/),
    ).toBeInTheDocument();
  });

  it("highlights every line that cites a clicked evidence chip, and Esc clears it", async () => {
    mockBrief();
    const { container } = mount();
    await screen.findByRole("heading", { level: 1 });
    const chips = screen.getAllByRole("button", { name: `Evidence: Record ${ANSWER_RASH_2}` });
    await userEvent.click(chips[0]);

    expect(container.querySelectorAll('[data-cited="true"]')).toHaveLength(4);
    expect(screen.getByText(/Highlighting 4 lines that cite/)).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: `Evidence: Record ${ANSWER_RASH_2} (selected)` })
        .length,
    ).toBeGreaterThan(0);

    await userEvent.keyboard("{Escape}");
    expect(container.querySelectorAll('[data-cited="true"]')).toHaveLength(0);
    expect(screen.queryByText(/Highlighting/)).not.toBeInTheDocument();
  });

  it("names and links the evidence when the API sends a lookup", async () => {
    mockBrief(() => ({
      json: briefJson({
        evidence: {
          [CM_PRED]: { kind: "draft", note: "prednisone", link: "/dashboard/checkins/S-PRED" },
        },
      }),
    }));
    mount();
    await screen.findByRole("heading", { level: 1 });
    await userEvent.click(
      screen.getAllByRole("button", { name: `Evidence: Record ${CM_PRED}` })[0],
    );
    const link = screen.getByRole("link", { name: "Open the source record" });
    expect(link).toHaveAttribute("href", "/dashboard/checkins/S-PRED");
    expect(screen.getByText(/“prednisone”/)).toBeInTheDocument();
  });

  it("re-requests the brief when the cut-off date changes, and can reset it", async () => {
    const seen: Array<string | null> = [];
    mockBrief((since) => {
      seen.push(since);
      return { json: briefJson(since ? { since } : {}) };
    });
    mount(`/dashboard/participants/${USUBJID}/brief?since=2026-10-01`);
    await screen.findByRole("heading", { level: 1 });
    expect(seen).toEqual(["2026-10-01"]);

    const picker = screen.getByLabelText("Show everything since");
    expect(picker).toHaveValue("2026-10-01");
    fireEvent.change(picker, { target: { value: "2026-09-20" } });
    await waitFor(() => expect(seen).toEqual(["2026-10-01", "2026-09-20"]));
    expect(screen.getByTestId("location")).toHaveTextContent("since=2026-09-20");

    await userEvent.click(screen.getByRole("button", { name: "Use the last visit date" }));
    await waitFor(() => expect(seen).toEqual(["2026-10-01", "2026-09-20", null]));
    expect(screen.getByTestId("location").textContent).not.toContain("since=");
  });

  it("prints with the browser and opens the server's printable version", async () => {
    const api = mockBrief();
    const print = vi.fn();
    window.print = print;
    const open = vi.spyOn(window, "open").mockReturnValue({} as Window);
    mount();
    await screen.findByRole("heading", { level: 1 });

    await userEvent.click(screen.getByRole("button", { name: "Print" }));
    expect(print).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "Open printable version" }));
    await waitFor(() => expect(open).toHaveBeenCalledWith("blob:brief-1", "_blank"));
    const call = api.find("GET", PRINT_PATH)[0];
    expect(call).toBeDefined();
  });

  it("opens the printable HTML with scripts blocked by a CSP placed first", async () => {
    mockBrief();
    vi.spyOn(window, "open").mockReturnValue({} as Window);
    mount();
    await screen.findByRole("heading", { level: 1 });
    await userEvent.click(screen.getByRole("button", { name: "Open printable version" }));
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled());
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob;
    expect(blob.type).toBe("text/html");
    // jsdom's Blob has no .text(); read it the way a browser page would.
    const html = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsText(blob);
    });
    expect(html).toMatch(
      /^<!doctype html><meta http-equiv="Content-Security-Policy" content="[^"]*script-src 'none'/,
    );
    expect(html).toContain("<p>printable</p>");
  });

  it("offers a link when the browser blocks the printable tab", async () => {
    mockBrief();
    vi.spyOn(window, "open").mockReturnValue(null);
    mount();
    await screen.findByRole("heading", { level: 1 });
    await userEvent.click(screen.getByRole("button", { name: "Open printable version" }));
    expect(await screen.findByRole("link", { name: "Open the printable version" })).toHaveAttribute(
      "href",
      "blob:brief-1",
    );
  });

  it("keeps the footer and hides the nav when printing", () => {
    expect(PRINT_CSS).toContain("header:has(nav)");
    expect(PRINT_CSS).toContain("[data-print-hide]");
    expect(PRINT_CSS).not.toMatch(/footer\s*[,{][^}]*display:\s*none/);
  });

  it("toggles technical ids (section keys, SDTM names, template ids)", async () => {
    mockBrief();
    mount();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByText("med_changes")).not.toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("Show technical ids"));
    expect(screen.getByText("med_changes")).toBeInTheDocument();
    expect(screen.getByText("(CMDOSE, CMINDC)")).toBeInTheDocument();
    expect(screen.getByText("brief.conmed_flag")).toBeInTheDocument();
  });

  it("checks off questions locally", async () => {
    mockBrief();
    mount();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.getByText("0/2 done")).toBeInTheDocument();
    const box = screen.getByRole("checkbox", { name: /Is the rash still there\?/ });
    await userEvent.click(box);
    expect(box).toBeChecked();
    expect(screen.getByText("1/2 done")).toBeInTheDocument();
    expect(screen.getByText("Side effect still open")).toBeInTheDocument();
  });

  it("shows a calm empty state", async () => {
    mockBrief(() => ({
      json: briefJson({
        sections: [
          { key: "new_side_effects", title: "New side effects", items: [] },
          { key: "vitals", title: "Vitals context", items: [] },
        ],
        questions_to_ask: [],
        narrative: null,
      }),
    }));
    mount();
    expect(await screen.findByText(/Pick an earlier date to see more/)).toBeInTheDocument();
    expect(screen.getByText(/No new side effects since/)).toBeInTheDocument();
    expect(screen.getByText("No open questions for this visit.")).toBeInTheDocument();
    expect(screen.getByText("No paragraph was returned for this brief.")).toBeInTheDocument();
  });

  it("says when the participant does not exist (no retry)", async () => {
    mockBrief(() => ({
      status: 404,
      json: { type: "about:blank", title: "Not Found", status: 404, detail: "no participant" },
    }));
    mount();
    expect(await screen.findByText(`No participant found for “${USUBJID}”`)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to the queue" })).toBeInTheDocument();
  });

  it("retries after a server error", async () => {
    let calls = 0;
    mockBrief(() => {
      calls++;
      return calls === 1
        ? { status: 500, json: { type: "about:blank", title: "Server Error", status: 500 } }
        : { json: briefJson() };
    });
    mount();
    await userEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("P-007");
  });

  it("sends the bearer token", async () => {
    sessionStorage.setItem(
      "interim.auth",
      JSON.stringify({ token: "tok-123", role: "investigator" }),
    );
    const api = mockBrief();
    mount();
    await screen.findByRole("heading", { level: 1 });
    expect(api.find("GET", BRIEF_PATH)[0].headers.authorization).toBe("Bearer tok-123");
  });
});
