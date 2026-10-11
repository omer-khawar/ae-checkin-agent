# UI audit: information architecture, navigation and data display (coordinator console)

Lens: how a trained coordinator finds, scans and acts on work. Method: ui-ux-pro-max Quick Reference priorities 1 to 10 (rule ids cited inline), skill searches for `ux` (navigation, tables) and `chart` (time series), screenshots `c01`–`c17` in `.playwright-mcp/ui-audit/`, and code in `apps/web/src` (`App.tsx`, `components/Layout.tsx`, `pages/dashboard/**`). Report only. Nothing in `apps/`, `packages/`, `scripts/` or other `docs/` files was changed.

Constraints that any redesign has to keep:

- The not-a-medical-device footer, word for word, on every page.
- MEASURED or SIMULATED as a visible word beside every vital.
- Click-to-evidence on every derived field.
- No grades, tiers or clinical language on the kiosk.
- Tier names spelled out (for example "T2 · Nurse call today").

---

## 1. Headline

The console is built like a set of explainer pages, not a workstation.

- **Where the work lives.** Coordinator work is spread across three inboxes that overlap (Queue, Escalations, Queries) and a fourth page that mixes data entry with a list (Notes).
- **No way in by participant or report.** There is no participant list and no list of reports. A participant who has no open queue row can only be reached by typing their ID into a filter. Report packets can only be reached through links on other pages.
- **The header is too tall.** It is two rows and about 170 px tall (22% of a 1366×768 screen). It truncates the study title ("Study of REG…") and puts a time-saved figure and demo/judge tools (Audit, Eval) on the same level as daily work.
- **Queue rows are too tall.** At 1366 px the Queue shows 1.5 rows above the fold. Rows are about 155 px tall because the Vitals cell wraps "Simulated (ignored for rules)" onto three lines. Only 8 of 10 columns fit, so the table scrolls sideways.
- **Tables can't be sorted.** No table in the app has sortable columns (`grep aria-sort` → 0 hits).
- **No terminology system.** One concept has up to five names: tier / priority / alert / alert level / escalation.
- **Formats vary.** Dates appear in four formats, including raw `2026-10-10T17:10:29.487Z`. IDs appear in two (`P-003` and `R2810-ONC-1624-P-003`).
- **Pitch copy on staff pages.** Judge-facing explanation is printed on staff pages: "nothing is re-ranked in the browser", "regex + NegEx", "(D-017)", "CLAUDE.md §8", "Answer key for this sample".

Recommended direction:

- One worklist with tabs, as the landing page.
- A participant hub that every ID links to.
- A Reports list.
- A single-row app bar with a jump-to-participant box.
- Demo tools moved into a separated menu, with a toggleable "Demo guide" layer for the explanations.
- Dense, sortable, keyboard-driven tables.
- A per-user switch between plain labels and SDTM codes.

---

## 2. Measurements

