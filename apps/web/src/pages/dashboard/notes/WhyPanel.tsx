/**
 * "Why" panel: every rule that fired, in plain English, with the inputs it used.
 * The `why` lines come from the API verbatim; the expandable rule rows show
 * `rule_id`, category, effect and inputs so a judge can check the arithmetic.
 */
import type { RuleFired } from "../../../lib/types";

export interface WhyPanelProps {
  why: string[];
  rulesFired: RuleFired[];
}

export function WhyPanel({ why, rulesFired }: WhyPanelProps) {
  if (why.length === 0 && rulesFired.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        No rules fired for this note (nothing non-excluded was found).
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
            Rules fired ({rulesFired.length})
          </h3>
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
            {rulesFired.map((r, i) => (
              <li key={`${r.rule_id}-${i}`}>
                <details className="group">
                  <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2 text-sm hover:bg-slate-50">
                    <span className="font-mono text-xs text-brand-800">{r.rule_id}</span>
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-700">
                      {r.category}
                    </span>
                    {r.effect && <span className="text-xs text-slate-600">→ {r.effect}</span>}
                  </summary>
                  <div className="space-y-1 px-3 pb-3 text-xs text-slate-700">
                    {r.description && <p className="text-slate-800">{r.description}</p>}
                    {Object.keys(r.inputs).length > 0 && (
                      <pre className="overflow-x-auto rounded bg-slate-50 p-2 font-mono text-[11px]">
                        {JSON.stringify(r.inputs, null, 1)}
                      </pre>
                    )}
                    {r.evidence.length > 0 && (
                      <ul className="list-disc pl-4">
                        {r.evidence.map((e, j) => (
                          <li key={j}>
                            <span className="font-mono">{e.kind}</span>
                            {e.note ? `: ${e.note}` : ""}
                          </li>
                        ))}
                      </ul>
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
