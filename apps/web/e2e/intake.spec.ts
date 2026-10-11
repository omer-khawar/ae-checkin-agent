/**
 * Browser walkthrough "intake" (demo steps 1-4): patient check-in at the kiosk,
 * coordinator logs a call, dashboard first view, check-in detail.
 *
 * Runs against a stack started separately (no webServer block):
 *   API  : DATABASE_URL=sqlite:///<tmp> SEED_ON_START=true DEMO_PASSWORD=interim-demo
 *          python -m uvicorn interim_api.main:app --port 8021
 *   web  : VITE_API_PROXY_TARGET=http://localhost:8021 npx vite --port 5191 --strictPort
 *   run  : npx playwright test e2e/intake.spec.ts --reporter=line --workers=1
 * Override with INTAKE_WEB_URL. Screenshots land in docs/screenshots/v2/.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";

const WEB = process.env.INTAKE_WEB_URL ?? "http://localhost:5191";
const PASSWORD = process.env.DEMO_PASSWORD ?? "interim-demo";
const SHOTS = "../../docs/screenshots/v2";

// PW_CHANNEL=chrome (or msedge) runs on an installed browser when the Playwright build is missing.
test.use({
  baseURL: WEB,
  viewport: { width: 1440, height: 900 },
  channel: process.env.PW_CHANNEL || undefined,
});
test.describe.configure({ mode: "serial" });

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${SHOTS}/intake-${name}.png`, fullPage: true });
}

async function signIn(page: Page, role: "coordinator" | "investigator" | "admin") {
  await page.goto("/login");
  await page.locator(`[data-role="${role}"]`).click();
  await page.getByLabel("Demo password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/dashboard|\/admin/);
}

/**
 * Kiosk answers are visually-hidden native radios inside a 64px <label> row (src/ui/kiosk/
 * answer-group.tsx); the row is the tap target, so click the row like a participant would.
 */
async function choose(radio: Locator) {
  const row = radio.locator("xpath=ancestor::label[1]");
  if (await row.count()) await row.click();
  else await radio.click();
  await expect(radio).toBeChecked();
}

/** Clinical words the participant must never see on the kiosk. */
const CLINICAL =
  /\b(grade|tier|CTCAE|adverse event|AESI|special interest|SAE|escalat|toxicity|provisional)\b/i;

test("1-2 kiosk check-in as P-007 (diarrhea almost constantly, prednisone started)", async ({
  page,
}) => {
  await page.goto("/kiosk");
  await expect(page.getByRole("heading", { name: "Welcome" })).toBeVisible();
  // No consent screen: the camera opt-out is a toggle on Welcome.
  await expect(page.getByText(/consent/i)).toHaveCount(0);
  const optOut = page.getByLabel("I'd rather not use the camera");
  await expect(optOut).toBeVisible();
  await expect(optOut).not.toBeChecked();
  await optOut.check();
  await expect(page.getByText("The camera will stay off.")).toBeVisible();
  await page.getByLabel("Your study ID").fill("P-007");
  await shot(page, "01-kiosk-welcome");
  await page.getByRole("button", { name: "Start check-in" }).click();

  // Ten symptom screens: everything "none" except diarrhea "Almost constantly".
  for (let i = 0; i < 10; i++) {
    await expect(page.getByText(new RegExp(`Question ${i + 1} of 13`))).toBeVisible();
    const heading = (await page.locator("h1").first().innerText()).trim();
    const groups = page.locator("fieldset");
    const n = await groups.count();
    for (let g = 0; g < n; g++) {
      const grp = groups.nth(g);
      const pick = /diarrhea/i.test(heading)
        ? "Almost constantly"
        : (await grp.getByRole("radio", { name: "None", exact: true }).count())
          ? "None"
          : (await grp.getByRole("radio", { name: "Never", exact: true }).count())
            ? "Never"
            : (await grp.getByRole("radio", { name: "Not at all", exact: true }).count())
              ? "Not at all"
              : "No";
      await choose(grp.getByRole("radio", { name: pick, exact: true }));
    }
    if (/diarrhea/i.test(heading)) await shot(page, "01-kiosk-diarrhea");
    const next = page.getByRole("button", { name: /^(Next|Continue)$/ });
    await expect(next).toBeEnabled();
    await next.click();
  }

  // Gates: no hospitalization; con-med prednisone started; nothing else.
  await expect(page.getByText(/Question 11 of 13/)).toBeVisible();
  await choose(page.getByTestId("yesno-hospitalization").getByRole("radio", { name: "No" }));
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await choose(page.getByTestId("yesno-conmed").getByRole("radio", { name: "Yes" }));
  await page.locator("#conmed-text").fill("prednisone");
  await choose(page.getByRole("radio", { name: "Started", exact: true }));
  await shot(page, "01-kiosk-conmed");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("button", { name: "Review my answers" }).click();
  await expect(page.getByRole("heading", { name: "Check your answers" })).toBeVisible();
  await shot(page, "01-kiosk-review");
  await page.getByRole("button", { name: "Send my answers" }).click();

  await expect(page.getByRole("heading", { name: /Thank you/ })).toBeVisible({ timeout: 30_000 });
  const body = await page.locator("main, body").first().innerText();
  expect(body).not.toMatch(CLINICAL);
  await shot(page, "02-kiosk-thankyou");
});

