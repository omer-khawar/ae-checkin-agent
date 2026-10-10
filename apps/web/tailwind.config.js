/**
 * Tailwind palette for Interim. See src/styles/README.md for the rationale.
 *
 * - Neutrals: Tailwind `slate` (text, borders, surfaces).
 * - Primary: Tailwind `teal`, aliased as `brand` so components say `bg-brand-700`
 *   and the palette can be swapped in one place.
 * - Status colours are deliberately NOT aliased: tier chips and badges reference
 *   `amber`/`orange`/`red`/`green`/`violet` directly through the tables in
 *   `src/lib/format.ts`, so the colour-to-meaning mapping lives in one TS file.
 *
 * Light theme only (DECISIONS.md D-006).
 *
 * @type {import('tailwindcss').Config}
 */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
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
      },
      fontFamily: {
        sans: [
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "Noto Sans",
          "sans-serif",
        ],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
      // Kiosk tap targets: WCAG 2.5.5 recommends >= 44px; we go larger.
      minHeight: {
        tap: "3.5rem",
        "tap-lg": "4.25rem",
      },
      boxShadow: {
        card: "0 1px 2px 0 rgb(15 23 42 / 0.06), 0 1px 3px 1px rgb(15 23 42 / 0.04)",
      },
    },
  },
  plugins: [],
};
