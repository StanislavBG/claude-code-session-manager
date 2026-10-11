/**
 * scheduler/gitTreeGuard.cjs — git status/stash/HEAD helpers, the shared-tree
 * guard, commit-guard/attribution and finalize-drop predicates. Extracted
 * verbatim from scheduler.cjs; internal calls go through module.exports (spy seam).
 */
'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const gitWorktree = require('../lib/gitWorktree.cjs');
const sharedGitExec = require('../lib/gitExec.cjs');
const { resolveProjectRoot } = require('../lib/opsOwnership.cjs');

// Unquote a single git porcelain v1 path token. Defined once in
// gitWorktree.cjs (which this file already requires — the reverse would be
// circular, since gitWorktree.cjs's own salvageDirtyDelta needs the exact
// same unquoting) and reused here rather than re-implemented, so the two
// porcelain consumers in this codebase can never drift apart.
const { unquotePorcelainPath } = gitWorktree;

// Split a rename/copy porcelain path field ("old -> new") into its two real
// paths. Each side is independently quoted per unquotePorcelainPath's rule —
// only the side that needs escaping is wrapped in quotes, the literal " -> "
// arrow between them never is. Returns null when no " -> " separator is
// found (a malformed/unexpected line) so the caller can fall back to treating
// the whole field as one opaque path rather than guessing.
function splitRenamePorcelainField(field) {
  const arrow = ' -> ';
  let head;
  let rest;
  if (field[0] === '"') {
    let end = -1;
    for (let i = 1; i < field.length; i += 1) {
      if (field[i] === '\\') { i += 1; continue; }
      if (field[i] === '"') { end = i; break; }
    }
    if (end === -1) return null;
    head = field.slice(0, end + 1);
    rest = field.slice(end + 1);
  } else {
    const idx = field.indexOf(arrow);
    if (idx === -1) return null;
    // An unquoted path containing a literal " -> " substring (git only
    // quotes for a quote/backslash/control-byte/non-ASCII byte — a plain
    // ASCII arrow inside a filename is never quoted) makes the true
    // old/new boundary genuinely ambiguous from this text alone: the first
    // occurrence could be the real separator, or it could be sitting
    // inside the old path with the real separator later in the field.
    // Guessing wrong silently corrupts oldPath/path for downstream
    // fs.existsSync/Set-membership checks, which is worse than the
    // existing "malformed line" fallback below — so more than one
    // occurrence falls back to treating the whole field as one opaque
    // path, same as any other line this function can't confidently parse.
    if (field.indexOf(arrow, idx + arrow.length) !== -1) return null;
    head = field.slice(0, idx);
    rest = field.slice(idx);
  }
  if (!rest.startsWith(arrow)) return null;
  return { oldPath: unquotePorcelainPath(head), path: unquotePorcelainPath(rest.slice(arrow.length)) };
}

// Parse `git status --porcelain` output into `{ code, path }` entries (plus
// `oldPath` for a rename/copy). Pure + exported for unit testing. Each
// porcelain line is "XY<space>PATH"; a staged rename/copy line is
// "XY<space>OLD -> NEW" instead — X (index status) is 'R' or 'C' — and NEW is
// the path git will report in any later `git status` call, so callers that
// key off `.path` (dirtyAfter membership, pathsCommittedDuringRun membership,
// fs.existsSync) must compare against NEW, never the fused "OLD -> NEW"
// string. `oldPath` is retained on the entry for callers that need the
// original path too. `code` is the raw 2-char status (e.g. '??' for
// untracked) — callers that need to distinguish "untracked" from
// "tracked-but-modified" (the shared-tree guard's revert-vs-now-ignored
// split) read it off the entry instead of re-deriving it later.
function parsePorcelainEntries(stdout) {
  return String(stdout || '')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => {
      const code = l.slice(0, 2);
      const field = l.slice(3);
      if (code.includes('R') || code.includes('C')) {
        const split = module.exports.splitRenamePorcelainField(field);
        if (split) return { code, path: split.path, oldPath: split.oldPath };
      }
      return { code, path: unquotePorcelainPath(field) };
    })
    .filter((e) => e.path);
}

