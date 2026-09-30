/**
 * jobLanding.cjs — checkout-free "land on the Epic's integration branch,
 * then try to promote" orchestration the scheduler calls instead of
 * `gitWorktree.integrateJobBranch` once a job carries an `epicId`.
 *
 * Two-step happy path, neither of which ever touches a human's or a
 * sibling job's own working tree/index/HEAD until promotion decides it is
 * actually safe to do so:
 *
 *   1. Land the job branch onto the per-Epic `sm-land/<epicId>` ref via
 *      `gitWorktree.integrateOntoRef` (pure object-database CAS — see that
 *      function's header in gitWorktree.cjs).
 *   2. Try to promote `sm-land/<epicId>` into the human's base branch: an
 *      in-checkout merge (`gitWorktree.integrateBranch`, existing
 *      dirty-path handling) when the base branch happens to be checked out
 *      right now, otherwise another checkout-free `integrateOntoRef` CAS.
 *
 * Promotion failing (checkout on another branch AND the base branch is
 * itself checked out elsewhere, or an in-checkout dirty-path collision)
 * never fails the job — the job's own commit already safely landed on
 * `sm-land/<epicId>` in step 1, so the result carries `landPending` instead
 * and the human/scheduler can promote later. Only a genuine content
 * conflict AT STEP 1 (two job branches disagreeing on the same lines) is a
 * real failure — the existing needs_review/investigation ladder handles it
 * exactly as it already does for `integrateJobBranch`.
 *
 * No `epicId` (or a `git_too_old` step-1 failure, i.e. this git predates
 * `git merge-tree --write-tree`) delegates straight to the legacy
 * `gitWorktree.integrateJobBranch` in-checkout path, unchanged.
 *
 * Git is only ever invoked via `execFile('git', argv, ...)` — no shell, no
 * string-interpolated command line. `epicId` is never used to build a path
 * or ref directly here; `gitWorktree.ensureLandBranch`/`landBranchNameFor`
 * own the one sanitization point for that.
 */

'use strict';

const { execFile } = require('node:child_process');
const gitWorktree = require('./gitWorktree.cjs');

function execGit(args, { cwd, timeout = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) {
        err.stderrText = stderr;
        err.stdoutText = stdout;
        reject(err);
        return;
      }
      resolve(stdout || '');
    });
  });
}

/**
 * True when `branch` is checked out in ANY worktree of the repo at `cwd`
 * (including `cwd` itself) — same porcelain parse `integrateOntoRef` uses
 * internally to refuse touching a checked-out ref, exposed here so
 * `promoteLandBranch` can decide up front whether the checkout-free path is
 * even worth attempting. Fails safe: any read failure reports `true` (assume
 * checked out somewhere) so a promotion attempt never mistakenly clobbers a
 * live checkout it couldn't actually see.
 */
async function isBranchCheckedOutAnywhere({ cwd, branch }) {
  try {
    const out = await execGit(['worktree', 'list', '--porcelain'], { cwd, timeout: 15_000 });
    const entries = gitWorktree.parseWorktreeListPorcelain(out);
    return entries.some((e) => e.branch === branch);
  } catch {
    return true;
  }
}

/**
 * Resolves the same effective base-branch fallback `integrateBranch`/
 * `ensureLandBranch` already apply (a falsy or `sm-*`-managed `baseBranch`
 * falls back to `resolveDefaultBranch(cwd)`) so this module never drifts
 * from their rule.
 */
async function resolveEffectiveBaseBranch(cwd, baseBranch) {
  return (typeof baseBranch === 'string' && baseBranch && !gitWorktree.isOwnManagedBranch(baseBranch))
    ? baseBranch
    : gitWorktree.resolveDefaultBranch(cwd);
}

/**
 * Step 3: try to promote the per-Epic `sm-land/<epicId>` branch into the
 * human's base branch. Never throws; always resolves to
 * `{ promoted: boolean, baseBranch, reason? }` — `reason` is set only when
 * `promoted` is false, for the caller to surface as `landPending.reason`.
 */
async function promoteLandBranch({ cwd, epicId, baseBranch }) {
  const landBranch = gitWorktree.landBranchNameFor(epicId);
  const effectiveBase = await resolveEffectiveBaseBranch(cwd, baseBranch);

  const current = await gitWorktree.getCurrentBranch(cwd);
  if (current === effectiveBase) {
    const result = await gitWorktree.integrateBranch({
      cwd,
      branch: landBranch,
      key: epicId,
      kind: 'job',
      baseBranch: effectiveBase,
    });
    if (result.ok) return { promoted: true, baseBranch: effectiveBase };
    return { promoted: false, baseBranch: effectiveBase, reason: result.reason || result.failureKind || 'in-checkout promotion failed' };
  }

  if (await isBranchCheckedOutAnywhere({ cwd, branch: effectiveBase })) {
    return {
      promoted: false,
      baseBranch: effectiveBase,
      reason: `base branch "${effectiveBase}" is checked out elsewhere and cwd is on "${current === null ? 'detached HEAD' : current}"`,
    };
  }

  const result = await gitWorktree.integrateOntoRef({
    cwd,
    targetRef: `refs/heads/${effectiveBase}`,
    branch: landBranch,
    message: `land epic ${epicId}`,
  });
  if (result.ok) return { promoted: true, baseBranch: effectiveBase };
  return { promoted: false, baseBranch: effectiveBase, reason: result.reason || result.failureKind || 'checkout-free promotion failed' };
}

/**
 * Lands a scheduler job branch, then tries to promote. See module header.
 */
async function landJobBranch({ cwd, branch, slug, epicId, baseBranch, carriedPaths }) {
  if (!epicId) {
    return gitWorktree.integrateJobBranch({ cwd, branch, slug, carriedPaths, baseBranch });
  }

  if (await gitWorktree.isCarriedWipOnly({ cwd, branch, carriedPaths })) {
    return { ok: true, integrated: false, reason: 'carried-wip-only' };
  }

  const land = await gitWorktree.ensureLandBranch({ cwd, epicId, baseBranch });
  if (!land.ok) {
    return { ok: false, reason: land.reason };
  }

  const landResult = await gitWorktree.integrateOntoRef({
    cwd,
    targetRef: land.ref,
    branch,
    message: `merge scheduler job ${slug || branch}`,
  });

  if (landResult.failureKind === 'git_too_old') {
    return gitWorktree.integrateJobBranch({ cwd, branch, slug, carriedPaths, baseBranch });
  }

  if (!landResult.ok) {
    return { ok: false, ...landResult, landedOn: land.branch };
  }

  const promo = await promoteLandBranch({ cwd, epicId, baseBranch });
  if (promo.promoted) {
    return { ok: true, integrated: true, landedOn: land.branch, promoted: true };
  }
  return {
    ok: true,
    integrated: true,
    landedOn: land.branch,
    promoted: false,
    landPending: { branch: land.branch, baseBranch: promo.baseBranch, reason: promo.reason },
  };
}

module.exports = {
  landJobBranch,
  promoteLandBranch,
  isBranchCheckedOutAnywhere,
};
