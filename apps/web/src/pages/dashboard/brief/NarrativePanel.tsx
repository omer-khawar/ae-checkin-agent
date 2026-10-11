/**
 * The brief's narrative paragraph (CLAUDE.md §00.3 generated-text contract).
 *
 * Each sentence is shown with the evidence chips it cites, and the panel says
 * who wrote it: "Written by template" (the deterministic writer that ships) or
 * "Written by Claude" (only when an API key is configured and the output passed
 * the evidence check). If the LLM output was rejected, the fallback reason is
 * shown so nobody has to guess which text they are reading. Any other writer
 * value from the API is shown as "Writer unknown", never as the template.
 */
import { Card } from "../../../components/Card";
import { cx } from "../../../lib/format";
import { EvidenceChips } from "./EvidenceChips";
import { cites, writerLabel, writerTitle } from "./model";
import type { BriefEvidenceRef, WrittenText } from "./types";

export interface NarrativePanelProps {
  narrative: WrittenText | null;
  selected: string | null;
  onSelectEvidence: (id: string) => void;
  evidence?: Record<string, BriefEvidenceRef>;
  showTechnical: boolean;
}

export function NarrativePanel({
  narrative,
  selected,
  onSelectEvidence,
  evidence,
  showTechnical,
}: NarrativePanelProps) {
  return (
    <Card
      title="In one paragraph"
      aside={
        narrative ? (
          <span
            className={cx(
              "rounded-full border px-2 py-0.5 text-xs font-semibold",
              narrative.writer === "unknown"
                ? "border-amber-300 bg-amber-50 text-amber-900"
                : "border-slate-300 bg-slate-50 text-slate-700",
            )}
            title={writerTitle(narrative.writer)}
            data-writer={narrative.writer}
          >
            {writerLabel(narrative.writer)}
          </span>
        ) : undefined
      }
      className="break-inside-avoid print:shadow-none"
    >
      {!narrative ? (
        <p className="text-sm text-slate-600">No paragraph was returned for this brief.</p>
      ) : (
        <>
          {narrative.fallback_reason && (
            <p
              role="note"
              className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900"
            >
              Claude's draft was not used ({narrative.fallback_reason}). The template text is shown.
            </p>
          )}
          {narrative.sentences.length > 0 ? (
            <ol className="space-y-1.5 text-sm leading-6 text-slate-900" aria-label="Sentences">
              {narrative.sentences.map((s, i) => {
                const hit = cites(s.evidence_ids, selected);
                return (
                  <li
                    key={`${i}-${s.text}`}
                    data-cited={hit ? "true" : undefined}
                    className={cx(
                      "rounded-lg px-2 py-1",
                      hit && "bg-brand-50 ring-2 ring-brand-500/40",
                      "print:bg-white print:ring-0",
                    )}
                  >
                    <span>{s.text}</span>{" "}
                    <EvidenceChips
                      ids={s.evidence_ids}
                      selected={selected}
                      onSelect={onSelectEvidence}
                      evidence={evidence}
                      showTechnical={showTechnical}
                      className="align-middle"
                    />
                    {showTechnical && s.template_id && (
                      <span className="ml-1 rounded bg-slate-100 px-1 font-mono text-[11px] text-slate-500">
                        {s.template_id}
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="text-sm leading-6 text-slate-900">{narrative.text}</p>
          )}
          <p className="mt-3 text-xs text-slate-500">
            Every sentence is built only from the records it cites. Grades are provisional; the
            investigator confirms. A person reviews this text before it leaves the system.
          </p>
        </>
      )}
    </Card>
  );
}
