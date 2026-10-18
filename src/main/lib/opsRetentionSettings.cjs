/**
 * opsRetentionSettings — machine-level retention policy for the ops sweeps.
 *
 * Storage: ~/.claude/session-manager/ops-retention.json
 * Shape (DEFAULTS): { runLogs:{maxAgeDays,keepPerSlug}, runsArchiveDays, auditLogMonths,
 *   reservedMarkersKeep, archivedTranscripts:{mode:'forever'} }
 *
 * Top-level in lib/ (no domain fits: read by scheduler, telemetry and epic sweeps alike).
 * preview() runs the sweeps' own eligibility code in dry-run mode — it deletes nothing.
 * Modelled on updaterSettings.cjs: frozen DEFAULTS, never-throwing read, strict write.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const atomicFs = require('./util/atomicFs.cjs');

const DEFAULTS = Object.freeze({
  runLogs: Object.freeze({ maxAgeDays: 14, keepPerSlug: 3 }),
  runsArchiveDays: 30,
  auditLogMonths: 6,
  reservedMarkersKeep: 100,
  archivedTranscripts: Object.freeze({ mode: 'forever' }),
});

// [min, max] per integer field; out-of-range values clamp, non-integers round.
const BOUNDS = Object.freeze({
  'runLogs.maxAgeDays': [3, 3650],
  'runLogs.keepPerSlug': [1, 1000],
  runsArchiveDays: [1, 3650],
  auditLogMonths: [1, 120],
  reservedMarkersKeep: [1, 100000],
});
const ARCHIVED_MODES = Object.freeze(['forever']);

function storePath() {
  return path.join(os.homedir(), '.claude', 'session-manager', 'ops-retention.json');
}

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function clamp(key, v) {
  const [min, max] = BOUNDS[key];
  return Math.min(max, Math.max(min, Math.round(v)));
}

/**
 * Strict patch validation (used by write() and the IPC set handler). Returns a
 * partial settings object with clamped integers; throws on unknown keys,
 * wrong types, or an unsupported archivedTranscripts.mode.
 */
function validatePatch(patch) {
  if (!isObj(patch)) throw new Error('Invalid ops retention config');
  const out = {};
  const num = (key, v) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`Invalid ops retention config: ${key}`);
    return clamp(key, v);
  };
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'runLogs') {
      if (!isObj(v)) throw new Error('Invalid ops retention config: runLogs');
      out.runLogs = {};
      for (const [rk, rv] of Object.entries(v)) {
        if (rk !== 'maxAgeDays' && rk !== 'keepPerSlug') throw new Error(`Invalid ops retention config: runLogs.${rk}`);
        out.runLogs[rk] = num(`runLogs.${rk}`, rv);
      }
    } else if (k === 'archivedTranscripts') {
      if (!isObj(v) || Object.keys(v).some((x) => x !== 'mode') || !ARCHIVED_MODES.includes(v.mode)) {
        throw new Error('Invalid ops retention config: archivedTranscripts');
      }
      out.archivedTranscripts = { mode: v.mode };
    } else if (k === 'runsArchiveDays' || k === 'auditLogMonths' || k === 'reservedMarkersKeep') {
      out[k] = num(k, v);
    } else {
      throw new Error(`Invalid ops retention config: unknown key ${k}`);
    }
  }
  return out;
}

/** Lenient field-by-field sanitize of on-disk data: bad fields are dropped, not fatal. */
function sanitizeStored(data) {
  if (!isObj(data)) return null;
  const out = {};
  const int = (key, v) => (typeof v === 'number' && Number.isFinite(v) ? clamp(key, v) : undefined);
  if (isObj(data.runLogs)) {
    const m = int('runLogs.maxAgeDays', data.runLogs.maxAgeDays);
    const k = int('runLogs.keepPerSlug', data.runLogs.keepPerSlug);
    if (m !== undefined || k !== undefined) {
      out.runLogs = {
        maxAgeDays: m !== undefined ? m : DEFAULTS.runLogs.maxAgeDays,
        keepPerSlug: k !== undefined ? k : DEFAULTS.runLogs.keepPerSlug,
      };
    }
  }
  for (const key of ['runsArchiveDays', 'auditLogMonths', 'reservedMarkersKeep']) {
    const v = int(key, data[key]);
    if (v !== undefined) out[key] = v;
  }
  if (isObj(data.archivedTranscripts) && ARCHIVED_MODES.includes(data.archivedTranscripts.mode)) {
    out.archivedTranscripts = { mode: data.archivedTranscripts.mode };
  }
  return out;
}

