/**
 * Health panel: API (`GET /health`), the public settings the kiosk and bridge
 * read (`GET /settings/public`), and the bridge WebSocket (hello / status via
 * `useBridge`). Nothing here is derived clinically; it is plumbing status so
 * an operator can see, before a demo, that every process is up and agrees on
 * the source and scenario.
 *
 * The two API calls are loaded independently: a failing `/settings/public`
 * (e.g. the rules table failed to load) must not hide a healthy `/health`,
 * or the operator would restart an API that answered fine.
 */
import { useCallback, useEffect, useRef } from "react";

import { Button } from "@/pages/admin/SysUI";
import { Panel as Card } from "@/pages/admin/SysUI";
import { ErrorBanner } from "../../components/ErrorBanner";
import { MeasuredBadge } from "../../components/MeasuredBadge";
import { getHealth, getPublicSettings } from "../../lib/api";
import type { UseBridge } from "../../lib/bridge";
import { cx, formatConfidence, Time } from "../../lib/format";
import type { Health, PublicSettings, Settings } from "../../lib/types";
import { scenarioRow, sourceRow } from "./tables";
import { useLoad } from "./useLoad";

export interface HealthPanelProps {
  bridge: UseBridge;
  /** The saved admin settings, to flag a bridge running a different source/scenario. */
  saved: Settings | null;
  /** Bumped by the parent after a reset so the panel refetches. */
  refreshKey?: number;
}

