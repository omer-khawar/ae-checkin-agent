# Demo script (3 minutes, live, from a cold start)

> This is the step-by-step version of `CLAUDE.md` §11. It is written so that a teammate who did not build Interim can run it on a laptop that is not the build machine. Timings add up to 180 seconds. Rehearse it twice from `make demo-reset` before presenting. The judge's "what happens if we change the input?" question has a prepared section at the end.

## 0. Pre-flight checklist (do this before the judges arrive)

Tick every box. Each has the command and the expected sign of success.

- [ ] **Clean clone.** `git clone <repo-url> interim && cd interim`. No prior `.env`, no prior `data/runtime/`.
- [ ] **Environment file.** `cp .env.example .env`. Nothing needs editing for the demo. Default values that matter: `DEMO_PASSWORD=interim-demo`, `VITALS_SOURCE=mock`, `VITALS_SCENARIO=resting`, `SEED_ON_START=true`, `DEMO_NCT_ID=NCT03088540`, `BRIDGE_WS_PORT=8787`, `VITE_BRIDGE_WS_URL=ws://localhost:8787`.
- [ ] **Bring it up, option A (Docker):** `docker compose up --build`. Wait for the `api` container to log that it is listening on `:8000` and (on first start) that seeding finished. Then open `http://localhost:5173/kiosk`.
- [ ] **Bring it up, option B (no Docker):** `make install && make seed && make dev` (Windows without make: `npm run install:all`, then `npm run seed`, then `npm run dev`). Three colored log streams: `api`, `web`, `bridge`.
- [ ] **API is healthy.** `curl http://localhost:8000/api/v1/health` returns `{"status":"ok","version":"0.1.0",...,"vitals_source":"mock","db":"ok"}`. `http://localhost:8000/docs` renders the OpenAPI page.
- [ ] **Seed landed.** `http://localhost:5173/dashboard` (log in as `coordinator` / `interim-demo`) shows the header "Demo study (public registry record): NCT03088540 … Regeneron Pharmaceuticals … all participants are synthetic" and a queue with 12 participants' prior check-ins. If the queue is empty: `make seed` (or `npm run seed`).
- [ ] **Bridge is running and idle.** The bridge terminal prints a status line every 5 s: `[bridge] source=mock scenario=resting state=idle session=none elapsed=0s … buffered=0 posted=0`. If it is missing, `make bridge` (or `npm run bridge`).
- [ ] **Kiosk reaches the bridge.** The kiosk renders its vitals card only after camera consent, so open `http://localhost:5173/kiosk`, type any ID (e.g. `P-012`), tap **Start check-in**, then **Yes, use the camera**. Expected: the card's badge reads **SIMULATED** `mock`, its header says "Collecting" with the three slots at "collecting…", and after ~12–15 s the pulse appears and the header turns to "Good signal". If the header says "No signal" and the card says "Vitals unavailable, continuing without them", the socket is down (see §8). Reload the tab to abandon this throwaway session; the reset in the last step wipes it. (Every kiosk string quoted in this script was checked against `apps/web/src` on 2026-10-10; if the kiosk copy changes, update the quotes here.)
- [ ] **Admin settings are at demo defaults.** Log in as `admin` / `interim-demo`, open `http://localhost:5173/admin`: Vitals source = `mock`, Mock scenario = `resting`, **Treat simulated as measured = OFF**. (It is switched ON only in step 5, and the warning must be visible when you do it.)
- [ ] **P-007 has its open cough AE.** Dashboard → Participants → `P-007` → timeline shows a check-in 5 days ago with Cough (G1, provisional) and an open AE for Cough. This is what step 4 links to.
- [ ] **Eval results exist.** `make eval` (API must be running) prints 100% and writes `docs/eval/results.md`. The Eval page shows the last run.
- [ ] **Browser prep.** One window, three tabs: Tab 1 `/kiosk` (zoom 125% so the judges can read it), Tab 2 `/dashboard` logged in as `coordinator`, Tab 3 `/admin` logged in as `admin`. Each tab logs in on its own: the token lives in `sessionStorage`, which is per tab, so the coordinator and admin tabs never interfere and no incognito window is needed. (A tab opened from a link inside a logged-in tab may inherit that tab's login; open the three tabs by typing the URLs.)
- [ ] **Reset for a clean run.** `make demo-reset` (or Admin → "Reset demo data"), then re-check the three admin settings. Do this between rehearsals; it wipes everything and reseeds, including P-007's open AE.

Roles and passwords (demo auth, see `docs/PRD.md` §11): `coordinator`, `investigator`, `admin`, all `interim-demo` unless `.env` changed `DEMO_PASSWORD`.

## 1. Header: a real study, synthetic participants (0:00–0:10)

**Tab 2 (dashboard).** Point at the header.

- Say: "This is a real Regeneron Phase 3 record pulled from ClinicalTrials.gov: cemiplimab versus chemotherapy in PD-L1-high lung cancer, NCT03088540. Every participant here is synthetic."
- Expected on screen: study title, sponsor "Regeneron Pharmaceuticals", phase "PHASE3", status "COMPLETED", the public registry URL, and the sentence "All participants are synthetic."

## 2. Kiosk: start a check-in, consent, vitals collecting (0:10–0:30)

**Tab 1 (kiosk).**

1. Welcome screen: type `P-007` in the study ID field, tap **Start check-in**.
2. Camera consent screen: read one bullet of it aloud ("No video or photos are stored or sent anywhere."), tap **Yes, use the camera**.
3. Expected: the first item appears with a progress bar; the small vitals card shows the badge **SIMULATED** `mock` (the scenario name is not shown on the kiosk; it is in the bridge terminal and on the Admin page), the header says "Collecting", and the three slots (Pulse, Breathing, HRV) say **collecting…**. After ~12–15 s the pulse appears (~72; the gate opens at 12 s and the mock's confidence finishes ramping at 15 s) and the header turns to "Good signal"; after ~30 s the breathing rate (~14), after ~60 s the HRV. A tiny pleth sparkline draws underneath and a "Capturing 0:42"-style counter ticks. The card is visible on the item and gate screens only.
4. Say: "Pulse after twelve seconds, breathing after thirty. Today the source is the mock, so every value is labeled simulated. With the Presage SDK adapter it says MEASURED and nothing else changes."

Bridge terminal (if visible) now prints `state=collecting session=01J… elapsed=35s pulse=72(0.9x) breathing=14(0.8x)` (the breathing field fills in once its 30 s gate has passed).

## 3. Kiosk: answers (0:30–1:10)

Tap through. Keep a steady pace; do not finish before the breathing value has appeared (≥30 s after consent), or the VS draft will only have a usable PULSE row. Each item screen shows all of its attributes at once and enables **Next** (on the last item, **Continue**) once every attribute has an answer; the gate screens use **Next** and, on the last one, **Finish check-in**.

| Screen | Tap |
|---|---|
| Shortness of breath (severity, interference) | **Moderate**, **Somewhat** |
| Cough (severity, interference) | **Mild**, **Not at all** |
| Fatigue (severity, interference) | **None**, **Not at all** |
| Nausea (frequency, severity) | **Never**, **None** |
| Diarrhea (frequency) | **Never** |
| Rash (present?) | **No** |
| Itching (severity) | **None** |
| Joint pain (severity, interference) | **None**, **Not at all** |
| Fever or chills (present?) | **No**; leave the optional temperature box empty |
| Mouth sores (severity, interference) | **None**, **Not at all** → **Continue** |
| Gate: hospital or ER since last visit? | **No** |
| Gate: started or stopped any medication? | **Yes** → type `loratadine` → **Started** |
| Gate: anything else for the study team? | leave blank → **Finish check-in** |

Expected: the kiosk sends `stop` to the bridge, waits up to 2.5 s for it to flush, calls `/complete`, and shows the **Thank-you** screen: "Thank you. Your check-in is complete." / "Your answers have been saved for the study team to review.", plus the fixed sentence about calling 911 if urgent help is needed, with the persistent footer "Interim is a research data-capture tool. It is not a medical device and does not provide medical advice." No tier, no grade, no clinical language on this screen. It returns to Welcome by itself after 45 s (or when you tap **Done**), so move to Tab 2 promptly.

## 4. Dashboard: Tier 1, drafts, evidence, Why (1:10–1:50)

**Tab 2 (dashboard → Queue).** Refresh if needed.

1. Expected: a new top row for `P-007`, chip **Tier 1 · Review 1 business day**, badge **SIMULATED**, draft counts AE 2 · VS 2 · CM 1 (VS 3 if the session ran past 60 s and an HRV row was published).
2. Click the row. The detail page has three columns.
   - **Left:** the answers in order with timestamps (local time; hover shows UTC).
   - **Middle:** drafts.
     - AE #1: `AETERM` = the shortness-of-breath item label, `AEDECOD = Dyspnea`, `AETOXGR = 2` with the label "provisional, investigator to confirm", `AESER`, `AEREL` empty (investigator-only), `INTERIM_TIER = 1`, `AEONGO = Y`.
     - AE #2: `AEDECOD = Cough`, `AETOXGR = 1`, `INTERIM_FOLLOWUP_OF` = the id of P-007's open Cough AE, and the page's `ae_links` entry pointing at the session from 5 days ago. Say: "Same symptom within seven days of an open AE becomes a follow-up, not a duplicate."
     - VS: `VSTESTCD = PULSE`, `VSORRES ≈ 72`, `VSORRESU = beats/min`; `VSTESTCD = RESP`, `VSORRES ≈ 14`, `VSORRESU = breaths/min`; both with **`VSMETHOD = Simulated`**, `INTERIM_SOURCE = mock`, `INTERIM_CONFIDENCE`, `INTERIM_N_SAMPLES`.
     - CM: `CMTRT = loratadine` (verbatim), `CMDECOD = loratadine`, `INTERIM_MATCH_KIND = exact`, `INTERIM_MATCH_CONFIDENCE = 1.0`, `CMSTDTC` = today.
   - **Right:** the **Why** panel.
3. Click the `AETOXGR` field on the Dyspnea draft. Expected: the evidence panel opens and the two left-column answers highlight, with the notes `shortness_of_breath.severity = 2 (Moderate)` and `shortness_of_breath.interference = 2 (Somewhat)`, each with its answer id and timestamp, plus the rule pointer `grade.provisional.shortness_of_breath` ("provisional, investigator to confirm; grade from participant answers only"). Click `AEDECOD` to see the table pointer `ctcae_terms.json` ("shortness_of_breath -> Dyspnea (CTCAE v5.0; mock MedDRA code MOCK-0001)"). Say: "Every field knows where it came from."
4. Read three lines from the Why panel, in order (the text below is the engine's own wording, verbatim):
   - `grade.provisional.shortness_of_breath`: "Shortness of breath (Dyspnea): composite 2 -> provisional CTCAE grade 2 (provisional, investigator to confirm)"
   - `vitals.simulated_ignored`: "Vitals: all usable samples are SIMULATED (mock) and 'treat simulated as measured' is OFF; summarized for the record but not eligible for corroboration"
   - `tier.base`: "Base tier 1 from highest provisional grade 2", followed by `tier.final`: "Final escalation tier 1 (Coordinator review): Coordinator reviews within 1 business day."

   Also visible: `score.composite.*` for the two items, `conmed.exact` ("Con-med 'loratadine' matched exactly to 'loratadine' (confidence 1.0)"), `dedup.new_ae` (Dyspnea), `dedup.followup_linked` ("Cough reported again 5.0 day(s) after open AE … (last reported …, within the 7-day window) -> follow-up, no new AE"), `draft.ae` ×2, `draft.vs` ×2, `draft.cm`.
5. Click **Confirm** on the Dyspnea AE draft (note optional). Expected: status chip becomes **confirmed**; an audit event `draft.confirmed` is written. Say: "Nothing leaves without this click." (Confirming now also guarantees that step 5 links the repeat report as a follow-up.)

## 5. Change the vitals, same answers: Tier 2, grade unchanged (1:50–2:30)

**Tab 3 (admin, as `admin`).**

1. Mock scenario → **`post_exercise`** ("jumping jacks" today; real jumping jacks once Presage is wired in).
2. **Treat simulated as measured → ON.** Expected: a warning is shown next to the toggle: simulated values will be allowed to satisfy the corroboration gate; exports still say Simulated. Apply the change (the page writes `PUT /admin/settings`; audit: `settings.changed`).

**Tab 1 (kiosk).** Repeat step 2 and step 3 exactly (P-007, consent Yes, same answers, `loratadine`, Started). Expected vitals card: the first visible pulse is ≈119 (the mock starts at 128 but the pulse gate opens at 12 s, by which time it has decayed) and falls toward 90; the first visible breathing rate is ≈25 at 30 s and drifts slowly toward 23; still **SIMULATED**. Wait for the breathing value to appear before tapping Finish check-in.

**Tab 2 (dashboard).** Refresh the queue.

1. Expected: new top row for `P-007`, chip **Tier 2 · Nurse call today**, and a new unacknowledged row on the Escalations page. (There is no toast for Tier 2; only the Tier 3 mock page shows one.)
2. Open it. In the Why panel, point at these lines (engine wording verbatim; the numbers are the session maxima, so yours will differ slightly):
   - `vitals.simulated_as_measured`: "WARNING: demo toggle ON - 60 SIMULATED sample(s) are being treated as measured for corroboration"
   - `corr.tachycardia_dyspnea`: "Corroboration: Reported shortness of breath (composite >= 2) with a pulse of 110 beats/min or more (shortness_of_breath.composite = 2, pulse_max = 119.0) -> tachycardia with reported dyspnea", and `corr.tachypnea_dyspnea`: "Corroboration: Reported shortness of breath (composite >= 2) with a breathing rate of 24 breaths/min or more (shortness_of_breath.composite = 2, breathing_max = 25.0) -> tachypnea corroborates reported dyspnea". (See the note below on which fires.)
   - `tier.corroboration_bump`: "Vitals corroboration adds one step: tier 1 -> 2; the grade is unchanged", then `tier.final`: "Final escalation tier 2 (Nurse call today): Research nurse calls the participant today."
3. Point at the Dyspnea AE draft: **`AETOXGR` is still 2.** Say: "The grade did not change. Only the participant's answers set the grade. The tier changed, by one step, and here is the rule, its threshold, and the sample that tripped it." The draft is now a follow-up of the AE confirmed in step 4.
4. Point at the VS rows: `VSMETHOD` still says **Simulated**. The toggle changes rule eligibility only, never the label.
5. Dashboard → **Escalations**: the new Tier 2 row. Click **Acknowledge**. Expected: "acknowledged by coordinator at …, N s to acknowledge".

> Which corroboration rules fire with `post_exercise`: the scenario's constants were chosen so that both do. The pulse gate opens at 12 s with the pulse ≈119 (≥ 110), so `corr.tachycardia_dyspnea` is essentially guaranteed; the breathing gate opens at 30 s with breathing ≈25 (≥ 24), so `corr.tachypnea_dyspnea` fires too unless the noise dips it below 24 at that moment. Either rule alone gives the +1; two rules never give +2. If you want exactly the "breathing 26" line from `CLAUDE.md` §11 and nothing else, use the **`tachypnea`** scenario instead (pulse ~98, breathing ~26 steady): only the tachypnea rule fires. Both are fine; say what is on the screen.

## 6. The judge changes the input (2:30–2:50)

**Tab 2 → Eval.**

1. Click **Run all** (or show the last run). Expected: per-tier precision / recall / F1 all 1.00 on the 24 shipped personas; the 4×4 grade confusion matrix is diagonal; dedup, SAE-clock and con-med checks 100%. Point at `docs/eval/results.md` if asked for the file.
2. Tick **Include hidden judge personas** and click **Run** again. Expected: 29 personas, 100%.
3. **Build your own:** click **Load the demo persona**, change shortness-of-breath severity from **Moderate** to **Severe** (leave interference at Somewhat), click **Run**. Expected: `redflag.severe_dyspnea` fires ("Red flag: Severe or very severe shortness of breath (shortness_of_breath.severity = 3) -> tier floor = 3 (Urgent)"), `tier.redflag_floor` ("Red-flag floor 3 raises tier 1 -> 3"), tier **3**, `stop_screen = true`, `page_oncall = true`, and **`AETOXGR` stays 2**: severity 3 with interference 2 is composite 2 in `composite_scoring.json`. Say: "The red flag moved the tier, not the grade. That is the kiosk's stop screen and a page to the on-call." Then raise interference to **Quite a bit** and run again: composite 3 → `AETOXGR = 3`, tier still 3. Say: "Now the table moved the grade. Severity and interference are the inputs; the scoring table and the ladder are data."
4. Hand the keyboard to the judge if they want to try another input (see §9 for the prepared answers).

## 7. Audit, export, footer, honesty (2:50–3:00)

**Tab 2 → Audit.** Click **Verify**. Expected: green **Verified** badge, "N events checked", the head hash. Say: "Every answer, sample, rule, edit, confirm, page and export is in this chain."

Click **Export bundle**. Expected: `bundle.zip` downloads with `AE.csv AE.json VS.csv VS.json VS_samples.csv CM.csv CM.json audit_excerpt.json manifest.json`; the manifest carries a SHA-256 per file and the audit head hash. If there is time, **Post to mock EDC** on the AE domain returns an `ack_id`.

Point at the footer: "Interim is a research data-capture tool. It is not a medical device and does not provide medical advice." Close on the "what it gets wrong" slide (`docs/SLIDES.md` slide 10).

---

## 8. Fallbacks

| Symptom | Do this |
|---|---|
| Kiosk vitals card says **Vitals unavailable, continuing without them** | The check-in still works; the record gets `vitals_status = unavailable`, no VS rows are drafted, and the Why panel shows `vitals.unavailable` ("Vitals: no samples were captured for this session; check-in evaluated without vitals"). Say so, and keep going. Restart the bridge in another terminal: `make bridge` (or `npm run bridge`). If port 8787 is taken, set `BRIDGE_WS_PORT=8788` **and** `VITE_BRIDGE_WS_URL=ws://localhost:8788` in `.env` and restart web + bridge. |
| Card header still says "Collecting" and no pulse has appeared after 20 s | Check the bridge terminal: `state=collecting`? If `idle`, the kiosk did not send `start`; reload the kiosk tab and start the session again. If `error`, you are in the `dropout` scenario; set the admin scenario back to `resting`. If the header says "Signal is weak", you are in `low_quality`; same fix. |
| Step 5 shows **Tier 1** instead of Tier 2 | In order: (a) Admin → "Treat simulated as measured" must be **ON** and saved; (b) the scenario must be `post_exercise` or `tachypnea` and must have been saved *before* the kiosk sent `start` (the bridge reads `/settings/public` on start); (c) the session must have lasted ≥ 30 s for breathing (pulse needs only 12 s). Fastest fix: set scenario `tachypnea`, re-run. |
| Step 5 corroboration moment is impossible (bridge dead) | Use Eval → Build your own: load the demo persona, set vitals scenario `tachypnea` (samples: breathing 26, pulse 98, conf 0.9, `isMeasured false`) and the persona setting `simulated_as_measured: true`, Run. Same rules fire, same Why text. |
| The cough draft is not linked as a follow-up in step 4 | P-007's seed AE is missing (reset was skipped or seed failed). Run `make demo-reset`. Fallback narrative: confirm the cough AE now, repeat the check-in, and show the link on the second run. |
| Dashboard shows no study header / "study unavailable" | `data/public/study.json` is committed; if it is missing, run `python scripts/fetch_public.py --offline` (uses the bundled fallback) then `make seed`. The demo does not need the network. |
| Docker will not build on the demo laptop | `make install && make seed && make dev` (or the `npm run` equivalents). Same URLs. |
| Login fails | Password is `DEMO_PASSWORD` from `.env` (default `interim-demo`). Each tab logs in on its own: the token lives in `sessionStorage`, which is per tab, so a tab you open by typing the URL starts logged out (that is normal, not a bug); a tab opened from a link inside a logged-in tab may inherit that login. |
| Two roles needed at once (coordinator + admin) | Use two tabs (Tab 2 as `coordinator`, Tab 3 as `admin`); they do not interfere. No incognito window is needed. |
| Projector cannot read the kiosk | Browser zoom 125–150%; the kiosk is designed for large type at 1366×768 and up. |
| Clock looks wrong on timestamps | UI shows local time with UTC on hover; the server time is the authoritative one in exports. |

Reset between runs: `make demo-reset` (or Admin → Reset demo data → confirm). Then re-check the three admin settings (source `mock`, scenario `resting`, toggle **OFF**).

## 9. "What happens if we change the input?" (prepared answers)

Say first: "Every clinical number is a table, so I can tell you in advance." Then do one live on the Eval page's build-your-own form. Each row below names the table and the rule the judge will see in the Why panel. Every row was re-run through `interim_rules` (engine and matcher) on 2026-10-10; re-run them before the rehearsal if any table under `packages/rules/data/` has changed since.

| Change | What happens | Table / rule |
|---|---|---|
| Shortness of breath severity Moderate → **Severe** (interference still Somewhat) | Red flag: tier floor 3 → **Tier 3**, stop screen, page; **`AETOXGR` stays 2** (severity 3 + interference 2 → composite 2). Raise interference to **Quite a bit** as well → composite 3 → `AETOXGR = 3`, tier still 3 | `red_flags.json` · `redflag.severe_dyspnea`; `composite_scoring.json` |
| Hospital/ER = **Yes** | `seriousness_suspected = true`, SAE clock starts (`site_awareness_at`, `due_at = +24 h`), queue shows a countdown chip; Tier 3 | `seriousness.json`, `red_flags.json` · `redflag.hospitalization`, `sae.clock_started` |
| Breathing 26 → **23** (edit the persona's vitals sample) | No corroboration (threshold is ≥ 24); tier stays 1 | `vitals_corroboration.json` · `corr.tachypnea_dyspnea` absent |
| Pulse **190** | Implausible (bounds 35–180) → sample ignored with a logged reason; no bump | `vitals_corroboration.json` · `vitals.implausible` |
| Confidence **0.5** on the samples | Below `min_confidence` 0.6 → `vitals.low_quality`; no bump | `vitals_corroboration.json` · `vitals.low_quality` |
| Toggle "simulated as measured" **OFF** with a mock session | `vitals.simulated_ignored`; no bump regardless of values | `RuleSettings.simulated_as_measured` |
| Con-med `loratadine` → **`Claritin`** | `CMDECOD = loratadine` (brand → generic), `case_insensitive`, 1.0 | `medlist.json` · `conmed.case_insensitive` |
| Con-med → **`loritidene`** (3 edits) | Unmatched; verbatim kept; flagged for the coordinator | `conmed.unmatched` |
| Con-med → **`vitamin k`** | Matches `vitamin c` at 0.89 (one-letter edit; `vitamin d` and `vitamin e` are equally close and lose the alphabetical tie-break): a documented false positive, `docs/WHAT_IT_GETS_WRONG.md` §4. (`vitamin c`, `vitamin d`, `vitamin e` and `vitamin b12` themselves are exact matches.) | `conmed.levenshtein` |
| Con-med → **`lasik`** | Matches `furosemide` at 0.80 via the brand `lasix`: a non-drug word becomes a diuretic; the coordinator sees the 0.80 and the verbatim text | `conmed.levenshtein` |
| Con-med → **`Dupixent`** or **`Libtayo`** | `CMDECOD = dupilumab` / `cemiplimab`, `case_insensitive`, 1.0: Regeneron's own products are in the hand-curated core list | `medlist.json` · `conmed.case_insensitive` |
| Same symptom reported again **tomorrow** | Follow-up linked to the open AE, no new AE | `dedup.json` · `dedup.followup_linked` |
| Same symptom reported again in **8 days** | New AE | `dedup.new_ae` |
| Fever = Yes **and** any item Severe | Tier floor 2 | `redflag.fever_with_severe` |
| Free text non-empty **and** any item Severe | Tier floor 2, flagged "human read"; the text is never parsed | `redflag.other_text_with_severe` |
| Any vitals value, any scenario | **Grade never changes**; vitals can only raise the tier by one step | property tests in `packages/rules/tests` |

If the judge asks "why 24 and 110?": open `packages/rules/data/vitals_corroboration.json` and read the `source` and `rationale` fields; then say that they are population thresholds, not baseline-adjusted, and that `docs/WHAT_IT_GETS_WRONG.md` §3 says what that costs.

If the judge asks "what does it get wrong?": slide 10, or the first three items of `docs/WHAT_IT_GETS_WRONG.md`: the composite→grade crosswalk is not validated; camera vitals are confounded by talking and motion; thresholds are fixed.

## 10. After the demo

- Leave the Eval page open with the hidden personas included; judges may come back to it.
- `make demo-reset` before the next group.
- The 3-minute video follows this same script, screen-recorded at 1920×1080 with the bridge terminal visible in a corner for steps 2 and 5.