// Parse `git status --porcelain` output into a list of changed paths. Pure +
// exported for unit testing.
function parsePorcelain(stdout) {
  return module.exports.parsePorcelainEntries(stdout).map((e) => e.path);
}

// Same as uncommittedChanges but keeps each path's porcelain status code —
// the shared-tree guard's baseline needs this to tell "was untracked" apart
// from "was tracked-and-modified" (see evaluateSharedTreeGuard). Returns null
// when the guard does not apply (cwd is not a git work tree, git is missing,
// or the call errors); never throws — a guard failure must not fail an
// otherwise-successful job.
function uncommittedChangesWithStatus(cwd) {
  return new Promise((resolve) => {
    if (!cwd) { resolve(null); return; }
    execFile(
      'git',
      ['-C', cwd, 'status', '--porcelain'],
      { timeout: 10_000, windowsHide: true },
      (err, stdout) => {
        if (err) { resolve(null); return; }
        resolve(module.exports.parsePorcelainEntries(stdout));
      },
    );
  });
}

// Return the list of uncommitted paths in cwd, or null under the same
// conditions as uncommittedChangesWithStatus (never throws). Kept as a thin
// path-only projection of that call rather than its own execFile, so a future
// fix to the git invocation (timeout, error handling) can't land in one and
// silently miss the other.
function uncommittedChanges(cwd) {
  return module.exports.uncommittedChangesWithStatus(cwd).then((entries) => (
    entries === null ? null : entries.map((e) => e.path)
  ));
}

// Return the current HEAD commit sha in cwd, or null on any error. Used by the
// commit-guard to detect whether the job self-committed during its run (HEAD
// moved) — in which case leftover working-tree dirt is presumptively from a
// concurrent external writer, not the job's unsaved deliverable. Never throws.
function gitHead(cwd) {
  return new Promise((resolve) => {
    if (!cwd) { resolve(null); return; }
    execFile(
      'git',
      ['-C', cwd, 'rev-parse', 'HEAD'],
      { timeout: 10_000, windowsHide: true },
      (err, stdout) => { resolve(err ? null : String(stdout || '').trim() || null); },
    );
  });
}

// Return the current `git stash list` entries in cwd as raw lines
// "<hash> <ref> <subject>" (hash is stable even as ref indices shift when a
// new entry is pushed on top), or null when the guard does not apply (cwd is
// not a git work tree, git is missing, or the call errors). Never throws.
function stashList(cwd) {
  return new Promise((resolve) => {
    if (!cwd) { resolve(null); return; }
    execFile(
      'git',
      ['-C', cwd, 'stash', 'list', '--format=%H %gd %gs'],
      { timeout: 10_000, windowsHide: true },
      (err, stdout) => {
        if (err) { resolve(null); return; }
        resolve(String(stdout || '').split('\n').filter(Boolean));
      },
    );
  });
}

// Parse one `stashList()` line into { hash, ref, subject }. Pure, exported
// for unit testing. Returns null for a malformed line.
function parseStashLine(line) {
  const m = /^(\S+)\s+(\S+)\s+(.*)$/.exec(String(line || ''));
  return m ? { hash: m[1], ref: m[2], subject: m[3] } : null;
}

// Paths touched by any commit landed in cwd strictly between headBefore and
// headAfter. Returns [] when no commit landed (headBefore === headAfter, or
// either is missing) — used by the shared-tree guard below to tell a path
// the job legitimately committed apart from a path that just silently went
// quiet with nothing to explain it. Never throws.
function pathsChangedSince(cwd, headBefore, headAfter) {
  return new Promise((resolve) => {
    if (!cwd || !headBefore || !headAfter || headBefore === headAfter) { resolve([]); return; }
    execFile(
      'git',
      ['-C', cwd, 'diff', '--name-only', `${headBefore}..${headAfter}`],
      { timeout: 10_000, windowsHide: true },
      (err, stdout) => { resolve(err ? [] : String(stdout || '').split('\n').filter(Boolean)); },
    );
  });
}

