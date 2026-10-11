# Interim demo video: browser walkthrough script (for an AI agent)

You are driving a web browser to record a product demo video of **Interim**. A person is screen-recording you and will add a voiceover later. You have no other context; everything you need is in this file. Follow it in order.

## What Interim is (read once, do not show this)

Interim is a tool for clinical trial **research coordinators**. Between study visits, trial participants have side effects. These get reported at a check-in kiosk, in phone calls, or in hospital notes. Today a coordinator finds each one by hand, retypes it into the trial database, and, if it is serious, writes a report to the drug sponsor within 24 hours. Interim does that prep work: it finds side effects, pre-fills the records with evidence, starts the 24-hour clocks, drafts the report, and builds a one-page brief before the next visit. **Rules decide, templates write, people confirm.** All participants are synthetic (fake). The study is a real public one: Regeneron's EMPOWER-Lung 1 (cemiplimab, lung cancer).

## Rules for recording

1. **Go slowly.** After every page loads, wait **3 seconds** before doing anything. After every click that changes the screen, wait **3 seconds**. Where a step says "hold", stay still for that many seconds.
2. **Point with the mouse.** When a step says "point at X", move the mouse onto X and leave it there for 2 seconds. Move the mouse in smooth, direct paths. Never wiggle it.
3. **Scroll smoothly**, in small steps, never jumping to the bottom.
4. **Only use the app at http://localhost:5173.** Do not open other websites, settings, dev tools, or new windows beyond the tabs listed here.
5. **Never** click "Reset demo data", "Sign out", or anything on the Admin page.
6. If something on screen does not match a "You should see" line, **stop and say what you see**. Do not improvise or try to fix it.
7. Do not type anything except what this file tells you to type.
8. **To open a row in a table, click its date in the "Received" column** (not the participant name, unless a step says so).
9. Total target length: about **3 to 4 minutes** of on-screen action.

## Before you start (setup check, not recorded)

The person has already started the app. Check that http://localhost:5173 loads a landing page that says "Interim". If it does not, stop and tell the person.

Prepare **two tabs**:

- **Tab 1 (coordinator):** go to http://localhost:5173/login. Pick **Coordinator / research nurse**, password `interim-demo`, sign in. You land on the **Worklist** (a table titled "Queue").
- **Tab 2 (investigator):** open a new tab, go to http://localhost:5173/login. Pick **Investigator**, password `interim-demo`, sign in. Leave it on the Worklist.

Switch back to **Tab 1**. Tell the person: "Ready. Start recording, then tell me to go." Wait for their go.

---

## Shot 1. The landing page (about 15 s)

1. In Tab 1, go to http://localhost:5173/ (the landing page). Hold 4 s on the top section.
2. Scroll down slowly through "The problem" and "How it works" sections (about 6 s of scrolling), then scroll back to the top.
3. Click **Open the coordinator desk**. You should see the Worklist.

## Shot 2. The Monday-morning worklist (about 25 s)

You should see: a header bar with **Worklist, Queries, Escalations, Notes**; a chip that says "≈ N min saved" with the word **estimate**; a line starting **"Since you were last here"**; a table with tier badges such as **Urgent** and **Nurse call today**; chips like **SAE 20h 10m left** and **AESI 13h 20m left** (the exact hours differ every run).

1. Hold 3 s.
2. Point at the **"Since you were last here"** line.
3. Point at the **"≈ N min saved · estimate"** chip in the header. Click it, hold 4 s on the explanation that opens, press Escape.
4. Point at a **Nurse call today** badge, then at the **SAE …h left** chip, then at the **AESI …h left** chip.
5. Point at one **SIMULATED** badge in the Vitals column.

## Shot 3. The ER note and the serious-event report (about 50 s)

