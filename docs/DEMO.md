# Demo script (3 minutes, live, from a cold start)

> **Status (2026-10-10, evening): this script describes the wave-2 build (`docs/CONTRACTS.md` R2.6) plus the R3 protocol rules that already run inside the engine.** The R3 rewrite (`docs/DECISIONS.md` D-023 to D-026: the Monday-morning story, no per-session camera consent, serious-event packets, visit briefs, the optional text writer) is pending; until its API and web work lands, the kiosk still shows the consent screen and every step below is what the running app does. Re-check this script against the tree when R3 stage 2 merges.

> This is the step-by-step version of `CLAUDE.md` §11. It is written so that a teammate who did not build Interim can run it on a laptop that is not the build machine. Timings add up to 180 seconds. Rehearse it twice from `make demo-reset` before presenting. The judge's "what happens if we change the input?" question has a prepared section at the end. Wave 2 added an **optional 20-second chart-note beat** (step 4b) and a note on swapping the mock for the **Presage** camera source (step 2); neither is needed for the 3-minute path.

## 0. Pre-flight checklist (do this before the judges arrive)

Tick every box. Each has the command and the expected sign of success.

- [ ] **Clean clone.** `git clone <repo-url> interim && cd interim`. No prior `.env`, no prior `data/runtime/`.
- [ ] **Environment file.** `cp .env.example .env`. Nothing needs editing for the demo. Default values that matter: `DEMO_PASSWORD=interim-demo`, `VITALS_SOURCE=mock`, `VITALS_SCENARIO=resting`, `SEED_ON_START=true`, `DEMO_NCT_ID=NCT03088540`, `BRIDGE_WS_PORT=8787`, `VITE_BRIDGE_WS_URL=ws://localhost:8787`.
- [ ] **Bring it up, option A (Docker):** `docker compose up --build`. Wait for the `api` container to log that it is listening on `:8000` and (on first start) that seeding finished. Then open `http://localhost:5173/kiosk`.
- [ ] **Bring it up, option B (no Docker):** `make install && make seed && make dev` (Windows without make: `npm run install:all`, then `npm run seed`, then `npm run dev`). Three colored log streams: `api`, `web`, `bridge`.
- [ ] **API is healthy.** `curl http://localhost:8000/api/v1/health` returns `{"status":"ok","version":"0.1.0",...,"vitals_source":"mock","db":"ok"}`. `http://localhost:8000/docs` renders the OpenAPI page.
- [ ] **Seed landed.** `http://localhost:5173/dashboard` (log in as `coordinator` / `interim-demo`) shows the header "Demo study (public registry record): NCT03088540 … Regeneron Pharmaceuticals … all participants are synthetic" and a queue of 42 rows: 34 prior check-ins for the 12 participants plus 8 synthetic chart notes (rows marked as notes). Two seeded rows are Tier 2 from notes: N3 (P-003, left unacknowledged on purpose so the Escalations page has live work) and N6 (P-006, an outside ED record whose SAE clock is a live countdown of roughly 21 hours on a fresh seed). If the queue is empty: `make seed` (or `npm run seed`).
- [ ] **Bridge is running and idle.** The bridge terminal prints a status line every 5 s: `[bridge] source=mock scenario=resting state=idle session=none elapsed=0s … buffered=0 posted=0`. If it is missing, `make bridge` (or `npm run bridge`).
- [ ] **Kiosk reaches the bridge.** The kiosk renders its vitals card only after camera consent, so open `http://localhost:5173/kiosk`, type any ID (e.g. `P-012`), tap **Start check-in**, then **Yes, use the camera**. Expected: the card's badge reads **SIMULATED** `mock`, its header says "Collecting" with the three slots at "collecting…", and after ~12–15 s the pulse appears and the header turns to "Good signal". If the header says "No signal" and the card says "Vitals unavailable, continuing without them", the socket is down (see §8). Reload the tab to abandon this throwaway session; the reset in the last step wipes it. (Every kiosk string and every dashboard button label quoted in this script (Eval, Notes, Audit pages) was checked against `apps/web/src` on 2026-10-10; if the copy changes, update the quotes here.)
- [ ] **Admin settings are at demo defaults.** Log in as `admin` / `interim-demo`, open `http://localhost:5173/admin`: Vitals source = `mock`, Mock scenario = `resting`, **Treat simulated vitals as measured = OFF**. (It is switched ON only in step 5, and the warning must be visible when you do it.)
- [ ] **P-007 has its open cough AE.** Dashboard → Participants → `P-007` → timeline shows a check-in 5 days ago with Cough (G1, provisional) and an open AE for Cough. This is what step 4 links to.
- [ ] **Eval results exist.** `make eval` starts its own throwaway API on a free port with a temporary SQLite database (it neither needs nor touches the demo API on :8000), replays the personas and the chart-note answer key, prints the summary and rewrites `docs/eval/results.md`; every persona it runs must pass. While the R3 API work is pending it lists one protocol persona, `P3-rash-itching-prior-pi3k-aesi`, as `SKIP … not replayable over HTTP` (the API has no `protocol_context` input yet); that persona is still checked in-process by `packages/rules/tests/test_personas.py`. `make eval` does **not** fill the Eval page: the page shows only the last run stored by its own buttons (`POST /api/v1/eval/run`), `make eval-live` (which replays against :8000 and writes `data/runtime/eval/results.live.md`) does not store one either, and `make demo-reset` wipes it. So after the final reset, open Dashboard → Eval and click **Run hidden judge personas (5)** once; on a reload the status line then reads "Showing the last stored run."
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
4. Say: "Pulse after twelve seconds, breathing after thirty. Today the source is the mock, so every value is labeled simulated. The Presage camera source is implemented; when it runs, the badge says MEASURED and nothing else changes."