// Restore ONE specific stash ref (never a blanket pop of "whatever is on
// top") into cwd: apply, then drop only on a clean apply. On conflict the
// entry is left in place — never dropped, never forced — so the operator's
// own `git stash pop`/`apply` still works afterward. Never throws.
function restoreSpecificStash(cwd, ref) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, 'stash', 'apply', ref], { timeout: 10_000, windowsHide: true }, (applyErr, _stdout, applyStderr) => {
      if (applyErr) {
        resolve({ ok: false, error: String(applyStderr || applyErr.message || applyErr).trim().split('\n')[0] });
        return;
      }
      execFile('git', ['-C', cwd, 'stash', 'drop', ref], { timeout: 10_000, windowsHide: true }, () => {
        resolve({ ok: true });
      });
    });
  });
}

// Diff a before/after `stashList()` pair plus a before/after dirty-path pair
// to find what an in-place job silently discarded from a tree it shares with
// something else (Incident: social-signals-trader 2026-09-01, a blanket
// `git stash` reverted a live operator config edit with no error anywhere).
// Two independent signals, either of which means the job discarded state it
// did not create:
//   - newStashes: a stash entry now present that wasn't in the baseline —
//     the job ran `git stash` itself.
//   - reverted: a path that was dirty in the baseline, is clean now, and was
//     not touched by any commit landed during the run — the job reset/
//     checked-out over pre-existing uncommitted work without stashing it.
//
// A THIRD outcome is not a revert at all: an untracked path can drop out of
// `git status` because the run committed a `.gitignore` change that now
// matches it — the file is untouched on disk, just no longer visible to git
// (Incident: 2026-09-12, PRD 1181 added a bare `logs/` ignore pattern, eleven
// untracked `session-manager-operations/logs/*` paths vanished from status,
// and an otherwise-perfect run was parked in needs_review for a human who had
// nothing to decide). `dirtyBefore` entries therefore carry each path's
// porcelain status code (`{ code, path }`, from parsePorcelainEntries) so this
// function can tell "was untracked" apart from "was tracked-and-modified":
//   - a TRACKED path (any code other than '??') leaving the dirty set always
//     means its content was restored to HEAD — still `reverted`, even though
//     the file still exists on disk, because for a tracked file "exists" is
//     not the question; "matches what the human left uncommitted" is.
//   - an UNTRACKED path ('??') leaving the dirty set is `reverted` only if it
//     no longer exists on disk; if it still exists, it merely became ignored
//     and is reported separately as `nowIgnored`.
// Plain path strings are still accepted in `dirtyBefore` for callers that
// have no status code (e.g. the stash-detection pass, which always passes an
// empty array) — an entry with no `code` is treated as tracked, matching the
// old behavior exactly.
//
// Pure/no I/O — status-code parsing and on-disk existence checks both happen
// at the call site (checkSharedTreeGuard); this function never stats the
// filesystem. Exported for unit testing.
function evaluateSharedTreeGuard({ stashBefore, stashAfter, dirtyBefore, dirtyAfter, pathsCommittedDuringRun, existsAfter }) {
  const beforeHashes = new Set((stashBefore || []).map((l) => module.exports.parseStashLine(l)?.hash).filter(Boolean));
  const newStashes = (stashAfter || [])
    .map(parseStashLine)
    .filter((e) => e && !beforeHashes.has(e.hash));
  const dirtyAfterSet = new Set(dirtyAfter || []);
  const committedSet = new Set(pathsCommittedDuringRun || []);
  const existsSet = new Set(existsAfter || []);
  const reverted = [];
  const nowIgnored = [];
  for (const entry of dirtyBefore || []) {
    const p = typeof entry === 'string' ? entry : entry.path;
    const code = typeof entry === 'string' ? undefined : entry.code;
    if (dirtyAfterSet.has(p) || committedSet.has(p)) continue;
    if (code === '??' && existsSet.has(p)) {
      nowIgnored.push(p);
    } else {
      reverted.push(p);
    }
  }
  return { newStashes, reverted, nowIgnored };
}

