/**
 * /admin — hidden operator panel (CLAUDE.md §3.1 admin, §3.7.7; CONTRACTS §2.2).
 *
 * Admin role only. The route is already wrapped in <RequireRole roles={["admin"]}>;
 * the page re-checks the role itself so it stays safe if the route table changes
 * (the API enforces the role server-side on PUT/POST regardless).
 *
 * Sections: vitals settings (source, mock scenario, simulated-as-measured),
 * health (API + public settings + bridge WebSocket), kiosk links with
 * `?scenario=` presets, and the demo reset with an in-page confirmation.
 */
import { useCallback, useState } from "react";
import { Link } from "react-router-dom";

import { PageHead } from "./admin/SysUI";
import { ErrorBanner } from "../components/ErrorBanner";
import { getAdminSettings } from "../lib/api";
import { ROLE_LABELS, useAuth } from "../lib/auth";
import { useBridge } from "../lib/bridge";
import type { Settings } from "../lib/types";
import { HealthPanel } from "./admin/HealthPanel";
import { KioskLinks } from "./admin/KioskLinks";
import { ResetPanel } from "./admin/ResetPanel";
import { SettingsForm } from "./admin/SettingsForm";
import { useLoad } from "./admin/useLoad";

export function Admin() {
  const { role } = useAuth();
  if (role !== "admin") {
    return (
      <div className="mx-auto max-w-lg py-16 text-center">
        <h1 className="text-page font-semibold text-foreground">Admin only (403)</h1>
        <p className="mt-2 text-muted-foreground">
          You are signed in as <strong>{role ? ROLE_LABELS[role] : "nobody"}</strong>. This page
          needs the {ROLE_LABELS.admin} role; the API refuses settings changes from other roles too.
        </p>
        <p className="mt-6">
          <Link to="/dashboard" className="text-primary underline">
            Back to the dashboard
          </Link>
        </p>
      </div>
    );
  }
  return <AdminPanel />;
}

/** A PUT's response, remembered together with the GET object it supersedes. */
interface SavedOverlay {
  data: Settings;
  /** The `settings.data` identity at the time of the PUT. */
  base: Settings | null;
}

function AdminPanel() {
  const settings = useLoad<Settings>(getAdminSettings);
  // A PUT's response replaces the form's baseline without a refetch. It is
  // keyed to the GET object it was layered over: once a reload (after a reset)
  // delivers a new object the overlay is ignored automatically, so there is no
  // window where the form briefly shows the pre-save GET while the fresh one
  // is in flight (the stale overlay stays in effect until the new GET lands).
  const [saved, setSaved] = useState<SavedOverlay | null>(null);
  const current = saved && saved.base === settings.data ? saved.data : settings.data;
  const [refreshKey, setRefreshKey] = useState(0);

  // Only the admin page talks to the bridge outside a check-in: it never sends
  // `start`, so it cannot capture anything; it only reads hello/status and may
  // push `set_scenario`.
  const bridge = useBridge();

  const { reload: reloadSettings, data: settingsData } = settings;
  const handleSaved = useCallback(
    (next: Settings) => setSaved({ data: next, base: settingsData }),
    [settingsData],
  );
  const handleReset = useCallback(() => {
    reloadSettings();
    setRefreshKey((k) => k + 1);
  }, [reloadSettings]);

  return (
    <div className="space-y-4">
      <PageHead
        title="Admin"
        actions={
          <Link to="/admin/outbox" className="text-table text-primary underline underline-offset-2">
            Participant texts (outbox)
          </Link>
        }
      >
        Operator controls for the demo. Every change here is an audited event; none of it touches a
        provisional grade. The persona evaluation (CLAUDE.md §8) runs from the{" "}
        <Link to="/dashboard/eval" className="text-primary underline underline-offset-2">
          Eval page
        </Link>
        , where a judge can also edit a persona and watch the outputs change.
      </PageHead>

      {settings.error ? (
        <ErrorBanner
          error={settings.error}
          message="Could not load settings"
          onRetry={settings.reload}
        />
      ) : current ? (
        <SettingsForm
          saved={current}
          onSaved={handleSaved}
          notifyBridgeScenario={bridge.setScenario}
        />
      ) : (
        <p className="text-table text-muted-foreground" role="status">
          Loading settings…
        </p>
      )}

      <HealthPanel bridge={bridge} saved={current} refreshKey={refreshKey} />

      <KioskLinks savedScenario={current ? String(current.mock_scenario) : null} />

      <ResetPanel onReset={handleReset} />
    </div>
  );
}
