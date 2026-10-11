/**
 * Bridge version, read from package.json so the `hello` WS message and the CLI banner can never
 * drift from what is published (docs/CONTRACTS.md §7: INTERIM_VERSION is read from package.json
 * by the bridge and the web app).
 */
import { readFileSync } from 'node:fs';

function readVersion(): string {
  try {
    // Works from both src/ (tsx) and dist/ (node): package.json is one level up from either.
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const pkg = JSON.parse(raw) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const BRIDGE_VERSION: string = readVersion();
