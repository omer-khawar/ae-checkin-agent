# Slide deck outline (12 slides)

> Target: 10–12 slides (Regeneron "Design & Packaging"). One idea per slide, light-on-white to match the product, no stock photos. Speaker notes are 60 words or fewer each; spoken time about 6 minutes without the live demo, which is `docs/DEMO.md` (3 minutes). Written for judges who are mostly **not clinicians**: plain words first, clinical terms only where they carry the point.

Screenshot checklist (1920×1080, light theme, zoom 110%, after `make demo-reset`; capture from the seeded Monday-morning state):

| Tag | What to capture | From |
|---|---|---|
| S-queue | Queue with the "Since you were last here" row, Tier 2 rows, SAE and AESI clock chips, the time-saved strip | `/dashboard` (coordinator) |
| S-note | P-006 ER note with "new confusion" and "Admitted overnight" highlighted, drafts, SAE countdown | `/dashboard/notes/:id` |
| S-packet | P-006 report packet: fields with evidence chips, missing-information list, narrative with per-sentence chips and "Written by template" | `/dashboard/packets/:id` |
| S-protocol | P-003 check-in: "diarrhea, severe (grade 3, provisional)", the AESI rule with "§9.4.3, p. 92"; P-011's prednisone "discouraged" flag with the exception text | `/dashboard/checkins/:id` |
| S-query | Queries page: the open Zofran query and its suggested answer | `/dashboard/queries` |
| S-brief | P-003 visit brief, top half | `/dashboard/participants/:usubjid/brief` |
| S-audit | Audit page, green "verified" | `/dashboard/audit` |
| S-eval | Eval results (tier table, grade matrix) + the Synthea headline table | `/dashboard/eval`, `docs/eval/synthea_results.md` |
| S-arch | Rendered Mermaid architecture diagram | `README.md` |
| S-kiosk | Kiosk question screen (optional) | `/kiosk` |

---

## Slide 1 — Title

**Content**
- **Interim** — the trial coordinator's safety-data desk
- "Side effects between visits, caught early and handed over ready to confirm."
- HackRU Fall 2026 · Regeneron "Best Clinical Trials Solution" · MIT · repo URL
- Footer: "Research data-capture tool. Not a medical device."

**Screenshot:** S-queue, small.

**Speaker notes:** Interim is a safety-data desk for the research coordinator at a clinical trial site. It catches side effects that happen between visits, from a kiosk, from hospital notes and from phone calls, and hands the coordinator records and reports that are already filled in. Rules decide, templates write, people confirm.

## Slide 2 — The problem: copying, deadlines, and missed side effects

**Content**
- Coordinators spend **12–15 hours per study per week** copying EHR data into the EDC (Mednet, via Clinical Trial Vanguard, 2026)
- Doctors miss **41–74%** of the side effects patients report (Di Maio, *J Clin Oncol* 2015)
- A serious event must reach the sponsor **within 24 hours** of the site learning about it (EMPOWER-Lung 1 protocol §9.4.2)
- Cemiplimab is given every 3 weeks: a symptom can be three weeks old before anyone asks

**Screenshot:** none; three large numbers.

**Speaker notes:** Three facts. Coordinators spend twelve to fifteen hours a week per study retyping data that already exists. Doctors miss between forty and seventy-four percent of the side effects patients report. And when something is serious, the sponsor must hear within twenty-four hours. That is a day of clerical work under a deadline, on top of everything else.

## Slide 3 — The life of one side effect

**Content** (a horizontal timeline, one icon per step; the steps Interim handles are colored)
1. The participant feels something
2. It is mentioned: kiosk, chart note, phone call
3. The coordinator finds it
4. It is typed into the record and the EDC
5. If serious: a report within 24 hours
6. The investigator decides seriousness and cause
7. The sponsor sends questions back
8. Before the next visit, the investigator is briefed

**Screenshot:** none; the timeline.

