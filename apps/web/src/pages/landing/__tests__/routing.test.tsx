/**
 * Routing after the landing page took "/": the landing renders at "/", the
 * staff sign-in lives at "/login", and the route guard sends signed-out people
 * to "/login" (not to the landing page).
 */
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { AppRoutes } from "../../../App";

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  );
}

describe("routes", () => {
  it("serves the landing page at /", () => {
    renderAt("/");
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Side effects between visits often reach the trial record late.",
      }),
    ).toBeInTheDocument();
  });

  it("serves the staff sign-in at /login", () => {
    renderAt("/login");
    expect(
      screen.getByRole("heading", { name: "Sign in to the safety-data desk" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
  });

  it("redirects a signed-out visitor from the dashboard to /login", () => {
    renderAt("/dashboard");
    expect(
      screen.getByRole("heading", { name: "Sign in to the safety-data desk" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { level: 1, name: /Side effects between visits/ }),
    ).toBeNull();
  });

  it("redirects a signed-out visitor from /admin to /login", () => {
    renderAt("/admin");
    expect(
      screen.getByRole("heading", { name: "Sign in to the safety-data desk" }),
    ).toBeInTheDocument();
  });
});
