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
          ? "border-t border-border bg-surface px-6 py-4 text-center text-k-disclaimer text-muted-foreground"
          : "border-t border-border bg-surface px-4 py-2 text-center text-caption text-muted-foreground"
      }
    >
      <p>{DISCLAIMER_TEXT}</p>
    </footer>
  );
}
