# UI audit: coordinator power and efficiency

Lens: the coordinator desk (`apps/web/src/pages/dashboard/**`, screenshots `c01`–`c17` in `.playwright-mcp/ui-audit/`).
Method: ui-ux-pro-max Quick Reference, priorities 1→10, plus CLI lookups (`--domain ux` "sort table sticky header bulk action keyboard", `--domain chart` "heatmap matrix", `--domain style` "data dense dashboard enterprise operations").
Audience: trained research coordinators and nurses who live in Medidata Rave, Epic and Veeva all day. They want speed, density, keyboard control and zero ambiguity. They do not want decoration.
Report only. No app files were changed.

## Headline

The desk computes the right things, but it is laid out like a document for first-time readers, not a work tool for staff.

- **The queue is the worst case.** At 1366×768 only **one queue row** shows above the fold. The 170 px header, an intro paragraph, the "Since you were last here" card and the filter card push the table down to y=512. Each row is about 150–158 px tall.
- **The row action is off-screen.** The table has `min-w-[1040px]` and 10 columns, so at 1366 the **Open** button and "Drafted records" sit past the right edge. To open any item you must scroll sideways.
- **The check-in detail page is about 6,100 px tall** at 1440. It holds three AE cards, three VS cards and a 23-item prose "Why" list.
- **Confirming a check-in's 6 drafts takes 12 clicks and about 8 screens of scrolling.**
- **None of the usual power features exist:** no keyboard shortcuts, sortable columns, bulk confirm, global search, nav count badges or "next item".

**Direction:** a compact, legacy-EDC-dense console. Single-line rows. Sticky headers. j/k plus single-key actions. Expert-first labels (SDTM code plus a short label), with the plain-English explanation one click away. Keep the kiosk large and calm.

## Monday-morning walk (1366×768, coordinator)

| Step | Today | Clicks / scrolls | Above the fold today | Target |
|---|---|---|---|---|
| 1. Triage queue | 25 rows per page, ~150 px each, server order only | 0 clicks, ~6 PgDn per page, 2 pages | header, prose, since-card, filters, **1 row** | 14+ rows, sortable, unread markers |
| 2. Open an item | Open button is off-screen; the participant link goes to the timeline, not the item | 1 horizontal scroll + 1 click | n/a | 1 key (Enter) or 1 click anywhere on the row |
| 3. Review drafts + evidence | 3-column page; each AE card ~700 px; 23 prose rules | ~8 screens | 1st AE card header, 10 answers, 3 rules | the whole check-in in ≤2 screens |
| 4. Confirm 6 drafts | Confirm → optional-note form → "Confirm draft", per card | **12 clicks + ~8 scrolls** | n/a | 1 key per draft, or 1 "confirm remaining" with a review list |
| 5. Open the 24 h packet | "Open report packet" is in the right column about 2 screens down | 1 click + 2 scrolls | n/a | pinned clock chip in the sticky detail header |
| 6. Complete packet | 23 field rows, each with its own Edit button; 6 missing fields aren't marked required | ≥13 clicks (6 × Edit/Save + Save) | 2 fields | sectioned form, inline edit, required status, Ctrl+S |
| 7. Answer a sponsor query | Nav → row → panel → Answer; nothing on the queue or nav says a query is waiting | 3 clicks | n/a | nav badge "Queries 1"; `g` `y` shortcut |
| 8. Print a visit brief | queue "Brief" link → Print; brief is 3,240 px and the paragraph column repeats the left column | 2 clicks | n/a | single-column print doc, one Print button |

## Findings

Priority: **P0** blocks the demo or fails accessibility. **P1** is a clear workflow cost. **P2** is polish.
Kind: CHANGE / ADD / REMOVE / FORMAT.

### Global chrome and design system

