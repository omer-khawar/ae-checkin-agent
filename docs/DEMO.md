# Demo script: Monday morning (3 minutes, live)

> The story (`CLAUDE.md` §00.6): **"Monday 8 am. Overnight: three kiosk check-ins, a caregiver's phone call and two hospital notes (an ER visit and an urgent-care visit). Interim has already found the side effects with exact quotes, merged duplicates, flagged the ER visit as a possible serious event, started the 24-hour clock, pre-filled the report and drafted its narrative, caught a discouraged steroid against the protocol, and built tomorrow's visit brief. The coordinator reviews and confirms instead of retyping."**
>
> **The time claim is the number on screen, nothing else.** Say the figure the time-saved strip shows, with the word "estimate". On a fresh seed (`docker compose down -v && docker compose up --build`) the strip reads **about 75 minutes this week** (last week's confirmed records), and confirming all of the overnight records adds **about 78 minutes** of typing that was pre-filled (measured 2026-10-11 against `GET /api/v1/metrics/time-saved`; the exact figure moves if the seed changes, so read it off the strip in pre-flight). Each per-field minute is an assumption anchored to one published entry rate (MSK + IgniteData), listed under "How is this estimated?" and in `packages/rules/data/time_model.json`. The 12–15 h per study per week figure is published context for how much copying coordinators do, not something Interim measured; never say "twenty minutes instead of a day".
>
> Every click below lands on state the seed creates (`apps/api/interim_api/seed.py`, `data/synthetic/README.md` §10). All participants are synthetic. Times are relative to when the seed ran, so "overnight" is true whenever you reset.

---

## 0. Pre-flight (5 minutes before the judges arrive)

1. **Start clean.** `docker compose down -v && docker compose up --build` (or `make demo-reset` with `make dev` running). Wait for the API health check: http://localhost:8000/api/v1/health returns `"status":"ok"`.
2. **Two browser tabs, two roles.** Logins live in each tab's session storage, so two tabs of the same browser can hold two roles.
   - **Tab A:** http://localhost:5173/ → **coordinator**, password `interim-demo` (or your `DEMO_PASSWORD`). Leave it on the Queue.
   - **Tab B:** http://localhost:5173/ → **investigator**. Leave it on the Queue.
3. **Check the morning state** in Tab A: the "Since you were last here" row is at the top of the Queue; the time-saved strip is in the header with the word "estimate" (write its number on a sticky note; that is the number you say in §1); the top rows are Tier 2 ("Nurse call today"); an **SAE** chip shows about 21 hours left and an **AESI** chip about 13 hours left.
4. **Optional:** a third tab on http://localhost:5173/kiosk for the fallback live check-in (§4).
5. Window at 1440 px or wider; browser zoom 100%; notifications off.

Do not reset between rehearsal and the real demo unless you rehearsed on a different machine: signing a packet and answering a query change the state (a reset puts it back).

---

## 1. The morning queue (0:00–0:20)

**Click:** nothing yet. Tab A, Queue.

**Say:** "This is a research coordinator's Monday. The study is real: Regeneron's EMPOWER-Lung 1, cemiplimab in lung cancer, straight from ClinicalTrials.gov. The participants are synthetic. Overnight, three kiosk check-ins, a caregiver's phone call, an urgent-care record and an ER note came in. Interim has already read all of them. Published surveys put coordinators at twelve to fifteen hours a week per study retyping this kind of data. Here it is pre-filled, sorted by urgency, and every number links to where it came from. Up here: about N minutes of typing already pre-filled this week. That is an estimate, and 'How is this estimated?' shows every assumption."

**Point at:** the "Since you were last here" row; the tier names spelled out (Log · Review within 1 business day · Nurse call today · Urgent); the **SAE** and **AESI** clock chips; the "Time saved this week (estimate)" strip.

---

## 2. The ER note and the 24-hour report (0:20–1:15)

**Click:** the **P-006** row (chart note, Tier 2, **SAE** chip).

**Say:** "An ER note from another hospital: 'brought in by wife for new confusion and decreased appetite … Admitted overnight for IV fluids. Dexamethasone discontinued.' The scanner found two side effects, quoted the exact words, and saw the admission. A hospital stay makes this a possible serious adverse event, and the protocol says the sponsor must hear within 24 hours. The clock started when the site read the note, not when the patient went to the ER."

**Point at:** the highlighted words in the note; the drafted records (Confusion, Anorexia; grade hints labeled provisional); the stopped steroid flagged against the protocol; the SAE clock countdown.

**Click:** **Open report packet**.

**Say:** "This is the report a coordinator would type from scratch under a deadline. Every field is pre-filled from evidence; click any chip and you see the source. Below, what is still missing: last dose, action taken, outcome, causality. That is the coordinator's phone list. And a draft narrative. Every sentence is built from the facts and cites them, and it says 'written by template'. No language model wrote this; decisions come from rules, text from templates, and a person signs."

**Click:** a narrative sentence's evidence chip.

**Switch to Tab B (investigator):** open the same packet (Queue → P-006 → **Open report packet**) and click **Sign**, then confirm.

**Say:** "Only the investigator can sign. Signing stops the clock as 'reported (mock)' and posts the packet to our mock EDC. Nothing real is sent anywhere."

**Point at:** status **signed**, the clock decision "reported (mock)", the mock EDC acknowledgment id.

---

## 3. The protocol catches what a form would not (1:15–1:55)

**Back to Tab A, Queue. Click:** the **P-003** kiosk check-in row (Tier 2, **AESI** chip).

**Say:** "P-003 answered 'almost constantly' for diarrhea. That is a provisional grade 3. In this protocol, a grade 3 immune-related side effect is an adverse event of special interest, and it also has a 24-hour deadline. Interim reads that from the protocol itself: section 9.4.3, page 92. This was already a known side effect, so the new report is linked as a follow-up instead of a duplicate. An hour later the participant's daughter called about the breathing; that call is in the queue too, merged the same way."

**Point at:** the plain label "Side effect: diarrhea, severe (grade 3, provisional)"; the follow-up link to the open Diarrhea record; the Why panel's protocol rule with its page number; the **AESI** clock ("possible AESI, investigator to confirm").

**Click:** Queue → the **P-011** kiosk check-in row (Tier 1).

**Say:** "P-011 started prednisone. The protocol discourages systemic steroids except in an emergency or to treat an immune-related side effect. Interim flags it with the protocol's own words and page, and leaves the decision to people. No tier change."

**Point at:** the CM record `prednisone`, the **discouraged** flag with the exception text (§7.7.2, p. 69), and the list of medication fields still missing.

**Click:** **Confirm** on the itching AE.

**Say:** "Confirm, and the time-saved estimate counts the fields Interim pre-filled that nobody had to edit. Edit a field first and that field counts for nothing."

**Point at:** the strip's number going up (if asked "what if the inputs change?": open "How is this estimated?"; each line is fields × assumed minutes).

---

## 4. Sponsor queries and the visit brief (1:55–2:30)

**Click:** **Queries** in the top navigation.

**Say:** "When records reach the sponsor, their edit checks send questions back. This one is three days old: the Zofran record is missing dose, unit, frequency and indication, which the protocol requires. Interim already wrote a suggested answer from the record, with its sources. The coordinator adds the dose and answers in one step."

**Point at:** the open query (P-005, about 72 hours old), the suggested answer with evidence chips and "written by template". (Answering is optional on stage; the seed also has an answered one for P-003.)

**Click:** Queue → the **Visit brief** link on the **P-003** row.

**Say:** "P-003 has a visit tomorrow. This is the investigator's one-page brief: everything since the last visit three weeks ago, the diarrhea's grade over time, the call, the clocks, medication changes with protocol flags, and questions to ask at the visit. Every line links to its source. It prints."

**Point at:** the sections, the "Questions to ask" list, the background block labeled "Synthea synthetic EHR (simulated)", **Print**.

---

## 5. Change the input (2:30–2:50)

**Click:** **Eval** in the top navigation → the **Build your own persona** form.

**Say:** "You do not have to trust our screenshots. Change one answer and watch."

**Do:** set **diarrhea** frequency to **Almost constantly**, leave everything else at none, **Run this persona** → provisional grade 3, Tier 2, possible-AESI clock started, and the Why list names the protocol rule. Then change it to **Frequently** and run again → grade 2, Tier 1, **no** clock.

**Say:** "Same rules, same tables, every time. Our answer keys pass 36 of 36 check-in personas and every scanner case. On Synthea notes the scanner was never tuned on, it does worse, and we publish that too."

---

## 6. Audit and honesty (2:50–3:00)

**Click:** **Audit** → **Verify chain** → green "verified".

**Say:** "Every answer, rule, edit, signature and query is a hash-chained event. Interim is a research data-capture tool, not a medical device. And here is what it gets wrong." (Point at the footer; end on the "What it gets wrong" slide.)

---

## 7. Fallbacks

| If… | Do this |
|---|---|
| The queue is empty or shows no overnight rows | The seed did not run. `make demo-reset` (or Admin → Reset demo data), reload. |
| The SAE chip says overdue | The database is older than a day. Reset. |
| **Sign** is missing on the packet | You are in the coordinator tab. Use Tab B (investigator). |
| The packet is already signed | You rehearsed on this database. Show the signed state, then on the P-012 packet click **Start follow-up report** to show a follow-up with "changes since the previous report". Reset afterwards. |
| A stage-2 page errors | Use the check-in detail and note detail pages (steps 2–4 still work there) and narrate the packet from the printable page: `GET /api/v1/packets/{id}/print` from http://localhost:8000/docs. |
| A judge asks to try the kiosk | Tab C: http://localhost:5173/kiosk, type **P-007**, answer shortness of breath "Moderate" / "Somewhat", everything else none, hospital No, medicine Yes "loratadine" started. There is no consent screen (consent is covered at enrollment); the welcome screen says no video is stored. The vitals card shows **SIMULATED**. The new check-in appears in the Queue as Tier 1 (Review within 1 business day). |
| A judge asks about vitals | Vitals are optional context: they never change a grade and can raise the tier by one step at most. The demo source is a labeled simulation; the Presage camera source is implemented but has not run live (`docs/VITALS_SOURCES.md` §5). |

---

## 8. "What happens if we change the input?" (prepared answers)

| Change | What happens | Why |
|---|---|---|
| Diarrhea "Almost constantly" → "Frequently" | Grade 3 → 2, Tier 2 → 1, AESI clock not started | AESI needs grade ≥ 3 on a potentially immune-related item (`protocol_rules.json`, `irae_mapping.json`) |
| Severe itching with interference "Quite a bit" | Grade 3 → possible-AESI clock | Itching is in the dermatologic family (persona `P3-itching-g3-aesi-clock`) |
| Rash present at the kiosk | Grade 1 at most | Rash is a yes/no item; a grade 3 rash can only come from a note (`docs/WHAT_IT_GETS_WRONG.md` §23) |
| Medicine "bevacizumab" or "Avastin" | Tier at least 2, "possible protocol deviation" | Prohibited in §7.7.1, p. 69 (personas `P3-bevacizumab-prohibited-floor`, `P3-avastin-brand-prohibited`) |
| "hydrocortisone cream" | No steroid flag | Topical qualifier (persona `P3-hydrocortisone-cream-topical-no-flag`) |
| Hospital or ER = Yes | Tier 3, kiosk stop screen, mock page, SAE clock | Red flag and seriousness trigger |
| Paste "Discharged home. If symptoms worsen, go to the ER." on the Notes page (dry run) | Flags a hospital visit | A known false positive (`docs/ISSUES.md` #25); the investigator can stop the clock with "Record seriousness decision" |
| Simulated vitals with "treat as measured" on (Eval form) | Tier may rise by one; grade never changes | Vitals corroboration (`vitals_corroboration.json`) |

---

## 9. After the demo

- Point judges to `docs/eval/results.md`, `docs/eval/synthea_results.md` and `docs/WHAT_IT_GETS_WRONG.md`.
- `make demo-reset` before the next group.
