/**
 * Browser walkthrough for steps 5-6 of the coordinator's safety-data desk
 * (CLAUDE.md §00): the 24-hour report packet and the investigator's decisions.
 *
 * Stack (started separately, see playwright.config.ts):
 *   API  http://localhost:8022  (SEED_ON_START=true, DEMO_PASSWORD=interim-demo)
 *   web  http://localhost:5192  (VITE_API_PROXY_TARGET=http://localhost:8022)
 * Override with E2E_WEB / E2E_API.
 *
 * Step 5: from the seeded ER-note SAE clock and from the seeded G3-diarrhea
 *   AESI clock, open the report packet; check fields carry evidence, the
 *   "information still needed" list, narrative sentences each with evidence
 *   chips and "Written by template"; edit and save a field; sign as the
 *   investigator; the clock stops; start a follow-up and see "changes since the
 *   previous report"; the print view carries the footer sentence verbatim.
 * Step 6: investigator attribution (AESER / AEREL / Immune-related) on a
 *   check-in, and a seriousness decision on the Escalations page for an SAE
 *   clock that has no AE draft (hospital visit reported, no symptoms).
 */
import { existsSync } from "node:fs";

import {
  chromium,
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type Page,
} from "@playwright/test";

// When Playwright's own Chromium is not installed (or an install is still in
// progress on this machine), fall back to the system Edge so the walkthrough
// still runs. E2E_CHANNEL forces a channel.
const channel =
  process.env.E2E_CHANNEL || (existsSync(chromium.executablePath()) ? undefined : "msedge");
if (channel) test.use({ channel });

const WEB = process.env.E2E_WEB ?? "http://localhost:5192";
const API = (process.env.E2E_API ?? "http://localhost:8022") + "/api/v1";
const PASSWORD = process.env.E2E_PASSWORD ?? "interim-demo";
const SHOTS = "../../docs/screenshots/v2";
const LAST_DOSE = "2026-10-01";
const FOOTER =
  "Interim is a research data-capture tool. It is not a medical device and does not provide medical advice.";

type Role = "coordinator" | "investigator" | "admin";

interface ClockRow {
  id: string;
  kind: "sae" | "aesi";
  usubjid: string;
  session_id: string | null;
  note_id: string | null;
  stopped_at: string | null;
  decision: string | null;
  packet_id: string | null;
  has_ae_draft?: boolean;
}

async function token(request: APIRequestContext, role: Role): Promise<string> {
  const r = await request.post(`${API}/auth/login`, {
    data: { username: role, password: PASSWORD },
  });
  expect(r.ok()).toBeTruthy();
  const body = (await r.json()) as { token?: string; access_token?: string };
  return (body.token ?? body.access_token) as string;
}

async function clocks(request: APIRequestContext, active = "all"): Promise<ClockRow[]> {
  const t = await token(request, "coordinator");
  const r = await request.get(`${API}/sae-clocks?active=${active}&limit=200`, {
    headers: { authorization: `Bearer ${t}` },
  });
  expect(r.ok()).toBeTruthy();
  return ((await r.json()) as { items: ClockRow[] }).items;
}

