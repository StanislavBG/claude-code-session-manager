/**
 * artifactRetention — retention sweep for `session-manager-operations/artifacts/`
 * (layout + ledger shape: artifactStore.cjs). Mirrors scheduler/planRecordRetention.cjs.
 *
 * pruneArtifacts({ projectRoot, epicStatus, now, days, tasksDays, dryRun, fsImpl, sizeCapBytes })
 *   → { removed: string[] (owner ids whose folder was deleted), trimmed: string[] (owner
 *       ids that lost some files but keep pinned/fresh ones), removedFiles, kept,
 *       totalBytes (store size left after the sweep), overCap }. Never throws.
 *
 * Epic folders artifacts/<epic-id>/ are eligible when:
 *   - epicStatus(id) → { status: 'completed' | 'archived', completedAt | archivedAt }
 *     older than `days` (default opsRetentionSettings artifactsDays, 30), or
 *   - epicStatus(id) → null (orphan) and its newest file mtime is older than `days`.
 *   proposed/active Epics, a done Epic with no parseable time, and a throwing epicStatus
 *   keep the folder. An eligible folder with no pinned ledger entry is deleted whole; one
 *   with pinned entries keeps those files and its ledger is rewritten to just them.
 * Task folders artifacts/_tasks/<task-id>/ have no lifecycle, so each unpinned ledger
 *   entry whose createdAt (else file mtime) is older than `tasksDays` (default
 *   opsRetentionSettings tasksDays) is deleted, and the ledger rewritten; a folder left
 *   with nothing is deleted. Untracked files go by mtime.
 * Symlinks, non-directories and unsafe names are never touched. dryRun computes the exact
 * same result and touches nothing. Every delete/rewrite is asserted as writer 'artifacts'
 * (the namespace owner, opsOwnership.cjs). When the store left after the sweep exceeds
 * sizeCapBytes (default SIZE_CAP_BYTES, 5 GiB) ONE warning is logged per call.
 */
'use strict';

const nodeFs = require('node:fs');
const path = require('node:path');
const opsOwnership = require('../opsOwnership.cjs');
const atomicFs = require('../util/atomicFs.cjs');

const WRITER = 'artifacts';
const NS = 'artifacts';
const TASKS_DIR = '_tasks';
const LEDGER = 'index.json';
const DAY_MS = 86400000;
const SIZE_CAP_BYTES = 5 * 1024 * 1024 * 1024;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const DONE = new Set(['completed', 'archived']);

function toMs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v) {
    const ms = Date.parse(v);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

const isSafeId = (n) => typeof n === 'string' && SAFE_ID_RE.test(n) && n !== '.' && n !== '..';

function resolveDays(v, key, fallback) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  try {
    const d = require('../opsRetentionSettings.cjs').read()[key];
    return typeof d === 'number' && d > 0 ? d : fallback;
  } catch {
    return fallback;
  }
}

/** Sum of file sizes + newest file mtime under dir (symlinks not followed). */
function scan(fsImpl, dir) {
  let bytes = 0;
  let newest = null;
  const walk = (d) => {
    let entries;
    try { entries = fsImpl.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      try {
        const st = fsImpl.lstatSync(p);
        bytes += st.isFile() ? st.size : 0;
        if (newest === null || st.mtimeMs > newest) newest = st.mtimeMs;
      } catch { /* vanished */ }
    }
  };
  walk(dir);
  if (newest === null) {
    try { newest = fsImpl.lstatSync(dir).mtimeMs; } catch { /* vanished */ }
  }
  return { bytes, newest };
}

/** { entries, raw } — entries [] on missing/corrupt; raw keeps the ledger's other keys. */
function readLedger(fsImpl, file) {
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    const list = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.entries) ? parsed.entries : [];
    const raw = parsed && !Array.isArray(parsed) && typeof parsed === 'object' ? parsed : { version: 1 };
    return { entries: list.filter((e) => e && typeof e === 'object' && typeof e.name === 'string'), raw };
  } catch {
    return { entries: [], raw: { version: 1 } };
  }
}

