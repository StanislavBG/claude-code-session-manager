/**
 * branchSweep.cjs — periodic recovery for `sm-job/<slug>` branches whose
 * owning job row was terminalized (or lost entirely) without the branch ever
 * being merged back into its project's HEAD (PRD 1135).
 *
 * The reaper's own liveness check (reaperHelpers.cjs findLiveProcessForJob)
 * stops NEW stranding at the source; this module recovers anything already
 * stranded before that fix landed, or by a crash the liveness check can't
 * cover (app killed between a job's commit and its own integrateJobBranch
 * call). Two halves of one invariant — see the PRD body.
 *
 * Deliberately never deletes a branch (`git branch -D` or otherwise) —
 * reclaiming disk is out of scope; this module only ever merges forward.
 *
 * Kept free of scheduler.cjs / electron / queueStore coupling (same reason
 * reaperHelpers.cjs is separate — importable and unit-testable without
 * requiring electron) — callers own persisting a `conflict` result onto a
 * job row.
 */
'use strict';

const gitWorktree = require('./gitWorktree.cjs');
const { execGit: sharedExecGit } = require('./gitExec.cjs');

// Thin re-shape over the shared gitExec.execGit — kept so call sites below
// (positional `timeout`, no `-C` prefix needed) don't all need touching.
function execGit(cwd, args, timeout = 20_000) {
  return sharedExecGit(cwd, args, { timeout });
}

/** List every local branch under `refs/heads/sm-job/*`. Never throws. */
async function listSmJobBranches(cwd) {
  try {
    const out = await execGit(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/sm-job/*']);
    return out.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** Branch names currently checked out in any linked worktree (incl. main). Never throws. */
async function listCheckedOutBranches(cwd) {
  try {
    const out = await execGit(cwd, ['worktree', 'list', '--porcelain']);
    return gitWorktree.parseWorktreeListPorcelain(out)
      .map((e) => e.branch)
      .filter(Boolean);
  } catch {
    return [];
  }
}

const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'skipped']);

/**
 * sweepStrandedJobBranches({ cwd, jobs, attemptedBranches }) → { results }
 *
 * `jobs` is the full in-memory queue snapshot (any project's rows may be
 * present; matched by slug only, since a slug is globally unique). `attemptedBranches`
 * is a caller-owned `Set` of `"<cwd>::<branch>"` keys — persisted across calls
 * (in-memory is enough: the goal is "not retried every cycle forever" while
 * the process is up, not durability across a restart) so a branch that
 * conflicts once is never retried again in the same process lifetime.
 *
 * Each result is `{ branch, slug, action }` where action is one of:
 *   'skip-checked-out'   — branch is checked out in a live worktree, left alone
 *   'no-op-merged'       — branch has no commits beyond HEAD, nothing to do
 *   'skip-active-row'    — job row exists and is NOT terminal, left alone
 *   'skip-already-attempted' — a prior sweep already tried and failed this branch
 *   'integrated'         — merged into HEAD this pass (`integration` attached)
 *   'conflict'           — one bounded integrateBranch attempt failed (`integration` attached)
 *
 * SM_BRANCH_SWEEP_DISABLE=1 restores today's behaviour exactly (no-op),
 * mirroring SM_RESUME_RECOVERY_DISABLE.
 */
async function sweepStrandedJobBranches({ cwd, jobs, attemptedBranches }) {
  if (process.env.SM_BRANCH_SWEEP_DISABLE === '1') return { results: [] };
  if (!cwd || !(await gitWorktree.isGitRepo(cwd))) return { results: [] };

  const attempted = attemptedBranches instanceof Set ? attemptedBranches : new Set();
  const branches = await listSmJobBranches(cwd);
  if (!branches.length) return { results: [] };
  const checkedOut = new Set(await listCheckedOutBranches(cwd));
  const jobsBySlug = new Map((Array.isArray(jobs) ? jobs : []).map((j) => [j.slug, j]));

  const results = [];
  for (const branch of branches) {
    const slug = gitWorktree.keyFromBranch('job', branch);
    if (checkedOut.has(branch)) {
      results.push({ branch, slug, action: 'skip-checked-out' });
      continue;
    }
    const merged = await gitWorktree.isBranchMergedIntoHead(cwd, branch);
    if (merged) {
      results.push({ branch, slug, action: 'no-op-merged' });
      continue;
    }
    const row = slug ? jobsBySlug.get(slug) : null;
    const terminalOrMissing = !row || TERMINAL_JOB_STATUSES.has(row.status);
    if (!terminalOrMissing) {
      results.push({ branch, slug, action: 'skip-active-row' });
      continue;
    }
    const attemptKey = `${cwd}::${branch}`;
    if (attempted.has(attemptKey)) {
      results.push({ branch, slug, action: 'skip-already-attempted' });
      continue;
    }
    attempted.add(attemptKey);
    // baseBranch: read off the job row when one still exists (the crash-between-
    // commit-and-integrate case this sweep exists for) so integration targets the
    // SAME branch the checkout was actually on when the worktree was created —
    // not whatever cwd happens to sit on during this sweep pass. A fully orphaned
    // branch (no row at all) has nothing to read, so it falls back to
    // resolveDefaultBranch(cwd), same as before.
    const integration = await gitWorktree.integrateJobBranch({
      cwd, branch, slug: slug || branch, baseBranch: (row && row.worktreeBaseBranch) || null,
    });
    results.push({ branch, slug, action: integration.ok ? 'integrated' : 'conflict', integration });
  }
  return { results };
}

module.exports = {
  listSmJobBranches,
  listCheckedOutBranches,
  sweepStrandedJobBranches,
};
