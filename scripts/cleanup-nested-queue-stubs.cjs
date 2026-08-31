#!/usr/bin/env node
'use strict';

/**
 * cleanup-nested-queue-stubs.cjs — remove the stray queue shards left behind
 * by the nested-ops-root bug (fixed 2026-08-30 in activeSessions.projectRootOf
 * + queueStore.projectStateDir).
 *
 * Before the fix, a transcript whose last row recorded an agent's `cd` into an
 * ops artifact directory made that subdirectory look like a project, and
 * writeSplit materialized a whole second ops root beneath it:
 *
 *   <project>/session-manager-operations/scheduler/epics/<id>/prds/
 *     session-manager-operations/scheduler/state/queue.json      → {"jobs": []}
 *
 * The doubled `session-manager-operations/` is the tell. Nothing reads these;
 * they are inert litter. 14 of them accumulated in starry-night-ships over
 * 8 days before the bug was reported.
 *
 * SAFETY: only deletes a queue.json that is BOTH nested under an outer ops
 * root AND holds zero jobs. A real queue — always exactly one per project, at
 * the un-nested path — can never match either condition. Prints what it would
 * remove and exits unless --apply is passed.
 *
 * Usage:
 *   node scripts/cleanup-nested-queue-stubs.cjs [projectCwd] [--apply]
 */

const fs = require('node:fs');
const path = require('node:path');

const OPS = 'session-manager-operations';
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const cwd = path.resolve(args.find((a) => !a.startsWith('--')) || process.cwd());
const opsRoot = path.join(cwd, OPS);
// The one legitimate queue path for this project. Everything else named
// queue.json under an ops root is a stray by construction.
const REAL_QUEUE = path.join(opsRoot, 'scheduler', 'state', 'queue.json');
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.worktrees']);

/**
 * Every queue.json under `dir`, recursively. Symlinks are never followed.
 * The whole project is scanned, not just the ops root: strays also landed
 * outside it (e.g. `plugins/<x>/skills/<y>/session-manager-operations/...`)
 * whenever the agent's recorded cwd was a source directory.
 */
function findQueueFiles(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) findQueueFiles(p, out);
    else if (e.isFile() && e.name === 'queue.json') out.push(p);
  }
  return out;
}

/** A stub is at a non-canonical path AND holds no jobs. Both, never either. */
function isStub(file) {
  if (file === REAL_QUEUE) return false;
  if (!path.relative(cwd, file).split(path.sep).includes(OPS)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data.jobs) && data.jobs.length === 0 && Object.keys(data).length === 1;
  } catch {
    return false;
  }
}

const stubs = findQueueFiles(cwd).filter(isStub);

if (!stubs.length) {
  console.log(`No nested queue.json stubs under ${cwd}`);
  process.exit(0);
}

for (const f of stubs) console.log(`${apply ? 'removing' : 'would remove'}  ${path.relative(cwd, f)}`);

if (!apply) {
  console.log(`\n${stubs.length} stub(s). Re-run with --apply to delete.`);
  process.exit(0);
}

let removed = 0;
for (const f of stubs) {
  try {
    fs.rmSync(f);
    removed += 1;
    // Prune the now-empty scaffolding (state/ → scheduler/ → the inner ops
    // root), stopping at the first directory that still holds anything.
    let dir = path.dirname(f);
    while (dir !== cwd && dir.startsWith(cwd) && path.basename(dir) !== OPS) {
      if (fs.readdirSync(dir).length) break;
      fs.rmdirSync(dir);
      dir = path.dirname(dir);
    }
    if (path.basename(dir) === OPS && dir !== opsRoot && !fs.readdirSync(dir).length) fs.rmdirSync(dir);
  } catch (e) {
    console.error(`failed to remove ${f}: ${e?.message}`);
  }
}
console.log(`\nRemoved ${removed} stub(s).`);