/** What is explicitly stored (sanitized), or null when absent/corrupt. Never throws. */
function readStored() {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
    return sanitizeStored(raw);
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[opsRetentionSettings] read failed:', e.message);
    return null;
  }
}

function withDefaults(stored) {
  const s = stored || {};
  return {
    runLogs: { ...DEFAULTS.runLogs, ...(s.runLogs || {}) },
    runsArchiveDays: s.runsArchiveDays ?? DEFAULTS.runsArchiveDays,
    auditLogMonths: s.auditLogMonths ?? DEFAULTS.auditLogMonths,
    reservedMarkersKeep: s.reservedMarkersKeep ?? DEFAULTS.reservedMarkersKeep,
    archivedTranscripts: { ...DEFAULTS.archivedTranscripts },
  };
}

/** Effective settings. Never throws: missing/corrupt file yields DEFAULTS. */
function read() {
  return withDefaults(readStored());
}

/** Validate + merge `patch` over the current settings and persist the full object. */
function write(patch) {
  const valid = validatePatch(patch);
  const cur = read();
  const next = {
    ...cur,
    ...valid,
    runLogs: { ...cur.runLogs, ...(valid.runLogs || {}) },
  };
  atomicFs.writeJsonAtomicSync(storePath(), next, { mode: 0o600 });
  return next;
}

/**
 * Dry-run report of what each policy would free, via the sweeps' own
 * eligibility code. Read-only. opts: { now, runsDir, plansRoot, jobs, liveKeys }.
 */
function preview(opts) {
  const o = opts || {};
  const schedulerPaths = require('./scheduler/schedulerPaths.cjs');
  const runLogRetention = require('./scheduler/runLogRetention.cjs');
  const staleTmpSweep = require('./scheduler/staleTmpSweep.cjs');
  const s = read();
  const now = typeof o.now === 'number' ? o.now : Date.now();
  const runsDir = o.runsDir || schedulerPaths.runsDir();
  const plansRoot = o.plansRoot || schedulerPaths.scheduledPlansRoot();

  let liveKeys = o.liveKeys;
  if (!liveKeys) {
    let jobs = o.jobs;
    if (!jobs) {
      try {
        jobs = require('./scheduler/queueStore.cjs').readMergedSync().jobs || [];
      } catch {
        jobs = [];
      }
    }
    liveKeys = runLogRetention.liveKeysFromJobs(jobs, { runsDir });
  }
  const report = runLogRetention.computeReport(runsDir, { ...s.runLogs }, { now, liveKeys });
  const archive = staleTmpSweep.pruneRunsArchive(path.join(plansRoot, 'runs-archive'), {
    maxAgeDays: s.runsArchiveDays,
    now,
    dryRun: true,
  });
  const tmp = staleTmpSweep.sweepStaleTmp(plansRoot, { now, dryRun: true });
  return {
    runLogs: { files: report.eligible.reduce((n, e) => n + e.removeFiles.length, 0) + report.dodFiles.length, bytes: report.eligibleSummary.bytes },
    runsArchive: { entries: archive.removedFiles, bytes: archive.freedBytes },
    tmp: { files: tmp.removedFiles, bytes: tmp.freedBytes },
  };
}

function registerIpc(ipcMain) {
  ipcMain.handle('opsRetention:get', () => read());
  ipcMain.handle('opsRetention:set', (_e, patch) => write(patch));
  ipcMain.handle('opsRetention:preview', () => preview());
}

module.exports = { storePath, read, readStored, write, validatePatch, preview, registerIpc, DEFAULTS, BOUNDS };
