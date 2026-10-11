# `src/ui`: Interim design system

Direction: **Apple liquid glass × healthcare, not techno.** Frosted glass for chrome,
crisp opaque surfaces for data, one teal accent, calm neutrals, and status colours that
always come with an icon and a word.

- Tokens: `src/styles/tokens.css` (CSS variables), mapped in `tailwind.config.js`.
- Utilities: `src/styles/index.css` (`.glass`, `.glass-strong`, `.tabular`, `.focus-ring`, `.transition-calm`).
- Class helper: `cn()` from `@/lib/cn` (clsx + tailwind-merge, taught our custom keys).
- shadcn CLI: `components.json` points new components at `@/ui` and `cn` at `@/lib/cn`.
- Requirements source: `docs/ui-audit/UI_AUDIT.md`, "Design system proposal".
- Starting palette: [Sea Glass](https://21st.dev/community/themes/sea-glass) by serafimcloud. We kept
  its structure and shadcn roles and replaced every value with the audit's contrast-safe ones.
  Credits for every borrowed component: `CREDITS.md` in this folder.

## Surfaces

Set `data-surface` on a route's root element. Both scopes use the **same variable names**, so a
component written once (`bg-surface text-foreground rounded-panel`) renders correctly on either.

| Scope                                         | Where                                  | Font                  | Root type             | Radius sm / md / lg | Focus ring                |
| --------------------------------------------- | -------------------------------------- | --------------------- | --------------------- | ------------------- | ------------------------- |
| `:root`, `[data-surface="console"]` (default) | `/dashboard`, `/admin`, landing, login | Inter variable        | 14px body, 13px table | 6 / 8 / 12          | `#0F766E` 2px, offset 2px |
| `[data-surface="kiosk"]`                      | `/kiosk`                               | Atkinson Hyperlegible | 20px (`--k-root`)     | 16 / 20 / 28        | `#1E3A8A` 3px, offset 3px |

The kiosk focus ring is blue on purpose (audit): the selected answer is solid teal, so a teal ring
would read as "selected". The ring is drawn outside the option (offset 3px), on the canvas, where
it measures 9.8:1. Add `data-text-size="large"` next to `data-surface="kiosk"` (or on a descendant)
for the "Larger text" toggle: `--k-root` becomes 24px and every `text-k-*` size scales with it.

The kiosk never shows tier, SAE or AESI colours. Only measured/simulated badges are allowed there.

## Tailwind names

| Role                                              | Classes                                                                                                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canvas                                            | `bg-background`                                                                                                                                         |
| Opaque surfaces (tables, forms, evidence, drafts) | `bg-surface`, `bg-surface-subtle` (table head, hover), `bg-surface-selected`                                                                            |
| Text                                              | `text-foreground`, `text-muted-foreground`, `text-subtle-foreground` (lightest allowed)                                                                 |
| Accent (teal)                                     | `bg-primary text-primary-foreground`, hover `bg-primary-strong`, links `text-primary`                                                                   |
| Subtle highlight (shadcn "accent")                | `bg-accent text-accent-foreground` (menu/cmdk highlighted item)                                                                                         |
| Lines                                             | `border-border` (decorative), `border-border-strong` / `border-input` (controls, 3:1)                                                                   |
| Focus                                             | global `:focus-visible`; `.focus-ring` / `.focus-ring-within` for wrappers; `ring-ring`                                                                 |
| Danger action                                     | `bg-destructive text-destructive-foreground`                                                                                                            |
| Status chip                                       | `bg-{s}-bg text-{s}-fg border-{s}-border`, `{s}` = `info success warning danger tier-0 tier-1 tier-2 tier-3 measured simulated sae aesi neutral`        |
| Console type                                      | `text-caption` 12 · `text-table` 13 · `text-body` 14 · `text-title` 16 · `text-page` 20 · `text-display` 24                                             |
| Kiosk type                                        | `text-k-disclaimer` 16 · `text-k-helper` 18 · `text-k-body` 20 · `text-k-answer` 22 · `text-k-lead` 24 · `text-k-question` 30 · `text-k-title` 36       |
| Radius                                            | `rounded-control` (buttons, inputs, chips, options) · `rounded-panel` (panels, cards) · `rounded-sheet` (sheets, palette, glass cards)                  |
| Elevation                                         | `shadow-glass` (inside `.glass`), `shadow-elev-1` (sticky thead), `shadow-elev-2` (popover, menu), `shadow-elev-3` (drawer, modal)                      |
| Sizes                                             | `h-row` 36px, `h-row-comfy` 44px, `h-appbar` 48px, `min-h-k-option` 64px, `gap-k-gap` 12px, `h-k-actionbar` 88px, `max-w-k-content`, `max-w-k-question` |
| Numbers                                           | `.tabular` (alias `.tnum`): tabular figures for vitals, timers, IDs, every table figure                                                                 |
| Fonts                                             | `font-sans` follows the surface; `font-console` / `font-kiosk` force one; `font-mono` for IDs, hashes, SDTM names                                       |
| Motion                                            | `.transition-calm` or `duration-fast` / `duration-base`; colour and opacity only, 200ms max                                                             |

Tailwind's default `rounded-*`, `text-sm/lg/...` and the legacy `brand-*` scale still work so the
existing pages keep rendering; phase 2 migrates them to the names above. Text never goes below
12px on the console or 16px on the kiosk.

## Glass rules

Glass is for **chrome only**:

- App header, command palette, sheets/drawers, toasts.
- Kiosk welcome, login and question cards, and the kiosk action bar.

Never on tables, forms, evidence, drafts, the Why panel or anything a coordinator reads closely.
Those stay `bg-surface` (opaque white), flat, with a `border-border` hairline.

`.glass` = 78% white fill, `backdrop-filter: blur(20px) saturate(170%)` (24px on the kiosk), a
1px white hairline at 70%, an inset top highlight, and a soft large-radius shadow with a 6% outer
ring so the edge reads on a light canvas. Pair it with `rounded-sheet`.

- **Fallback:** without `backdrop-filter` support, or with `prefers-reduced-transparency: reduce`,
  the fill becomes 96% white with no blur. The fallback is the default rule; blur is added only
  inside `@supports`.
- **Text on glass:** `text-foreground` and `text-muted-foreground` stay at or above 4.5:1 on
  `.glass` even when the darkest token colour (`#111827`) sits directly underneath. **Console
  `text-primary` (teal links, active nav) needs `.glass-strong`** (92% fill), or put the active
  item in an opaque `bg-accent` pill. On `.glass` alone it falls to 3.41:1 over dark content.
- No glow, gradient text, animated borders, pointer-tracked highlights or SVG distortion
  filters. Fades are 200ms or less and stop under `prefers-reduced-motion`.

## Contrast table

WCAG 2.x relative-luminance ratios, computed from the hex values in `tokens.css`. Text needs
4.5:1 (AA, normal size); non-text UI boundaries and focus rings need 3:1 (1.4.11).

### Text and controls on opaque surfaces

| Surface | Foreground                                           | Background                       | Ratio | Needs |      |
| ------- | ---------------------------------------------------- | -------------------------------- | ----- | ----- | ---- |
| console | text `#111827`                                       | background `#F3F7F7`             | 16.44 | 4.5   | pass |
| console | text `#111827`                                       | surface `#FFFFFF`                | 17.74 | 4.5   | pass |
| console | text `#111827`                                       | surface-subtle `#EEF3F4`         | 15.85 | 4.5   | pass |
| console | text `#111827`                                       | surface-selected `#E3F1EF`       | 15.29 | 4.5   | pass |
| console | text-muted `#4B5563`                                 | background `#F3F7F7`             | 7.00  | 4.5   | pass |
| console | text-muted `#4B5563`                                 | surface `#FFFFFF`                | 7.56  | 4.5   | pass |
| console | text-muted `#4B5563`                                 | surface-subtle `#EEF3F4`         | 6.75  | 4.5   | pass |
| console | text-muted `#4B5563`                                 | surface-selected `#E3F1EF`       | 6.51  | 4.5   | pass |
| console | text-subtle `#5F6B7A`                                | background `#F3F7F7`             | 5.03  | 4.5   | pass |
| console | text-subtle `#5F6B7A`                                | surface `#FFFFFF`                | 5.43  | 4.5   | pass |
| console | text-subtle `#5F6B7A`                                | surface-subtle `#EEF3F4`         | 4.85  | 4.5   | pass |
| console | text-subtle `#5F6B7A`                                | surface-selected `#E3F1EF`       | 4.67  | 4.5   | pass |
| console | primary (link) `#0F766E`                             | surface `#FFFFFF`                | 5.47  | 4.5   | pass |
| console | primary (link) `#0F766E`                             | background `#F3F7F7`             | 5.07  | 4.5   | pass |
| console | primary (link) `#0F766E`                             | surface-subtle `#EEF3F4`         | 4.89  | 4.5   | pass |
| console | primary-foreground `#FFFFFF`                         | primary `#0F766E`                | 5.47  | 4.5   | pass |
| console | primary-foreground `#FFFFFF`                         | primary-strong `#115E59`         | 7.58  | 4.5   | pass |
| console | accent-foreground `#115E59`                          | accent `#E6F2F1`                 | 6.62  | 4.5   | pass |
| console | destructive-foreground `#FFFFFF`                     | destructive `#B91C1C`            | 6.47  | 4.5   | pass |
| console | destructive (text) `#B91C1C`                         | surface `#FFFFFF`                | 6.47  | 4.5   | pass |
| console | input / border-strong (non-text) `#7B8794`           | surface `#FFFFFF`                | 3.66  | 3     | pass |
| console | ring (non-text) `#0F766E`                            | background `#F3F7F7`             | 5.07  | 3     | pass |
| console | ring (non-text) `#0F766E`                            | surface `#FFFFFF`                | 5.47  | 3     | pass |
| kiosk   | text `#0F172A`                                       | background `#F5F9F9`             | 16.83 | 4.5   | pass |
| kiosk   | text `#0F172A`                                       | surface `#FFFFFF`                | 17.85 | 4.5   | pass |
| kiosk   | text `#0F172A`                                       | surface-subtle `#EEF4F4`         | 16.05 | 4.5   | pass |
| kiosk   | text `#0F172A`                                       | accent `#E6F2F1`                 | 15.59 | 4.5   | pass |
| kiosk   | text-muted `#334155`                                 | background `#F5F9F9`             | 9.76  | 4.5   | pass |
| kiosk   | text-muted `#334155`                                 | surface `#FFFFFF`                | 10.35 | 4.5   | pass |
| kiosk   | text-muted `#334155`                                 | surface-subtle `#EEF4F4`         | 9.31  | 4.5   | pass |
| kiosk   | text-muted `#334155`                                 | accent `#E6F2F1`                 | 9.04  | 4.5   | pass |
| kiosk   | primary-foreground (selected option, Next) `#FFFFFF` | primary `#115E59`                | 7.58  | 4.5   | pass |
| kiosk   | primary-foreground `#FFFFFF`                         | primary-strong (hover) `#134E4A` | 9.48  | 4.5   | pass |
| kiosk   | primary (text) `#115E59`                             | surface `#FFFFFF`                | 7.58  | 4.5   | pass |
| kiosk   | destructive (validation text) `#991B1B`              | surface `#FFFFFF`                | 8.31  | 4.5   | pass |
| kiosk   | input / border-strong (option edge) `#64748B`        | surface `#FFFFFF`                | 4.76  | 3     | pass |
| kiosk   | ring (non-text, outside the option) `#1E3A8A`        | background `#F5F9F9`             | 9.77  | 3     | pass |
| kiosk   | ring (non-text, outside the option) `#1E3A8A`        | surface `#FFFFFF`                | 10.36 | 3     | pass |

### Text on glass

The composite colour is the glass fill blended over what is underneath. "Over canvas" is the
normal case; "worst case" assumes the darkest token colour (`#111827`) directly beneath with no
blur, which overstates the real risk (blur averages it with lighter pixels).

| Surface | Fill              | Text                 | Over canvas | Over worst case (`#111827` beneath)   |
| ------- | ----------------- | -------------------- | ----------- | ------------------------------------- |
| console | .glass 78%        | text `#111827`       | 17.41       | 11.05 pass                            |
| console | .glass 78%        | text-muted `#4B5563` | 7.42        | 4.71 pass                             |
| console | .glass 78%        | primary `#0F766E`    | 5.37        | 3.41 **below 4.5: use .glass-strong** |
| kiosk   | .glass 78%        | text `#0F172A`       | 17.67       | 11.12 pass                            |
| kiosk   | .glass 78%        | text-muted `#334155` | 10.25       | 6.45 pass                             |
| kiosk   | .glass 78%        | primary `#115E59`    | 7.51        | 4.72 pass                             |
| console | .glass-strong 92% | text `#111827`       | 17.59       | 15.13 pass                            |
| console | .glass-strong 92% | text-muted `#4B5563` | 7.49        | 6.45 pass                             |
| console | .glass-strong 92% | primary `#0F766E`    | 5.43        | 4.67 pass                             |
| kiosk   | .glass-strong 92% | text `#0F172A`       | 17.82       | 15.23 pass                            |
| kiosk   | .glass-strong 92% | text-muted `#334155` | 10.34       | 8.83 pass                             |
| kiosk   | .glass-strong 92% | primary `#115E59`    | 7.57        | 6.47 pass                             |
| console | fallback 96%      | text `#111827`       | 17.74       | 16.38 pass                            |
| console | fallback 96%      | text-muted `#4B5563` | 7.56        | 6.98 pass                             |
| console | fallback 96%      | primary `#0F766E`    | 5.47        | 5.06 pass                             |
| kiosk   | fallback 96%      | text `#0F172A`       | 17.85       | 16.49 pass                            |
| kiosk   | fallback 96%      | text-muted `#334155` | 10.35       | 9.56 pass                             |
| kiosk   | fallback 96%      | primary `#115E59`    | 7.58        | 7.00 pass                             |

### Status chips

Every chip carries a word; the icon (Lucide) is extra, colour is third. The chip border is
decorative because the word identifies the chip, except T0, whose outline is its only shape cue,
so its border was darkened from the audit's `#9CA3AF` (2.54:1) to `#6B7280` (4.83:1 on white).

| Chip        | Meaning / icon                                            | fg / bg / border                  | Text ratio | Border vs chip bg | Border vs white |
| ----------- | --------------------------------------------------------- | --------------------------------- | ---------- | ----------------- | --------------- |
| `tier-0`    | T0 · Log / `circle`                                       | `#374151` / `#F3F4F6` / `#6B7280` | 9.37       | 4.39              | 4.83            |
| `tier-1`    | T1 · Review within 1 business day / `clock`               | `#713F12` / `#FEF3C7` / `#D97706` | 7.79       | 2.86              | 3.19            |
| `tier-2`    | T2 · Nurse call today / `phone` (2px border)              | `#7C2D12` / `#FFEDD5` / `#EA580C` | 8.18       | 3.11              | 3.56            |
| `tier-3`    | T3 · Urgent / `siren` (solid)                             | `#FFFFFF` / `#B91C1C` / `#B91C1C` | 6.47       | n/a (solid)       | 6.47            |
| `measured`  | MEASURED / `activity`                                     | `#14532D` / `#DCFCE7` / `#16A34A` | 8.30       | 3.00              | 3.30            |
| `simulated` | SIMULATED / `flask-conical`                               | `#4C1D95` / `#EDE9FE` / `#7C3AED` | 9.23       | 4.80              | 5.70            |
| `sae`       | SAE suspected, 24h clock / `octagon-alert`, `timer`       | `#991B1B` / `#FEF2F2` / `#DC2626` | 7.60       | 4.41              | 4.83            |
| `aesi`      | AESI (possible) / `star`                                  | `#075985` / `#E0F2FE` / `#0284C7` | 6.59       | 3.57              | 4.10            |
| `neutral`   | Draft, rule, reference, open, acknowledged, clock stopped | `#374151` / `#F3F4F6` / `#D5DBE1` | 9.37       | 1.27              | 1.40            |
| `info`      | UI feedback (toast, banner) / `info`                      | `#1E40AF` / `#EFF6FF` / `#3B82F6` | 8.01       | 3.38              | 3.68            |
| `success`   | UI feedback / `circle-check`                              | `#14532D` / `#DCFCE7` / `#16A34A` | 8.30       | 3.00              | 3.30            |
| `warning`   | UI feedback / `triangle-alert`                            | `#713F12` / `#FEF3C7` / `#D97706` | 7.79       | 2.86              | 3.19            |
| `danger`    | UI feedback / `circle-x`                                  | `#991B1B` / `#FEF2F2` / `#DC2626` | 7.60       | 4.41              | 4.83            |

`info`, `success`, `warning` and `danger` are for UI feedback (toasts, banners, "saved", "export
failed"), never for clinical meaning. Clinical meaning uses the tier, sae, aesi and provenance
tokens, so a hue never carries two clinical meanings on one screen.

## Components

Every component lives in this folder and is previewed live at **`/ui-preview`**
(`src/pages/UiPreview.tsx`, synthetic data only). Source credits: `CREDITS.md`.

| Module                                    | Exports                                                                                                                            | Use                                                                                                                                                                                                                                       |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `button.tsx`                              | `Button`                                                                                                                           | All actions. Variants `primary` `secondary` `ghost` `danger` (outline) `destructive` (solid, confirming tap) `glass`; sizes `sm` 28 / `md` 32 / `icon` (needs `aria-label`) / kiosk `xl` (Next 72px, Back 64px). `asChild` styles a link. |
| `badge.tsx`, `badge-kinds.ts`             | `Badge`; `BADGE_KINDS`, `tierBadgeKind`, `draftBadgeKind`, `provenanceBadgeKind`, `querySeverityBadgeKind`, `queryStatusBadgeKind` | Every status chip (icon + word). `short` for dense tables, `detail` for countdowns, `size="lg"` on the kiosk (measured/simulated only).                                                                                                   |
| `kbd.tsx`                                 | `Kbd`, `KbdCombo`, `KbdSequence`                                                                                                   | Shortcut caps; symbols are announced as words.                                                                                                                                                                                            |
| `glass-card.tsx`                          | `GlassCard` + `Header` `Title` `Description` `Action` `Content` `Footer`                                                           | Chrome cards (login, welcome). `strength="strong"` for teal text on the console.                                                                                                                                                          |
| `app-header.tsx`                          | `AppHeader`, `AppHeaderBrand`, `AppHeaderNav`, `AppHeaderNavItem`                                                                  | The 48px glass app bar with count badges and a skip link to `#main`.                                                                                                                                                                      |
| `segmented-control.tsx`                   | `SegmentedControl`                                                                                                                 | Small view switchers (radiogroup, roving focus).                                                                                                                                                                                          |
| `sheet.tsx`                               | `Sheet`, `SheetTrigger`, `SheetContent`, `SheetHeader`, `SheetBody`, `SheetFooter`, `SheetTitle`, `SheetDescription`, `SheetClose` | Side or bottom panels (evidence, forms, Why rail). Data inside stays on opaque panels.                                                                                                                                                    |
| `toaster.tsx`, `toast.ts`                 | `Toaster`, `ToastCard`; `notify`                                                                                                   | Mount `<Toaster />` once; fire with `notify.success/info/warning/danger`, optional `undo`.                                                                                                                                                |
| `data-table.tsx`                          | `DataTable`, `DataTableColumnMeta`                                                                                                 | The one dense opaque table: sorting (`manualSorting` for server order), selection + bulk bar, whole-row open, j/k keys, density.                                                                                                          |
| `command-menu.tsx`, `use-command-menu.ts` | `CommandMenu`; `useCommandMenu`                                                                                                    | Ctrl/Cmd+K palette (optional `/`).                                                                                                                                                                                                        |
| `keyboard.ts`                             | `isTypingTarget`                                                                                                                   | Shared guard so single-key shortcuts ignore text fields.                                                                                                                                                                                  |
| `kiosk/progress.tsx`                      | `KioskProgress`                                                                                                                    | "Question N of M" + segmented bar.                                                                                                                                                                                                        |
| `kiosk/question-card.tsx`                 | `QuestionCard`                                                                                                                     | Glass card holding one question (H1, focus on step change).                                                                                                                                                                               |
| `kiosk/answer-group.tsx`                  | `AnswerGroup`                                                                                                                      | 64px single-choice rows; selected = solid teal + check.                                                                                                                                                                                   |
| `kiosk/action-bar.tsx`                    | `KioskActionBar`, `KIOSK_DISCLAIMER`                                                                                               | Sticky glass Back/Next bar with the verbatim disclaimer.                                                                                                                                                                                  |

Test notes (jsdom): cmdk needs `ResizeObserver` and `Element.prototype.scrollIntoView`
stubs, and clicking a real sonner toast needs `setPointerCapture`. The tests that need them
stub them locally (`command-menu`, `ui-preview`, `toaster`).
