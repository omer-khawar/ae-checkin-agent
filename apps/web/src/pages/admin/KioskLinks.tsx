/**
 * Links that open the kiosk with a `?scenario=` preset (CLAUDE.md §7.2: the
 * query param overrides the saved mock scenario for that kiosk only). Opens in
 * a new tab so the admin page stays up during a demo.
 */
import { Link } from "react-router-dom";

import { Panel as Card } from "@/pages/admin/SysUI";
import { MeasuredBadge } from "../../components/MeasuredBadge";
import { MOCK_SCENARIOS } from "./tables";

export interface KioskLinksProps {
  /** The saved scenario, shown on the plain `/kiosk` link. */
  savedScenario: string | null;
}

export function KioskLinks({ savedScenario }: KioskLinksProps) {
  return (
    <Card title="Open the kiosk">
      <p className="text-table text-foreground">
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
            className="inline-flex min-h-11 items-center rounded-panel border border-primary bg-primary px-4 text-table font-semibold text-white hover:bg-primary-strong"
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
              className="inline-flex min-h-11 items-center rounded-panel border border-input bg-surface px-4 text-table font-medium text-foreground hover:bg-surface-subtle"
            >
              {sc.label}
              <code className="ml-2 font-mono text-caption text-muted-foreground">
                ?scenario={sc.id}
              </code>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