test("2 coordinator logs a call for another participant", async ({ page }) => {
  await signIn(page, "coordinator");
  await page.goto("/dashboard/notes");
  // The call form is a side sheet now.
  await page.getByRole("button", { name: "Log a call" }).click();
  const form = page.getByRole("form", { name: "Log a call" });
  await expect(form).toBeVisible();
  const sel = form.locator("select").first();
  await expect(sel.locator("option", { hasText: "P-003" })).toHaveCount(1);
  await sel.selectOption({ label: "P-003" });
  await form.getByLabel("Who was on the call").selectOption({ label: "Caregiver" });
  // A unique tail keeps re-runs against the same database from hitting the 409 duplicate guard.
  await form
    .getByLabel("Call summary")
    .fill(
      `Daughter called: father has had a new itchy rash on both arms since Saturday, started cetirizine. Ref ${Date.now()}.`,
    );
  await form.getByRole("button", { name: "Log call" }).click();
  await expect(page.getByTestId("call-logged")).toBeVisible();
  await shot(page, "02-notes-log-call");
});

test("3 dashboard: time saved, since-last-here, queue chips", async ({ page }) => {
  await signIn(page, "coordinator");
  await page.goto("/dashboard");
  const strip = page.getByTestId("time-saved-strip");
  await expect(strip).toBeVisible();
  await expect(strip).toContainText(/\d/);
  await expect(strip).toContainText(/estimate/i);
  const since = page.getByTestId("since-last-here");
  await expect(since).toBeVisible();
  await expect(since).toContainText(/check-in/i);

  const rows = page.locator("tbody tr");
  await expect(rows.first()).toBeVisible();
  // The new P-007 check-in with a special-interest (AESI) chip.
  const p007 = rows.filter({ hasText: "P-007" }).filter({ hasText: /AESI|special-interest/i });
  await expect(p007.first()).toBeVisible();
  // Seeded overnight items: ER-note SAE chip, urgent-care follow-up, caregiver call.
  await expect(
    rows
      .filter({ hasText: /Emergency department note/ })
      .filter({ hasText: /Serious event/ })
      .first(),
  ).toBeVisible();
  // Urgent-care visit (an outside record) that follows up an already-open AE.
  await expect(
    rows
      .filter({ hasText: /Outside record/ })
      .filter({ has: page.getByTestId("followup-chip") })
      .first(),
  ).toBeVisible();
  // Caregiver phone call.
  await expect(
    rows
      .filter({ hasText: /Phone call/ })
      .filter({ hasText: /Caregiver/ })
      .first(),
  ).toBeVisible();
  // At 1440 px the page never scrolls sideways and the queue's "Open" column is on screen.
  const widths = await page.evaluate(() => {
    const t = document.querySelector("table");
    return {
      doc: document.documentElement.scrollWidth,
      view: window.innerWidth,
      table: t?.scrollWidth ?? 0,
      wrap: t?.parentElement?.clientWidth ?? 0,
    };
  });
  expect(widths.doc).toBeLessThanOrEqual(widths.view);
  expect(widths.table).toBeLessThanOrEqual(widths.wrap + 1);
  // Report-clock chips stay inside their column (they wrap instead of running into "Alert").
  const chipOverflow = await page.evaluate(
    () =>
      [...document.querySelectorAll("tbody td [data-clock-kind]")].filter((chip) => {
        const td = chip.closest("td")!;
        return chip.getBoundingClientRect().right > td.getBoundingClientRect().right + 1;
      }).length,
  );
  expect(chipOverflow).toBe(0);
  await shot(page, "03-dashboard-queue");

  // Worklist density: at 1366x768 at least min(10, rows) queue rows sit above the fold.
  await page.setViewportSize({ width: 1366, height: 768 });
  const fold = await page.evaluate(() => {
    const all = [...document.querySelectorAll("tbody tr")];
    const above = all.filter((r) => r.getBoundingClientRect().bottom <= window.innerHeight);
    return { total: all.length, above: above.length };
  });
  expect(fold.above).toBeGreaterThanOrEqual(Math.min(10, fold.total));
});

