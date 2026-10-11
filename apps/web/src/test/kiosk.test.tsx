/**
 * End-to-end kiosk flow against a mocked API and a fake bridge socket.
 *
 * The per-session camera consent screen was removed (CLAUDE.md §00, D-026):
 * the Welcome screen carries the "no video is stored" line and an
 * "I'd rather not use the camera" opt-out whose value is sent as consent_camera.
 */
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { AppRoutes } from "../App";
import { DISCLAIMER_TEXT } from "../components/Disclaimer";
import { SHELL_MAX_W, SIDE_COLUMN_REM } from "../pages/kiosk/KioskShell";
import { CAMERA_OPT_OUT_LABEL, NO_VIDEO_TEXT } from "../pages/kiosk/Welcome";
import type { AnswerRequest, CompleteResponse, GatesRequest, ItemsResponse } from "../lib/types";
import { FakeWebSocket } from "./fakeWebSocket";
import {
  completeResponse,
  ITEMS,
  ITEMS_TABLE_SHAPE,
  SESSION_ID,
  session,
  STOP_TEXT,
  STUDY,
} from "./fixtures";
import { installMockFetch, type Route } from "./mockFetch";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** CONTRACTS.md §5: USUBJID = "{study_id}-{display_label}". */
const USUBJID_P007 = `${STUDY.study_id}-P-007`;

interface RouteOptions {
  complete?: CompleteResponse;
  sessionStatus?: number;
  /** usubjid values POST /sessions accepts; anything else is a 404. Default: accept all. */
  knownUsubjids?: string[];
  items?: ItemsResponse;
}

function routes(opts: RouteOptions = {}): Route[] {
  let answerSeq = 0;
  return [
    { method: "GET", path: "/api/v1/study", handler: () => ({ json: STUDY }) },
    { method: "GET", path: "/api/v1/items", handler: () => ({ json: opts.items ?? ITEMS }) },
    {
      method: "POST",
      path: "/api/v1/sessions",
      handler: ({ body }) => {
        const b = body as { usubjid: string; consent_camera: boolean };
        const unknown = opts.knownUsubjids && !opts.knownUsubjids.includes(b.usubjid);
        if ((opts.sessionStatus && opts.sessionStatus >= 400) || unknown) {
          const status = opts.sessionStatus ?? 404;
          return {
            status,
            json: {
              type: "about:blank",
              title: "Not Found",
              status,
              detail: "Unknown participant",
            },
          };
        }
        return { json: session({ usubjid: b.usubjid, consent_camera: b.consent_camera }) };
      },
    },
    {
      method: "POST",
      path: new RegExp(`^/api/v1/sessions/${SESSION_ID}/answers$`),
      handler: ({ body }) => {
        const b = body as AnswerRequest;
        answerSeq += 1;
        return {
          json: {
            id: `01JANSWER${String(answerSeq).padStart(17, "0")}`,
            session_id: SESSION_ID,
            item_id: b.item_id,
            attribute: b.attribute,
            value_int: b.value,
            value_text: null,
            ts_client: b.ts_client,
            ts_server: "2026-10-10T18:00:01.000Z",
          },
        };
      },
    },
    {
      method: "POST",
      path: new RegExp(`^/api/v1/sessions/${SESSION_ID}/gates$`),
      handler: () => ({ json: { answers: [] } }),
    },
    {
      method: "POST",
      path: new RegExp(`^/api/v1/sessions/${SESSION_ID}/complete$`),
      handler: () => ({ json: opts.complete ?? completeResponse() }),
    },
  ];
}

function renderKiosk() {
  return render(
    <MemoryRouter initialEntries={["/kiosk"]}>
      <AppRoutes />
    </MemoryRouter>,
  );
}

async function clickOption(user: ReturnType<typeof userEvent.setup>, label: string | RegExp) {
  await user.click(screen.getByRole("button", { name: label }));
}

/** Welcome (ID + optional camera opt-out) → Start; returns once the first item heading is on screen. */
async function startCheckIn(
  user: ReturnType<typeof userEvent.setup>,
  id: string,
  camera: boolean,
  firstHeading: string,
) {
  await user.type(await screen.findByLabelText("Your study ID"), id);
  if (!camera) await user.click(screen.getByRole("checkbox", { name: CAMERA_OPT_OUT_LABEL }));
  await user.click(screen.getByRole("button", { name: "Start check-in" }));
  expect(await screen.findByRole("heading", { name: firstHeading })).toBeInTheDocument();
}