| Check | Current | Target |
|---|---|---|
| Header height (c01, 1366×768) | ~170 px, 2 rows | 48 px app bar + 44 px page header |
| Queue rows visible above fold at 1366×768 (c01) | 1.5 | ≥ 12 (36 px rows) |
| Queue first-row y-offset (c01) | ~537 px | ~180 px |
| Queue columns visible at 1366 without horizontal scroll (c01) | 8 of 10 (Alert clipped; Drafted records + Open off-screen) | all, ≤ 8 columns after merges |
| Queue page length, 25 rows at 1440 (c02) | ~4,440 px | ~1,100 px |
| Sortable tables in the app | 0 | every list table |
| Routes with own `document.title` | 0 (every tab reads the same) | all |
| List pages with filters in the URL | Queue, Queries, Brief, Packet (4); Escalations, Notes, Timeline, Audit are not | all |
| Ways to reach a participant with no open queue row | type ID in Queue filter + set Status = All + click (4 actions) | 1 (Participants list or jump box) |
| Ways to list all report packets / everything awaiting investigator signature | none | Reports page, 1 click |
| Clicks from login to P-003's open AESI report | Escalations → scroll to clocks table → Open report packet (2 + scroll), or Queue → Open → scroll ~1,800 px to Why panel → Open report packet | Reports → row (2), or worklist tab "Report clocks" → row (2) |
| Names for the escalation tier concept | Priority (Queue column), Alert (Queue column, ack status), Alert level (Why panel), Tier (Escalations), Escalation (nav) | Tier, with the ack status called "Acknowledged" |
| Date formats on screen | `Oct 10, 01:15 PM`; `Oct 10, 2026, 11:52:08 PM`; `2026-10-09`; `2026-10-10T17:10:29.487Z` | one display format + UTC on hover |
| Body text contrast `text-slate-400` (#94A3B8) on white, used for "—", "no detail", separators | 2.56 : 1 (fails `color-contrast`) | slate-500 #64748B 4.76 : 1 minimum; slate-600 #475569 7.6 : 1 for secondary text |
| Brief page: share of the "In one paragraph" panel that repeats the left column (c08) | ~100% (every sentence restates a left-column card) | collapsed by default / print-only |
| Timeline: symptom small multiples that are flat G0 for every check-in (c09, P-003) | 7 of 10 (≈ 60% of chart area shows no information) | heatmap grid, 1 row per symptom |
| Time-saved strip: change caused by opening one visit brief | ≈ 28 min → ≈ 1.1 h (one `brief.generated` = 7 sections × 5 min = 35 min) | strip off the global chrome; breakdown visible |

---

## 3. Findings

Priority: P0 blocks the demo or fails accessibility; P1 has a clear workflow cost; P2 is polish. Kind: CHANGE / ADD / REMOVE / FORMAT.

### Global shell and navigation

**IA-01 · P1 · CHANGE · Header (all c*, `Layout.tsx`)**
- **Problem.** The header is two rows, about 170 px tall, at 1366 px. The study title is truncated to "Study of REG…" and the "Demo study (public registry record)" chip wraps to three lines. The user name is shown twice ("Demo Coordinator (research nurse) · Coordinator / research nurse"). "Open kiosk" is a link at the far right, next to Sign out (`destructive-nav-separation`).
- **Why it matters.** The header takes 22% of the viewport on every page. A coordinator on a 1366 laptop loses the rows they came for.
- **Recommendation.** A single 48 px app bar:
  - `[Interim]  Worklist · Participants · Reports · [+ New ▾]` on the left.
  - `[Jump to participant…  /]  [NCT03088540 · Synthetic data ▾]  [Demo Coordinator ▾]` on the right.
  - The study pill opens a popover with the full title, phase, sponsor and registry link. The user menu holds role, Sign out (separated by a divider), and the Demo tools group (IA-03).

**IA-02 · P1 · CHANGE · Nav active state on detail pages (c03, c06, c08, c09, c15)**
- **Problem.** On check-in detail, packet, brief and timeline, no nav item is highlighted (`nav-state-active`). Note detail does highlight Notes, so the behaviour is inconsistent.
- **Why it matters.** Users lose their place. "Where am I" is answered only by the page title.
- **Recommendation.** Every route maps to a nav section:
  - check-in, note and call detail → Worklist
  - participant hub, brief and timeline → Participants
  - packets → Reports

  Use a 2 px bottom indicator plus semibold weight on the active item, not only a background tint.

**IA-03 · P1 · CHANGE · Nav items Audit, Eval, Admin (all c*)**
- **Problem.** Audit, Eval and Admin sit in primary nav at the same weight as Queue (`nav-hierarchy`). Eval and Admin are judge/demo tools. Audit is an occasional QA task.
- **Why it matters.** The primary nav says "this is a demo" before it says "this is your desk". Six to seven equal items dilute the daily ones.
- **Recommendation.** Move these into a visually separated "System" group in the user menu (or a right-aligned overflow, `overflow-menu`): Audit trail · Evaluation · Admin (admin only) · Open kiosk · Demo guide on/off. Keep the routes and deep links unchanged so DEMO.md steps still work.

**IA-04 · P1 · ADD · Jump-to-participant (global)**
- **Problem.** There is no global search (`search-accessible`). The only participant lookup is the Queue's "Participant" filter.
- **Why it matters.** Coordinators work by subject ID all day ("P-007 just called").
- **Recommendation.** Add a header combobox, focused with `/` or Ctrl+K. Typing "7" or "P-007" or the full USUBJID lists matches; Enter opens the participant hub. Also accept a check-in, note or packet ULID prefix.

**IA-05 · P2 · ADD · Document titles (`App.tsx`, no `document.title` anywhere)**
- **Problem.** Every browser tab reads the same title.
- **Why it matters.** Coordinators keep several participants open in tabs.
- **Recommendation.** Set titles per route, for example "P-003 · Check-in Oct 10 · Interim", "Worklist (7) · Interim", "AESI report P-003 · Interim".

**IA-06 · P2 · ADD · Skip link and focus on route change (`Layout.tsx`)**
- **Problem.** There is no "Skip to main content" link (`skip-links`), and focus is not moved to `<main>` or the h1 on navigation (`focus-on-route-change`).
- **Recommendation.** Add a skip link as the first focusable element. Focus the h1 after each route change.

**IA-07 · P1 · CHANGE · Breadcrumbs (c03, c05, c08, c09, c12)**
- **Problem.** Breadcrumbs are inconsistent across pages (`breadcrumb-web`):

  | Page | Current breadcrumb |
  |---|---|
  | Check-in detail | "Queue / check-in 01M4MHCCNR49JZKABTQDF9DMQR" (raw ULID) |
  | Timeline | "Queue / Participant timeline" |
  | Packet | "Queue / P-003 / Report" (P-003 is not a link) |
  | Note detail | "← All chart notes" |
  | Brief | an eyebrow "VISIT BRIEF" with no breadcrumb |

- **Recommendation.** One Breadcrumb component: Section › Participant › Object. For example "Worklist › P-003 › Check-in Oct 10, 1:10 PM" or "Reports › P-003 › AESI report v1". The participant crumb always links to the hub. Keep ULIDs in a copy-to-clipboard chip, not in the crumb.

### Three inboxes and the landing page

**IA-08 · P1 · CHANGE · Queue, Escalations and Queries pages (c01/c02, c10, c07)**
- **Problem.** There are three inboxes, and they overlap:
  - Queue already shows tier, acknowledgement status ("Alert" column) and report clocks ("Report due").
  - Escalations re-lists the same tier ≥ 2 items with reasons, plus a second table of the same clocks.
  - Queries is a third list.
  - Notes is a fourth (ingested notes, with Tier).
  - "Since you were last here" counts across all of them.
- **Why it matters.** A nurse has to visit four pages to answer "what do I do next". The same item appears in up to three places with different column names.
- **Recommendation.** One Worklist page with tabs whose counts update live:
  - **To review** (check-ins, chart notes and calls with open drafts; current Queue default)
  - **Needs acknowledgement** (tier ≥ 2 not acked; current Escalations "Open")
  - **Report clocks** (running 24 h SAE/AESI clocks with countdowns; current Escalations clocks table)
  - **Sponsor queries** (current Queries Open/Answered/Closed as a sub-filter)
  - **Done** (confirmed, acked, signed in the last 7 days)

  The tables share one column model and one filter bar (participant, tier, source, date). The tab and filters live in the URL (`deep-linking`). The current Escalations KPIs (median time to acknowledge, pages sent) become one line of stats under the tabs. The pager log moves to Audit.

**IA-09 · P1 · CHANGE · Landing page after login (`Login.tsx` navigates to `from`, default `/dashboard`)**
- **Problem.** Every role lands on the same Queue. The investigator's job (sign packets, decide AESER/AEREL/IRAE) has no inbox. In c15 the investigator must open each packet and scroll to fields 21–23 of 23.
- **Why it matters.** The investigator is the bottleneck on the 24 h clock, and the UI never shows them their pile.
- **Recommendation.** Land each role on its own view:
  - Coordinator → Worklist / To review.
  - Investigator → Worklist with an "Awaiting investigator" tab: packets to sign, sorted by time left; drafts with AESER/AEREL undecided; acks.
  - Admin → /admin.

  In the packet, pin the three investigator-decision fields and "Sign" into the sticky action bar for the investigator role. Today "Sign" is styled as a secondary button while a disabled "Save" is the teal primary (`primary-action`).

**IA-10 · P1 · CHANGE · "Since you were last here" (c01, `queue/SinceLastHere.tsx`)**
- **Problem.**
  - The six count chips ("3 check-ins", "7 need action", "2 report clocks running") are styled like buttons (bordered, coloured) but are `<li>` elements with no link or handler. They look clickable and do nothing (`state-clarity`, `hover-vs-tap`).
  - "Mark all as seen" is unstyled text.
  - The panel and the filter card take about 200 px above the table.
- **Recommendation.** Fold the counts into the Worklist tab badges, so they become the navigation. Keep one compact line: "Since Sun 6:02 PM: 3 check-ins · 3 chart notes · 1 call · [Show only new]". Rows that arrived since the last visit get a 6 px unread dot in the first column (`tab-badge`: clear it after the row is opened). "Mark all as seen" becomes a small secondary button.

**IA-11 · P1 · CHANGE · Notes page (c11)**
- **Problem.** One page holds three jobs (`progressive-disclosure`):
  - an ingest form with a "Load sample" picker and a visible "Answer key for this sample"
  - a "Log a call" form
  - a list of ingested notes

  "Log a call" also exists on the timeline. The list duplicates rows already in the Queue (source = Chart note / Phone call).
- **Why it matters.** Entering a note is a quick, interruptive task ("phone rang"). It should not need a page change. The answer key is judge material.
- **Recommendation.**
  - Add "+ New ▾" (Chart note | Phone call) in the app bar. It opens a right-side sheet (480 px) with the form, prefilled with the participant when launched from the hub. The dry-run scan result shows in the sheet.
  - The ingested-notes list becomes the Worklist with Source = Chart note/Call.
  - "Load sample" and "Answer key" move into the Demo guide layer (IA-22).

### Participant-centric hub

**IA-12 · P1 · ADD · Participants list (no route exists)**
- **Problem.** There is no roster of the 12 participants.
- **Why it matters.** It is the most basic site view. Without it, "how is P-008 doing" has no path.
- **Recommendation.** Add `/dashboard/participants`: a sortable table with these columns:
  - Participant (P-003; USUBJID on hover)
  - Last check-in
  - Next visit
  - Open AEs (count + highest provisional grade)
  - Running clocks (countdown)
  - Open queries
  - Open drafts
  - Vitals source of last check-in (SIMULATED/MEASURED word)

  The row opens the hub.

**IA-13 · P1 · CHANGE · Participant timeline / brief / packets / queries (c08, c09)**
- **Problem.** Participant information is scattered across separate pages with ad-hoc cross-links:
  - Timeline links to Brief.
  - Brief links back to the timeline.
  - Packets are reachable only from the check-in Why panel, Escalations or brief chips.
  - Queries for a participant are not reachable from the participant at all.
  - In the Queue, the participant label links to the timeline (underline only on hover), with a separate tiny "Brief" link beneath it.
- **Recommendation.** One hub at `/dashboard/participants/:usubjid` with a persistent header and tabs:
  - **Header:** P-003 · USUBJID · enrolled · next visit · SYNTHETIC badge · open-clock countdown · [Log call] [Add note] [Print brief].
  - **Tabs** (each its own URL; existing routes become redirects or aliases):
    - Overview (current timeline)
    - Visit brief
    - Side effects (open/resolved AEs with follow-up links)
    - Medications
    - Reports (packets)
    - Queries
    - Activity (check-ins, notes, calls, filtered audit)

  Every participant ID anywhere links to the hub.

**IA-14 · P1 · FORMAT · Participant IDs (c10 Escalations, c13 Audit vs c01 Queue)**
- **Problem.** Escalations and Audit show "R2810-ONC-1624-P-003" wrapping over three lines in a 90 px column. Queue, Brief and Notes show "P-003".
- **Recommendation.** Always display the short label (P-003) as the link. Show the full USUBJID in a tooltip and on the hub header. In exports and the packet field list, show the full USUBJID.

### Explanatory copy and the demo-guide layer

**IA-15 · P1 · REMOVE · Pitch and developer copy on staff pages**
- **Problem.** Staff pages carry copy written for judges and developers. Examples:
  - Queue: "Order comes from the rules engine on the server; nothing is re-ranked in the browser."
  - Escalations: "Acknowledging writes an audit event…" in the subtitle. The reasons column contains "(D-017)" and "A note never pages or stops a kiosk and never reaches Tier 3".
  - Notes: "regex + NegEx exclusions, no language model".
  - Eval and Admin: "CLAUDE.md §8".
  - Admin: "PUT /api/v1/admin/settings · admin only · audited".
  - Queue filter: "Include eval runs (harness sessions)".
  - Packet: a 3-line intro paragraph.
- **Why it matters.** The user said "no eye candy … power and functionality". Explanatory paragraphs push the work below the fold and read as a sales pitch. Decision IDs and file paths mean nothing to a nurse.
- **Recommendation.**
  - Page subtitles become at most one line of operational fact, or nothing.
  - Move every "how it works / why it is trustworthy" sentence into a Demo guide layer (IA-22).
  - Strip "(D-0xx)", "CLAUDE.md", HTTP verbs and paths, and "harness" from rendered text on non-admin pages. Keep them in tooltips on Admin only.
  - Rename "Include eval runs" to "Show test runs", inside a "More filters" popover.

**IA-16 · P1 · CHANGE · Time-saved strip (all c*, `TimeSavedStrip.tsx`, `services/metrics.py`)**
- **Problem.** The strip is in the global header of every page, the investigator's included, and it reports "coordinator time". It is labelled "estimate" with a basis disclosure, which is good. But simply opening one visit brief (c08) moved it from ≈ 28 min (c01) to ≈ 1.1 h, because `brief.generated` credits 7 sections × 5 min = 35 min. The credit is deduplicated per participant per visit, but one page view still provides more than half of the week's figure.
- **Why it matters.** A judge who asks "what happens if I open a brief" sees the number jump by more than half. That reads as gaming the metric, and its placement in the chrome reads as marketing.
- **Recommendation.**
  - Remove the strip from the global header.
  - Show it on the Worklist "Done" tab footer, or in the Demo guide, as "≈ 1.1 h estimated this week". Render the category breakdown inline (fields pre-filled · packets signed · briefs used) rather than behind a link.
  - Count a brief only when it is printed or marked "used at visit", not on view. This is an API change; log it for the backend owner.
  - Hide the strip for the investigator role.

**IA-17 · P2 · CHANGE · Brief "In one paragraph" panel (c08)**
- **Problem.** The right column restates every card of the left column sentence by sentence. Each sentence carries 2–8 evidence chips ("Record ..166ETK", "Answer ..XV25JD"). The page is about 3,240 px tall at 1440 px, and most of it is a duplicate.
- **Recommendation.** Make the left column the brief. Keep the narrative paragraph, collapsed, as "Narrative (for the visit note)", and expanded in print. Replace per-sentence chip rows with a single "6 sources" chip that expands on click (click-to-evidence is preserved). Move "Questions to ask at the visit" to the top of the right column as the sticky checklist.

### Terminology

**IA-18 · P1 · FORMAT · Terminology (all c*)**
- **Problem.** Several concepts have more than one name:

  | Concept | Names in use |
  |---|---|
  | Escalation tier | "Priority" (Queue column), "Alert" (Queue column meaning ack status), "Alert level" (Why panel), "Tier" (Escalations), "Escalation" (nav) |
  | Side effect | "Side effects (AE)", "New side effects" and "Open adverse events" (same page, c08), "Side effect, in the participant's or note's words" |
  | Report | "Report packet", "Report", "Special-interest event report", route `/packets` |
  | Check-in | "check-in" in the UI vs "session" in the audit log and URL param |
  | Notes and calls | "Notes" (nav), "Chart notes" (title), "Chart notes and calls", "Phone note" (note type), "Phone call" (chip) |
  | Report clock | "Report due", "24-hour report clock", "SAE clock", "report clocks running" |
  | Grade | "Grade 2 provisional", "G2", "grade 2", AETOXGR |

- **Recommendation.** Publish a glossary in `docs/` and the Demo guide, and apply it:
  - **Tier** (T0 Log / T1 Review within 1 business day / T2 Nurse call today / T3 Urgent)
  - **Acknowledged** (yes/no + who/when)
  - **Side effect (AE)**: use "side effect" in prose and "AE" in codes. Drop "adverse event" from headings.
  - **Report**: "SAE report" / "AESI report". Drop the word "packet" from the UI.
  - **Check-in**: everywhere, including breadcrumbs.
  - **Note** for documents; **Call** for phone calls. The source column reads Check-in / Note / Call.
  - **Report clock** (24 h)
  - **Grade N (provisional)**, with the G-prefix only in dense cells.

**IA-19 · P1 · FORMAT · Dates and numbers (c03, c05, c11, c13)**
- **Problem.** AESTDTC and the packet date fields render raw ISO ("2026-10-10T17:10:29.487Z"). The Notes table "Note date" is "2026-10-09" wrapped onto two lines. Audit uses "Oct 10, 2026, 11:52:08 PM", and the Queue uses "Oct 10, 01:15 PM". Countdowns and counts don't use tabular figures consistently (`number-tabular`). The Queue grade cell does use `tnum`.
- **Recommendation.**
  - One formatter for display: "Oct 10 13:15" (24 h is clinical convention; or keep 12 h, but use one), with the year shown when it differs. Show the full UTC ISO on hover and in exports.
  - Show SDTM date fields as the display date plus the ISO value in mono beneath when "codes" mode is on (IA-20).
  - Apply `tabular-nums` to every table, countdown and vitals value.

### SDTM codes vs plain labels

**IA-20 · P1 · ADD · Field labels in drafts and packets (c03/c04, c05, c12)**
- **Problem.** Fields use long plain labels in a ~200 px label column that wrap to three lines ("Side effect, in the participant's or note's words"), with the SDTM code as a small chip beneath. This makes each AE card about 900 px tall. Note-detail drafts (c12) show raw `INTERIM_GRADE_BASIS`, `INTERIM_ONSET_BEFORE_FIRST_REPORT` and so on with no plain label, and do not hide extension fields behind "Show 9 more fields" as check-in detail does.
- **Why it matters.** Trained coordinators and data managers think in AETERM, AETOXGR and CMDECOD. Judges don't. Today's layout serves neither well.
- **Recommendation.** Add a per-user toggle in the user menu, "Field names: Plain · Codes · Both" (localStorage, default Both):
  - **Both:** code in 12 px mono, then a short plain label: `AETERM` Verbatim term · `AEDECOD` CTCAE term · `AESTDTC` Start · `AEONGO` Ongoing · `AETOXGR` Grade (prov.) · `AESER` Serious (PI) · `AEREL` Related (PI) · `AEACN` Action taken · `AEOUT` Outcome.
  - **Codes:** codes only, with the plain label as tooltip.
  - **Plain:** plain label only, with the code as tooltip.

  Extension `INTERIM_*` fields always sit behind a "Show system fields" disclosure, on both detail pages.

### Tables vs cards (data display)

**IA-21 · P0 · CHANGE · Queue table at 1366 px (c01, `queue/QueueTable.tsx`)**
- **Problem.**
  - Ten columns overflow at 1366: Alert is clipped, and Drafted records and Open are off-screen (horizontal scrollbar visible), contrary to `horizontal-scroll`.
  - The Vitals cell renders "Simulated (ignored for rules)" over three lines plus a SIMULATED badge, so rows are about 155 px tall and 1.5 rows are visible.
  - The only "Open" action is in the off-screen last column.
  - No column is sortable (`sortable-table`), and the row itself is not clickable.
- **Why it matters.** This is the landing page of the demo at the most common laptop width. The primary action is not visible without scrolling sideways.
- **Recommendation.**
  - Merge to 7 columns: Participant (P-003 link + unread dot) · Source (icon + Check-in/Note/Call) · Received (tnum) · Tier (chip + ack icon/word: "T2 · Nurse call today · Not acked") · Top grade (tnum, "G3 prov.") · Vitals (one SIMULATED/MEASURED badge; "ignored for rules" in the tooltip and legend) · Report clock (countdown chip or "—") · Drafts ("3 AE · 1 CM").
  - Make the whole row a link (Enter/click). Keep an explicit "Open" for screen readers.
  - Use 36 px rows with a density toggle (36/44). Add a sticky header, `aria-sort` on Received/Tier/Grade/Clock, 50 rows per page, and keyboard j/k to move and Enter to open.
  - Optional split view: open the row in a right pane so the list stays in place.

**IA-23 · P1 · CHANGE · Check-in detail drafts as tall cards (c04, ~6,100 px page at 1440)**
- **Problem.** Each AE and VS draft is a card with stacked label/value rows and its own Confirm/Edit/Reject, so six drafts make a ~6,000 px page. The VS drafts (PULSE 82.8, RESP 13, HRV 39.7) each take ~600 px for one number. There is no bulk action (ux "Bulk Actions").
- **Recommendation.**
  - The middle column becomes a compact draft table: one row per draft (domain · term/test · key value · status · evidence count), expandable inline into a two-column field grid.
  - VS becomes a single 3-row table (Test · Result · Unit · Method · SIMULATED/MEASURED word · Confidence) with "Confirm all vitals" plus per-row confirm.
  - For AEs, add "Confirm all unchanged" with a confirmation step.
  - The Why panel stays on the right as a sticky panel.

**IA-24 · P1 · CHANGE · Escalations reasons column (c10)**
- **Problem.** Reason bullets render in a ~270 px column, so rows reach about 400 px. The text includes rule internals ("tier floor", "-> seriousness suspected (ICH E2A)", "(D-017)"). The KPI tiles take a full row.
- **Recommendation.** In the merged Worklist "Needs acknowledgement" tab:
  - Show the first reason in plain words ("Chart note: new confusion; ED visit"), with "+3 more" expanding inline.
  - Put the full rule text in the item's Why panel.
  - Show the KPIs as one line of text.
  - Show "Time to acknowledge" as a live, tnum countdown chip that turns red past the tier's target.

**IA-25 · P2 · CHANGE · Packet field table (c05, c06, c15)**
- **Problem.** There are 23 rows, each with its own "Edit" button (23 identical buttons). Empty "Not known yet" fields sit mixed with filled ones. The "Information still needed" list is separate from the fields it refers to.
- **Recommendation.**
  - Group the fields: Event · Dates · Drug & action · Investigator decisions · Reporter.
  - Edit on click of the value cell (one pencil on hover/focus, keyboard Enter).
  - Mark missing fields inline with an amber "Needed" tag. Make the right-hand checklist items anchor links to those rows (`error-summary` pattern).
  - Put Save/Sign in a sticky action bar.

**IA-26 · P2 · CHANGE · Queries table (c07)**
- **Problem.** "Raised by" shows the raw check id `query.cm_required_fields_missing`. The record cell "Medication change: Dose CM.CMDOSE" and the participant "P-005" are not links. Age "71 h" is one hour from the 72 h red threshold with no visual warning.
- **Recommendation.**
  - Show "Automatic data check: required fields missing", with the id in a tooltip.
  - Link the participant to the hub and the record to the draft or field it refers to.
  - Show age as a chip that turns amber at 48 h and red at 72 h.
  - Add a sortable Age column.

### Charts on the timeline

**IA-27 · P1 · CHANGE · Symptoms over time (c09, `timeline/charts.tsx` `type="monotone"`)**
- **Problem.**
  - Ten small line charts of an ordinal grade (G0–G3) use smoothed `monotone` curves, which imply values between grades. For example, the Diarrhea line dips smoothly between G2 and G3 (`chart-type`).
  - For P-003, 7 of 10 charts are flat G0, so about 60% of the section carries no information.
  - Each chart has its own "Table view" toggle.
- **Recommendation.** Replace the small multiples with one symptom × check-in heatmap grid:
  - 10 rows (symptom, CTCAE term in small type), one column per check-in date.
  - Each cell shows the grade number on a 4-step sequential fill: G0 white, G1 amber-100, G2 orange-200, G3 red-300, with text ≥ 4.5:1 (`color-not-only`: the number is always printed).
  - Rows that are G0 throughout collapse into "7 symptoms never reported" (expandable).
  - Clicking a cell opens that check-in's answer (evidence).
  - This is itself a table, which satisfies `data-table` and prints well.
  - If lines are kept, use `type="stepAfter"` with a fixed 0–3 domain.

**IA-28 · P1 · CHANGE · Vitals over time (c09)**
- **Problem.** The y-axis auto-scales to 82–86 bpm, so ±1 bpm of simulated noise looks like a trend (`axis-labels`, `trend-emphasis`). "SIMULATED" is printed above every one of the 10 points. There is no reference range.
- **Recommendation.**
  - Fix the domains: pulse 40–140 with a shaded 60–100 band; breathing 6–36 with a 12–20 band.
  - Keep the MEASURED/SIMULATED word beside every value by labelling each series directly at its line end ("Pulse · SIMULATED") and in every tooltip and table row, instead of 10 repeated labels.
  - Use filled points for measured and hollow points for simulated (`pattern-texture`).
  - Keep the "Table view" toggle.

### Empty, loading and unavailable states

**IA-29 · P2 · ADD · Empty states (c07 "Closed 0", Notes Scan result, Queue with filters)**
- **Problem.** Empty tabs and tables show either nothing or a generic line (`empty-states`).
- **Recommendation.** Give each empty state one sentence of cause plus one action. Examples:
  - "No open sponsor queries. Queries appear here when the sponsor or an automatic data check asks about a record."
  - With filters on: "No items match P-008 + T2. [Clear filters]"

  For the queue, distinguish "nothing to review" (positive, with the last-reviewed time) from "filters hide everything".

**IA-30 · P2 · CHANGE · Disclaimer footer (all c*)**
- **Problem.** The verbatim footer is present on every page, which is correct. On 4,000–6,000 px pages, though, it is only seen at the very end.
- **Recommendation.** Make it a slim sticky bottom bar (28 px, 12 px text, slate-600 on white, 7.6 : 1) on dashboard routes, so it stays in the viewport on every screen. The text stays verbatim from `DISCLAIMER_TEXT`.

**IA-31 · P0 · FORMAT · Low-contrast text tokens (`QueueTable.tsx`, `Layout.tsx`, others)**
- **Problem.** `text-slate-400` (#94A3B8) on white is 2.56 : 1. It is used for informational text ("no detail", "—" placeholders that carry a title, the name/role separator). The disabled "Clear filters" link reads as disabled even when filters are set (`color-contrast`).
- **Recommendation.** Minimum text token slate-500 (4.76 : 1). Use slate-600 for secondary text. Reserve slate-400 for purely decorative borders and icons.

### Audit, Eval, Admin (demo/system tools)

**IA-32 · P1 · CHANGE · Exports on the Audit page (c13)**
- **Problem.** "Download submission bundle", the per-domain CSV/JSON exports and the "post to EDC" work all sit on the Audit trail page. Exporting confirmed records is a coordinator task. Audit is a QA view.
- **Recommendation.** Move Exports to the Reports page (Reports › Data export) with the per-domain buttons and the "Post to EDC" mock. Leave a one-line "Exports are audited — see Audit" link. Add a participant filter to Audit (accepts P-003, not only ULID/USUBJID).

**IA-33 · P2 · CHANGE · Eval page (c14)**
- **Problem.** It is a 4,500 px page with 36 personas, the builder and the results together.
- **Recommendation.** In the System menu, split it into tabs: Run test set (results + confusion matrix) · Personas (sortable table, filter by category) · Build your own (form + live result side by side). Keep the hidden judge personas one click away for DEMO.md step 6.

---

## 4. Target sitemap and navigation model

```
App bar (48 px, every dashboard page)
  [Interim] Worklist  Participants  Reports  [+ New ▾ Note | Call]     [Jump to participant /]  [NCT03088540 · Synthetic ▾]  [User ▾]
                                                                                                                  ├ Field names: Plain | Codes | Both
                                                                                                                  ├ Density: Compact | Comfortable
                                                                                                                  ├ Demo guide: on/off
                                                                                                                  ├ ── System ──
                                                                                                                  ├ Audit trail
                                                                                                                  ├ Evaluation
                                                                                                                  ├ Admin (admin only)
                                                                                                                  ├ Open kiosk ↗
                                                                                                                  └ Sign out

/dashboard                          Worklist (landing: coordinator)
  ?tab=review                       To review     (check-ins, notes, calls with open drafts)      ← current Queue
  ?tab=ack                          Needs acknowledgement (tier ≥ 2 not acked)                     ← Escalations "Open"
  ?tab=clocks                       Report clocks (24 h SAE/AESI, countdown)                       ← Escalations clocks
  ?tab=queries                      Sponsor queries (open/answered/closed)                          ← Queries
  ?tab=investigator                 Awaiting investigator (sign, AESER/AEREL/IRAE)  (landing: investigator)
  ?tab=done                         Done (7 days) + time-saved estimate with breakdown
  /dashboard/checkins/:id           Check-in detail   (breadcrumb Worklist › P-003 › Check-in …)
  /dashboard/notes/:id              Note / call detail

/dashboard/participants             Participants roster (sortable)
  /:usubjid                         Hub: Overview (timeline heatmap + vitals + lists)
  /:usubjid/brief                   Visit brief (printable)
  /:usubjid/side-effects            Open/resolved AEs, follow-up links
  /:usubjid/medications             CM records
  /:usubjid/reports                 That participant's packets
  /:usubjid/queries                 That participant's queries
  /:usubjid/activity                Check-ins, notes, calls, filtered audit

/dashboard/reports                  All SAE/AESI reports: draft / awaiting signature / signed / submitted
  /dashboard/packets/:id            Report (keep URL; breadcrumb Reports › P-003 › AESI report v1)
  ?tab=export                       Data export (bundle, per-domain CSV/JSON, Post to mock EDC)

System (user menu, separated)
  /dashboard/audit                  Audit trail + Verify chain + pager log
  /dashboard/eval                   Evaluation (Run | Personas | Build your own)
  /admin                            Admin (landing: admin)
  /kiosk                            opens in new tab
```

Navigation rules:

- No more than 4 primary items.
- The active state comes from route ownership (IA-02).
- Every participant ID links to the hub.
- Every list's tab, filter and sort state is in the URL (`deep-linking`, `state-preservation`), so Back restores the list and its scroll position.
- Keyboard shortcuts: `/` search · `g w` worklist · `g p` participants · `j/k` move · `Enter` open · `a` acknowledge (with focus on a row in Needs ack) · `?` shortcut sheet.
- Existing routes (`/dashboard`, `/dashboard/escalations`, `/dashboard/queries`, `/dashboard/notes`) stay as redirects to the matching Worklist tab, so DEMO.md, tests and other agents' links keep working.

**Demo guide layer (IA-22, ADD, P1).** A toggle in the user menu, persisted per browser. It is on by default for the first session only and can be turned on with `?guide=1` for the demo video. When on, each page shows a dismissible teal-outlined "How this works" side note, which is where the current explanatory paragraphs move: rules not prompts, audit chain, the regex scanner, the time-saved basis, sample notes with answer keys, and links to DEMO.md steps. When off, staff pages show only operational content. This keeps the judge story without making nurses read it.

---

## 5. On the generated design system (`ds_console.md`)

Keep:

- The design dials: density 9/10 (dense dashboard), motion 1/10, variance 2/10.
- Status-colour strategy (green/amber/red, with words).
- Source Sans 3 as the single UI family (good x-height and tabular figures).
- The anti-pattern "No filtering".
- From the checklist: focus rings, 4.5 : 1 contrast and reduced motion.

Reject:

- **"Exaggerated Minimalism".** It means oversized type (`clamp(3rem,10vw,12rem)`, weight 900), "massive whitespace" and "statement design", and is meant for fashion and portfolio sites. It is the opposite of a dense operations tool.
- **The "Real-Time / Operations Landing" pattern** (Hero / How it works / CTA). That is a marketing page, not an app shell.
- **GSAP page-transition snippets.** There should be no route animation in a work tool; the most a transition should do is a 150 ms opacity change on panels.
- **The cyan palette.** The cyan background #ECFEFF and cyan border #A5F3FC sit at about 1.1 : 1 against each other, so borders disappear. A tinted canvas also weakens the status colours. Use a neutral slate canvas instead.
- **Lexend as a second heading family.** It isn't needed; one family with weight hierarchy is enough.

Console tokens recommended for this lens:

- **Canvas and text:**
  - surface #FFFFFF
  - canvas #F8FAFC
  - border #E2E8F0
  - text #0F172A
  - text-secondary #475569
  - text-min #64748B
- **Brand:** teal-700 #0F766E, for primary actions, links and the active nav indicator only.
- **Tiers (word always shown):**
  - T0 slate-100 / slate-700
  - T1 amber-100 / amber-900
  - T2 orange-100 / orange-900
  - T3 red-600 / white
- **Clock chip:** amber when < 8 h left, red when < 4 h or overdue.
- **Vitals source words:** MEASURED green-700 on green-50; SIMULATED violet-700 on violet-50.
- **Type scale:** 12 / 13 / 14 / 16 / 20 px. Table text 13 px, body 14 px, page title 20 px semibold, and no display sizes. IDs and codes in 12 px mono. `tabular-nums` globally on tables.
- **Spacing:** a 4 px grid. Table cells 8 × 12 px, rows 36 px (compact) or 44 px (comfortable). Cards with a 1 px border and 8 px radius, and no shadow above `shadow-sm`.
- **Components to build once:**
  - AppBar, Breadcrumb, Tabs with counts
  - DataTable (sort, sticky header, row link, keyboard, density, column visibility)
  - FilterBar synced to the URL
  - SideSheet
  - CountdownChip, TierChip, SourceWordBadge
  - CodeLabel (Plain/Codes/Both)
  - EvidencePopover
  - EmptyState
  - DemoGuideNote
