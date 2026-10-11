# UI audit: patient kiosk

**Scope:** the patient kiosk at `/kiosk`. Code reviewed: `apps/web/src/pages/kiosk/**`, `components/VitalsPanel.tsx`, `components/ProgressBar.tsx`, `components/Button.tsx`, `components/Disclaimer.tsx`, `components/ErrorBanner.tsx`, `tailwind.config.js` and `styles/index.css`.
**Evidence:** screenshots `k01-welcome-{laptop,tablet}.png`, `k02-question1-{laptop,tablet}.png` and `k03-wrong-id-laptop.png` in `.playwright-mcp/ui-audit/`. I captured `k03` against the live app at 1280x800 by typing P-999. I did not start or complete any real session, so no demo data was created.
**Method:** I followed the ui-ux-pro-max skill, working through Quick Reference priorities 1 to 10, and ran its CLI searches (`--domain ux` and `--domain typography`). Contrast ratios are computed from the Tailwind hex values with the WCAG 2.x formula. Reading grades are Flesch-Kincaid estimates.
**Audience:** oncology trial participants, often aged 60 or older. Some will be fatigued or nauseous, or will have reduced vision or a tremor. They use a shared laptop or tablet in a clinic.
**Status:** report only. Nothing in `apps/` was changed.

---

## Headline

The kiosk is already calm, light and readable at a distance. The footer is correct, and Yes/No and Next are large. The main problems are as follows:

1. **The kiosk has no inactivity timeout** (P0, privacy). Nothing in `KioskFlow.tsx` resets an abandoned check-in. The next person to sit down sees the previous participant's study ID and answers, and can page through them with Back.
2. **Two questions share one screen** on 7 of the 10 items. The options sit in a 2-column grid that reads in a zig-zag ("None | Mild / Moderate | Severe / Very severe"). On a 1280x800 laptop and a 1024x768 tablet, the Next button is below the fold (y ≈ 850–916 px).
3. **Answer buttons fail WCAG 1.4.11 non-text contrast.** The option border is slate-300, which measures 1.48:1 on white. The white button fill against the slate-50 page measures 1.04:1. The selected fill (brand-50) is 1.04:1 against white, so the selected state is carried only by a thin border and ring, with no check mark.
4. **Clinical and developer language reaches the patient.** Examples:
   - The full protocol title, "…Metastatic Non-Small Cell Lung Cancer (NSCLC)" (grade 13.6), appears in the header of every screen.
   - The vitals card shows "HRV (RMSSD)", "mock" and a heartbeat waveform.
   - A wrong study ID shows "HTTP 404 Participant not found: No participant with usubjid P-999".
   - The "anything else" screen shows the data-table note "Stored verbatim and never parsed by software."
5. **The live vitals card should not face the patient by default.** Live pulse numbers and a beating waveform look like an ICU monitor. A patient who sees "128 beats/min" may become anxious, and that anxiety can raise the very pulse being captured. Replace the card with a quiet "Camera on" status line that still carries the SIMULATED or MEASURED word. Keep the numbers card behind a presenter mode for the judge demo.

**Direction:** one decision per screen. Use a single-column ordinal answer list with 64 px targets and a radio-and-check indicator. Put Back and Next in a sticky action bar that also carries the disclaimer. Add a review screen before Finish, an idle timeout, and a "Need help?" button. Use a self-hosted Atkinson Hyperlegible font at a 20–22 px base, and hold body text to 7:1 contrast.

---

## Findings

Priority: **P0** blocks the demo or is an accessibility or privacy failure. **P1** has a clear cost to the patient. **P2** is polish.
Kind: CHANGE / ADD / REMOVE / FORMAT. Effort: S (under 1 h), M (half a day), L (more than half a day, or needs an API or rules change).

### P0

