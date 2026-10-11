/**
 * "Reference safety information (public label excerpt)" — collapsed by default,
 * fetched from GET /reference/label the first time it is opened. Read-only text
 * from the public openFDA label; shown beside the investigator controls so the
 * attribution decision has the label at hand. No advice is derived from it.
 */
import { useState } from "react";

import { ErrorBanner } from "../../../components/ErrorBanner";
import { getReferenceLabel } from "../../../lib/api";
import { Time } from "../../../lib/format";
import type { ReferenceLabel } from "../../../lib/types";
import { Disclosure } from "./bits";

export function ReferencePanel() {
  const [label, setLabel] = useState<ReferenceLabel | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);

  const load = () => {
    if (label || loading) return;
    setLoading(true);
    setError(null);
    getReferenceLabel()
      .then(setLabel)
      .catch(setError)
      .finally(() => setLoading(false));
  };

  return (
    <Disclosure
      summary="Reference safety information (public label excerpt)"
      onToggle={(open) => {
        if (open) load();
      }}
    >
      {loading && <p className="text-sm text-slate-500">Loading label excerpt…</p>}
      <ErrorBanner error={error} message="Label excerpt unavailable" onRetry={load} />
      {label && (
        <div className="space-y-2 text-sm">
          <div className="flex flex-wrap items-center gap-x-2 text-xs text-slate-600">
            <span className="font-semibold text-slate-800">{label.drug}</span>
            <span>· section: {label.section}</span>
            <span>
              · fetched <Time iso={label.fetched_at} style="short" />
            </span>
            {label.source_url && (
              <a
                href={label.source_url}
                target="_blank"
                rel="noreferrer"
                className="text-brand-700 underline"
              >
                source
              </a>
            )}
          </div>
          <p className="text-xs italic text-slate-600">{label.note}</p>
          <div className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-3 font-mono text-xs leading-relaxed text-slate-800">
            {label.text}
          </div>
        </div>
      )}
    </Disclosure>
  );
}