/** Direct child files of dir (no dirs, no symlinks), excluding the ledger. */
function childFiles(fsImpl, dir) {
  let entries;
  try { entries = fsImpl.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.filter((e) => e.name !== LEDGER && !e.isSymbolicLink()).map((e) => e.name);
}

function isEpicEligible(id, dir, epicStatus, cutoffMs, fsImpl) {
  let st;
  try { st = epicStatus(id); } catch { return false; }
  if (st === null || st === undefined) {
    const { newest } = scan(fsImpl, dir);
    return newest !== null && newest < cutoffMs;
  }
  if (!st || typeof st !== 'object' || !DONE.has(st.status)) return false;
  const done = toMs(st.completedAt) ?? toMs(st.archivedAt);
  return done !== null && done < cutoffMs;
}

/**
 * Remove `names` from owner folder `dir`, keeping `keepEntries` in its ledger. Deletes the
 * whole folder when nothing would remain. Returns 'removed' | 'trimmed' | null.
 */
function applyOwner({ dir, names, keepEntries, entries, raw, dryRun, fsImpl, result }) {
  const remaining = childFiles(fsImpl, dir).filter((n) => !names.includes(n));
  if (remaining.length === 0 && keepEntries.length === 0) {
    opsOwnership.assertOpsWrite(dir, WRITER);
    result.removedFiles += childFiles(fsImpl, dir).length;
    if (!dryRun) fsImpl.rmSync(dir, { recursive: true, force: true });
    return 'removed';
  }
  if (names.length === 0 && keepEntries.length === entries.length) return null;
  for (const n of names) {
    const p = path.join(dir, n);
    opsOwnership.assertOpsWrite(p, WRITER);
    if (!dryRun) fsImpl.rmSync(p, { recursive: true, force: true });
    result.removedFiles += 1;
  }
  const ledgerFile = path.join(dir, LEDGER);
  opsOwnership.assertOpsWrite(ledgerFile, WRITER);
  if (!dryRun) atomicFs.writeJsonAtomicSync(ledgerFile, { ...raw, entries: keepEntries });
  return 'trimmed';
}

function pruneEpicOwner(ctx, id, dir) {
  if (!isEpicEligible(id, dir, ctx.epicStatus, ctx.cutoffMs, ctx.fsImpl)) return null;
  const { entries, raw } = readLedger(ctx.fsImpl, path.join(dir, LEDGER));
  const keepEntries = entries.filter((e) => e.pinned === true);
  const keepNames = new Set(keepEntries.map((e) => e.name));
  const names = childFiles(ctx.fsImpl, dir).filter((n) => !keepNames.has(n));
  return applyOwner({ dir, names, keepEntries, entries, raw, dryRun: ctx.dryRun, fsImpl: ctx.fsImpl, result: ctx.result });
}

function pruneTaskOwner(ctx, dir) {
  const { fsImpl, tasksCutoffMs } = ctx;
  const { entries, raw } = readLedger(fsImpl, path.join(dir, LEDGER));
  const mtime = (n) => { try { return fsImpl.lstatSync(path.join(dir, n)).mtimeMs; } catch { return null; } };
  const old = (ms) => ms !== null && ms < tasksCutoffMs;
  const keepEntries = entries.filter((e) => e.pinned === true || !old(toMs(e.createdAt) ?? mtime(e.name)));
  const tracked = new Set(entries.map((e) => e.name));
  const keepNames = new Set(keepEntries.map((e) => e.name));
  const names = childFiles(fsImpl, dir).filter((n) => (tracked.has(n) ? !keepNames.has(n) : old(mtime(n))));
  return applyOwner({ dir, names, keepEntries, entries, raw, dryRun: ctx.dryRun, fsImpl, result: ctx.result });
}

function safeDirs(fsImpl, dir) {
  try {
    return fsImpl.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.isSymbolicLink() && isSafeId(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function pruneArtifacts(opts) {
  const result = { removed: [], trimmed: [], removedFiles: 0, kept: 0, totalBytes: 0, overCap: false };
  try {
    const o = opts || {};
    const fsImpl = o.fsImpl || nodeFs;
    const now = typeof o.now === 'number' && Number.isFinite(o.now) ? o.now : Date.now();
    const cap = typeof o.sizeCapBytes === 'number' && o.sizeCapBytes >= 0 ? o.sizeCapBytes : SIZE_CAP_BYTES;
    const root = opsOwnership.opsPath(o.projectRoot, NS);
    if (!fsImpl.existsSync(root)) return result;
    const ctx = {
      fsImpl,
      dryRun: !!o.dryRun,
      result,
      epicStatus: typeof o.epicStatus === 'function' ? o.epicStatus : () => { throw new Error('no epicStatus'); },
      cutoffMs: now - resolveDays(o.days, 'artifactsDays', 30) * DAY_MS,
      tasksCutoffMs: now - resolveDays(o.tasksDays, 'tasksDays', 30) * DAY_MS,
    };
    const before = scan(fsImpl, root).bytes;
    let freed = 0;
    const visit = (ownerId, dir, fn) => {
      try {
        const size = scan(fsImpl, dir).bytes;
        const out = fn();
        if (out === 'removed') { result.removed.push(ownerId); freed += size; return; }
        if (out === 'trimmed') {
          result.trimmed.push(ownerId);
          if (!ctx.dryRun) freed += size - scan(fsImpl, dir).bytes;
        }
        result.kept += 1;
      } catch (err) {
        console.warn(`[artifactRetention] keep ${ownerId}:`, err && err.message);
        result.kept += 1;
      }
    };
    for (const id of safeDirs(fsImpl, root)) {
      if (id === TASKS_DIR) continue;
      const dir = opsOwnership.opsPath(o.projectRoot, NS, id);
      visit(id, dir, () => pruneEpicOwner(ctx, id, dir));
    }
    for (const t of safeDirs(fsImpl, path.join(root, TASKS_DIR))) {
      const dir = opsOwnership.opsPath(o.projectRoot, NS, TASKS_DIR, t);
      visit(`${TASKS_DIR}/${t}`, dir, () => pruneTaskOwner(ctx, dir));
    }
    result.totalBytes = ctx.dryRun ? Math.max(0, before - freed) : scan(fsImpl, root).bytes;
    if (result.totalBytes > cap) {
      result.overCap = true;
      console.warn(`[artifactRetention] artifacts store over size cap: ${result.totalBytes} bytes > ${cap} (${root})`);
    }
  } catch (err) {
    console.warn('[artifactRetention] sweep skipped:', err && err.message);
  }
  return result;
}

module.exports = { pruneArtifacts, SIZE_CAP_BYTES };
