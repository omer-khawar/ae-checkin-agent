/**
 * "Why" panel for a chart note or phone call: every rule that fired, in plain
 * English first (CLAUDE.md §00). The `why` lines come from the API verbatim;
 * each rule row then leads with its plain sentence (the API's own `plain`
 * text, else the local plain_language.json template filled from the rule's
 * inputs) and keeps the rule id, category, effect and inputs one click deeper
 * in a disclosure, so a judge can still check the arithmetic.
 */
import type { RuleFired, RuleFiredPlain } from "../../../lib/types";
import { evidenceKindName, ruleSentence, type Labels } from "../detail/plain";

export interface WhyPanelProps {
  why: string[];
  rulesFired: Array<RuleFired | RuleFiredPlain>;
  labels?: Labels;
  /** True for a logged phone call (R4.1), so the empty text names it correctly. */
  isPhoneCall?: boolean;
}

export function WhyPanel({ why, rulesFired, labels, isPhoneCall = false }: WhyPanelProps) {
  if (why.length === 0 && rulesFired.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        {isPhoneCall
          ? "No rules fired for this phone call (nothing non-excluded was found in the summary)."
          : "No rules fired for this note (nothing non-excluded was found)."}
      </p>
    );
  }
  return (
    <div className="space-y-4">
      {why.length > 0 && (
        <ol className="list-decimal space-y-1.5 pl-5 text-sm text-slate-800" data-testid="why-list">
          {why.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ol>
      )}
      {rulesFired.length > 0 && (
        <div>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-600">
            Rules that applied ({rulesFired.length})
          </h3>
          <ul
            className="divide-y divide-slate-100 rounded-lg border border-slate-200"
            aria-label="Rules fired"
          >
            {rulesFired.map((r, i) => (
              <li key={`${r.rule_id}-${i}`} data-rule-id={r.rule_id}>
                <details className="group">
                  <summary className="cursor-pointer px-3 py-2 text-sm text-slate-900 hover:bg-slate-50">
                    {ruleSentence(r, { labels })}
                  </summary>
                  <div className="space-y-1 px-3 pb-3 text-xs text-slate-700">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded border border-slate-200 bg-slate-50 px-1 font-mono text-[11px] text-brand-800">
                        {r.rule_id}
                      </span>
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-700">
                        {r.category}
                      </span>
                      {r.effect && <span className="text-slate-600">→ {r.effect}</span>}
                    </div>
                    {r.description && (
                      <p className="text-slate-800">Engine description: {r.description}</p>
                    )}
                    {Object.keys(r.inputs).length > 0 && (
                      <pre className="overflow-x-auto rounded bg-slate-50 p-2 font-mono text-[11px]">
                        {JSON.stringify(r.inputs, null, 1)}
                      </pre>
                    )}
                    {r.evidence.length > 0 && (
                      <div className="space-y-0.5" aria-label="Evidence">
                        {r.evidence.map((e, j) => (
                          <p key={j}>
                            <span title={e.kind}>{evidenceKindName(e.kind)}</span>
                            {e.note ? `: ${e.note}` : ""}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                </details>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