> **Presage instead of the mock (optional, only when the key is being used).** The Presage SmartSpectra source is implemented but has not yet passed its live test (`docs/VITALS_SOURCES.md` §5; `docs/WHAT_IT_GETS_WRONG.md` §17). Do the live checklist first, off-camera, then for the take that counts: stop the mock bridge, `cd apps/vitals-bridge && npm run install:presage`, set `PRESAGE_API_KEY` in the environment (never on screen, never committed), run `npm run bridge -- --source presage --api http://localhost:8000 --ws-port 8787` (pin `PRESAGE_CAMERA_ID` from `--list-cameras` on Windows). Expected differences: the kiosk badge reads **MEASURED** `presage`, there is no pleth sparkline, VS drafts carry `VSMETHOD = "Contactless optical, camera-based"`, and in step 5 you do 30 s of real jumping jacks instead of switching the scenario, with **"Treat simulated vitals as measured" left OFF**. The account is metered: rehearse with the mock and switch only for the final take (one check-in is about 1.5–2 minutes of capture). If the bridge reports `SmartSpectra error 2 / 4 / 5` (key, credits, network), restart it with `--source mock` and carry on; the script below is unchanged.

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

1. Expected: a new row for `P-007` at the top of the Tier 1 rows (the queue sorts by tier, then time, so the four seeded Tier 2 rows stay above it; type `P-007` in the participant filter to make it the top row), chip **Tier 1 · Review 1 business day**, badge **SIMULATED**, draft counts AE 2 · VS 2 · CM 1 (VS 3 if the session ran past 60 s and an HRV row was published).
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

   Also visible: `score.composite.*` for the two items, `conmed.exact` ("Con-med 'loratadine' matched exactly to 'loratadine' (confidence 1.0)"), `dedup.new_ae` (Dyspnea), `dedup.followup_linked` ("Cough reported again 5.0 day(s) after open AE … (last reported …, within the 7-day window) -> follow-up, no new AE"), `draft.ae` ×2, `draft.vs` ×2, `draft.cm`, and one line from the R3 protocol table (`packages/rules/data/protocol_rules.json`, D-025): `protocol.cm_fields_missing`, "The protocol asks for each medication's generic name, dose, dose unit, frequency, indication and start/stop date (§7.7, p. 69). Still missing for 'loratadine': dose, dose unit, frequency, indication. Coordinator to ask the participant". If a judge points at it, say: "That is the real EMPOWER-Lung 1 protocol's con-med section; the kiosk only asks for the name, so the coordinator knows what to ask next."
