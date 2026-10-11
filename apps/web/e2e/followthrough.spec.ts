/**
 * Browser walkthrough "followthrough" (demo steps 7-8 + platform pages):
 * sponsor queries, the visit brief, Audit verify, Eval, Admin, the participant
 * timeline (Synthea baseline labeled simulated), and no console errors.
 *
 * Runs against a stack started separately (no webServer block):
 *   API  : DATABASE_URL=sqlite:///<tmp> SEED_ON_START=true DEMO_PASSWORD=interim-demo
 *          python -m uvicorn interim_api.main:app --port 8023
 *   web  : VITE_API_PROXY_TARGET=http://localhost:8023 npx vite --port 5193 --strictPort
 *   run  : npx playwright test e2e/followthrough.spec.ts --reporter=line --workers=1
 * Override with FOLLOWTHROUGH_WEB_URL. Screenshots land in docs/screenshots/v2/.
 * Needs a freshly seeded database (the seeded open query is answered here).
 */
import { expect, test, type Page } from "@playwright/test";

const WEB = process.env.FOLLOWTHROUGH_WEB_URL ?? "http://localhost:5193";
const PASSWORD = process.env.DEMO_PASSWORD ?? "interim-demo";
const SHOTS = "../../docs/screenshots/v2";
/** The seeded participant whose next visit is tomorrow (seed.NEXT_VISIT_LABEL). */
const BRIEF_PARTICIPANT = "P-003";

// channel "chromium" = Playwright's full Chromium build; set FOLLOWTHROUGH_CHANNEL=chrome or
// msedge to drive an installed browser instead (no Playwright browser download needed).
const CHANNEL = process.env.FOLLOWTHROUGH_CHANNEL ?? "chromium";
test.use({ baseURL: WEB, viewport: { width: 1440, height: 900 }, channel: CHANNEL });
test.describe.configure({ mode: "serial" });

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${SHOTS}/followthrough-${name}.png`, fullPage: true });
}

/** Collects console errors and uncaught page errors for the whole test. */
function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`${page.url()} :: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`${page.url()} :: pageerror ${e.message}`));
  return errors;
}

async function signIn(page: Page, role: "coordinator" | "investigator" | "admin") {
  // Start signed out (the login page redirects a signed-in user to the dashboard).
  await page.goto("/");
  await page.evaluate(() => window.sessionStorage.clear());
  await page.goto("/");
  await page.locator(`[data-role="${role}"]`).click();
  await page.getByLabel("Demo password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/dashboard|\/admin/);
}

// Reset and reseed the demo data first so the spec can be re-run against the same API.
test.beforeAll(async ({ request }) => {
  const login = await request.post(`${WEB}/api/v1/auth/login`, {
    data: { username: "admin", password: PASSWORD },
  });
  expect(login.ok()).toBeTruthy();
  const { token } = (await login.json()) as { token: string };
  const reset = await request.post(`${WEB}/api/v1/admin/reset`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { reseed: true },
  });
  expect(reset.ok(), await reset.text()).toBeTruthy();
});

async function timeSaved(page: Page): Promise<string> {
  const strip = page.getByTestId("time-saved-strip");
  await expect(strip).toBeVisible();
  await expect(strip).toContainText("estimate");
  return (await strip.innerText()).trim();
}

