# Interim UI audit: merged report

Report only: no app code was changed. This report merges four audits run with the ui-ux-pro-max skill (Quick Reference priorities 1→10):

| Code | Audit | File |
|---|---|---|
| PK | Patient kiosk | `docs/ui-audit/patient-kiosk.md` |
| CP | Coordinator power and efficiency | `docs/ui-audit/coordinator-power.md` |
| IA | Information architecture, navigation, data display | `docs/ui-audit/information-architecture.md` |
| VS | Visual system, consistency, accessibility | `docs/ui-audit/visual-system-a11y.md` |

- **Screenshots** are in `.playwright-mcp/ui-audit/`:
  - `c01`–`c16`: coordinator console at 1366×768 and 1440 full page.
  - `k01`–`k03`: kiosk at 1280×800 and 1024×768.
  - The Login page was not captured: `c17` shows the Queue. Login findings come from `pages/Login.tsx`.
- **Rule ids** are the skill's (e.g. `color-contrast`, `sortable-table`).
- **Priority:** P0 blocks the demo or fails accessibility. P1 is a clear workflow cost. P2 is polish.
- **Effort:** S is under 2 h, M is half a day, L is a day or more.

## Verdict

Under the screens, the app computes the right things. The surfaces are built for the wrong reader.

**The kiosk** is calm and mostly readable. But it has a privacy hole: nothing resets a half-finished check-in on a shared device. Its answer buttons fail WCAG 1.4.11 (border 1.48:1, and "selected" looks the same as "hover"). Next sits below the fold on both target screens. And clinical or developer wording reaches the patient: "Metastatic NSCLC", "HRV (RMSSD)", "HTTP 404 … usubjid".

**The console** reads like an explainer for first-time visitors, not a desk for trained staff:
- At 1366×768 the Queue shows about 1.5 rows, and the Open button is off-screen to the right.
- The check-in detail page is about 6,100 px tall.
- Confirming 6 drafts takes 12 clicks.
- No table can be sorted, and there are no keyboard shortcuts, search, count badges or next-item flow.

Three accessibility problems apply everywhere:
- The focus ring is 1.75:1.
- 68 text nodes are below 12 px.
- slate-400 information text is 2.56:1.

The fix is two separate token sets and two separate design attitudes, not one shared style.

- **Kiosk direction:** *Calm, large, one question at a time, with nothing clinical on screen.*
- **Console direction:** *Dense, keyboard-first, evidence one click away: a worklist, not a brochure.*

Rules every redesign must keep:
- The not-a-medical-device footer, word for word, on every page. On the kiosk it moves into the sticky action bar; on the console it becomes a slim sticky footer.
- MEASURED or SIMULATED as a visible word beside every vital, including compact cells.
- Click-to-evidence on every derived field.
- No grades, tiers or clinical words on the kiosk.
- Explicit tier names, e.g. "T2 · Nurse call today".
- One human click, recorded as an audit event per record, behind every confirm, including bulk confirm.

---

## Contradictions between auditors, resolved

| # | Topic | Auditor positions | Decision and reason |
|---|---|---|---|
| 1 | Camera consent on the kiosk | VS F-12: a dedicated Yes/No consent screen with nothing preselected. PK: a two-choice control on Welcome with Yes preselected. | **PK.** CLAUDE.md §00 and D-026 removed per-session consent; it is covered by the consent form signed at enrollment. Use a clear opt-out control, not a consent gate. |
| 2 | Vitals on the kiosk | VS F-11: keep a simplified numbers card. PK: replace it with a quiet "Camera on · SIMULATED" line, with numbers only in presenter mode. | **PK by default, plus presenter mode.** §00 demotes vitals. Live pulse numbers can make the patient anxious and push up the pulse being measured. The demo still shows numbers through `?presenter=1`. *Open question 1.* |
| 3 | Auto-advance after an answer | VS F-33: auto-advance after 300 ms. PK: no auto-advance. | **No auto-advance.** A participant with a tremor needs to see and fix a wrong tap. The new Review screen is the second safety net. |
| 4 | Kiosk "selected" style | VS: solid #115E59 fill with white text and a check. PK: #CCFBF1 tint, 3 px border and a radio. | **Solid fill, white text, check icon. Unselected options show an empty radio.** This gives the biggest visual difference between states (7.58:1 against white) and does not rely on the border alone. |
| 5 | Kiosk focus colour | PK: teal ring. VS: 3 px blue #1E3A8A. | **Blue.** Teal means "selected", so focus must look different. |
| 6 | Kiosk Next button before an answer | VS: grey disabled style plus helper text. PK: always enabled, with an inline prompt when tapped empty. | **PK.** A disabled button gives an older user no feedback. A tap that says "Please choose an answer" does. |
| 7 | Field labels on the console | CP: SDTM code first. §00 and IA: plain language first, codes one click deeper. | **Plain label first on one line, with the code as a 12 px mono suffix.** A per-user "Codes" mode serves experts. §00 overrides, and judges are mostly non-clinicians. |
| 8 | Time-saved strip | IA: remove it from the global header. §00.5: show it in the header and on the queue. | **Make it a one-line chip in the app bar (no second row), with the breakdown on the queue status line, hidden for investigators.** Stop crediting time for merely viewing a brief; that is an API change. *Open question 2.* |
| 9 | One worklist or separate pages | IA: merge Queue, Escalations, Queries and Notes into one tabbed Worklist. CP: keep the pages and add nav badges. | **Both, in two phases.** Badges now (S). The tabbed Worklist with redirects from the old routes later (L). The old routes keep working, so DEMO.md and tests don't break. *Open question 3.* |
| 10 | Date format | CP and VS: `10-Oct-2026 13:15`. IA: `Oct 10 13:15`. | **`10-Oct-2026 13:15`** (24 h, site-local, DD-MMM-YYYY as on paper case report forms). Dense cells show `10-Oct 13:15` in the current year. UTC on hover. |
| 11 | Console font | VS: IBM Plex. IA: Source Sans 3. CP: system font. | **IBM Plex Sans + Plex Mono, self-hosted.** It has distinct 0/O and 1/l/I, which matters for the long record IDs and participant IDs. Fall back to system-ui. |
| 12 | Kiosk question size | VS: 28 px. PK: 30–32 px. | **30 px**, weight 700. |
| 13 | Kiosk background | VS: #FAFAF7. PK: #F8FAFC. | **#F8FAFC.** It is already slate-50, so nothing has to change. |
| 14 | Bulk confirm | CP: bulk confirm for T0/T1 from the queue. IA: "Confirm all unchanged" with a confirmation step. | **Both, guarded.** Show a review list naming every draft, write one audit event per draft, and disable for T2/T3 and rows with a running clock. Acknowledgements are never bulk. |

---

## 1. Kiosk (`/kiosk`; `pages/kiosk/**`, `VitalsPanel`, `ProgressBar`, the `Button` option variant)