5. Click **Confirm** on the Dyspnea AE draft (note optional). Expected: status chip becomes **confirmed**; an audit event `draft.confirmed` is written. Say: "Nothing leaves without this click." (Confirming now also guarantees that step 5 links the repeat report as a follow-up.)

## 4b. Optional: paste a chart note (20 s; the sheet's "Better" tier)

Use it when the judges ask about chart scanning, or swap it in for step 6.1 (the persona run) to stay at three minutes. **Tab 2 → Notes** (`/dashboard/notes`, logged in as `coordinator`).

1. The **Ingest a chart note** form opens pre-filled with a sample note (N3); click **Clear** (it resets the date to today). Then: Participant **P-007**; Note date: leave today's; Author `Research RN`; Type **Phone note**; paste exactly this text:

   ```
   Pt reports dry cough x4 days, worse at night. Started dextromethorphan OTC. Denies fever or shortness of breath.
   ```

   Optionally click **Scan only (dry run)** first: the same findings appear and nothing is stored.
2. Click **Ingest**. Expected (verified on 2026-10-10 against a freshly seeded database through `POST /api/v1/notes`):
   - Tier **1 · Coordinator review**; no red flag, no escalation, no SAE clock.
   - **AE** `AETERM = cough`, `AEDECOD = Cough`, `AETOXGR = 1` (grade hint: "mentioned without a severity word"), onset 4 days before the note, marked worsening ("worse at night"), and **a follow-up of P-007's open Cough AE** that the kiosk opened: the Why panel says "Cough reported again in a chart note … day(s) after open AE …; within the 7-day window -> follow-up, no new AE". `INTERIM_RECORD_SOURCE = chart_note`.
   - **CM** `CMTRT = dextromethorphan`, `CMDECOD = dextromethorphan`, started today, `INTERIM_MATCH_KIND = lexicon`.
   - **Skipped**, with reasons: Fever and Dyspnea, "negated: 'Denies' precedes 'fever' in the same clause".
   - Click the AE draft's `AETERM` field: its evidence lists the `chart_note` pointer and the word "cough" is highlighted in the stored note text (character offsets).
3. Say: "Same rules engine, different source. A regex lexicon with negation rules, no model. It found the cough, linked it to the cough the participant reported at the kiosk instead of opening a duplicate, picked up the new cough medicine, and showed us the two things it deliberately ignored."

Notes for the presenter:
- Pasting the same note twice is refused (**409 Duplicate note**) by design; change a word to ingest again.
- Do **not** start the note with "Phone call with pt:": the scanner reads "call with" as an instruction and skips the cough (`docs/WHAT_IT_GETS_WRONG.md` §15). It is a good answer to "what does it get wrong?", but not mid-demo.
- To show the SAE clock from a note instead, append `Seen in the ED last night, sent home.`: the note becomes Tier 2, `seriousness_suspected`, and a 24-hour SAE clock starts at the ingestion time (a note never reaches Tier 3 or pages anyone: D-017). Writing `Seen in ED last night` without "the" does **not** start the clock; see §9.
- If you ran 4b before step 5, step 5's cough report still links as a follow-up (the open Cough AE is the same).

## 5. Change the vitals, same answers: Tier 2, grade unchanged (1:50–2:30)

**Tab 3 (admin, as `admin`).**

1. Mock scenario → **`post_exercise`** ("jumping jacks" today; real jumping jacks once Presage is wired in).
2. **Treat simulated vitals as measured → ON.** Expected: a warning is shown next to the toggle: simulated values will be allowed to satisfy the corroboration gate; exports still say Simulated. Click **Save settings** (the page writes `PUT /admin/settings`; audit: `settings.changed`).

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

The page has three parts, top to bottom: the **Run the test set** card (two buttons), the **Personas** catalogue (one **Run** button per row; its "show hidden judge personas" checkbox only filters the list and runs nothing), and **Build your own persona**.

