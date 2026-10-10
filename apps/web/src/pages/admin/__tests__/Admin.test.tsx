/**
 * Admin page against a mocked API (route-table fetch) and the fake bridge socket.
 */
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { ToastProvider } from "../../../components/Toast";
import { AUTH_STORAGE_KEY } from "../../../lib/api";
import type { Health, PublicSettings, Role, Settings, SettingsUpdate } from "../../../lib/types";
import { FakeWebSocket } from "../../../test/fakeWebSocket";
import { installMockFetch, type Route } from "../../../test/mockFetch";
import { Admin } from "../../Admin";
import { diffSettings, draftFrom, MOCK_SCENARIOS, SIMULATED_AS_MEASURED_WARNING } from "../tables";

const SETTINGS: Settings = {
  vitals_source: "mock",
  mock_scenario: "resting",
  simulated_as_measured: false,
};

const HEALTH: Health = {
  status: "ok",
  version: "0.1.0",
  time_utc: "2026-10-10T18:04:12.345Z",
  vitals_source: "mock",
  db: "sqlite",
};

const PUBLIC: PublicSettings = {
  vitals_source: "mock",
  mock_scenario: "resting",
  simulated_as_measured: false,
  min_confidence: 0.6,
  timing_gates: { pulse_s: 12, breathing_s: 30, hrv_s: 60 },
};

function signIn(role: Role) {
  sessionStorage.setItem(
    AUTH_STORAGE_KEY,
    JSON.stringify({
      token: `tok.${role}`,
      role,
      display_name: role,
      expires_at: "2099-01-01T00:00:00.000Z",
    }),
  );
}

interface RouteOptions {
  settingsStatus?: number;
  putStatus?: number;
  resetStatus?: number;
  publicStatus?: number;
  /** When set, every GET /admin/settings after the first waits on this promise. */
  deferLaterGets?: Promise<void>;
}

function problem(status: number, detail = "db down") {
  return {
    status,
    json: {
      type: "about:blank",
      title: status >= 500 ? "Server Error" : "Forbidden",
      status,
      detail,
    },
  };
}

function routes(opts: RouteOptions = {}): Route[] {
  let saved: Settings = { ...SETTINGS };
  let gets = 0;
  return [
    {
      method: "GET",
      path: "/api/v1/admin/settings",
      handler: async () => {
        gets += 1;
        if (opts.settingsStatus && opts.settingsStatus >= 400) return problem(opts.settingsStatus);
        if (gets > 1 && opts.deferLaterGets) await opts.deferLaterGets;
        return { json: { ...saved } };
      },
    },
    {
      method: "PUT",
      path: "/api/v1/admin/settings",
      handler: ({ body }) => {
        if (opts.putStatus && opts.putStatus >= 400) return problem(opts.putStatus, "write failed");
        saved = { ...saved, ...(body as SettingsUpdate) };
        return { json: saved };
      },
    },
    {
      method: "POST",
      path: "/api/v1/admin/reset",
      handler: () =>
        opts.resetStatus && opts.resetStatus >= 400
          ? {
              status: opts.resetStatus,
              json: { type: "about:blank", title: "Forbidden", status: opts.resetStatus },
            }
          : { json: { ok: true, reseeded: true } },
    },
    { method: "GET", path: "/api/v1/health", handler: () => ({ json: HEALTH }) },
    {
      method: "GET",
      path: "/api/v1/settings/public",
      handler: () =>
        opts.publicStatus && opts.publicStatus >= 400
          ? problem(opts.publicStatus, "rules table failed to load")
          : { json: PUBLIC },
    },
  ];
}

function renderAdmin() {
  return render(
    <MemoryRouter initialEntries={["/admin"]}>
      <ToastProvider>
        <Admin />
      </ToastProvider>
    </MemoryRouter>,
  );
}

/** Push the bridge's hello through the fake socket once it is open. */
async function bridgeHello(scenario = "resting") {
  await waitFor(() => expect(FakeWebSocket.last?.readyState).toBe(1));
  act(() => {
    FakeWebSocket.last?.receive({
      type: "hello",
      source: "mock",
      isMeasured: false,
      scenario,
      minConf: 0.6,
      gates: { pulseS: 12, breathingS: 30, hrvS: 60 },
      version: "0.1.0",
    });
  });
}