// Post-run shared-tree guard for an IN-PLACE job (worktree.ok === false —
// callers must gate on that; a worktree-isolated run's git state can never
// leak into guardCwd, so there is nothing here to check). Best-effort: never
// throws, never changes the job's exit code. Restores exactly one
// executor-created stash (never guesses when there are 2+); reports anything
// it can't safely resolve on the returned object so the caller can surface it
// on the job row instead of finishing silently green.
async function checkSharedTreeGuard({ cwd, stashBaseline, dirtyBaseline, headBefore, slug, landedCommit }) {
  try {
    const [stashAfter, headAfter] = await Promise.all([
      module.exports.stashList(cwd),
      module.exports.gitHead(cwd),
    ]);
    const pathsCommittedDuringRun = await module.exports.pathsChangedSince(cwd, headBefore, headAfter);
    // First pass: which stashes are new. Decided before charging anything
    // against dirtyBaseline — a path this run's own stash covers must not be
    // judged "reverted" using dirty state captured before the restore below
    // has had a chance to bring it back.
    const { newStashes } = module.exports.evaluateSharedTreeGuard({
      stashBefore: stashBaseline,
      stashAfter,
      dirtyBefore: [],
      dirtyAfter: [],
      pathsCommittedDuringRun,
    });

    const result = {};
    if (newStashes.length === 1) {
      const [entry] = newStashes;
      const restore = await module.exports.restoreSpecificStash(cwd, entry.ref);
      if (restore.ok) {
        result.restoredStash = entry.ref;
        console.log(`[scheduler] ${slug}: restored a stash the job created in the shared tree (${entry.ref})`);
      } else {
        result.restoreFailed = `${entry.ref}: ${restore.error || 'apply failed'}`;
        console.error(`[scheduler] ${slug}: shared-tree guard could not restore ${entry.ref}: ${restore.error}`);
      }
    } else if (newStashes.length > 1) {
      result.ambiguousStashes = newStashes.map((e) => e.ref);
      console.error(`[scheduler] ${slug}: shared-tree guard found ${newStashes.length} stashes the job created — ambiguous, not auto-restoring (${result.ambiguousStashes.join(', ')})`);
    }

    // Second pass: recompute "reverted" against the tree's dirty state AFTER
    // any restore attempt above, so a path that came back via a successfully
    // restored stash is not ALSO reported as an unexplained revert (it was
    // explained — by the stash this guard just restored).
    const dirtyAfter = await module.exports.uncommittedChanges(cwd);
    // Existence check for the "now ignored, not reverted" split (2026-09-12
    // incident) — only untracked baseline entries need it; a tracked path
    // leaving the dirty set is always a revert regardless of disk state (see
    // evaluateSharedTreeGuard). Scoped to entries carrying a status code —
    // plain path strings (no code) fall back to the old always-reverted path.
    const untrackedBaselinePaths = (dirtyBaseline || [])
      .filter((e) => e && typeof e === 'object' && e.code === '??')
      .map((e) => e.path);
    // A large untracked baseline (the 2026-09-12 incident's shared tree had
    // ~240 such paths) makes this a lot of stat calls — fs.promises.access
    // run concurrently instead of fs.existsSync run synchronously one at a
    // time keeps this off the event loop instead of blocking every other
    // in-flight scheduler/IPC task for the duration.
    const existsChecks = await Promise.all(
      untrackedBaselinePaths.map((p) => fsp.access(path.join(cwd, p)).then(() => true, () => false)),
    );
    const existsAfter = untrackedBaselinePaths.filter((_, i) => existsChecks[i]);
    const { reverted, nowIgnored } = module.exports.evaluateSharedTreeGuard({
      stashBefore: stashBaseline,
      stashAfter,
      dirtyBefore: dirtyBaseline,
      dirtyAfter,
      pathsCommittedDuringRun,
      existsAfter,
    });
    // Ground truth outranks the baseline diff (2026-09-18, 1229-fo-03): the
    // dirty baseline is invalidated by ANY later writer (a human commit that
    // sweeps the same paths), so it can't prove a revert on its own. The
    // job's own landedCommit still being an ancestor of HEAD proves its work
    // was not discarded — anchored to that sha, not to the baseline.
    const workSurvives = reverted.length > 0
      && await module.exports.landedCommitIsAncestorOfHead(cwd, landedCommit);
    if (workSurvives) {
      console.log(`[scheduler] ${slug}: shared-tree guard: ${reverted.length} baseline path(s) went clean but landed commit ${String(landedCommit).slice(0, 7)} is still an ancestor of HEAD — not a revert`);
    } else if (reverted.length) {
      result.reverted = reverted;
      console.error(`[scheduler] ${slug}: shared-tree guard: ${reverted.length} path(s) reverted in the shared tree with no commit to explain it (${reverted.slice(0, 3).join(', ')})`);
    }
    if (nowIgnored.length) {
      result.nowIgnored = nowIgnored;
      console.log(`[scheduler] ${slug}: shared-tree guard: ${nowIgnored.length} path(s) no longer shown by git status but still present on disk — likely a new ignore rule, not a revert (${nowIgnored.slice(0, 3).join(', ')})`);
    }
    return (result.restoredStash || result.restoreFailed || result.ambiguousStashes || result.reverted || result.nowIgnored) ? result : null;
  } catch (e) {
    console.error(`[scheduler] ${slug}: shared-tree guard error`, e);
    return null;
  }
}