test("4 check-in detail: plain labels, evidence, protocol chips, confirm", async ({ page }) => {
  await signIn(page, "coordinator");
  await page.goto("/dashboard");
  const row = page
    .locator("tbody tr")
    .filter({ hasText: "P-007" })
    .filter({ hasText: /AESI|special-interest/i })
    .first();
  await row.getByRole("link", { name: /^Open check-in for/ }).click();
  await page.waitForURL(/\/dashboard\/checkins\//);

  // AE draft: plain label first, SDTM name as a badge underneath.
  const gradeBtn = page.getByRole("button", { name: /\(AETOXGR\): show evidence/ }).first();
  await expect(gradeBtn).toBeVisible();
  const gradeLabel = (await gradeBtn.innerText())
    .split("\n")
    .map((t) => t.trim())
    .filter(Boolean);
  expect(gradeLabel[0]).not.toBe("AETOXGR");
  expect(gradeLabel[0]).toMatch(/grade/i);
  expect(gradeLabel[1]).toMatch(/^AETOXGR/);
  await expect(page.getByTestId("aesi-banner").first()).toBeVisible();

  // Clicking a field highlights its evidence (the diarrhea answer).
  await gradeBtn.click();
  await expect(page.getByTestId("evidence-panel").first()).toBeVisible();
  await expect(page.locator('[data-answer-id][data-highlighted="true"]').first()).toBeVisible();
  await shot(page, "04-detail-evidence");

  // CM draft: discouraged steroid with exception text; missing fields listed.
  const cm = page.getByTestId("cm-protocol").first();
  await expect(cm).toBeVisible();
  await expect(cm.getByTestId("protocol-chip")).toContainText(/discouraged/i);
  await expect(cm).toContainText(/exception/i);
  await expect(page.getByTestId("cm-missing").first()).toBeVisible();

  // Close the evidence sheet (Esc), then confirm the AE draft.
  await page.keyboard.press("Escape");
  // One click confirms and moves focus to the next draft (no note form).
  await page.getByRole("button", { name: "Confirm", exact: true }).first().click();
  await expect(page.getByText("Confirmed", { exact: true }).first()).toBeVisible();
  await shot(page, "04-detail-confirmed");
});
