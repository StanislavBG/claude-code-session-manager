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
const { readJsonOr, writeJsonAtomic } = require('../util/atomicFs.cjs');

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

// ─── Persisted per-(cwd, branch) failure backoff (PRD 3494) ────────────────
//
// The in-memory attempted set resets on every restart, so a permanently
// conflicting branch was re-attempted (and re-reported as
// branch_sweep_conflict) at every boot forever — 17 rows across 9 projects on
// the 2026-11-22 reboot. The backoff state below survives restarts: each
// failed attempt bumps a count and pushes the next attempt out exponentially;
// at BRANCH_SWEEP_MAX_FAILURES (or once the owning PRD is skipped/superseded)
// the branch is given up on for good — never retried, never deleted, reported
// exactly once.

const BRANCH_SWEEP_MAX_FAILURES = 3;
const BRANCH_SWEEP_BACKOFF_BASE_MS = 60 * 60 * 1000; // 1 h, doubled per failure
// Row statuses that mean "this PRD will never run again" — a branch they own
// has nothing left to recover into.
const GIVE_UP_ROW_STATUSES = new Set(['skipped', 'cancelled', 'superseded']);

/** Empty backoff state: `{ version, branches: { [branch]: entry } }`. */
function emptyBackoffState() {
  return { version: 1, branches: {} };
}

/** Coerce anything read off disk into a well-formed backoff state. */
function normalizeBackoffState(raw) {
  const out = emptyBackoffState();
  if (!raw || typeof raw !== 'object' || !raw.branches || typeof raw.branches !== 'object') return out;
  for (const [branch, e] of Object.entries(raw.branches)) {
    if (!e || typeof e !== 'object') continue;
    out.branches[branch] = {
      failures: Number.isFinite(e.failures) && e.failures > 0 ? Math.floor(e.failures) : 0,
      lastFailureAt: Number.isFinite(e.lastFailureAt) ? e.lastFailureAt : null,
      nextAttemptAt: Number.isFinite(e.nextAttemptAt) ? e.nextAttemptAt : null,
      lastReason: typeof e.lastReason === 'string' ? e.lastReason : null,
      gaveUp: e.gaveUp === true,
      gaveUpAt: Number.isFinite(e.gaveUpAt) ? e.gaveUpAt : null,
      gaveUpReason: typeof e.gaveUpReason === 'string' ? e.gaveUpReason : null,
      slug: typeof e.slug === 'string' ? e.slug : null,
      reported: e.reported === true,
    };
  }
  return out;
}

/** Read a backoff state file; a missing/garbled file is an empty state. */
async function loadBranchSweepBackoff(file) {
  return normalizeBackoffState(await readJsonOr(file, null));
}

/** Persist a backoff state file atomically. Caller owns the ops-write check. */
async function saveBranchSweepBackoff(file, state) {
  await writeJsonAtomic(file, normalizeBackoffState(state));
}

/**
 * prdGiveUpReason(row) → 'prd-skipped' | 'prd-superseded' | null. A row whose
 * PRD was skipped, cancelled or superseded will never run again, so its
 * stranded branch is given up on without another merge attempt.
 */
function prdGiveUpReason(row) {
  if (!row || typeof row !== 'object') return null;
  if (row.supersededBy) return 'prd-superseded';
  if (!GIVE_UP_ROW_STATUSES.has(row.status)) return null;
  return row.status === 'skipped' ? 'prd-skipped' : 'prd-superseded';
}

/**
 * decideBranchRetry({ entry, row, now }) → { action, reason } — the pure
 * give-up decision. action is one of:
 *   'given-up' — already given up in an earlier pass (never retried)
 *   'give-up'  — give up now without attempting (reason = prd-skipped/superseded,
 *                or max-failures for a legacy entry already at the cap)
 *   'backoff'  — failed before; next attempt not yet due
 *   'attempt'  — try one bounded integration
 */
