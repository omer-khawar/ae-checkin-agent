/**
 * Landing page: every section renders, the footer sentence is verbatim, every
 * number has a source link, and the entry points go to /kiosk and /login.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { DISCLAIMER, FAQ, PROBLEM, PROOF, STEPS } from "../content";
import { LandingPage } from "../LandingPage";

function renderLanding() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <LandingPage />
    </MemoryRouter>,
  );
}

describe("LandingPage", () => {
  it("renders on the console surface with every section heading", () => {
    const { container } = renderLanding();
    expect(container.querySelector('[data-surface="console"]')).not.toBeNull();

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Side effects between visits often reach the trial record late.",
      }),
    ).toBeInTheDocument();
    for (const name of [
      PROBLEM.title,
      "The life of one side effect, and the screen that handles each step",
      "Rules decide, templates write, people confirm.",
      "What we tested, and what it gets wrong",
      "Questions people ask first",
    ]) {
      expect(screen.getByRole("heading", { level: 2, name })).toBeInTheDocument();
    }
  });

  it("quotes the not-a-medical-device sentence verbatim in the footer", () => {
    renderLanding();
    expect(DISCLAIMER).toBe(
      "Interim is a research data-capture tool. It is not a medical device and does not provide medical advice.",
    );
    const footer = screen.getByRole("contentinfo");
    expect(within(footer).getByText(DISCLAIMER)).toBeInTheDocument();
    expect(within(footer).getByText(/Original AE Capture Desk by Omer Khawar/)).toBeInTheDocument();
    expect(within(footer).getByRole("link", { name: /MIT license/ })).toHaveAttribute(
      "href",
      expect.stringContaining("/LICENSE"),
    );
  });

  it("links the header and hero calls to action to /kiosk and /login", () => {
    renderLanding();
    const header = screen.getByRole("banner");
    expect(within(header).getByRole("link", { name: "Staff sign in" })).toHaveAttribute(
      "href",
      "/login",
    );
    expect(within(header).getByRole("link", { name: "Try the patient kiosk" })).toHaveAttribute(
      "href",
      "/kiosk",
    );
    expect(within(header).getByRole("link", { name: /GitHub/ })).toHaveAttribute(
      "href",
      "https://github.com/omer-khawar/ae-checkin-agent",
    );
    for (const label of ["How it works", "What you get", "FAQ"]) {
      expect(within(header).getByRole("link", { name: label })).toHaveAttribute(
        "href",
        expect.stringMatching(/^#/),
      );
    }

    const main = screen.getByRole("main");
    expect(within(main).getByRole("link", { name: /Open the coordinator desk/ })).toHaveAttribute(
      "href",
      "/login",
    );
    expect(within(main).getAllByRole("link", { name: "Try the patient kiosk" })[0]).toHaveAttribute(
      "href",
      "/kiosk",
    );
  });

  it("shows the real screenshot with alt text and the synthetic-data caption", () => {
    renderLanding();
    const img = screen.getByRole("img", { name: /coordinator's queue/i });
    expect(img).toHaveAttribute("src", "/landing/hero-queue.png");
    expect(screen.getByText("Synthetic participants. Screens from the current build.")).toBeInTheDocument();
  });

  it("gives every problem number an external source link", () => {
    renderLanding();
    for (const stat of PROBLEM.stats) {
      expect(screen.getByText(stat.value)).toBeInTheDocument();
      const link = screen.getByRole("link", { name: new RegExp(escapeRe(stat.source.text)) });
      expect(link).toHaveAttribute("href", stat.source.href);
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    }
  });

  it("lists the eight steps in order, each naming its screen", () => {
    renderLanding();
    expect(STEPS).toHaveLength(8);
    const list = screen.getAllByRole("list").find((l) => l.tagName === "OL");
    expect(list).toBeDefined();
    const items = within(list as HTMLElement).getAllByRole("listitem");
    expect(items).toHaveLength(8);
    items.forEach((li, i) => {
      expect(within(li).getByRole("heading", { level: 3 })).toHaveTextContent(
        `Step ${i + 1}: ${STEPS[i].title}`,
      );
      expect(within(li).getByText(STEPS[i].screen)).toBeInTheDocument();
    });
  });

  it("links every proof statement and 'what it gets wrong' to the docs on GitHub", () => {
    renderLanding();
    for (const p of PROOF) {
      expect(screen.getByRole("heading", { level: 3, name: p.headline })).toBeInTheDocument();
      expect(p.link.href).toMatch(/^https:\/\/github\.com\/omer-khawar\/ae-checkin-agent\/blob\/interim\//);
    }
    expect(screen.getByRole("link", { name: /What it gets wrong/ })).toHaveAttribute(
      "href",
      "https://github.com/omer-khawar/ae-checkin-agent/blob/interim/docs/WHAT_IT_GETS_WRONG.md",
    );
    // Simulated data is called simulated.
    expect(screen.getAllByText(/simulated/i).length).toBeGreaterThan(0);
  });

  it("opens and closes FAQ answers with the keyboard-accessible disclosure buttons", async () => {
    const user = userEvent.setup();
    renderLanding();
    const first = screen.getByRole("button", { name: FAQ[0].q });
    expect(first).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("region", { name: FAQ[0].q })).toHaveTextContent(DISCLAIMER);

    const camera = screen.getByRole("button", { name: "Does the camera store video?" });
    expect(camera).toHaveAttribute("aria-expanded", "false");
    const panel = document.getElementById(camera.getAttribute("aria-controls") ?? "");
    expect(panel).not.toBeVisible();
    // jsdom has no Tailwind: a `flex` class on the panel would beat the `hidden`
    // attribute in a real browser (every answer showed). Closed panels carry `hidden`.
    expect(panel).toHaveClass("hidden");
    expect(panel).not.toHaveClass("flex");

    await user.click(camera);
    expect(camera).toHaveAttribute("aria-expanded", "true");
    expect(panel).toBeVisible();
    expect(panel).toHaveClass("flex");
    expect(panel).toHaveTextContent(/SIMULATED/);

    await user.click(first);
    expect(first).toHaveAttribute("aria-expanded", "false");
  });
});

/** Escape a string for use inside a RegExp. */
function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
