/**
 * "Questions to ask at the visit": a checklist built deterministically by the
 * API (missing medication details, side effects still open, reports not signed).
 * Ticks are local to this screen and print as checked boxes; they are not saved
 * and change nothing in the record.
 */
import { useState } from "react";

import { Card } from "../../../components/Card";
import { cx } from "../../../lib/format";
import { EvidenceChips } from "./EvidenceChips";
import { cites, QUESTION_KIND_LABELS } from "./model";
import type { BriefEvidenceRef, BriefQuestion } from "../../../lib/types";

export interface QuestionsChecklistProps {
  questions: BriefQuestion[];
  selected: string | null;
  onSelectEvidence: (id: string) => void;
  evidence?: Record<string, BriefEvidenceRef>;
  showTechnical: boolean;
}

export function QuestionsChecklist({
  questions,
  selected,
  onSelectEvidence,
  evidence,
  showTechnical,
}: QuestionsChecklistProps) {
  const [ticked, setTicked] = useState<ReadonlySet<number>>(new Set());
  const toggle = (i: number) =>
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  return (
    <Card
      title="Questions to ask at the visit"
      aside={
        <span className="tnum text-xs text-slate-600">
          {ticked.size}/{questions.length} done
        </span>
      }
      className="break-inside-avoid print:shadow-none"
    >
      {questions.length === 0 ? (
        <p className="text-sm text-slate-600">No open questions for this visit.</p>
      ) : (
        <ul className="space-y-2">
          {questions.map((q, i) => {
            const id = `brief-q-${i}`;
            const hit = cites(q.evidence_ids, selected);
            const kindLabel = q.kind ? QUESTION_KIND_LABELS[q.kind] : undefined;
            return (
              <li
                key={`${i}-${q.text}`}
                data-cited={hit ? "true" : undefined}
                className={cx(
                  "flex items-start gap-3 rounded-xl border px-3 py-2",
                  hit
                    ? "border-brand-500 bg-brand-50 ring-2 ring-brand-500/40"
                    : "border-slate-200",
                  "print:border-slate-300 print:bg-white print:ring-0",
                )}
              >
                <input
                  id={id}
                  type="checkbox"
                  checked={ticked.has(i)}
                  onChange={() => toggle(i)}
                  className="mt-1 h-5 w-5 shrink-0 rounded border-slate-400 text-brand-700 focus-visible:ring-2 focus-visible:ring-brand-500"
                />
                <div className="min-w-0 flex-1">
                  <label
                    htmlFor={id}
                    className={cx(
                      "block cursor-pointer text-sm leading-6 text-slate-900",
                      ticked.has(i) && "text-slate-500 line-through",
                    )}
                  >
                    {kindLabel && (
                      <span className="mr-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-700 no-underline">
                        {kindLabel}
                      </span>
                    )}
                    {q.text}
                  </label>
                  {q.evidence_ids.length > 0 && (
                    <EvidenceChips
                      ids={q.evidence_ids}
                      selected={selected}
                      onSelect={onSelectEvidence}
                      evidence={evidence}
                      showTechnical={showTechnical}
                      className="mt-1"
                    />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-3 text-xs text-slate-500 print:hidden">
        Ticks stay on this screen only; they are not saved to the record.
      </p>
    </Card>
  );
}
