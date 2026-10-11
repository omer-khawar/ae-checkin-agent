/**
 * End-to-end kiosk flow against a mocked API and a fake bridge socket.
 *
 * The per-session camera consent screen was removed (CLAUDE.md §00, D-026):
 * the Welcome screen carries the "no video is stored" line and an optional
 * "Use the camera" box (off by default, R5.6) whose value is sent as consent_camera.
 * R5.1: the first question after the study ID is "are you having trouble breathing...";
 * Yes (or Severe / Very severe shortness of breath) stops the check-in at once.
 */
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { KioskFlow } from "../pages/kiosk/KioskFlow";
import { DISCLAIMER_TEXT } from "../components/Disclaimer";
import { SHELL_MAX_W, SIDE_COLUMN_REM } from "../pages/kiosk/KioskShell";
import { CAMERA_OPT_IN_LABEL, NO_VIDEO_TEXT } from "../pages/kiosk/Welcome";
import type {
  AnswerRequest,
  CompleteResponse,
  GatesRequest,
  ItemsResponse,
  UrgentRequest,
} from "../lib/types";
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
const SITE_PHONE = "(732) 555-0142";
/** The urgent_now question (fallback wording; the fixture catalog does not carry it). */
const URGENT_HEADING = /trouble breathing, or chest pain or tightness/;

interface RouteOptions {
  complete?: CompleteResponse;
  sessionStatus?: number;
  /** usubjid values POST /sessions accepts; anything else is a 404. Default: accept all. */
  knownUsubjids?: string[];
  items?: ItemsResponse;
  /** POST /urgent status; >= 400 simulates an unreachable / missing endpoint. */
  urgentStatus?: number;
}

function routes(opts: RouteOptions = {}): Route[] {
  let answerSeq = 0;
  return [
    { method: "GET", path: "/api/v1/study", handler: () => ({ json: STUDY }) },
    { method: "GET", path: "/api/v1/items", handler: () => ({ json: opts.items ?? ITEMS }) },
    {
      method: "GET",
      path: "/api/v1/settings/public",
      handler: () => ({ json: { site_phone: SITE_PHONE, site_name: "Study team" } }),
    },
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
    {
      method: "POST",
      path: new RegExp(`^/api/v1/sessions/${SESSION_ID}/urgent$`),
      handler: ({ body }) =>
        opts.urgentStatus && opts.urgentStatus >= 400
          ? {
              status: opts.urgentStatus,
              json: { type: "about:blank", title: "Not Found", status: opts.urgentStatus },
            }
          : {
              json: completeResponse({
                tier: 3,
                stop_screen: true,
                stop_screen_text: STOP_TEXT,
                ended_early: (body as UrgentRequest).trigger,
              }),
            },
    },
  ];
}

function renderKiosk(path = "/kiosk") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <KioskFlow />
    </MemoryRouter>,
  );
}

async function clickOption(user: ReturnType<typeof userEvent.setup>, label: string | RegExp) {
  await user.click(screen.getByRole("radio", { name: label }));
}

/** Last gate -> review screen -> send. */
async function finish(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Review my answers" }));
  await user.click(await screen.findByRole("button", { name: "Send my answers" }));
}

/** The urgent_now screen answered No: pick No, press Next. */
async function passUrgent(user: ReturnType<typeof userEvent.setup>) {
  expect(await screen.findByRole("heading", { name: URGENT_HEADING })).toBeInTheDocument();
  await clickOption(user, "No");
  await user.click(screen.getByRole("button", { name: "Next" }));
}

/** Welcome (ID + optional camera box) → Start → urgent question No; returns once the first item heading is on screen. */
async function startCheckIn(
  user: ReturnType<typeof userEvent.setup>,
  id: string,
  camera: boolean,
  firstHeading: string,
) {
  await user.type(await screen.findByLabelText("Your study ID"), id);
  if (camera) await user.click(screen.getByRole("checkbox", { name: CAMERA_OPT_IN_LABEL }));
  await user.click(screen.getByRole("button", { name: "Start check-in" }));
  await passUrgent(user);
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
  await finish(user);
}

