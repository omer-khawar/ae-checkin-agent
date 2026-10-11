/**
 * Generated text, one sentence per line, each with its evidence chips and the
 * writer label (CLAUDE.md §00.3: "written by template / written by Claude").
 * A sentence with no evidence would break the contract; it is flagged rather
 * than hidden so a reviewer sees it.
 */
import { writerLabel } from "./model";
import { EvidenceChip } from "./bits";
import type { QueryEvidence, WrittenText } from "../../../lib/types";

export interface WrittenTextViewProps {
  written: WrittenText;
  evidenceById: Map<string, QueryEvidence>;
  activeEvidenceId: string | null;
  onSelectEvidence: (id: string) => void;
}

export function WrittenTextView({
  written,
  evidenceById,
  activeEvidenceId,
  onSelectEvidence,
}: WrittenTextViewProps) {
  return (
    <div data-testid="suggested-answer">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <span className="rounded-full border border-border-strong bg-surface-subtle px-2 py-0.5 font-medium text-muted-foreground">
          {writerLabel(written)}
        </span>
        {written.fallback_reason && (
          <span className="text-warning-fg">Template used because: {written.fallback_reason}</span>
        )}
      </div>
      {written.sentences.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          The writer had no facts to cite for this query.
        </p>
      ) : (
        <ol className="space-y-2">
          {written.sentences.map((s, i) => (
            <li key={i} className="text-sm leading-relaxed text-foreground">
              <span>{s.text}</span>{" "}
              <span className="inline-flex flex-wrap gap-1 align-middle">
                {s.evidence_ids.length === 0 ? (
                  <span className="rounded border border-warning-border bg-warning-bg px-1.5 py-0.5 text-caption text-warning-fg">
                    No evidence cited
                  </span>
                ) : (
                  s.evidence_ids.map((id) => (
                    <EvidenceChip
                      key={id}
                      id={id}
                      evidence={evidenceById.get(id)}
                      active={activeEvidenceId === id}
                      onSelect={onSelectEvidence}
                    />
                  ))
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
