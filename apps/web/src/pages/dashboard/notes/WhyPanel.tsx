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
      <p className="text-sm text-muted-foreground">
        {isPhoneCall
          ? "No rules fired for this phone call (nothing non-excluded was found in the summary)."
          : "No rules fired for this note (nothing non-excluded was found)."}
      </p>
    );
  }
  return (
    <div className="space-y-4">
      {why.length > 0 && (
        <ol
          className="list-decimal space-y-1.5 pl-5 text-sm text-foreground"
          data-testid="why-list"
        >
          {why.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ol>
      )}
      {rulesFired.length > 0 && (
        <div>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Rules that applied ({rulesFired.length})
          </h3>
          <ul
            className="divide-y divide-border rounded-control border border-border"
            aria-label="Rules fired"
          >
            {rulesFired.map((r, i) => (
              <li key={`${r.rule_id}-${i}`} data-rule-id={r.rule_id}>
                <details className="group">
                  <summary className="cursor-pointer px-3 py-2 text-sm text-foreground hover:bg-surface-subtle">
                    {ruleSentence(r, { labels })}
                  </summary>
                  <div className="space-y-1 px-3 pb-3 text-xs text-muted-foreground">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded border border-border bg-surface-subtle px-1 font-mono text-caption text-primary">
                        {r.rule_id}
                      </span>
                      <span className="rounded bg-surface-subtle px-1.5 py-0.5 text-caption text-muted-foreground">
                        {r.category}
                      </span>
                      {r.effect && <span className="text-muted-foreground">→ {r.effect}</span>}
                    </div>
                    {r.description && (
                      <p className="text-foreground">Engine description: {r.description}</p>
                    )}
                    {Object.keys(r.inputs).length > 0 && (
                      <pre className="overflow-x-auto rounded bg-surface-subtle p-2 font-mono text-caption">
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
