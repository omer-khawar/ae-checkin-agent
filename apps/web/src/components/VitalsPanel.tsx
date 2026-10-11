/**
 * The small, calm vitals card shown on the kiosk while a check-in runs with
 * the camera on (CLAUDE.md §3.3). It renders whatever the bridge publishes and
 * never computes anything clinical.
 *
 * Per-metric slot (see `metricSlot()` in lib/vitals.ts):
 *   - the number, once the bridge's `published.<metric>` flag is true and the
 *     confidence is >= `minConf` with no `low_conf_<metric>` flag;
 *   - "collecting…" while the timing gate is pending or the signal is weak;
 *   - "not available" once the gate has elapsed and the source has no value for
 *     that metric (e.g. a source without HRV).
 *
 * Header dot (see `signalQuality()`): judged only from published metrics, so
 * the first 12 s of every session read "Collecting", not "Signal is weak".
 *
 * "Vitals unavailable, continuing without them" is shown when the socket is
 * down, the source reports `error`, the bridge is idle with no session to
 * capture, or `captureLost` (bridge up but not capturing this session). The
 * check-in never depends on the card.
 */
import type { BridgeSnapshot, UseBridge } from "../lib/bridge";
import { cx, formatConfidence, formatElapsed, formatVital } from "../lib/format";
import {
  FALLBACK_MIN_CONF,
  lowConfFlag,
  metricSlot,
  QUALITY_TEXT,
  signalQuality,
  type MetricKey,
} from "../lib/vitals";
import { MeasuredBadge } from "./MeasuredBadge";

export interface VitalsPanelProps {
  bridge: Pick<
    BridgeSnapshot,
    | "connected"
    | "hello"
    | "state"
    | "status"
    | "sample"
    | "published"
    | "elapsedS"
    | "waveform"
    | "lastError"
  > &
    Partial<Pick<UseBridge, "activeSessionId" | "captureLost">>;
  /** Confidence threshold; defaults to the bridge's hello.minConf, then 0.6. */
  minConf?: number;
  /** Show the raw confidence and flags (dashboard/admin); the kiosk keeps it calm. */
  verbose?: boolean;
  className?: string;
}

export const UNAVAILABLE_TEXT = "Vitals unavailable, continuing without them";

interface MetricView {
  key: MetricKey;
  label: string;
  unit: string;
  value: number | undefined;
  conf: number | undefined;
  published: boolean;
  gateS: number;
  decimals: number;
}

