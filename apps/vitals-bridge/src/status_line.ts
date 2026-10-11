/**
 * The one-line status the CLI prints every 5 s. Format pinned by docs/CONTRACTS.md §3.4:
 *
 *   [bridge] source=mock scenario=resting state=collecting session=01J... elapsed=42s pulse=72(0.93) breathing=14(0.88) buffered=3 posted=40
 *
 * Kept in its own module so it can be unit-tested without spawning the CLI.
 */
import type { SourceName, SourceState } from './sources/types.js';

export interface StatusSnapshot {
  source: SourceName;
  scenario: string | null;
  state: SourceState;
  sessionId: string | null;
  elapsedS: number;
  pulse?: number;
  pulseConf?: number;
  breathing?: number;
  breathingConf?: number;
  buffered: number;
  posted: number;
}

function metric(value: number | undefined, conf: number | undefined): string {
  if (value === undefined) return '-';
  return `${Math.round(value)}(${(conf ?? 0).toFixed(2)})`;
}

export function formatStatusLine(s: StatusSnapshot): string {
  return (
    `[bridge] source=${s.source} scenario=${s.scenario ?? '-'} state=${s.state} ` +
    `session=${s.sessionId ?? 'none'} elapsed=${Math.floor(s.elapsedS)}s ` +
    `pulse=${metric(s.pulse, s.pulseConf)} breathing=${metric(s.breathing, s.breathingConf)} ` +
    `buffered=${s.buffered} posted=${s.posted}`
  );
}
