import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULTS, parseArgs, parseOriginList, USAGE } from '../src/config.js';

describe('parseArgs', () => {
  it('applies the documented defaults (loopback bind, threshold not pinned, any origin)', () => {
    expect(parseArgs([])).toEqual({
      source: 'mock',
      scenario: 'resting',
      apiBase: 'http://localhost:8000',
      wsPort: 8787,
      wsHost: '127.0.0.1',
      minConf: 0.6,
      minConfExplicit: false,
      token: undefined,
      allowedOrigins: [],
      listCameras: false,
      session: null,
      help: false,
      version: false,
    });
  });

  it('marks --min-conf / VITALS_MIN_CONF as pinned only when actually given', () => {
    expect(parseArgs(['--min-conf', '0.6']).minConfExplicit).toBe(true);
    expect(parseArgs([], { VITALS_MIN_CONF: '0.6' }).minConfExplicit).toBe(true);
    expect(parseArgs([], { VITALS_MIN_CONF: '  ' }).minConfExplicit).toBe(false);
  });

  it('reads the origin allow-list from the flag or BRIDGE_ALLOWED_ORIGINS', () => {
    expect(
      parseArgs(['--allowed-origins', 'http://localhost:5173, http://Kiosk.local/']).allowedOrigins,
    ).toEqual(['http://localhost:5173', 'http://kiosk.local']);
    expect(parseArgs([], { BRIDGE_ALLOWED_ORIGINS: 'http://a' }).allowedOrigins).toEqual([
      'http://a',
    ]);
    expect(parseOriginList(undefined)).toEqual([]);
    expect(parseOriginList(' , ')).toEqual([]);
  });

  it('reads the CONTRACTS §3.4 flags, both "--k v" and "--k=v"', () => {
    const cfg = parseArgs([
      '--source',
      'mock',
      '--scenario=post_exercise',
      '--api',
      'http://10.0.0.5:8000/',
      '--ws-port=9000',
      '--min-conf',
      '0.75',
      '--token',
      'abc',
      '--session',
      '01HZZ',
      '--list-cameras',
    ]);
    expect(cfg.source).toBe('mock');
    expect(cfg.scenario).toBe('post_exercise');
    expect(cfg.apiBase).toBe('http://10.0.0.5:8000'); // trailing slash stripped
    expect(cfg.wsPort).toBe(9000);
    expect(cfg.minConf).toBe(0.75);
    expect(cfg.token).toBe('abc');
    expect(cfg.session).toBe('01HZZ');
    expect(cfg.listCameras).toBe(true);
  });

  it('falls back to environment variables, and flags beat env', () => {
    const env = {
      VITALS_SOURCE: 'presage',
      VITALS_SCENARIO: 'dropout',
      BRIDGE_API_URL: 'http://api:8000',
      BRIDGE_WS_PORT: '8800',
      BRIDGE_WS_HOST: '127.0.0.1',
      VITALS_MIN_CONF: '0.5',
      BRIDGE_TOKEN: 'tok',
    };
    const fromEnv = parseArgs([], env);
    expect(fromEnv).toMatchObject({
      source: 'presage',
      scenario: 'dropout',
      apiBase: 'http://api:8000',
      wsPort: 8800,
      wsHost: '127.0.0.1',
      minConf: 0.5,
      token: 'tok',
    });
    const mixed = parseArgs(['--source', 'mock', '--ws-port', '1234'], env);
    expect(mixed.source).toBe('mock');
    expect(mixed.wsPort).toBe(1234);
    expect(mixed.scenario).toBe('dropout');
  });

  it('treats an empty env var as unset', () => {
    expect(parseArgs([], { BRIDGE_TOKEN: '', VITALS_SCENARIO: '  ' })).toMatchObject({
      token: undefined,
      scenario: DEFAULTS.scenario,
    });
  });

  it('lower-cases the source name', () => {
    expect(parseArgs(['--source', 'Mock']).source).toBe('mock');
  });

  it('validates the mock scenario but ignores it for other sources', () => {
    expect(() => parseArgs(['--scenario', 'sprint'])).toThrow(ConfigError);
    expect(() => parseArgs(['--scenario', 'sprint'])).toThrow(/known: resting, post_exercise/);
    expect(parseArgs(['--source', 'presage', '--scenario', 'sprint']).scenario).toBe('sprint');
  });

  it('rejects bad ports, confidences and URLs', () => {
    expect(() => parseArgs(['--ws-port', '70000'])).toThrow(/0\.\.65535/);
    expect(() => parseArgs(['--ws-port', 'abc'])).toThrow(ConfigError);
    expect(() => parseArgs(['--min-conf', '1.5'])).toThrow(/0\.\.1/);
    expect(() => parseArgs(['--min-conf', 'high'])).toThrow(ConfigError);
    expect(() => parseArgs(['--api', 'localhost:8000'])).toThrow(/http\(s\) URL/);
    expect(() => parseArgs([], { BRIDGE_WS_PORT: '-1' })).toThrow(ConfigError);
  });

  it('rejects unknown options, stray positionals and missing values', () => {
    expect(() => parseArgs(['--colour', 'red'])).toThrow(/unknown option --colour/);
    expect(() => parseArgs(['resting'])).toThrow(/unexpected argument/);
    expect(() => parseArgs(['--source'])).toThrow(/--source needs a value/);
    expect(() => parseArgs(['--api', '--ws-port', '1'])).toThrow(/--api needs a value/);
  });

  it('recognises help and version in long and short form', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
    expect(parseArgs(['--version']).version).toBe(true);
    expect(parseArgs(['-V']).version).toBe(true);
    expect(USAGE).toMatch(/--source <mock\|presage\|arduino>/);
    expect(USAGE).toMatch(/Exit codes: 0 ok, 1 fatal/);
  });
});