function decideBranchRetry({ entry, row, now }) {
  if (entry && entry.gaveUp) return { action: 'given-up', reason: entry.gaveUpReason || null };
  const prdReason = prdGiveUpReason(row);
  if (prdReason) return { action: 'give-up', reason: prdReason };
  if (entry && entry.failures >= BRANCH_SWEEP_MAX_FAILURES) return { action: 'give-up', reason: 'max-failures' };
  if (entry && Number.isFinite(entry.nextAttemptAt) && now < entry.nextAttemptAt) {
    return { action: 'backoff', reason: null };
  }
  return { action: 'attempt', reason: null };
}

/**
 * recordBranchFailure(entry, { now, reason, slug }) → new entry with the
 * failure counted, the next attempt pushed out by base·2^(failures-1), and
 * gaveUp set once the count reaches BRANCH_SWEEP_MAX_FAILURES.
 */
function recordBranchFailure(entry, { now, reason = null, slug = null } = {}) {
  const failures = ((entry && entry.failures) || 0) + 1;
  const gaveUp = failures >= BRANCH_SWEEP_MAX_FAILURES;
  return {
    ...emptyEntry(),
    ...(entry || {}),
    failures,
    lastFailureAt: now,
    lastReason: reason,
    nextAttemptAt: gaveUp ? null : now + BRANCH_SWEEP_BACKOFF_BASE_MS * 2 ** (failures - 1),
    slug: slug || (entry && entry.slug) || null,
    gaveUp,
    gaveUpAt: gaveUp ? now : null,
    gaveUpReason: gaveUp ? 'max-failures' : null,
  };
}

function emptyEntry() {
  return {
    failures: 0, lastFailureAt: null, nextAttemptAt: null, lastReason: null,
    gaveUp: false, gaveUpAt: null, gaveUpReason: null, slug: null, reported: false,
  };
}

/** Mark an entry given up (without counting a failure). */
function markGaveUp(entry, { now, reason, slug = null }) {
  return {
    ...emptyEntry(), ...(entry || {}),
    nextAttemptAt: null, gaveUp: true, gaveUpAt: now, gaveUpReason: reason,
    slug: slug || (entry && entry.slug) || null,
  };
}

/**
 * takeUnreportedGiveUps(state) → [{ branch, slug, reason, failures }] for every
 * given-up branch not yet reported, flipping `reported` so the same branch is
 * never reported again (across boots, once the state is saved).
 */
function takeUnreportedGiveUps(state) {
  const out = [];
  for (const [branch, e] of Object.entries((state && state.branches) || {})) {
    if (!e || !e.gaveUp || e.reported) continue;
    e.reported = true;
    out.push({ branch, slug: e.slug || null, reason: e.gaveUpReason || null, failures: e.failures || 0 });
  }
  return out;
}

/** listGivenUpBranches(state) → every given-up branch (reported or not), sorted. */
function listGivenUpBranches(state) {
  return Object.entries((state && state.branches) || {})
    .filter(([, e]) => e && e.gaveUp)
    .map(([branch, e]) => ({ branch, slug: e.slug || null, reason: e.gaveUpReason || null, failures: e.failures || 0 }))
    .sort((a, b) => a.branch.localeCompare(b.branch));
}

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
 *   'skip-backoff'       — failed before; its next attempt is not due yet (backoff only)
 *   'skip-gave-up'       — given up in an earlier pass; never retried (backoff only)
 *   'gave-up'            — given up this pass without an attempt: PRD skipped/superseded (backoff only)
 *
 * `backoff` (optional) = `{ state, now }`: a mutable persisted backoff state
 * (see loadBranchSweepBackoff). When given, the sweep consults
 * decideBranchRetry before each attempt and records each conflict into it
 * (`gaveUp: true` on the conflict result that hits the cap); a success clears
 * the branch's entry. `changed` in the return value says whether the caller
 * must persist the state. Branches are never deleted either way.
 *
 * SM_BRANCH_SWEEP_DISABLE=1 restores today's behaviour exactly (no-op),
 * mirroring SM_RESUME_RECOVERY_DISABLE.
 */
