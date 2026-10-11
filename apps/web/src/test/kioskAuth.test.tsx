/**
 * R5.6 read-aloud toggle placement and the 401 -> signed-out fix (lib/api.ts send()).
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";

import { RequireRole } from "../components/RequireRole";
import { AUTH_STORAGE_KEY, getQueue } from "../lib/api";
import { getAuth, resetAuthCache } from "../lib/auth";
import { KioskFlow } from "../pages/kiosk/KioskFlow";
import { Login } from "../pages/Login";
import { ITEMS, STUDY } from "./fixtures";
import { installMockFetch } from "./mockFetch";

const SESSION = {
  token: "tok-123",
  role: "coordinator",
  username: "coordinator",
  expires_at: new Date(Date.now() + 3_600_000).toISOString(),
};

afterEach(() => {
  resetAuthCache();
});

describe("read aloud toggle", () => {
  it("sits next to Larger text in the kiosk header and toggles on and off", async () => {
    const user = userEvent.setup();
    installMockFetch([
      { method: "GET", path: "/api/v1/study", handler: () => ({ json: STUDY }) },
      { method: "GET", path: "/api/v1/items", handler: () => ({ json: ITEMS }) },
    ]);
    render(
      <MemoryRouter initialEntries={["/kiosk"]}>
        <KioskFlow />
      </MemoryRouter>,
    );
    await screen.findByLabelText("Your study ID");
    const larger = screen.getByRole("button", { name: "Larger text" });
    const read = screen.getByRole("button", { name: "Read aloud" });
    expect(larger.parentElement).toBe(read.parentElement);
    expect(read).toHaveAttribute("aria-pressed", "false");
    await user.click(read);
    expect(read).toHaveAttribute("aria-pressed", "true");
  });
});

describe("HTTP 401 on a request that carried a token", () => {
  function tree() {
    return (
      <MemoryRouter initialEntries={["/dashboard"]}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            path="/dashboard"
            element={
              <RequireRole>
                <p>dashboard home</p>
              </RequireRole>
            }
          />
        </Routes>
      </MemoryRouter>
    );
  }

  it("clears the stored session and routes to /login with the expiry message", async () => {
    sessionStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(SESSION));
    resetAuthCache();
    installMockFetch([
      {
        method: "GET",
        path: "/api/v1/queue",
        handler: () => ({
          status: 401,
          json: { type: "about:blank", title: "Unauthorized", status: 401 },
        }),
      },
    ]);
    render(tree());
    expect(await screen.findByText("dashboard home")).toBeInTheDocument();
    expect(getAuth()).not.toBeNull();

    await getQueue().catch(() => undefined);

    await waitFor(() => expect(getAuth()).toBeNull());
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    expect(await screen.findByText("Your session expired. Please sign in again.")).toBeVisible();
    expect(screen.queryByText("dashboard home")).not.toBeInTheDocument();
  });

  it("does not sign out when no token was sent (a plain 401 from login keeps the form)", async () => {
    installMockFetch([
      {
        method: "GET",
        path: "/api/v1/queue",
        handler: () => ({
          status: 401,
          json: { type: "about:blank", title: "Unauthorized", status: 401 },
        }),
      },
    ]);
    render(tree());
    await getQueue().catch(() => undefined);
    expect(screen.queryByText(/session expired/i)).not.toBeInTheDocument();
  });
});
