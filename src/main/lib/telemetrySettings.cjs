/**
 * telemetrySettings — persists product-telemetry consent/config + install identity.
 *
 * Storage: ~/.config/session-manager/telemetry.json
 * Shape: {
 *   enabled: boolean,                // ON by default — hard kill switch is SM_TELEMETRY=0
 *   installId: string,               // crypto.randomUUID(), minted once, the only identity
 *   endpoint: string,                // bilko.run ingest base URL
 *   noticeAckedAt: string|null,      // ISO timestamp the first-run disclosure was shown
 *   lastMachineReportAt: string|null,
 *   lastMachineReportVersion: string,
 *   lastDailyFlushAt: string|null,
 *   schemaVersion: 1
 * }
 *
 * Modeled directly on ../otelSettings.cjs — same atomic tmp+rename write via config.cjs,
 * same schemaVersion + isValid() + frozen DEFAULTS shape. Deliberately has NO identity
 * field beyond installId — no email, no username, no hostname. isValid() rejects any
 * unknown key so a future accidental PII field can never silently round-trip through load/save.
 *
 * This module is pure data plumbing: no network code, no call sites. Later PRDs consume it.
 */
'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const config = require('../config.cjs');

const SCHEMA_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * DAY_MS;

const DEFAULTS = Object.freeze({
  enabled: true,
  installId: '',
  endpoint: 'https://bilko.run',
  noticeAckedAt: null,
  lastMachineReportAt: null,
  lastMachineReportVersion: '',
  lastDailyFlushAt: null,
  schemaVersion: SCHEMA_VERSION,
});

const KNOWN_KEYS = new Set(Object.keys(DEFAULTS));

function storePath() {
  return path.join(os.homedir(), '.config', 'session-manager', 'telemetry.json');
}

function isValid(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return false;
  for (const k of Object.keys(cfg)) {
    if (!KNOWN_KEYS.has(k)) return false;
  }
  if (typeof cfg.enabled !== 'boolean') return false;
  if (typeof cfg.installId !== 'string') return false;
  if (typeof cfg.endpoint !== 'string' || !cfg.endpoint.trim()) return false;
  if (cfg.noticeAckedAt !== null && typeof cfg.noticeAckedAt !== 'string') return false;
  if (cfg.lastMachineReportAt !== null && typeof cfg.lastMachineReportAt !== 'string') return false;
  if (typeof cfg.lastMachineReportVersion !== 'string') return false;
  if (cfg.lastDailyFlushAt !== null && typeof cfg.lastDailyFlushAt !== 'string') return false;
  if (cfg.schemaVersion !== SCHEMA_VERSION) return false;
  return true;
}

function normalize(cfg) {
  return {
    enabled: !!cfg.enabled,
    installId: typeof cfg.installId === 'string' ? cfg.installId : '',
    endpoint: typeof cfg.endpoint === 'string' && cfg.endpoint.trim() ? cfg.endpoint.trim() : DEFAULTS.endpoint,
    noticeAckedAt: typeof cfg.noticeAckedAt === 'string' ? cfg.noticeAckedAt : null,
    lastMachineReportAt: typeof cfg.lastMachineReportAt === 'string' ? cfg.lastMachineReportAt : null,
    lastMachineReportVersion: typeof cfg.lastMachineReportVersion === 'string' ? cfg.lastMachineReportVersion : '',
    lastDailyFlushAt: typeof cfg.lastDailyFlushAt === 'string' ? cfg.lastDailyFlushAt : null,
    schemaVersion: SCHEMA_VERSION,
  };
}

let writeQueue = Promise.resolve();
async function save(cfg) {
  if (!isValid(cfg)) throw new Error('Invalid telemetry config');
  const next = normalize(cfg);
  const run = async () => {
    await config.writeTextAtomic(storePath(), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    return next;
  };
  const tail = writeQueue.then(run, run);
  writeQueue = tail.catch(() => {});
  return tail;
}

async function readRaw() {
  try {
    const raw = await fsp.readFile(storePath(), 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data === 'object') {
      return normalize({ ...DEFAULTS, ...data });
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.warn('[telemetrySettings] load failed:', e.message);
    }
  }
  return { ...DEFAULTS };
}

/**
 * Loads the persisted config, minting and persisting installId on first read
 * when absent. A second in-process load() and a fresh load() from disk both
 * observe the same minted id, since the mint result is written to disk
 * before this resolves.
 */
async function load() {
  const cfg = await readRaw();
  if (!cfg.installId) {
    return save({ ...cfg, installId: crypto.randomUUID() });
  }
  return cfg;
}

/** Hard kill switch (SM_TELEMETRY=0) always wins over the persisted value. */
function isEnabled(cfg) {
  if (process.env.SM_TELEMETRY === '0') return false;
  return !!(cfg && cfg.enabled);
}

/** Env override always wins over the persisted endpoint. */
function resolveEndpoint(cfg) {
  if (process.env.SM_TELEMETRY_ENDPOINT) return process.env.SM_TELEMETRY_ENDPOINT;
  return (cfg && typeof cfg.endpoint === 'string' && cfg.endpoint.trim()) ? cfg.endpoint : DEFAULTS.endpoint;
}

/** True when lastDailyFlushAt is null or more than 24h before `now`. `now` is injected, never read internally. */
function isDailyFlushDue(cfg, now) {
  const last = cfg && cfg.lastDailyFlushAt;
  if (!last) return true;
  const lastMs = new Date(last).getTime();
  if (Number.isNaN(lastMs)) return true;
  return (now - lastMs) > DAY_MS;
}

/**
 * True when the install has changed app version since its last report, OR
 * lastMachineReportAt is null / more than 30 days before `now` (periodic
 * liveness heartbeat — what turns the data into an active-install count
 * rather than an ever-installed count). `now` is injected, never read internally.
 */
function isMachineReportDue(cfg, { now, appVersion }) {
  if (!cfg) return true;
  if (cfg.lastMachineReportVersion !== appVersion) return true;
  const last = cfg.lastMachineReportAt;
  if (!last) return true;
  const lastMs = new Date(last).getTime();
  if (Number.isNaN(lastMs)) return true;
  return (now - lastMs) > THIRTY_DAYS_MS;
}

module.exports = {
  load,
  save,
  storePath,
  isValid,
  isEnabled,
  resolveEndpoint,
  isDailyFlushDue,
  isMachineReportDue,
  DEFAULTS,
  SCHEMA_VERSION,
};
