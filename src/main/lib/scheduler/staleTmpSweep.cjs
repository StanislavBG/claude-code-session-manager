'use strict';

/**
 * staleTmpSweep.cjs — reaps tmp files leaked by dead writers in scheduled-plans/
 * (`queue.json.tmp-<pid>-*`, `.max-allocated-group.tmp-<pid>-*`) and prunes
 * `scheduled-plans/runs-archive/` by age.
 *
 * Safety: a tmp file is removed only when it is older than minAgeMs AND the pid
 * embedded in its name is not alive. `queue.json.bak*` files are never deleted —
 * they are reported only.
 */

const fs = require('node:fs');
const path = require('node:path');

const DAY_MS = 24 * 60 * 60 * 1000;
const TMP_RE = /\.tmp-(\d+)-/;

function defaultIsPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = process exists but belongs to someone else → alive.
    return !!e && e.code === 'EPERM';
  }
}

function sweepStaleTmp(dir, opts) {
  const o = opts || {};
  const minAgeMs = typeof o.minAgeMs === 'number' ? o.minAgeMs : 3600000;
  const now = typeof o.now === 'number' ? o.now : Date.now();
  const isPidAlive = typeof o.isPidAlive === 'function' ? o.isPidAlive : defaultIsPidAlive;
  const dryRun = o.dryRun === true;
  const result = { removedFiles: 0, freedBytes: 0, removed: [], backups: [], errors: [] };
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    if (e && e.code !== 'ENOENT') result.errors.push(e.message);
    return result;
  }
  for (const name of names) {
    if (name.startsWith('queue.json.bak')) {
      result.backups.push(name);
      continue;
    }
    const m = TMP_RE.exec(name);
    if (!m) continue;
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (!st.isFile() || now - st.mtimeMs <= minAgeMs) continue;
      if (isPidAlive(Number(m[1]))) continue;
      if (!dryRun) fs.unlinkSync(full);
      result.removedFiles += 1;
      result.freedBytes += st.size;
      result.removed.push(name);
    } catch (e) {
      if (e && e.code !== 'ENOENT') result.errors.push(`${name}: ${e.message}`);
    }
  }
  return result;
}

function sizeOf(p, st) {
  if (!st.isDirectory()) return st.size;
  let total = 0;
  let kids = [];
  try { kids = fs.readdirSync(p); } catch { return 0; }
  for (const k of kids) {
    try { total += sizeOf(path.join(p, k), fs.lstatSync(path.join(p, k))); } catch { /* raced */ }
  }
  return total;
}

// Lazy require: opsRetentionSettings requires this module (preview), so a
// top-level require here would be circular.
function defaultRunsArchiveDays() {
  try {
    return require('../opsRetentionSettings.cjs').read().runsArchiveDays;
  } catch {
    return 30;
  }
}

function pruneRunsArchive(archiveDir, opts) {
  const o = opts || {};
  const maxAgeDays = typeof o.maxAgeDays === 'number' ? o.maxAgeDays : defaultRunsArchiveDays();
  const dryRun = o.dryRun === true;
  const now = typeof o.now === 'number' ? o.now : Date.now();
  const result = { removedFiles: 0, freedBytes: 0, removed: [], errors: [] };
  let names;
  try {
    names = fs.readdirSync(archiveDir);
  } catch (e) {
    if (e && e.code !== 'ENOENT') result.errors.push(e.message);
    return result;
  }
  for (const name of names) {
    const full = path.join(archiveDir, name);
    try {
      const st = fs.lstatSync(full);
      if (now - st.mtimeMs <= maxAgeDays * DAY_MS) continue;
      const bytes = sizeOf(full, st);
      if (!dryRun) fs.rmSync(full, { recursive: true, force: true });
      result.removedFiles += 1;
      result.freedBytes += bytes;
      result.removed.push(name);
    } catch (e) {
      if (e && e.code !== 'ENOENT') result.errors.push(`${name}: ${e.message}`);
    }
  }
  return result;
}

module.exports = { sweepStaleTmp, pruneRunsArchive };