test("7 queries: answer the seeded query with a correction, raise and close as admin", async ({
  page,
}) => {
  const errors = watchConsole(page);
  await signIn(page, "coordinator");
  await page.goto("/dashboard/queries");
  await expect(page.getByRole("heading", { name: "Sponsor queries" })).toBeVisible();
  const before = await timeSaved(page);

  // The seeded open query is listed; open it.
  await expect(page.getByTestId("count-open")).toHaveText("1");
  const openBtn = page.getByRole("button", { name: /^Open query:/ }).first();
  await expect(openBtn).toBeVisible();
  await openBtn.click();
  const panel = page.getByTestId("query-panel");
  await expect(panel).toBeVisible();

  // A suggested answer, written by the template from the record's evidence.
  const suggestion = panel.getByRole("region", { name: "Suggested answer" });
  await expect(suggestion).toBeVisible();
  await expect(suggestion).toContainText(/template/i);
  const answerBox = panel.locator("#query-answer");
  await expect(answerBox).not.toHaveValue("");
  await shot(page, "01-queries-open");

  // Answer with "Also correct the field".
  await panel.getByLabel("Also correct the field").check();
  // The queried field (the missing dose) is the one offered first, not another field.
  await expect(panel.getByLabel("Field to correct")).toHaveValue("CMDOSE");
  await panel.getByLabel("New value").fill("8");
  await panel.getByRole("button", { name: "Answer", exact: true }).click();
  await expect(page.getByText("Answer sent to the sponsor (mock)")).toBeVisible();
  await expect(page.getByText(/The record was also corrected \(Dose\)/)).toBeVisible();
  await expect(panel.getByTestId("current-value")).toContainText("8");
  await expect(panel.getByRole("region", { name: "Answer given" })).toBeVisible();
  await expect(page.getByTestId("count-open")).toHaveText("0");
  await shot(page, "02-queries-answered");

  // Admin, acting as the sponsor's monitor: raise a manual query, close an answered one.
  await signIn(page, "admin");
  await page.goto("/dashboard/queries");
  await page.getByRole("button", { name: "Raise query" }).click();
  const form = page.getByTestId("raise-query");
  await expect(form).toBeVisible();
  const participant = form.getByLabel("Participant", { exact: true });
  await expect(participant.locator("option")).not.toHaveCount(1);
  await participant.selectOption({ label: "P-005" });
  const source = form.getByLabel("Check-in or note");
  await expect(source).toBeEnabled();
  await expect(source.locator("option")).not.toHaveCount(1);
  await source.selectOption({ index: 1 });
  const record = form.getByLabel("Record", { exact: true });
  await expect(record).toBeEnabled();
  await expect(record.locator("option")).not.toHaveCount(1);
  await record.selectOption({ index: 1 });
  await expect(form.getByLabel("Field", { exact: true }).locator("option").first()).not.toHaveText(
    "Pick a record first",
  );
  await form
    .getByLabel("Question for the site")
    .fill("Please confirm the start date against the source document.");
  await shot(page, "03-queries-raise");
  await form.getByRole("button", { name: "Raise query" }).click();
  await expect(form).toHaveCount(0);
  await expect(page.getByTestId("count-open")).toHaveText("1");
  await expect(page.getByTestId("query-panel")).toContainText(
    "Please confirm the start date against the source document.",
  );

  await page.getByRole("tab", { name: /Answered/ }).click();
  const answered = page.getByRole("button", { name: /^Open query:/ });
  await expect(answered.first()).toBeVisible();
  const nAnswered = Number(await page.getByTestId("count-answered").innerText());
  await answered.first().click();
  await page.getByRole("button", { name: "Close query (as sponsor)" }).click();
  await expect(page.getByText("Query closed")).toBeVisible();
  await expect(page.getByTestId("count-answered")).toHaveText(String(nAnswered - 1));
  await shot(page, "04-queries-closed");

  // The time-saved strip moved (re-read after a reload; it refreshes every 5 minutes).
  await page.reload();
  await expect.poll(() => timeSaved(page)).not.toBe(before);

  expect(errors, errors.join("\n")).toEqual([]);
});

