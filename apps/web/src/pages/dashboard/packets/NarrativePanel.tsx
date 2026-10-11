/**
 * The draft narrative (CLAUDE.md §00.3 generated-text contract).
 *
 * - Each generated sentence is shown with its evidence chips; a chip opens the
 *   evidence inspector, so every sentence can be traced to its source.
 * - The writer is always named: "Written by template" (the deterministic
 *   default) or "Written by Claude" (optional LLM writer), plus the fallback
 *   reason when the LLM draft was rejected.
 * - Generated text is never presented as final: until the packet is signed the
 *   card says "Draft" and who must sign it.
 * - The investigator can rewrite the text in a text area. The edit is staged
 *   and saved with the page's Save button (PATCH, versioned); the generated
 *   sentences and their evidence stay available one click deeper.
 */
import { useId } from "react";

import { Button } from "../../../components/Button";
import { Card } from "../../../components/Card";
import { cx, Time } from "../../../lib/format";
import { EvidenceChips, type EvidenceSelection } from "./EvidenceBits";
import { type NarrativeView, writerLabel } from "./model";
import type { PacketEvidence, PacketStatus, WrittenText } from "../../../lib/types";

export interface NarrativePanelProps {
  narrative: WrittenText;
  view: NarrativeView;
  status: PacketStatus;
  signedBy: string | null;
  signedAt: string | null;
  evidence: Map<string, PacketEvidence>;
  /** Investigator only, and only while the packet is a draft. */
  canEdit: boolean;
  /** Staged text (null = not editing). */
  draftText: string | null;
  onDraftChange: (text: string | null) => void;
  selectedKey: string | null;
  onSelectEvidence: (s: EvidenceSelection) => void;
}

export function NarrativePanel({
  narrative,
  view,
  status,
  signedBy,
  signedAt,
  evidence,
  canEdit,
  draftText,
  onDraftChange,
  selectedKey,
  onSelectEvidence,
}: NarrativePanelProps) {
  const areaId = useId();
  const signed = status === "signed";
  // The text area exists only while editing is allowed: once the page freezes
  // (sign confirmation open) or the packet is signed, a staged edit is never
  // shown as if it were the report's text.
  const editing = canEdit && draftText !== null;
  // Who wrote the text on screen. A person's rewrite is theirs, not the
  // writer's; the generated sentences keep the writer label one click deeper.
  const headerLabel = view.editedByPerson
    ? `Edited by ${view.editedBy ?? "a person"} (from a ${
        narrative.writer === "llm" ? "Claude" : "template"
      } draft)`
    : writerLabel(narrative.writer);

  const sentenceList = (
    <ol className="space-y-2" aria-label="Narrative sentences with evidence">
      {view.sentences.map((s, i) => (
        <li key={i} className="rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2">
          <p className="text-slate-900">{s.text}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <EvidenceChips
              items={s.evidence_ids.map((id) => ({ id, evidence: evidence.get(id) ?? null }))}
              keyPrefix={`sentence:${i}`}
              context={`Narrative sentence ${i + 1}`}
              selectedKey={selectedKey}
              onSelect={onSelectEvidence}
              emptyText="No evidence cited"
            />
            {s.template_id && (
              <code
                className="font-mono text-[10px] text-slate-400"
                title="Template sentence id (narrative_templates.json)"
              >
                {s.template_id}
              </code>
            )}
          </div>
        </li>
      ))}
    </ol>
  );

  return (
    <Card
      title="Narrative"
      aside={
        <span className="flex flex-wrap items-center justify-end gap-2">
          <span
            className="rounded-md border border-slate-300 bg-white px-1.5 py-0.5 text-[11px] font-semibold text-slate-700"
            data-testid="writer-label"
          >
            {headerLabel}
          </span>
          {signed ? (
            <span className="rounded-md border border-green-300 bg-green-50 px-1.5 py-0.5 text-[11px] font-semibold text-green-900">
              Signed
            </span>
          ) : (
            <span className="rounded-md border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[11px] font-semibold text-amber-900">
              Draft
            </span>
          )}
        </span>
      }
    >
      <div className="space-y-3">
        {signed ? (
          <p className="text-sm text-slate-600">
            Signed by <span className="font-semibold">{signedBy ?? "the investigator"}</span>
            {signedAt && (
              <>
                {" "}
                on <Time iso={signedAt} />
              </>
            )}
            .
          </p>
        ) : (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            This is a draft written from the evidence. It is not final until the investigator
            reviews and signs the report.
          </p>
        )}

        {narrative.fallback_reason && (
          <p className="text-xs text-slate-600">
            Claude’s draft was not used ({narrative.fallback_reason}); the template writer wrote
            this text instead.
          </p>
        )}

        {editing ? (
          <div className="space-y-2">
            <label htmlFor={areaId} className="block text-sm font-semibold text-slate-800">
              Narrative text (your edit)
            </label>
            <textarea
              id={areaId}
              value={draftText}
              onChange={(e) => onDraftChange(e.target.value)}
              rows={8}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm leading-relaxed focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/30"
            />
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-slate-600">
                Not saved yet. Use <span className="font-semibold">Save</span> at the top of the
                page.
              </span>
              <Button size="sm" variant="ghost" onClick={() => onDraftChange(null)}>
                Discard my edit
              </Button>
            </div>
          </div>
        ) : view.editedByPerson ? (
          <div className="space-y-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Current text, edited by {view.editedBy ?? "a person"}
              {view.editedAt && (
                <>
                  {" "}
                  (<Time iso={view.editedAt} style="short" />)
                </>
              )}
            </p>
            <p className="whitespace-pre-wrap text-slate-900" data-testid="narrative-current">
              {view.text}
            </p>
          </div>
        ) : null}

        {view.sentences.length === 0 ? (
          !view.editedByPerson && !editing ? (
            <p className="text-sm text-slate-600">
              No narrative sentences were written: the evidence did not support any. The
              investigator can write the narrative here.
            </p>
          ) : null
        ) : view.editedByPerson || editing ? (
          <details className="rounded-lg border border-slate-200">
            <summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-slate-700">
              Generated sentences and their evidence ({view.sentences.length}){" "}
              <span
                className="ml-1 rounded-md border border-slate-300 bg-white px-1.5 py-0.5 text-[11px] font-semibold text-slate-700"
                data-testid="generated-writer-label"
              >
                {writerLabel(narrative.writer)}
              </span>
            </summary>
            <div className="px-3 pb-3">{sentenceList}</div>
          </details>
        ) : (
          sentenceList
        )}

        {canEdit && !editing && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => onDraftChange(view.text)}
            className={cx(view.sentences.length === 0 && "mt-1")}
          >
            Edit narrative
          </Button>
        )}
      </div>
    </Card>
  );
}