1. **P0 CHANGE: header height (c01, c03, every page).**
   - **Problem:** the two-row header is 170 px, which is 22% of a 768 px viewport.
     - The study block is a narrow column that wraps to 5 lines ("Study of REG… / Demo study (public registry record) / All participants are synthetic.").
     - "Open kiosk" sits in the coordinator chrome.
     - The time-saved strip takes a whole second row.
   - **Recommendation:** one 44 px app bar:
     - `[logo] [R2810-ONC-1624 · NCT03088540 · SYNTHETIC chip] [nav with counts] [search ⌘K] [freshness "↻ 11:51:48"] [user menu: role, Open kiosk, Sign out]`.
     - Move "≈ 28 min saved this week (estimate)" into the queue status line as plain text, so it stays visible to judges at no cost in height.
   - Rule: `content-priority`, `visual-hierarchy`. Effort: M.
2. **P1 CHANGE: no active nav item on deep pages (c03, c05, c08, c09).**
   - **Problem:** the Queue NavLink uses `end`, so check-in detail, packet, brief and timeline highlight nothing. The active style (`bg-brand-50` on white) is about 1.03:1 against the bar.
   - **Recommendation:** map routes to sections:
     - `/dashboard/checkins/*`, `/participants/*` and `/packets/*` → Queue.
     - Note detail → Notes.
     - Use a 2 px brand-700 bottom border plus font-semibold as the active indicator.
   - Rule: `nav-state-active`. Effort: S.
3. **P1 ADD: nav count badges and a global urgent alert.**
   - **Problem:** the new-T3 toast fires only while `Queue.tsx` is mounted. A coordinator on a detail page never hears about a page.
   - **Recommendation:**
     - Poll once in `Layout`.
     - Show badges: Queue (needs action), Escalations (unacknowledged), Queries (open, red when >72 h).
     - Set `document.title` to "(2) Interim".
     - Raise a global `aria-live` toast for new T3/T2 items on any page.
   - Rule: `tab-badge`, `toast-accessibility`. Effort: M.
4. **P1 ADD: global search / command palette (Ctrl+K or `/`).**
   - **What it searches:** participant (P-003 or USUBJID), check-in or note ULID suffix, query id, AE term ("diarrhea").
   - **Actions:** "Open brief for P-003", "Go to escalations", "Export AE CSV".
   - **Problem today:** there is no participant list at all. The timeline is reachable only from a queue row.
   - Rule: `search-accessible`. Effort: M.
5. **P1 ADD: keyboard layer and a `?` help sheet.**
   - **Problem:** none exists today. The only key handlers are Esc on the brief and Enter on the packet fields.
   - **Proposed keys:**

     | Context | Keys |
     |---|---|
     | Go to section | `g q` / `g e` / `g n` / `g y` / `g a` |
     | Tables | `j` / `k` row focus, `Enter` open, `x` select |
     | Detail page | `c` confirm, `e` edit, `r` reject, `a` acknowledge |
     | Moving between items | `]` / `[` next and previous item |
     | Edit forms | `Ctrl+Enter` save, `Esc` cancel |

   - Don't capture keys while focus is in an input.
   - Rule: `keyboard-nav`, `keyboard-shortcuts`. Effort: M.
6. **P1 ADD: session-timeout handling.**
   - **Problem:** expiry is checked only on load (`lib/auth.ts:44`). A 401 in the middle of an edit drops the work.
   - **Recommendation:**
     - Show a banner at T-5 min: "Session ends 15:51 · Stay signed in".
     - On 401, open a re-login modal over the page and keep unsaved form state in `sessionStorage`.
   - Rule: `timeout-feedback`, `form-autosave`. Effort: M.
7. **P2 ADD: data freshness everywhere.**
   - **Problem:** "updated 11:51:48 PM" plus Refresh exists only on the queue. Detail, escalations and queries show nothing.
   - **Recommendation:** one app-bar indicator "↻ 15 s · 11:51:48". Drop the per-page Refresh buttons.
   - Effort: S.