1. In **Run the test set**, click **Run hidden judge personas (5)**. Expected: 5 / 5 pass, plus the chart-note scanner section, which passes its 39-case answer key (AE terms 38/38, meds 17/17, 0 over-escalations). Point at `docs/eval/results.md` if asked for the file (`make eval` writes that file, not this button). If they ask whether that is circular: yes, those answer keys are regression tests; the honest number is the Synthea evaluation (`docs/eval/synthea_results.md`: symptoms P 0.919 / R 0.792 on notes the scanner never saw).
2. Optional, if asked for the whole set: **Run the shipped personas (31)**. The page computes the count from the catalogue: the 24 personas of `CLAUDE.md` §8 plus 7 `protocol` personas added with the R3 protocol rules (36 in `personas.json` with the 5 hidden ones). Expected today: **30 / 31**. The one failure is `P3-rash-itching-prior-pi3k-aesi`. It needs a `protocol_context` (a prior PI3K inhibitor) that the API cannot receive until the R3 stage-2 work lands, so the AESI it expects does not fire. Its tier and grades still match, so per-tier precision / recall / F1 and the diagonal grade confusion matrix are unaffected. Say so plainly: it is a known gap, not a surprise. (`make eval` skips that persona as not replayable rather than failing it.)
3. **Build your own persona:** the form is already pre-filled with the demo persona `T1-dyspnea-moderate`, which has the same answers as step 3 (if someone changed it, click **Reset to demo persona**). In the Answers card, set Shortness of breath **Severity** to **Severe** (leave **Interference** at **Somewhat**) and click **Run this persona**. Expected under **Outcome of this run**: "Escalation tier 3: Urgent · kiosk shows the stop screen · on-call paged". In the Why card: `redflag.severe_dyspnea` ("Red flag: Severe or very severe shortness of breath (shortness_of_breath.severity = 3) -> tier floor = 3 (Urgent)") and `tier.redflag_floor` ("Red-flag floor 3 raises tier 1 -> 3"). **The provisional grade stays 2**: severity 3 with interference 2 is composite 2 in `composite_scoring.json`. Say: "The red flag moved the tier, not the grade. That is the kiosk's stop screen and a page to the on-call." Then set **Interference** to **Quite a bit** and click **Run this persona** again. Composite 3 gives grade 3, the tier stays 3, and two R3 protocol lines appear: `protocol.aesi_suspected` ("Possible adverse event of special interest (possible AESI, investigator to confirm): Shortness of breath. … Protocol §9.4.3, p. 92 lists 'Grade 3 or greater irAEs'. …") and `aesi.clock_started` ("24-hour AESI clock started (possible AESI, investigator to confirm). …"). Say: "Now the table moved the grade. Severity and interference are the inputs; the scoring table and the ladder are data. And grade 3 on a potentially immune-related symptom is a possible AESI under this protocol, so a 24-hour clock starts, like an SAE." (Until R3 stage 2 lands, the AESI clock is reported in this result but does not yet appear as a queue chip.)
4. Hand the keyboard to the judge if they want to try another input (see §9 for the prepared answers).

## 7. Audit, export, footer, honesty (2:50–3:00)

**Tab 2 → Audit.** Click **Verify chain**. Expected: a green **VERIFIED** badge, "Events checked" with the count, and the head hash (with "Copy full hash"). Say: "Every answer, sample, rule, edit, confirm, page and export is in this chain."

In the exports card on the same page (the **Records** selector defaults to **Confirmed only**), click **Download submission bundle (.zip)**. Expected: `interim-bundle.zip` downloads with `AE.csv AE.json VS.csv VS.json VS_samples.csv CM.csv CM.json audit_excerpt.json manifest.json`. The manifest carries a SHA-256 per file and the audit head hash, and a new `export.generated` event appears in the event list.

**Posting to the mock EDC has no dashboard button.** The web client has the call (`postMockEdc` in `apps/web/src/lib/api.ts`), but no page uses it yet. If there is time, show the endpoint from a terminal instead (Git Bash, macOS or Linux; verified against a freshly seeded API on 2026-10-10):

```bash
API=http://localhost:8000/api/v1
TOKEN=$(curl -s -X POST $API/auth/login -H 'content-type: application/json' \
  -d '{"username":"coordinator","password":"interim-demo"}' | python -c "import sys,json; print(json.load(sys.stdin)['token'])")
curl -s -H "Authorization: Bearer $TOKEN" "$API/export/AE.json" \
  | python -c "import sys,json; print(json.dumps({'records': json.load(sys.stdin)['records']}))" \
  | curl -s -X POST "$API/mock-edc/AE" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' --data-binary @-
```

