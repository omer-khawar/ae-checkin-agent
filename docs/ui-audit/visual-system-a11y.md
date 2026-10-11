# UI audit: visual system, consistency and accessibility

Lens: tokens, colour and contrast, type, spacing, radius and elevation, icons, focus and keyboard, headings, dark mode, component inventory, and loading, empty and error states. Covers both surfaces: the patient kiosk and the coordinator console.

Method: ui-ux-pro-max Quick Reference priorities 1 to 10, plus CLI lookups (`--domain ux/style/typography`). Inputs were 21 screenshots in `.playwright-mcp/ui-audit/`, a grep of every class in `apps/web/src` (tests excluded) and computed WCAG contrast ratios using Tailwind v3 hex values. This report is read-only: no app file was changed.

> Note: `c17-login-1440.png` actually shows the Queue, because the admin session was already signed in. The login page itself was not audited.

---

## 1. What the code actually uses today (measured)

| Dimension | Measured | Verdict |
|---|---|---|
| Colour families (class count) | slate 1249, brand(teal) 209, red 125, amber 118, green 61, violet 30, sky 30, orange 18, teal 9, indigo 8, emerald 6 | 11 hue families. Only `brand` is a token. Every status colour is a raw Tailwind class, and the same hue carries several meanings (see F-05). |
| Text colours | slate-500 ×253, slate-600 ×251, slate-900 ×163, slate-700 ×144, slate-800 ×67, **slate-400 ×13** | Six greys for text. slate-400 fails AA (2.56:1). |
| Font sizes | text-xs ×394, text-sm ×298, **text-[11px] ×46**, text-2xl ×26, text-base ×23, **text-[10px] ×22**, text-xl ×15, text-[12px] ×15, text-lg ×12, text-3xl ×6, text-4xl ×5, text-[13px] ×4 | 12 sizes, 4 of them arbitrary. **68 uses are below 12px.** |
| Radius | rounded ×67, rounded-lg ×66, rounded-full ×44, rounded-xl ×39, rounded-md ×27, rounded-2xl ×10 | 6 radii and no rule for which one to use. |
| Shadow | shadow-card ×10, shadow ×2, shadow-lg ×1 | Little used, but every Card floats on slate-50, which makes the console look like a stack of cards. |
| Icons | No icon library. Hand-drawn inline `<svg>` in 6 files. Unicode used as icons: ✓ ✕ ▶ ⇄ ← ↑ ↓ ≈, and "→" 115 times | Mixed visual language (`icon-style-consistent`, `no-emoji-icons`). |
| Focus | Global `:focus-visible` = `ring-4 ring-brand-500/60`, plus 8 files with their own ring variants (`ring-2 ring-brand-500`, `ring-brand-600/30`, `focus:outline-none`) | The ring colour fails 3:1 (F-01). |
| Tabular numerals | `.tnum` utility used 98× in 36 files | Good, but opt-in: tables do not default to it. |
| Sortable tables | 26 `<table>` in 19 files, **0 `aria-sort`** | No column can be sorted (F-21). |
| Skip link | 0 | Missing (F-27). |
| Dark mode | 0 `dark:` classes; D-006 says light only | See F-20. |
| Loading | Plain "Loading …" text in 22 files with different wording, 5 ad-hoc spinners, 0 skeletons | Inconsistent (F-26). `ErrorBanner` is shared across 30 files, which is good. |
| Headings | Pages use `<h1>` (28 in 22 files); `Card` renders `<h2>` titles; `<h3>` ×15 | Hierarchy is basically sound. |

### Contrast of the pairs actually in use (WCAG 2.x)