export function VitalsPanel({ bridge, minConf, verbose, className }: VitalsPanelProps) {
  const threshold = minConf ?? bridge.hello?.minConf ?? FALLBACK_MIN_CONF;
  const sample = bridge.sample;
  const flags = sample?.qualityFlags ?? [];
  const activeSessionId = bridge.activeSessionId ?? null;
  const idleWithNothingToCapture = bridge.state === "idle" && activeSessionId === null;
  const unavailable =
    !bridge.connected ||
    bridge.state === "error" ||
    bridge.state === "disconnected" ||
    bridge.captureLost === true ||
    idleWithNothingToCapture;
  const isMeasured = sample?.isMeasured ?? bridge.hello?.isMeasured ?? false;
  const sourceName = sample?.source ?? bridge.hello?.source ?? null;
  // Timing gates come from the bridge's hello (parseBridgeMessage fills the
  // contract defaults when a hello omits them); nothing clinical is decided here.
  const gates = bridge.hello?.gates ?? { pulseS: 12, breathingS: 30, hrvS: 60 };

  const metrics: MetricView[] = [
    {
      key: "pulse",
      label: "Pulse",
      unit: "beats/min",
      value: sample?.pulseBpm,
      conf: sample?.pulseConf,
      published: bridge.published.pulse,
      gateS: gates.pulseS,
      decimals: 0,
    },
    {
      key: "breathing",
      label: "Breathing",
      unit: "breaths/min",
      value: sample?.breathingBpm,
      conf: sample?.breathingConf,
      published: bridge.published.breathing,
      gateS: gates.breathingS,
      decimals: 0,
    },
    {
      key: "hrv",
      label: "HRV (RMSSD)",
      unit: "ms",
      value: sample?.hrvRmssdMs,
      conf: sample?.hrvConf,
      published: bridge.published.hrv,
      gateS: gates.hrvS,
      decimals: 0,
    },
  ];

  const quality = signalQuality(
    {
      unavailable,
      hasSample: sample !== null,
      flags,
      publishedConfs: metrics.filter((m) => m.published).map((m) => m.conf),
      lowConfPublished: metrics.some(
        (m) => m.value !== undefined && flags.includes(lowConfFlag(m.key)),
      ),
    },
    threshold,
  );
  const qualityText = QUALITY_TEXT[quality];

  const statusLine =
    bridge.state === "collecting" || bridge.state === "warming"
      ? `Capturing ${formatElapsed(bridge.elapsedS)}`
      : activeSessionId !== null
        ? "Starting…"
        : "Ready";

  return (
    <aside
      className={cx("rounded-2xl border border-slate-200 bg-white p-4 shadow-card", className)}
      aria-label="Vitals"
      data-testid="vitals-panel"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            className={cx(
              "inline-block h-2.5 w-2.5 rounded-full",
              quality === "good" && "bg-green-500",
              quality === "degraded" && "bg-amber-500",
              quality === "collecting" && "bg-brand-400",
              quality === "unavailable" && "bg-slate-400",
            )}
            aria-hidden="true"
          />
          <span className="text-sm font-medium text-slate-700" data-testid="vitals-quality">
            {qualityText}
          </span>
        </div>
        <MeasuredBadge isMeasured={isMeasured} source={sourceName} />
      </div>

      {unavailable ? (
        <p className="mt-3 text-base text-slate-700" role="status">
          {UNAVAILABLE_TEXT}
        </p>
      ) : (
        <>
          <dl className="mt-3 grid grid-cols-3 gap-3">
            {metrics.map((m) => {
              const slot = metricSlot(
                {
                  metric: m.key,
                  value: m.value,
                  conf: m.conf,
                  published: m.published,
                  elapsedS: bridge.elapsedS,
                  gateS: m.gateS,
                },
                threshold,
                flags,
              );
              return (
                <div key={m.key} className="min-w-0" data-testid={`vital-${m.key}`}>
                  <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
                    {m.label}
                  </dt>
                  <dd className="mt-0.5">
                    {slot === "value" ? (
                      <>
                        <span className="tnum text-2xl font-semibold text-slate-900">
                          {formatVital(m.value, m.decimals)}
                        </span>
                        <span className="ml-1 text-xs text-slate-500">{m.unit}</span>
                      </>
                    ) : slot === "not_available" ? (
                      <span className="text-base text-slate-500">not available</span>
                    ) : (
                      <span className="text-base text-slate-500">collecting…</span>
                    )}
                    {verbose && (
                      <div className="tnum mt-0.5 text-[11px] text-slate-500">
                        conf {formatConfidence(m.conf)}
                      </div>
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>

          <Sparkline values={bridge.waveform} />

          <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
            <span className="tnum">{statusLine}</span>
            {verbose && flags.length > 0 && <span className="font-mono">{flags.join(" ")}</span>}
          </div>
        </>
      )}
    </aside>
  );
}

/** Tiny inline-SVG pleth trace; no charting library on the kiosk bundle. */
export function Sparkline({
  values,
  width = 240,
  height = 36,
}: {
  values: number[];
  width?: number;
  height?: number;
}) {
  if (values.length < 2) {
    return <div className="mt-3 h-9 rounded bg-slate-50" aria-hidden="true" />;
  }
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min || 1;
  const step = width / (values.length - 1);
  const points = values
    .map(
      (v, i) =>
        `${(i * step).toFixed(1)},${(height - ((v - min) / span) * (height - 4) - 2).toFixed(1)}`,
    )
    .join(" ");
  return (
    <svg
      className="mt-3 h-9 w-full text-brand-600"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      data-testid="pleth-sparkline"
    >
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        points={points}
      />
    </svg>
  );
}
