import { pageInfo } from "../lib/api";
import { Button } from "./Button";

export interface PaginationProps {
  total: number;
  limit: number;
  offset: number;
  onChange: (next: { limit: number; offset: number }) => void;
  className?: string;
}

/** Prev / next controls for `{items, total, limit, offset}` responses. */
export function Pagination({ total, limit, offset, onChange, className }: PaginationProps) {
  const info = pageInfo({ total, limit, offset });
  return (
    <nav className={className} aria-label="Pagination">
      <div className="flex items-center justify-between gap-3 text-table text-muted-foreground">
        <span className="tabular">
          {info.from}–{info.to} of {total}
        </span>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={!info.hasPrev}
            onClick={() => onChange({ limit, offset: Math.max(0, offset - limit) })}
          >
            Previous
          </Button>
          <span className="tabular">
            Page {info.page} / {info.pages}
          </span>
          <Button
            size="sm"
            variant="secondary"
            disabled={!info.hasNext}
            onClick={() => onChange({ limit, offset: offset + limit })}
          >
            Next
          </Button>
        </div>
      </div>
    </nav>
  );
}