1. Find the row for **P-006** whose source is **Chart note** (Emergency department note) and that has an **SAE** chip. Click its date in the Received column. You should see the chart note page: the note text with highlighted words ("ED visit", "new confusion", "decreased appetite", "Dexamethasone"), a red **SAE clock started** box, and a **Drafts** column.
2. Point at the highlighted words in the note text, one by one (1 s each).
3. Point at the red **SAE clock started** box.
4. Scroll down slowly through the **Drafts** column (about 5 s), then back up.
5. Click **Open report packet**. You should see a page titled **Serious event report** with sections **Report fields**, **Narrative** (labeled **Written by template**), **Information still needed** and **Evidence**.
6. Scroll slowly to the **Narrative** section. Point at the **Written by template** label. Click one evidence chip next to a narrative sentence; hold 3 s on what opens; close it (Escape).
7. Scroll to **Information still needed** and point at the list.
8. Switch to **Tab 2 (investigator)**. Click the date of the same **P-006** chart-note row (with the SAE chip), then **Open report packet**.
9. Click **Sign**. A confirmation box appears. Tick **"I reviewed the narrative and every field."** Then tick **Not available** next to every listed missing item (there are several). Click **Yes, sign the report**.
10. You should see the packet marked **Signed** and the clock recorded as **reported (mock)**. Hold 4 s.

## Shot 4. A protocol rule catches a special-interest side effect (about 35 s)

1. Switch back to **Tab 1**. Click **Worklist** in the header.
2. Find the **P-003** row whose source is **Check-in** and that has an **AESI** chip. Click its date. You should see the check-in page: answers on the left, side-effect records in the middle, a **Why** panel on the right.
3. Point at the side effect **Diarrhea, severe (grade 3, provisional)** record.
4. In the **Why** panel, make sure **Explain in plain English** is ticked. Scroll the Why panel slowly to the rule that mentions the protocol page (section 9.4.3, p. 92) and point at it.
5. Click any field value in a side-effect record (for example the severity grade). An evidence panel opens showing exactly which answer it came from. Hold 4 s, then press Escape.

## Shot 5. A discouraged steroid (about 25 s)

1. Click **Worklist**. Find the **P-011** row whose source is **Check-in**. Click its date.
2. Scroll to the medication record for **prednisone**. Point at the **Discouraged by protocol §7.7.2** flag and hold 3 s.
3. Find a side-effect record with a **Confirm** button and click **Confirm**. Hold 3 s.
4. Point at the **"≈ N min saved"** chip in the header (the number may have gone up).

## Shot 6. Sponsor query (about 20 s)

1. Click **Queries** in the header. You should see a table of queries; one for **P-005** is about 3 days old.
2. Click that query row. A side panel opens with a **Suggested answer**, evidence chips and **Written by template**. Hold 4 s.
3. Close the panel (Escape). Do not send the answer.

## Shot 7. Visit brief (about 25 s)

1. Click **Worklist**. In any **P-003** row, click the participant name **P-003** itself. You should see the participant page with tabs (Overview, Symptoms, Medicines, Notes & calls, Reports). Hold 3 s.
2. Click the **Visit brief** button (top right). You should see a one-page **visit brief**. Scroll slowly through it (about 8 s): new side effects with grade trend, medication changes, clocks, and **Questions to ask** at the visit.
3. Scroll back to the top. Point at the **Print** button (do not click it).

## Shot 8. Change the input (about 30 s)

1. Click **System** (gear icon) in the header, then **Eval**.
2. Find the **Build your own persona** form. Set **diarrhea** to **Almost constantly**; leave everything else as is. Click **Run this persona**. Hold 4 s on the result (grade 3, tier "Nurse call today", a possible-AESI clock).
3. Change **diarrhea** to **Frequently**. Click **Run this persona** again. Hold 4 s (grade 2, tier lower, no clock).

## Shot 9. Audit trail and close (about 15 s)

1. Click **System** → **Audit**. Click **Verify chain**. You should see a green **verified** result. Hold 4 s.
2. Scroll to the bottom of the page and point at the footer sentence: "Interim is a research data-capture tool. It is not a medical device and does not provide medical advice." Hold 4 s.
3. Tell the person: "Done. You can stop recording."

---

## Optional Shot 10. The patient kiosk (only if the person asks for it)

1. Open a new tab at http://localhost:5173/kiosk.
2. Type **P-007** as the study ID and continue.
3. Answer one question per screen: shortness of breath **Moderate**, then **Somewhat**; every other symptom **None** / **Never** / **No**; hospital or emergency room **No**; started or stopped a medicine **Yes**, type `loratadine`, **Started**; leave "anything else" empty.
4. On the review screen, hold 3 s, then send it. Hold 4 s on the thank-you screen.