test("8 visit brief for the participant seen tomorrow", async ({ page }) => {
  const errors = watchConsole(page);
  await signIn(page, "coordinator");
  await page.goto("/dashboard");
  const briefLink = page.getByRole("link", { name: `Visit brief for ${BRIEF_PARTICIPANT}` });
  await expect(briefLink.first()).toBeVisible();
  await briefLink.first().click();
  await page.waitForURL(/\/brief/);

  await expect(page.locator("h1")).toContainText(BRIEF_PARTICIPANT);
  await expect(page.getByText(/next visit/i).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "New side effects" })).toBeVisible();
  await expect(page.getByText("Questions to ask at the visit")).toBeVisible();
  // Regression: a row with many chips (24-hour clock + due + status + report link)
  // squeezed its sentence into a one-word-wide column. Every sentence keeps real width.
  await expect(page.locator("section li span.leading-6")).not.toHaveCount(0);
  const narrowest = await page
    .locator("section li span.leading-6")
    .evaluateAll((els) => Math.min(...els.map((e) => e.getBoundingClientRect().width)));
  expect(narrowest).toBeGreaterThan(200);
  // Synthetic background chart, labeled simulated.
  await expect(page.getByText(/Synthea synthetic EHR \(simulated\)/).first()).toBeVisible();

  // Evidence links: a chip highlights the lines citing it and links to the source record.
  const chip = page.getByRole("button", { name: /^Evidence:/ }).first();
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(page.getByText(/Highlighting \d+ line/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Open the source record" })).toBeVisible();
  await shot(page, "05-brief");

  // Printable version opens as a self-contained page.
  const [popup] = await Promise.all([
    page.waitForEvent("popup"),
    page.getByRole("button", { name: "Open printable version" }).click(),
  ]);
  await popup.waitForLoadState();
  await expect(popup.locator("body")).toContainText(BRIEF_PARTICIPANT);
  await expect(popup.locator("body")).toContainText(/not a medical device/i);
  await popup.screenshot({ path: `${SHOTS}/followthrough-06-brief-print.png`, fullPage: true });
  await popup.close();

  // The source-record link navigates inside the dashboard.
  await page.getByRole("link", { name: "Open the source record" }).click();
  await expect(page).toHaveURL(/\/dashboard\/(checkins|notes|participants|packets)\//);

  expect(errors, errors.join("\n")).toEqual([]);
});

test("platform: audit verify, eval 100%, admin, timeline with simulated baseline", async ({
  page,
}) => {
  const errors = watchConsole(page);
  await signIn(page, "admin");

  // Audit: verify the chain.
  await page.goto("/dashboard/audit");
  await page.getByRole("button", { name: "Verify chain" }).click();
  const verify = page.getByTestId("verify-result");
  await expect(verify).toBeVisible();
  await expect(verify).toContainText(/verified/i);
  await expect(verify).not.toContainText(/broken/i);
  await shot(page, "07-audit-verified");

  // Eval: shipped personas all pass.
  await page.goto("/dashboard/eval");
  await expect(page.getByTestId("persona-list")).toBeVisible();
  await page.getByRole("button", { name: /^Run the shipped personas/ }).click();
  await expect(page.getByText(/Run complete: (\d+) of \1 passed\./)).toBeVisible({
    timeout: 120_000,
  });
  const results = page.getByTestId("eval-results");
  await expect(results).toBeVisible();
  await expect(results).toContainText("100%");
  await shot(page, "08-eval");

  // Admin page loads.
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Admin", exact: true })).toBeVisible();
  await expect(page.getByText(/Admin only \(403\)/)).toHaveCount(0);
  await shot(page, "09-admin");

  // Participant timeline with the Synthea baseline labeled simulated.
  await page.goto(`/dashboard/participants/${BRIEF_PARTICIPANT}`);
  await expect(page.getByTestId("sessions")).toBeVisible();
  const baseline = page.getByTestId("synthea-baseline");
  await expect(baseline).toBeVisible();
  await expect(baseline).toContainText(/simulated/i);
  await expect(baseline).toContainText(/83/);
  await shot(page, "10-timeline");

  // Remaining dashboard pages render without console errors.
  for (const path of ["/dashboard", "/dashboard/escalations", "/dashboard/notes"]) {
    await page.goto(path);
    await expect(page.locator("main h1").first()).toBeVisible();
  }

  expect(errors, errors.join("\n")).toEqual([]);
});
