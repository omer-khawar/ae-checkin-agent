/**
 * Small "explains itself" building blocks for the Eval page (CLAUDE.md §3.7.2,
 * §13; task craft bar "every derived value shows its evidence/rules").
 *
 * - `InputChips` renders a rule's `inputs` (the values it compared and the
 *   thresholds it compared them against) as `key: value` chips.
 * - `EvidenceList` renders an `Evidence[]` (answer / vitals-sample / rule /
 *   table pointers) as a collapsed `<details>` so tables stay compact.
 *
 * Display only; nothing here computes a value.
 */
import { Time } from "../../../lib/format";
import type { Evidence } from "../../../lib/types";

/**
 * Render one rule input value as text; objects/arrays fall back to compact
 * JSON. Module-private so this file exports only components (react-refresh).
 */
function formatInputValue(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function InputChips({
  inputs,
  label = "Inputs",
}: {
  inputs?: Record<string, unknown> | null;
  label?: string;
}) {
  const entries = Object.entries(inputs ?? {});
  if (entries.length === 0) return null;
  return (
    <ul className="mt-1 flex flex-wrap gap-1" aria-label={label}>
      {entries.map(([k, v]) => (
        <li
          key={k}
          className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[11px] text-slate-800"
        >
          {k}: {formatInputValue(v)}
        </li>
      ))}
    </ul>
  );
}

export function EvidenceList({
  evidence,
  summary,
  className,
}: {
  evidence?: Evidence[] | null;
  /** Override the `<summary>` text. */
  summary?: string;
  className?: string;
}) {
  const list = evidence ?? [];
  if (list.length === 0) return null;
  return (
    <details className={className ?? "mt-1 text-xs text-slate-700"}>
      <summary className="cursor-pointer">
        {summary ?? `${list.length} evidence pointer${list.length === 1 ? "" : "s"}`}
      </summary>
      <ul className="mt-1 space-y-1 pl-1">
        {list.map((e, i) => (
          <li key={`${e.id}-${i}`} className="flex flex-wrap items-baseline gap-x-2">
            <span className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[10px] uppercase tracking-wide text-slate-700">
              {e.kind}
            </span>
            <span className="text-slate-900">{e.note}</span>
            {e.ts && <Time iso={e.ts} style="time" className="text-slate-500" />}
            <span className="font-mono text-[10px] text-slate-500">{e.id}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