**Speaker notes:** This is the life of one side effect at a trial site. Today, every step after the first is manual. A starter sheet would stop at step four. We followed it all the way: the 24-hour report, the investigator's decision, the sponsor's questions, and the brief before the next visit. All eight steps run in Interim.

## Slide 4 — Monday morning (live demo)

**Content**
- Overnight: 3 kiosk check-ins, 1 caregiver call, 1 urgent-care record, 1 ER note
- Interim already: found the side effects with exact quotes · merged repeats · started the 24-hour clock · pre-filled the report and drafted its narrative · flagged a discouraged steroid · built tomorrow's visit brief
- On screen: "≈ N minutes of coordinator time saved this week (estimate)", N read live from the seeded demo (about 75 on a fresh seed, about 150 after confirming the overnight records); basis on hover, one measured rate, the rest labeled assumptions
- QR code / URL to the repo; `docker compose up`

**Screenshot:** S-queue (large), S-packet (inset).

**Speaker notes:** Here is the coordinator's Monday. Everything that came in overnight is already read, sorted and pre-filled. Watch the ER note become a pre-filled 24-hour report with a drafted narrative, signed by the investigator. Then a sponsor question with a suggested answer, and tomorrow's visit brief. Then you change an input and watch it change.

## Slide 5 — Rules decide, templates write, people confirm

**Content**
| Who | Does what | Example |
|---|---|---|
| **Rules** (JSON tables, each with source and rationale) | Every decision | Grade 3 + immune-related → 24-hour AESI clock (protocol p. 92) |
| **Templates** | Every sentence of generated text, each citing its evidence | Each narrative sentence ends in chips that open its sources |
| **People** | Every confirmation and signature | Only the investigator signs a report |
- No language model runs in the demo or the evaluation. Every decision is a table lookup you can read; every sentence is a template that cites its evidence.

**Screenshot:** S-packet narrative with evidence chips.

**Speaker notes:** No decision depends on generated text. Rules make every decision, from tables anyone can read. Templates write the narratives, and every sentence points to its source. No language model runs anywhere in what you are seeing. And nothing leaves without a person confirming or signing it.

## Slide 6 — It reads the real protocol

**Content**
- Rules taken from the public EMPOWER-Lung 1 protocol, with page numbers:
  - **Special-interest events** (§9.4.3, p. 92): grade 3 immune-related → 24-hour clock
  - **Serious events** (§9.4.2, p. 91): 24 hours, regardless of cause
  - **Prohibited medicines** (§7.7.1, p. 69): bevacizumab → "possible protocol deviation"
  - **Discouraged medicines** (§7.7.2, p. 69): steroids → flag with the protocol's exception text
  - **Medication form fields** (§7.7, p. 69): what is still missing
- Verbatim excerpt cached with its sha256

**Screenshot:** S-protocol.

**Speaker notes:** A generic form would miss that a severe immune-related side effect in this trial has the same 24-hour deadline as a hospital stay. Interim encodes the real protocol, page by page, and cites the page on screen. It also catches a steroid the protocol discourages, quoting the protocol's own exception, and leaves the decision to the investigator.

## Slide 7 — Every number shows its evidence; every action is on the record

**Content**
- Click any field: the answer, the quoted note words (with character offsets), the rule, the table
- Plain words first; SDTM names one click deeper
- Edits create versions; nothing is overwritten
- Hash-chained audit log; one click to verify
- Time saved shown as an **estimate**, with its basis on hover

**Screenshot:** S-note (evidence highlight) and S-audit.

**Speaker notes:** Every value on screen links to where it came from: an answer, the exact words of a note, a rule and its table. Every change is a new version, every action an audit event, and the chain verifies with one click. The time-saved number is labeled an estimate, and you can see exactly how it was computed.

## Slide 8 — Evaluation, including data we never tuned on

**Content**
- Answer keys, replayed through the running API: **36/36 personas**, **3/3 counterfactuals** (tier moves, grade does not), **38/38 scanner cases**, **8/8 notes**
- Those are regression tests. The independent test: **Synthea** synthetic charts (12 lung-cancer patients, 72 notes)
  - Symptoms: precision 0.92, recall 0.79
  - Medications in the text: precision 1.00, recall 0.18
  - 56% of routine visits over-flagged (templated "chest pain")
