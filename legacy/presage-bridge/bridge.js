#!/usr/bin/env node
/*
 * presage-bridge: measure vitals with Presage SmartSpectra on THIS computer's webcam and send them
 * to the AE Capture Desk backend.
 *
 * Why this exists: SmartSpectra runs on-device (iOS / Android / C++ / Node-Electron). There is no
 * browser SDK and no cloud API for measurements. If the app is a web app, this little Node process
 * is the piece that talks to the camera. A native iOS/Android app can skip this and POST the same
 * JSON to the backend directly.
 *
 * Usage
 *   node bridge.js measure --checkin 12           measure, then POST /api/checkins/12/vitals
 *   node bridge.js measure --patient 3            measure, then POST /api/patients/3/vitals
 *   node bridge.js measure --checkin 12 --demo    no camera / API key needed: sends simulated metrics
 *   node bridge.js serve                          HTTP API on :8787 so a web frontend can trigger it:
 *       POST http://localhost:8787/measure  {"checkin_id": 12, "seconds": 45, "demo": false}
 *
 * Config (env vars or a .env file next to this script): PRESAGE_API_KEY, BACKEND_URL, SECONDS, BRIDGE_PORT
 *
 * Not a medical device. Vitals are supporting context for the research team, never a diagnosis.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

// --- tiny .env loader (no dependency) -------------------------------------------------------------
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const BACKEND_URL = (process.env.BACKEND_URL || 'http://localhost:8000').replace(/\/$/, '');
const DEFAULT_SECONDS = Number(process.env.SECONDS || 45);
const PORT = Number(process.env.BRIDGE_PORT || 8787);

// Keep payloads small: only the fields the backend summarizes.
function slim(metricsObj) {
  const out = {};
  const c = metricsObj.cardio || {};
  const b = metricsObj.breathing || {};
  if (c.pulseRate?.length || c.hrv?.length) out.cardio = { pulseRate: c.pulseRate || [], hrv: c.hrv || [] };
  if (b.rate?.length) out.breathing = { rate: b.rate };
  return out;
}

// --- real measurement -----------------------------------------------------------------------------
async function measureWithCamera(seconds, log = console.log) {
  const apiKey = process.env.PRESAGE_API_KEY;
  if (!apiKey) throw new Error('PRESAGE_API_KEY is not set (get one at https://physiology.presagetech.com), or use --demo');

  const { SmartSpectraSDK, CameraSelection, breathingMetrics, cardioMetrics, decodeMetrics } = require('@smartspectra/node-sdk');
  const { Metrics } = require('@smartspectra/node-sdk/messages');

  const sdk = new SmartSpectraSDK({ apiKey, requestedMetrics: [...breathingMetrics, ...cardioMetrics] });
  const collected = [];
  let lastHint = '';
  let fatal = null;

  sdk.on('metrics', (buf) => {
    const obj = Metrics.toObject(decodeMetrics(buf), { longs: Number });
    const s = slim(obj);
    if (s.cardio || s.breathing) collected.push(s);
  });
  sdk.on('validationStatus', (code, _ts, hint) => {
    if (code !== 0 && hint && hint !== lastHint) log(`  camera: ${hint}`); // e.g. "face not centered", "too dark"
    lastHint = code === 0 ? '' : hint;
  });
  sdk.on('error', (code, message, retryable) => {
    log(`  SmartSpectra error ${code}: ${message} (retryable=${retryable})`);
    if (!retryable) fatal = new Error(`SmartSpectra error ${code}: ${message}`);
  });

  log(`Measuring for ${seconds}s. Sit still, face the camera, good lighting, chest visible...`);
  sdk.useCamera(CameraSelection.default);
  sdk.start();
  await new Promise((r) => setTimeout(r, seconds * 1000));
  await sdk.stopAsync();
  await sdk.destroy();
  if (fatal && collected.length === 0) throw fatal;
  log(`Collected ${collected.length} metrics packets.`);
  return collected;
}

// --- simulated measurement (same protobuf round-trip, no camera) -----------------------------------
function simulatedMetrics(seconds, pulse = 76, breathing = 15) {
  let Metrics = null;
  try { ({ Metrics } = require('@smartspectra/node-sdk/messages')); } catch { /* SDK not installed: plain JSON */ }
  const t0 = Date.now() * 1000;
  const out = [];
  for (let i = 0; i < seconds; i++) {
    const ts = t0 + i * 1e6;
    const raw = {
      cardio: { pulseRate: [{ value: pulse + (Math.random() * 4 - 2), confidence: Math.min(95, 30 + i * 2.5), stable: i > 4, timestamp: ts }] },
      breathing: { rate: [{ value: breathing + (Math.random() * 2 - 1), confidence: i < 30 ? 0 : Math.min(90, 40 + (i - 30) * 3), stable: i >= 30, timestamp: ts }] },
    };
    if (Metrics) {
      const buf = Metrics.encode(Metrics.fromObject(raw)).finish();
      out.push(slim(Metrics.toObject(Metrics.decode(buf), { longs: Number })));
    } else {
      out.push(raw);
    }
  }
  return out;
}

// --- send to backend ------------------------------------------------------------------------------
async function sendToBackend({ checkinId, patientId, metrics }) {
  const url = checkinId ? `${BACKEND_URL}/api/checkins/${checkinId}/vitals` : `${BACKEND_URL}/api/patients/${patientId}/vitals`;
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ metrics }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Backend ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

async function measureAndSend({ checkinId, patientId, seconds, demo, pulse, breathing }, log = console.log) {
  if (!checkinId && !patientId) throw new Error('Need a check-in id or patient id');
  const metrics = demo ? simulatedMetrics(seconds, pulse, breathing) : await measureWithCamera(seconds, log);
  const reading = await sendToBackend({ checkinId, patientId, metrics });
  log(`Saved vitals reading #${reading.id}: pulse ${reading.pulse_bpm ?? '-'} bpm, breathing ${reading.breathing_bpm ?? '-'} /min`);
  for (const n of reading.quality_notes || []) log(`  note: ${n}`);
  return reading;
}

// --- CLI ------------------------------------------------------------------------------------------
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

function serve() {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.end();
    if (req.method === 'GET' && req.url === '/health') return res.end(JSON.stringify({ ok: true, backend: BACKEND_URL }));
    if (req.method !== 'POST' || req.url !== '/measure') { res.statusCode = 404; return res.end('{"error":"POST /measure"}'); }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    try {
      const b = raw ? JSON.parse(raw) : {};
      const reading = await measureAndSend({
        checkinId: b.checkin_id, patientId: b.patient_id, seconds: Number(b.seconds || DEFAULT_SECONDS),
        demo: Boolean(b.demo), pulse: b.pulse, breathing: b.breathing,
      });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(reading));
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(e.message || e) }));
    }
  });
  server.listen(PORT, () => console.log(`presage-bridge listening on http://localhost:${PORT}  (backend: ${BACKEND_URL})`));
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'serve') return serve();
  if (cmd === 'measure') {
    const opts = {
      checkinId: arg('checkin'), patientId: arg('patient'), seconds: Number(arg('seconds', DEFAULT_SECONDS)),
      demo: Boolean(arg('demo', false)), pulse: Number(arg('pulse', 76)), breathing: Number(arg('breathing', 15)),
    };
    await measureAndSend(opts);
    return;
  }
  console.log('Usage: node bridge.js measure --checkin <id> | --patient <id> [--seconds 45] [--demo [--pulse 104 --breathing 27]]');
  console.log('       node bridge.js serve');
  process.exitCode = 1;
}

if (require.main === module) {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}

module.exports = { measureAndSend, simulatedMetrics, slim };