describe("tables", () => {
  it("diffSettings sends only the changed keys", () => {
    const draft = draftFrom(SETTINGS);
    expect(diffSettings(SETTINGS, draft)).toEqual({});
    expect(diffSettings(SETTINGS, { ...draft, mock_scenario: "tachypnea" })).toEqual({
      mock_scenario: "tachypnea",
    });
    expect(diffSettings(SETTINGS, { ...draft, simulated_as_measured: true })).toEqual({
      simulated_as_measured: true,
    });
  });

  it("ships the five CLAUDE.md §7.2 scenarios, each with physiology and rationale", () => {
    expect(MOCK_SCENARIOS.map((s) => s.id)).toEqual([
      "resting",
      "post_exercise",
      "tachypnea",
      "low_quality",
      "dropout",
    ]);
    for (const s of MOCK_SCENARIOS) {
      expect(s.physiology.length).toBeGreaterThan(10);
      expect(s.rationale.length).toBeGreaterThan(10);
    }
  });
});

describe("Admin page", () => {
  it("shows a 403-style message to non-admin roles and fetches nothing", async () => {
    signIn("coordinator");
    const fetchMock = installMockFetch(routes());
    renderAdmin();
    expect(await screen.findByRole("heading", { name: /Admin only \(403\)/ })).toBeInTheDocument();
    expect(screen.getByText(/Coordinator \/ research nurse/)).toBeInTheDocument();
    expect(fetchMock.find("GET", "/api/v1/admin/settings")).toHaveLength(0);
  });

  it("loads settings, shows the saved values, and saves only the changed keys", async () => {
    signIn("admin");
    const fetchMock = installMockFetch(routes());
    const user = userEvent.setup();
    renderAdmin();

    // Loaded: saved values shown, toggle OFF by default, no warning yet.
    const sourceGroup = await screen.findByRole("radiogroup", { name: "Vitals source" });
    expect(within(sourceGroup).getByRole("radio", { name: /Mock \(simulated\)/ })).toBeChecked();
    const scenarioGroup = screen.getByRole("radiogroup", { name: "Mock scenario" });
    expect(within(scenarioGroup).getByRole("radio", { name: /Resting/ })).toBeChecked();
    const toggle = screen.getByRole("switch", { name: "Treat simulated vitals as measured" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByText(SIMULATED_AS_MEASURED_WARNING)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();

    // Each scenario shows its one-line physiology; presage/arduino show requirements.
    expect(screen.getByText(/pulse 128 → 90/)).toBeInTheDocument();
    expect(screen.getByText(/npm run install:presage/)).toBeInTheDocument();
    expect(screen.getByText(/docs\/VITALS_SOURCES\.md/)).toBeInTheDocument();

    // Pick post_exercise, switch the toggle on → warning appears before saving.
    await user.click(within(scenarioGroup).getByRole("radio", { name: /Post-exercise/ }));
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("alert")).toHaveTextContent(SIMULATED_AS_MEASURED_WARNING);

    await bridgeHello("resting");
    await user.click(screen.getByRole("button", { name: "Save settings" }));

    const puts = fetchMock.find("PUT", "/api/v1/admin/settings");
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].body).toEqual({ mock_scenario: "post_exercise", simulated_as_measured: true });
    expect(puts[0].headers.authorization).toBe("Bearer tok.admin");

    // Toast, form re-baselined on the response, bridge told about the scenario.
    expect(await screen.findByText("Settings saved")).toBeInTheDocument();
    expect(screen.getByText(/Bridge notified \(set_scenario/)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled(),
    );
    expect(screen.getByText("ON")).toBeInTheDocument();
    expect(FakeWebSocket.last?.sentMessages).toContainEqual({
      type: "set_scenario",
      scenario: "post_exercise",
    });
    // The admin page never starts a capture.
    expect(FakeWebSocket.last?.sentMessages.some((m) => m.type === "start")).toBe(false);
  });

  it("shows the API/bridge health, labels the bridge source SIMULATED, and flags a mismatch", async () => {
    signIn("admin");
    installMockFetch(routes());
    renderAdmin();

    expect(await screen.findByText("0.1.0")).toBeInTheDocument();
    expect(screen.getByText("sqlite")).toBeInTheDocument();
    // Time: local text, UTC on hover.
    const time = screen.getByTitle("2026-10-10T18:04:12.345Z (UTC)");
    expect(time.tagName).toBe("TIME");
    expect(screen.getByText("60%")).toBeInTheDocument(); // min_confidence

    await bridgeHello("tachypnea");
    const conn = screen.getByTestId("bridge-connection");
    await waitFor(() => expect(conn).toHaveTextContent("Connected"));
    const bridgeSection = screen.getByRole("region", { name: "Vitals bridge (WebSocket)" });
    const badge = within(bridgeSection).getByText("SIMULATED").closest("[data-measured]");
    expect(badge).toHaveAttribute("data-measured", "false");
    // The scenario row and the mismatch note both name it.
    expect(within(bridgeSection).getAllByText("tachypnea").length).toBeGreaterThanOrEqual(1);
    expect(within(bridgeSection).getByText(/Steady fast breathing/)).toBeInTheDocument();
    // Saved scenario is resting; bridge announced tachypnea → informational note.
    expect(within(bridgeSection).getByRole("status")).toHaveTextContent(
      /applies on its next start/,
    );
  });

  it("reports a disconnected bridge", async () => {
    signIn("admin");
    installMockFetch(routes());
    FakeWebSocket.autoOpen = false;
    renderAdmin();
    await screen.findByText("0.1.0");
    expect(screen.getByTestId("bridge-connection")).toHaveTextContent("Disconnected");
    expect(screen.getByText(/npm run bridge -- --source mock/)).toBeInTheDocument();
  });

  it("links to the kiosk with ?scenario= presets", async () => {
    signIn("admin");
    installMockFetch(routes());
    renderAdmin();
    await screen.findByRole("radiogroup", { name: "Vitals source" });
    const links = screen.getAllByRole("link", { name: /\?scenario=/ });
    expect(links.map((a) => a.getAttribute("href"))).toEqual(
      MOCK_SCENARIOS.map((s) => `/kiosk?scenario=${s.id}`),
    );
    expect(screen.getByRole("link", { name: /Kiosk \(saved scenario: resting\)/ })).toHaveAttribute(
      "href",
      "/kiosk",
    );
  });

  it("resets demo data only after the in-page confirmation", async () => {
    signIn("admin");
    const fetchMock = installMockFetch(routes());
    const user = userEvent.setup();
    renderAdmin();
    await screen.findByRole("radiogroup", { name: "Vitals source" });

    await user.click(screen.getByRole("button", { name: "Reset demo data…" }));
    expect(fetchMock.find("POST", "/api/v1/admin/reset")).toHaveLength(0);
    const confirm = screen.getByRole("group", { name: /Reset and reseed/ });

    // Cancel first: nothing posted.
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: /Reset and reseed/ })).not.toBeInTheDocument();
    expect(fetchMock.find("POST", "/api/v1/admin/reset")).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Reset demo data…" }));
    await user.click(screen.getByRole("button", { name: "Yes, wipe and reseed" }));
    const posts = fetchMock.find("POST", "/api/v1/admin/reset");
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].body).toEqual({ reseed: true });
    expect(await screen.findByText("Demo data reset")).toBeInTheDocument();
    // Settings and health are refetched after a reset.
    await waitFor(() =>
      expect(fetchMock.find("GET", "/api/v1/admin/settings").length).toBeGreaterThanOrEqual(2),
    );
    await waitFor(() =>
      expect(fetchMock.find("GET", "/api/v1/health").length).toBeGreaterThanOrEqual(2),
    );
  });

  it("shows an error banner with retry when settings fail to load", async () => {
    signIn("admin");
    const fetchMock = installMockFetch(routes({ settingsStatus: 500 }));
    const user = userEvent.setup();
    renderAdmin();
    const banner = await screen.findByText("Could not load settings");
    expect(banner).toBeInTheDocument();
    expect(screen.getByText(/HTTP 500/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(fetchMock.find("GET", "/api/v1/admin/settings").length).toBe(2));
  });

  it("surfaces a failed reset inline", async () => {
    signIn("admin");
    installMockFetch(routes({ resetStatus: 403 }));
    const user = userEvent.setup();
    renderAdmin();
    await screen.findByRole("radiogroup", { name: "Vitals source" });
    await user.click(screen.getByRole("button", { name: "Reset demo data…" }));
    await user.click(screen.getByRole("button", { name: "Yes, wipe and reseed" }));
    expect(await screen.findByText("Reset failed")).toBeInTheDocument();
    expect(screen.getByText(/HTTP 403/)).toBeInTheDocument();
    // The confirm group stays open and focus comes back to the confirm button
    // (it was disabled while busy, which drops focus in browsers).
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Yes, wipe and reseed" })).toHaveFocus(),
    );
  });

  it("returns keyboard focus to the trigger after Cancel and after a successful reset", async () => {
    signIn("admin");
    installMockFetch(routes());
    const user = userEvent.setup();
    renderAdmin();
    await screen.findByRole("radiogroup", { name: "Vitals source" });

    const trigger = () => screen.getByRole("button", { name: "Reset demo data…" });
    trigger().focus();
    await user.keyboard("{Enter}");
    // The confirm button is auto-focused when the group opens.
    expect(screen.getByRole("button", { name: "Yes, wipe and reseed" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("group", { name: /Reset and reseed/ })).not.toBeInTheDocument();
    await waitFor(() => expect(trigger()).toHaveFocus());

    // Successful reset: the group unmounts; focus goes back to the trigger too.
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "Yes, wipe and reseed" }));
    expect(await screen.findByText("Demo data reset")).toBeInTheDocument();
    await waitFor(() => expect(trigger()).toHaveFocus());
  });

  it("expanding a scenario's rationale does not change the selected scenario", async () => {
    signIn("admin");
    installMockFetch(routes());
    const user = userEvent.setup();
    renderAdmin();
    const scenarioGroup = await screen.findByRole("radiogroup", { name: "Mock scenario" });
    const resting = within(scenarioGroup).getByRole("radio", { name: /Resting/ });
    const tachypnea = within(scenarioGroup).getByRole("radio", { name: /Tachypnea/ });
    expect(resting).toBeChecked();

    // The <details> is a sibling of the <label>, so the summary text is not
    // part of the radio's accessible name and clicking it cannot activate it.
    expect(tachypnea).not.toHaveAccessibleName(/Why these numbers/);
    await user.click(screen.getByText("Why these numbers (Tachypnea)"));
    expect(resting).toBeChecked();
    expect(tachypnea).not.toBeChecked();
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();
  });

  it("keeps the draft and shows the error when PUT /admin/settings fails", async () => {
    signIn("admin");
    installMockFetch(routes({ putStatus: 500 }));
    const user = userEvent.setup();
    renderAdmin();
    const scenarioGroup = await screen.findByRole("radiogroup", { name: "Mock scenario" });
    await user.click(within(scenarioGroup).getByRole("radio", { name: /Post-exercise/ }));
    await user.click(screen.getByRole("button", { name: "Save settings" }));

    expect(await screen.findByText("Could not save settings")).toBeInTheDocument();
    expect(screen.getByText(/HTTP 500/)).toBeInTheDocument();
    // Not re-baselined: the draft is still dirty and still shows the edit.
    expect(within(scenarioGroup).getByRole("radio", { name: /Post-exercise/ })).toBeChecked();
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save settings" })).toBeEnabled();
    expect(screen.queryByText("Settings saved")).not.toBeInTheDocument();
  });

  it("Discard changes restores the saved values", async () => {
    signIn("admin");
    installMockFetch(routes());
    const user = userEvent.setup();
    renderAdmin();
    const scenarioGroup = await screen.findByRole("radiogroup", { name: "Mock scenario" });
    const toggle = screen.getByRole("switch", { name: "Treat simulated vitals as measured" });
    await user.click(within(scenarioGroup).getByRole("radio", { name: /Dropout/ }));
    await user.click(toggle);
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(within(scenarioGroup).getByRole("radio", { name: /Resting/ })).toBeChecked();
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByText(SIMULATED_AS_MEASURED_WARNING)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Discard changes" })).toBeDisabled();
  });

  it("the simulated-as-measured switch and the radio groups work from the keyboard", async () => {
    signIn("admin");
    installMockFetch(routes());
    const user = userEvent.setup();
    renderAdmin();
    const scenarioGroup = await screen.findByRole("radiogroup", { name: "Mock scenario" });
    const toggle = screen.getByRole("switch", { name: "Treat simulated vitals as measured" });

    toggle.focus();
    await user.keyboard(" ");
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("alert")).toHaveTextContent(SIMULATED_AS_MEASURED_WARNING);
    await user.keyboard(" ");
    expect(toggle).toHaveAttribute("aria-checked", "false");

    // Arrow keys move the selection within the scenario radio group.
    within(scenarioGroup)
      .getByRole("radio", { name: /Resting/ })
      .focus();
    await user.keyboard("{ArrowDown}");
    expect(within(scenarioGroup).getByRole("radio", { name: /Post-exercise/ })).toBeChecked();
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  });

  it("keeps the healthy /health block when /settings/public fails", async () => {
    signIn("admin");
    installMockFetch(routes({ publicStatus: 500 }));
    renderAdmin();
    // /health answered: version, db and time are shown and no "unreachable" banner.
    expect(await screen.findByText("0.1.0")).toBeInTheDocument();
    expect(screen.getByText("sqlite")).toBeInTheDocument();
    expect(screen.queryByText(/API unreachable/)).not.toBeInTheDocument();
    // The public-settings block carries its own, endpoint-specific error.
    const banner = await screen.findByText(/Public settings unavailable/);
    expect(banner).toBeInTheDocument();
    expect(screen.getByText(/HTTP 500/)).toBeInTheDocument();
  });

  it("labels the env and public vitals source with a SIMULATED/MEASURED badge", async () => {
    signIn("admin");
    installMockFetch(routes());
    renderAdmin();
    await screen.findByText("0.1.0");
    const apiSection = screen.getByRole("region", { name: "API" });
    const badges = within(apiSection)
      .getAllByText("SIMULATED")
      .map((el) => el.closest("[data-measured]"));
    // One for "Env vitals source" (/health), one for the public vitals_source.
    expect(badges).toHaveLength(2);
    for (const b of badges) {
      expect(b).toHaveAttribute("data-measured", "false");
      expect(b).toHaveTextContent("mock");
    }
  });

  it("links to the Eval page", async () => {
    signIn("admin");
    installMockFetch(routes());
    renderAdmin();
    await screen.findByRole("radiogroup", { name: "Vitals source" });
    expect(screen.getByRole("link", { name: "Eval page" })).toHaveAttribute(
      "href",
      "/dashboard/eval",
    );
  });

  it("does not flash the pre-save settings while the post-reset refetch is in flight", async () => {
    signIn("admin");
    let releaseGet: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGet = resolve;
    });
    const fetchMock = installMockFetch(routes({ deferLaterGets: gate }));
    const user = userEvent.setup();
    renderAdmin();
    const scenarioGroup = await screen.findByRole("radiogroup", { name: "Mock scenario" });

    // Save tachypnea: the form re-baselines on the PUT response.
    await user.click(within(scenarioGroup).getByRole("radio", { name: /Tachypnea/ }));
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    await screen.findByText("Settings saved");
    const scenarioFieldset = scenarioGroup.closest("fieldset") as HTMLElement;
    const savedLine = () => within(scenarioFieldset).getByText(/^Saved:/);
    expect(savedLine()).toHaveTextContent("Saved: tachypnea");

    // Reset: the refetch is deferred; meanwhile the form must still show the
    // saved (PUT) values, not the original GET's "resting".
    await user.click(screen.getByRole("button", { name: "Reset demo data…" }));
    await user.click(screen.getByRole("button", { name: "Yes, wipe and reseed" }));
    await screen.findByText("Demo data reset");
    await waitFor(() =>
      expect(fetchMock.find("GET", "/api/v1/admin/settings").length).toBeGreaterThanOrEqual(2),
    );
    expect(within(scenarioGroup).getByRole("radio", { name: /Tachypnea/ })).toBeChecked();
    expect(savedLine()).toHaveTextContent("Saved: tachypnea");

    // Release the GET: the fresh server copy (also tachypnea here) takes over.
    releaseGet();
    await waitFor(() =>
      expect(within(scenarioGroup).getByRole("radio", { name: /Tachypnea/ })).toBeChecked(),
    );
    expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();
  });
});
