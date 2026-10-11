/** Login: glass card, role radiogroup, home and kiosk links, successful sign-in redirect. */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetAuthCache } from "../../lib/auth";
import { installMockFetch } from "../../test/mockFetch";
import { Login } from "../Login";

function mount() {
  return render(
    <MemoryRouter initialEntries={["/login"]}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/dashboard" element={<div>dashboard-home</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  resetAuthCache();
});
afterEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  resetAuthCache();
});

describe("Login", () => {
  it("offers home and kiosk links and the footer sentence", () => {
    mount();
    expect(screen.getByRole("link", { name: /Back to home/ })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "Try the patient kiosk" })).toHaveAttribute(
      "href",
      "/kiosk",
    );
    expect(
      screen.getByText(
        "Interim is a research data-capture tool. It is not a medical device and does not provide medical advice.",
      ),
    ).toBeInTheDocument();
  });

  it("picks a role in the radiogroup and keeps Sign in disabled without a password", async () => {
    const user = userEvent.setup();
    mount();
    const group = screen.getByRole("radiogroup", { name: "Role" });
    expect(group.querySelector('[data-role="coordinator"]')).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await user.click(group.querySelector('[data-role="investigator"]') as HTMLElement);
    expect(group.querySelector('[data-role="investigator"]')).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled();
  });

  it("signs in with the chosen role and leaves for the dashboard", async () => {
    const user = userEvent.setup();
    const api = installMockFetch([
      {
        method: "POST",
        path: /\/auth\/login$/,
        handler: () => ({
          json: {
            token: "t",
            role: "investigator",
            username: "investigator",
            expires_at: "2099-01-01T00:00:00Z",
          },
        }),
      },
    ]);
    mount();
    await user.click(
      screen
        .getByRole("radiogroup", { name: "Role" })
        .querySelector('[data-role="investigator"]') as HTMLElement,
    );
    await user.type(screen.getByLabelText("Demo password"), "interim-demo");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(screen.getByText("dashboard-home")).toBeInTheDocument());
    expect(api.find("POST", /\/auth\/login$/)[0]?.body).toMatchObject({
      username: "investigator",
      password: "interim-demo",
    });
  });
});
