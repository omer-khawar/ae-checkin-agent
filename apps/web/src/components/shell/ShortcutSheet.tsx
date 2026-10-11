/** "?" sheet: every keyboard path in the console, in one place. */
import { Kbd, KbdCombo, KbdSequence } from "@/ui/kbd";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/ui/sheet";

import { MOD_KEY } from "./modKey";

interface Row {
  keys: string[];
  kind: "single" | "combo" | "sequence";
  label: string;
}

const GROUPS: Array<{ title: string; rows: Row[] }> = [
  {
    title: "Anywhere",
    rows: [
      { keys: [MOD_KEY, "K"], kind: "combo", label: "Search and run commands" },
      { keys: ["/"], kind: "single", label: "Search (when not typing)" },
      { keys: ["?"], kind: "single", label: "Show this list" },
      { keys: ["G", "W"], kind: "sequence", label: "Go to Worklist" },
      { keys: ["G", "Q"], kind: "sequence", label: "Go to Queries" },
      { keys: ["G", "E"], kind: "sequence", label: "Go to Escalations" },
      { keys: ["G", "N"], kind: "sequence", label: "Go to Notes" },
      { keys: ["G", "U"], kind: "sequence", label: "Open the next urgent item" },
    ],
  },
  {
    title: "Worklist and detail pages",
    rows: [
      { keys: ["J"], kind: "single", label: "Next row (where the page supports it)" },
      { keys: ["K"], kind: "single", label: "Previous row" },
      { keys: ["Enter"], kind: "single", label: "Open the selected row" },
      { keys: ["Esc"], kind: "single", label: "Close a panel, menu or this sheet" },
    ],
  },
];

function Keys({ row }: { row: Row }) {
  if (row.kind === "combo") return <KbdCombo keys={row.keys} />;
  if (row.kind === "sequence") return <KbdSequence keys={row.keys} />;
  return <Kbd>{row.keys[0]}</Kbd>;
}

export function ShortcutSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" size="sm" showCloseButton>
        <SheetHeader>
          <SheetTitle>Keyboard shortcuts</SheetTitle>
          <SheetDescription>
            Shortcuts are ignored while you are typing in a field.
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          {GROUPS.map((g) => (
            <section key={g.title} className="mb-5">
              <h3 className="mb-1 text-caption font-semibold uppercase tracking-wide text-muted-foreground">
                {g.title}
              </h3>
              <ul className="divide-y divide-border">
                {g.rows.map((r) => (
                  <li key={r.label} className="flex items-center justify-between gap-3 py-2">
                    <span>{r.label}</span>
                    <Keys row={r} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
