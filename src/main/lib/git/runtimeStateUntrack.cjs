/**
 * runtimeStateUntrack.cjs — find and safely untrack Session Manager runtime
 * state that a project accidentally committed.
 *
 * Why the preconditions: `git rm --cached` committed in a linked worktree and
 * then merged deletes the LIVE files in the main checkout. So the untrack runs
 * only from the project's MAIN checkout, on the default branch, with a clean
 * index, no in-flight merge/rebase/cherry-pick, and no running job.
 *
 * Never edits the root .gitignore: each runtime namespace carries its own
 * self-ignore file (opsOwnership.ensureRuntimeIgnores). Not wired to any UI or
 * MCP route — surface it in a follow-up.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execGit } = require('./gitExec.cjs');
const { RUNTIME_NAMESPACES, OPS_ROOT_DIR } = require('../opsOwnership.cjs');

const ATTRIBUTION = 'Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>';
const RM_BATCH = 200;

const nsPathspecs = () => RUNTIME_NAMESPACES.map((ns) => `${OPS_ROOT_DIR}/${ns}`);

/** Tracked paths (repo-relative, posix) under runtime namespaces, README.md excluded. */
async function findTrackedRuntimeState(projectRoot) {
  let out;
  try {
    out = await execGit(projectRoot, ['ls-files', '-z', '--', ...nsPathspecs()], { maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return [];
  }
  return out.split('\0').filter((p) => p && path.posix.basename(p) !== 'README.md');
}

/** Sorted list of every file on disk under the runtime namespaces. */
function listRuntimeFilesOnDisk(projectRoot) {
  const found = [];
  const walk = (abs, rel) => {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(path.join(abs, e.name), r);
      else found.push(r);
    }
  };
  for (const ns of RUNTIME_NAMESPACES) {
    walk(path.join(projectRoot, OPS_ROOT_DIR, ns), `${OPS_ROOT_DIR}/${ns}`);
  }
  return found.sort();
}

async function git(cwd, args) {
  return (await execGit(cwd, args)).trim();
}

async function defaultBranchOf(cwd) {
  try {
    const ref = await git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    if (ref) return ref.replace(/^origin\//, '');
  } catch { /* no remote HEAD */ }
  for (const b of ['main', 'master']) {
    try {
      await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`]);
      return b;
    } catch { /* try next */ }
  }
  return null;
}

/**
 * untrackRuntimeState(projectRoot, opts) → { ok, reason?, removed?, committed? }
 * opts: { isProjectBusy: () => boolean|Promise<boolean> (required),
 *         defaultBranch?: string }
 * On refusal nothing is touched.
 */
async function untrackRuntimeState(projectRoot, opts = {}) {
  const refuse = (reason) => ({ ok: false, reason });
  try {
    const gitDir = path.resolve(projectRoot, await git(projectRoot, ['rev-parse', '--git-dir']));
    const commonDir = path.resolve(projectRoot, await git(projectRoot, ['rev-parse', '--git-common-dir']));
    if (gitDir !== commonDir) return refuse('projectRoot is a linked worktree; run from the main checkout');

    const branch = await git(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const def = opts.defaultBranch || await defaultBranchOf(projectRoot);
    if (!def) return refuse('cannot determine the default branch');
    if (branch !== def) return refuse(`HEAD is on '${branch}', not the default branch '${def}'`);

    for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
      if (fs.existsSync(path.join(gitDir, marker))) {
        return refuse(`a merge, rebase or cherry-pick is in progress (${marker})`);
      }
    }

    if ((await git(projectRoot, ['diff', '--cached', '--name-only'])) !== '') {
      return refuse('the index already has staged changes');
    }

    if (typeof opts.isProjectBusy !== 'function') return refuse('opts.isProjectBusy is required');
    if (await opts.isProjectBusy()) return refuse('a job is running for this project');

    const tracked = await findTrackedRuntimeState(projectRoot);
    if (tracked.length === 0) return { ok: true, removed: 0, committed: false };

    const before = listRuntimeFilesOnDisk(projectRoot);
    for (let i = 0; i < tracked.length; i += RM_BATCH) {
      await execGit(projectRoot, ['rm', '-r', '--cached', '-q', '--', ...tracked.slice(i, i + RM_BATCH)], { timeout: 120_000 });
    }
    const msg = `chore(ops): untrack Session Manager runtime state (${tracked.length} files)\n\n${ATTRIBUTION}`;
    await execGit(projectRoot, ['commit', '-m', msg], { timeout: 60_000 });

    const after = listRuntimeFilesOnDisk(projectRoot);
    if (before.length !== after.length || before.some((f, i) => f !== after[i])) {
      return { ok: false, reason: 'on-disk runtime file list changed across the untrack', removed: tracked.length, committed: true };
    }
    return { ok: true, removed: tracked.length, committed: true };
  } catch (err) {
    return refuse(`git failed: ${(err && (err.stderrText || err.message)) || err}`);
  }
}

module.exports = { findTrackedRuntimeState, untrackRuntimeState, listRuntimeFilesOnDisk };