async function sweepStrandedJobBranches({ cwd, jobs, attemptedBranches, backoff }) {
  if (process.env.SM_BRANCH_SWEEP_DISABLE === '1') return { results: [] };
  if (!cwd || !(await gitWorktree.isGitRepo(cwd))) return { results: [] };

  const attempted = attemptedBranches instanceof Set ? attemptedBranches : new Set();
  const bo = backoff && backoff.state && typeof backoff.state === 'object'
    ? { state: backoff.state, now: Number.isFinite(backoff.now) ? backoff.now : Date.now() }
    : null;
  if (bo && (!bo.state.branches || typeof bo.state.branches !== 'object')) bo.state.branches = {};
  let changed = false;
  const branches = await listSmJobBranches(cwd);
  if (!branches.length) return { results: [], changed: false };
  const checkedOut = new Set(await listCheckedOutBranches(cwd));
  const jobsBySlug = new Map((Array.isArray(jobs) ? jobs : []).map((j) => [j.slug, j]));

  const results = [];
  for (const branch of branches) {
    const slug = gitWorktree.keyFromBranch('job', branch);
    if (checkedOut.has(branch)) {
      results.push({ branch, slug, action: 'skip-checked-out' });
      continue;
    }
    const row = slug ? jobsBySlug.get(slug) : null;
    // forkSha bounds both the merged check and integration at the branch's own
    // commits: after main is rebased/reset, the pre-rewrite commits it inherited
    // must neither be replayed back nor keep a replay-landed branch "unmerged".
    const forkSha = await gitWorktree.resolveForkSha({
      cwd, branch, recorded: (row && row.worktreeForkSha) || null,
    });
    const merged = await gitWorktree.isBranchMergedIntoHead(cwd, branch, forkSha);
    if (merged) {
      results.push({ branch, slug, action: 'no-op-merged' });
      continue;
    }
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
    if (bo) {
      const decision = decideBranchRetry({ entry: bo.state.branches[branch], row, now: bo.now });
      if (decision.action === 'given-up') {
        results.push({ branch, slug, action: 'skip-gave-up', reason: decision.reason });
        continue;
      }
      if (decision.action === 'give-up') {
        bo.state.branches[branch] = markGaveUp(bo.state.branches[branch], { now: bo.now, reason: decision.reason, slug });
        changed = true;
        results.push({ branch, slug, action: 'gave-up', reason: decision.reason });
        continue;
      }
      if (decision.action === 'backoff') {
        results.push({ branch, slug, action: 'skip-backoff', nextAttemptAt: bo.state.branches[branch].nextAttemptAt });
        continue;
      }
    }
    attempted.add(attemptKey);
    // baseBranch: read off the job row when one still exists (the crash-between-
    // commit-and-integrate case this sweep exists for) so integration targets the
    // SAME branch the checkout was actually on when the worktree was created —
    // not whatever cwd happens to sit on during this sweep pass. A fully orphaned
    // branch (no row at all) has nothing to read, so it falls back to
    // resolveDefaultBranch(cwd), same as before.
    const integration = await gitWorktree.integrateJobBranch({
      cwd, branch, slug: slug || branch, baseBranch: (row && row.worktreeBaseBranch) || null, forkSha,
    });
    if (!integration.ok) {
      if (bo) {
        const entry = recordBranchFailure(bo.state.branches[branch], { now: bo.now, reason: integration.reason || null, slug });
        bo.state.branches[branch] = entry;
        changed = true;
        results.push({ branch, slug, action: 'conflict', integration, failures: entry.failures, gaveUp: entry.gaveUp });
      } else {
        results.push({ branch, slug, action: 'conflict', integration });
      }
      continue;
    }
    if (bo && bo.state.branches[branch]) {
      delete bo.state.branches[branch];
      changed = true;
    }
    results.push({ branch, slug, action: 'integrated', integration });
  }
  return { results, changed };
}

module.exports = {
  BRANCH_SWEEP_MAX_FAILURES,
  BRANCH_SWEEP_BACKOFF_BASE_MS,
  emptyBackoffState,
  loadBranchSweepBackoff,
  saveBranchSweepBackoff,
  prdGiveUpReason,
  decideBranchRetry,
  recordBranchFailure,
  takeUnreportedGiveUps,
  listGivenUpBranches,
  listSmJobBranches,
  listCheckedOutBranches,
  sweepStrandedJobBranches,
};
