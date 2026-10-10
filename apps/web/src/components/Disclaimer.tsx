/**
 * The persistent footer sentence (CLAUDE.md §3.8, CONTRACTS.md §4). Verbatim; do
 * not paraphrase. Rendered on every page, kiosk and dashboard alike.
 */
export const DISCLAIMER_TEXT =
  "Interim is a research data-capture tool. It is not a medical device and does not provide medical advice.";

export interface DisclaimerProps {
  /** Larger type for the kiosk. */
  large?: boolean;
}

export function Disclaimer({ large }: DisclaimerProps) {
  return (
    <footer
      className={
        large
          ? "border-t border-slate-200 bg-white px-6 py-4 text-center text-base text-slate-600"
          : "border-t border-slate-200 bg-white px-4 py-3 text-center text-xs text-slate-600"
      }
    >
      <p>{DISCLAIMER_TEXT}</p>
    </footer>
  );
}
