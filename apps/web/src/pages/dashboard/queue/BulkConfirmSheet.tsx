/**
 * "Confirm all drafts (N)": a confirmation sheet for the rows ticked in the worklist.
 *
 * Opens, loads the still-unconfirmed drafts of the selected rows (GET /checkins/:id or
 * GET /notes/:id, one call per row), lists them grouped by participant, and on confirm calls
 * the existing POST /drafts/:id/confirm once per draft. There is no undo: confirming is the
 * explicit, audited human step, so the sheet says exactly what will happen first.
 * Only low-risk rows can be selected at all (see bulk.ts), so nothing here can confirm a
 * Tier 2+ item or one with a running 24-hour clock.
 */
import { useEffect, useState } from "react";

import { Button } from "@/ui/button";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/ui/sheet";

import { confirmAll, loadPendingDrafts, type BulkResult, type PendingDraft } from "./bulk";
import { countLabel } from "./summary";
import type { QueueRow } from "./types";

export interface BulkConfirmSheetProps {
  open: boolean;
  rows: QueueRow[];
  onOpenChange: (open: boolean) => void;
  /** Called once with the outcome, after the confirm calls settle. */
  onDone: (result: BulkResult, rowCount: number) => void;
}

const DOMAIN_WORD: Record<string, string> = {
  AE: "side effect",
  VS: "vital sign",
  CM: "medication",
};

export function BulkConfirmSheet({ open, rows, onOpenChange, onDone }: BulkConfirmSheetProps) {
  const [drafts, setDrafts] = useState<PendingDraft[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setDrafts(null);
    setError(null);
    loadPendingDrafts(rows).then(
      (list) => {
        if (!cancelled) setDrafts(list);
      },
      () => {
        if (!cancelled) setError("Could not load the drafts for the selected rows. Try again.");
      },
    );
    return () => {
      cancelled = true;
    };
    // `rows` identity changes on every poll; the selection at open time is what counts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const byRow = new Map<string, PendingDraft[]>();
  for (const d of drafts ?? []) byRow.set(d.rowKey, [...(byRow.get(d.rowKey) ?? []), d]);

  const run = async () => {
    if (!drafts || drafts.length === 0) return;
    setBusy(true);
    const result = await confirmAll(drafts);
    setBusy(false);
    onOpenChange(false);
    onDone(result, byRow.size);
  };

  return (
    <Sheet open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <SheetContent side="right" size="md">
        <SheetHeader>
          <SheetTitle>Confirm drafts for {countLabel(rows.length, "item")}</SheetTitle>
          <SheetDescription>
            Each draft is confirmed as it is shown, with its evidence unchanged. This cannot be
            undone here; later edits create a new version.
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          {error ? (
            <p role="alert" className="text-body text-danger-fg">
              {error}
            </p>
          ) : drafts === null ? (
            <p role="status" className="text-body text-muted-foreground">
              Loading drafts…
            </p>
          ) : drafts.length === 0 ? (
            <p role="status" className="text-body text-muted-foreground">
              Nothing left to confirm: every draft on these items is already confirmed or rejected.
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-panel border border-border bg-surface">
              {rows
                .filter((r) => byRow.has(r.key))
                .map((r) => {
                  const list = byRow.get(r.key) ?? [];
                  const words = Object.entries(
                    list.reduce<Record<string, number>>((acc, d) => {
                      acc[d.domain] = (acc[d.domain] ?? 0) + 1;
                      return acc;
                    }, {}),
                  ).map(([dom, n]) => countLabel(n, DOMAIN_WORD[dom] ?? dom));
                  return (
                    <li key={r.key} className="flex items-baseline justify-between gap-3 px-3 py-2">
                      <span className="font-semibold text-foreground">{r.display_label}</span>
                      <span className="text-body text-muted-foreground">{words.join(" · ")}</span>
                    </li>
                  );
                })}
            </ul>
          )}
        </SheetBody>
        <SheetFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!drafts || drafts.length === 0}
            onClick={run}
          >
            {`Confirm all drafts (${drafts?.length ?? 0})`}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
