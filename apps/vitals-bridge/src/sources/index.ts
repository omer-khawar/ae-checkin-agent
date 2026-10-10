/**
 * Source factory. `createSource(name)` is the only place the bridge decides which plugin runs.
 *
 * Fail-fast policy (CLAUDE.md §7.3): a stubbed source (presage, arduino) is constructed, then
 * refused with its own NotImplemented message plus a hint to switch to mock. An unknown name is
 * refused the same way. The CLI maps both to exit code 2 before opening any port.
 */
import { ArduinoVitalsSource } from './arduino.js';
import { MockVitalsSource, type MockOptions } from './mock.js';
import { PresageVitalsSource } from './presage.js';
import {
  isSourceName,
  isStubbed,
  NotImplementedError,
  SOURCE_NAMES,
  type SourceName,
  type VitalsSource,
} from './types.js';

export const SWITCH_TO_MOCK_HINT =
  'Switch to the mock source: --source mock (or VITALS_SOURCE=mock).';

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
}

function construct(name: SourceName, opts: CreateSourceOptions): VitalsSource {
  switch (name) {
    case 'mock':
      return new MockVitalsSource(opts.mock);
    case 'presage':
      return new PresageVitalsSource();
    case 'arduino':
      return new ArduinoVitalsSource();
  }
}

/**
 * Build the requested source or throw:
 *  - UnknownSourceError for a name outside mock | presage | arduino,
 *  - NotImplementedError (with the stub message + the switch-to-mock hint) for a stub.
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
