/**
 * R5.3: the Gemini second-reader status line and the collapsed list of
 * findings the quote check rejected (a visible guardrail). Renders nothing
 * when the server does not report a reader (older API).
 */
import { cx } from "../../../lib/format";
import { FOUND_BY_LABEL, foundByOf, readerOf, readerStatusText, rejectedOf } from "./readerTypes";

export function FoundByBadge({ finding }: { finding: unknown }) {
  const fb = foundByOf(finding);
  return (
    <span
      data-testid="found-by"
      data-found-by={fb}
      className={cx(
        "mt-1 inline-block rounded px-1.5 py-0.5 text-[11px] font-medium",
        fb === "scanner"
          ? "bg-surface-subtle text-muted-foreground"
          : "bg-violet-100 text-violet-900",
      )}
      title={
        fb === "gemini"
          ? "Found by Gemini; its exact words were found in the note"
          : fb === "both"
            ? "Found by the scanner and confirmed by Gemini"
            : "Found by the rules scanner"
      }
    >
      Found by: {FOUND_BY_LABEL[fb]}
    </span>
  );
}

export function ReaderPanel({ scan, className }: { scan: unknown; className?: string }) {
  const reader = readerOf(scan);
  const rejected = rejectedOf(scan);
  if (!reader && rejected.length === 0) return null;
  const off = !reader || reader.status === "off" || reader.status === "error";
  return (
    <div className={cx("space-y-2 px-3 py-2 text-sm", className)} data-testid="reader-panel">
      <p
        data-testid="reader-status"
        data-status={reader?.status ?? "unknown"}
        className={off ? "text-muted-foreground" : "font-medium text-violet-900"}
      >
        {readerStatusText(reader)}
      </p>
      {rejected.length > 0 && (
        <details data-testid="reader-rejected">
          <summary className="cursor-pointer text-xs font-medium text-foreground">
            Rejected by the quote check ({rejected.length})
          </summary>
          <ul className="mt-1 space-y-1 text-xs">
            {rejected.map((r, i) => (
              <li key={`${r.quote}-${i}`}>
                <span className="font-mono">“{r.quote}”</span>
                <span className="text-muted-foreground">: {r.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
