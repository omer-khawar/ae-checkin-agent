/**
 * Print stylesheet for the brief, injected only while the page is mounted.
 *
 * - Hides the dashboard chrome (the Layout header that holds the nav, the nav
 *   itself, toasts) and the page's own controls (`data-print-hide`).
 * - Keeps the footer: the not-a-medical-device sentence prints on the page.
 * - Removes the max-width / padding of <main> so the brief uses the paper.
 *
 * `header:has(nav)` targets the Layout header without touching Layout.tsx
 * (owned elsewhere); `nav` is also hidden on its own as a fallback for browsers
 * without `:has`.
 */
export const PRINT_CSS = `
@media print {
  header:has(nav), [data-slot^="app-header"], nav, [data-print-hide], [aria-live] { display: none !important; }
  html, body { background: #fff !important; }
  main { max-width: none !important; padding: 0 !important; }
  [data-brief-root] { font-size: 11pt; }
  [data-brief-root] a { color: inherit !important; }
  [data-brief-root] section { break-inside: avoid; box-shadow: none !important; }
  footer { break-inside: avoid; }
  .glass, .glass-strong { backdrop-filter: none !important; background: #fff !important; box-shadow: none !important; }
  [data-brief-root] input[type="checkbox"] { appearance: auto; }
}
@page { margin: 14mm; }
`;
