/**
 * Kiosk UI phase 2: presenter-only numbers card, quiet camera line, "Need help?",
 * the review screen with Edit, and the idle timeout.
 */
import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { KioskFlow } from "../pages/kiosk/KioskFlow";
import { IdlePrompt } from "../pages/kiosk/IdlePrompt";
import { HELP_TEXT } from "../pages/kiosk/KioskShell";
import { useIdleTimeout } from "../pages/kiosk/useIdleTimeout";
import { DISCLAIMER_TEXT } from "../components/Disclaimer";
import { completeResponse, ITEMS, SESSION_ID, session, STUDY } from "./fixtures";
import { installMockFetch, type Route } from "./mockFetch";

const routes: Route[] = [
  { method: "GET", path: "/api/v1/study", handler: () => ({ json: STUDY }) },
  { method: "GET", path: "/api/v1/items", handler: () => ({ json: ITEMS }) },
  {
    method: "POST",
    path: "/api/v1/sessions",
    handler: ({ body }) => ({
      json: session({ usubjid: (body as { usubjid: string }).usubjid }),
    }),
  },
  {
    method: "POST",
    path: new RegExp(`^/api/v1/sessions/${SESSION_ID}/answers$`),
    handler: ({ body }) => {
      const b = body as { item_id: string; attribute: string; value: number; ts_client: string };
      return {
        json: {
          id: "01JANSWER00000000000000000",
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
    handler: () => ({ json: completeResponse() }),
  },
];

function renderKiosk(path = "/kiosk") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <KioskFlow />
    </MemoryRouter>,
  );
}

async function begin(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText("Your study ID"), "P-007");
  await user.click(screen.getByRole("button", { name: "Start check-in" }));
  await screen.findByRole("heading", { name: ITEMS.items[0].label });
}

async function pick(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole("radio", { name }));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("kiosk phase 2", () => {
  it("hides the numbers card without ?presenter=1 but keeps a quiet camera line", async () => {
    const user = userEvent.setup();
    installMockFetch(routes);
    renderKiosk();
    await begin(user);
    expect(screen.queryByTestId("vitals-panel")).not.toBeInTheDocument();
    expect(screen.queryByTestId("kiosk-side")).not.toBeInTheDocument();
    expect(screen.getByTestId("kiosk-camera-status")).toHaveTextContent("Camera on · simulated");
    // The footer sentence rides in the action bar, exactly once.
    expect(screen.getAllByText(DISCLAIMER_TEXT)).toHaveLength(1);
  });

  it("shows presenter numbers with ?presenter=1", async () => {
    const user = userEvent.setup();
    installMockFetch(routes);
    renderKiosk("/kiosk?presenter=1");
    await begin(user);
    expect(await screen.findByTestId("vitals-panel")).toBeInTheDocument();
  });

  it("says Camera off when the participant opts out", async () => {
    const user = userEvent.setup();
    installMockFetch(routes);
    renderKiosk();
    await user.click(await screen.findByRole("checkbox", { name: /rather not use the camera/ }));
    await begin(user);
    expect(screen.getByTestId("kiosk-camera-status")).toHaveTextContent("Camera off");
  });

  it("Need help? shows a calm message to ask the staff member", async () => {
    const user = userEvent.setup();
    installMockFetch(routes);
    renderKiosk();
    await screen.findByLabelText("Your study ID");
    await user.click(screen.getByRole("button", { name: "Need help?" }));
    expect(screen.getByText(HELP_TEXT)).toBeInTheDocument();
    expect(HELP_TEXT).toMatch(/ask the study team/i);
  });

  it("Edit on the review screen jumps to that question and Next returns to the review", async () => {
    const user = userEvent.setup();
    installMockFetch(routes);
    renderKiosk();
    await begin(user);

    await pick(user, "Mild");
    await pick(user, "A little bit");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByRole("heading", { name: ITEMS.items[1].label });
    await pick(user, "None");
    await pick(user, "Not at all");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByRole("heading", { name: ITEMS.items[2].label });
    await pick(user, "No");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await pick(user, "No");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await pick(user, "No");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Review my answers" }));

    const review = await screen.findByTestId("review-screen");
    expect(within(review).getByText("Mild · A little bit")).toBeInTheDocument();

    await user.click(within(review).getByRole("button", { name: `Edit: ${ITEMS.items[0].label}` }));
    expect(await screen.findByRole("heading", { name: ITEMS.items[0].label })).toBeInTheDocument();
    await pick(user, "Severe");
    await user.click(screen.getByRole("button", { name: "Back to my answers" }));

    const again = await screen.findByTestId("review-screen");
    await waitFor(() => expect(within(again).getByText(/^Severe · /)).toBeInTheDocument());
  });
});

describe("idle timeout", () => {
  it("warns after 60 s of silence, resets after 30 s more, and input restarts the clock", () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const { result } = renderHook(() => useIdleTimeout({ enabled: true, onTimeout }));

    act(() => {
      vi.advanceTimersByTime(30_000);
      window.dispatchEvent(new Event("pointerdown"));
      vi.advanceTimersByTime(59_000);
    });
    expect(result.current.warning).toBe(false);

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(result.current.warning).toBe(true);
    expect(result.current.secondsLeft).toBeLessThanOrEqual(30);

    // "I'm still here" clears the warning.
    act(() => result.current.dismiss());
    expect(result.current.warning).toBe(false);

    act(() => {
      vi.advanceTimersByTime(60_000 + 31_000);
    });
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("does nothing while disabled", () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const { result } = renderHook(() => useIdleTimeout({ enabled: false, onTimeout }));
    act(() => {
      vi.advanceTimersByTime(200_000);
    });
    expect(result.current.warning).toBe(false);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("the prompt asks Are you still there? and offers one button", async () => {
    const onStay = vi.fn();
    render(<IdlePrompt secondsLeft={12} onStay={onStay} />);
    expect(screen.getByRole("alertdialog", { name: "Are you still there?" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "I'm still here" }));
    expect(onStay).toHaveBeenCalled();
  });
});