### Change
- **K-01** · P0 · S · `k02-*`. Answer button border is slate-300 at 1.48:1, and selected looks the same as hover (`color-contrast` WCAG 1.4.11, `state-clarity`, `color-not-only`) → unselected: white fill, 2 px #64748B border, 28 px empty radio. Selected: #115E59 fill, white 22 px/700 label, check icon. Hover only darkens the border. *(PK K-02, VS F-07)*
- **K-02** · P1 · M · `k02-*`. 7 of 10 screens ask two questions at once, so the second question falls below the fold (`progressive-disclosure`) → one question per screen, with the symptom as a small eyebrow label and the question as the H1. Put PRO-CTCAE branching (None/Never skips the follow-up) behind a flag until the rules owner confirms the scoring. *(PK, VS F-33)*
- **K-03** · P1 · M · `k02-question1-laptop` (Next at y≈850–916 in an 800 px viewport). The primary action is below the fold, and disabled Next is 2.21:1 and reads as broken (`fixed-element-offset`, `primary-action`, `disabled-states`) → sticky 88 px bottom bar. Back: secondary, 64 px, hidden on question 1. Next: #115E59, 72 px tall, at least 200 px wide, always enabled; an empty tap shows "Please choose an answer". Put the disclaimer in the bar. *(PK, VS F-08, F-13)*
- **K-04** · P1 · S · `k03-wrong-id-laptop`. "HTTP 404 Participant not found: No participant with usubjid P-999" shows above the field (`error-clarity`, `error-placement`, `focus-management`) → under the field in 18 px #991B1B: "We couldn't find P-999. Check the ID on your study card, or ask the front desk." Set `aria-invalid` and focus/select the input.
- **K-05** · P1 · S · `k01-*`. The "I'd rather not use the camera" checkbox is a double negative, and nothing says the camera is on during questions (`input-labels`) → a two-choice control, "Use the camera to read my pulse and breathing": [Yes] (preselected, per D-026) / [No, keep it off], each 64 px. Keep the no-video sentence word for word. *(PK; VS F-12 overruled, see contradiction 1)*
- **K-06** · P1 · S · free-text gate (`lib/gates.ts` otherNote). The patient sees developer copy, "never parsed by software" → "A member of the study team will read this. It may not be read today. If you need help now, tell the front desk or call 911." Make the label visible.
- **K-07** · P1 · M · fever item. °C only, so 101.2 °F is rejected with a confusing error → °F/°C toggle (default from a site setting), converted to °C before storing. The input is 64 px with `inputMode=decimal`.
- **K-08** · P1 · S · `k01`, `k02`. Secondary text is slate-500 (4.55:1) and the placeholder is slate-400 (2.56:1) (`color-accessible-pairs`) → kiosk text is only #0F172A or #334155 (10.35:1). Drop the study-ID placeholder.
- **K-09** · P1 · M · `ItemScreen.tsx`. Screen readers announce answers as "toggle button" and read the question twice, and focus is lost after Next (`voiceover-sr`, `focus-on-route-change`) → radiogroup semantics with arrow keys. Focus the H1 on each step and announce "Question N of M" politely.
- **K-10** · P1 · M · medication gate. One text box only, the keyboard covers Started/Stopped on a tablet, and "Both" next to a single name is unclear → ask the direction first with big buttons, then names (up to 3, stored exactly as typed). Add "I don't know the name – the study team can ask me".
- **K-11** · P2 · S · `Stop.tsx`. The stop text is one block, and it looks different from Thank-you, so bystanders can tell → split into sentences with the 911 line in a neutral bordered box, no red. Same layout, icon and countdown as Thank-you. Text stays word for word.
- **K-12** · P2 · S · `ThankYou.tsx`. The ✓ is a text glyph and the screen resets silently (`no-emoji-icons`, `timeout-feedback`) → 64 px SVG check and "This screen will close in 45 s" with tabular figures.
- **K-13** · P2 · S · spinners. With reduced motion the spinners still loop, and Next flashes a spinner on every tap (`reduced-motion`, `loading-states`) → static "Saving…" under reduced motion. Show a spinner only after 300 ms.

### Add
- **K-14** · P0 · M · `KioskFlow.tsx`. No inactivity reset: the next person can press Back through the previous participant's answers → after 90 s idle, a full-screen "Are you still there?" with a 30 s countdown, then `reset()` and the session marked abandoned (needs an API field). Also reset after the tab has been hidden for more than 5 min.
- **K-15** · P1 · M · before submit. One mis-tap on "Severe" can trigger paging, and there is no way to see it (`undo-support`) → a "Check your answers" screen listing only answers above None, plus the 3 gates, each with a 56 px "Change" button. Primary button: "Send to study team".
- **K-16** · P1 · M · `KioskShell` header. No exit and no help (`escape-routes`) → a 48 px "Need help?" button opening a fixed card, "Please ask a member of the study team at the front desk", with [Back to my check-in] and [Stop and leave] (needs a second tap to confirm on the page).
- **K-17** · P1 · L · item screens. No "prefer not to answer", so patients guess → a 48 px "I'd rather not answer" link that records a decline. This changes the API/rules contract: log it in ISSUES.md and ship only once the backend accepts it.
- **K-18** · P2 · M · all copy. Not ready for translation → move kiosk wording into a locale-keyed `kioskCopy.ts`. Spanish items need licensed PRO-CTCAE translations; list them in NOT_BUILT.md.
- **K-19** · P2 · S · Welcome. No text-size control (`dynamic-type`) → a "Larger text" toggle (root 20 → 24 px). Test 200% zoom; drop the sticky bar when the screen is under 500 px tall.
- **K-20** · P2 · M · `/kiosk`. Browser Back leaves the kiosk (`back-behavior`) → one history entry per step, and DEMO.md says to run the kiosk fullscreen.

### Remove
- **K-21** · P1 · S · `VitalsPanel` on `k02-*`. Live pulse, "HRV (RMSSD)", "mock", "Signal is weak" and a beating waveform look like an ICU monitor (`motion-meaning`, no clinical language) → one 18 px line: camera icon, "Camera on · Reading pulse and breathing", a 14 px **SIMULATED/MEASURED** badge, "Turn camera off". The full card appears only with `?presenter=1` or the admin setting. *(PK; VS F-11 partly kept)*
- **K-22** · P1 · S · `k01`, `k02` header. The registry title, "…Metastatic Non-Small Cell Lung Cancer", is on every screen (reading grade 13.6) → remove it. Welcome may show a site-set friendly name ("Your study check-in"). *(PK, VS F-10)*
- **K-23** · P2 · S · `k01` header. The logo is an empty teal square → an SVG mark or wordmark only. Welcome H1: "Let's check in on how you've been feeling", with "13 short questions · about 3 minutes" beneath.

### Format
- **K-24** · P1 · S · `k02-*`. The 2-column grid makes the scale zig-zag, and labels are centred (`visual-hierarchy`) → one column in scale order, rows 64 px tall, 12 px gaps, left-aligned labels.
- **K-25** · P1 · S · `k02-*`. "QUESTION 1 OF 10" and "0 of 13" disagree (`multi-step-progress`) → one counter, "Question 3 of 13" at 18/600, with an 8 px bar (slate-300 track, brand fill).
- **K-26** · P1 · S · `ItemScreen.tsx`. The type sizes are upside down: the symptom name is 36 px, the question 20 px and the answers 18 px, with an all-caps eyebrow (`font-scale`, `weight-hierarchy`) → eyebrow 18/600 sentence case; question H1 30/700, line-height 1.3, max width 34 rem; answers 22/600; helper 18.

---

## 2. Console: global shell and navigation (`components/Layout.tsx`, all `c*`)

