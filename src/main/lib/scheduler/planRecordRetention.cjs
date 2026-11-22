/**
 * planRecordRetention — retention sweep for `session-manager-operations/plan-records/<epic-id>/`.
 *
 * prunePlanRecords({ projectRoot, epicStatus, now, days, dryRun, fsImpl })
 *   → { removed: string[] (epic ids), kept: number }. Never throws.
 *
 * A folder is removed when:
 *   - epicStatus(id) → { status: 'completed', completedAt } with completedAt older than `days`, or
 *   - epicStatus(id) → null (orphan) and its newest file mtime is older than `days`.
 * Never removed: proposed/active (any non-completed) Epics, a completed Epic with no
 * parseable completedAt, README.md / .gitignore (or any non-directory), symlinks, and
 * folder names that fail SAFE_ID_RE. A throwing epicStatus keeps the folder.
 * dryRun reports the exact same list and deletes nothing.
 *
 * Writes go through opsPath(projectRoot, 'plan-records', id) and the opsOwnership write
 * guard as writer 'scheduler' (the namespace owner). epicStatus and fsImpl are injected
 * so the module is pure; defaultEpicStatus(projectRoot) reads prompt-sessions/<id>.json.
 * days defaults to opsRetentionSettings.read().planRecordsDays.
 */
'use strict';

const nodeFs = require('node:fs');
const path = require('node:path');
const opsOwnership = require('../opsOwnership.cjs');
const { readJsonOrSync } = require('../util/atomicFs.cjs');

const WRITER = 'scheduler';
const NS = 'plan-records';
const DAY_MS = 86400000;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const RESERVED = new Set(['README.md', '.gitignore']);

function toMs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v) {
    const ms = Date.parse(v);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

function isSafeId(name) {
  return typeof name === 'string' && SAFE_ID_RE.test(name) && name !== '.' && name !== '..' && !RESERVED.has(name);
}

/** Newest mtime of any file under dir (recursive, symlinks not followed); dir mtime when empty. */
function newestMtime(fsImpl, dir) {
  let newest = null;
  const walk = (d) => {
    let entries;
    try { entries = fsImpl.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      try {
        const st = fsImpl.lstatSync(p);
        if (newest === null || st.mtimeMs > newest) newest = st.mtimeMs;
      } catch { /* vanished */ }
    }
  };
  walk(dir);
  if (newest === null) {
    try { newest = fsImpl.lstatSync(dir).mtimeMs; } catch { /* vanished */ }
  }
  return newest;
}

function resolveDays(days) {
  if (typeof days === 'number' && Number.isFinite(days) && days > 0) return days;
  try {
    return require('../opsRetentionSettings.cjs').read().planRecordsDays;
  } catch {
    return 14;
  }
}

function isEligible({ id, dir, epicStatus, cutoffMs, fsImpl }) {
  let st;
  try { st = epicStatus(id); } catch { return false; }
  if (st === null || st === undefined) {
    const m = newestMtime(fsImpl, dir);
    return m !== null && m < cutoffMs;
  }
  if (!st || typeof st !== 'object' || st.status !== 'completed') return false;
  const done = toMs(st.completedAt);
  return done !== null && done < cutoffMs;
}

function prunePlanRecords(opts) {
  const result = { removed: [], kept: 0 };
  try {
    const o = opts || {};
    const fsImpl = o.fsImpl || nodeFs;
    if (typeof o.epicStatus !== 'function') return result;
    const now = typeof o.now === 'number' && Number.isFinite(o.now) ? o.now : Date.now();
    const cutoffMs = now - resolveDays(o.days) * DAY_MS;
    const root = opsOwnership.opsPath(o.projectRoot, NS);
    let entries;
    try { entries = fsImpl.readdirSync(root, { withFileTypes: true }); } catch { return result; }
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink() || !isSafeId(e.name)) continue;
      const id = e.name;
      let target;
      try {
        target = opsOwnership.opsPath(o.projectRoot, NS, id);
        if (!isEligible({ id, dir: target, epicStatus: o.epicStatus, cutoffMs, fsImpl })) {
          result.kept += 1;
          continue;
        }
        opsOwnership.assertOpsWrite(target, WRITER);
        if (!o.dryRun) fsImpl.rmSync(target, { recursive: true, force: true });
        result.removed.push(id);
      } catch (err) {
        console.warn(`[planRecordRetention] keep ${id}:`, err && err.message);
        result.kept += 1;
      }
    }
  } catch (err) {
    console.warn('[planRecordRetention] sweep skipped:', err && err.message);
  }
  return result;
}

/**
 * defaultEpicStatus(projectRoot) → epicStatus(id) reading prompt-sessions/<id>.json
 * (live mirror is flat; a completed archive nests the record under `session`).
 * Returns null when the file is absent/unreadable or carries no status. Never throws.
 */
function defaultEpicStatus(projectRoot) {
  return (id) => {
    try {
      if (!isSafeId(id)) return null;
      const doc = readJsonOrSync(opsOwnership.opsPath(projectRoot, 'prompt-sessions', `${id}.json`), null);
      if (!doc || typeof doc !== 'object') return null;
      const rec = doc.session && typeof doc.session === 'object' ? doc.session : doc;
      if (typeof rec.status !== 'string') return null;
      return { status: rec.status, completedAt: rec.completedAt ?? null };
    } catch {
      return null;
    }
  };
}

module.exports = { prunePlanRecords, defaultEpicStatus };
