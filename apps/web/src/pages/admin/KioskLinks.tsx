/**
 * Links that open the kiosk with a `?scenario=` preset (CLAUDE.md §7.2: the
 * query param overrides the saved mock scenario for that kiosk only). Opens in
 * a new tab so the admin page stays up during a demo.
 */
import { Link } from "react-router-dom";

import { Card } from "../../components/Card";
import { MeasuredBadge } from "../../components/MeasuredBadge";
import { MOCK_SCENARIOS } from "./tables";

export interface KioskLinksProps {
  /** The saved scenario, shown on the plain `/kiosk` link. */
  savedScenario: string | null;
}

export function KioskLinks({ savedScenario }: KioskLinksProps) {
  return (
    <Card title="Open the kiosk">
      <p className="text-sm text-slate-700">
        Each link starts a kiosk with the mock scenario pinned by{" "}
        <code className="font-mono">?scenario=</code>; only that kiosk is affected and every sample
        stays <MeasuredBadge isMeasured={false} />.
      </p>
      <ul className="mt-3 flex flex-wrap gap-2">
        <li>
          <Link
            to="/kiosk"
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-11 items-center rounded-xl border border-brand-800 bg-brand-700 px-4 text-sm font-semibold text-white hover:bg-brand-800"
          >
            Kiosk (saved scenario{savedScenario ? `: ${savedScenario}` : ""})
          </Link>
        </li>
        {MOCK_SCENARIOS.map((sc) => (
          <li key={sc.id}>
            <Link
              to={`/kiosk?scenario=${encodeURIComponent(sc.id)}`}
              target="_blank"
              rel="noreferrer"
              title={sc.physiology}
              className="inline-flex min-h-11 items-center rounded-xl border border-slate-300 bg-white px-4 text-sm font-medium text-slate-900 hover:bg-slate-100"
            >
              {sc.label}
              <code className="ml-2 font-mono text-xs text-slate-500">?scenario={sc.id}</code>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
