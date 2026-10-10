/**
 * Audit page against a mocked API (CONTRACTS.md §2.2 GET /audit, GET /audit/verify,
 * GET /export/*). Uses the shared route-table fetch mock from src/test.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "../../../../components/Toast";
import { AUTH_STORAGE_KEY } from "../../../../lib/api";
import type { AuditEvent, AuditVerifyResult, Paginated } from "../../../../lib/types";
import { installMockFetch, type Route } from "../../../../test/mockFetch";
import { Audit } from "../../Audit";
import { GENESIS_PREV_HASH } from "../auditLib";

// ---------------------------------------------------------------------------
// Fixtures: a 30-event chain with contiguous seq and prev_hash → hash links.
// Hashes are fake hex strings; the page never recomputes sha256.
// ---------------------------------------------------------------------------

const SESSION_ID = "01JSESSION00000000000000AA";

function fakeHash(seq: number): string {
  return seq.toString(16).padStart(4, "0").repeat(16);
}

const ACTIONS: Array<Partial<AuditEvent>> = [
  {
    action: "session.started",
    actor_id: "NCT03088540-P-007",
    actor_role: "participant",
    entity_type: "session",
    entity_id: SESSION_ID,
    payload: { usubjid: "NCT03088540-P-007", consent_camera: true },
  },
  {
    action: "vitals.batch",
    actor_id: "vitals-bridge",
    actor_role: "system",
    entity_type: "session",
    entity_id: SESSION_ID,
    payload: {
      n: 5,
      first_ts: "2026-10-10T18:00:01.000Z",
      last_ts: "2026-10-10T18:00:05.000Z",
      sources: ["mock"],
      is_measured: [false],
      simulated: true,
      posted_by: "vitals-bridge",
    },
  },
  {
    action: "session.completed",
    actor_id: "NCT03088540-P-007",
    actor_role: "participant",
    entity_type: "session",
    entity_id: SESSION_ID,
    payload: { tier: 1, max_grade: 2 },
  },
  {
    action: "draft.confirmed",
    actor_id: "coordinator",
    actor_role: "coordinator",
    entity_type: "draft",
    entity_id: "01JDRAFT0000000000000000AA",
    payload: { session_id: SESSION_ID, domain: "AE" },
  },
  {
    action: "export.generated",
    actor_id: "coordinator",
    actor_role: "coordinator",
    entity_type: "export",
    entity_id: "AE.csv",
    payload: { domain: "AE", format: "csv", rows: 3 },
  },
];

function buildChain(n: number): AuditEvent[] {
  const out: AuditEvent[] = [];
  for (let seq = 1; seq <= n; seq++) {
    const base = ACTIONS[(seq - 1) % ACTIONS.length];
    out.push({
      id: `01JAUDIT${String(seq).padStart(18, "0")}`,
      seq,
      ts_utc: `2026-10-10T18:${String(seq).padStart(2, "0")}:00.000Z`,
      actor_id: "x",
      actor_role: "system",
      action: "x",
      entity_type: "x",
      entity_id: "x",
      payload: {},
      prev_hash: seq === 1 ? GENESIS_PREV_HASH : fakeHash(seq - 1),
      hash: fakeHash(seq),
      ...base,
    });
  }
  return out;
}

const CHAIN = buildChain(30);

function verified(overrides: Partial<AuditVerifyResult> = {}): AuditVerifyResult {
  return {
    ok: true,
    checked: CHAIN.length,
    head_hash: fakeHash(CHAIN.length),
    first_broken: null,
    verified_at: "2026-10-10T19:00:00.000Z",
    ...overrides,
  };
}

interface Options {
  chain?: AuditEvent[];
  verify?: AuditVerifyResult;
  auditStatus?: number;
}

function routes(opts: Options = {}): Route[] {
  const chain = opts.chain ?? CHAIN;
  return [
    {
      method: "GET",
      path: "/api/v1/audit",
      handler: ({ url }) => {
        if (opts.auditStatus && opts.auditStatus >= 400) {
          return {
            status: opts.auditStatus,
            json: {
              type: "about:blank",
              title: "Server Error",
              status: opts.auditStatus,
              detail: "boom",
            },
          };
        }
        const type = url.searchParams.get("entity_type");
        const id = url.searchParams.get("entity_id");
        const action = url.searchParams.get("action");
        const limit = Number(url.searchParams.get("limit") ?? 25);
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const filtered = chain
          .filter((e) => (type ? e.entity_type === type : true))
          .filter((e) => (id ? e.entity_id === id : true))
          .filter((e) => (action ? e.action === action : true))
          .sort((a, b) => b.seq - a.seq);
        const page: Paginated<AuditEvent> = {
          items: filtered.slice(offset, offset + limit),
          total: filtered.length,
          limit,
          offset,
        };
        return { json: page };
      },
    },
    {
      method: "GET",
      path: "/api/v1/audit/verify",
      handler: () => ({ json: opts.verify ?? verified() }),
    },
    {
      method: "GET",
      path: "/api/v1/export/bundle.zip",
      handler: () => ({ text: "PK-fake-zip", headers: { "Content-Type": "application/zip" } }),
    },
    {
      method: "GET",
      path: /^\/api\/v1\/export\/(AE|VS|CM)\.(csv|json)$/,
      handler: () => ({ text: "STUDYID,USUBJID\n", headers: { "Content-Type": "text/csv" } }),
    },
  ];
}

function signIn() {
  sessionStorage.setItem(
    AUTH_STORAGE_KEY,
    JSON.stringify({
      token: "demo-token",
      role: "coordinator",
      display_name: "Coordinator",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    }),
  );
}

function mount() {
  return render(
    <MemoryRouter initialEntries={["/dashboard/audit"]}>
      <ToastProvider>
        <Audit />
      </ToastProvider>
    </MemoryRouter>,
  );
}

async function waitForRows() {
  await waitFor(() => expect(screen.getAllByRole("row").length).toBeGreaterThan(1));
}

beforeEach(() => {
  signIn();
});

afterEach(() => {
  // saveBlob() stubs installed by individual tests.
  delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
  delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
});

// ---------------------------------------------------------------------------

describe("Audit page: event table", () => {
  it("lists events newest first with seq, actor role chip, action gloss and entity link", async () => {
    const mock = installMockFetch(routes());
    mount();
    await waitForRows();

    // Bearer token goes to the dashboard endpoint.
    const call = mock.find("GET", "/api/v1/audit")[0];
    expect(call.headers.authorization).toBe("Bearer demo-token");

    const rows = screen.getAllByRole("row").filter((r) => r.hasAttribute("data-seq"));
    expect(rows).toHaveLength(25);
    expect(rows[0]).toHaveAttribute("data-seq", "30");
    expect(rows[24]).toHaveAttribute("data-seq", "6");
    expect(screen.getByTestId("events-total")).toHaveTextContent("30 total");

    // seq 30 is an export.generated event by the coordinator.
    const top = within(rows[0]);
    expect(top.getByText("export.generated")).toBeInTheDocument();
    expect(top.getByText(/Export generated/)).toBeInTheDocument();
    expect(top.getByText("coordinator", { selector: "span[data-role]" })).toBeInTheDocument();

    // seq 26 is session.started → entity link to the check-in detail page.
    const sessionRow = rows.find((r) => r.getAttribute("data-seq") === "26")!;
    const link = within(sessionRow).getByRole("link", { name: SESSION_ID });
    expect(link).toHaveAttribute("href", `/dashboard/checkins/${SESSION_ID}`);

    // Local time with UTC on hover.
    expect(within(rows[0]).getByTitle("2026-10-10T18:30:00.000Z (UTC)")).toBeInTheDocument();
  });

  it("shows the SIMULATED badge and tier chip from payloads without expanding", async () => {
    installMockFetch(routes());
    mount();
    await waitForRows();
    const rows = screen.getAllByRole("row").filter((r) => r.hasAttribute("data-seq"));
    const vitalsRow = rows.find((r) => r.getAttribute("data-seq") === "27")!;
    const badge = within(vitalsRow).getByText("SIMULATED");
    expect(badge.closest("span[data-measured]")).toHaveAttribute("data-measured", "false");
    expect(within(vitalsRow).getByText("mock")).toBeInTheDocument();
    expect(within(vitalsRow).queryByText("MEASURED")).toBeNull();

    const completedRow = rows.find((r) => r.getAttribute("data-seq") === "28")!;
    expect(within(completedRow).getByText("Review 1 business day")).toBeInTheDocument();
  });

  it("paints chain-link glyphs: linked for adjacent rows, end for the last row on the page", async () => {
    installMockFetch(routes());
    mount();
    await waitForRows();
    const rows = screen.getAllByRole("row").filter((r) => r.hasAttribute("data-seq"));
    expect(rows[0]).toHaveAttribute("data-chain-link", "linked");
    expect(rows[rows.length - 1]).toHaveAttribute("data-chain-link", "end");
  });

  it("flags a row whose prev_hash does not match the row below", async () => {
    const tampered = CHAIN.map((e) => (e.seq === 30 ? { ...e, prev_hash: "f".repeat(64) } : e));
    installMockFetch(routes({ chain: tampered }));
    mount();
    await waitForRows();
    const rows = screen.getAllByRole("row").filter((r) => r.hasAttribute("data-seq"));
    expect(rows[0]).toHaveAttribute("data-chain-link", "broken");
    expect(rows[1]).toHaveAttribute("data-chain-link", "linked");
  });

  it("expands a row to show full prev_hash → hash and the pretty payload", async () => {
    installMockFetch(routes());
    const user = userEvent.setup();
    mount();
    await waitForRows();
    const rows = screen.getAllByRole("row").filter((r) => r.hasAttribute("data-seq"));
    const vitalsRow = rows.find((r) => r.getAttribute("data-seq") === "27")!;
    const toggle = within(vitalsRow).getByRole("button", { name: "Payload" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);

    const details = screen.getByTestId("audit-details-27");
    expect(within(details).getByText(fakeHash(26))).toBeInTheDocument();
    expect(within(details).getByText(fakeHash(27))).toBeInTheDocument();
    expect(within(details).getByText(/"simulated": true/)).toBeInTheDocument();
    expect(within(details).getByText(/chain intact here/)).toBeInTheDocument();
    expect(within(vitalsRow).getByRole("button", { name: "Hide" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    // The hash button carries the prev → hash pair on hover.
    // Testing Library collapses the title's newlines to spaces when matching.
    const hashButton = within(vitalsRow).getByTitle(/prev_hash [0-9a-f]+ → hash/);
    expect(hashButton.getAttribute("title")).toContain(fakeHash(26));
    expect(hashButton.getAttribute("title")).toContain(fakeHash(27));
  });

  it("marks the genesis event", async () => {
    installMockFetch(routes({ chain: buildChain(3) }));
    mount();
    await waitForRows();
    const rows = screen.getAllByRole("row").filter((r) => r.hasAttribute("data-seq"));
    expect(rows[2]).toHaveAttribute("data-chain-link", "genesis");
    expect(within(rows[2]).getByText("genesis")).toBeInTheDocument();
  });
});

describe("Audit page: filters and pagination", () => {
  it("sends entity_type / entity_id to the server on Apply and resets the offset", async () => {
    const mock = installMockFetch(routes());
    const user = userEvent.setup();
    mount();
    await waitForRows();

    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() =>
      expect(
        screen.getAllByRole("row").filter((r) => r.hasAttribute("data-seq"))[0],
      ).toHaveAttribute("data-seq", "5"),
    );
    expect(mock.calls.at(-1)?.path).toBe("/api/v1/audit");

    await user.type(screen.getByLabelText("Entity type"), "session");
    await user.type(screen.getByLabelText("Entity id"), SESSION_ID);
    await user.click(screen.getByRole("button", { name: "Apply" }));

    // session.started, vitals.batch and session.completed are all logged on the session: 3 of 5.
    await waitFor(() => expect(screen.getByTestId("events-total")).toHaveTextContent("18 total"));
    expect(screen.getByTestId("events-total")).toHaveTextContent("(filtered)");

    const last = mock.fn.mock.calls.at(-1)?.[0] as string;
    const url = new URL(last, "http://localhost");
    expect(url.searchParams.get("entity_type")).toBe("session");
    expect(url.searchParams.get("entity_id")).toBe(SESSION_ID);
    expect(url.searchParams.get("offset")).toBe("0");

    // Rows that are not adjacent in the chain show a gap, not a false "broken";
    // adjacent ones (28 → 27) still verify as linked.
    const rows = screen.getAllByRole("row").filter((r) => r.hasAttribute("data-seq"));
    expect(rows[0]).toHaveAttribute("data-seq", "28");
    expect(rows[0]).toHaveAttribute("data-chain-link", "linked");
    expect(rows[2]).toHaveAttribute("data-seq", "26");
    expect(rows[2]).toHaveAttribute("data-chain-link", "gap");

    await user.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(screen.getByTestId("events-total")).toHaveTextContent("30 total"));
  });

  it("sends the action filter to the server so it searches the whole log", async () => {
    const mock = installMockFetch(routes());
    const user = userEvent.setup();
    mount();
    await waitForRows();
    const before = mock.find("GET", "/api/v1/audit").length;

    await user.type(screen.getByLabelText(/^Action/), "vitals.batch");
    // Typing alone does not refetch; Apply does.
    expect(mock.find("GET", "/api/v1/audit")).toHaveLength(before);
    await user.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => expect(screen.getByTestId("events-total")).toHaveTextContent("6 total"));
    const last = mock.fn.mock.calls.at(-1)?.[0] as string;
    expect(new URL(last, "http://localhost").searchParams.get("action")).toBe("vitals.batch");
    const rows = screen.getAllByRole("row").filter((r) => r.hasAttribute("data-seq"));
    expect(rows).toHaveLength(6);
    rows.forEach((r) => expect(within(r).getByText("vitals.batch")).toBeInTheDocument());
    expect(screen.getByTestId("events-total")).toHaveTextContent("(filtered)");

    // The datalist offers every known action because the server matches exactly.
    const options = Array.from(document.querySelectorAll("#audit-actions option")).map((o) =>
      o.getAttribute("value"),
    );
    expect(options).toContain("draft.confirmed");
    expect(options).toContain("export.generated");

    await user.clear(screen.getByLabelText(/^Action/));
    await user.type(screen.getByLabelText(/^Action/), "nothing.matches");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByText(/No events match these filters/)).toBeInTheDocument();
  });

  it("keeps the table and expanded payloads on screen while refetching", async () => {
    installMockFetch(routes());
    const user = userEvent.setup();
    mount();
    await waitForRows();
    const rows = screen.getAllByRole("row").filter((r) => r.hasAttribute("data-seq"));
    const completedRow = rows.find((r) => r.getAttribute("data-seq") === "28")!;
    await user.click(within(completedRow).getByRole("button", { name: "Payload" }));
    expect(screen.getByTestId("audit-details-28")).toBeInTheDocument();

    // Verify triggers a refetch of the list; the table must not unmount.
    await user.click(screen.getByRole("button", { name: "Verify chain" }));
    await screen.findByTestId("verify-result");
    expect(screen.queryByText("Loading events…")).toBeNull();
    expect(screen.getByTestId("audit-details-28")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("events-refreshing")).toBeNull());
    expect(screen.getByTestId("audit-details-28")).toBeInTheDocument();
  });

  it("links chart-note entities to the note detail page", async () => {
    const chain = buildChain(3).map((e, i) =>
      i === 0
        ? {
            ...e,
            action: "drafts.applied",
            entity_type: "note",
            entity_id: "01JNOTE000000000000000AA",
          }
        : e,
    );
    installMockFetch(routes({ chain }));
    mount();
    await waitForRows();
    const link = screen.getByRole("link", { name: "01JNOTE000000000000000AA" });
    expect(link).toHaveAttribute("href", "/dashboard/notes/01JNOTE000000000000000AA");
    expect(screen.getByText(/Rules outcome applied/)).toBeInTheDocument();
  });

  it("disables Copy for a row that arrived without a hash instead of copying undefined", async () => {
    const chain = buildChain(2).map((e) =>
      e.seq === 2 ? ({ ...e, hash: undefined } as unknown as AuditEvent) : e,
    );
    installMockFetch(routes({ chain }));
    const user = userEvent.setup();
    mount();
    await waitForRows();
    const rows = screen.getAllByRole("row").filter((r) => r.hasAttribute("data-seq"));
    await user.click(within(rows[0]).getByRole("button", { name: "Payload" }));
    const details = screen.getByTestId("audit-details-2");
    const copies = within(details).getAllByRole("button", { name: "Copy" });
    expect(copies[0]).toBeEnabled(); // prev_hash present
    expect(copies[1]).toBeDisabled(); // hash missing
  });

  it("changes the page size", async () => {
    installMockFetch(routes());
    const user = userEvent.setup();
    mount();
    await waitForRows();
    await user.selectOptions(screen.getByLabelText("Per page"), "50");
    await waitFor(() =>
      expect(screen.getAllByRole("row").filter((r) => r.hasAttribute("data-seq"))).toHaveLength(30),
    );
  });
});

describe("Audit page: verify", () => {
  it("shows a green VERIFIED badge with the checked count and head hash, then refetches", async () => {
    const mock = installMockFetch(routes());
    const user = userEvent.setup();
    mount();
    await waitForRows();
    const before = mock.find("GET", "/api/v1/audit").length;

    await user.click(screen.getByRole("button", { name: "Verify chain" }));
    const result = await screen.findByTestId("verify-result");
    expect(within(result).getByText("VERIFIED")).toHaveAttribute("data-verify", "ok");
    expect(within(result).getByText("30")).toBeInTheDocument();
    const head = within(result).getByTitle(fakeHash(30));
    expect(head).toHaveTextContent(`${fakeHash(30).slice(0, 16)}…`);
    expect(mock.find("GET", "/api/v1/audit/verify")[0].headers.authorization).toBe(
      "Bearer demo-token",
    );
    await waitFor(() => expect(mock.find("GET", "/api/v1/audit").length).toBe(before + 1));
  });

  it("shows a red BROKEN badge with the first broken link and expected vs actual hash", async () => {
    installMockFetch(
      routes({
        verify: verified({
          ok: false,
          checked: 17,
          first_broken: {
            index: 17,
            seq: 18,
            id: CHAIN[16].id,
            expected_hash: "e".repeat(64),
            actual_hash: "a".repeat(64),
            reason: "sequence gap: expected seq 17, found 18",
          } as AuditVerifyResult["first_broken"],
        }),
      }),
    );
    const user = userEvent.setup();
    mount();
    await waitForRows();
    await user.click(screen.getByRole("button", { name: "Verify chain" }));
    const result = await screen.findByTestId("verify-result");
    expect(within(result).getByText("BROKEN")).toHaveAttribute("data-verify", "broken");
    expect(within(result).getByText(/First broken link at index/)).toHaveTextContent("17");
    expect(within(result).getByText(/First broken link at index/)).toHaveTextContent("(seq 18)");
    expect(within(result).getByText("sequence gap: expected seq 17, found 18")).toBeInTheDocument();
    expect(within(result).getByText(CHAIN[16].id)).toBeInTheDocument();
    expect(within(result).getByText("e".repeat(64))).toBeInTheDocument();
    expect(within(result).getByText("a".repeat(64))).toBeInTheDocument();
  });

  it("explains the chain construction in prose", async () => {
    installMockFetch(routes());
    mount();
    expect(screen.getByText(/sha256\(prev_hash \+ canonical_json\(event\)\)/)).toBeInTheDocument();
  });
});

describe("Audit page: exports", () => {
  it("downloads the bundle with the bearer token and refetches the log", async () => {
    const mock = installMockFetch(routes());
    const createObjectURL = vi.fn(() => "blob:interim");
    Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    const user = userEvent.setup();
    mount();
    await waitForRows();
    const before = mock.find("GET", "/api/v1/audit").length;

    await user.selectOptions(screen.getByLabelText("Records"), "all");
    await user.click(screen.getByRole("button", { name: /Download submission bundle/ }));
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(mock.find("GET", "/api/v1/export/bundle.zip")[0].headers.authorization).toBe(
      "Bearer demo-token",
    );
    const bundleCall = mock.fn.mock.calls.find((c) => String(c[0]).includes("/export/bundle.zip"));
    expect(new URL(String(bundleCall?.[0]), "http://localhost").searchParams.get("status")).toBe(
      "all",
    );
    expect(await screen.findByText("interim-bundle.zip downloaded")).toBeInTheDocument();
    await waitFor(() => expect(mock.find("GET", "/api/v1/audit").length).toBe(before + 1));
  });

  it("offers per-domain CSV/JSON links that honour the status filter", async () => {
    const mock = installMockFetch(routes());
    Object.defineProperty(URL, "createObjectURL", { value: () => "blob:x", configurable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: () => undefined, configurable: true });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    const user = userEvent.setup();
    mount();
    await waitForRows();
    await user.selectOptions(screen.getByLabelText("Records"), "all");

    const csvButtons = screen.getAllByRole("button", { name: "CSV" });
    expect(csvButtons).toHaveLength(3);
    await user.click(csvButtons[0]);
    await waitFor(() => expect(mock.find("GET", "/api/v1/export/AE.csv")).toHaveLength(1));
    const last = mock.fn.mock.calls.find((c) => String(c[0]).includes("/export/AE.csv"))?.[0];
    expect(new URL(String(last), "http://localhost").searchParams.get("status")).toBe("all");

    expect(screen.getByRole("button", { name: "Per-sample CSV" })).toBeInTheDocument();
    expect(screen.getByText(/Exports are themselves audited/)).toBeInTheDocument();
  });
});

describe("Audit page: states", () => {
  it("shows an error banner with retry when the API fails", async () => {
    const mock = installMockFetch(routes({ auditStatus: 500 }));
    mount();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not load audit events");
    expect(alert).toHaveTextContent("HTTP 500");
    const before = mock.find("GET", "/api/v1/audit").length;
    await userEvent.setup().click(within(alert).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(mock.find("GET", "/api/v1/audit").length).toBe(before + 1));
  });

  it("shows an empty state when there are no events", async () => {
    installMockFetch(routes({ chain: [] }));
    mount();
    expect(await screen.findByText(/No audit events yet/)).toBeInTheDocument();
  });

  it("shows a loading state first", () => {
    installMockFetch(routes());
    mount();
    expect(screen.getByRole("status", { name: "" })).toHaveTextContent("Loading events…");
  });
});