### Change
- **G-01** · P0 · M · `c01`, `c03`. The header is 2 rows and about 170 px (22% of 768). The title is cut to "Study of REG…", the role is printed twice, and Open kiosk sits next to Sign out (`content-priority`, `destructive-nav-separation`) → one 48 px app bar:
  - left: `[Interim] Queue· Escalations· Queries· Notes` with count badges
  - right: `[Jump to… /] [R2810-ONC-1624 · NCT03088540 ▾] [SYNTHETIC] [time-saved chip] [User ▾]`

  The study chip opens a popover with the full title. This recovers about 120 px, roughly 3 more rows. *Another agent is editing `Layout.tsx`; coordinate.* *(CP, IA-01, VS F-15)*
- **G-02** · P0 · S · all pages. The focus ring #72D4CA is 1.75:1 and 8 components use their own ring variants (`focus-states`) → one `--focus` token: 2 px #0F766E outline with 2 px offset (5.47:1). Delete the per-component rings. *(VS F-01)*
- **G-03** · P0 · S · `QueueTable.tsx:117,168,188,209,369`, `Queue.tsx:187`, `PacketParts.tsx:496`, audit `EventsTable`. slate-400 information text is 2.56:1, with its meaning only in tooltips (`color-contrast`, `hover-vs-tap`) → the lightest text is `--text-subtle` #5F6B7A (5.43:1). Replace a bare "—" with "none" or "n/a". "Clear filters" uses #475569. *(VS F-04, IA-31, CP)*
- **G-04** · P0 · S · 68 uses of `text-[10px]`/`text-[11px]`. The SIMULATED badge is 11 px (`readable-font-size`) → a 12 px floor on the console; MEASURED/SIMULATED at least 12 px. Ban arbitrary `text-[Npx]` through an eslint rule or role-named fontSize. *(VS F-03)*
- **G-05** · P1 · S · `c03`, `c05`, `c08`, `c09`. No nav item is active on deep pages, and the active tint is 1.03:1 (`nav-state-active`) → route ownership: check-in → Queue, packet → Escalations (Reports later), brief/timeline → Participant. Show a 2 px #0F766E underline plus semibold.
- **G-06** · P1 · M · nav. Audit, Eval and Admin have the same weight as Queue (`nav-hierarchy`) → a separated "System" group in the user menu: Audit trail · Evaluation · Admin · Open kiosk ↗ · Demo guide · Sign out (after a divider). Routes stay unchanged.
- **G-07** · P1 · M · `lib/format.tsx`, chips (`c01`, `c05`, `c10`). Amber means 8 things, and a **green chip reads "Serious event — clock stopped"** (`color-semantic`) → reserve hues:
  - tier ramp: neutral, amber, orange, red
  - violet: simulated/synthetic only
  - green: MEASURED only
  - teal: action/selection only
  - red outline: SAE or running clock
  - blue: AESI
  - everything else: neutral chip plus icon

  *(VS F-05)*
- **G-08** · P1 · S · `TierChip`. The T1 and T2 fills are 1.09:1 apart (`color-not-only`) → change shape and icon as well as colour: T0 outline + circle, T1 amber + clock, T2 orange 2 px border + phone, T3 solid #B91C1C + siren, plus a 4 px left stripe on the queue row. Keep the full names. *(VS F-06)*
- **G-09** · P1 · M · `Button.tsx`, `Card`. The console reuses kiosk-sized controls (44 px+, rounded-xl, shadows, nested cards) (`elevation-consistent`) → console sizes: controls 28–32 px, radius 4 (controls) / 6 (panels), flat 1 px borders, no nested cards. Keep 64 px sizes for `/kiosk` only. *(CP, VS F-19)*
- **G-10** · P1 · S · `c03`, `c05`, `c09`, `c12`. Breadcrumbs differ on every page, including a raw record ID in the check-in crumb (`breadcrumb-web`) → one Breadcrumb, Section › P-003 › Object ("Queue › P-003 › Check-in 10-Oct 13:10"), with the record ID in a copy chip. *(IA-07)*
- **G-11** · P1 · S · `c10`, `c13`, `c07`. "R2810-ONC-1624-P-003" wraps over 3 lines and the Queue uses P-003 (`consistency`) → show P-003 everywhere as a link, with USUBJID on hover and a copy button. The full ID appears in exports only. *(CP, IA-14, VS F-25)*
- **G-12** · P1 · S · app bar. The time-saved strip takes a whole row, and opening one brief jumps it from ≈28 min to ≈1.1 h → a one-line chip in the app bar, breakdown on the queue status line, hidden for investigators. Credit a brief only when it is printed or marked used (API). *(IA-16; contradiction 8)*

### Add
- **G-13** · P1 · M · nav, `Queue.tsx` toast. Nothing shows that a query, alert or clock is waiting, and the urgent toast fires only on the Queue page (`tab-badge`, `toast-accessibility`) → poll once in Layout. Badges on Queue (needs action), Escalations (not acknowledged), Queries (open; red after 72 h). `document.title` shows "(2) Interim". A global aria-live toast for new T2/T3.
- **G-14** · P1 · M · app bar. No search and no participant list (`search-accessible`) → Ctrl+K or `/` command palette. It finds P-003, a USUBJID, a record ID, query id or AE term, and runs actions such as "Open brief for P-003" or "Export AE CSV".
- **G-15** · P1 · M · whole console. No keyboard layer (`keyboard-shortcuts`, `keyboard-nav`) → `g q/e/y/n/a` to go to sections; `j/k`, `Enter`, `x` in tables; `c/e/r/a` on detail; `]`/`[` next/previous item; `Ctrl+Enter` save, `Esc` cancel; `?` opens a shortcut sheet. Never capture keys while typing in a field.
- **G-16** · P1 · M · `lib/auth.ts:44`, `lib/api.ts`. An expired session loses work mid-edit (`timeout-feedback`, `form-autosave`) → a banner 5 min before expiry ("Session ends 15:51 · Stay signed in"). On a 401, show a re-login modal and keep the form state in sessionStorage.
- **G-17** · P1 · M · user menu. Judge explanations clutter staff pages → a "Demo guide" toggle (on with `?guide=1`, and for the first session) that shows dismissible "How this works" side notes. All pitch copy moves there. *(IA-22)*
- **G-18** · P1 · S · user menu. Plain vs code labels serve only one audience at a time → "Field names: Plain · Both · Codes" (localStorage). A separate "Show technical ids" toggle covers record IDs, rule ids and template keys. *(IA-20, contradiction 7)*
- **G-19** · P2 · S · `Layout.tsx`. No skip link, and focus stays put on route change (`skip-links`, `focus-on-route-change`) → a "Skip to main content" link; focus the h1 after navigation. *(IA-06, VS F-27, CP)*
- **G-20** · P2 · S · `App.tsx`. Every tab has the same title → per-route titles, e.g. "P-003 · Check-in 10-Oct · Interim". *(IA-05)*
- **G-21** · P2 · S · 22 files. 22 different "Loading…" strings, 5 ad-hoc spinners and no empty states (`progressive-loading`, `empty-states`) → shared `<Loading>` (shown after 300 ms), `<TableSkeleton>` and `<EmptyState title body action>`. Keep `ErrorBanner`. *(VS F-26, IA-29)*
- **G-22** · P2 · M · whole app. Unicode glyphs used as icons (✓ ✕ ▶ ⇄, and → 115 times) plus hand-drawn SVGs (`icon-style-consistent`) → Lucide (ISC): 16 px on the console, 24 px on the kiosk, stroke 2, an `aria-label` on every icon-only control. *(VS F-16)*
- **G-23** · P2 · M · Queue, Escalations, Queries. Exports exist only on Audit, and data freshness shows only on the Queue (`export-option`) → "Export ▾ (CSV/JSON of this view)", audited, on each list. A print stylesheet. A global "↻ 15 s" freshness indicator in the app bar.
- **G-24** · P2 · M · tokens. No dark theme → a console-only dark theme after the tokens move to CSS variables. The kiosk stays light. Do not do this first. *(VS F-20)*