Expected: `{"ack_id":"EDC-AE-…","domain":"AE","received":N,"accepted_at":"…","sha256":"…","note":"Mock EDC acknowledgment. No external system was contacted."}` and a `mock_edc.posted` audit event. (Alternative: open `http://localhost:8000/docs`, click Authorize, then use `POST /api/v1/mock-edc/{domain}`.)

Point at the footer: "Interim is a research data-capture tool. It is not a medical device and does not provide medical advice." Close on the "what it gets wrong" slide (`docs/SLIDES.md` slide 10).

---

## 8. Fallbacks

| Symptom | Do this |
|---|---|
| Kiosk vitals card says **Vitals unavailable, continuing without them** | The check-in still works; the record gets `vitals_status = unavailable`, no VS rows are drafted, and the Why panel shows `vitals.unavailable` ("Vitals: no samples were captured for this session; check-in evaluated without vitals"). Say so, and keep going. Restart the bridge in another terminal: `make bridge` (or `npm run bridge`). If port 8787 is taken, set `BRIDGE_WS_PORT=8788` **and** `VITE_BRIDGE_WS_URL=ws://localhost:8788` in `.env` and restart web + bridge. |
| Card header still says "Collecting" and no pulse has appeared after 20 s | Check the bridge terminal: `state=collecting`? If `idle`, the kiosk did not send `start`; reload the kiosk tab and start the session again. If `error`, you are in the `dropout` scenario; set the admin scenario back to `resting`. If the header says "Signal is weak", you are in `low_quality`; same fix. |
| Step 5 shows **Tier 1** instead of Tier 2 | In order: (a) Admin → "Treat simulated vitals as measured" must be **ON** and saved; (b) the scenario must be `post_exercise` or `tachypnea` and must have been saved *before* the kiosk sent `start` (the bridge reads `/settings/public` on start); (c) the session must have lasted ≥ 30 s for breathing (pulse needs only 12 s). Fastest fix: set scenario `tachypnea`, re-run. |
| Step 5 corroboration moment is impossible (bridge dead) | Use Eval → **Build your own persona**: click **Reset to demo persona**, set **Scenario preset** to **Fast breathing** (simulated breathing 26, pulse 98, confidence 0.9, every sample `isMeasured: false`), tick **Treat simulated vitals as measured for this run**, click **Run this persona**. Same rules fire, same Why text. |
| The cough draft is not linked as a follow-up in step 4 | P-007's seed AE is missing (reset was skipped or seed failed). Run `make demo-reset`. Fallback narrative: confirm the cough AE now, repeat the check-in, and show the link on the second run. |
| Dashboard shows no study header / "study unavailable" | `data/public/study.json` is committed; if it is missing, run `python scripts/fetch_public.py --offline` (uses the bundled fallback) then `make seed`. The demo does not need the network. |
| Docker will not build on the demo laptop | `make install && make seed && make dev` (or the `npm run` equivalents). Same URLs. |
| Login fails | Password is `DEMO_PASSWORD` from `.env` (default `interim-demo`). Each tab logs in on its own: the token lives in `sessionStorage`, which is per tab, so a tab you open by typing the URL starts logged out (that is normal, not a bug); a tab opened from a link inside a logged-in tab may inherit that login. |
| Two roles needed at once (coordinator + admin) | Use two tabs (Tab 2 as `coordinator`, Tab 3 as `admin`); they do not interfere. No incognito window is needed. |
| Projector cannot read the kiosk | Browser zoom 125–150%; the kiosk is designed for large type at 1366×768 and up. |
| Clock looks wrong on timestamps | UI shows local time with UTC on hover; the server time is the authoritative one in exports. |
| Step 4b: **Ingest** returns "Duplicate note" (409) | The same participant, date and text were already ingested (a rehearsal, or a double click). Change one word, or `make demo-reset`. |
| Step 4b: **Ingest** is disabled or says read-only | You are logged in as `investigator`; the Notes page offers an investigator only the dry-run scan, which still works. Log in as `coordinator`. (The web UI enforces this restriction; the API currently also accepts `POST /notes` from an investigator. See `docs/PRD.md` §3.) |
| Step 4b: the cough is not a follow-up | P-007's open Cough AE is missing (seed skipped) or more than 7 days old. `make demo-reset`; the note still drafts a new Cough AE, which is fine to show. |
| Presage source: `SmartSpectra error 2 / 4 / 5`, exit code 2, or no pulse after 20 s | Stop the bridge and restart it with `--source mock` (or `make bridge`); continue with the mock and the SIMULATED badge. Never debug the vendor account on stage. |