| Pair (fg on bg) | Ratio | AA normal text 4.5 / non-text 3.0 |
|---|---|---|
| slate-900 on slate-50 (body) | 17.06 | pass |
| slate-600 on white (secondary) | 7.58 | pass |
| slate-500 on white / slate-50 / slate-100 | 4.76 / 4.55 / 4.34 | pass / borderline / **fail** |
| **slate-400 on white** ("—" placeholders, "refreshing…", packet id, audit gap markers, kiosk placeholder) | **2.56** | **fail** |
| T0 chip slate-800 on slate-200 | 11.87 | pass |
| T1 chip amber-900 on amber-200 | 7.28 | pass |
| T2 chip orange-900 on orange-200 | 6.92 | pass |
| T3 chip white on red-600 | 4.83 | pass |
| **T1 vs T2 chip fill (amber-200 vs orange-200)** | **1.09** | Not distinguishable by colour; only the "T1"/"T2" text separates them |
| MEASURED green-800 on green-100 | 6.49 | pass |
| SIMULATED violet-800 on violet-100 | 7.57 | pass |
| "mock" source label (violet-800 at 80% opacity) | 4.98 | pass (but 11px) |
| Error banner red-800 on red-50 | 7.60 | pass |
| Primary button white on brand-700 | 5.47 | pass |
| **Disabled primary (brand-700 at 50% opacity over slate-50) with white text** | **2.21** | Exempt from WCAG, but on the kiosk it reads as "faded", not "unavailable" |
| **Focus ring brand-500/60 (#72D4CA) on white** | **1.75** | **fail, 1.4.11 / 2.4.11** |
| **Kiosk option button border slate-300 on white** | **1.48** | **fail, 1.4.11 (component boundary)** |
| **Admin switch (off): slate-200 track, slate-300 border on white** | **1.23 / 1.48** | **fail, 1.4.11** |
| Vitals quality dot green-500 on white | 2.28 | fail on its own, but the text "Good signal" sits beside it, so OK |
| Progress track slate-200 on white | 1.23 | Decorative track; the fill brand-600 passes |

---

## 2. Findings

Priorities: P0 blocks the demo or fails accessibility. P1 is a clear workflow cost. P2 is polish.
Kinds: CHANGE / ADD / REMOVE / FORMAT.

### P0

**F-01 · design-system · CHANGE · Focus ring is invisible (1.75:1).**
- Where: `src/styles/index.css` `:focus-visible { ring-4 ring-brand-500/60 }`. Eight components define their own ring on top of that.
- Rule: `focus-states`, WCAG 1.4.11.
- Why it matters: coordinators who work from the keyboard cannot see where they are. Judges who tab through will notice.
- Fix: one token, `--focus: #0F766E`, applied as `outline: 2px solid var(--focus); outline-offset: 2px` (5.47:1). On the kiosk use 3px in a distinct blue, `#1E3A8A` (10.4:1), so focus never looks like "selected". Delete the per-component ring classes.
- Effort: S

**F-02 · queue · CHANGE · At 1366×768 the queue shows about 1.5 rows, and the row action is off-screen.**
- Where: `c01`.
- Measurements:
  - The first row starts at y≈537 px. Above it sit the header (170 px), the title (95), "Since you were last here" (110), the filters (90) and the table header (50).
  - Check-in rows are about 158 px tall, because the Vitals cell wraps "Simulated (ignored for rules)" over three lines and then adds a badge.
  - The table has 10 columns. ALERT is clipped and the 10th column, the **Open** button, is past the right edge, so the page scrolls sideways.
- Rules: `horizontal-scroll`, `content-priority`, Data-Dense Dashboard style (row padding 8–12px).
- Why it matters: this is the coordinator's home screen. A nurse used to Rave or OnCore expects 15 to 25 rows per screen.
- Fix:
  - 36 px rows (`py-1.5`, 13 px text).
  - Make the whole row a link, with Enter to open, and drop the Open column.
  - Merge "Came in as" into an icon prefix on Participant.
  - Vitals becomes one `SIMULATED` badge with the reason in a tooltip.
  - Sticky `<thead>`.
  - Collapse "Since you were last here" into one 32 px summary line.
  - Target: at least 14 rows above the fold at 1366×768, and no horizontal scroll at 1280.
- Effort: M

**F-03 · dashboard-global · CHANGE · 68 text nodes are 10–11 px.**
- Where:
  - `MeasuredBadge` `size="sm"` uses `text-[11px]`.
  - VitalsPanel window line uses `text-[11px]`.
  - Packet narrative ids use `text-[10px] text-slate-400` (2.56:1).
  - Evidence and id chips in brief, packet and detail.
- Rules: `readable-font-size`, `color-contrast`.
- Why it matters: SIMULATED is a rule-mandated label; at 11 px it is the least readable word on the page. 10 px slate-400 fails on both size and contrast.
- Fix:
  - Console minimum is 12 px (caption).
  - MEASURED/SIMULATED badge minimum: 12 px on the console, 14 px on the kiosk.
  - Ban arbitrary `text-[Npx]` with an eslint `no-restricted-syntax` regex or a Tailwind `fontSize` override that drops the defaults.
- Effort: S

**F-04 · dashboard-global · CHANGE · `text-slate-400` is used for information (2.56:1).**
- Where:
  - `QueueTable.tsx:117,168,188,209,369`: "—" cells whose meaning lives only in a `title` tooltip.
  - `Queue.tsx:187`: "· refreshing…".
  - `PacketParts.tsx:496`: the packet id.
  - `EventsTable.tsx:39-40`: audit gap and end markers.
  - Kiosk placeholder.
- Rules: `color-contrast`, `hover-vs-tap`. The tooltip-only meaning is also invisible on a touch screen.
- Fix: a `--text-subtle: #5F6B7A` token (5.43:1 on white, 5.01 on canvas) is the lightest text colour allowed. Replace a bare "—" with a short word ("none", "n/a") at that colour.
- Effort: S

**F-07 · kiosk · CHANGE · Answer buttons have no visible boundary, and "selected" looks like "hover".**
- Where: `k02-question1-*`, `Button.tsx` `option` variant.
- Details:
  - The border is slate-300, 1.48:1 on white.
  - Hover is `bg-brand-50` with `border-brand-500`.
  - Selected is `bg-brand-50` with `border-brand-700` and a 40% ring.
  - The fills are identical, the borders differ by one shade, and there is no check mark.
- Rules: WCAG 1.4.11, `state-clarity`, `color-not-only`, `press-feedback`.
- Why it matters: an older or anxious participant on a touch screen must be certain what they picked. This is the single most important visual on the kiosk.
- Fix:
  - Resting: white fill, 2 px border `#7B8794` (3.66:1).
  - Selected: solid `#115E59` fill, white text (7.58:1), a leading 24 px check icon, and the label weight going 500 to 700.
  - Hover only darkens the border.
  - Keep `aria-pressed`.
- Effort: S

### P1

**F-05 · design-system · CHANGE · One hue, many meanings.**
- Amber is used for:
  - T1 "Review within 1 business day"
  - the "Rule" evidence chip
  - "Draft, not signed"
  - query "Open"
  - clock "Active"
  - "! Not acknowledged"
  - the report-due card
  - the "Information still needed" checkboxes
- Green is used for:
  - MEASURED
  - "✓ Acknowledged"
  - **"Serious event — clock stopped (SAE)"**, a green chip announcing a serious event (`c01`, `c02` row 1)
- Sky is used for the query kind "Data" and for nothing else.
- Rules: `color-semantic`, `color-not-decorative-only`.
- Why it matters: professionals learn colour meanings within a day and then scan by colour. Overloaded hues cause misreads. A green "Serious event" chip is a safety-perception bug.
- Fix:
  - Reserve hues strictly:
    - tier ramp: neutral, amber, orange, red
    - violet: synthetic or simulated only
    - green: MEASURED only
    - teal: actions and selection only
    - red outline: SAE or clock running
    - blue: AESI
  - Everything else (draft, rule, reference, open, acknowledged, clock stopped) is a neutral grey chip with an icon.
- Effort: M

**F-06 · dashboard-global · CHANGE · The tier ramp depends on reading the text.**
- Where: `TierChip`. The T1 and T2 fills are 1.09:1 apart. In queue row tinting only T3 gets a pink row.
- Rule: `color-not-only`.
- Fix: escalate *form* as well as hue, so the tier can be read at a glance.

  | Tier | Fill and border | Icon (Lucide) |
  |---|---|---|
  | T0 | Outline neutral (`#9CA3AF` border) | `circle` |
  | T1 | Pale amber fill, `#D97706` border (3.19:1) | `clock` |
  | T2 | Orange tint, `#EA580C` 2 px border | `phone` |
  | T3 | Solid `#B91C1C` fill, white text (6.47:1) | `siren` |

  Add a matching 4 px left stripe on queue rows. Keep the explicit names ("T2 · Nurse call today").
- Effort: S

**F-08 · kiosk · CHANGE · The disabled Next button looks like a broken primary button and nothing explains it.**
- Where: `k02`. White on #84B8B5 is 2.21:1.
- Rules: `disabled-states`, `error-clarity`.
- Fix: disabled style is `#E5E7EB` fill with `#4B5563` text, no teal tint. Show helper text under the question: "Choose one answer for each question to continue."
- Effort: S

**F-09 · kiosk · FORMAT · Two counters disagree: "QUESTION 1 OF 10" and the progress bar "0 of 13".**
- Where: `k02`.
- Rule: `multi-step-progress`.
- Fix: one counter, "Question 1 of 13" (items plus gates), with the bar filled to the current step.
- Effort: S

**F-10 · kiosk · REMOVE · Full registry title on every kiosk screen.**
- The text is: "Study of REGN 2810 Compared to Platinum-Based Chemotherapies in Participants With Metastatic Non-Small Cell Lung Cancer (NSCLC)".
- It appears in the kiosk header (`KioskShell` subtitle) and again in bold on Welcome.
- Rule: product rule "no clinical language on the kiosk". "Metastatic" on the screen a patient reads while reporting symptoms is avoidable distress.
- Fix: header shows "Your study check-in" plus the site name. The study title stays on the console.
- Effort: S

**F-11 · kiosk · CHANGE · The vitals card uses clinician vocabulary and small type.**
- Where: `VitalsPanel` in kiosk mode.
- Details:
  - "HRV (RMSSD)" and "beats/min" as 12 px uppercase labels in slate-500.
  - The window line is 11 px.
  - The SIMULATED badge is 11 px.
- Fix (kiosk variant):
  - Two values only, "Heart rate" and "Breathing", at 32 px tabular numerals.
  - "per minute" at 18 px.
  - SIMULATED/MEASURED badge at 14 px bold, as a word.
  - Status in plain words: "Reading…" / "Got it".
  - HRV and pleth detail move to the console.
  - The card stays small, not the hero.
- Effort: S

**F-12 · kiosk · CHANGE · Camera consent is an opt-out checkbox.**
- Where: `k01`. "I'd rather not use the camera" is unticked by default, so the camera is on unless the participant acts. The checkbox is 28 px.
- Rules: brief §3.1/§3.8 ("explicit Yes/No"), `touch-target-size`.
- Fix: a dedicated consent screen with two equal 64 px buttons, "Yes, use the camera" and "No, continue without it", and nothing pre-selected.
- Effort: S

**F-13 · kiosk · CHANGE · The primary action is below the fold at 1280×800 and 1024×768.**
- Where: `k02`. Next sits at y≈883 on both full-page captures. A two-attribute item pushes it off-screen.
- Rules: `fixed-element-offset`, `content-priority`.
- Fix: a sticky bottom action bar (white, top border, 88 px tall) holding Back (secondary, 64 px) and Next (primary, 64 px), always visible. Add bottom padding to the content so nothing hides behind the bar.
- Effort: S

**F-15 · dashboard-global · CHANGE · The header is 170 px of a 768 px viewport (22%).**
- Where: `c01`, `c03`.
- Details:
  - The study title is truncated to "Study of REG…" inside a column about 100 px wide.
  - "Demo study (public registry record)" and "All participants are synthetic." wrap over five lines.
  - The role is printed twice: "Demo Coordinator (research nurse) · Coordinator / research nurse".
  - The time-saved pill takes a whole second row.
- Fix: one 48 px app bar:
  - logo
  - nav (with a count badge on Queue and Escalations)
  - study chip `R2810-ONC-1624 · NCT03088540` with the full title in a tooltip and the registry link
  - a violet `SYNTHETIC DATA` chip
  - a user menu (name, role, sign out, open kiosk)

  Time saved moves into the Queue summary line. This recovers about 120 px, roughly 3 more queue rows.
- Note: `Layout.tsx` is already being changed to two rows by another agent. Coordinate with that change.
- Effort: S

**F-17 · dashboard-global · FORMAT · Six date/time formats.**

| Where | Format shown |
|---|---|
| Queue | "Oct 04, 12:09 PM" |
| Notes table | "2026-10-09", wrapping onto two lines |
| Check-in detail draft fields and packet "Started on" / "Site became aware" | Raw ISO "2026-10-10T17:10:29.487Z" (`toISOString` in 3 files) |
| Audit | "Oct 10, 2026, 11:52:08 PM" |
| Brief | "2026-10-10 17:15 UTC" |
| Report clock | "13h 23m left" |

- Rules: `number-tabular`, `number-formatting`, `truncation-strategy`.
- Fix:
  - One `<Time>` component everywhere, showing `10-Oct-2026 13:15` (site-local, 24-hour, the DD-MMM-YYYY convention clinical staff use on CRFs), with the full UTC in `title`.
  - `whitespace-nowrap` and tabular numerals.
  - Durations as `13 h 23 m`.
  - Raw SDTM ISO values appear only in the evidence drawer and in exports.
- Effort: M

**F-18 · design-system · CHANGE · No type scale.**
- 12 sizes are in use, plus arbitrary px values. text-xs and text-sm are used interchangeably for the same role. Page titles are 24 px and Card titles 16 px.
- Rules: `font-scale`, `text-styles-system`.
- Fix: the scale in §3, enforced as Tailwind `fontSize` overrides named by role (`caption`, `label`, `body`, `title`, `page`), not by size.
- Effort: M

**F-21 · queue / audit / notes / escalations · ADD · No sortable columns.**
- 0 of 26 tables are sortable.
- Rule: `sortable-table`.
- Fix: sortable `<th><button>` with `aria-sort`. The server's tier-then-time order stays the default and is shown as "Sorted by: priority (server)".
- Effort: M

**F-22 · queue · REMOVE · The Vitals cell says the same thing twice.**
- The text "Simulated (ignored for rules)" and a SIMULATED badge appear in the same cell, and this is what makes each row about 158 px tall.
- Rule: `whitespace-balance`.
- Fix: keep only the `SIMULATED` badge (the visible word required by the rule) plus a small info icon whose tooltip says "ignored for rules". The legend already explains it.
- Effort: S

**F-23 · checkin-detail · CHANGE · Drafts column is narrow and has 3 equal-weight actions per card.**
- Where: `c03`, `c04`.
- Details:
  - At 1366 the middle column is about 400 px wide, so labels like "Side effect, in the participant's or note's words" wrap to three lines.
  - The page is 6,103 px tall.
  - Each of 7 drafts repeats Confirm (solid teal), Edit and **Reject (solid red)**: 21 primary-weight buttons.
- Rules: `primary-action`, `destructive-emphasis`, `confirmation-dialogs`.
- Fix:
  - Render each domain as a dense table (field | value | evidence), with all VS rows in a single table.
  - One action bar per domain: "Confirm all AE (3)" and per-row actions.
  - Reject becomes an outline-danger button that asks for a reason inline.
  - The Why panel collapses to a right drawer below 1440.
- Effort: L

**F-25 · escalations · FORMAT · Participant identity is shown inconsistently, and the Reasons column is full prose.**
- Where: `c10`.
- Details:
  - The full USUBJID "R2810-ONC-1624-P-006" breaks over three lines as an underlined monospace link, while Queue and Queries show "P-006".
  - The Reasons cell runs to 300+ words.
- Fix:
  - Always show `P-006`, with the USUBJID in a tooltip and on the detail page.
  - Reasons show the first rule plus "+3 more" (expand inline).
  - `whitespace-nowrap` on IDs.
- Effort: S

**F-27 · dashboard-global · ADD · No skip link and no focus management on route change.**
- Rules: `skip-links`, `focus-on-route-change`.
- Fix: "Skip to main content" as the first focusable element, and focus `<main>` (tabIndex -1) after navigation.
- Effort: S

**F-28 · dashboard-global · ADD · No keyboard shortcuts in a professional tool.**
- Only Esc handlers exist.
- Rule: `keyboard-shortcuts`.
- Fix:

  | Key | Action |
  |---|---|
  | `j` / `k` | Move row |
  | `Enter` | Open |
  | `/` | Focus filter |
  | `g q` / `g e` | Go to Queue / Escalations |
  | `c` / `x` | Confirm / reject the focused draft (reject asks for a reason) |
  | `?` | Shortcut cheat-sheet |

  Show the hints in tooltips.
- Effort: M

**F-37 · admin · CHANGE · The "Treat simulated as measured" switch is unreadable when off.**
- The track is slate-200 with a slate-300 border (1.23 / 1.48:1). The On/Off state is `sr-only`.
- Rules: WCAG 1.4.11, `state-clarity`.
- Fix: track border `#7B8794`, a visible "OFF"/"ON" word beside it, and an amber warning row when ON.
- Effort: S

### P2

**F-14 · kiosk · CHANGE · Kiosk type sizes are not quite large enough for an older population.**
- Option labels are 18 px (`text-lg`), helper text 16 px, vitals labels 12 px, the footer 16 px.
- Fix: the kiosk scale 18 / 22 / 28 / 36 (see §3).
  - Options at 22 px / weight 500.
  - Question stem at 28 px.
  - Screen title at 36 px.
  - Nothing below 18 px except the disclaimer footer, which stays at 16 px minimum.
- Effort: S

**F-16 · design-system · CHANGE · Icons mix Unicode glyphs and hand-drawn SVGs.**
- Unicode in use: ✓ ✕ ▶ ⇄ ← ↑ ↓. "▶ Raw samples" and "▶ How the alert level was computed" are disclosure triangles typed as text.
- Rules: `icon-style-consistent`, `no-emoji-icons`.
- Fix:
  - Adopt `lucide-react` (ISC, tree-shaken), or copy about 20 Lucide SVGs into `components/icons.tsx`.
  - Sizes: 16 px console / 24 px kiosk, stroke 2.
  - Use a `<details>` chevron that rotates.
  - Every icon-only control gets an `aria-label`.
- Effort: M

**F-19 · design-system · CHANGE · Radius and elevation drift.**
- Six radii are in use. Cards are `rounded-2xl` with a shadow on a slate-50 canvas, which produces nested cards (the tinted "Since you were last here" card inside the page, the filter card, the table card).
- Rules: `elevation-consistent`, `effects-match-style`.
- Fix: the console goes flat. Panels are white with 1 px `#D5DBE1` borders and radius 6, controls and chips radius 4, and shadows only for popovers and modals. The kiosk keeps radius 12/16 and one soft shadow level.
- Effort: M

**F-20 · dashboard-global · ADD · No dark theme for long shifts.**
- Fix: once the tokens move to CSS variables (§3), offer a console-only dark theme behind a user-menu toggle, defaulting to the OS `prefers-color-scheme`. The kiosk stays light. Validate every chip pair separately (dark values are in §3).
- Do not ship this before the token migration.
- Effort: M

**F-24 · checkin-detail / packet / brief · CHANGE · Evidence chips are colour-coded with status hues.**
- "Check-in answer" is teal, "Rule" is amber, "Reference table" is slate.
- Rule: `color-semantic`.
- Fix: neutral chips (`#374151` on `#F3F4F6`) with a kind icon: `message-square` for an answer, `activity` for vitals, `git-branch` for a rule, `book` for reference, `file-text` for a note.
- Effort: S

**F-26 · dashboard-global · ADD · Loading and empty states are ad hoc.**
- 22 different "Loading…" strings and 5 one-off spinners.
- Rules: `progressive-loading`, `empty-states`.
- Fix: shared `<Loading label>` (delayed 300 ms), `<TableSkeleton rows=8>` and `<EmptyState title body action>`. Keep `ErrorBanner`.
- Effort: S

**F-29 · timeline · CHANGE · Ten small-multiple charts, six of them flat at G0, take about 600 px.**
- Where: `c09`.
- Rule: `data-density`.
- Fix: a symptom × check-in heat strip (rows = 10 symptoms, columns = check-ins, cell = grade digit plus tint). Symptoms that were never above G0 collapse into one line.
- Effort: M

**F-30 · design-system · CHANGE · Font choice.**
- The system stack renders Segoe UI on the demo laptop. It is fine, but IDs like `01M4MHCCNR49JZKABTQDF9DMQR` are hard to read.
- Fix: self-host fonts (no CDN: the brief bans third-party scripts and the kiosk must cold-start offline).
  - Console: **IBM Plex Sans + IBM Plex Mono** (tabular figures, distinct 0/O and 1/l/I for ULIDs and USUBJIDs).
  - Kiosk: **Atkinson Hyperlegible** (designed for low-vision readers) for both body and headings.
- Effort: S

**F-31 · design-system · REMOVE · Do not adopt the generated "Exaggerated Minimalism" system.**
- What to reject:
  - The generator's pick for both surfaces: `clamp(3rem,10vw,12rem)`, weight 900, "massive whitespace".
  - The "Pricing-Focused Landing" and "Operations Landing" patterns.
  - The cyan palette: `#0891B2` on white is about 3.7:1, which fails body text. The `#ECFEFF` canvas is a tint that hurts long reading.
- What to keep: the Density 9 dial for the console, "status colours green/amber/red", "sticky headers, 12–14 px, 8–12 px padding" (from the Data-Dense Dashboard style), and Lexend or Atkinson-class legibility fonts for the kiosk only.
- Effort: S

**F-32 · design-system · ADD · Tabular numerals are opt-in.**
- Fix: put `font-variant-numeric: tabular-nums` on `table`, `time`, `.tnum`, and every countdown by default.
- Effort: S

**F-33 · kiosk · CHANGE · Two questions on one screen.**
- Items with severity and interference stack both questions, which makes the page long (F-13). The brief says "one question per screen".
- Fix: one attribute per screen, auto-advancing 300 ms after a selection, with Back always available. This gives 18 short screens instead of 10 long ones, and the progress bar makes that feel fast.
- Effort: M

### Keep (verified good)

- The verbatim not-a-medical-device footer is present on every captured screen. Kiosk footer: 16 px slate-600, 7.58:1. Console footer: 12 px, 7.58:1.
- The MEASURED/SIMULATED word is always rendered as text, never as colour alone, and the colours pass (6.49 / 7.57).
- Violet consistently means synthetic or simulated, including "All participants are synthetic" and "Participant is synthetic". Keep this as the only meaning of violet.
- Tier chips always carry an explicit name ("T2 · Nurse call today").
- `ErrorBanner` is shared, `aria-live` is used in 12 files, and option buttons use `aria-pressed`.
- Kiosk option targets are 56 px with a 12 px gap.
- `prefers-reduced-motion` is honoured globally.

---

## 3. Proposed token sets

Implement these as CSS custom properties in `index.css`, mapped into `tailwind.config.js` `theme.colors` with role names (`bg-surface`, `text-muted`, `chip-tier2-bg`…). Delete raw status hues from components.

### (a) Kiosk: calm, large, light only

| Token | Hex | Role / check |
|---|---|---|
| `--k-bg` | `#FAFAF7` | warm off-white canvas |
| `--k-surface` | `#FFFFFF` | cards, option buttons |
| `--k-text` | `#1F2937` | all body text (14.0:1 on bg) |
| `--k-text-muted` | `#374151` | the lightest text allowed on the kiosk (9.9:1) |
| `--k-primary` | `#115E59` | Next, selected option fill; white text 7.58:1 |
| `--k-primary-hover` | `#134E4A` | |
| `--k-border` | `#7B8794` | option and input boundary (3.66:1 on white, 1.4.11 pass) |
| `--k-divider` | `#E5E7EB` | decorative only |
| `--k-focus` | `#1E3A8A` | 3 px outline, 3 px offset (10.4:1); blue so focus is never confused with selection |
| `--k-disabled-bg` / `--k-disabled-fg` | `#E5E7EB` / `#4B5563` | |
| `--k-error` | `#B91C1C` | inline validation only (6.47:1) |
| `--k-simulated-fg/bg/border` | `#4C1D95` / `#EDE9FE` / `#7C3AED` | 9.2:1 |
| `--k-measured-fg/bg/border` | `#14532D` / `#DCFCE7` / `#16A34A` | 8.3:1 |

No tier colours and no red/amber/orange anywhere on the kiosk. The Tier 3 stop screen uses the same calm palette.

| Type role | Size / line-height / weight |
|---|---|
| Footer disclaimer | 16 / 1.5 / 400 (verbatim) |
| Helper / caption | 18 / 1.5 / 400 |
| Body, option labels | 22 / 1.45 / 500 (selected: 700) |
| Question stem | 28 / 1.3 / 600 |
| Screen title | 36 / 1.2 / 700 |
| Vitals value | 32 / 1 / 600, tabular |

Font: Atkinson Hyperlegible (self-hosted woff2, `font-display: swap`), with the system stack as fallback.

Spacing (8 px base): 8 / 16 / 24 / 32 / 48 / 64. Option height 64 px, gap 16 px, content max-width 720 px, sticky action bar 88 px.

Radius: 12 (controls) and 16 (cards). Elevation: 0 (flat) and 1 (`0 1px 3px rgb(17 24 39 / .08)` for the vitals card and the action bar). Motion: 150–200 ms colour and opacity only.

### (b) Console: dense, flat, keyboard-first (light default, dark optional)

| Token | Light | Dark | Role / check (light) |
|---|---|---|---|
| `--bg-canvas` | `#F4F6F8` | `#0F1419` | page |
| `--bg-surface` | `#FFFFFF` | `#161B22` | panels, tables |
| `--bg-subtle` | `#F1F4F7` | `#1C2128` | table header, zebra, hover |
| `--bg-selected` | `#E6F2F1` | `#123B38` | focused or selected row |
| `--border` | `#D5DBE1` | `#30363D` | dividers (decorative) |
| `--border-strong` | `#7B8794` | `#8B949E` | inputs, switches, checkboxes (3.66:1 / 5.6:1) |
| `--text` | `#111827` | `#E5E7EB` | 17.7:1 / 14.0:1 |
| `--text-muted` | `#4B5563` | `#9CA3AF` | 7.56:1 / 6.81:1 |
| `--text-subtle` | `#5F6B7A` | `#8B949E` | lightest allowed text (5.43:1 / 5.62:1) |
| `--accent` | `#0F766E` | `#2DD4BF` | primary buttons, links, selection (5.47:1) |
| `--accent-hover` | `#115E59` | `#5EEAD4` | |
| `--focus` | `#0F766E` | `#5EEAD4` | 2 px outline, 2 px offset |
| `--danger` | `#B91C1C` | `#F87171` | destructive actions (outline style), clock overdue |

Status chips (fg / bg / border, icon). Every chip carries a word, and the icon is extra.

| Meaning | Light fg / bg / border | Icon | Contrast |
|---|---|---|---|
| T0 · Log | `#374151` / `#F3F4F6` / `#9CA3AF` (outline) | `circle` | 9.37 |
| T1 · Review within 1 business day | `#713F12` / `#FEF3C7` / `#D97706` | `clock` | 7.79 |
| T2 · Nurse call today | `#7C2D12` / `#FFEDD5` / `#EA580C` (2 px) | `phone` | 8.18 |
| T3 · Urgent | `#FFFFFF` / `#B91C1C` / `#7F1D1D` (solid) | `siren` | 6.47 |
| MEASURED | `#14532D` / `#DCFCE7` / `#16A34A` | `activity` | 8.30 |
| SIMULATED / synthetic | `#4C1D95` / `#EDE9FE` / `#7C3AED` | `flask-conical` | 9.23 |
| SAE (possible serious) | `#991B1B` / `#FEF2F2` / `#DC2626` | `alert-octagon` | 7.60 |
| AESI (possible special interest) | `#075985` / `#E0F2FE` / `#0284C7` | `star` | 6.59 |
| 24 h clock running | `#991B1B` / `#FEF2F2` / `#DC2626` + countdown | `timer` | 7.60 |
| Clock stopped / acknowledged / confirmed / draft / rule / reference | `#374151` / `#F3F4F6` / `#D5DBE1` (neutral) | `check`, `pencil`, `git-branch`, `book` | 9.37 |

Dark chips: fg = the 300-level tint (`#FCD34D`, `#FDBA74`, `#FCA5A5`, `#C4B5FD`, `#86EFAC`, `#7DD3FC`, all 9–12:1 on `#161B22`) on a 15% alpha of the hue, with a 1 px border in the 500-level. T3 is `#7F1D1D` fill with `#FEE2E2` text.

| Type role | Size / line-height / weight |
|---|---|
| `caption` (chips, meta, timestamps) | 12 / 1.35 / 500 |
| `table` (dense cells) | 13 / 1.35 / 400, tabular |
| `body` (forms, prose, Why panel) | 14 / 1.5 / 400 |
| `title` (panel heading) | 16 / 1.4 / 600 |
| `page` (h1) | 20 / 1.3 / 600 |
| `mono` (IDs, hashes, SDTM var names) | 12–13 IBM Plex Mono |

Font: IBM Plex Sans + Plex Mono, self-hosted. Nothing below 12 px. Uppercase only for 12 px column headers with `letter-spacing: .04em`.

Spacing (4 px base): 4 / 8 / 12 / 16 / 24 / 32. Table row 36 px (compact 32 px), cell padding 6 × 10, panel padding 12–16, page gutter 16 (1366) to 24 (1440+). App bar 48 px.

Radius: 4 (buttons, inputs, chips), 6 (panels), full (status dots only).

Elevation:

| Level | Use | Style |
|---|---|---|
| 0 | Panels | 1 px border, no shadow |
| 1 | Sticky header / table head | `0 1px 0 var(--border)` |
| 2 | Popover, menu, toast | `0 4px 12px rgb(17 24 39 / .12)` |
| 3 | Modal / drawer | `0 12px 32px rgb(17 24 39 / .20)` with a 50% scrim |

Motion: 120–150 ms colour and opacity only, with no route transitions.

Components to consolidate (one of each):
- `Button` (primary / secondary / ghost / danger-outline; sizes sm 28 px console, md 32 px, kiosk 64 px)
- `Chip` (status, with the table above)
- `DataTable` (sticky head, sortable, row-link, keyboard, skeleton, empty)
- `Panel` (replaces `Card` on the console)
- `Time`
- `Field` (label, input, helper, error)
- `Drawer` (evidence / Why)
- `Loading`, `EmptyState`, `ErrorBanner`
