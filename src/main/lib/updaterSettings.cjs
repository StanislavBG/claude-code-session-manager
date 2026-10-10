/**
 * updaterSettings — persists the in-app auto-update toggle.
 *
 * Storage: ~/.claude/session-manager/updater.json
 * Shape: { enabled: boolean (ON by default), schemaVersion: 1 }
 *
 * Mirrors telemetrySettings.cjs: atomic write via config.cjs, frozen DEFAULTS,
 * isValid() rejecting unknown keys. Pure data plumbing — no IPC, no UI.
 */
'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const config = require('../config.cjs');
const { schedulerHome } = require('./schedulerPaths.cjs');

const SCHEMA_VERSION = 1;
const DEFAULTS = Object.freeze({ enabled: true, schemaVersion: SCHEMA_VERSION });
const KNOWN_KEYS = new Set(Object.keys(DEFAULTS));

function storePath() {
  return path.join(schedulerHome(), 'updater.json');
}

function isValid(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return false;
  for (const k of Object.keys(cfg)) {
    if (!KNOWN_KEYS.has(k)) return false;
  }
  return typeof cfg.enabled === 'boolean' && cfg.schemaVersion === SCHEMA_VERSION;
}

/** Never throws: missing, unparseable, or invalid files all yield the defaults. */
async function load() {
  try {
    const data = JSON.parse(await fsp.readFile(storePath(), 'utf8'));
    const merged = { ...DEFAULTS, ...data };
    if (isValid(data && typeof data === 'object' && !Array.isArray(data) ? merged : data)) {
      return { enabled: merged.enabled, schemaVersion: SCHEMA_VERSION };
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[updaterSettings] load failed:', e.message);
  }
  return { ...DEFAULTS };
}

let writeQueue = Promise.resolve();
async function save(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid updater config');
  for (const k of Object.keys(patch)) {
    if (k !== 'enabled') throw new Error('Invalid updater config');
  }
  if (typeof patch.enabled !== 'boolean') throw new Error('Invalid updater config');
  const next = { enabled: patch.enabled, schemaVersion: SCHEMA_VERSION };
  const run = async () => {
    await config.writeJson(storePath(), next, { mode: 0o600 });
    return next;
  };
  const tail = writeQueue.then(run, run);
  writeQueue = tail.catch(() => {});
  return tail;
}

module.exports = { storePath, load, save, isValid, DEFAULTS, SCHEMA_VERSION };