Reset between runs: `make demo-reset` (or Admin → Reset demo data → confirm). Then re-check the three admin settings (source `mock`, scenario `resting`, toggle **OFF**).

## 9. "What happens if we change the input?" (prepared answers)

Say first: "Every clinical number is a table, so I can tell you in advance." Then do one live on the Eval page's build-your-own form. Each row below names the table and the rule the judge will see in the Why panel. Every row was re-run through `interim_rules` (engine and matcher) on 2026-10-10; re-run them before the rehearsal if any table under `packages/rules/data/` has changed since.

| Change | What happens | Table / rule |
|---|---|---|
| Shortness of breath severity Moderate → **Severe** (interference still Somewhat) | Red flag: tier floor 3 → **Tier 3**, stop screen, page; **`AETOXGR` stays 2** (severity 3 + interference 2 → composite 2). Raise interference to **Quite a bit** as well → composite 3 → `AETOXGR = 3`, tier still 3 | `red_flags.json` · `redflag.severe_dyspnea`; `composite_scoring.json` |
| Hospital/ER = **Yes** | `seriousness_suspected = true`, SAE clock starts (`site_awareness_at`, `due_at = +24 h`), queue shows a countdown chip; Tier 3 | `seriousness.json`, `red_flags.json` · `redflag.hospitalization`, `sae.clock_started` |
| Breathing 26 → **23** (Scenario preset **Fast breathing**, demo toggle ticked, then set the **Breathing** level to 23) | No corroboration (threshold is ≥ 24); tier stays 1 | `vitals_corroboration.json` · `corr.tachypnea_dyspnea` absent |
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
| *Notes page, step 4b note:* delete **"Denies"** | Fever and Dyspnea become findings (two more AE drafts), and the `fever` red flag makes the note **Tier 2** | `chartscan_lexicon.json` negation cues · `chartscan_red_flags.json` |
| *Notes page:* append **"Seen in the ED last night, sent home."** | Hospitalization cue → **Tier 2**, `seriousness_suspected`, SAE clock from the ingestion time; never Tier 3 for a note (D-017) | `chartscan_red_flags.json` · `chartscan.hospitalization` |
| *Notes page:* the same sentence **without "the"** ("Seen in ED last night") | **No** hospitalization cue, no SAE clock: bare "ED" needs hospital context. A documented miss (`docs/WHAT_IT_GETS_WRONG.md` §15) | `chartscan_red_flags.json` |
| *Notes page:* start the note with **"Phone call with pt:"** | The cough is skipped as hypothetical ("'call with' earlier in the sentence") | `chartscan_lexicon.json` hypothetical cues; WHAT_IT_GETS_WRONG §15 |

If the judge asks "why 24 and 110?": open `packages/rules/data/vitals_corroboration.json` and read the `source` and `rationale` fields; then say that they are population thresholds, not baseline-adjusted, and that `docs/WHAT_IT_GETS_WRONG.md` §3 says what that costs.

If the judge asks "what does it get wrong?": slide 10, or the first three items of `docs/WHAT_IT_GETS_WRONG.md`: the composite→grade crosswalk is not validated; camera vitals are confounded by talking and motion; thresholds are fixed.

## 10. After the demo

- Leave the Eval page open on the last run (the catalogue lists the hidden judge personas by default, each with its own **Run** button); judges may come back to it.
- `make demo-reset` before the next group.
- The 3-minute video follows this same script, screen-recorded at 1920×1080 with the bridge terminal visible in a corner for steps 2 and 5.