// True when cwd is inside a git repository. Used to keep a non-git cwd (e.g.
// a scratch dir like /tmp) from ever being handed to an investigation's
// fix-plan as its cwd — the commit guard, worktree isolation, and
// runVerify's PASS+commit sentinel override all read git state from job.cwd,
// so a fix plan rooted at a non-repo path gets parked in needs_review even
// when its commit really landed (Incident: 99-fix-e2e-needs-review-test,
// 2026-08-07 — green, committed 6ecbd40, PASS sentinel, still needs_review).
// Bounded and never throws.
function isGitRepoSync(cwd) {
  if (!cwd) return false;
  try {
    execFileSync('git', ['-C', cwd, 'rev-parse', '--git-dir'], {
      timeout: 10_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

// Best-effort `git fetch --all --prune` in cwd, bounded and never throwing.
// A PRD that does its work in a separate `git worktree add` checkout (per
// standards.md's own recommended pattern for shared repos) commits and pushes
// from THAT worktree, then removes it — the commit never touches job.cwd's
// own refs, so job.cwd's remote-tracking branches can be stale relative to
// what was actually pushed. Refreshing them here is what lets the git log
// --all scan below see a worktree-pushed commit. Resolves once fetch settles
// (or times out / errors) — callers don't need the result, just the refresh.
function fetchAllRefs(cwd) {
  return new Promise((resolve) => {
    if (!cwd) { resolve(); return; }
    execFile(
      'git',
      ['-C', cwd, 'fetch', '--all', '--prune'],
      { timeout: 20_000, windowsHide: true },
      () => resolve(),
    );
  });
}

// Returns true if ≥1 commit landed on any ref (branch, remote-tracking branch,
// or tag) in cwd between startedAt and finishedAt (with 60s slack) — not just
// the currently checked-out branch. Used both by the self-heal pass and by the
// live commit-guard's fallback (see computeCommittedDuringRun) to derive
// committedDuringRun from the recorded run window. Fetches remotes first (see
// fetchAllRefs) so a commit pushed from a separate worktree checkout that was
// since removed is still visible via job.cwd's remote-tracking refs. Never
// throws; git-unavailable → false (no override, job stays as-is).
async function committedInWindow(cwd, startedAt, finishedAt) {
  if (!cwd || !startedAt) return false;
  await module.exports.fetchAllRefs(cwd);
  return new Promise((resolve) => {
    const until = finishedAt
      ? new Date(Date.parse(finishedAt) + 60_000).toISOString()
      : new Date().toISOString();
    execFile(
      'git',
      ['-C', cwd, 'log', '--all', '--format=%H', `--since=${startedAt}`, `--until=${until}`],
      { timeout: 10_000, windowsHide: true },
      (err, stdout) => { resolve(!err && String(stdout || '').trim().length > 0); },
    );
  });
}

// Live commit-guard: cheap HEAD-diff fast path, falling back to the
// git-log --all scan when HEAD didn't move on the starting branch. A PRD that
// checks out other branches, commits real work on each, then checks its
// starting branch back out before exit leaves HEAD unchanged even though
// commits landed — the fallback catches that case. Never throws.
//
// Both signals are known to race against ref/object visibility at the exact
// moment of process exit — a job that commits in a throwaway linked worktree
// and removes it before exiting can have committedInWindow() return false
// even though the commit is real and already pushed (confirmed incidents:
// pass-no-commit-worktree-commit-invisible-at-exit, RCA 770-pr269). When both
// signals say "no commit", wait a short bounded delay and retry once before
// giving up — a replayed identical call moments later reliably finds it.
const COMMIT_GUARD_RETRY_DELAY_MS = 2000;

async function computeCommittedDuringRun(cwd, headBefore, headAfter, startedAt, untilIso) {
  if (headBefore && headAfter && headBefore !== headAfter) return true;
  // Call via module.exports (not the bare local binding) so tests can
  // vi.spyOn(gitTreeGuard, 'committedInWindow') to drive the retry deterministically.
  if (await module.exports.committedInWindow(cwd, startedAt, untilIso)) return true;
  await new Promise((resolve) => { setTimeout(resolve, COMMIT_GUARD_RETRY_DELAY_MS); });
  return module.exports.committedInWindow(cwd, startedAt, untilIso);
}

/**
 * Which commit does this run get credit for? A worktree-isolated run shares the
 * main checkout with concurrent jobs, so a HEAD move there may be someone else's
 * integration — credit comes only from this run's own integration result. An
 * in-place run keeps the HEAD-delta / time-window behaviour.
 */
function resolveRunCommitAttribution({
  ranInWorktree, integratedSha, headBefore, headAtExit, committedInWindow,
  rangeCommits, transcriptCommitShas, siblingOverlap,
}) {
  if (ranInWorktree) {
    const landedCommit = integratedSha || null;
    return { landedCommit, committedDuringRun: Boolean(landedCommit) };
  }
  const shas = Array.isArray(transcriptCommitShas) ? transcriptCommitShas.filter(Boolean) : [];
  if (shas.length === 0 && !siblingOverlap) {
    const headMoved = Boolean(headBefore && headAtExit && headBefore !== headAtExit);
    return {
      landedCommit: headMoved ? headAtExit : null,
      committedDuringRun: headMoved || Boolean(committedInWindow),
    };
  }
  // Shared tree with possible siblings (or transcript evidence): credit only a
  // commit in the range that this run's own transcript reported.
  const own = (Array.isArray(rangeCommits) ? rangeCommits : [])
    .find((c) => shas.some((sha) => c.startsWith(sha)));
  const landedCommit = own || null;
  return { landedCommit, committedDuringRun: Boolean(landedCommit) };
}

/** Full shas in `before..after` (newest first); [] on any error. Never throws. */
function gitRangeCommits(cwd, before, after) {
  return new Promise((resolve) => {
    if (!cwd || !before || !after || before === after) { resolve([]); return; }
    execFile(
      'git', ['-C', cwd, 'rev-list', `${before}..${after}`],
      { timeout: 10_000, windowsHide: true },
      (err, out) => {
        if (err) { resolve([]); return; }
        resolve(String(out || '').split('\n').map((l) => l.trim()).filter(Boolean));
      },
    );
  });
}

/**
 * Read-only check: is a job's `sm-job/<slug>` worktree branch already fully
 * integrated into `cwd`'s current HEAD — i.e. every commit on the branch is
 * an ancestor of (or equal to) HEAD? Mirrors gitWorktree.cjs's own
 * integrateBranch() no-op detection (`mergeBase === branchHead`) exactly, but
 * deliberately never calls integrateBranch itself: this is used by
 * reapDeadRunningJobs to PROVE a dead job's work already landed, never to
 * perform the landing — attempting a real merge from an audit check is a
 * mutating action with its own conflict/timing risk, and "land the still-
 * stranded branch" is explicitly a separate, later decision (mechanical
 * recovery, or a human), not something a reap pass should do on its own
 * initiative. See reapDeadRunningJobs's own header comment for why the
 * conservative failure direction here is needs_review, never a silent merge.
 *
 * Returns:
 *  - true  — branch exists and is fully contained in HEAD (already
 *    integrated by a prior pass, or a genuine no-op branch that never
 *    diverged from its base — both cases legitimately "landed").
 *  - false — branch exists and still holds commits not in HEAD (a real
 *    stranded deliverable, e.g. the PRD 1118 shape).
 *  - null  — branch does not exist at all (never a worktree run — an
 *    in-place run, or SM_JOB_WORKTREE_DISABLE), or the git calls errored.
 * Never throws.
 */
function isBranchAlreadyIntegrated(cwd, branch) {
  return new Promise((resolve) => {
    if (!cwd || !branch) { resolve(null); return; }
    execFile(
      'git', ['-C', cwd, 'rev-parse', '--verify', branch],
      { timeout: 10_000, windowsHide: true },
      (err, branchHeadOut) => {
        if (err) { resolve(null); return; } // branch doesn't exist — not a worktree run
        const branchHead = String(branchHeadOut || '').trim();
        execFile(
          'git', ['-C', cwd, 'merge-base', 'HEAD', branch],
          { timeout: 10_000, windowsHide: true },
          (mbErr, mbOut) => {
            const mergeBase = mbErr ? '' : String(mbOut || '').trim();
            resolve(mergeBase !== '' && mergeBase === branchHead);
          },
        );
      },
    );
  });
}

/**
 * Override for a SIGTERM'd (143) run when a commit landed in its window.
 * Exit 143 alone doesn't prove the deliverable is missing — the 776/779
 * incidents (2026-07-30) both died on a headless-incompatible interactive
 * step (xvfb Electron screenshot / playwright electron.launch) AFTER their
 * commit had already landed, and sat `failed` forever with a real deliverable
 * on disk. A landed commit doesn't prove every AC line passed though (the
 * step it died on is still unverified), so this routes to `needs_review`,
 * never silently promotes to `completed`. Returns null for every other exit
 * code, or for a 143 with no commit found in window — those fall through to
 * the existing `failed` path unchanged. Pure/no I/O: the commit-window scan
 * (committedInWindow) happens at the call site, not here.
 */
function classifySigtermWithCommit(exitCode, commitFoundInWindow) {
  if (exitCode !== 143 || !commitFoundInWindow) return null;
  return {
    status: 'needs_review',
    reason: 'SIGTERM after a commit landed — verify AC before treating as done',
  };
}

/**
 * Pure decision for spawnJob's finalize mutate (2026-09-06 incident): given
 * the row this run is trying to finalize (or its absence) and this run's own
 * identity, decide whether the finalize must be DROPPED instead of applied.
 * Never mutates anything itself — callers apply `stampLandedCommit` and emit
 * the audit event/log line.
 *
 *  - row missing entirely (i2 === -1 upstream): always drop, nothing to
 *    stamp — there is no row left to carry the fact.
 *  - row present but not 'running': drop the STATUS change (a cancelled row,
 *    PRD 1024, must never be re-legalized to completed/needs_review by a
 *    stale exit handler) but still let a genuinely-landed commit be stamped
 *    as a fact — never a transition — when this run owns the row's current
 *    runId, or the row doesn't already carry a newer one of its own.
 *  - row present and 'running': not a drop; caller proceeds to finalize.
 */
function evaluateFinalizeDrop({ rowExists, rowStatus, rowRunId, rowLandedCommit, runId, landedCommit }) {
  if (!rowExists) {
    return { drop: true, reason: 'row-missing', stampLandedCommit: null };
  }
  if (rowStatus !== 'running') {
    const stampLandedCommit = landedCommit && (rowRunId === runId || !rowLandedCommit) ? landedCommit : null;
    return { drop: true, reason: 'row-not-running', stampLandedCommit };
  }
  return { drop: false, reason: null, stampLandedCommit: null };
}

/**
 * Pure decision for spawnJob's dispatch mutate: given a PENDING row about to
 * be dispatched and the newest terminalRunOutcome sidecar result for its
 * slug, decide whether this dispatch should be SKIPPED because a prior run
 * already completed this exact slug — the gap left by reconcile()'s own
 * anti-resurrection guard, which only ever sees a slug BEFORE it first lands
 * in s.jobs (2026-09-06 incident: an existing pending row was re-dispatched
 * three times against already-shipped work).
 *
 * Compares the sidecar's finishedAt against THIS row's own last pending
 * transition (or queuedAt, when the row has never been reset) rather than
 * merely "a completed sidecar exists somewhere" — so a deliberate human
 * re-queue of the same slug in a LATER episode (whose queuedAt/pending
 * transition postdates the earlier completion) still runs.
 */
function evaluateDispatchSidecarReconcile({ rowStatus, rowRunId, statusHistory, queuedAt, outcome }) {
  if (rowStatus !== 'pending') return { skip: false };
  if (!outcome || outcome.status !== 'completed') return { skip: false };
  if (outcome.runId === rowRunId) return { skip: false };
  const lastPendingEntry = Array.isArray(statusHistory)
    ? [...statusHistory].reverse().find((h) => h.to === 'pending')
    : null;
  const lastPendingAt = lastPendingEntry?.at ?? queuedAt ?? null;
  if (lastPendingAt && (!outcome.finishedAt || outcome.finishedAt < lastPendingAt)) {
    return { skip: false };
  }
  return { skip: true, runId: outcome.runId, finishedAt: outcome.finishedAt };
}

/**
 * Pure detector for mutate()'s write-path regression check: transitionJob
 * only ever APPENDS to statusHistory (capped at STATUS_HISTORY_CAP, never
 * shrunk below it once reached) — so a running->pending change whose
 * statusHistory got SHORTER is not a real transition, it's evidence this
 * row's prior state was lost (e.g. a finalize mutate working off a stale
 * in-memory snapshot).
 */
function isQueueRowRegression({ statusBefore, statusAfter, historyLenBefore, historyLenAfter }) {
  return statusBefore === 'running' && statusAfter === 'pending' && historyLenAfter < historyLenBefore;
}

/**
 * True when `sha` is a non-empty commit that is an ancestor of (or equal to)
 * HEAD in the repo at `cwd` (`git merge-base --is-ancestor`). Bounded, never
 * throws: an empty sha, an unknown sha, or any git failure is `false`, so the
 * caller's safe default is "cannot prove the work survived".
 */
async function landedCommitIsAncestorOfHead(cwd, sha) {
  if (!sha || typeof sha !== 'string' || !cwd) return false;
  try {
    await sharedGitExec.execGit(resolveProjectRoot(cwd), ['merge-base', '--is-ancestor', sha, 'HEAD'], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  splitRenamePorcelainField,
  parsePorcelainEntries,
  parsePorcelain,
  uncommittedChangesWithStatus,
  uncommittedChanges,
  gitHead,
  stashList,
  parseStashLine,
  pathsChangedSince,
  restoreSpecificStash,
  evaluateSharedTreeGuard,
  checkSharedTreeGuard,
  isGitRepoSync,
  fetchAllRefs,
  committedInWindow,
  computeCommittedDuringRun,
  resolveRunCommitAttribution,
  gitRangeCommits,
  isBranchAlreadyIntegrated,
  classifySigtermWithCommit,
  evaluateFinalizeDrop,
  evaluateDispatchSidecarReconcile,
  isQueueRowRegression,
  landedCommitIsAncestorOfHead,
};
