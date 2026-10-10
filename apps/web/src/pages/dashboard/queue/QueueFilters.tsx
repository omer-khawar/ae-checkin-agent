/**
 * Queue filter bar: participant (free text with a datalist from GET
 * /participants), minimum tier, open|all, include-eval toggle. Controlled by
 * the page; the participant text is debounced before it reaches the URL.
 */
import { useEffect, useId, useState } from "react";

import { Button } from "../../../components/Button";
import { TIERS } from "../../../lib/format";
import type { Participant } from "../../../lib/types";
import { isDefaultFilters } from "./normalize";
import type { QueueFilterState } from "./types";

export interface QueueFiltersProps {
  value: QueueFilterState;
  participants: readonly Participant[];
  onChange: (patch: Partial<QueueFilterState>) => void;
  /** ms before a typed participant filter is applied. */
  debounceMs?: number;
}

const FIELD =
  "rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900 min-h-9";
const LABEL = "text-xs font-medium text-slate-600";

export function QueueFilters({
  value,
  participants,
  onChange,
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

  return (
    <form
      className="flex flex-wrap items-end gap-x-4 gap-y-3"
      aria-label="Queue filters"
      onSubmit={(e) => {
        e.preventDefault();
        onChange({ participant: typed, offset: 0 });
      }}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-participant`} className={LABEL}>
          Participant
        </label>
        <input
          id={`${id}-participant`}
          list={`${id}-participants`}
          className={`${FIELD} w-44`}
          placeholder="All (type P-007)"
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

      <div className="flex flex-col gap-1">
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

      <div className="flex flex-col gap-1">
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

      <label className="flex min-h-9 items-center gap-2 text-sm text-slate-800">
        <input
          type="checkbox"
          className="h-4 w-4 accent-brand-700"
          checked={value.includeEval}
          onChange={(e) => onChange({ includeEval: e.target.checked, offset: 0 })}
        />
        Include eval runs
        <span
          className="text-xs text-slate-500"
          title="Sessions created by the evaluation harness, not by a participant at the kiosk"
        >
          (harness sessions)
        </span>
      </label>

      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={isDefault}
        onClick={() => {
          setTyped("");
          onChange({ participant: "", minTier: 0, status: "open", includeEval: false, offset: 0 });
        }}
      >
        Clear filters
      </Button>
    </form>
  );
}