- `make eval` regenerates `docs/eval/results.md`

**Screenshot:** S-eval.

**Speaker notes:** On our own answer keys we pass everything, but we wrote those keys, so that only proves the rules do what the tables say. So we also ran the scanner on Synthea charts it had never seen. Symptoms hold up; medication recall is poor, and templated text over-flags. We publish those numbers, not just the good ones.

## Slide 9 — What it gets wrong

**Content**
- The questionnaire-to-grade mapping is our approximation, not a validated crosswalk
- The scanner finds only words in its lexicon; "go to the ER if it worsens" starts a false serious-event clock
- Template text is stiff and cannot fill in facts it does not have (it lists them as missing instead)
- Time saved: one measured rate, the rest labeled assumptions
- Which symptoms count as "possibly immune-related" is our reading of the protocol
- Kiosk rash is yes/no, so it can never reach grade 3
- Camera vitals: Presage's documented pulse range ends at 110, exactly where our pulse rules start; never run live

**Screenshot:** none.

**Speaker notes:** We can name what Interim gets wrong. The grade mapping is an approximation. The scanner reads discharge advice as a hospital visit. Template text is stiff. The time-saved figure rests on assumptions we label. And our camera vendor's pulse range stops where our pulse rule starts. Every one of these is documented with an example you can reproduce.

## Slide 10 — What we chose not to build

**Content**
- **A language-model chart reader**: deferred; the deterministic scanner stays, measured and explainable
- **Voice check-in**: disclosure rules for automated calls; the kiosk and logged calls cover the need
- **Real EDC and safety-database integration**: mock EDC with SDTM-shaped records shows the seam
- **Sponsor-side query portal**: the admin plays the monitor
- **Multilingual items**: our wording is not a validated translation
- **Arduino sensor**: slot exists · **Presage camera**: implemented, not yet run live

**Screenshot:** none.

**Speaker notes:** These are decisions, not gaps we hid. We deferred a language-model chart reader because we could not validate it in a weekend. Voice, real EDC connections, a sponsor portal and translations each need things a hackathon cannot give: compliance rules, credentials, licensed translations. Each has a documented seam where it would plug in.

## Slide 11 — Ready to deploy

**Content**
- `git clone` → `docker compose up --build` → kiosk, dashboard, API docs
- CI on every push: lint, strict types, tests, deterministic eval, Docker build
- Configuration only through environment variables; no secrets in the repo
- Roles enforced on the server; only the investigator signs
- MIT license; SQLite by default, Postgres by one variable
- Production still needs: single sign-on, Part 11 signatures, real EDC connectors, licensed terminologies

**Screenshot:** S-arch.

**Speaker notes:** It runs from a clean clone with one command, on a laptop that is not ours. CI checks every push, including the evaluation. Configuration is environment-only, roles are enforced by the server, and the license is MIT. We also list plainly what production would still need: single sign-on, electronic signatures, and real EDC connections.

## Slide 12 — Team and credits

**Content**
- Team names and roles
- **Omer Khawar** — AE Capture Desk: the chart-note scanner and the Presage groundwork (in `legacy/`)
- **Synthea** (MITRE, Apache-2.0) · **Presage** SmartSpectra SDK · NCI PRO-CTCAE and CTCAE · Basch et al. 2021 · ClinicalTrials.gov · openFDA · CDISC
- Repo URL · `docs/DEMO.md` · `docs/WHAT_IT_GETS_WRONG.md`

**Screenshot:** none.

**Speaker notes:** Thank you. Interim builds on Omer Khawar's AE Capture Desk, on Synthea's synthetic patients, and on public data from ClinicalTrials.gov, openFDA and NCI. The repository has the demo script, the evaluation, and the list of what it gets wrong. We would love you to change an input and try to break it.
