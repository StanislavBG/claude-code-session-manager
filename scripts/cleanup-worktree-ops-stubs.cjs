#!/usr/bin/env node
'use strict';

/**
 * cleanup-worktree-ops-stubs.cjs — sibling to cleanup-nested-queue-stubs.cjs
 * (dispatched from there via `--worktree-stubs`), removing
 * `session-manager-operations/` trees that queueStore.writeSplit /
 * opsErrorLog.appendError materialized in EPHEMERAL locations before
 * ephemeralCwd.cjs's fail-closed guard existed:
 *
 *   - directly under os.tmpdir() — a bare-root stray, e.g. the
 *     /tmp/session-manager-operations/logs/ tree found live 2026-09-01.
 *   - inside the two MANAGED git worktree roots (gitWorktree.cjs's
 *     KIND_CONFIG job/epic roots), at the `<root>/<hash>/<key>/
 *     session-manager-operations/` depth `worktreeDirFor` checks out at, e.g.
 *     /tmp/session-manager-epic-worktrees/443997d5.../enemies-animation-.../
 *     session-manager-operations/scheduler/state/queue.json (rewritten every
 *     reconcile pass, mtime tracking the clock).
 *
 * A worktree is torn down when its Epic/job ends, so any state written there
 * is silently destroyed — this cleanup exists for stubs left behind by a
 * worktree still alive (being rewritten) or torn down without its parent
 * hash dir being pruned.
 *
 * SAFETY: only ever removes a `session-manager-operations/` directory it can
 * PROVE holds zero git-tracked files in its enclosing worktree (some
 * projects, e.g. starry-night-ships, track that folder as real checked-out
 * content) — `git -C <worktreeRoot> ls-files -- <relpath>` must come back
 * empty. A worktree whose root no longer exists, or isn't a git repo, is
 * skipped without throwing. The bare os.tmpdir()-root case has no enclosing
 * worktree to check against (nothing under os.tmpdir() itself is ever
 * git-tracked) and is always eligible.
 *
 * Usage:
 *   node scripts/cleanup-worktree-ops-stubs.cjs [--dry-run] [--apply]
 * Mirrors cleanup-nested-queue-stubs.cjs's default-safe shape: prints
 * "would remove" and changes nothing unless --apply is passed. --dry-run is
 * an explicit, equivalent no-op spelling (wins over --apply if both given).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { KIND_CONFIG } = require('../src/main/lib/gitWorktree.cjs');

const OPS_DIRNAME = 'session-manager-operations';
const SKIP_DIRS = new Set(['node_modules', '.git']);
// Worktree layout is <root>/<hash>/<key>/session-manager-operations/ — three
// directory levels below root before the ops dir itself, so cap the walk
// there rather than scanning arbitrarily deep into checked-out project trees.
const MAX_WALK_DEPTH = 3;

function findOpsDirsUnder(dir, maxDepth) {
  const out = [];
  function walk(current, depth) {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue;
      const p = path.join(current, e.name);
      if (e.name === OPS_DIRNAME) { out.push(p); continue; } // never recurse into a found ops dir
      if (depth < maxDepth) walk(p, depth + 1);
    }
  }
  walk(dir, 0);
  return out;
}

/** True when `worktreeRoot` is a readable git repo with zero tracked files under `opsDir`. */
function isSafeToRemove(worktreeRoot, opsDir) {
  if (!fs.existsSync(path.join(worktreeRoot, '.git'))) return false;
  const rel = path.relative(worktreeRoot, opsDir);
  try {
    const out = execFileSync('git', ['-C', worktreeRoot, 'ls-files', '--', rel], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    return out.trim().length === 0;
  } catch {
    return false; // can't prove untracked — never delete
  }
}

function findCandidates() {
  const tmpdir = path.resolve(os.tmpdir());
  const candidates = [];

  const bareOps = path.join(tmpdir, OPS_DIRNAME);
  if (fs.existsSync(bareOps)) candidates.push({ dir: bareOps, worktreeRoot: null });

  const managedRoots = [KIND_CONFIG.job.root, KIND_CONFIG.epic.root].map((p) => path.resolve(p));
  for (const root of managedRoots) {
    for (const opsDir of findOpsDirsUnder(root, MAX_WALK_DEPTH)) {
      candidates.push({ dir: opsDir, worktreeRoot: path.dirname(opsDir) });
    }
  }
  return candidates;
}

function main(argv) {
  const apply = argv.includes('--apply') && !argv.includes('--dry-run');
  const candidates = findCandidates();

  if (!candidates.length) {
    console.log('No worktree/tmpdir session-manager-operations stubs found.');
    return 0;
  }

  let removed = 0;
  let skipped = 0;
  for (const { dir, worktreeRoot } of candidates) {
    const safe = worktreeRoot ? isSafeToRemove(worktreeRoot, dir) : true;
    if (!safe) {
      console.log(`skipping (tracked or unverifiable)  ${dir}`);
      skipped += 1;
      continue;
    }
    console.log(`${apply ? 'removing' : 'would remove'}  ${dir}`);
    if (apply) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        removed += 1;
      } catch (e) {
        console.error(`failed to remove ${dir}: ${e?.message}`);
      }
    }
  }

  if (!apply) {
    console.log(`\n${candidates.length - skipped} removable, ${skipped} skipped. Re-run with --apply to delete.`);
    return 0;
  }

  console.log(`\nRemoved ${removed} stub(s), skipped ${skipped}.`);
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { main, findCandidates, isSafeToRemove };
