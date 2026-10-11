/**
 * Tailwind 3.4 config for Interim. Token values live in src/styles/tokens.css as
 * CSS variables (two scopes: [data-surface="console"] and [data-surface="kiosk"]);
 * this file only maps role names onto them. Rationale + contrast: src/ui/README.md.
 *
 * Naming follows shadcn conventions so components adapted from 21st.dev/shadcn
 * need few edits:
 *   - `primary`  = the teal accent (buttons, links, active nav, selected fill)
 *   - `accent`   = the SUBTLE teal fill for hover / highlighted items (shadcn meaning)
 *   - `muted`    = subtle surface; `muted-foreground` = secondary text
 *   - `ring`     = focus colour
 * Status chips: `bg-tier-2-bg text-tier-2-fg border-tier-2-border`, same shape for
 * info/success/warning/danger/measured/simulated/sae/aesi/neutral.
 *
 * Legacy keys (`brand`, `minHeight.tap*`, `shadow-card`) are kept until every page
 * has migrated in phase 2. Tailwind's default radius/font-size keys are NOT
 * overridden (existing pages still use them); new components use the named keys
 * below (`rounded-control|panel|sheet`, `text-caption|table|body|...|k-question`).
 *
 * Light theme only (DECISIONS.md D-006).
 *
 * @type {import('tailwindcss').Config}
 */

/** `rgb(var(--x) / <alpha-value>)` so opacity modifiers work: `bg-primary/10`. */
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;

/** {bg, fg, border} triplet for a status token family. */
const status = (name) => ({
  bg: v(`${name}-bg`),
  fg: v(`${name}-fg`),
  border: v(`${name}-border`),
});

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Legacy alias of Tailwind teal; removed after the phase 2 migration.
        brand: {
          50: "#f0fdfa",
          100: "#ccfbf1",
          200: "#99f6e4",
          300: "#5eead4",
          400: "#2dd4bf",
          500: "#14b8a6",
          600: "#0d9488",
          700: "#0f766e",
          800: "#115e59",
          900: "#134e4a",
          950: "#042f2e",
        },

        background: v("background"),
        foreground: v("foreground"),
        surface: {
          DEFAULT: v("surface"),
          subtle: v("surface-subtle"),
          selected: v("surface-selected"),
        },
        card: { DEFAULT: v("surface"), foreground: v("text") },
        popover: { DEFAULT: v("surface"), foreground: v("text") },
        muted: { DEFAULT: v("surface-subtle"), foreground: v("text-muted") },
        subtle: { foreground: v("text-subtle") },
        primary: {
          DEFAULT: v("accent"),
          strong: v("accent-strong"),
          foreground: v("accent-fg"),
        },
        accent: { DEFAULT: v("accent-subtle"), foreground: v("accent-subtle-fg") },
        destructive: { DEFAULT: v("destructive"), foreground: v("destructive-fg") },
        border: { DEFAULT: v("border"), strong: v("border-strong") },
        input: v("border-strong"),
        ring: v("focus"),

        info: status("info"),
        success: status("success"),
        warning: status("warning"),
        danger: status("danger"),
        "tier-0": status("tier-0"),
        "tier-1": status("tier-1"),
        "tier-2": status("tier-2"),
        "tier-3": status("tier-3"),
        measured: status("measured"),
        simulated: status("simulated"),
        sae: status("sae"),
        aesi: status("aesi"),
        neutral: status("neutral"),
      },
      fontFamily: {
        // Follows the surface: Inter on the console, Atkinson Hyperlegible on the kiosk.
        sans: ["var(--font-sans)"],
        console: [
          '"Inter Variable"',
          "Inter",
          "system-ui",
          "-apple-system",
          '"Segoe UI"',
          "Roboto",
          "sans-serif",
        ],
        kiosk: [
          '"Atkinson Hyperlegible"',
          "system-ui",
          "-apple-system",
          '"Segoe UI"',
          "Roboto",
          "sans-serif",
        ],
        mono: ["var(--font-mono)"],
      },
      fontSize: {
        // Console scale (never below 12px).
        caption: ["var(--fs-caption)", { lineHeight: "1.35" }],
        table: ["var(--fs-table)", { lineHeight: "1.35" }],
        body: ["var(--fs-body)", { lineHeight: "1.5" }],
        title: ["var(--fs-title)", { lineHeight: "1.4", fontWeight: "600" }],
        page: ["var(--fs-page)", { lineHeight: "1.3", fontWeight: "600" }],
        display: ["var(--fs-display)", { lineHeight: "1.25", fontWeight: "600" }],
        // Kiosk scale (scales with --k-root; never below 16px).
        "k-disclaimer": ["var(--fs-k-disclaimer)", { lineHeight: "1.5" }],
        "k-helper": ["var(--fs-k-helper)", { lineHeight: "1.5" }],
        "k-body": ["var(--fs-k-body)", { lineHeight: "1.5" }],
        "k-answer": ["var(--fs-k-answer)", { lineHeight: "1.45", fontWeight: "600" }],
        "k-lead": ["var(--fs-k-lead)", { lineHeight: "1.4" }],
        "k-question": ["var(--fs-k-question)", { lineHeight: "1.3", fontWeight: "700" }],
        "k-title": ["var(--fs-k-title)", { lineHeight: "1.2", fontWeight: "700" }],
      },
      borderRadius: {
        control: "var(--radius-sm)",
        panel: "var(--radius-md)",
        sheet: "var(--radius-lg)",
      },
      boxShadow: {
        card: "0 1px 2px 0 rgb(15 23 42 / 0.06), 0 1px 3px 1px rgb(15 23 42 / 0.04)",
        glass: "var(--glass-highlight), var(--glass-shadow)",
        "elev-1": "var(--elev-1)",
        "elev-2": "var(--elev-2)",
        "elev-3": "var(--elev-3)",
      },
      spacing: {
        row: "var(--row-h)",
        "row-comfy": "var(--row-h-comfy)",
        appbar: "var(--appbar-h)",
        "k-option": "var(--k-option-h, 64px)",
        "k-gap": "var(--k-option-gap, 12px)",
        "k-actionbar": "var(--k-actionbar-h, 88px)",
      },
      // Kiosk tap targets: WCAG 2.5.5 recommends >= 44px; we go larger.
      minHeight: {
        tap: "3.5rem",
        "tap-lg": "4.25rem",
        "k-option": "var(--k-option-h, 64px)",
        row: "var(--row-h)",
      },
      maxWidth: {
        "k-content": "calc(var(--k-root, 20px) * 40)",
        "k-question": "calc(var(--k-root, 20px) * 34)",
      },
      transitionDuration: {
        fast: "var(--motion-fast)",
        base: "var(--motion-base)",
      },
      backdropBlur: {
        glass: "var(--glass-blur)",
      },
    },
  },
  plugins: [],
};
