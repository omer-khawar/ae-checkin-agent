# Interim web palette and typography

> **Superseded by the UI revamp design system:** tokens now live in `tokens.css` (CSS variables, console + kiosk surfaces), fonts are self-hosted Inter (console) and Atkinson Hyperlegible (kiosk), and the rules plus contrast table are in `src/ui/README.md`. This file describes the legacy palette the existing pages still use until they migrate.

Light theme only (DECISIONS.md D-006): the kiosk runs on a laptop in a clinic corridor
and the dashboard is read on office monitors. One theme means one set of contrast
checks and nothing to toggle during a demo.

## Palette

| Role                     | Tailwind token                                              | Where                      |
| ------------------------ | ----------------------------------------------------------- | -------------------------- |
| Page background          | `slate-50`                                                  | `html`                     |
| Surfaces (cards, header) | `white` with `border-slate-200`                             | `Card`, `Layout`           |
| Body text                | `slate-900`                                                 | everywhere                 |
| Secondary text           | `slate-600` (never lighter than `slate-500` on white)       | hints, timestamps          |
| Primary action           | `brand-700` (= teal-700, `#0f766e`) text `white`            | `Button variant="primary"` |
| Primary hover            | `brand-800`                                                 |                            |
| Focus ring               | `brand-500` at 60%                                          | global `:focus-visible`    |
| Selected option (kiosk)  | `brand-50` background, `brand-700` border, `brand-900` text | item option buttons        |

`brand` is an alias of Tailwind's `teal` scale defined in `tailwind.config.js`; changing the
product colour is a one-place edit.

### Status colours (meaning is fixed in `src/lib/format.ts`)

| Meaning                               | Token                                                  | Text on it   |
| ------------------------------------- | ------------------------------------------------------ | ------------ |
| Tier 0 "Log"                          | `slate-200`                                            | `slate-800`  |
| Tier 1 "Review within 1 business day" | `amber-200`                                            | `amber-900`  |
| Tier 2 "Nurse call today"             | `orange-200`                                           | `orange-900` |
| Tier 3 "Urgent"                       | `red-600`                                              | `white`      |
| MEASURED badge                        | `green-100` / `green-800`                              |              |
| SIMULATED badge                       | `violet-100` / `violet-800`                            |              |
| Error banner                          | `red-50` / `red-800`, border `red-300`                 |              |
| Vitals quality dot                    | `green-500` ok, `amber-500` degraded, `slate-400` none |              |

Tier colours are only shown on the dashboard. The kiosk never renders a tier, a grade, or
any status colour tied to a clinical meaning; the participant sees teal and slate only.

All combinations above meet WCAG AA (4.5:1) for normal text; the kiosk uses 20–36px type so
large-text thresholds apply with margin.

## Typography

System font stack (`system-ui, -apple-system, Segoe UI, Roboto, ...`): no web fonts, so
the kiosk renders instantly on a cold-start laptop with no network.

| Context              | Size                                                   |
| -------------------- | ------------------------------------------------------ |
| Kiosk question stem  | `text-3xl` / `text-4xl` on wide screens                |
| Kiosk option buttons | `text-xl`, min height 3.5rem (`min-h-tap`), full width |
| Kiosk hints          | `text-lg` `slate-600`                                  |
| Dashboard body       | `text-sm` / `text-base`                                |
| Vitals values        | `text-2xl` with `tnum` (tabular numerals)              |

## Motion

One 200 ms transition on button backgrounds and the progress bar; the pleth sparkline
redraws per message without animation. `prefers-reduced-motion` disables all of it.