describe("kiosk flow", () => {
  it("runs end-to-end: welcome → session → answers → gates → stop bridge → complete → thank-you", async () => {
    const user = userEvent.setup();
    const mock = installMockFetch(routes());
    renderKiosk("/kiosk?presenter=1");

    // Welcome shows the disclaimer footer, and no study title or clinical word.
    expect(await screen.findByRole("heading", { name: "Welcome" })).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(STUDY.title.slice(0, 20)))).not.toBeInTheDocument();
    expect(screen.getByText(DISCLAIMER_TEXT)).toBeInTheDocument();
    // The "no video is stored" line and the camera box, camera OFF by default.
    expect(screen.getByText(NO_VIDEO_TEXT)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: CAMERA_OPT_IN_LABEL })).not.toBeChecked();

    await user.type(screen.getByLabelText("Your study ID"), "p-007");
    await user.click(screen.getByRole("checkbox", { name: CAMERA_OPT_IN_LABEL }));
    expect(mock.find("POST", "/api/v1/sessions")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Start check-in" }));

    // No consent screen: Start goes straight to the session with the composed
    // USUBJID and consent_camera from the ticked box.
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

    // Screen 1 (R5.1): the urgent question, Yes before No. Next with nothing chosen prompts.
    expect(await screen.findByRole("heading", { name: URGENT_HEADING })).toBeInTheDocument();
    expect(screen.getByText(`Question 1 of ${ITEMS.items.length + 4}`)).toBeInTheDocument();
    expect(
      screen.getAllByRole("radio").map((r) => r.closest("label")?.textContent?.trim()),
    ).toEqual(["Yes", "No"]);
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Please choose an answer")).toBeInTheDocument();
    await clickOption(user, "No");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(mock.find("POST", /\/urgent$/)).toHaveLength(0);

    // Item 1: shortness of breath → Moderate / Somewhat. Each tap POSTs immediately.
    expect(await screen.findByRole("heading", { name: ITEMS.items[0].label })).toBeInTheDocument();
    // Fixture items carry no prompts, so the recall helper line is shown (grammatical form).
    expect(screen.getByText("Think about the last 7 days.")).toBeInTheDocument();
    // Presenter mode shows the vitals numbers, so the camera line says simulated next to them.
    // One counter over all screens (urgent question + items + 3 gates).
    expect(screen.getByTestId("kiosk-camera-status")).toHaveTextContent("Camera on · simulated");
    expect(screen.getByText(`Question 2 of ${ITEMS.items.length + 4}`)).toBeInTheDocument();
    // Next is always enabled: pressing it with nothing chosen prompts instead of advancing.
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect((await screen.findAllByText("Please choose an answer")).length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: ITEMS.items[0].label })).toBeInTheDocument();
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
    expect(screen.getByRole("radio", { name: "Moderate" })).toBeChecked();
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
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Please choose an answer")).toBeInTheDocument();
    await clickOption(user, "Yes");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Please type the name of the medication")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: ITEMS.gates[1].label })).toBeInTheDocument();
    await user.type(screen.getByLabelText("What is the name of the medication?"), "  loratadine ");
    await clickOption(user, "Started");
    await user.click(screen.getByRole("button", { name: "Next" }));

    // Gate 3: free text, then Finish → gates POSTed once with everything, verbatim.
    expect(await screen.findByRole("heading", { name: ITEMS.gates[2].label })).toBeInTheDocument();
    await user.type(screen.getByRole("textbox"), "feeling ok ");
    await user.click(screen.getByRole("button", { name: "Review my answers" }));

    // Review: plain list of answers, nothing sent until "Send my answers".
    const review = await screen.findByTestId("review-screen");
    expect(within(review).getByText("Moderate · Somewhat")).toBeInTheDocument();
    expect(within(review).getByText(/^Yes:\s+loratadine \(started\)$/)).toBeInTheDocument();
    expect(mock.find("POST", /\/gates$/)).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Send my answers" }));

    await waitFor(() => expect(mock.find("POST", /\/gates$/)).toHaveLength(1));
    const gates = mock.find("POST", /\/gates$/)[0].body as GatesRequest;
    expect(gates).toMatchObject({
      hospitalization: false,
      urgent_now: false,
      conmed_changed: true,
      conmeds: [{ text: "  loratadine ", direction: "started" }],
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
  }, 20_000);

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

    // Camera left off on Welcome: no vitals panel, no `start` to the bridge.
    await startCheckIn(user, "P-003", false, ITEMS.items[0].label);
    expect(screen.queryByTestId("vitals-panel")).not.toBeInTheDocument();
    expect(FakeWebSocket.last?.sentMessages.some((m) => m.type === "start")).toBeFalsy();

    // (Severe shortness of breath would stop at once, R5.1; here the stop comes from /complete.)
    await clickOption(user, "Moderate");
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
    await finish(user);

    const stop = await screen.findByTestId("stop-screen");
    expect(within(stop).getByText(STOP_TEXT)).toBeInTheDocument();
    expect(within(stop).getByTestId("stop-phone")).toHaveTextContent(
      `Call the study team: ${SITE_PHONE}`,
    );
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
    // Plain language only: no cause, status code or field name.
    expect(screen.getByRole("alert")).not.toHaveTextContent(/Unknown participant|404|usubjid/i);
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
    expect(await screen.findByRole("heading", { name: URGENT_HEADING })).toBeInTheDocument();
    const posts = mock.find("POST", "/api/v1/sessions");
    expect(posts[posts.length - 1].body).toMatchObject({ usubjid: USUBJID_P007 });
  });

  describe("camera opt-in box (replaces the consent screen)", () => {
    it("is OFF by default: consent_camera:false, no vitals card, the bridge never starts", async () => {
      const user = userEvent.setup();
      const mock = installMockFetch(routes());
      renderKiosk();

      const box = await screen.findByRole("checkbox", { name: CAMERA_OPT_IN_LABEL });
      expect(box).not.toBeChecked();
      expect(screen.getByText(/The camera will stay off/)).toBeInTheDocument();
      await user.type(screen.getByLabelText("Your study ID"), "P-007");
      await user.click(screen.getByRole("button", { name: "Start check-in" }));
      await passUrgent(user);

      expect(
        await screen.findByRole("heading", { name: ITEMS.items[0].label }),
      ).toBeInTheDocument();
      expect(mock.find("POST", "/api/v1/sessions")[0].body).toEqual({
        usubjid: USUBJID_P007,
        consent_camera: false,
      });
      expect(screen.getByTestId("kiosk-camera-status")).toHaveTextContent(/^Camera off$/);
      expect(screen.queryByTestId("vitals-panel")).not.toBeInTheDocument();
      expect(FakeWebSocket.last?.sentMessages.some((m) => m.type === "start")).toBeFalsy();
    });

    it("sends consent_camera:true when ticked and starts the bridge", async () => {
      const user = userEvent.setup();
      const mock = installMockFetch(routes());
      renderKiosk();
      await startCheckIn(user, "P-007", true, ITEMS.items[0].label);
      expect(mock.find("POST", "/api/v1/sessions")[0].body).toEqual({
        usubjid: USUBJID_P007,
        consent_camera: true,
      });
      await waitFor(() =>
        expect(FakeWebSocket.last?.sentMessages).toContainEqual({
          type: "start",
          sessionId: SESSION_ID,
        }),
      );
      // A quiet line for patients: the word "simulated" appears only where numbers are shown.
      expect(screen.getByTestId("kiosk-camera-status")).toHaveTextContent(/^Camera on$/);
    });

    it("is keyboard operable: Space toggles it and Enter in the ID box starts the check-in", async () => {
      const user = userEvent.setup();
      const mock = installMockFetch(routes());
      renderKiosk();

      const toggle = await screen.findByRole("checkbox", { name: CAMERA_OPT_IN_LABEL });
      toggle.focus();
      await user.keyboard(" ");
      expect(toggle).toBeChecked();
      await user.keyboard(" ");
      expect(toggle).not.toBeChecked();

      await user.type(screen.getByLabelText("Your study ID"), "P-007{Enter}");
      await passUrgent(user);
      expect(
        await screen.findByRole("heading", { name: ITEMS.items[0].label }),
      ).toBeInTheDocument();
      expect(mock.find("POST", "/api/v1/sessions")[0].body).toMatchObject({
        consent_camera: false,
      });
    });

    it("resets to camera off and an empty ID for the next participant after Done", async () => {
      const user = userEvent.setup();
      installMockFetch(routes());
      renderKiosk();
      await startCheckIn(user, "P-007", true, ITEMS.items[0].label);
      await answerAllNone(user);
      await user.click(await screen.findByRole("button", { name: "Done" }));

      expect(await screen.findByRole("heading", { name: "Welcome" })).toBeInTheDocument();
      expect(screen.getByRole("checkbox", { name: CAMERA_OPT_IN_LABEL })).not.toBeChecked();
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
      await user.click(screen.getByRole("button", { name: "Start check-in" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        /couldn't start the check-in\. Please try again/,
      );
      expect(screen.getByRole("heading", { name: "Welcome" })).toBeInTheDocument();

      fail = false;
      await user.click(screen.getByRole("button", { name: "Try again" }));
      await passUrgent(user);
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

    it("Try again uses the box as it is NOW (ticked after the failure means camera on)", async () => {
      const user = userEvent.setup();
      const state = { fail: true };
      const mock = installMockFetch(failingSessionRoutes(state));
      renderKiosk();

      // Camera left off for the failed attempt.
      await user.type(await screen.findByLabelText("Your study ID"), "P-007");
      await user.click(screen.getByRole("button", { name: "Start check-in" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't start the check-in/);
      expect(mock.find("POST", "/api/v1/sessions")[0].body).toMatchObject({
        consent_camera: false,
      });

      // The participant changes their mind before retrying.
      await user.click(screen.getByRole("checkbox", { name: CAMERA_OPT_IN_LABEL }));
      state.fail = false;
      await user.click(screen.getByRole("button", { name: "Try again" }));
      await passUrgent(user);

      expect(
        await screen.findByRole("heading", { name: ITEMS.items[0].label }),
      ).toBeInTheDocument();
      const posts = mock.find("POST", "/api/v1/sessions");
      expect(posts[posts.length - 1].body).toEqual({
        usubjid: USUBJID_P007,
        consent_camera: true,
      });
      await waitFor(() =>
        expect(FakeWebSocket.last?.sentMessages.some((m) => m.type === "start")).toBe(true),
      );
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
      await passUrgent(user);

      expect(
        await screen.findByRole("heading", { name: ITEMS.items[0].label }),
      ).toBeInTheDocument();
      const posts = mock.find("POST", "/api/v1/sessions");
      expect(posts[posts.length - 1].body).toEqual({
        usubjid: USUBJID_P007,
        consent_camera: false,
      });
    });
  });

  describe("urgent path (R5.1)", () => {
    it("urgent_now = Yes posts /urgent at once, shows the stop screen and asks nothing more", async () => {
      const user = userEvent.setup();
      const mock = installMockFetch(routes());
      renderKiosk();
      await user.type(await screen.findByLabelText("Your study ID"), "P-007");
      await user.click(screen.getByRole("button", { name: "Start check-in" }));
      expect(await screen.findByRole("heading", { name: URGENT_HEADING })).toBeInTheDocument();
      await clickOption(user, "Yes");

      const stop = await screen.findByTestId("stop-screen");
      // No Next to press: the stop screen replaces the question.
      expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
      await waitFor(() => expect(mock.find("POST", /\/urgent$/)).toHaveLength(1));
      const call = mock.find("POST", /\/urgent$/)[0].body as UrgentRequest;
      expect(call.trigger).toBe("urgent_now");
      expect(call.ts_client).toMatch(ISO);
      // The API's fixed text wins; "Your answers were saved." is on screen; the phone line too.
      await waitFor(() => expect(within(stop).getByText(STOP_TEXT)).toBeInTheDocument());
      expect(STOP_TEXT).toContain("Your answers were saved.");
      expect(within(stop).getByTestId("stop-phone")).toHaveTextContent(
        `Call the study team: ${SITE_PHONE}`,
      );
      // No more questions, no gates, no complete; nothing clinical on screen.
      expect(mock.find("POST", /\/(gates|complete)$/)).toHaveLength(0);
      expect(mock.find("POST", /\/answers$/)).toHaveLength(0);
      expect(screen.queryByText(/tier|grade/i)).not.toBeInTheDocument();
      expect(screen.getByText(DISCLAIMER_TEXT)).toBeInTheDocument();
    });

    it("Severe shortness of breath posts the answer, then /urgent with severe_dyspnea", async () => {
      const user = userEvent.setup();
      const mock = installMockFetch(routes());
      renderKiosk();
      await startCheckIn(user, "P-007", false, ITEMS.items[0].label);

      await clickOption(user, "Severe");
      expect(await screen.findByTestId("stop-screen")).toBeInTheDocument();
      await waitFor(() => expect(mock.find("POST", /\/urgent$/)).toHaveLength(1));
      expect((mock.find("POST", /\/urgent$/)[0].body as UrgentRequest).trigger).toBe(
        "severe_dyspnea",
      );
      // The severity answer reached the server before the urgent call.
      const answer = mock.find("POST", /\/answers$/)[0];
      expect(answer.body).toMatchObject({
        item_id: "shortness_of_breath",
        attribute: "severity",
        value: 3,
      });
      expect(mock.calls.indexOf(answer)).toBeLessThan(
        mock.calls.indexOf(mock.find("POST", /\/urgent$/)[0]),
      );
      expect(mock.find("POST", /\/(gates|complete)$/)).toHaveLength(0);
    });

    it("Very severe does the same; Moderate does not stop the check-in", async () => {
      const user = userEvent.setup();
      const mock = installMockFetch(routes());
      renderKiosk();
      await startCheckIn(user, "P-007", false, ITEMS.items[0].label);
      await clickOption(user, "Moderate");
      await clickOption(user, "Very much"); // interference never triggers it
      expect(screen.queryByTestId("stop-screen")).not.toBeInTheDocument();
      expect(mock.find("POST", /\/urgent$/)).toHaveLength(0);
      await clickOption(user, "Very severe");
      expect(await screen.findByTestId("stop-screen")).toBeInTheDocument();
      await waitFor(() => expect(mock.find("POST", /\/urgent$/)).toHaveLength(1));
      expect((mock.find("POST", /\/urgent$/)[0].body as UrgentRequest).trigger).toBe(
        "severe_dyspnea",
      );
    });

    it("still shows the stop screen when /urgent cannot be delivered, without claiming anything was saved", async () => {
      const user = userEvent.setup();
      installMockFetch(routes({ urgentStatus: 404 }));
      renderKiosk();
      await user.type(await screen.findByLabelText("Your study ID"), "P-007");
      await user.click(screen.getByRole("button", { name: "Start check-in" }));
      await clickOption(user, "Yes");
      const stop = await screen.findByTestId("stop-screen");
      await waitFor(() =>
        expect(
          within(stop).getByText(/Please tell a member of the study team right away/),
        ).toBeInTheDocument(),
      );
      expect(within(stop).getByText(/call 911 now/)).toBeInTheDocument();
      expect(within(stop).queryByText(/answers were saved/)).not.toBeInTheDocument();
      expect(within(stop).getByTestId("stop-phone")).toBeInTheDocument();
    });

    it("the normal path never calls /urgent and sends urgent_now:false with the gates", async () => {
      const user = userEvent.setup();
      const mock = installMockFetch(routes());
      renderKiosk();
      await startCheckIn(user, "P-007", false, ITEMS.items[0].label);
      await answerAllNone(user);
      await screen.findByRole("heading", { name: /Your check-in is complete/ });
      expect(mock.find("POST", /\/urgent$/)).toHaveLength(0);
      expect(mock.find("POST", /\/gates$/)[0].body).toMatchObject({ urgent_now: false });
    });

    it("the thank-you screen shows the study team's phone line from /settings/public", async () => {
      const user = userEvent.setup();
      installMockFetch(routes());
      renderKiosk();
      await startCheckIn(user, "P-007", false, ITEMS.items[0].label);
      await answerAllNone(user);
      expect(await screen.findByTestId("thankyou-phone")).toHaveTextContent(
        `Call the study team: ${SITE_PHONE}`,
      );
    });
  });

  describe("Need help? and Yes-before-No (R5.6)", () => {
    it("shows the phone line, and the help line is gone for the next person after Done", async () => {
      const user = userEvent.setup();
      installMockFetch(routes());
      renderKiosk();
      await startCheckIn(user, "P-007", false, ITEMS.items[0].label);
      await user.click(screen.getByRole("button", { name: "Need help?" }));
      expect(screen.getByTestId("help-phone")).toHaveTextContent(
        `Call the study team: ${SITE_PHONE}`,
      );
      // Still open when the participant keeps answering...
      await clickOption(user, "None");
      expect(screen.getByTestId("help-phone")).toBeInTheDocument();
      // ...and cleared once the check-in is finished and the kiosk resets.
      await clickOption(user, "Not at all");
      await user.click(screen.getByRole("button", { name: "Next" }));
      await clickOption(user, "None");
      await clickOption(user, "Not at all");
      await user.click(await screen.findByRole("button", { name: "Next" }));
      await clickOption(user, "No");
      await user.click(screen.getByRole("button", { name: "Continue" }));
      await clickOption(user, "No");
      await user.click(screen.getByRole("button", { name: "Next" }));
      await clickOption(user, "No");
      await user.click(screen.getByRole("button", { name: "Next" }));
      await finish(user);
      await screen.findByRole("heading", { name: /Your check-in is complete/ });
      expect(screen.queryByTestId("help-phone")).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Done" }));
      await screen.findByRole("heading", { name: "Welcome" });
      expect(screen.queryByTestId("help-phone")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Need help?" })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
    });

    it("lists Yes before No on the presence item and the gates", async () => {
      const user = userEvent.setup();
      installMockFetch(routes());
      renderKiosk();
      await startCheckIn(user, "P-007", false, ITEMS.items[0].label);
      await clickOption(user, "None");
      await clickOption(user, "Not at all");
      await user.click(screen.getByRole("button", { name: "Next" }));
      await clickOption(user, "None");
      await clickOption(user, "Not at all");
      await user.click(screen.getByRole("button", { name: "Next" }));
      // rash: the table lists No (0) before Yes (1); the screen shows Yes first.
      expect(
        await screen.findByRole("heading", { name: ITEMS.items[2].label }),
      ).toBeInTheDocument();
      const labels = () =>
        screen.getAllByRole("radio").map((r) => r.closest("label")?.textContent?.trim());
      expect(labels()).toEqual(["Yes", "No"]);
      await clickOption(user, "No");
      await user.click(screen.getByRole("button", { name: "Continue" }));
      expect(labels()).toEqual(["Yes", "No"]); // hospitalization
      await clickOption(user, "No");
      await user.click(screen.getByRole("button", { name: "Next" }));
      expect(labels()).toEqual(["Yes", "No"]); // con-med
    });
  });

  describe("several medications (R5.2)", () => {
    async function toConmedGate(user: ReturnType<typeof userEvent.setup>) {
      await startCheckIn(user, "P-007", false, ITEMS.items[0].label);
      await clickOption(user, "None");
      await clickOption(user, "Not at all");
      await user.click(screen.getByRole("button", { name: "Next" }));
      await clickOption(user, "None");
      await clickOption(user, "Not at all");
      await user.click(screen.getByRole("button", { name: "Next" }));
      await clickOption(user, "No");
      await user.click(await screen.findByRole("button", { name: "Continue" }));
      await clickOption(user, "No"); // hospitalization
      await user.click(screen.getByRole("button", { name: "Next" }));
      await screen.findByRole("heading", { name: ITEMS.gates[1].label });
      await clickOption(user, "Yes");
    }

    it("Add another medication sends conmeds[] and a joined conmed_text; the review lists each", async () => {
      const user = userEvent.setup();
      const mock = installMockFetch(routes());
      renderKiosk();
      await toConmedGate(user);

      await user.type(
        screen.getByLabelText("What is the name of the medication?"),
        "cefalexin antibiotic pill",
      );
      await clickOption(user, "Started");
      await user.click(screen.getByRole("button", { name: "Add another medication" }));
      const second = screen.getByTestId("conmed-row-1");
      await user.type(within(second).getByRole("textbox"), "hydrocortisone cream");
      await user.click(within(second).getByRole("radio", { name: "Stopped" }));
      // A second row can be removed again, and a third added.
      await user.click(screen.getByRole("button", { name: "Add another medication" }));
      expect(screen.getByTestId("conmed-row-2")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Remove medication 3" }));
      expect(screen.queryByTestId("conmed-row-2")).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Next" }));

      await user.click(await screen.findByRole("button", { name: "Review my answers" }));
      const review = await screen.findByTestId("review-screen");
      expect(within(review).getByText("Yes, 2 medications:")).toBeInTheDocument();
      expect(within(review).getByText("cefalexin antibiotic pill (started)")).toBeInTheDocument();
      expect(within(review).getByText("hydrocortisone cream (stopped)")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Send my answers" }));

      await waitFor(() => expect(mock.find("POST", /\/gates$/)).toHaveLength(1));
      const gates = mock.find("POST", /\/gates$/)[0].body as GatesRequest;
      expect(gates.conmeds).toEqual([
        { text: "cefalexin antibiotic pill", direction: "started" },
        { text: "hydrocortisone cream", direction: "stopped" },
      ]);
      expect(gates.conmed_text).toBe("cefalexin antibiotic pill, hydrocortisone cream");
      expect(gates.conmed_direction).toBe("both");
    });

    it("an incomplete second row blocks Next with a prompt", async () => {
      const user = userEvent.setup();
      installMockFetch(routes());
      renderKiosk();
      await toConmedGate(user);
      await user.type(screen.getByLabelText("What is the name of the medication?"), "loratadine");
      await clickOption(user, "Started");
      await user.click(screen.getByRole("button", { name: "Add another medication" }));
      await user.click(screen.getByRole("button", { name: "Next" }));
      expect(await screen.findByText("Please type the name of the medication")).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: ITEMS.gates[1].label })).toBeInTheDocument();
    });
  });

  it("keeps the vitals card in the side column when the camera is on (docs/ISSUES #21)", async () => {
    const user = userEvent.setup();
    installMockFetch(routes());
    renderKiosk("/kiosk?presenter=1");
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
    renderKiosk("/kiosk?presenter=1");

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
    expect(screen.getByRole("alert")).not.toHaveTextContent(/500|HTTP|Server Error/);
    // Next does not move on while an answer is unsaved.
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("heading", { name: ITEMS.items[0].label })).toBeInTheDocument();

    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByRole("heading", { name: ITEMS.items[1].label })).toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("heading", { name: ITEMS.items[0].label })).toBeInTheDocument();

    // Still failing: one retry resends both, Next still does not move on.
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(mock.find("POST", /\/answers$/)).toHaveLength(4));
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("heading", { name: ITEMS.items[0].label })).toBeInTheDocument();

    // API recovers: the retry resends both again and Next moves on only then.
    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByRole("heading", { name: ITEMS.items[1].label })).toBeInTheDocument();
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
      await finish(user);

      await waitFor(() => expect(mock.find("POST", /\/gates$/)).toHaveLength(1));
      const gates = mock.find("POST", /\/gates$/)[0].body as GatesRequest;
      expect(gates).not.toHaveProperty("temp_c");
      expect(gates).toEqual({
        hospitalization: false,
        urgent_now: false,
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
      const box = screen.getByRole("spinbutton");
      await user.type(box, "3850");
      expect(
        screen.getByText("Please enter a temperature between 34 and 43 °C, or leave this empty."),
      ).toBeInTheDocument();
      // Continue stays put while the reading is out of range.
      await user.click(screen.getByRole("button", { name: "Continue" }));
      expect(screen.getByRole("heading", { name: "Fever or chills" })).toBeInTheDocument();
      expect(box).toHaveAttribute("min", "34");
      expect(box).toHaveAttribute("max", "43");

      await user.clear(box);
      await user.type(box, "38.5");
      expect(screen.queryByText(/Please enter a temperature/)).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Continue" }));

      await clickOption(user, "No");
      await user.click(screen.getByRole("button", { name: "Next" }));
      await clickOption(user, "No");
      await user.click(screen.getByRole("button", { name: "Next" }));
      await finish(user);

      await waitFor(() => expect(mock.find("POST", /\/gates$/)).toHaveLength(1));
      const gates = mock.find("POST", /\/gates$/)[0].body as GatesRequest;
      expect(gates.temp_c).toBe(38.5);
    });
  });
});
