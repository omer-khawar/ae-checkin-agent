/**
 * Queue filter bar, one dense line: view tabs (All · Needs action · Serious &
 * special-interest · Notes & calls), participant (free text with a datalist
 * from GET /participants), minimum tier, open|all, (the include_eval URL param still works, no checkbox).
 * Controlled by the page; the participant text is debounced before it reaches
 * the URL. The view tabs filter the loaded page in the browser; the other
 * controls go to GET /queue.
 */
import { useEffect, useId, useState } from "react";

import { Button } from "@/ui/button";
import { SegmentedControl, type Segment } from "@/ui/segmented-control";

import { TIERS } from "../../../lib/format";
import type { Participant } from "../../../lib/types";
import { isDefaultFilters } from "./normalize";
import type { QueueFilterState, QueueView } from "./types";

export interface QueueFiltersProps {
  value: QueueFilterState;
  participants: readonly Participant[];
  onChange: (patch: Partial<QueueFilterState>) => void;
  /** Per-view counts for the tabs (rows on the loaded page). */
  counts?: Partial<Record<QueueView, number>>;
  /** ms before a typed participant filter is applied. */
  debounceMs?: number;
}

const FIELD =
  "focus-ring h-8 rounded-control border border-border-strong bg-surface px-2 text-body text-foreground";
const LABEL = "text-caption font-medium text-muted-foreground";

const VIEWS: ReadonlyArray<{ value: QueueView; label: string }> = [
  { value: "all", label: "All" },
  { value: "needs", label: "Needs action" },
  { value: "serious", label: "Serious & special-interest" },
  { value: "notes", label: "Notes & calls" },
];

export function QueueFilters({
  value,
  participants,
  onChange,
  counts,
  debounceMs = 300,
}: QueueFiltersProps) {
  const id = useId();
  const [typed, setTyped] = useState(value.participant);

  // Keep the box in sync when the URL changes from outside (back button, Clear).
  useEffect(() => {
    setTyped(value.participant);
  }, [value.participant]);

  // Debounce typing → URL; a datalist pick is also just an input event.
  useEffect(() => {
    if (typed === value.participant) return;
    const t = setTimeout(() => onChange({ participant: typed, offset: 0 }), debounceMs);
    return () => clearTimeout(t);
  }, [typed, value.participant, onChange, debounceMs]);

  const isDefault = isDefaultFilters(value);
  const segments: Segment<QueueView>[] = VIEWS.map((v) => ({
    value: v.value,
    label: v.label,
    accessory:
      counts && counts[v.value] !== undefined ? (
        <span className="tabular text-muted-foreground">{counts[v.value]}</span>
      ) : undefined,
  }));

  return (
    <form
      className="flex flex-wrap items-end gap-x-3 gap-y-2"
      aria-label="Queue filters"
      onSubmit={(e) => {
        e.preventDefault();
        onChange({ participant: typed, offset: 0 });
      }}
    >
      <SegmentedControl
        label="Queue view"
        size="sm"
        options={segments}
        value={value.view}
        onValueChange={(view) => onChange({ view })}
      />

      <div className="flex items-center gap-1.5">
        <label htmlFor={`${id}-participant`} className={LABEL}>
          Participant
        </label>
        <input
          id={`${id}-participant`}
          list={`${id}-participants`}
          className={`${FIELD} w-32`}
          placeholder="All"
          value={typed}
          autoComplete="off"
          onChange={(e) => setTyped(e.target.value)}
        />
        <datalist id={`${id}-participants`}>
          {participants.map((p) => (
            <option key={p.usubjid} value={p.display_label}>
              {p.usubjid}
            </option>
          ))}
        </datalist>
      </div>

      <div className="flex items-center gap-1.5">
        <label htmlFor={`${id}-tier`} className={LABEL}>
          Minimum tier
        </label>
        <select
          id={`${id}-tier`}
          className={FIELD}
          value={value.minTier}
          onChange={(e) => onChange({ minTier: Number(e.target.value), offset: 0 })}
        >
          <option value={0}>Any tier</option>
          {([1, 2, 3] as const).map((t) => (
            <option key={t} value={t}>
              Tier {t}+ · {TIERS[t].name}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center gap-1.5">
        <label htmlFor={`${id}-status`} className={LABEL}>
          Status
        </label>
        <select
          id={`${id}-status`}
          className={FIELD}
          value={value.status}
          onChange={(e) =>
            onChange({ status: e.target.value === "all" ? "all" : "open", offset: 0 })
          }
        >
          <option value="open">Open (drafts awaiting review)</option>
          <option value="all">All</option>
        </select>
      </div>

      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={isDefault}
        onClick={() => {
          setTyped("");
          onChange({
            participant: "",
            minTier: 0,
            status: "open",
            includeEval: false,
            offset: 0,
            view: "all",
          });
        }}
      >
        Clear filters
      </Button>
    </form>
  );
}