8. **P0 CHANGE: low-contrast text.**
   - **Problem:** `text-slate-400` (#94A3B8) on white is **2.56:1**. It is used for:
     - "Clear filters", which looks disabled (c01)
     - "no detail"
     - every em-dash empty cell
     - the `·` separators
   - **Recommendation:** use slate-600 (#475569, **7.6:1**) for anything actionable and slate-500 (#64748B, **4.76:1**) as the floor.
   - Rule: `color-contrast`. Effort: S.
9. **P1 FORMAT: sub-12 px text.**
   - **Problem:** SDTM code badges are `text-[11px]` (queue) and `text-[10px]` (edit labels). Several meta lines are `text-xs` with slate-500 on slate-50.
   - **Recommendation:** use a 12 px minimum and make code chips 12 px mono with slate-700.
   - Rule: `readable-font-size`. Effort: S.
10. **P1 FORMAT: raw ISO timestamps in clinical fields.**
    - **Problem:** values such as `2026-10-10T17:10:29.487Z` appear in AESTDTC (c03), SITE_AWARENESS_AT and REPORT_DUE_AT (c05). The Notes "Note date" column wraps "2026-10-\n09" (c11).
    - **Recommendation:**
      - One formatter everywhere: `10-Oct-2026 13:10` local (DD-MMM-YYYY is the clinical convention), with UTC ISO on hover/copy.
      - `whitespace-nowrap` and `tabular-nums`.
      - Show the export value only in the expanded evidence.
    - Rule: `number-formatting`, `number-tabular`. Effort: S.
11. **P1 CHANGE: inconsistent participant identifiers.**
    - **Problem:** the queue shows `P-003`. Escalations and SAE clocks show `R2810-ONC-1624-P-003` wrapped over 3 lines (c10). Query text uses the full USUBJID.
    - **Recommendation:** show the display label P-003 everywhere, with the USUBJID on hover and a copy button.
    - Effort: S.
12. **P1 REMOVE: internal IDs and decision refs in the reading path.**
    - **What leaks:**
      - "(D-017)" inside escalation reasons (c10)
      - `query.cm_required_fields_missing` (c07)
      - `aesi_narrative.who` keys (c05)
      - `packet 01M4…`, `edit-check` actor ids
    - **Recommendation:** put them behind one global "Show technical ids" toggle (the brief already has one), off by default.
    - Effort: S.
13. **P1 CHANGE: two token sets.**
    - **Problem:** the dashboard reuses kiosk-scaled controls: `Button md` is `min-h-11` (44 px), `rounded-xl`, `text-base`, and the queue Open link is `min-h-9 rounded-xl`.
    - **Recommendation:** add a `console` density:

      | Element | Value |
      |---|---|
      | Controls | 28–32 px |
      | Table text | 13 px |
      | Body text | 14 px |
      | Radius | 4 px |
      | Shadows | none; 1 px slate-200 borders |
      | Table cell padding | 6–8 px |

      Keep the `kiosk` tokens (`min-h-tap`, 56–68 px) for `/kiosk` only.
    - Rule: `consistency`, `elevation-consistent`. Effort: M.
14. **P2 ADD: skip link.**
    - **Problem:** none in `Layout`. That's 9+ tab stops before the main content.
    - **Recommendation:** add "Skip to main content".
    - Rule: `skip-links`. Effort: S.

### Queue (`Queue.tsx`, `queue/QueueTable.tsx`; c01, c02)

15. **P0 CHANGE: the primary action is off-screen at 1366.**
    - **Problem:** `min-w-[1040px]` with 10 columns. At 1366 only **8 of 10 columns** fit, so "Drafted records" and **Open** need a horizontal scroll (scrollbar visible in c01).
    - **Recommendation:**
      - Make the whole row the link: `tr` with `tabIndex=0`, Enter/click opens.
      - Keep the participant link as a secondary target.
      - Collapse to 8 compact columns: `☐ | ● new | Pri | Participant | Source | Received | Max gr. | Report due | Alert | Drafts (AE/VS/CM)`.
    - Rule: `horizontal-scroll`, `primary-action`. Effort: S–M.
16. **P0 CHANGE: rows are too tall to triage.**
    - **Problem:** rows are about 150 px. The Vitals cell wraps "Simulated (ignored for rules)" over 3 lines plus a badge, and Participant and Brief are stacked. At 1366×768 the table starts at y=512 and **only 1 row is visible**.
    - **Recommendation:**
      - 36 px single-line rows.
      - Vitals cell: `83/13 SIMULATED`, one line, with the word SIMULATED kept and "ignored for rules" in a tooltip.
      - Brief and timeline as hover/focus row actions.
      - Target: **≥14 rows above the fold**.
    - Rule: `data-density`, `content-priority`. Effort: M.
17. **P1 ADD: sortable columns.**
    - **Problem:** the table is server order only ("never re-sorts").
    - **Recommendation:**
      - Sortable headers with `aria-sort` for Priority, Received, Report due, Participant, Max grade, passed as a server param so the rules engine stays the source of order.
      - Default stays tier desc, time desc.
      - Persist the sort in the URL (filters already use `useSearchParams`, so keep that).
    - Rule: `sortable-table`. Effort: M.
18. **P1 ADD: sticky header and filters.**
    - **Problem:** the `thead` scrolls away after one row.
    - **Recommendation:** `sticky top-[44px]` for the filter row and `thead`.
    - Rule: `sticky navigation`. Effort: S.
19. **P1 ADD: multi-select and bulk confirm for low-risk items.**
    - **Recommendation:**
      - Checkbox column. A bulk bar: "Confirm drafts of 5 selected (T0/T1 only) · Export CSV · Assign".
      - Bulk confirm opens one review list naming each draft. It writes one audit event per draft, with the human click recorded.
      - Disable bulk confirm for T2/T3 and for any row with a running clock.
    - Rule: `bulk actions` (ux-guidelines, Data Entry). Effort: L.
20. **P1 CHANGE: "Since you were last here" chips look like buttons but aren't.**
    - **Problem:** the chips ("7 need action", "2 report clocks running") have button styling but no handler. Only "Mark all as seen" is clickable. The card costs 100 px.
    - **Recommendation:**
      - Fold them into the filter row as **saved-view quick filters**: `Needs action 7 · Clocks running 2 · Unacked alerts 3 · Open queries 1 · All`.
      - Add a "new since last seen" left bar (3 px brand) and bold participant on unseen rows.
    - Rule: `state-clarity`, unread markers. Effort: M.
21. **P1 FORMAT: the report-due column should be a countdown.**
    - **Problem:** the chip text "Serious event — report due in 20:35 SAE" wraps.
    - **Recommendation:**
      - Show `SAE 20:35` / `AESI 13:23` in tabular numerals, h:mm remaining.
      - Red when under 4 h, amber under 12 h; "stopped" in slate.
      - The chip links to the packet (already true). Make the column sortable.
    - Rule: `number-tabular`, `color-not-only` (keep the SAE/AESI word). Effort: S.
22. **P2 REMOVE: queue intro prose and the bottom legend.**
    - **Problem:** "Everything that needs a look… nothing is re-ranked in the browser" (2 lines) and the 3-line legend under the table.
    - **Recommendation:** move both into a `?` popover on the table header. Keep the tier full name in each chip's `title` and in the chip itself ("T2 Nurse call today"), which preserves explicit tier names.
    - Effort: S.
23. **P2 FORMAT: the max-grade cell.**
    - **Problem:** "Grade 2 provisional" uses two words per row.
    - **Recommendation:** header "Max grade (prov.)", cell `2`. Keep "provisional" in the header and tooltip.
    - Effort: S.

### Check-in detail (`CheckInDetail.tsx`, `detail/*`; c03, c04)

24. **P1 CHANGE: layout.**
    - **Problem:** the page is about 6,100 px tall at 1440. Each AE card is about 700 px: 13 field rows with two-line plain labels, plus an investigator box, reference info and version history. Three VS cards repeat that.
    - **Recommendation:** master-detail.
      - **Left:** sticky answers rail, 280 px.
      - **Centre:** a compact **drafts table**, one row per draft: `Dom | Term | Gr | Status | Evid# | c/e/r`. Expand in place to a 2-column key:value grid labelled `AETOXGR Grade` (SDTM code first in mono, short label).
      - **Right:** a collapsible Why rail.
      - Target: the whole check-in in ≤2 screens at 1366.
    - Effort: L.
25. **P1 CHANGE: expert mode for the Why panel.**
    - **Problem:** it has 23 numbered prose sentences, e.g. "Shortness of breath: the answers add up to a symptom score of 2 out of 3."
    - **Recommendation:**
      - Default for staff: a compact rule table `Rule | Inputs | Threshold | Result | Category`, e.g. `corr.sob_rr | SOB comp 2, RR 26 | ≥2 & ≥24 | +1 tier`.
      - A one-click "Explain in plain English" toggle, remembered per user (`localStorage`).
      - For the demo/judge path, default it **on** for the investigator/admin demo login, or add `?explain=1`.
    - Effort: M.
26. **P1 CHANGE: confirm ergonomics.**
    - **Problem:** Confirm → optional note form → "Confirm draft" is 2 clicks per draft, 12 for six. There is no auto-advance and no next item.
    - **Recommendation:**
      - Confirm commits on one click/key, with the optional note as a collapsed field.
      - Focus moves to the next pending draft.
      - After the last one, show a "Next open item ▸ P-006 T2 (]) " bar.
      - Add "Confirm remaining (4)", which lists the drafts and confirms them as separate audited events.
      - Reject keeps its required reason.
    - Rule: `primary-action`, `success-feedback`. Effort: M.
27. **P1 CHANGE: inline edit.**
    - **Problem:** Edit opens a block form with every editable field. Labels use a 10 px mono code.
    - **Recommendation:**
      - Click a value (or press `e` on a focused field) to get an input in place.
      - Enter / Ctrl+Enter saves (new version), Esc cancels, Tab moves to the next editable field.
      - Show a "v2 saved" inline confirmation.
    - Rule: `keyboard-nav`, `inline-validation`. Effort: M.
28. **P1 CHANGE: VS drafts as one table.**
    - **Problem:** HRV, Pulse and Resp are three full cards, each with Confirm/Edit/Reject, about 1,100 px in total.
    - **Recommendation:** one VS sub-table `VSTESTCD | Result | Unit | Method (SIMULATED) | Conf | Time | ☐` with "Confirm VS set (3)". The SIMULATED word stays in each row.
    - Effort: M.
29. **P2 CHANGE: answers column.**
    - **Problem:** 16 answers, most of them "None (0)" / "Not at all (0)", get equal weight.
    - **Recommendation:** show non-zero answers first, in bold, and collapse zeros into "9 answers None/Never · show".
    - Effort: S.
30. **P2 CHANGE: detail header.**
    - **Recommendation:**
      - Make it sticky (44 px): `P-003 · T2 Nurse call today · SIMULATED · AESI clock 13:23 → packet · ◂ 3 of 7 ▸`.
      - Remove the separate Refresh button (auto-refresh).
      - Replace the red sentence "A 24-hour report clock is running" with the countdown chip.
    - Effort: S.

### 24-hour report packet (`packets/*`; c05, c06, c15)

31. **P1 CHANGE: the packet should behave like a form.**
    - **Problem:** 23 flat rows, each with an Edit button. Missing values show as italic "Not known yet" with no required flag. The "Information still needed (6)" list sits apart from the fields.
    - **Recommendation:**
      - Sections with counters: `Event 5/5 · Timing 3/4 · Study drug 1/3 · Investigator decisions 0/3 · Reporter 1/1`.
      - Required-before-sign fields get a red asterisk and "Required" text.
      - Clicking a "still needed" item scrolls to and focuses that field.
      - Inline edit on every value.
      - A sticky action bar: `Save (Ctrl+S) · Print · Export JSON · Sign (investigator) — 6 required missing ▸`.
      - Investigator-only fields render read-only (not disabled) for coordinators.
    - Rule: `required-indicators`, `error-summary`, `field-grouping`, `read-only-distinction`. Effort: L.
32. **P2 REMOVE: packet prose.**
    - **Problem:** the intro paragraph (3 lines) and the narrative as 11 bordered cards, each with chip rows (c05).
    - **Recommendation:** render the narrative as one continuous paragraph with superscript evidence markers. Click a marker to highlight the source (click-to-evidence is kept).
    - Effort: M.
33. **P2 FORMAT: deadline card.**
    - **Recommendation:** keep it, but pin it into the sticky bar.
      - `13:23 left · due 11-Oct 13:15` in tabular numerals.
      - Show seconds under 1 h.
      - Red under 4 h.
    - Effort: S.

### Sponsor queries (`queries/*`; c07)

34. **P1 ADD: queries inbox columns.**
    - **Problem:** the age shows "71 h" with no warning until 72 h. There is no assignee or due column.
    - **Recommendation:**
      - Columns: `Due (72 h SLA) remaining`, `Assigned to`, `Field` (CM.CMDOSE).
      - Sort by due.
      - Filter by participant and kind.
      - Amber at ≥48 h, red at >72 h.
      - Remove the 3-line explanatory paragraph.
      - Show P-005 instead of the full USUBJID in the question text.
    - Effort: M.

### Visit brief (`brief/*`; c08)

35. **P1 REMOVE: duplicated paragraph column.**
    - **Problem:** "In one paragraph" (right column) repeats every item in the left column, and the page is 3,240 px. There are two print buttons ("Print", "Open printable version").
    - **Recommendation:**
      - A single-column print document.
      - The paragraph as an optional collapsed summary at the top.
      - One Print button.
      - Evidence chips (`Record ..166ETK`) hidden by default and in print.
    - Effort: M.

### Escalations (`Escalations.tsx`; c10)

36. **P2 CHANGE: KPI cards and the reasons column.**
    - **Problem:** 4 large KPI cards (~90 px). The reasons column wraps up to 20 lines of prose per row.
    - **Recommendation:**
      - One stat line: `Open 3 · Median ack 29m19s · Active clocks 2 · Pages 1`.
      - Reasons: the first reason plus "+3 more" (expand).
      - Keep the per-row Acknowledge button; no bulk ack.
    - Effort: S.

### Participant timeline (`ParticipantTimeline.tsx`; c09)

37. **P1 CHANGE: grade grid instead of 10 small charts.**
    - **Problem:** 10 small-multiple charts of about 145 px each, 7 of them flat at G0.
    - **Recommendation:**
      - A **symptom × check-in grade grid**: 10 rows × N columns, numbers in cells, G0 blank, colour plus number, with a legend. About 300 px in total.
      - A row header sparkline is optional.
      - Vitals: a table plus a small line chart, with SIMULATED on each series label and each table cell.
    - Rule: `chart-type` (heatmap for intensity), `data-density`. Effort: M.

### Chart notes (`Notes.tsx`; c11)

38. **P1 CHANGE: worklist first.**
    - **Problem:** the ingest form and the Log-call form take the first ~1,300 px. The worklist "Ingested notes and calls" is at the bottom.
    - **Recommendation:**
      - Put the worklist table first.
      - "Ingest note" and "Log call" become buttons that open a right drawer.
      - Show "Answer key for this sample" only in demo/admin mode.
    - Effort: M.

### Export and print

39. **P2 ADD: export from the work views.**
    - **Problem:** exports live only on the Audit page.
    - **Recommendation:**
      - Add `Export ▾ (CSV/JSON of current view)` on Queue, Escalations and Queries.
      - Add a print stylesheet for queue and detail.
      - Keep every export audited (already the case).
    - Rule: `export-option`. Effort: M.

## On the skill-generated `ds_console.md`

- **Keep:**
  - density 9 / motion 1 / variance 2
  - the status-colour strategy ("Dark or neutral. Status colors (green/amber/red). Data-dense but scannable")
  - "Avoid: ornate design, no filtering"
  - destructive red #DC2626
  - visible focus rings and reduced motion
  - Source Sans 3 is acceptable as body text, but the system font stack is faster and fine.
- **Reject:**
  - the style "Exaggerated Minimalism" (oversized type `clamp(3rem,10vw,12rem)`, weight 900, "massive whitespace": built for fashion and portfolio sites)
  - the "Operations Landing" pattern (hero, how-it-works, CTA)
  - Lexend headings
  - the cyan background #ECFEFF and cyan border #A5F3FC (low-contrast borders, about 1.2:1)
  - GSAP page transitions
- **Use instead:** the skill's own "Data-Dense Dashboard" style entry: minimal padding 8–12 px, 12–14 px text, sticky headers, tables with sorting, grid layout.

## Recommended direction (coordinator console)

**Layout**
- A 44 px app bar with study code, nav and counts, search, freshness and user menu.
- Full-width content (drop `max-w-7xl`, which wastes ~160 px at 1440).
- Queue: a full-height work table with sticky header and filter row, row click / Enter to open, and an optional preview drawer (`p`).
- Detail: master-detail with an answers rail, a drafts table with expand-in-place, and a collapsible Why rail.
- Packet: a sectioned form with a sticky action bar.

**Density**
- 36 px table rows, 6–8 px cell padding.
- 28–32 px controls, 4 px radius.
- No card shadows; 1 px slate-200 dividers.
- No nested cards.

**Type**
- System UI 14 px body, 13 px table cells.
- 12 px is the minimum (labels and mono codes).
- 16/600 page titles (not 24 px bold).
- `tabular-nums` on every number, date and countdown.
- Mono for SDTM codes and IDs.

**Colour tokens (light)**

| Token | Value |
|---|---|
| surface | #FFFFFF |
| canvas | #F8FAFC |
| border | #E2E8F0 |
| text | #0F172A |
| text-2 | #475569 (7.6:1) |
| text-3 | #64748B (4.76:1, floor) |
| brand / primary actions | #0F766E (5.47:1 on white) |
| focus ring | #14B8A6 |

**Status tokens:** status colours only ever carry meaning, and always with a word.

| Tier / state | Background | Text |
|---|---|---|
| T0 | #E2E8F0 | #1E293B |
| T1 | #FDE68A | #78350F |
| T2 | #FED7AA | #7C2D12 |
| T3 | #DC2626 | #FFFFFF |
| SIMULATED | #EDE9FE | #5B21B6 |
| MEASURED | #DCFCE7 | #166534 |
| Clock under 4 h | #B91C1C text, bold | |

**Components**
- DataTable: sort, sticky, select, j/k, row actions, CSV.
- QuickFilterBar: saved views with counts.
- CountdownChip (h:mm, tabular).
- CommandPalette (Ctrl+K).
- Shortcut help (`?`).
- InlineEditCell.
- EvidencePopover: click a field to see the source answer/sample with its timestamp.
- RuleTable with a plain-English toggle.
- StickyActionBar.
- SessionBanner.
- Toast (global, `aria-live`).

**Remove**
- Intro paragraphs on every page.
- The bottom legend.
- The KPI card row.
- The duplicated brief paragraph column.
- Pill-heavy chips for non-status data.
- Two-line plain labels as the primary field label.

**Must survive any redesign**
- The not-a-medical-device footer, verbatim.
- The word MEASURED/SIMULATED beside every vital.
- Click-to-evidence on every derived field.
- Explicit tier names (T2 · Nurse call today).
- Investigator-only controls.
