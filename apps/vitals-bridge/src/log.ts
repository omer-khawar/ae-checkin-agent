/**
 * Minimal logger. Every line is prefixed `[bridge]` so the three `make dev` processes are easy to
 * tell apart in one terminal. info/debug go to stdout, warn/error to stderr. No dependency, no
 * colours, no timestamps on the status line (its format is pinned by docs/CONTRACTS.md §3.4).
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  level?: LogLevel;
  /** Sink for stdout-level lines (info/debug). Default console.log. */
  out?: (line: string) => void;
  /** Sink for stderr-level lines (warn/error). Default console.error. */
  err?: (line: string) => void;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = ORDER[opts.level ?? 'info'];
  const out = opts.out ?? ((line: string) => console.log(line));
  const err = opts.err ?? ((line: string) => console.error(line));
  const enabled = (l: LogLevel): boolean => ORDER[l] >= level;
  return {
    debug: (m) => {
      if (enabled('debug')) out(`[bridge] DEBUG ${m}`);
    },
    info: (m) => {
      if (enabled('info')) out(`[bridge] ${m}`);
    },
    warn: (m) => {
      if (enabled('warn')) err(`[bridge] WARN ${m}`);
    },
    error: (m) => {
      if (enabled('error')) err(`[bridge] ERROR ${m}`);
    },
  };
}

/** Logger that discards everything; used by tests and as a safe default in library classes. */
export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
