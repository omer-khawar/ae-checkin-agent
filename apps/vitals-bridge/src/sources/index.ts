/**
 * Source factory. `createSource(name)` is the only place the bridge decides which plugin runs.
 *
 * Fail-fast policy (CLAUDE.md §7.3/§7.4):
 *  - a stubbed source (arduino) is constructed, then refused with its own NotImplemented message
 *    plus a hint to switch to mock; an unknown name is refused the same way;
 *  - a real source that needs something outside the repo (presage: the native SDK and an API
 *    key) is handed out here and verified by the CLI through `preflight()` before any port opens.
 * The CLI maps all three to exit code 2.
 */
import { ArduinoVitalsSource } from './arduino.js';
import { MockVitalsSource, type MockOptions } from './mock.js';
import { PresageVitalsSource, type PresageOptions } from './presage.js';
import {
  isSourceName,
  isStubbed,
  NotImplementedError,
  SOURCE_NAMES,
  SWITCH_TO_MOCK_HINT,
  type SourceName,
  type VitalsSource,
} from './types.js';

export class UnknownSourceError extends Error {
  override readonly name = 'UnknownSourceError';
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface CreateSourceOptions {
  /** Options forwarded to the mock source (seed, pacing); ignored for other sources. */
  mock?: MockOptions;
  /** Options forwarded to the Presage source (api key, camera, logger); ignored for other sources. */
  presage?: PresageOptions;
}

function construct(name: SourceName, opts: CreateSourceOptions): VitalsSource {
  switch (name) {
    case 'mock':
      return new MockVitalsSource(opts.mock);
    case 'presage':
      return new PresageVitalsSource(opts.presage);
    case 'arduino':
      return new ArduinoVitalsSource();
  }
}

/**
 * Build the requested source or throw:
 *  - UnknownSourceError for a name outside mock | presage | arduino,
 *  - NotImplementedError (with the stub message + the switch-to-mock hint) for a stub.
 * A Presage source is returned without touching the SDK; call `preflight()` to verify it.
 */
export function createSource(name: string, opts: CreateSourceOptions = {}): VitalsSource {
  if (!isSourceName(name)) {
    throw new UnknownSourceError(
      `unknown vitals source "${name}" (known: ${SOURCE_NAMES.join(', ')}). ${SWITCH_TO_MOCK_HINT}`,
    );
  }
  const source = construct(name, opts);
  if (isStubbed(source)) {
    throw new NotImplementedError(`${source.notImplementedMessage}. ${SWITCH_TO_MOCK_HINT}`);
  }
  return source;
}

export { MockVitalsSource, PresageVitalsSource, ArduinoVitalsSource };
export * from './types.js';
export * from './scenarios.js';
export * from './presageMap.js';