export function HealthPanel({ bridge, saved, refreshKey = 0 }: HealthPanelProps) {
  const health = useLoad<Health>(getHealth);
  const pub = useLoad<PublicSettings>(getPublicSettings);
  const loading = health.loading || pub.loading;
  const { reload: reloadHealth } = health;
  const { reload: reloadPub } = pub;
  const reload = useCallback(() => {
    reloadHealth();
    reloadPub();
  }, [reloadHealth, reloadPub]);

  // A parent bump of refreshKey (after a reset) refetches. The mount load is
  // already done by useLoad, so only a *change* of the key reloads: comparing
  // against the last seen key (rather than a first-run flag) keeps React 18
  // StrictMode's double effect invocation in dev from fetching twice.
  const lastKey = useRef(refreshKey);
  useEffect(() => {
    if (lastKey.current === refreshKey) return;
    lastKey.current = refreshKey;
    reload();
  }, [refreshKey, reload]);

  const hello = bridge.hello;
  const bridgeSource = hello ? sourceRow(hello.source) : undefined;
  const sourceMismatch =
    hello !== null && saved !== null && String(saved.vitals_source) !== hello.source;
  const scenarioMismatch =
    hello !== null &&
    hello.scenario !== null &&
    saved !== null &&
    String(saved.mock_scenario) !== hello.scenario;

  return (
    <Card
      title="Health"
      aside={
        <Button size="sm" variant="secondary" onClick={reload} busy={loading}>
          Refresh
        </Button>
      }
    >
      <div className="grid gap-4 md:grid-cols-2">
        {/* ---- API ------------------------------------------------------- */}
        <section aria-labelledby="health-api">
          <h3 id="health-api" className="text-table font-semibold text-foreground">
            API
          </h3>
          <ErrorBanner
            error={health.error}
            message="API unreachable (GET /health failed)"
            onRetry={health.reload}
            className="mt-2"
          />
          {!health.error && (
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-table">
              <dt className="text-muted-foreground">Status</dt>
              <dd className="flex items-center gap-2">
                <Dot ok={health.data?.status === "ok"} />
                {health.loading && !health.data ? "Checking…" : (health.data?.status ?? "—")}
              </dd>
              <dt className="text-muted-foreground">Version</dt>
              <dd className="font-mono">{health.data?.version ?? "—"}</dd>
              <dt className="text-muted-foreground">Server time</dt>
              <dd>
                <Time iso={health.data?.time_utc} />
                <span className="ml-1 text-caption text-muted-foreground">(UTC on hover)</span>
              </dd>
              <dt className="text-muted-foreground">Database</dt>
              <dd className="font-mono">{health.data?.db ?? "—"}</dd>
              <dt className="text-muted-foreground">Env vitals source</dt>
              <dd>
                <SourceValue source={health.data?.vitals_source} />
              </dd>
            </dl>
          )}

          <h3 className="mt-4 text-table font-semibold text-foreground">
            Public settings (what the kiosk and bridge read)
          </h3>
          <ErrorBanner
            error={pub.error}
            message="Public settings unavailable (GET /settings/public failed)"
            onRetry={pub.reload}
            className="mt-2"
          />
          {pub.data ? (
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-table">
              <dt className="text-muted-foreground">vitals_source</dt>
              <dd>
                <SourceValue source={pub.data.vitals_source} />
              </dd>
              <dt className="text-muted-foreground">mock_scenario</dt>
              <dd className="font-mono">{pub.data.mock_scenario}</dd>
              <dt className="text-muted-foreground">simulated_as_measured</dt>
              <dd className={cx("font-mono", pub.data.simulated_as_measured && "text-warning-fg")}>
                {String(pub.data.simulated_as_measured)}
              </dd>
              <dt className="text-muted-foreground">min_confidence</dt>
              <dd className="font-mono">{formatConfidence(pub.data.min_confidence)}</dd>
              <dt className="text-muted-foreground">timing gates</dt>
              <dd className="font-mono">
                pulse {pub.data.timing_gates?.pulse_s ?? "—"} s · breathing{" "}
                {pub.data.timing_gates?.breathing_s ?? "—"} s · HRV{" "}
                {pub.data.timing_gates?.hrv_s ?? "—"} s
              </dd>
            </dl>
          ) : (
            !pub.error && <p className="mt-2 text-table text-muted-foreground">Loading…</p>
          )}
        </section>

        {/* ---- Bridge ---------------------------------------------------- */}
        <section aria-labelledby="health-bridge">
          <h3 id="health-bridge" className="text-table font-semibold text-foreground">
            Vitals bridge (WebSocket)
          </h3>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-table">
            <dt className="text-muted-foreground">Socket</dt>
            <dd className="flex items-center gap-2" data-testid="bridge-connection">
              <Dot ok={bridge.connected} />
              {bridge.connected
                ? "Connected"
                : `Disconnected${bridge.reconnectAttempts > 0 ? ` (retrying, attempt ${bridge.reconnectAttempts})` : ""}`}
            </dd>
            <dt className="text-muted-foreground">URL</dt>
            <dd className="font-mono text-caption">{bridge.client?.url ?? "—"}</dd>
            <dt className="text-muted-foreground">Source</dt>
            <dd className="flex flex-wrap items-center gap-2">
              {hello ? (
                <>
                  <MeasuredBadge isMeasured={hello.isMeasured} source={hello.source} />
                  <span className="text-caption text-muted-foreground">
                    {bridgeSource?.label ?? hello.source}
                  </span>
                </>
              ) : (
                <span className="text-muted-foreground">
                  {bridge.connected ? "Waiting for hello…" : "—"}
                </span>
              )}
            </dd>
            <dt className="text-muted-foreground">Scenario</dt>
            <dd className="font-mono">
              {hello?.scenario ?? "—"}
              {hello?.scenario && scenarioRow(hello.scenario) && (
                <span className="ml-2 font-sans text-caption text-muted-foreground">
                  {scenarioRow(hello.scenario)?.physiology}
                </span>
              )}
            </dd>
            <dt className="text-muted-foreground">State</dt>
            <dd className="font-mono">
              {bridge.state}
              {bridge.sessionId && (
                <span className="ml-2 font-sans text-caption text-muted-foreground">
                  session {bridge.sessionId}
                </span>
              )}
            </dd>
            <dt className="text-muted-foreground">Bridge version</dt>
            <dd className="font-mono">{hello?.version ?? "—"}</dd>
            <dt className="text-muted-foreground">Bridge min conf</dt>
            <dd className="font-mono">{hello ? formatConfidence(hello.minConf) : "—"}</dd>
          </dl>
          {bridge.lastError && (
            <p className="mt-2 text-table text-danger-fg" role="status">
              Last bridge error: {bridge.lastError}
            </p>
          )}
          {sourceMismatch && (
            <p
              className="mt-2 rounded-control border border-warning-border bg-warning-bg px-3 py-2 text-caption text-warning-fg"
              role="status"
            >
              The running bridge uses source <code className="font-mono">{hello?.source}</code> but
              the saved setting is <code className="font-mono">{String(saved?.vitals_source)}</code>
              . Restart the bridge process to apply the saved source.
            </p>
          )}
          {scenarioMismatch && !sourceMismatch && (
            <p className="mt-2 text-caption text-muted-foreground" role="status">
              The bridge announced scenario <code className="font-mono">{hello?.scenario}</code>;
              the saved scenario <code className="font-mono">{String(saved?.mock_scenario)}</code>{" "}
              applies on its next start.
            </p>
          )}
          {!bridge.connected && (
            <p className="mt-2 text-caption text-muted-foreground">
              Start it with <code className="font-mono">npm run bridge -- --source mock</code> in{" "}
              <code className="font-mono">apps/vitals-bridge</code>. The check-in works without it;
              records are then flagged vitals unavailable.
            </p>
          )}
        </section>
      </div>
    </Card>
  );
}

/**
 * A configured vitals source name with its MEASURED/SIMULATED badge (CLAUDE.md
 * §13: the word "simulated" appears next to anything simulated, every time).
 * An unknown name (not one of the three adapter slots) is printed plain, with a
 * note, rather than guessing which way it measures.
 */
function SourceValue({ source }: { source: string | null | undefined }) {
  if (!source) return <span className="font-mono">—</span>;
  const row = sourceRow(source);
  if (!row) {
    return (
      <span className="flex flex-wrap items-center gap-2">
        <span className="font-mono">{source}</span>
        <span className="text-caption text-muted-foreground">
          (unknown source; not an adapter slot)
        </span>
      </span>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      <MeasuredBadge isMeasured={row.isMeasured} source={source} />
      <span className="text-caption text-muted-foreground">{row.label}</span>
    </span>
  );
}

function Dot({ ok }: { ok: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cx("inline-block h-2.5 w-2.5 rounded-full", ok ? "bg-success-fg" : "bg-subtle-foreground")}
    />
  );
}