**K-01 · ADD · No inactivity timeout or abandoned-session reset** (`KioskFlow.tsx`; `ThankYou` resets after 45 s and `Stop` after 90 s, but the items and gates steps never time out)
- *Problem:* A participant who walks away mid check-in leaves their study ID, every selected answer, any typed medicine name and any free text on screen. The next person can press Back and read all of it. Answers are already sent to the server on each tap, so a half-finished session also stays open with no end state.
- *Rules:* privacy on a shared device; `escape-routes`; `timeout-feedback`.
- *Recommendation:*
  - After 90 s with no input on any step past Welcome, show a full-screen card: "Are you still there?". Give it a 64 px primary button, "Yes, keep going", and a visible 30-second countdown that ticks in tabular numerals.
  - On timeout, call `reset()`, which already stops the bridge.
  - Post an `abandoned` event or completion reason so the coordinator can see the partial check-in. This needs an API field; coordinate with the API agent.
  - Also clear state on `visibilitychange` to hidden for more than 5 minutes.
- *Effort:* M

**K-02 · CHANGE · Answer-button borders and selected state fail non-text contrast** (`Button.tsx` `VARIANTS.option` and `OPTION_SELECTED`; `k02-*`)
- *Problem:*
  - The option border `border-slate-300` is #CBD5E1, 1.48:1 on white and 1.42:1 on the page. The white fill is 1.04:1 against slate-50. A low-vision user cannot see where one button ends and the next begins.
  - The selected fill `bg-brand-50` is 1.04:1 against white. Selection rests on a thin brand-700 border plus a 40 % ring, with no shape cue.