async function login(browser: Browser, role: Role): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${WEB}/`);
  await page.locator(`button[data-role="${role}"]`).click();
  await page.locator("#password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/dashboard/);
  return page;
}

/**
 * Navigate and wait for a marker. Other agents edit shared source while this runs, and
 * the dev server's full-page reloads can bounce a navigation; retry until it sticks.
 */
async function gotoReady(page: Page, url: string, ready: string) {
  await expect(async () => {
    if (page.url() !== url) await page.goto(url);
    await expect(page.locator(ready).first()).toBeVisible({ timeout: 8_000 });
  }).toPass({ timeout: 60_000 });
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

/** Kiosk session through the real API (the kiosk endpoints need no login). */
async function kioskCheckIn(
  request: APIRequestContext,
  usubjid: string,
  answers: { item_id: string; attribute: string; value: number }[],
  hospitalization: boolean,
): Promise<string> {
  const ts = new Date().toISOString();
  const s = await request.post(`${API}/sessions`, {
    data: { usubjid, consent_camera: false },
  });
  expect(s.status(), await s.text()).toBe(201);
  const created = (await s.json()) as { id?: string; session_id?: string };
  const sessionId = (created.session_id ?? created.id) as string;
  // Every item attribute must be answered: the given answers, "none" (0) elsewhere.
  const catalog = (await (await request.get(`${API}/items`)).json()) as {
    items: { id: string; attributes: string[] }[];
  };
  const given = new Map(answers.map((a) => [`${a.item_id}.${a.attribute}`, a.value]));
  const all = catalog.items.flatMap((it) =>
    it.attributes.map((attribute) => ({
      item_id: it.id,
      attribute,
      value: given.get(`${it.id}.${attribute}`) ?? 0,
    })),
  );
  for (const a of all) {
    const r = await request.post(`${API}/sessions/${sessionId}/answers`, {
      data: { ...a, ts_client: ts },
    });
    expect(r.ok(), await r.text()).toBeTruthy();
  }
  const g = await request.post(`${API}/sessions/${sessionId}/gates`, {
    data: { hospitalization, conmed_changed: false, ts_client: ts },
  });
  expect(g.ok(), await g.text()).toBeTruthy();
  const c = await request.post(`${API}/sessions/${sessionId}/complete`, {
    data: { ts_client: ts },
  });
  expect(c.ok(), await c.text()).toBeTruthy();
  return sessionId;
}

/** Step 5 for one clock: review, edit, sign, clock stops, follow-up, print. */
async function packetWalkthrough(
  browser: Browser,
  request: APIRequestContext,
  clock: ClockRow,
  tag: string,
) {
  // Coordinator opens the packet from the Escalations page.
  const coord = await login(browser, "coordinator");
  await gotoReady(coord, `${WEB}/dashboard/escalations`, `tr:has-text("${clock.usubjid}")`);
  const row = coord.locator("tr", { hasText: clock.usubjid }).filter({
    has: coord.getByRole("button", { name: "Open report packet" }),
  });
  await row.first().getByRole("button", { name: "Open report packet" }).click();
  await coord.waitForURL(/\/dashboard\/packets\/(?!new)/);
  const packetUrl = coord.url();

  // Fields with evidence.
  const fields = coord.locator("tr[data-field]");
  await expect(fields.first()).toBeVisible();
  expect(await fields.count()).toBeGreaterThan(3);
  const withEvidence = coord.locator("tr[data-field]", {
    has: coord.locator('button[aria-label^="Show evidence"]'),
  });
  expect(await withEvidence.count()).toBeGreaterThan(0);

  // Missing information.
  await expect(coord.getByRole("heading", { name: "Information still needed" })).toBeVisible();

  // Narrative: every sentence has evidence chips; writer named.
  await expect(coord.getByTestId("writer-label")).toHaveText("Written by template");
  const sentences = coord
    .getByRole("list", { name: "Narrative sentences with evidence" })
    .locator("li");
  const n = await sentences.count();
  expect(n).toBeGreaterThan(0);
  for (let i = 0; i < n; i++) {
    await expect(
      sentences.nth(i).locator('button[aria-label^="Show evidence"]').first(),
    ).toBeVisible();
  }
  // Clicking a chip fills the evidence inspector.
  await sentences.first().locator('button[aria-label^="Show evidence"]').first().click();
  await expect(coord.getByTestId("evidence-inspector")).not.toContainText("Click");

  // Edit a field and save it as a new version.
  // The site fills in the last dose date, which the evidence cannot know.
  const lastDose = coord.locator('tr[data-field="LAST_DOSE_DATE"]');
  await lastDose.getByRole("button", { name: /^Edit / }).click();
  await lastDose.locator("form input, form textarea").first().fill(LAST_DOSE);
  await coord.getByRole("button", { name: "Apply" }).click();
  await expect(coord.getByText(/Unsaved changes: 1 field/)).toBeVisible();
  await coord.getByRole("button", { name: "Save", exact: true }).click();
  await expect(coord.getByText("Saved as a new version")).toBeVisible();
  await expect(coord.getByText("Edited by a person").first()).toBeVisible();
  await expect(coord.getByText("Only the investigator can sign this report.")).toBeVisible();
  await shot(coord, `reporting-0${tag === "sae" ? 1 : 4}-packet-${tag}-review`);
  await coord.context().close();

  // Investigator signs.
  const inv = await login(browser, "investigator");
  await gotoReady(inv, packetUrl, '[data-testid="deadline"]');
  await expect(inv.getByTestId("deadline")).toContainText("left");
  await inv.getByRole("button", { name: "Sign", exact: true }).click();
  const confirm = inv.getByTestId("sign-confirm");
  await confirm.getByRole("checkbox").check();
  await confirm.getByRole("button", { name: "Yes, sign the report" }).click();
  await expect(inv.getByTestId("status-label")).toContainText(/signed/i);
  await expect(inv.getByTestId("deadline")).toContainText("Reported (mock)");
  const after = (await clocks(request)).find((c) => c.id === clock.id);
  expect(after?.stopped_at, "clock stopped after signing").toBeTruthy();
  await shot(inv, `reporting-0${tag === "sae" ? 2 : 5}-packet-${tag}-signed`);

  // Print view opens with the footer sentence verbatim.
  const [printPage] = await Promise.all([
    inv.context().waitForEvent("page"),
    inv.getByRole("button", { name: "Print" }).click(),
  ]);
  await printPage.waitForLoadState();
  await expect(printPage.locator("footer")).toHaveText(FOOTER);
  expect(await printPage.content()).toContain(FOOTER);
  await printPage.close();

  // Follow-up shows changes since the previous report.
  await inv.getByRole("button", { name: "Start follow-up report" }).click();
  await expect(inv.getByText(/Follow-up 1 started/)).toBeVisible();
  await expect(
    inv.getByRole("heading", { name: "Changes since the previous report" }),
  ).toBeVisible();
  await expect(inv.getByTestId("sequence-label")).toContainText(/follow-up/i);
  await expect(inv.getByTestId("deadline")).toContainText("Stopped by the initial report");
  // The site's value is carried into the follow-up, not listed as a change.
  await expect(inv.locator('tr[data-field="LAST_DOSE_DATE"]')).toContainText(LAST_DOSE);
  await expect(
    inv.locator("section").filter({
      has: inv.getByRole("heading", { name: "Changes since the previous report" }),
    }),
  ).not.toContainText("Last dose");
  await shot(inv, `reporting-0${tag === "sae" ? 3 : 6}-packet-${tag}-followup`);
  await inv.context().close();
}

test.describe.configure({ mode: "serial" });

test("step 5a: SAE packet from the seeded ER-note clock", async ({ browser, request }) => {
  const sae = (await clocks(request, "true")).find((c) => c.kind === "sae" && c.note_id);
  expect(sae, "seeded ER-note SAE clock").toBeTruthy();
  await packetWalkthrough(browser, request, sae as ClockRow, "sae");
});

test("step 5b: AESI packet from the G3-diarrhea clock", async ({ browser, request }) => {
  const aesi = (await clocks(request, "true")).find((c) => c.kind === "aesi" && c.session_id);
  expect(aesi, "seeded G3-diarrhea AESI clock").toBeTruthy();
  await packetWalkthrough(browser, request, aesi as ClockRow, "aesi");
});

test("step 6a: investigator attribution on a check-in", async ({ browser, request }) => {
  const sessionId = await kioskCheckIn(
    request,
    "R2810-ONC-1624-P-008",
    [
      { item_id: "shortness_of_breath", attribute: "severity", value: 2 },
      { item_id: "shortness_of_breath", attribute: "interference", value: 2 },
    ],
    false,
  );
  const inv = await login(browser, "investigator");
  await gotoReady(inv, `${WEB}/dashboard/checkins/${sessionId}`, 'select[id^="aeser-"]');
  const aeser = inv.locator('select[id^="aeser-"]').first();
  await expect(aeser).toBeVisible();
  await aeser.selectOption("N");
  await inv.locator('select[id^="aerel-"]').first().selectOption({ index: 1 });
  await inv.locator('select[id^="irae-"]').first().selectOption("Y");
  await inv.locator('input[id^="attr-note-"]').first().fill("e2e attribution");
  await inv.getByRole("button", { name: "Save attribution" }).first().click();
  await expect(inv.locator('select[id^="aeser-"]').first()).toHaveValue("N");
  await expect(inv.locator('select[id^="irae-"]').first()).toHaveValue("Y");
  await expect(inv.getByRole("button", { name: "Save attribution" }).first()).toBeDisabled();

  // The server holds the decision on the current AE draft version.
  const t = await token(request, "investigator");
  const detail = (await (
    await request.get(`${API}/checkins/${sessionId}`, { headers: { authorization: `Bearer ${t}` } })
  ).json()) as { drafts: { domain: string; status: string; fields: Record<string, unknown> }[] };
  const ae = detail.drafts.find((d) => d.domain === "AE");
  expect(ae?.fields.AESER).toBe("N");
  expect(ae?.fields.INTERIM_IRAE).toBe("Y");
  expect(typeof ae?.fields.AEREL).toBe("string");
  await shot(inv, "reporting-07-attribution");
  await inv.context().close();
});

test("step 6b: seriousness decision for a clock with no AE draft", async ({ browser, request }) => {
  const sessionId = await kioskCheckIn(request, "R2810-ONC-1624-P-010", [], true);
  const clock = (await clocks(request, "true")).find((c) => c.session_id === sessionId);
  expect(clock, "SAE clock started by the hospital-visit answer").toBeTruthy();
  expect(clock?.has_ae_draft).toBe(false);

  const inv = await login(browser, "investigator");
  await gotoReady(inv, `${WEB}/dashboard/escalations`, `tr:has-text("${clock!.usubjid}")`);
  const row = inv.locator("tr", { hasText: clock!.usubjid }).filter({
    has: inv.getByRole("button", { name: "Record seriousness decision" }),
  });
  await row.first().getByRole("button", { name: "Record seriousness decision" }).click();
  const form = inv.getByRole("form", { name: "Record seriousness decision" });
  await form.getByLabel("Serious", { exact: true }).check();
  await form.getByLabel(/Reason/).fill("e2e: overnight ER visit, admitted");
  await form.getByRole("button", { name: "Continue" }).click();
  await expect(inv.getByTestId("decision-confirm")).toContainText(clock!.usubjid);
  await form.getByRole("button", { name: "Yes, record decision" }).click();
  await expect(inv.getByText("Seriousness decision recorded", { exact: true })).toBeVisible();
  const after = (await clocks(request)).find((c) => c.id === clock!.id);
  expect(after?.stopped_at).toBeTruthy();
  expect(after?.decision).toBeTruthy();
  await shot(inv, "reporting-08-escalations-decision");
  await inv.context().close();
});