### Remove
- **G-25** · P1 · S · `c01`, `c07`, `c10`, `c11`, `c14`, `c16`. Pitch and developer copy on staff pages: "nothing is re-ranked in the browser", "(D-017)", "regex + NegEx", "CLAUDE.md §8", "query.cm_required_fields_missing", `aesi_narrative.*` keys → move it to the Demo guide (G-17) or behind "Show technical ids". Admin may keep HTTP paths. *(CP, IA-15)*
- **G-26** · P1 · S · `c01`. The doubled role label and the time-saved second row → delete both; the role goes in the user menu.

### Format
- **G-27** · P1 · S · `c03` AESTDTC, `c05` packet dates, `c11` note date, `c13` audit. Six date formats, including raw `2026-10-10T17:10:29.487Z` (`number-formatting`) → one `<Time>` component showing `10-Oct-2026 13:15` local 24 h, UTC on hover/copy, `whitespace-nowrap`, durations as `13 h 23 m`. ISO appears only in the evidence popover and exports. *(CP, IA-19, VS F-17)*
- **G-28** · P1 · S · all tables. Tabular figures are opt-in (98 manual uses) (`number-tabular`) → `tabular-nums` by default on `table`, `time`, countdowns and vitals. *(VS F-32)*
- **G-29** · P1 · S · all `c*`. Up to 5 names for one concept (Priority / Alert / Alert level / Tier / Escalation) → a glossary in `docs/` and the Demo guide:
  - Tier (T0 Log / T1 Review within 1 business day / T2 Nurse call today / T3 Urgent)
  - Acknowledged
  - Side effect (AE)
  - SAE report / AESI report (drop "packet" from the UI)
  - Check-in
  - Note / Call
  - Report clock (24 h)
  - Grade N (provisional)

  *(IA-18)*