/** Answer every fixture item and gate with "nothing to report" and press Finish. */
async function answerAllNone(user: ReturnType<typeof userEvent.setup>) {
  await clickOption(user, "None");
  await clickOption(user, "Not at all");
  await user.click(await screen.findByRole("button", { name: "Next" }));
  await clickOption(user, "None");
  await clickOption(user, "Not at all");
  await user.click(await screen.findByRole("button", { name: "Next" }));
  await clickOption(user, "No");
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await clickOption(user, "No");
  await user.click(screen.getByRole("button", { name: "Next" }));
  await clickOption(user, "No");
  await user.click(screen.getByRole("button", { name: "Next" }));
  await user.click(screen.getByRole("button", { name: "Finish check-in" }));
}

describe("kiosk flow", () => {
  it("runs end-to-end: welcome → session → answers → gates → stop bridge → complete → thank-you", async () => {
    const user = userEvent.setup();
    const mock = installMockFetch(routes());
    renderKiosk();

    // Welcome shows the study and the disclaimer footer.
    expect(await screen.findByRole("heading", { name: "Welcome" })).toBeInTheDocument();
    // Title shows in the kiosk header and in the Welcome body.
    expect(
      (await screen.findAllByText(new RegExp(STUDY.title.slice(0, 20)))).length,
    ).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(DISCLAIMER_TEXT)).toBeInTheDocument();
    // The "no video is stored" line and the opt-out toggle, camera on by default.
    expect(screen.getByText(NO_VIDEO_TEXT)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: CAMERA_OPT_OUT_LABEL })).not.toBeChecked();

    await user.type(screen.getByLabelText("Your study ID"), "p-007");
    expect(mock.find("POST", "/api/v1/sessions")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Start check-in" }));

    // No consent screen: Start goes straight to the session with the composed
    // USUBJID and consent_camera from the (untouched) toggle.
    expect(screen.queryByRole("heading", { name: /use the camera/ })).not.toBeInTheDocument();
    await waitFor(() => expect(mock.find("POST", "/api/v1/sessions")).toHaveLength(1));
    expect(mock.find("POST", "/api/v1/sessions")[0].body).toEqual({
      usubjid: USUBJID_P007,
      consent_camera: true,
    });

    // Bridge got `start` with the session id; vitals panel visible, labelled SIMULATED.
    const ws = FakeWebSocket.last!;
    await waitFor(() =>
      expect(ws.sentMessages).toContainEqual({ type: "start", sessionId: SESSION_ID }),
    );
    const panel = await screen.findByTestId("vitals-panel");
    expect(within(panel).getAllByText("collecting…").length).toBeGreaterThan(0);
    // During the timing gate the card says Collecting, never "Signal is weak".
    act(() => {
      ws.receive({
        type: "sample",
        sample: {
          tsUtc: "2026-10-10T18:00:03.000Z",
          source: "mock",
          isMeasured: false,
          windowS: 12,
          qualityFlags: ["gate_pending_pulse", "gate_pending_breathing", "gate_pending_hrv"],
        },
        published: { pulse: false, breathing: false, hrv: false },
        elapsedS: 3,
        sessionId: SESSION_ID,
      });
    });
    expect(within(panel).getByTestId("vitals-quality")).toHaveTextContent("Collecting");
    act(() => {
      ws.receive({
        type: "sample",
        sample: {
          tsUtc: "2026-10-10T18:00:13.000Z",
          source: "mock",
          isMeasured: false,
          pulseBpm: 72,
          pulseConf: 0.93,
          windowS: 12,
          qualityFlags: ["gate_pending_breathing", "gate_pending_hrv"],
        },
        published: { pulse: true, breathing: false, hrv: false },
        elapsedS: 13,
        sessionId: SESSION_ID,
      });
    });
    expect(within(panel).getByText("SIMULATED")).toBeInTheDocument();
    expect(within(panel).getByText("72")).toBeInTheDocument();
    expect(within(panel).getByTestId("vitals-quality")).toHaveTextContent("Good signal");

    // Item 1: shortness of breath → Moderate / Somewhat. Each tap POSTs immediately.
    expect(screen.getByRole("heading", { name: ITEMS.items[0].label })).toBeInTheDocument();
    // Fixture items carry no prompts, so the recall helper line is shown (grammatical form).
    expect(screen.getByText("Think about the last 7 days.")).toBeInTheDocument();
    const next1 = screen.getByRole("button", { name: "Next" });
    expect(next1).toBeDisabled();
    await clickOption(user, "Moderate");
    await clickOption(user, "Somewhat");
    await waitFor(() => expect(mock.find("POST", /\/answers$/)).toHaveLength(2));
    const [a1, a2] = mock.find("POST", /\/answers$/).map((c) => c.body as AnswerRequest);
    expect(a1).toMatchObject({ item_id: "shortness_of_breath", attribute: "severity", value: 2 });
    expect(a2).toMatchObject({
      item_id: "shortness_of_breath",
      attribute: "interference",
      value: 2,
    });
    expect(a1.ts_client).toMatch(ISO);
    await waitFor(() => expect(screen.getByRole("button", { name: "Next" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Next" }));

    // Item 2: cough → Mild / Not at all. Back works and keeps the selection.
    expect(await screen.findByRole("heading", { name: ITEMS.items[1].label })).toBeInTheDocument();
    await clickOption(user, "Mild");
    await clickOption(user, "Not at all");
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("heading", { name: ITEMS.items[0].label })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Moderate" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByRole("heading", { name: ITEMS.items[1].label })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));

    // Item 3: rash → No, then Continue.
    expect(await screen.findByRole("heading", { name: ITEMS.items[2].label })).toBeInTheDocument();
    await clickOption(user, "No");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    // Gate 1: hospitalization → No.
    expect(await screen.findByRole("heading", { name: ITEMS.gates[0].label })).toBeInTheDocument();
    await clickOption(user, "No");
    await user.click(screen.getByRole("button", { name: "Next" }));

    // Gate 2: con-med → Yes, "  loratadine " (typed with spaces), Started.
    expect(await screen.findByRole("heading", { name: ITEMS.gates[1].label })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    await clickOption(user, "Yes");
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    await user.type(screen.getByLabelText("What is the name of the medication?"), "  loratadine ");
    await clickOption(user, "Started");
    await user.click(screen.getByRole("button", { name: "Next" }));

    // Gate 3: free text, then Finish → gates POSTed once with everything, verbatim.
    expect(await screen.findByRole("heading", { name: ITEMS.gates[2].label })).toBeInTheDocument();
    await user.type(screen.getByRole("textbox"), "feeling ok ");
    await user.click(screen.getByRole("button", { name: "Finish check-in" }));

    await waitFor(() => expect(mock.find("POST", /\/gates$/)).toHaveLength(1));
    const gates = mock.find("POST", /\/gates$/)[0].body as GatesRequest;
    expect(gates).toMatchObject({
      hospitalization: false,
      conmed_changed: true,
      conmed_text: "  loratadine ",
      conmed_direction: "started",
      other_text: "feeling ok ",
    });
    expect(gates.ts_client).toMatch(ISO);
    expect(gates).not.toHaveProperty("temp_c");

    // Bridge told to stop BEFORE /complete is called; complete carries ts_client.
    await waitFor(() => expect(mock.find("POST", /\/complete$/)).toHaveLength(1));
    const stopIdx = ws.sentMessages.findIndex((m) => m.type === "stop");
    expect(stopIdx).toBeGreaterThan(-1);
    const completeCall = mock.find("POST", /\/complete$/)[0];
    expect((completeCall.body as { ts_client: string }).ts_client).toMatch(ISO);
    expect(mock.calls.indexOf(completeCall)).toBeGreaterThan(
      mock.calls.indexOf(mock.find("POST", /\/gates$/)[0]),
    );

    // Thank-you; nothing clinical shown.
    expect(
      await screen.findByRole("heading", { name: /Thank you\. Your check-in is complete/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/tier/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/grade/i)).not.toBeInTheDocument();
    expect(screen.getByText(DISCLAIMER_TEXT)).toBeInTheDocument();

    // Done → back to Welcome for the next participant.
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByRole("heading", { name: "Welcome" })).toBeInTheDocument();
  });

  it("does not call /complete on the bridge's pre-flush idle; waits for the post-flush idle", async () => {
    const user = userEvent.setup();
    FakeWebSocket.autoRespond = false;
    const mock = installMockFetch(routes());
    renderKiosk();
    await startCheckIn(user, "P-007", true, ITEMS.items[0].label);
    const ws = FakeWebSocket.last!;
    await waitFor(() =>
      expect(ws.sentMessages).toContainEqual({ type: "start", sessionId: SESSION_ID }),
    );
    act(() => {
      ws.receive({ type: "status", state: "collecting", elapsedS: 1, sessionId: SESSION_ID });
    });

    await answerAllNone(user);

    await waitFor(() => expect(ws.sentMessages.some((m) => m.type === "stop")).toBe(true));
    // The source halted (idle) but the bridge still holds the session: last batch not posted yet.
    act(() => {
      ws.receive({ type: "status", state: "idle", elapsedS: 40, sessionId: SESSION_ID });
    });
    await new Promise((r) => setTimeout(r, 80));
    expect(mock.find("POST", /\/complete$/)).toHaveLength(0);

    // Post-flush idle releases /complete.
    act(() => {
      ws.receive({ type: "status", state: "idle", elapsedS: 0, sessionId: null });
    });
    await waitFor(() => expect(mock.find("POST", /\/complete$/)).toHaveLength(1));
    expect(
      await screen.findByRole("heading", { name: /Thank you\. Your check-in is complete/ }),
    ).toBeInTheDocument();
  });

  it("retries POST /sessions with the typed label when the composed USUBJID is unknown", async () => {
    const user = userEvent.setup();
    const mock = installMockFetch(routes({ knownUsubjids: ["P-007"] }));
    renderKiosk();
    await startCheckIn(user, "P-007", false, ITEMS.items[0].label);

    const posts = mock.find("POST", "/api/v1/sessions");
    expect(posts.map((p) => (p.body as { usubjid: string }).usubjid)).toEqual([
      USUBJID_P007,
      "P-007",
    ]);
  });

  it("re-sends start for the session after the bridge socket reconnects", async () => {
    const user = userEvent.setup();
    installMockFetch(routes());
    renderKiosk();
    await startCheckIn(user, "P-007", true, ITEMS.items[0].label);
    const ws1 = FakeWebSocket.last!;
    await waitFor(() =>
      expect(ws1.sentMessages).toContainEqual({ type: "start", sessionId: SESSION_ID }),
    );

    act(() => {
      ws1.serverClose();
    });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2), { timeout: 2000 });
    const ws2 = FakeWebSocket.last!;
    await waitFor(() =>
      expect(ws2.sentMessages).toContainEqual({ type: "start", sessionId: SESSION_ID }),
    );
  });

  it("shows the fixed stop screen text when /complete returns stop_screen=true", async () => {
    const user = userEvent.setup();
    installMockFetch(
      routes({
        complete: completeResponse({ tier: 3, stop_screen: true, stop_screen_text: STOP_TEXT }),
      }),
    );
    renderKiosk();

    // Opt out of the camera on Welcome: no vitals panel, no `start` to the bridge.
    await startCheckIn(user, "P-003", false, ITEMS.items[0].label);
    expect(screen.queryByTestId("vitals-panel")).not.toBeInTheDocument();
    expect(FakeWebSocket.last?.sentMessages.some((m) => m.type === "start")).toBeFalsy();

    await clickOption(user, "Very severe");
    await clickOption(user, "Very much");
    await user.click(await screen.findByRole("button", { name: "Next" }));
    await clickOption(user, "None");
    await clickOption(user, "Not at all");
    await user.click(await screen.findByRole("button", { name: "Next" }));
    await clickOption(user, "No");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await clickOption(user, "Yes"); // hospitalization
    await user.click(screen.getByRole("button", { name: "Next" }));
    await clickOption(user, "No"); // con-med
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Finish check-in" }));

    const stop = await screen.findByTestId("stop-screen");
    expect(within(stop).getByText(STOP_TEXT)).toBeInTheDocument();
    // Nothing else: no tier, grade, or next-steps copy.
    expect(screen.queryByText(/tier/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Your check-in is complete/)).not.toBeInTheDocument();
    // No `stop` sent to the bridge because capture never started.
    expect(FakeWebSocket.last?.sentMessages.some((m) => m.type === "stop")).toBeFalsy();
  });

  it("returns to Welcome with a message when the study ID is unknown", async () => {
    const user = userEvent.setup();
    installMockFetch(routes({ sessionStatus: 404 }));
    renderKiosk();

    await user.type(await screen.findByLabelText("Your study ID"), "P-999");
    await user.click(screen.getByRole("button", { name: "Start check-in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /couldn't start a check-in with that study ID/,
    );
    expect(screen.getByRole("heading", { name: "Welcome" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/Unknown participant/);
    // The typed ID stays in the box so the participant can correct it.
    expect(screen.getByLabelText("Your study ID")).toHaveValue("P-999");
    expect(FakeWebSocket.last?.sentMessages.some((m) => m.type === "start")).toBeFalsy();
  });

  it("hides the unknown-ID message as soon as the participant corrects the ID", async () => {
    const user = userEvent.setup();
    const mock = installMockFetch(routes({ knownUsubjids: [USUBJID_P007] }));
    renderKiosk();

    const input = await screen.findByLabelText("Your study ID");
    await user.type(input, "P-999");
    await user.click(screen.getByRole("button", { name: "Start check-in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /couldn't start a check-in with that study ID/,
    );

    // Editing the box: the message no longer describes what is typed, so it goes.
    await user.clear(input);
    await user.type(input, "P-007");
    expect(
      screen.queryByText(/couldn't start a check-in with that study ID/),
    ).not.toBeInTheDocument();

    // Typing the rejected ID back (any case) brings it back: it is still the rejected one.
    await user.clear(input);
    await user.type(input, "p-999");
    expect(screen.getByText(/couldn't start a check-in with that study ID/)).toBeInTheDocument();

    // The corrected ID starts normally.
    await user.clear(input);
    await user.type(input, "P-007");
    await user.click(screen.getByRole("button", { name: "Start check-in" }));
    expect(await screen.findByRole("heading", { name: ITEMS.items[0].label })).toBeInTheDocument();
    const posts = mock.find("POST", "/api/v1/sessions");
    expect(posts[posts.length - 1].body).toMatchObject({ usubjid: USUBJID_P007 });
  });

  describe("camera opt-out toggle (replaces the consent screen)", () => {
    it("sends consent_camera:false when ticked, shows no vitals card and never starts the bridge", async () => {
      const user = userEvent.setup();
      const mock = installMockFetch(routes());
      renderKiosk();

      const toggle = await screen.findByRole("checkbox", { name: CAMERA_OPT_OUT_LABEL });
      await user.click(toggle);
      expect(toggle).toBeChecked();
      expect(screen.getByText(/The camera will stay off/)).toBeInTheDocument();
      await user.type(screen.getByLabelText("Your study ID"), "P-007");
      await user.click(screen.getByRole("button", { name: "Start check-in" }));

      expect(
        await screen.findByRole("heading", { name: ITEMS.items[0].label }),
      ).toBeInTheDocument();
      expect(mock.find("POST", "/api/v1/sessions")[0].body).toEqual({
        usubjid: USUBJID_P007,
        consent_camera: false,
      });
      expect(screen.queryByTestId("vitals-panel")).not.toBeInTheDocument();
      expect(FakeWebSocket.last?.sentMessages.some((m) => m.type === "start")).toBeFalsy();
    });

    it("is keyboard operable: Space toggles it and Enter in the ID box starts the check-in", async () => {
      const user = userEvent.setup();
      const mock = installMockFetch(routes());
      renderKiosk();

      const toggle = await screen.findByRole("checkbox", { name: CAMERA_OPT_OUT_LABEL });
      toggle.focus();
      await user.keyboard(" ");
      expect(toggle).toBeChecked();
      await user.keyboard(" ");
      expect(toggle).not.toBeChecked();

      await user.type(screen.getByLabelText("Your study ID"), "P-007{Enter}");
      expect(
        await screen.findByRole("heading", { name: ITEMS.items[0].label }),
      ).toBeInTheDocument();
      expect(mock.find("POST", "/api/v1/sessions")[0].body).toMatchObject({
        consent_camera: true,
      });
    });

    it("resets to camera on and an empty ID for the next participant after Done", async () => {
      const user = userEvent.setup();
      installMockFetch(routes());
      renderKiosk();
      await startCheckIn(user, "P-007", false, ITEMS.items[0].label);
      await answerAllNone(user);
      await user.click(await screen.findByRole("button", { name: "Done" }));

      expect(await screen.findByRole("heading", { name: "Welcome" })).toBeInTheDocument();
      expect(screen.getByRole("checkbox", { name: CAMERA_OPT_OUT_LABEL })).not.toBeChecked();
      expect(screen.getByLabelText("Your study ID")).toHaveValue("");
    });

    it("offers Try again on a server error and resends with the same choice", async () => {
      const user = userEvent.setup();
      let fail = true;
      const base = routes();
      const sessionRoute = base.find((r) => r.method === "POST" && r.path === "/api/v1/sessions")!;
      const original = sessionRoute.handler;
      sessionRoute.handler = (ctx) =>
        fail
          ? { status: 503, json: { type: "about:blank", title: "Unavailable", status: 503 } }
          : original(ctx);
      const mock = installMockFetch(base);
      renderKiosk();

      await user.type(await screen.findByLabelText("Your study ID"), "P-007");
      await user.click(screen.getByRole("checkbox", { name: CAMERA_OPT_OUT_LABEL }));
      await user.click(screen.getByRole("button", { name: "Start check-in" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        /couldn't start the check-in\. Please try again/,
      );
      expect(screen.getByRole("heading", { name: "Welcome" })).toBeInTheDocument();

      fail = false;
      await user.click(screen.getByRole("button", { name: "Try again" }));
      expect(
        await screen.findByRole("heading", { name: ITEMS.items[0].label }),
      ).toBeInTheDocument();
      const posts = mock.find("POST", "/api/v1/sessions");
      expect(posts.length).toBeGreaterThanOrEqual(2);
      expect(posts[posts.length - 1].body).toEqual({
        usubjid: USUBJID_P007,
        consent_camera: false,
      });
      expect(screen.queryByTestId("vitals-panel")).not.toBeInTheDocument();
    });

    /** POST /sessions answers 503 while `state.fail` is true. */
    function failingSessionRoutes(state: { fail: boolean }): Route[] {
      const base = routes();
      const sessionRoute = base.find((r) => r.method === "POST" && r.path === "/api/v1/sessions")!;
      const original = sessionRoute.handler;
      sessionRoute.handler = (ctx) =>
        state.fail
          ? { status: 503, json: { type: "about:blank", title: "Unavailable", status: 503 } }
          : original(ctx);
      return base;
    }

    it("Try again uses the opt-out as it is NOW (ticked after the failure means camera off)", async () => {
      const user = userEvent.setup();
      const state = { fail: true };
      const mock = installMockFetch(failingSessionRoutes(state));
      renderKiosk();

      // Camera left on for the failed attempt.
      await user.type(await screen.findByLabelText("Your study ID"), "P-007");
      await user.click(screen.getByRole("button", { name: "Start check-in" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't start the check-in/);
      expect(mock.find("POST", "/api/v1/sessions")[0].body).toMatchObject({
        consent_camera: true,
      });

      // The participant changes their mind before retrying.
      await user.click(screen.getByRole("checkbox", { name: CAMERA_OPT_OUT_LABEL }));
      state.fail = false;
      await user.click(screen.getByRole("button", { name: "Try again" }));

      expect(
        await screen.findByRole("heading", { name: ITEMS.items[0].label }),
      ).toBeInTheDocument();
      const posts = mock.find("POST", "/api/v1/sessions");
      expect(posts[posts.length - 1].body).toEqual({
        usubjid: USUBJID_P007,
        consent_camera: false,
      });
      expect(screen.queryByTestId("vitals-panel")).not.toBeInTheDocument();
      expect(FakeWebSocket.last?.sentMessages.some((m) => m.type === "start")).toBeFalsy();
    });

    it("Try again uses the ID as it is NOW (corrected after the failure)", async () => {
      const user = userEvent.setup();
      const state = { fail: true };
      const mock = installMockFetch(failingSessionRoutes(state));
      renderKiosk();

      const input = await screen.findByLabelText("Your study ID");
      await user.type(input, "P-070");
      await user.click(screen.getByRole("button", { name: "Start check-in" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't start the check-in/);

      await user.clear(input);
      await user.type(input, "P-007");
      state.fail = false;
      await user.click(screen.getByRole("button", { name: "Try again" }));

      expect(
        await screen.findByRole("heading", { name: ITEMS.items[0].label }),
      ).toBeInTheDocument();
      const posts = mock.find("POST", "/api/v1/sessions");
      expect(posts[posts.length - 1].body).toEqual({
        usubjid: USUBJID_P007,
        consent_camera: true,
      });
    });
  });

  it("keeps the vitals card in the side column when the camera is on (docs/ISSUES #21)", async () => {
    const user = userEvent.setup();
    installMockFetch(routes());
    renderKiosk();
    await startCheckIn(user, "P-007", true, ITEMS.items[0].label);
    const side = await screen.findByTestId("kiosk-side");
    expect(within(side).getByTestId("vitals-panel")).toBeInTheDocument();
    // The grid reads its side column from --kiosk-side, which is built from
    // SIDE_COLUMN_REM: the constant is the only place the width lives.
    const grid = side.parentElement!;
    expect(grid.className).toContain("lg:grid-cols-[minmax(0,1fr)_var(--kiosk-side)]");
    expect(grid.style.getPropertyValue("--kiosk-side")).toBe(`${SIDE_COLUMN_REM}rem`);
    expect(grid.className).not.toMatch(/grid-cols-\[[^\]]*\d+rem/);
    // Wide enough that "HRV (RMSSD)" (~79px) and "128 beats/min" (~97px) each
    // fit one line in the card's 3 metric columns: 16px rem, card p-4 (2 x 16px),
    // gap-3 (2 x 12px) between the columns.
    const perMetricPx = (SIDE_COLUMN_REM * 16 - 2 * 16 - 2 * 12) / 3;
    expect(perMetricPx).toBeGreaterThanOrEqual(97);
    // Capped when the layout stacks below lg, so the card stays secondary.
    expect(side.className).toContain("max-w-md");
  });

  it("keeps the header and main the same width on every step, so nothing jumps (docs/ISSUES #21)", async () => {
    const user = userEvent.setup();
    installMockFetch(routes());
    renderKiosk();

    await screen.findByLabelText("Your study ID");
    expect(screen.getByTestId("kiosk-header-row").className).toContain(SHELL_MAX_W);
    expect(screen.getByRole("main").className).toContain(SHELL_MAX_W);

    await startCheckIn(user, "P-007", true, ITEMS.items[0].label);
    expect(await screen.findByTestId("kiosk-side")).toBeInTheDocument();
    expect(screen.getByTestId("kiosk-header-row").className).toContain(SHELL_MAX_W);
    expect(screen.getByRole("main").className).toContain(SHELL_MAX_W);
    expect(screen.getByRole("main").className).not.toMatch(/max-w-5xl/);
  });

  it("blocks Next and offers retry when an answer POST fails, then recovers", async () => {
    const user = userEvent.setup();
    let fail = true;
    const base = routes();
    const answerRoute = base.find(
      (r) => r.method === "POST" && String(r.path).includes("answers"),
    )!;
    const original = answerRoute.handler;
    answerRoute.handler = (ctx) =>
      fail
        ? { status: 500, json: { type: "about:blank", title: "Server Error", status: 500 } }
        : original(ctx);
    const mock = installMockFetch(base);
    renderKiosk();
    await startCheckIn(user, "P-007", false, ITEMS.items[0].label);

    await clickOption(user, "Mild");
    await clickOption(user, "Not at all");
    expect(await screen.findByRole("alert")).toHaveTextContent(/Your answer was not saved/);
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
    expect(mock.find("POST", /\/answers$/).length).toBeGreaterThanOrEqual(3);
  });

  it("resends EVERY failed attribute on Try again, and Next stays disabled until all are acknowledged", async () => {
    const user = userEvent.setup();
    let fail = true;
    const base = routes();
    const answerRoute = base.find(
      (r) => r.method === "POST" && String(r.path).includes("answers"),
    )!;
    const original = answerRoute.handler;
    answerRoute.handler = (ctx) =>
      fail
        ? { status: 500, json: { type: "about:blank", title: "Server Error", status: 500 } }
        : original(ctx);
    const mock = installMockFetch(base);
    renderKiosk();
    await startCheckIn(user, "P-007", false, ITEMS.items[0].label);

    // Both attributes fail during an API hiccup.
    await clickOption(user, "Moderate");
    await clickOption(user, "Somewhat");
    await waitFor(() => expect(mock.find("POST", /\/answers$/)).toHaveLength(2));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Your answer was not saved/);
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

    // Still failing: one retry resends both, Next stays disabled.
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(mock.find("POST", /\/answers$/)).toHaveLength(4));
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

    // API recovers: the retry resends both again and Next unlocks only then.
    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Next" })).toBeEnabled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    const resent = mock
      .find("POST", /\/answers$/)
      .slice(4)
      .map((c) => c.body as AnswerRequest);
    expect(resent.map((r) => r.attribute).sort()).toEqual(["interference", "severity"]);
    expect(resent).toContainEqual(
      expect.objectContaining({ item_id: "shortness_of_breath", attribute: "severity", value: 2 }),
    );
    expect(resent).toContainEqual(
      expect.objectContaining({
        item_id: "shortness_of_breath",
        attribute: "interference",
        value: 2,
      }),
    );
  });

  describe("with the rules tables' own shapes (prompts, optional_fields, gate text_prompt)", () => {
    it("renders the table wording and drops the redundant recall line", async () => {
      const user = userEvent.setup();
      installMockFetch(routes({ items: ITEMS_TABLE_SHAPE }));
      renderKiosk();
      await startCheckIn(user, "P-007", false, "Shortness of breath");

      expect(
        screen.getByText(
          "In the last 7 days, how bad was your shortness of breath when it was at its worst?",
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText(/Think about/)).not.toBeInTheDocument();
      await clickOption(user, "None");
      await clickOption(user, "Not at all");
      await user.click(await screen.findByRole("button", { name: "Next" }));

      expect(await screen.findByRole("heading", { name: "Fever or chills" })).toBeInTheDocument();
      expect(
        screen.getByText("In the last 7 days, did you have a fever or chills?"),
      ).toBeInTheDocument();
      expect(screen.queryByText(/Think about/)).not.toBeInTheDocument();
      await clickOption(user, "Yes");
      // The temperature label comes from the table, not a generic fallback.
      expect(
        screen.getByLabelText(
          "If you took your temperature, what was the highest reading? (optional)",
        ),
      ).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Continue" }));

      // Gate wording from gate_questions.json.
      expect(
        await screen.findByRole("heading", { name: ITEMS_TABLE_SHAPE.gates[0].label }),
      ).toBeInTheDocument();
      await clickOption(user, "No");
      await user.click(screen.getByRole("button", { name: "Next" }));
      await clickOption(user, "Yes");
      expect(
        screen.getByLabelText("Please type the name of the medication as it appears on the label."),
      ).toBeInTheDocument();
      expect(screen.getByText("Did you start it, stop it, or both?")).toBeInTheDocument();
      // The table's text_note is documentation, not participant copy.
      expect(screen.queryByText(/deterministic string matcher/)).not.toBeInTheDocument();
      await clickOption(user, "No");
      await user.click(screen.getByRole("button", { name: "Next" }));
      expect(
        screen.getByText("Stored verbatim and never parsed by software. It is read by a person."),
      ).toBeInTheDocument();
    });

    it("clears a typed temperature when fever is changed back to No and never sends it", async () => {
      const user = userEvent.setup();
      const mock = installMockFetch(routes({ items: ITEMS_TABLE_SHAPE }));
      renderKiosk();
      await startCheckIn(user, "P-007", false, "Shortness of breath");
      await clickOption(user, "None");
      await clickOption(user, "Not at all");
      await user.click(await screen.findByRole("button", { name: "Next" }));

      await screen.findByRole("heading", { name: "Fever or chills" });
      await clickOption(user, "Yes");
      await user.type(screen.getByRole("spinbutton"), "38.5");
      await clickOption(user, "No");
      expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
      // Changing back to Yes shows an empty box: the stale value is gone.
      await clickOption(user, "Yes");
      expect(screen.getByRole("spinbutton")).toHaveValue(null);
      await clickOption(user, "No");
      await user.click(screen.getByRole("button", { name: "Continue" }));

      await clickOption(user, "No"); // hospitalization
      await user.click(screen.getByRole("button", { name: "Next" }));
      await clickOption(user, "No"); // con-med
      await user.click(screen.getByRole("button", { name: "Next" }));
      await user.click(screen.getByRole("button", { name: "Finish check-in" }));

      await waitFor(() => expect(mock.find("POST", /\/gates$/)).toHaveLength(1));
      const gates = mock.find("POST", /\/gates$/)[0].body as GatesRequest;
      expect(gates).not.toHaveProperty("temp_c");
      expect(gates).toEqual({
        hospitalization: false,
        conmed_changed: false,
        ts_client: expect.stringMatching(ISO),
      });
    });

    it("rejects a temperature outside the table's bounds and sends an in-range one with fever present", async () => {
      const user = userEvent.setup();
      const mock = installMockFetch(routes({ items: ITEMS_TABLE_SHAPE }));
      renderKiosk();
      await startCheckIn(user, "P-007", false, "Shortness of breath");
      await clickOption(user, "None");
      await clickOption(user, "Not at all");
      await user.click(await screen.findByRole("button", { name: "Next" }));

      await screen.findByRole("heading", { name: "Fever or chills" });
      await clickOption(user, "Yes");
      await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled());
      const box = screen.getByRole("spinbutton");
      await user.type(box, "3850");
      expect(
        screen.getByText("Please enter a temperature between 34 and 43 °C, or leave this empty."),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
      expect(box).toHaveAttribute("min", "34");
      expect(box).toHaveAttribute("max", "43");

      await user.clear(box);
      await user.type(box, "38.5");
      expect(screen.queryByText(/Please enter a temperature/)).not.toBeInTheDocument();
      await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled());
      await user.click(screen.getByRole("button", { name: "Continue" }));

      await clickOption(user, "No");
      await user.click(screen.getByRole("button", { name: "Next" }));
      await clickOption(user, "No");
      await user.click(screen.getByRole("button", { name: "Next" }));
      await user.click(screen.getByRole("button", { name: "Finish check-in" }));

      await waitFor(() => expect(mock.find("POST", /\/gates$/)).toHaveLength(1));
      const gates = mock.find("POST", /\/gates$/)[0].body as GatesRequest;
      expect(gates.temp_c).toBe(38.5);
    });
  });
});
