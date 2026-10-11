import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatStatusLine } from '../src/status_line.js';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run the real CLI entrypoint through tsx (same path `npm run bridge` uses). */
function runCli(args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
      cwd: appDir,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('cli: fail-fast sources (exit code 2, before any port opens)', () => {
  it('--source presage without the SDK installed prints the install command and exits 2', async () => {
    // The SDK is never a dependency, so in CI (and on this machine) it is absent.
    const r = await runCli(['--source', 'presage', '--ws-port', '0'], { PRESAGE_API_KEY: 'k' });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('@smartspectra/node-sdk@3.4.0');
    expect(r.stderr).toContain('npm run install:presage');
    expect(r.stderr).toContain('--source mock');
    expect(r.stdout).not.toMatch(/ws:\/\//); // never got as far as listening
  });

  it('--source presage --list-cameras without the SDK exits 2 with the same hint', async () => {
    const r = await runCli(['--source', 'presage', '--list-cameras'], { PRESAGE_API_KEY: '' });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('npm run install:presage');
    expect(r.stderr).not.toContain('PRESAGE_API_KEY is not set'); // listing cameras needs no key
  });

  it('VITALS_SOURCE=arduino from the environment exits 2 too', async () => {
    const r = await runCli(['--ws-port', '0'], { VITALS_SOURCE: 'arduino' });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Arduino serial source not yet integrated');
  });

  it('an unknown source exits 2 with the known list', async () => {
    const r = await runCli(['--source', 'webcam']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/unknown vitals source "webcam"/);
  });

  it('a bad option exits 2 with usage', async () => {
    const r = await runCli(['--ws-port', 'lots']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--ws-port must be an integer/);
    expect(r.stderr).toMatch(/Usage:/);
  });
});

describe('cli: informational flags', () => {
  it('--help prints usage and exits 0', async () => {
    const r = await runCli(['--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Usage: npm run bridge/);
  });

  it('--version prints the package version', async () => {
    const r = await runCli(['--version']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('0.1.0');
  });

  it('--list-cameras lists the simulated camera for the mock source', async () => {
    const r = await runCli(['--source', 'mock', '--list-cameras']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/mock-0\tSimulated camera/);
  });
});

describe('formatStatusLine', () => {
  it('matches the CONTRACTS §3.4 format', () => {
    expect(
      formatStatusLine({
        source: 'mock',
        scenario: 'resting',
        state: 'collecting',
        sessionId: '01JABCDEFGHJKMNPQRSTVWXYZ0',
        elapsedS: 42.7,
        pulse: 72.4,
        pulseConf: 0.93,
        breathing: 14.2,
        breathingConf: 0.88,
        buffered: 3,
        posted: 40,
      }),
    ).toBe(
      '[bridge] source=mock scenario=resting state=collecting session=01JABCDEFGHJKMNPQRSTVWXYZ0 elapsed=42s pulse=72(0.93) breathing=14(0.88) buffered=3 posted=40',
    );
  });

  it('shows dashes while idle', () => {
    expect(
      formatStatusLine({
        source: 'mock',
        scenario: null,
        state: 'idle',
        sessionId: null,
        elapsedS: 0,
        buffered: 0,
        posted: 0,
      }),
    ).toBe(
      '[bridge] source=mock scenario=- state=idle session=none elapsed=0s pulse=- breathing=- buffered=0 posted=0',
    );
  });
});
