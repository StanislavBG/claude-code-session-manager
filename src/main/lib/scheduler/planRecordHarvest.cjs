'use strict';

/**
 * planRecordHarvest.cjs — copy the plan records a job wrote inside its git
 * worktree (`<ops>/plan-records/<epic-id>/*.md`, never committed) into the
 * main checkout's `plan-records/<epic-id>/`, writing as the namespace owner
 * ('scheduler'), so they survive worktree teardown without a commit.
 *
 * Never throws: every refusal is reported in `skipped` with a reason.
 */

const fs = require('node:fs');
const path = require('node:path');
const { OPS_ROOT_DIR, opsPath, checkOpsWrite, assertOpsWrite } = require('../opsOwnership.cjs');
const { writeTextAtomicSync } = require('../util/atomicFs.cjs');

const NAMESPACE = 'plan-records';
const WRITER = 'scheduler';
const MAX_BYTES = 1024 * 1024;
const NAME_RE = /^[A-Za-z0-9._-]+\.md$/;
const EPIC_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

function errMsg(e) {
  return e && e.message ? e.message : String(e);
}

/**
 * harvestPlanRecords({ worktreeDir, projectRoot, epicId, fsImpl })
 *   → { copied: string[], skipped: { path, reason }[] }
 * `copied` holds destination absolute paths.
 */
function harvestPlanRecords({ worktreeDir, projectRoot, epicId, fsImpl = fs } = {}) {
  /** @type {string[]} */
  const copied = [];
  /** @type {{ path: string, reason: string }[]} */
  const skipped = [];
  try {
    if (typeof epicId !== 'string' || !EPIC_ID_RE.test(epicId)) {
      skipped.push({ path: String(epicId), reason: 'unsafe epicId' });
      return { copied, skipped };
    }
    if (typeof worktreeDir !== 'string' || !path.isAbsolute(worktreeDir)
      || typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) {
      skipped.push({ path: String(worktreeDir), reason: 'worktreeDir and projectRoot must be absolute paths' });
      return { copied, skipped };
    }
    if (path.resolve(worktreeDir) === path.resolve(projectRoot)) return { copied, skipped };

    const srcDir = path.join(path.resolve(worktreeDir), OPS_ROOT_DIR, NAMESPACE, epicId);
    let destDir;
    try {
      destDir = path.resolve(opsPath(projectRoot, NAMESPACE, epicId));
    } catch (e) {
      skipped.push({ path: srcDir, reason: `destination refused: ${errMsg(e)}` });
      return { copied, skipped };
    }
    if (destDir === srcDir) return { copied, skipped };

    let srcStat;
    try {
      srcStat = fsImpl.lstatSync(srcDir);
    } catch {
      return { copied, skipped }; // no records written by this job
    }
    if (!srcStat.isDirectory()) {
      skipped.push({ path: srcDir, reason: 'source is not a directory' });
      return { copied, skipped };
    }

    let names;
    try {
      names = fsImpl.readdirSync(srcDir).map(String).sort();
    } catch (e) {
      skipped.push({ path: srcDir, reason: `cannot list source: ${errMsg(e)}` });
      return { copied, skipped };
    }

    for (const name of names) {
      const src = path.join(srcDir, name);
      try {
        if (!NAME_RE.test(name)) { skipped.push({ path: src, reason: 'name not allowed' }); continue; }
        const st = fsImpl.lstatSync(src);
        if (st.isSymbolicLink()) { skipped.push({ path: src, reason: 'symlink' }); continue; }
        if (st.isDirectory()) { skipped.push({ path: src, reason: 'directory' }); continue; }
        if (!st.isFile()) { skipped.push({ path: src, reason: 'not a regular file' }); continue; }
        if (st.size > MAX_BYTES) { skipped.push({ path: src, reason: `oversize (${st.size} > ${MAX_BYTES} bytes)` }); continue; }

        const dest = path.resolve(opsPath(projectRoot, NAMESPACE, epicId, name));
        if (path.dirname(dest) !== destDir) { skipped.push({ path: src, reason: 'destination escapes plan-records folder' }); continue; }
        const verdict = checkOpsWrite(dest, WRITER);
        if (!verdict.ok) { skipped.push({ path: src, reason: `write refused: ${verdict.error}` }); continue; }
        assertOpsWrite(dest, WRITER);

        const text = fsImpl.readFileSync(src, 'utf8');
        if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) { skipped.push({ path: src, reason: 'oversize after read' }); continue; }
        writeTextAtomicSync(dest, text);
        copied.push(dest);
      } catch (e) {
        skipped.push({ path: src, reason: `copy failed: ${errMsg(e)}` });
      }
    }
  } catch (e) {
    skipped.push({ path: String(worktreeDir), reason: `harvest failed: ${errMsg(e)}` });
  }
  return { copied, skipped };
}

module.exports = { harvestPlanRecords, MAX_BYTES, NAME_RE, EPIC_ID_RE };