- **G-30** · P2 · S · all `c*`. On 4,000–6,000 px pages the disclaimer is seen only at the very end → a slim sticky footer (28 px, 12 px #475569, 7.6:1). The text stays word for word. *(IA-30)*

---

## 3. Queue / worklist (`Queue.tsx`, `queue/QueueTable.tsx`; `c01`, `c02`)

Measured at 1366×768:

| Measure | Value |
|---|---|
| First row starts at | y≈537 px |
| Rows visible above the fold | 1.5 |
| Row height | about 155 px |
| Columns visible | 8 of 10 |
| Open button | off-screen to the right |
| Length of a 25-row page at 1440 | 4,440 px |
| Opening one item | 1 sideways scroll + 1 click |

Target: at least 14 rows above the fold and no horizontal scroll at 1280.

### Change
- **Q-01** · P0 · S · `c01`. The only Open action is off-screen, and the participant link goes to the timeline (`horizontal-scroll`, `primary-action`) → the whole row is the link (`tr` focusable; click or Enter opens). Remove the Open column. At most 8 columns: Participant (+ unread dot, with a Check-in/Note/Call icon prefix) · Received · Tier (with ack word) · Max grade (prov.) · Vitals · Report clock · Drafts AE/VS/CM. Brief and Timeline become hover/focus row actions. *(CP, IA-21, VS F-02)*
- **Q-02** · P0 · M · `c01`, `c02`. Rows are about 155 px because the Vitals cell repeats "Simulated (ignored for rules)" over 3 lines plus a badge (`data-density`, `whitespace-balance`) → 36 px single-line rows, 13 px text, 6×10 px cell padding. Vitals cell: `83/13 SIMULATED` on one line, with "ignored for rules" in the tooltip and legend. *(CP, IA-21, VS F-02, F-22)*
- **Q-03** · P1 · M · `c01` "Since you were last here". Its chips look like buttons but do nothing, and the card costs about 100 px (`state-clarity`) → a quick-filter row of saved views: `Needs action 7 · Clocks running 2 · Unacked 3 · Open queries 1 · All`, plus one line "Since Sun 18:02: 3 check-ins · 3 notes · 1 call". Unseen rows get a 3 px brand left bar and a bold participant. *(CP, IA-10)*

### Add
- **Q-04** · P1 · M · column headers. Nothing can be sorted (0 `aria-sort` in the app) (`sortable-table`) → sortable `<th><button>` with `aria-sort` for Tier, Received, Report clock, Participant and Grade, using a server sort param so the rules engine stays the source of truth. The default stays "tier desc, time desc" and is labelled "Sorted by: priority (server)". Sort state goes in the URL. *(CP, IA, VS F-21)*
- **Q-05** · P1 · S · `thead` and filters. Column meaning scrolls away (`sticky-navigation`) → make the filter row and thead sticky under the app bar.
- **Q-06** · P1 · L · table. No multi-select → a checkbox column and a bulk bar, "Confirm drafts of N selected (T0/T1 only) · Export CSV". Opens a review list and writes one audit event per draft. Disabled for T2/T3 and running clocks. *(CP; contradiction 14)*
- **Q-07** · P2 · S · table. One density for everyone → a Compact 36 / Comfortable 44 toggle in the user menu. Optional right-hand preview pane (M) so the list stays put.

### Remove
- **Q-08** · P2 · S · `c01`, `c02`. The intro paragraph and the bottom legend → a `?` popover on the table header.
- **Q-09** · P2 · S · `c01` filter. "Include eval runs (harness sessions)" → "Show test runs", inside "More filters".

### Format
- **Q-10** · P1 · S · `c02` Report due. "Serious event — report due in 20:35 SAE" wraps (`number-tabular`) → `SAE 20:35` / `AESI 13:23` as tabular h:mm. Red under 4 h, amber under 12 h; "stopped" is neutral.
- **Q-11** · P2 · S · Most severe column. "Grade 2 provisional" on every row → header "Max grade (prov.)", cell `2`.

---

## 4. Check-in detail (`CheckInDetail.tsx`, `detail/*`; `c03`, `c04`, also `c12` note detail)

Measured: the page is 6,103 px tall at 1440. Each AE card is about 700 px; each VS card is about 600 px for one number. The page has 21 primary-weight buttons and a 23-sentence Why list. Confirming 6 drafts takes 12 clicks and about 8 scrolls.

### Change
- **D-01** · P1 · L · `c03`, `c04`. The narrow middle column of tall cards wraps labels over 3 lines (`data-density`, `progressive-disclosure`) → master-detail:
  - left: a sticky answers rail, 280 px
  - centre: a drafts table, one row per draft (Dom · Term · Gr · Status · Evidence # · actions), expanding in place to a two-column key:value grid
  - right: a collapsible Why rail, which becomes a drawer below 1440

  Target: the whole check-in in 2 screens or fewer at 1366. *(CP, IA-23, VS F-23)*
- **D-02** · P1 · M · `DraftsColumn.tsx`. Confirm takes 2 clicks per draft (Confirm, then the note form), with no next item (`primary-action`, `success-feedback`) → Confirm commits on one click or `c`, with the optional note collapsed. Focus moves to the next pending draft. After the last one, a "Next open item ▸ (])" bar. "Confirm remaining (N)" opens a review list and writes one event per draft. *(CP)*
- **D-03** · P1 · M · `WhyPanel.tsx`. 23 prose sentences are slow to scan → default to a rule table: Rule | Inputs | Threshold | Result (e.g. `corr.sob_rr | SOB comp 2, RR 26 | ≥2 & ≥24 | +1 tier`). An "Explain in plain English" toggle is remembered, and defaults on with `?explain=1` or `?guide=1` for the demo. *(CP)*
- **D-04** · P1 · M · edit form. A block form with 10 px mono labels and no keyboard save (`keyboard-nav`, `inline-validation`) → inline edit: click the value or press `e`. Enter or Ctrl+Enter saves a new version, Esc cancels, Tab goes to the next field; "v2 saved" shows inline.
- **D-05** · P1 · M · `c04` VS section. Three full cards for three numbers → one VS table: VSTESTCD | Result | Unit | Method **SIMULATED** | Conf | Time | ☐, with "Confirm vitals (3)". The SIMULATED word stays on every row. *(CP, IA-23)*
- **D-06** · P1 · S · `c03`. Reject is a solid red button next to solid Confirm on every card (`destructive-emphasis`) → outline-danger Reject that asks for its reason inline. *(VS F-23)*

### Add
- **D-07** · P2 · S · `c03` header. Header actions scroll away, and "Open report packet" is about 2 screens down → a sticky 44 px header, `P-003 · T2 Nurse call today · SIMULATED · AESI 13:23 → report · ◂ 3 of 7 ▸`. *(CP)*
- **D-08** · P1 · S · `c12` note detail. Raw `INTERIM_GRADE_BASIS` and similar fields have no labels and no disclosure → "Show system fields (9)" on both detail pages, plus plain labels. *(IA-20)*

### Remove
- **D-09** · P2 · S · `c03`. The Refresh button duplicates auto-refresh → remove it; the app-bar freshness indicator (G-23) covers it.

### Format
- **D-10** · P2 · S · `c03`, `c04` answers. 16 answers, mostly "None (0)", all at equal weight (`visual-hierarchy`) → non-zero answers first in bold; zeros collapse into "9 answers None/Never · show".
- **D-11** · P2 · S · evidence chips. Chips are colour-coded with status hues (Rule = amber) → neutral chips (#374151 on #F3F4F6) with a kind icon: message-square (answer), activity (vitals), git-branch (rule), book (reference), file-text (note). *(VS F-24)*

---

## 5. Report packet (`packets/*`; `c05`, `c06`, `c15`)

Measured: 23 flat rows, each with its own Edit button. The 6 missing fields are not marked required, and filling them takes at least 13 clicks. As investigator (`c15`), the decision fields are rows 21–23 of 23, and Sign is a secondary button next to a disabled teal Save.

### Change
- **P-01** · P1 · L · `c05`, `c06`. A flat list in which missing values are italic "Not known yet" (`field-grouping`, `required-indicators`) → sections with counters: Event 5/5 · Timing 3/4 · Study drug 1/3 · Investigator decisions 0/3 · Reporter 1/1. Required fields are marked "* Required". Edit inline (click the value or press Enter). A sticky action bar holds `Save (Ctrl+S) · Print · Export JSON · Sign · 6 required missing ▸ · 13:23 left`. *(CP, IA-25)*
- **P-02** · P1 · S · `c15`. The investigator has to scroll to rows 21–23, and Sign is not the primary button (`primary-action`) → for the investigator role, pin AESER/AEREL/IRAE plus Sign (primary) into the action bar. Investigator-only fields show read-only to coordinators (`read-only-distinction`). *(IA-09)*

### Add
- **P-03** · P1 · S · "Information still needed (6)". The checklist is separate from the fields it refers to (`error-summary`) → each item is an anchor that focuses its field.

### Remove
- **P-04** · P2 · M · `c05` narrative. 11 bordered cards with chip rows, about 1,100 px → one continuous paragraph with superscript evidence markers; clicking a marker highlights the source. Click-to-evidence is kept, and so is the "written by template" label. *(CP)*
- **P-05** · P1 · S · `c05`. `aesi_narrative.*` keys, raw record IDs and the intro paragraph → behind "Show technical ids" and the Demo guide.

### Format
- **P-06** · P2 · S · `c06` "Report due" card. The countdown scrolls away → pin `13:23 left · due 11-Oct 13:15` in the action bar. Seconds under 1 h, red under 4 h.
- **P-07** · P1 · S · `c05` SITE_AWARENESS_AT, REPORT_DUE_AT. Raw ISO dates → `<Time>` (G-27).

---

## 6. Queries (`queries/*`; `c07`)

### Change
- **QR-01** · P2 · S · "Raised by" shows `query.cm_required_fields_missing`, and the participant and record are not links → "Automatic data check: required fields missing" (id in a tooltip). Participant links to the hub/timeline; the record links to the draft field. *(IA-26)*

### Add
- **QR-02** · P1 · M · table. No due date, no SLA, no assignee, no sort (`sortable-table`) → columns: Due (72 h SLA remaining) · Assigned to · Field (CM.CMDOSE). Sort by due; filter by participant and kind. *(CP)*

### Remove
- **QR-03** · P2 · S · 3 lines of explanatory prose on top → the Demo guide.

### Format
- **QR-04** · P1 · S · Age "71 h" sits 1 h from the 72 h limit with no warning (`color-not-only`) → an age chip with the word: amber at 48 h or more, red over 72 h. Use P-005 in the question text.

---

## 7. Visit brief (`brief/*`; `c08`)

### Change
- **B-01** · P2 · S · "Questions to ask at the visit" is buried → put it at the top as a sticky checklist. *(IA-17)*

### Remove
- **B-02** · P1 · M · `c08`. The "In one paragraph" column repeats about 100% of the left column, making the page 3,240 px, and there are two print buttons → a single-column print document. The narrative becomes a collapsed "Narrative (for the visit note)", expanded in print. Keep one Print button. *(CP, IA-17)*

### Format
- **B-03** · P2 · S · 2–8 evidence chips per sentence ("Record ..166ETK") → one "6 sources" chip that expands on click; hidden in print.

---

## 8. Timeline and the participant hub (`ParticipantTimeline.tsx`; `c09`)

### Change
- **T-01** · P1 · M · `c09`. 10 small-multiple line charts, 7 flat at G0, drawn with smoothed `monotone` curves that imply values between grades (`chart-type`, `data-density`) → a symptom × check-in grid: 10 rows, one column per date, each cell showing the grade number on a 4-step fill. Rows that are G0 throughout collapse into "7 never reported". Clicking a cell opens the evidence. If lines are kept, use `stepAfter` with a fixed 0–3 axis. *(CP, IA-27, VS F-29)*
- **T-02** · P1 · S · vitals chart. The axis auto-scales to 82–86 bpm, so noise looks like a trend, and "SIMULATED" is printed 10 times (`axis-labels`, `trend-emphasis`) → fixed axes (pulse 40–140 with a shaded 60–100 band; breathing 6–36 with 12–20). A direct series label "Pulse · SIMULATED", hollow points for simulated and filled for measured. Keep the table view. *(IA-28)*

### Add
- **T-03** · P1 · L · no route. No participant roster, no hub, and a participant's queries are unreachable → `/dashboard/participants`: a sortable roster (last check-in, next visit, open AEs, clocks, queries, drafts, vitals word). A hub at `/participants/:id` with tabs Overview · Brief · Side effects · Medications · Reports · Queries · Activity. Every participant ID links there; the old routes redirect. *(IA-12, IA-13)*

### Remove / Format
- Covered by T-01 (drop the 10 per-chart "Table view" toggles in favour of the grid, which is itself a table).

---

## 9. Notes and calls (`Notes.tsx`; `c11`, `c12`)

### Change
- **N-01** · P1 · M · `c11`. The ingest and Log-call forms fill the first ~1,300 px and the worklist is at the bottom (`content-priority`) → worklist table first. "+ New ▾ (Note | Call)" in the app bar opens a 480 px right-side sheet, prefilled with the participant when launched from the hub. *(CP, IA-11)*

### Remove
- **N-02** · P1 · S · `c11`. "Answer key for this sample" and "Load sample" are shown to coordinators → admin or Demo-guide only.

### Format
- **N-03** · P1 · S · `c11` "Note date" wraps as "2026-10-" / "09" → `<Time>`, nowrap (G-27).
- (Note detail: see D-08.)

---

## 10. Escalations (`Escalations.tsx`; `c10`)

### Change
- **E-01** · P2 · S · `c10`. 4 large KPI cards (about 90 px), and Reasons cells of up to 20 lines / 300+ words → one stat line, "Open 3 · Median ack 29m19s · Active clocks 2 · Pages 1". Reasons show the first reason in plain words plus "+3 more" inline. Full rule text goes to the Why panel. Acknowledge stays per row (no bulk). *(CP, IA-24, VS F-25)*
- **E-02** · P1 · S · USUBJID wraps over 3 lines → P-003 (G-11).

### Add
- **E-03** · P2 · S · Time to acknowledge → a live tabular chip that turns red past the tier's target. Phase 2: becomes the Worklist "Needs acknowledgement" tab. *(IA-08, IA-24)*

### Remove
- **E-04** · P1 · S · "(D-017)", "tier floor" and "-> seriousness suspected (ICH E2A)" in the reasons → plain words; rule ids behind "Show technical ids" (G-25).

---

## 11. Audit, Eval and Admin (`c13`, `c14`, `c16`)

### Change
- **A-01** · P1 · M · `c13`. Exports (submission bundle, CSV/JSON per domain, Post to EDC) live on the Audit page, but exporting is a coordinator task → a Reports › Data export page (or an Export menu). Audit keeps a one-line "Exports are audited" link. *(IA-32, CP)*
- **A-02** · P1 · S · `c16`. With "Treat simulated as measured" off, the switch is 1.23 / 1.48:1 and its state is `sr-only` (WCAG 1.4.11) → a #7B8794 track border, a visible OFF/ON word, and an amber warning row when ON. *(VS F-37)*
- **A-03** · P2 · S · `c13` filters. "Action (exact name)" is free text, and the participant filter does not accept P-003 → a select or autocomplete of action names; accept P-003; 50 rows per page (1,803 events = 73 pages at 25).
- **A-04** · P2 · M · `c14`. One 4,500 px page → tabs: Run test set · Personas (sortable) · Build your own (form and live result side by side). Hidden judge personas stay one click away for DEMO.md step 6. *(IA-33)*

### Add
- **A-05** · P2 · S · `c13`. The Verify result does not stay on the page → a persistent badge, "✓ Chain verified · 1,803 events · head 4a22… · 23:52", or the first broken link in red.

### Remove
- Nothing. Admin may keep HTTP paths and CLAUDE.md references; it is the one page where that copy belongs.

### Format
- **A-06** · P2 · S · `c13` event rows are about 60 px, with 2–3 chip lines → single-line rows (seq · time · actor · action · entity P-003 · hash); payload chips move into the existing Payload drawer.
- **A-07** · P2 · S · `c16` Save settings, disabled, is 50% teal and looks broken → neutral disabled style with a "No changes" label.

---

## 12. Login (`pages/Login.tsx`; not captured: `c17` shows the Queue)

### Change
- **L-01** · P1 · S · The role picker reuses the kiosk `option` button (1.48:1 border, 56 px) and the password border is slate-300 → a compact radio list (Coordinator / Investigator / Admin) with #7B8794 borders and a 2 px focus outline.
- **L-02** · P1 · S · Every role lands on the Queue, and the investigator has no inbox → land each role on its own view: coordinator → Queue; investigator → "Awaiting investigator" (reports to sign, AESER/AEREL undecided); admin → /admin. *(IA-09)*
- **L-03** · P2 · S · The tagline "Between-visit check-in desk" is out of date → "Safety-data desk for study sites" (§00).

### Add
- **L-04** · P2 · S · No show/hide password and no autofocus (`password-toggle`) → a show toggle and autofocus on the password field. Keep the demo-auth disclosure line.

### Format
- **L-05** · P2 · S · The disabled Sign-in button gives no reason → keep it enabled and validate inline ("Enter the demo password").

---

## Design system proposal

Implement both sets as CSS custom properties in `src/styles/index.css`, mapped to role-named Tailwind colours (`bg-surface`, `text-muted`, `chip-t2-bg`). Delete raw status hues from components. The kiosk tokens apply only under `/kiosk` (a `data-surface="kiosk"` root attribute).

### Kiosk tokens: calm, large, light only

| Token | Hex | Role / contrast |
|---|---|---|
| `--k-bg` | #F8FAFC | canvas |
| `--k-surface` | #FFFFFF | options, cards, action bar |
| `--k-text` | #0F172A | all body text (17.85:1) |
| `--k-text-2` | #334155 | lightest text allowed (10.35:1) |
| `--k-border` | #64748B | option/input boundary (4.76:1, passes 1.4.11) |
| `--k-divider` | #E2E8F0 | decorative only |
| `--k-primary` | #115E59 | Next and the selected option fill; white text 7.58:1 |
| `--k-primary-hover` | #134E4A | |
| `--k-focus` | #1E3A8A | 3 px outline, 3 px offset (10.4:1); blue so it never reads as "selected" |
| `--k-error-fg` / `-bg` | #991B1B / #FEF2F2 | inline validation (7.6:1) |
| `--k-simulated` fg/bg/border | #4C1D95 / #EDE9FE / #7C3AED | 9.2:1 |
| `--k-measured` fg/bg/border | #14532D / #DCFCE7 / #16A34A | 8.3:1 |

No tier colours, and no red, amber or orange anywhere on the kiosk; the stop screen uses the same calm palette.

| Kiosk type role | Size / line-height / weight |
|---|---|
| Disclaimer (verbatim) | 16 / 1.5 / 400 |
| Helper, eyebrow, counter | 18 / 1.5 / 400–600 |
| Answer labels, body | 22 / 1.45 / 600 (selected 700) |
| Question (H1) | 30 / 1.3 / 700, max-width 34 rem |
| Screen title (Welcome, Thank-you) | 36 / 1.2 / 700 |

- **Font:** Atkinson Hyperlegible, self-hosted via `@fontsource` (OFL, works offline), falling back to system-ui. Root size 20 px; a "Larger text" toggle raises it to 24 px. No all-caps.
- **Spacing:** 8 px base: 8 / 16 / 24 / 32 / 48 / 64.
- **Sizes:** options 64 px tall with 12 px gaps; content max width 40 rem; sticky action bar 88 px plus the safe-area inset.
- **Radius:** 12 (inputs, options) and 16 (cards).
- **Elevation:** 0 (flat) and 1 (`0 1px 3px rgb(17 24 39/.08)`, action bar only).
- **Icons:** Lucide, 24 px, stroke 2.
- **Motion:** 150 ms colour/opacity only. No waveform, no auto-advance, no route transitions.

### Console tokens: dense, flat, keyboard-first (light default; dark later)

| Token | Light | Dark (phase 2) | Role / contrast |
|---|---|---|---|
| `--bg-canvas` | #F4F6F8 | #0F1419 | page (panels separate without shadows) |
| `--bg-surface` | #FFFFFF | #161B22 | panels, tables |
| `--bg-subtle` | #F1F4F7 | #1C2128 | table head, row hover |
| `--bg-selected` | #E6F2F1 | #123B38 | focused/selected row |
| `--border` | #D5DBE1 | #30363D | dividers |
| `--border-strong` | #7B8794 | #8B949E | inputs, switches, checkboxes (3.66:1) |
| `--text` | #111827 | #E5E7EB | 17.7:1 |
| `--text-muted` | #4B5563 | #9CA3AF | 7.56:1 |
| `--text-subtle` | #5F6B7A | #8B949E | lightest text allowed (5.43:1); never slate-400 |
| `--accent` | #0F766E | #2DD4BF | primary buttons, links, selection, active nav (5.47:1) |
| `--focus` | #0F766E | #5EEAD4 | 2 px outline, 2 px offset |
| `--danger` | #B91C1C | #F87171 | outline-danger buttons, overdue clock |

Status chips. Every chip carries a word; the icon is extra.

| Meaning | fg / bg / border | Icon | Contrast |
|---|---|---|---|
| T0 · Log | #374151 / #F3F4F6 / #9CA3AF (outline) | circle | 9.37 |
| T1 · Review within 1 business day | #713F12 / #FEF3C7 / #D97706 | clock | 7.79 |
| T2 · Nurse call today | #7C2D12 / #FFEDD5 / #EA580C (2 px) | phone | 8.18 |
| T3 · Urgent | #FFFFFF / #B91C1C (solid) | siren | 6.47 |
| MEASURED | #14532D / #DCFCE7 / #16A34A | activity | 8.30 |
| SIMULATED / synthetic | #4C1D95 / #EDE9FE / #7C3AED | flask-conical | 9.23 |
| SAE (suspected) / 24 h clock running | #991B1B / #FEF2F2 / #DC2626 + countdown | alert-octagon / timer | 7.60 |
| AESI (possible) | #075985 / #E0F2FE / #0284C7 | star | 6.59 |
| Draft, rule, reference, open, acknowledged, clock stopped | #374151 / #F3F4F6 / #D5DBE1 | pencil, git-branch, book, check | 9.37 |

| Console type role | Size / line-height / weight |
|---|---|
| `caption` (chips, meta, column headers) | 12 / 1.35 / 500 (headers uppercase, +0.04em) |
| `table` | 13 / 1.35 / 400, tabular |
| `body` (forms, Why panel) | 14 / 1.5 / 400 |
| `title` (panel) | 16 / 1.4 / 600 |
| `page` (h1) | 20 / 1.3 / 600 |
| `mono` (IDs, hashes, SDTM names) | 12–13 IBM Plex Mono |

- **Font:** IBM Plex Sans + IBM Plex Mono, self-hosted. Nothing below 12 px.
- **Spacing:** 4 px base: 4 / 8 / 12 / 16 / 24 / 32.
- **Table:** rows 36 px (comfortable 44 px), cell padding 6×10.
- **Chrome:** app bar 48 px; page gutter 16 px at 1366, 24 px at 1440 and up; content is full width (drop `max-w-7xl`).
- **Radius:** 4 (buttons, inputs, chips), 6 (panels), full (dots only).
- **Elevation:**
  - 0: panels, border only
  - 1: sticky thead, `0 1px 0 var(--border)`
  - 2: popover, menu, toast, `0 4px 12px rgb(17 24 39/.12)`
  - 3: drawer/modal, `0 12px 32px rgb(17 24 39/.20)` with a 50% scrim
- **Icons:** Lucide, 16 px, stroke 2.
- **Motion:** 120–150 ms colour/opacity only.

**Components to build once:** AppBar · Breadcrumb · Tabs with counts · DataTable (sort, sticky head, row-link, j/k, multi-select, density, skeleton, empty) · QuickFilterBar (URL-synced) · Chip/TierChip/SourceWordBadge · CountdownChip · `<Time>` · Field (label/input/helper/error) · InlineEditCell · EvidencePopover · RuleTable + Explain toggle · Drawer/SideSheet · StickyActionBar · CommandPalette · ShortcutSheet · Toast (aria-live) · SessionBanner · Loading/EmptyState/ErrorBanner · DemoGuideNote · CodeLabel (Plain/Both/Codes).

### Skill generator output (`ds_kiosk.md`, `ds_console.md`): kept and rejected

| Suggestion | Verdict | Why |
|---|---|---|
| Console style "Exaggerated Minimalism" (`clamp(3rem,10vw,12rem)`, weight 900, −0.05em tracking, "massive whitespace") | **Reject** | Display type for fashion and portfolio sites, the opposite of a dense operations console. It also hurts older kiosk readers. |
| "Pricing-Focused Landing" (kiosk) and "Real-Time / Operations Landing" (console) patterns | **Reject** | Marketing-page layouts, not app shells. |
| GSAP scroll-reveal and page-transition snippets | **Reject** | No route animation in a work tool, and the kiosk has nothing to reveal. |
| Cyan palette: #ECFEFF canvas, #A5F3FC borders, #0891B2 text | **Reject** | Borders are about 1.1–1.3:1 against the canvas and #0891B2 is about 3.7:1 for body text. A tinted canvas also weakens the status colours. |
| Google-hosted Figtree/Noto and Lexend headings | **Reject** | The brief bans third-party loads and the kiosk must work offline. One family per surface is enough. |
| Density 9 / motion 1 / variance 2 dials (console) | **Keep** | The right settings for an operations desk. |
| "Data-Dense Dashboard" style entry (8–12 px padding, 12–14 px text, sticky headers, sortable tables) | **Keep** | It is the basis of the console spec above. |
| Status-only colour (green/amber/red, always with words); "avoid ornate", "no filtering" anti-patterns | **Keep** | Matches `color-not-only` and the hue discipline in G-07. |
| Calm teal health palette for the kiosk; avoid list (no neon, heavy motion or AI-purple gradients); light only | **Keep** | It is already the `brand` scale, so nothing has to change. |
| Atkinson Hyperlegible (from the typography search) | **Keep, kiosk only** | Designed for low-vision readers. Self-host it. |
| Pre-delivery checklist (focus states, reduced motion, 768/1024 tests) | **Keep** | |

---

## Power features for coordinators (ranked by value ÷ effort)

| Rank | Feature | Value | Effort | Notes |
|---|---|---|---|---|
| 1 | Row-as-link + `j/k/Enter` + `]` next item | High | S | Opening an item goes from a sideways scroll plus a click to one key (Q-01, D-02) |
| 2 | One-click Confirm with auto-focus on the next draft; "Confirm remaining (N)" with a review list | High | M | 12 clicks become 1–6 keypresses; still one audit event per record (D-02) |
| 3 | Nav count badges + global T2/T3 toast + `(n)` in the tab title | High | M | Nobody misses a page while on another screen (G-13) |
| 4 | Sortable, sticky tables with sort/filter state in the URL | High | M | Server order stays the default (Q-04, Q-05) |
| 5 | Command palette / jump to participant (Ctrl+K, `/`) | High | M | Coordinators work by subject ID all day (G-14) |
| 6 | Quick-filter saved views with counts (replaces the "Since you were last here" card) | Med-High | M | Q-03 |
| 7 | Field-name mode Plain/Both/Codes + "Show technical ids" | Med | S | Serves judges and experts with the same screen (G-18) |
| 8 | Density toggle Compact 36 / Comfortable 44 | Med | S | Q-07 |
| 9 | Inline edit with Enter/Esc/Tab and Ctrl+S on the packet | Med | M | D-04, P-01 |
| 10 | Shortcut sheet `?` with `g`-prefix navigation | Med | M | G-15 |
| 11 | Role landing + investigator "Awaiting investigator" inbox | High | M | The investigator is the bottleneck on the 24 h clock (L-02) |
| 12 | Export the current view (CSV/JSON, audited) + print stylesheet | Med | M | G-23 |
| 13 | Session-expiry banner + re-login without losing work | Med | M | G-16 |
| 14 | Bulk confirm from the queue (T0/T1 only, guarded) | Med | L | Q-06 |
| 15 | Unified Worklist tabs + Participant roster/hub | High | L | Phase 2; old routes redirect (IA-08, T-03) |
| 16 | Split-view preview pane on the queue | Low-Med | M | Optional |

---

## What not to do (eye candy to avoid)

- No hero sections, KPI tile rows, gradient banners or "statement" type on the console. One stat line beats four cards.
- No soft cards inside cards and no drop shadows on panels. The console is flat: borders, not elevation.
- No route or page transitions, scroll-reveals, GSAP, parallax or animated counters. 150 ms colour changes only.
- No animated heartbeat waveform or live pulse numbers in front of the patient by default.
- No colour without a word, and no hue with two meanings. Never a green chip for a serious event.
- No pill chips for non-status data (dates, IDs, counts). Plain text in tabular figures.
- No explanatory paragraphs on staff pages. Use the Demo guide toggle.
- No tooltip-only meaning: the meaning must be visible, because a touch screen cannot hover.
- No sub-12 px text on the console and no sub-16 px text on the kiosk.
- No icon-only buttons without labels, and no Unicode glyphs as icons.
- No auto-advance, carousels or swipe gestures on the kiosk.
- No dark mode or theme switcher before the token migration is done.
- No web-hosted fonts, CDN icon fonts, analytics or third-party scripts.
- Do not re-sort or re-rank anything client-side in a way that hides the server's tier order.

---

## Top 15 changes (ordered by impact ÷ effort)

| # | Change | IDs | Surface | Pri | Effort | Shot |
|---|---|---|---|---|---|---|
| 1 | Queue row = link; ≤8 columns; 36 px single-line rows; one SIMULATED badge per vitals cell; sticky thead | Q-01, Q-02, Q-05 | Console | P0 | S–M | c01, c02 |
| 2 | Accessibility floor: 2 px #0F766E focus outline; no slate-400 text (#5F6B7A minimum); 12 px minimum | G-02, G-03, G-04 | Both | P0 | S | all |
| 3 | Kiosk answer buttons: visible 2 px border, solid selected fill + check, single-column scale | K-01, K-24 | Kiosk | P0 | S | k02 |
| 4 | Single 48 px app bar (study chip, badges, user menu; System group) | G-01, G-06, G-26 | Console | P0 | M | c01, c03 |
| 5 | Kiosk idle timeout + reset + abandoned state | K-14 | Kiosk | P0 | M | k02 |
| 6 | Kiosk sticky action bar (Back/Next always on screen, disclaimer inside) | K-03 | Kiosk | P1 | M | k02 |
| 7 | Strip clinical and developer wording from the kiosk: study title, vitals card → status line (presenter mode), HTTP errors, dev notes | K-21, K-22, K-04, K-06 | Kiosk | P1 | S | k01–k03 |
| 8 | One question per screen + one counter + corrected type scale | K-02, K-25, K-26 | Kiosk | P1 | M | k02 |
| 9 | One-click Confirm → next draft → next item; "Confirm remaining (N)" | D-02 | Console | P1 | M | c03, c04 |
| 10 | Nav count badges, global urgent toast, active nav state | G-13, G-05 | Console | P1 | M | c01, c03 |
| 11 | Hue discipline + tier chips with shape/icon (fixes the green "Serious event" chip) | G-07, G-08 | Console | P1 | M | c01, c10 |
| 12 | One `<Time>` formatter + tabular figures by default | G-27, G-28 | Console | P1 | S | c03, c05, c11 |
| 13 | Keyboard layer + command palette | G-14, G-15 | Console | P1 | M | — |
| 14 | Check-in detail master-detail: drafts table, VS table, rule-table Why with Explain toggle | D-01, D-03, D-05 | Console | P1 | L | c03, c04 |
| 15 | Report packet: sections with counters, required markers, inline edit, sticky Sign/Save bar with countdown | P-01, P-02, P-03 | Console | P1 | L | c05, c06, c15 |

---

## Open questions for the team (decide before the redesign plan)

1. **Kiosk vitals.** Use a quiet "Camera on · SIMULATED" line by default with the numbers card only in presenter mode (`?presenter=1`)? Or keep live numbers on the kiosk? This affects DEMO.md step 2 and §3.3 vs §00.
2. **Time-saved figure.** §00.5 asks for a header strip. Is a one-line app-bar chip plus a queue breakdown acceptable? And should the API stop crediting a brief on view (only on print or "used at visit")?
3. **Worklist.** Merge Queue, Escalations, Queries and Notes into one tabbed Worklist this round, or ship nav badges now and merge later?
4. **Default field labels.** Plain (for judges, §00), Both, or Codes (for coordinators)? This report proposes plain label first with the code inline.
5. **API and rules contract changes.** Which are in scope while other agents are mid-flight?
   - abandoned-session state (K-14)
   - "declined" answers (K-17)
   - °F storage (K-07)
   - PRO-CTCAE branching scoring (K-02)
   - server sort param (Q-04)
   - bulk-confirm endpoint (Q-06)
   - brief time credit (G-12)
   - query assignee/due fields (QR-02)
6. **Dependencies.** May we add `@fontsource/atkinson-hyperlegible`, `@fontsource/ibm-plex-sans`/`-mono` (about 200 KB, offline-safe) and `lucide-react` (ISC)? Or should we copy SVGs and use the system font?
7. **Who owns `Layout.tsx` and `Button.tsx` right now?** Another agent is reshaping the header. The redesign must land after that work, or on a branch that rebases onto it.
8. **Kiosk target hardware.** Laptop at 1280×800, a tablet, or both? This decides the sticky-bar behaviour and on-screen-keyboard handling for the medication step.
9. **Camera opt-out preselected to "Yes"** (D-026), or no default? It is an ethics framing call for the slides.
10. **Spanish.** Build the copy file now and list Spanish items in NOT_BUILT.md, or skip i18n entirely?
11. **Date format.** Is 24 h `10-Oct-2026 13:15` acceptable for a mostly non-clinician judging panel, or should the console use a 12 h clock?
12. **Dark mode.** Confirm it is deferred until after the token migration.
13. **Participant hub and Reports list** (T-03, A-01). New routes are a larger change: is this round's redesign about restyling the existing screens, or also changing the information architecture?