- *Rules:* `color-contrast` (WCAG 1.4.11 needs 3:1 for component boundaries and states); `color-not-only`; `state-clarity`.
- *Recommendation:*
  - Unselected: white fill, 2 px border slate-500 (#64748B, 4.76:1), a 28 px empty radio circle on the left, left-aligned 22 px label.
  - Selected: fill brand-100 (#CCFBF1), 3 px border brand-700 (#0F766E, 4.86:1 against the fill), and a filled radio circle with a white check (SVG, not a glyph). Text stays brand-900 (8.41:1).
  - Hover keeps the layout bounds unchanged.
- *Effort:* S

### P1

**K-03 · CHANGE · Two questions per screen** (`ItemScreen.tsx` maps every `item.attributes` onto one screen; `k02-question1-*`)
- *Problem:* 7 of the 10 items ask two questions at once, for example severity plus interference. That is 17 decisions across 10 screens, and the second question plus Next fall below the fold at 800 px and 768 px heights. Fatigued or low-vision users scroll, lose context and may not notice the second question. Next stays disabled with no explanation.
- *Rules:* `progressive-disclosure`; "one decision per screen" from the brief §3.8; `content-priority`.
- *Recommendation:*
  - Render one attribute per screen. The symptom becomes the eyebrow ("Shortness of breath") and the prompt becomes the H1.
  - Optionally apply PRO-CTCAE conditional branching: if the first attribute is "None" or "Never", skip the follow-up and record 0. This cuts a symptom-free check-in to 13 taps. Branching changes what the API receives, so confirm with the rules owner that a missing interference value equals 0 in `composite_scoring`; keep it behind a flag until then.
  - Total screens: 19 without branching, 13 to 19 with it.
- *Effort:* M without branching; L with it.

**K-04 · FORMAT · Ordinal scale shown as a zig-zag 2-column grid** (`ItemScreen.tsx` `grid gap-3 sm:grid-cols-2`; `k02-*`)
- *Problem:* "None | Mild / Moderate | Severe / Very severe" reads left-right then down, so the severity order is not visually linear, and "Very severe" sits alone like an afterthought. Older users misread grids as two independent lists. Labels are also centred, although the code asks for `justify-start`: the `justify-center` in BASE wins.
- *Rules:* `visual-hierarchy`; `touch-density`; `no-precision-required`.
- *Recommendation:* One vertical column in scale order, least to most. Each option is at least 64 px high (`min-h-16`) with a 12 px gap, so 5 options need 368 px and fit above the fold once K-03 lands. Left-align the labels, give them a leading radio, and remove `justify-center` for `variant="option"`.
- *Effort:* S

**K-05 · CHANGE · Next is below the fold, and Back and Next are not anchored** (`ItemScreen.tsx` and `GateScreen.tsx` footer rows; `k02-*` with Next at y ≈ 850–916 on an 800 px viewport)
- *Problem:* The primary action has to be scrolled to. The disabled Next is brand-700 at 50 % opacity, giving white text at 2.21:1 and a fill at 2.11:1 against the page, so it reads as broken rather than "answer first". The disabled Back is ghost text at 2.59:1.
- *Rules:* `fixed-element-offset`; `disabled-states`; `primary-action`; `touch-target-size`.
- *Recommendation:*
  - Add a sticky bottom action bar: white, 1 px top border slate-300, 16 px padding plus `env(safe-area-inset-bottom)`.
  - Back: secondary style, 2 px border slate-500, left-arrow icon and label, at least 64 px high and 140 px wide. Hide it on question 1 instead of showing it disabled.
  - Next: brand-800 (#115E59; white text 7.58:1, meeting the 7:1 target), at least 72 px high and 200 px wide, right-arrow icon.
  - Keep Next enabled. If tapped with no answer, show an inline "Please choose an answer" (red-800 on red-50, 7.6:1) under the question and move focus to the first option.
  - Put the disclaimer line inside the same bar so it is visible on every screen without scrolling.
  - Reserve bottom padding in `main` so content never hides under the bar.
- *Effort:* M

**K-06 · REMOVE · Live vitals card faces the patient** (`VitalsPanel.tsx` in the `KioskShell` side column; `k02-*`)
- *Problem:* The kiosk shows live pulse and breathing numbers, "HRV (RMSSD)", the source name "mock" in monospace, a coloured quality dot, "Signal is weak" and an animated pleth waveform.
  - It is clinical jargon, which the brief bans on the kiosk.
  - The waveform looks like an ICU monitor, and live numbers invite worry ("is 128 bad?").
  - Watching your own pulse changes it, which contaminates the eSource the product exists to capture.
  - The waveform redraws every sample even with reduced motion, because it is a data update rather than a CSS animation.
  - Status dots use brand-400 at 1.86:1 and green-500 at 2.28:1 on white.
- *Rules:* `motion-meaning`; `excessive-motion`; `reduced-motion`; `color-not-only`.
- *Recommendation:*
  - Default patient view: one quiet status line under the question (or in the header): a camera icon, "Camera on", then "Reading pulse and breathing", then the word SIMULATED (or MEASURED) as text in the existing `MeasuredBadge` at size md. Add a text button, "Turn camera off", with at least 48 px height.
  - Never show numbers, HRV, the waveform, confidence or the source id to the patient.
  - Keep the current full card for presenter mode, so demo step 2 still works: `?presenter=1` or an admin setting "Show vitals card on kiosk (demo)", default off.
  - The MEASURED/SIMULATED word stays wherever a vital is shown.
- *Effort:* S for the status line; M with the admin setting.

**K-07 · REMOVE · Full protocol title shown to the patient on every screen** (`KioskShell` subtitle and the `Welcome` "Study:" line; `k01-*` and `k02-*`)
- *Problem:* "Study of REGN 2810 Compared to Platinum-Based Chemotherapies in Participants With Metastatic Non-Small Cell Lung Cancer (NSCLC)" reads at grade 13.6, appears twice on Welcome, and puts "Metastatic … Cancer" at the top of every question. It is clinical language and emotionally loaded. It also uses about 35 px of a 768 px tablet height.
- *Rules:* brief §3.8 (no clinical jargon on the kiosk); `content-priority`.
- *Recommendation:* Remove the subtitle from `KioskShell`. On Welcome, show a site-configurable friendly name such as "Your lung study check-in", or nothing. Keep the registry title on the dashboard, where judges look for it.
- *Effort:* S

**K-08 · CHANGE · Wrong-study-ID error shows HTTP status and "usubjid"** (`Welcome.tsx` uses `ErrorBanner`, which always renders `describeError`; `k03-wrong-id-laptop.png`)
- *Problem:* The banner reads "HTTP 404 Participant not found: No participant with usubjid P-999". It is technical, and it sits above the field instead of under it. Focus does not move. After the error the Start button drops below the fold at 800 px (y ≈ 820–887).
- *Rules:* `error-clarity`; `error-placement`; `focus-management`; `aria-live-errors`.
- *Recommendation:* Add a `quiet` or `participant` prop to `ErrorBanner` that suppresses the HTTP line and detail. On the kiosk, render the message under the input in red-800 (#991B1B) at 18 px with an alert icon: "We couldn't find P-999. Check the ID on your study card, or ask the front desk." Set `aria-invalid`, focus and select the input text, and add a 2 px red-700 border.
- *Effort:* S

**K-09 · CHANGE · Camera choice is a negatively worded opt-out checkbox** (`Welcome.tsx` `CAMERA_OPT_OUT_LABEL`; `k01-*`)
- *Problem:* "I'd rather not use the camera" plus "You can tick the box above to turn it off" is a double negative for an older reader. A ticked box means "off", which is inverted. The patient also has no way to turn the camera off once questions start, and there is no on-screen sign that the camera is on during questions.
- *Rules:* `input-labels`; `state-clarity`; consent clarity (D-026 keeps camera on by default under the enrollment ICF).
- *Recommendation:*
  - Replace the checkbox with a 2-option segmented control under the label "Use the camera to read my pulse and breathing": "Yes" (preselected, per D-026) and "No, keep it off". Each option is at least 64 px high and carries a check when selected.
  - Keep `NO_VIDEO_TEXT` verbatim directly beneath.
  - Add a "Why?" line: "It helps the study team. The check-in is the same either way."
  - During the check-in, show "Camera on · Turn off" in the status line (K-06).
- *Effort:* S

**K-10 · ADD · No review step before Finish** (the flow runs gates, then `submitting`)
- *Problem:* A participant with a tremor can mis-tap "Severe" for "Mild" and never see it again. Severity drives tier and paging, so a mis-tap can trigger a nurse call, or miss one.
- *Rules:* `undo-support`; `multi-step-progress`; `error-recovery`.
- *Recommendation:* Insert a "Check your answers" screen before Finish. List only the symptoms answered above None or Never, plus the three gate answers, in a 20 px two-column list ("Shortness of breath · Moderate · Somewhat"). Give each row a 56 px "Change" button that jumps to that screen and returns to Review. If no symptoms were reported, show "You told us you had no symptoms". Primary button: "Send to study team". It adds one screen (about 10 s).
- *Effort:* M

**K-11 · ADD · No way to leave mid check-in, and no "Need help?"** (`KioskShell` header)
- *Problem:* The only exits are finishing or reloading. A participant who feels unwell, or is called in for their visit, has no exit. There is also no way to ask for help without abandoning the screen.
- *Rules:* `escape-routes`; `modal-escape`.
- *Recommendation:* Header right: a 48 px secondary "Need help?" button that opens a full-screen card with fixed copy: "Please ask a member of the study team at the front desk." The card offers "Back to my check-in" and "Stop and leave". "Stop and leave" requires a second tap on an in-page confirmation (no `confirm()`), then calls `reset()` and records the session as abandoned. The card contains no medical advice.
- *Effort:* M

**K-12 · CHANGE · Free-text screen shows developer copy, and gives no safety pointer for urgent text** (`GateScreen` "other"; `gatePrompts().otherNote` = `gate_questions.json` `note`)
- *Problem:* The patient sees "Stored verbatim and never parsed by software. It is read by a person." That is jargon. It also hides a safety gap: someone typing "chest pain right now" is told nothing about timing, because free text is not parsed and only raises a flag together with a severe item.
- *Rules:* brief §3.8 plain language; `input-helper-text`.
- *Recommendation:*
  - Do not render `note` on the kiosk; use `FALLBACK_GATE_PROMPTS.other_hint`, rewritten.
  - Copy: "A member of the study team will read this. It may not be read today. If you need help now, tell the front desk or call 911." The 911 sentence matches the pre-approved stop text.
  - Show the label visibly (it is `sr-only` today) and keep the H1.
- *Effort:* S

**K-13 · CHANGE · Temperature only in °C** (`ItemScreen.tsx` optional temperature field; `proctcae_items.json` `optional_fields.temp_c`)
- *Problem:* US participants read thermometers in °F. Typing 101.2 fails the 34–43 bounds with "Please enter a temperature between 34 and 43 °C", which is confusing for a fevered patient.
- *Rules:* `error-clarity`; `input-type-keyboard`.
- *Recommendation:* Add a °F / °C segmented toggle next to the input, defaulting by locale or a site setting. Convert to °C on the client and send `temp_c`. Record the entered unit and raw value if the API accepts it; ask the API agent. Use a 64 px input with `inputMode="decimal"`.
- *Effort:* M

**K-14 · FORMAT · Two progress counters disagree, and the header reads "0 of 13" on question 1** (`KioskShell` `ProgressBar` and the `ItemScreen` eyebrow; `k02-*`)
- *Problem:* The header bar text says "0 of 13" while the eyebrow says "Question 1 of 10" (now "of 13" in code). Two counters with different bases sit 60 px apart. The bar track is slate-200, about 1.2:1 against white, with no segments.
- *Rules:* `multi-step-progress`; `number-tabular`.
- *Recommendation:* Keep one counter, next to the question: "Question 3 of 13" at 18 px, weight 600, slate-700. Hide the header bar text, or show "About 2 minutes left". Draw the bar 8 px tall with a slate-300 track and a brand-700 fill, labelled with `aria-valuetext="Question 3 of 13"`. If K-03 branching makes the total vary, show "Almost done" on the last 3 screens instead of a changing total.
- *Effort:* S

**K-15 · FORMAT · Type scale inverts the hierarchy: the symptom name is the H1 and the real question is 20 px** (`ItemScreen.tsx` H1 `text-3xl/4xl`, legend `text-xl`, options `text-lg` at 18 px)
- *Problem:* The thing the patient must answer is the smallest prominent text, and answer labels are 18 px. For readers aged 60 and over, questions should be 24 px or more and options 20 px or more.
- *Rules:* `readable-font-size`; `font-scale`; `weight-hierarchy`; `line-length-control`.
- *Recommendation:*
  - Eyebrow (symptom name): 18 px, weight 600, brand-800.
  - H1 (the question): 30–32 px, weight 700, line-height 1.3, max width 34 rem (about 55 characters per line).
  - Options: 22 px, weight 600. Helper text: 18 px slate-700.
  - Set the kiosk base to 20 px.
  - Drop the `uppercase tracking-wide` eyebrow, because all-caps hurts low-vision reading.
- *Effort:* S

**K-16 · CHANGE · Secondary text uses slate-500 or slate-600 on slate-50, short of the 7:1 target** (eyebrow `text-slate-500` = 4.55:1; vitals labels `text-slate-500 text-xs` = 4.76:1; hints `text-slate-600` = 7.24:1; placeholder slate-400 = 2.56:1)
- *Rules:* `color-accessible-pairs` (7:1 AAA target for this audience).
- *Recommendation:* On the kiosk, use slate-900 for primary text (17.85:1) and slate-700 for secondary (9.9:1 on slate-50 and 10.35:1 on white). Ban slate-400 and slate-500 for any kiosk text. Placeholders must not carry information: the study-ID example already appears in the hint, so drop the placeholder or use slate-600.
- *Effort:* S

**K-17 · CHANGE · Options are announced as toggle buttons and labelled twice; focus is lost on every screen change** (`ItemScreen` fieldset `aria-labelledby` plus an inner `role="group"` with the same label; `Button` `aria-pressed`; `key={currentItem.id}` remounts the screen)
- *Problem:* A screen reader announces "Mild, toggle button, not pressed" rather than "radio 2 of 5". The legend is read twice. After Next, focus falls to `<body>`, so a screen-reader or keyboard user does not hear the new question and must tab from the top. Arrow keys do not move between options.
- *Rules:* `voiceover-sr`; `keyboard-nav`; `focus-on-route-change`; `form-labels`.
- *Recommendation:* Use `role="radiogroup"` with `role="radio"` and `aria-checked`, or native `<input type=radio>` styled as cards, with roving tabindex and arrow keys. Remove the inner duplicate `role=group`. On every step change, focus the H1 (`tabIndex=-1`) and announce "Question 3 of 13" through a polite live region. Map Enter to Next when an answer is chosen.
- *Effort:* M

**K-18 · ADD · No "prefer not to answer" or "not sure"** (all items are required: `itemAnswered` requires every attribute)
- *Problem:* Patients who cannot judge a scale, such as interference when they did no activities, are forced to guess. A forced guess is worse data than an explicit missing value.
- *Rules:* `error-recovery`; trial data integrity (ALCOA "accurate").
- *Recommendation:* Add a low-emphasis text button under each option list: "I'd rather not answer" (48 px, slate-700, underlined). It records an explicit declined value, and the coordinator sees "declined" with evidence. This needs an API and rules contract change, so log it in ISSUES.md and do not ship it before the backend accepts it.
- *Effort:* L

**K-19 · CHANGE · Medication gate: one free-text box, typing is hard, and "Both" is ambiguous** (`GateScreen.tsx` conmed branch)
- *Problem:*
  - Only one medicine can be entered.
  - The 24 px text box needs the on-screen keyboard on a tablet, which hides the direction buttons.
  - "Both" next to a single name is unclear.
  - Patients with a tremor or who don't know the name have no path.
- *Rules:* `touch-friendly-input`; `progressive-disclosure`; `error-recovery`.
- *Recommendation:*
  - Ask the direction first, as large options: "I started a new medicine", "I stopped a medicine", "Both".
  - Then show the name field, with an "Add another medicine" link (up to 3, each sent verbatim).
  - Add an "I don't know the name. The study team can ask me." option that records the change with empty text, flagged for the coordinator.
  - Keep "Spelling does not need to be perfect".
- *Effort:* M; multiple medicines may need an API change.

### P2

**K-20 · CHANGE · Thank-you uses a text glyph "✓" and resets silently after 45 s** (`ThankYou.tsx`)
- *Rules:* `no-emoji-icons`; `timeout-feedback`.
- *Recommendation:*
  - Use an SVG check icon (lucide `CircleCheck`, 64 px, brand-700) instead of the glyph.
  - Add a visible "This screen will close in 45 s" line with a tabular countdown, so the patient knows their answers will not stay on screen.
  - Make Done the primary action: 72 px, "Done, I'm finished".
  - Cut the copy to 3 lines at grade 4 or below.
- *Effort:* S

**K-21 · FORMAT · Tier-3 stop screen is one 36 px semibold wall of text, and differs visibly from thank-you** (`Stop.tsx`)
- *Problem:* A distressed patient has to read 36 px semibold paragraphs, and the safety sentence does not stand out. A bystander can tell from across the room that this patient was escalated: a different layout, no icon, a secondary Done button.
- *Rules:* `visual-hierarchy`; privacy on a shared device.
- *Recommendation:*
  - Render the API's verbatim `stop_screen_text` split at sentence boundaries, without altering any word:
    - "Thank you." as the H1, 36 px.
    - "A member of the study team will contact you today." as body text, 24 px.
    - The 911 sentence in a neutral bordered box (slate-50 fill, 2 px slate-500 border, 22 px weight 600, phone icon). Do not use red.
  - Use the same shell, icon and Done style as thank-you so the two screens look alike from a distance.
  - Show the 90 s auto-close countdown.
- *Effort:* S

**K-22 · ADD · No language choice** (`index.html lang="en"`; copy lives in JSON tables and components)
- *Recommendation:* Move the kiosk strings into one `kioskCopy.ts` keyed by locale now, even if only `en` ships. Add an "English | Español" segmented control on Welcome, 48 px high, set by `lang` on `<html>`. Spanish item text must come from licensed, translated PRO-CTCAE, so list it in NOT_BUILT.md and do not machine-translate.
- *Effort:* M for the scaffold; L for translation.

**K-23 · ADD · No text-size control; 200 % zoom is untested**
- *Recommendation:* Add a 48 px "Larger text" toggle on Welcome that sets the root font-size from 20 px to 24 px. Every kiosk size is in rem, so the layout scales. With K-05's sticky bar, verify at 640x400 effective (1280x800 at 200 %) that the bar does not cover the question: make the bar non-sticky below a height of 500 px.
- *Effort:* S

**K-24 · CHANGE · Spinners under reduced motion; per-tap spinner flicker on Next** (`index.css` sets `animation-duration: 0.01ms` but iterations stay infinite; `ItemScreen` `nextBusy` shows a spinner after every tap)
- *Rules:* `reduced-motion`; `loading-states` (only after 300 ms).
- *Recommendation:* Under `prefers-reduced-motion`, set `animation-iteration-count: 1` too and show a static "Saving…" label instead of a spinner. Show the Next spinner only if the POST is still pending after 300 ms.
- *Effort:* S

**K-25 · REMOVE · Empty teal square as the logo; "Welcome" says nothing** (`KioskShell` header and `Welcome` H1; `k01-*`)
- *Recommendation:* Replace the square with a simple SVG mark, or drop it and keep the wordmark "Interim". Make the Welcome H1 "Let's check in on how you've been feeling", then "13 short questions · about 3 minutes". The current Welcome copy reads at about grade 2.5; keep it at or below grade 5.
- *Effort:* S

**K-26 · FORMAT · Browser Back leaves the kiosk and loses the session** (single route, state machine only)
- *Recommendation:* Push a history entry per step (`?step=items&i=3`) so browser Back maps to the in-app Back, or intercept `popstate`. Document that kiosk mode runs fullscreen (`chrome --kiosk`) in DEMO.md.
- *Effort:* M

---

## Measured facts

| Check | Value | Target | Result |
|---|---|---|---|
| Option button border slate-300 on white | 1.48:1 | 3:1 (WCAG 1.4.11) | fail |
| Selected fill brand-50 vs white | 1.04:1 | 3:1, or a shape cue | fail (border only) |
| Eyebrow "QUESTION 1 OF 10" slate-500 on slate-50 | 4.55:1 | 7:1 | below target |
| Hints and footer slate-600 on white | 7.58:1 | 7:1 | pass |
| Disabled Next: white on brand-700 at 50 % | 2.21:1 | (exempt) | reads as broken |
| Primary Start/Next: white on brand-700 | 5.47:1 | 7:1 | below target; brand-800 gives 7.58:1 |
| Placeholder slate-400 on white | 2.56:1 | 4.5:1 if informative | duplicate of hint, so drop it |
| Vitals status dot brand-400 / green-500 on white | 1.86 / 2.28:1 | 3:1 | fail (the word sits next to it) |
| Option target height | 56 px (`min-h-tap`) | 56–64 px for this audience | borderline; use 64 |
| Next / Yes / No height | 68 px (`min-h-tap-lg`) | 64 px or more | pass |
| Next on 1280x800, two-question item | y ≈ 850–916 px | above the fold | fail |
| Start after a wrong ID, 1280x800 | y ≈ 820–887 px | above the fold | fail |
| Decisions per two-question screen | 2 (7 of 10 items) | 1 | fail |
| Item prompt reading grade (FK) | 0.9–7.2, mean 4.4 | 6 or below | mostly pass |
| Study title reading grade | 13.6 | 6 or below | fail, remove it |
| Inactivity timeout during questions | none | 90 s warning, then reset | missing |

---

## Skill-generated baseline (`ds_kiosk.md`): keep and reject

**Keep:**
- A calm health palette. Cyan #0891B2 and teal are interchangeable; stay on the existing teal `brand` scale, which is already wired.
- The "Avoid" list: no neon, no heavy motion, no AI-purple gradients.
- Light mode only.
- The pre-delivery checklist: focus states, `prefers-reduced-motion`, and testing at 768/1024.
- From the typography search, **Atkinson Hyperlegible** ("Accessibility First" pairing), designed for low-vision readers. Self-host it with `@fontsource/atkinson-hyperlegible` (OFL); no Google Fonts CDN, because the brief bans third-party scripts and the kiosk must work offline. Fall back to `system-ui`.

**Reject:**
- **Pattern "Pricing-Focused Landing"**: irrelevant (a generator mismatch).
- **Style "Exaggerated Minimalism"** with `clamp(3rem, 10vw, 12rem)`, weight 900 and −0.05em tracking. That is display typography for fashion sites. Tight tracking and 900 weight lower legibility for older readers; use weight 700, normal tracking and 30–32 px questions.
- **Scroll-reveal GSAP motion**: the kiosk has no scrolling content to reveal, and motion should be close to zero.
- **Figtree + Noto Sans from Google Fonts**: acceptable faces, but external hosting is not allowed, and Atkinson beats both for this audience.
- **Background #ECFEFF and border #A5F3FC**: the cyan border measures about 1.3:1 on white and repeats K-02's failure. Use slate-500 borders.

---

## Recommended kiosk look

**Layout:**
- **Header:** 64 px, white, 1 px slate-200 bottom border. Wordmark on the left; "Need help?" on the right, 48 px secondary button. No study title, no progress text.
- **Main:** a single centred column, `max-w-[40rem]`, 24 px side padding, 32 px top padding. From top to bottom:
  - Eyebrow: "Question 3 of 13 · Shortness of breath", 18 px, weight 600, slate-700.
  - Progress bar: 8 px, segmented.
  - H1: the question, 30–32 px, weight 700, slate-900, line-height 1.3.
  - Answer list: one column, 64 px rows, 12 px gaps, 28 px radio on the left, 22 px label.
  - The camera status line (K-06), 18 px, below the list.
- **Sticky action bar:** white, top border slate-300. Back on the left, secondary, 64 px. Next on the right, brand-800, 72 px high, at least 200 px wide. Beneath both, the disclaimer at 16 px slate-700. Add the safe-area inset.

**Tokens:**

| Token | Value | Contrast |
|---|---|---|
| `--k-bg` | #F8FAFC | |
| `--k-surface` | #FFFFFF | |
| `--k-text` | #0F172A | 17.85:1 on white |
| `--k-text-2` | #334155 | 10.35:1 on white |
| `--k-border` | #64748B | 4.76:1 |
| `--k-primary` | #115E59 | 7.58:1 with white |
| `--k-selected-bg` | #CCFBF1 | |
| `--k-selected-border` | #0F766E | |
| `--k-error` | #991B1B on #FEF2F2 | 7.6:1 |
| `--k-focus` | 4 px ring #0D9488 with a 2 px white offset | |

Radius: 16 px for cards and options, 12 px for inputs.

**Type:** Atkinson Hyperlegible, self-hosted, falling back to system-ui. Root 20 px, or 24 px with "Larger text". Scale 16 (footer) / 18 / 22 / 30 / 36. Weights 400 and 700 only.

**Motion:** 150 ms colour transitions only. No waveform. No auto-advance: explicit Next is safer with a tremor. Reduced motion disables the spinner and the progress transition.

**Flow:** Welcome (ID, camera Yes/No, optional language and text size), then 13–19 one-question screens, then Review, then Saving, then Thank-you or Stop (same visual family, countdown visible). An idle guard runs over every step after Welcome.

**Rules that survive the redesign:** the verbatim disclaimer stays visible on every screen (now in the sticky bar). Wherever a vital is shown, the word MEASURED or SIMULATED appears beside it, and the camera status line carries the word. The kiosk shows no grades, tiers or clinical words. The stop text is rendered verbatim.
