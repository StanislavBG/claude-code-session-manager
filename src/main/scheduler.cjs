/**
 * scheduler.cjs — runs queued PRDs as headless `claude -p` jobs around
 * the next 5h token-window reset.
 *
 * Layout (under ~/.claude/session-manager/scheduled-plans/):
 *   prds/NN-slug.md      → user/Claude-authored PRD files (source of truth)
 *   queue.json           → scheduler state: schedule, runs, status per PRD
 *   runs/<ISO>/<slug>.log → captured stdout/stderr for one execution
 *   runs/<ISO>/<slug>.meta.json → per-job metadata (exit, duration, cwd)
 *
 * Time:
 *   - "Next reset" comes from /api/oauth/usage five_hour.resets_at
 *     (already exposed via billing.fetchUsage()).
 *   - Trigger fires at resets_at + offsetMinutes (default 15).
 *   - We schedule a single setTimeout for the next fire-time. On schedule
 *     change (queue updated, reset_at moves) we cancel + reschedule.
 *
 * Parallelism:
 *   - PRD filename `NN-slug.md` — `NN` is the parallel group. All PRDs in
 *     the same group launch simultaneously; the next group only starts
 *     after the previous group's jobs all settle.
 *   - User-set concurrency cap (default 5) is the within-group ceiling. If
 *     a group has more PRDs than the cap, the excess waits until a slot
 *     frees in that group.
 *
 * Execution:
 *   - `claude -p "<PRD body>" --model sonnet --dangerously-skip-permissions`
 *     per PRD. Backlog runs on Sonnet; interactive sessions stay on Opus.
 *   - Stdout/stderr → runs/<ts>/<slug>.log; meta json gets exit + duration.
 *   - PRD frontmatter `cwd` → child cwd. Default: PROJECT_CWD const below.
 *
 * Persistence:
 *   - queue.json is the system of record for scheduling. Edited atomically
 *     via fs.writeFileSync(tmp) + rename.
 *   - On startup, walk prds/, ensure every .md has a queue.json entry.
 *     Orphaned entries (.md gone) are pruned.
 *
 * Renderer events:
 *   - 'schedule:state' broadcasts the full state on mutation. Keeps the
 *     panel UI dead simple — no diff machinery. Sends are trailing-edge
 *     debounced (~BROADCAST_COALESCE_MS) by default so a burst of mutations
 *     collapses into one push; state-machine transitions (pause/resume, job
 *     start/finish) call broadcast({ flush: true }) to bypass the window.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { execFile, execFileSync } = require('node:child_process');
const { ipcMain } = require('electron');
const billing = require('./usage.cjs');
const { cleanChildEnv, pathWithUserBins } = require('./lib/cleanEnv.cjs');
const supervisor = require('./supervisor.cjs');
const { resolveClaudeBin, probeClaudeVersion } = require('./lib/claudeBin.cjs');
const launchFailure = require('./lib/launchFailure.cjs');
const { appendError } = require('./lib/opsErrorLog.cjs');
const { readTail } = require('./lib/fileTail.cjs');
const { claudePidAlive, classifyRunOutcome, mapOutcomeToGateOutcome, ORPHAN_REQUEUE_CAP, selectReapableJobs } = require('./lib/reaperHelpers.cjs');
const { detectRateLimitInLog } = require('./lib/rateLimitDetect.cjs');
const { stripAppOwnedChurn } = require('./lib/jobDirtFilter.cjs');
const { computeQueueHealth } = require('./lib/queueHealth.cjs');
const { createLoadGate, topCpuConsumers } = require('./lib/loadGate.cjs');
const { openLog, withChildAndLog } = require('./lib/childWithLog.cjs');
const { sendIfAlive } = require('./lib/sendToRenderer.cjs');
const { createBroadcastCoalescer } = require('./lib/broadcastCoalescer.cjs');
const prdParser = require('./scheduler/prdParser.cjs');
const sessionsStore = require('./sessionsStore.cjs');
const { enqueueExternalPrompt } = require('./chatRunner.cjs');
const { appendResponseEventIfKnown } = require('./promptSessionEvents.cjs');
const { maybeEnqueueValidationPrompt } = require('./lib/epicValidationHook.cjs');
const promptSessionTranscript = require('./promptSessionTranscript.cjs');
const { verifyRun } = require('./runVerify.cjs');
const { latestTerminalOutcomeForSlug, COMPLETED_EQUIVALENT_VERDICTS } = require('./lib/terminalRunOutcome.cjs');
const { landedSinceRun } = require('./lib/landedSinceRun.cjs');
const { declaredPathsForPrd } = require('./lib/prdDeclaredPaths.cjs');
const logs = require('./logs.cjs');
const { schemas, validated, SCHEDULE_SLUG_RE } = require('./ipcSchemas.cjs');
const { readBody, sendJson } = require('./lib/localAdminHttp.cjs');
const {
  POLL_INTERVAL_MS,
  USAGE_REFRESH_INTERVAL_MS,
  MAX_JOB_DURATION_MS,
  BROADCAST_COALESCE_MS,
  QUARANTINE_ESCALATE_MS: QUARANTINE_ESCALATE_MS_DEFAULT,
  JOB_OVERRUN_FACTOR: JOB_OVERRUN_FACTOR_DEFAULT,
  JOB_OVERRUN_FLOOR_MS: JOB_OVERRUN_FLOOR_MS_DEFAULT,
  PIDLESS_SPAWN_GRACE_MS,
  INVESTIGATION_MAX_MS,
  STARVATION_ESCALATE_MS,
} = require('./lib/schedulerConfig.cjs');
const QUARANTINE_ESCALATE_MS = process.env.SM_QUARANTINE_ESCALATE_HOURS
  ? Number(process.env.SM_QUARANTINE_ESCALATE_HOURS) * 60 * 60_000
  : QUARANTINE_ESCALATE_MS_DEFAULT;
const JOB_OVERRUN_FACTOR = process.env.SM_JOB_OVERRUN_FACTOR
  ? Number(process.env.SM_JOB_OVERRUN_FACTOR)
  : JOB_OVERRUN_FACTOR_DEFAULT;
const JOB_OVERRUN_FLOOR_MS = process.env.SM_JOB_OVERRUN_FLOOR_MINUTES
  ? Number(process.env.SM_JOB_OVERRUN_FLOOR_MINUTES) * 60_000
  : JOB_OVERRUN_FLOOR_MS_DEFAULT;
const { pickForProject, pickNextBatch, findStarvedProjects, DEFAULT_PROJECT_CWD } = require('./lib/schedulerBatch.cjs');
const { runDefinitionOfDoneOnDrain } = require('./lib/dodDrainHook.cjs');
const { writeRcaReport, extractRcaBlock } = require('./lib/rcaReport.cjs');
const queueHistory = require('./lib/queueHistory.cjs');
const queueOps = require('./queueOps.cjs');
// Feedback-auto-PRD sweep — formerly only run by the external scheduler-watchdog
// while the app was down (PRD 686 moved it in-app so it also runs while alive).
// Plain Node module, no Electron dependency; queuePath/prdsDir defaults already
// match ROOT/QUEUE_PATH below since both resolve the same ~/.claude/session-manager
// home-dir layout.
const { resolvePrdsDirs, resolveArchivedPrdsDirs, resolvePrdWriteDir, listEpicPrdDirs, listArchivedPrdDirs } = require('./lib/prdLocations.cjs');
const { ensureEpic, appendPrdCreatedEvent, readActiveIndex } = require('./lib/epicMint.cjs');
const agentModelResolve = require('./lib/agentModelResolve.cjs');
const { transitionJob, STATUS_HISTORY_CAP, LEGAL_TRANSITIONS } = require('./lib/scheduleJobTransitions.cjs');
const { buildContextDigest, composeExecutorPrompt } = require('./lib/epicContextDigest.cjs');
const { JOB_STATUSES } = require('./lib/scheduleJobSchema.cjs');
const { appendAuditEvent } = require('./lib/auditLog.cjs');

// ---------- origin session resolution (PRD 832) ----------
// An Epic IS a tagged claude session — job rows carry the originating
// claudeSessionId alongside sourcePromptId so every PRD stays traceable to
// the session that spawned it. active-index.json is tiny; a short TTL cache
// keeps reconcile (every 60s, N jobs) at one read per project per pass.
const originIndexCache = new Map(); // cwd -> { at, sessions }
const ORIGIN_CACHE_TTL_MS = 30_000;
function resolveOriginSessionId(cwd, epicId) {
  if (!cwd || !epicId) return null;
  let entry = originIndexCache.get(cwd);
  if (!entry || Date.now() - entry.at > ORIGIN_CACHE_TTL_MS) {
    entry = { at: Date.now(), sessions: readActiveIndex(cwd).sessions };
    originIndexCache.set(cwd, entry);
  }
  const session = entry.sessions[epicId];
  return session && typeof session.claudeSessionId === 'string' ? session.claudeSessionId : null;
}
const sessionSlots = require('./lib/sessionSlots.cjs');
const quietMachineLease = require('./lib/quietMachineLease.cjs');
const jobWorktree = require('./lib/jobWorktree.cjs');
const { reconcileEpicWorktreesOnBoot } = require('./lib/epicWorktreeBoot.cjs');
const queueStore = require('./lib/queueStore.cjs');
const { splitFrontmatter, parsePrdFile, serializePrdFile } = require('./lib/prdFrontmatter.cjs');
const { migratePrds, consolidateFlatPrds, legacyAdoptExistingPrds } = require('./lib/prdMigration.cjs');
const { allProjectCwds } = require('../../scripts/lib/activeSessions.cjs');

// Captured once at module load so every run's meta sidecar can record how
// stale the running process is relative to on-disk source (incident: PRD
// 812-commit-guard-retry — the scheduler process was booted ~52 min before
// an exemption it should have applied landed on disk, and nothing in the
// run record showed that; this is the fix).
const SCHEDULER_BOOTED_AT = new Date().toISOString();
// Resolves against __dirname (this app's OWN source checkout) — unaffected by
// PRD 994's job worktrees, which live under a job's PROJECT cwd, never under
// this app's install directory.
const SCHEDULER_CODE_SHA = (() => {
  try {
    return execFileSync('git', ['-C', __dirname, 'rev-parse', '--short', 'HEAD'], {
      timeout: 5000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
})();

const MAX_INVESTIGATION_DURATION_MS = 30 * 60_000;

// After the agent emits a `result` event in its JSONL stream, the parent
// `claude -p` process should exit promptly. Real-world failure (2026-05-10
// cellar-publish): an agent emitted result=success, then spawned unbounded
// `until $(curl ...)` background bashes that kept the parent alive for 22
// minutes until manual intervention. The post-result watchdog catches this:
// if the process is still alive POST_RESULT_GRACE_MS after result, SIGTERM
// the whole process group; if still alive POST_RESULT_KILL_MS after SIGTERM,
// SIGKILL. The original `result.subtype` is preserved and used to map the
// kill exit code back to 0 so legit work isn't mismarked as failed.
const POST_RESULT_GRACE_MS = 90_000;
const POST_RESULT_KILL_MS = 30_000;
const RESULT_TAIL_POLL_MS = 5_000;
const RESULT_TAIL_BYTES = 8 * 1024;
// Wider than RESULT_TAIL_BYTES (which only needs the subtype near the
// boundary) — a real `result` string can be a full paragraph, so
// extractResultTextFromLog scans more of the tail to find it whole.
const RESULT_TEXT_TAIL_BYTES = 64 * 1024;

// Idle-output watchdog: if the log file mtime stops advancing for this long
// while the process is still alive, the agent is hung mid-work (network
// stall, infinite tool loop, compaction wedge). User rule: anything not
// making progress for 20 minutes is presumed stuck. SIGTERM the process
// group, then SIGKILL after POST_RESULT_KILL_MS. The scheduler logs this
// distinctly from MAX_JOB_DURATION_MS so post-mortems can tell them apart.
const IDLE_OUTPUT_KILL_MS = 20 * 60_000;
const IDLE_CHECK_INTERVAL_MS = 60_000;

// Foreground Bash budget for every spawned `claude -p` job (executor +
// investigation). The Claude Code harness auto-backgrounds any foreground
// Bash command past its own default (120s) or max (600s) timeout and returns
// a tool result promising a later notification — but a headless single-shot
// run has no later turn, so that notification can never arrive and the run
// dead-ends mid-verification with no commit and no verdict. Raising these
// via the child's env moves that trap out of reach of normal gate commands
// (test suites, builds). BASH_MAX_TIMEOUT_MS MUST stay strictly below
// IDLE_OUTPUT_KILL_MS with real margin: a long foreground Bash emits no
// stream-json events while it runs, so the log mtime stalls and the
// idle-tail watchdog above would SIGTERM the job mid-gate if the two ever
// crossed — trading one silent failure for another.
const BASH_DEFAULT_TIMEOUT_MS = 600_000; // 10 min
const BASH_MAX_TIMEOUT_MS = 900_000; // 15 min — must stay below IDLE_OUTPUT_KILL_MS

// Boot reconciliation: a job left 'running' by an app restart/crash whose log
// shows neither success nor a real failure result was merely interrupted — the
// host died, the PRD didn't. Re-queue it up to this many times before giving up
// and marking it failed, so a restart self-recovers instead of needing a manual
// flip + a wasted fix-plan investigation.
// Cap = 5: covers a self-development cycle that restarts the app up to 6 times
// total (1 original run + 5 requeues). Mirrors the spirit of the transient-retry
// path (live-kill, addressed in 4c5013c) but for boot reconciliation orphans.
// Raised from 2 → 5 to survive burst restart storms (feedback 2026-06-15-01).
// Value lives in reaperHelpers.cjs (imported above) so the external watchdog
// shares the exact same budget — both increment the same j.orphanRetries field.

// Appended to every scheduled job prompt so the queue can be RELIED ON to finish
// work to a consistent bar: review → security-review → verify → commit. Enforced
// centrally here (not per-PRD) so it applies to every current and future PRD.
// The commit step is also backstopped by the post-run commit guard below: a
// clean exit that leaves uncommitted changes is downgraded to needs_review.
const FINISH_PROTOCOL = `

---
# SCHEDULER FINISH PROTOCOL (mandatory — runs AFTER the work above)

Once every acceptance-criteria line above is satisfied, finish in this EXACT
sequence. Do not stop before the commit lands; committing is part of the job.

RUN VERIFICATION IN THE FOREGROUND — this applies to the whole run, not just
step 3 below: every test/typecheck/lint/build command you run, whether while
implementing the AC or during VERIFY, must run SYNCHRONOUSLY and you must wait
for it to return. Never start a verification command as a background task
(no background Bash) and then call Monitor, TaskOutput, or ScheduleWakeup to
pick up its result later — a headless \`claude -p\` run has no later turn, so
nothing ever delivers that notification and the run dies mid-verification with
no commit and no verdict. Your foreground Bash budget for this run is
${BASH_DEFAULT_TIMEOUT_MS / 1000}s by default, up to ${BASH_MAX_TIMEOUT_MS / 1000}s max
— size your own \`timeout <n>\` wrapper (e.g. \`timeout ${Math.floor(BASH_MAX_TIMEOUT_MS / 1000)} npm test\`)
to fit inside that ceiling; if a gate command still cannot finish inside
budget, stop and emit SCHEDULER_VERDICT: FAIL with the reason instead of
deferring it.

1. CODE REVIEW — run \`/code-review --fix\` on your changes and apply the fixes it
   surfaces (correctness first). For any finding you judge a false positive, say
   why in your result; do not silently skip it. If \`/code-review\` is not
   available in this environment, do an equivalent careful self-review instead.
2. SECURITY REVIEW — run \`/security-review\` and address every finding (or
   justify it). If unavailable, self-review the diff for injection, secrets,
   path traversal, and unsafe input handling.
3. VERIFY — run the project's OWN check commands (typecheck / lint / tests — the
   project's CLAUDE.md names them; infer from the repo if not) and make them
   pass. Do not assume npm; use whatever the target project uses.
4. COMMIT — the queue can run several jobs against this SAME working tree at
   once. Do NOT stage the whole working tree in one blanket/wildcard git-add
   sweep — that captures whatever a concurrent sibling job is mid-writing and
   mis-attributes its work to this commit, corrupting both jobs' verdicts.
   Stage only the exact paths YOU created or modified for this PRD, then
   commit: \`git add <path> [<path>...] && git commit -m "<type>(<scope>): <summary>"\`.
   Your own work must still never be left uncommitted — this only changes
   which paths get staged, never whether you commit.
5. VERDICT SENTINEL — as the LAST LINE of your final result text, emit exactly
   one of these two lines (no trailing text after it):
     SCHEDULER_VERDICT: PASS
     SCHEDULER_VERDICT: FAIL <one-line reason>
   Print PASS only when the AC gate is green AND the commit from step 4 landed.
   Print FAIL (and exit 1) if the AC gate was red or the commit could not land.
   NEVER print PASS on a red AC gate — a lying PASS turns the verifier from a
   false-failure catcher into a silent-failure shipper. A truthful PASS + a
   landed commit lets the verifier override incidental transcript noise (grep
   results containing "Error", a TDD red-test run early in the session, debug
   Tracebacks) so those do not false-trip a needs_review downgrade.

A job that exits with uncommitted changes is treated as INCOMPLETE and flagged
for review. Do NOT add work beyond the acceptance criteria — this protocol is the
only post-AC work. If a review finding can't be fixed within scope, commit what
you have, describe the finding in the commit body, and note the follow-up in your
final result.`;

// Parse \`git status --porcelain\` output into a list of changed paths. Pure +
// exported for unit testing. Each porcelain line is "XY<space>PATH" (2 status
// chars + space), so the path starts at index 3; rename lines ("R  a -> b")
// keep the "a -> b" tail, which is fine for a human-facing dirty-file list.
function parsePorcelain(stdout) {
  return String(stdout || '')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => l.slice(3))
    .filter(Boolean);
}

// Return the list of uncommitted paths in cwd, or null when the guard does not
// apply (cwd is not a git work tree, git is missing, or the call errors). Never
// throws — a guard failure must not fail an otherwise-successful job.
function uncommittedChanges(cwd) {
  return new Promise((resolve) => {
    if (!cwd) { resolve(null); return; }
    execFile(
      'git',
      ['-C', cwd, 'status', '--porcelain'],
      { timeout: 10_000, windowsHide: true },
      (err, stdout) => {
        if (err) { resolve(null); return; } // not a repo / git missing → skip
        resolve(parsePorcelain(stdout));
      },
    );
  });
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
// Pure/no I/O — the guard's git calls happen at the call site
// (checkSharedTreeGuard). Exported for unit testing.
function evaluateSharedTreeGuard({ stashBefore, stashAfter, dirtyBefore, dirtyAfter, pathsCommittedDuringRun }) {
  const beforeHashes = new Set((stashBefore || []).map((l) => parseStashLine(l)?.hash).filter(Boolean));
  const newStashes = (stashAfter || [])
    .map(parseStashLine)
    .filter((e) => e && !beforeHashes.has(e.hash));
  const dirtyAfterSet = new Set(dirtyAfter || []);
  const committedSet = new Set(pathsCommittedDuringRun || []);
  const reverted = (dirtyBefore || []).filter((p) => !dirtyAfterSet.has(p) && !committedSet.has(p));
  return { newStashes, reverted };
}

// Post-run shared-tree guard for an IN-PLACE job (worktree.ok === false —
// callers must gate on that; a worktree-isolated run's git state can never
// leak into guardCwd, so there is nothing here to check). Best-effort: never
// throws, never changes the job's exit code. Restores exactly one
// executor-created stash (never guesses when there are 2+); reports anything
// it can't safely resolve on the returned object so the caller can surface it
// on the job row instead of finishing silently green.
async function checkSharedTreeGuard({ cwd, stashBaseline, dirtyBaseline, headBefore, slug }) {
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
    const { reverted } = module.exports.evaluateSharedTreeGuard({
      stashBefore: stashBaseline,
      stashAfter,
      dirtyBefore: dirtyBaseline,
      dirtyAfter,
      pathsCommittedDuringRun,
    });
    if (reverted.length) {
      result.reverted = reverted;
      console.error(`[scheduler] ${slug}: shared-tree guard: ${reverted.length} path(s) reverted in the shared tree with no commit to explain it (${reverted.slice(0, 3).join(', ')})`);
    }
    return (result.restoredStash || result.restoreFailed || result.ambiguousStashes || result.reverted) ? result : null;
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
  await fetchAllRefs(cwd);
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
  // vi.spyOn(scheduler, 'committedInWindow') to drive the retry deterministically.
  if (await module.exports.committedInWindow(cwd, startedAt, untilIso)) return true;
  await new Promise((resolve) => { setTimeout(resolve, COMMIT_GUARD_RETRY_DELAY_MS); });
  return module.exports.committedInWindow(cwd, startedAt, untilIso);
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

const ROOT = path.join(os.homedir(), '.claude', 'session-manager', 'scheduled-plans');
const PRDS_DIR = path.join(ROOT, 'prds');
const RUNS_DIR = path.join(ROOT, 'runs');
const PRDS_ARCHIVE_DIR = path.join(ROOT, 'prds-archived');
const QUEUE_PATH = path.join(ROOT, 'queue.json');
const SCHEDULER_STATE_PATH = path.join(os.homedir(), '.claude', 'session-manager', 'scheduler-state.json');
const HEARTBEAT_PATH = path.join(os.homedir(), '.claude', 'session-manager', 'scheduler-heartbeat.log');
const HEARTBEAT_MAX_BYTES = 1024 * 1024;
// DEFAULT_PROJECT_CWD imported from lib/schedulerBatch.cjs (single source of truth).

// Each headless claude -p job can shell out to tsc/vite/pytest and grow well
// past 1 GB at peak; reserve 2.5 GB per running+pending slot. Raised from 1.5 GB
// after the 2026-06-16 OOM: 3 concurrent cross-project jobs + their build
// subprocesses pushed a 24 GB host ~10 GB into swap and the OOM killer took
// Electron — every pty got SIGHUP (code=0 signal=1).
const MIN_FREE_MB_PER_JOB = 2500;

// Absolute headroom kept free for the Electron host (main + renderer + GPU) and
// the OS — NEVER lent to jobs. Without it the gate green-lights a job whenever
// MemAvailable is just above per-job need, starving the very process that owns
// the ptys; that's the one the OOM killer then reaps. Subtracted from
// MemAvailable before the per-job gate runs. See availableForJobs().
const RESERVED_HOST_MB = 3000;

// oom_score_adj applied to each spawned claude -p job (range -1000..1000;
// Electron inherits the default 0). A positive bias makes the kernel OOM killer
// prefer a disposable, restartable job over Electron — whose death SIGHUPs every
// pty and drops the sleep inhibitor. The job's build subprocesses (tsc/vite)
// inherit it, so the actual memory hogs are the preferred victims. The gate caps
// how many START; this decides who dies if a spike slips through anyway.
const OOM_SCORE_ADJ_JOB = 500;

const DEFAULT_CONFIG = {
  offsetMinutes: 15,
  defaultCwd: DEFAULT_PROJECT_CWD,
  // 'when-available' = poll usage and fire whenever utilization < threshold.
  // 'on-reset'        = fire offsetMinutes after the next 5h reset (legacy).
  // 'manual'          = only fire on explicit Run now click.
  firePolicy: 'when-available',
  // For 'when-available'. Fire only when five_hour utilization < this percent.
  utilizationThreshold: 90,
  schemaVersion: 1,
  supervisor: {
    enabled: true,
    intervalMinutes: 15,
    maxConcurrentProbes: 2,
    probeStaleThresholdMinutes: 10,
  },
};

// ---------- memory gate ----------

/**
 * Returns available system memory in MB.  Reads /proc/meminfo on Linux; fails
 * open (returns Infinity) on darwin or on any parse/read error so the gate
 * never blocks scheduling on unsupported platforms.
 */
function getAvailableMemMb() {
  if (process.platform !== 'linux') return Infinity;
  try {
    const raw = fs.readFileSync('/proc/meminfo', 'utf8');
    const m = raw.match(/^MemAvailable:\s+(\d+)\s+kB/m);
    if (!m) return Infinity;
    return Math.floor(parseInt(m[1], 10) / 1024);
  } catch {
    return Infinity;
  }
}

/**
 * Pure helper: clamp a batch down so launching `toLaunch` more jobs doesn't
 * drop available memory below MIN_FREE_MB_PER_JOB per active slot.
 * Exported for unit tests.
 */
function memoryLimitedBatchSize(availableMb, minPerJob, runningCount, batchLen) {
  if (availableMb === Infinity) return batchLen;
  let allowed = batchLen;
  while (allowed > 0 && availableMb < minPerJob * (runningCount + allowed)) {
    allowed--;
  }
  return allowed;
}

/**
 * Memory available to LAUNCH jobs with: MemAvailable minus the host reserve,
 * floored at 0. Keeping the host reserve out of the job budget is what stops the
 * gate from green-lighting a job into an OOM that kills Electron. Fails open
 * (Infinity) on non-Linux where MemAvailable is unknown. Exported for tests.
 */
function availableForJobs(availableMb, reservedHostMb) {
  if (availableMb === Infinity) return Infinity;
  return Math.max(0, availableMb - reservedHostMb);
}

/**
 * Bias a spawned job's oom_score_adj up so the kernel OOM killer sacrifices the
 * (restartable) job before Electron. Raising a child's OWN score is privilege-
 * free; lowering Electron's would need CAP_SYS_RESOURCE. Linux-only, best-effort
 * — the job may have already exited (write ENOENTs), which is fine. See the
 * 2026-06-16 OOM-kills-Electron incident.
 */
function biasJobOomScore(pid) {
  if (process.platform !== 'linux' || !pid) return;
  try {
    fs.writeFileSync(`/proc/${pid}/oom_score_adj`, String(OOM_SCORE_ADJ_JOB));
  } catch {
    /* job already exited, or /proc unavailable — best-effort hardening only */
  }
}

// ---------- fs helpers ----------

// ---------- per-project PRD dir resolution (PRD 808) ----------
//
// PRDS_DIR above is now the LEGACY global dir — kept only as a migration
// source and a search fallback. Live PRDs resolve per-job to
// `<job.cwd>/session-manager-operations/scheduler/prds/` via prdLocations.cjs.

/**
 * Every PRD-source directory currently in play: the legacy global dir (still
 * searched so a not-yet-migrated file is never invisible) plus every active
 * project's own PRDs dir. Used by scans that enumerate PRDs across projects
 * (reconcile, list-prds, lint, rescan).
 */
function candidatePrdsDirs() {
  return [PRDS_DIR, ...resolvePrdsDirs()];
}

/**
 * Every `prds-archived/` dir across every project (the sibling-of-source
 * layout archiveCompletedPrd writes into — see that function's comment).
 * Used only by list-prds so the PRDs/Runs tabs can show an Epic's REAL
 * historical PRD count, not just its currently-pending one. Deliberately
 * excludes the flat legacy PRDS_ARCHIVE_DIR (manual `schedule:archive-prd`
 * timestamped-subdir layout) — that path is for a different, unused-by-
 * any-renderer manual archive flow, not Epic-scoped completion archiving.
 */
function candidateArchivedPrdsDirs() {
  return resolveArchivedPrdsDirs();
}

/**
 * Resolve an archived PRD's real terminal outcome for `schedule:list-prds`:
 * its live queue.json row (if the job hasn't aged out yet), else its
 * history.jsonl row, else 'completed' — archiveCompletedPrd only ever
 * archives a job whose effective status is 'completed' (a 'failed' job's
 * PRD source stays in the live prds/ dir), so 'completed' is a safe
 * default, not a guess; the live/history lookups are defensive in case
 * that archiving invariant ever changes. Exported as a pure function (no
 * IPC/fs) so this fallback chain is unit-testable without an Electron
 * harness.
 */
function resolveArchivedPrdStatus(slug, liveStatusBySlug, histBySlug) {
  const resolved = liveStatusBySlug.get(slug) ?? histBySlug.get(slug)?.status ?? 'completed';
  return resolved === 'failed' ? 'failed' : 'completed';
}

/** The PRD-source directory for a given job cwd (falls back to DEFAULT_PROJECT_CWD). */
function prdDirForCwd(cwd) {
  return resolvePrdWriteDir(cwd || DEFAULT_PROJECT_CWD);
}

/**
 * Absolute path to `<job's project PRDs dir>/<job.slug>.md`. Resolves to
 * `resolvePrdWriteDir(cwd)` — the RETIRED flat
 * `<cwd>/session-manager-operations/scheduler/prds/` dir, which holds only
 * zero-byte `.reserved-NNN` stubs and no PRD source for any Epic-scoped PRD
 * (see resolveNotifyPrd's and resolveVerifyPrdPath's doc comments, PRD 985
 * and 991). Do NOT reach for this in new code — use `findPrdDir(slug)` (via
 * `resolveVerifyPrdPath`/`resolveNotifyPrd`, or directly for a fresh path)
 * instead. The one legitimate remaining caller is executeJob's `prdPath`
 * (~line 2235), which only falls back to this AFTER `findPrdDir` already
 * came up empty — a real miss, not a resolution shortcut — matching this
 * function's genuinely-legacy semantics rather than a bug. (PRD 991 also
 * removed the two verify call sites and buildInvestigationPrompt's
 * originalBody read from this list — all three now go through
 * resolveVerifyPrdPath instead.)
 */
function prdPathForJob(job) {
  return path.join(prdDirForCwd(job && job.cwd), `${job && job.slug}.md`);
}

/**
 * Absolute path to a job's archived-twin `<slug>.md`. Resolves to the first
 * archive dir (across the flat legacy layout and every Epic's own sibling
 * archive — see listArchivedPrdDirs) that actually contains the slug, falling
 * back to the flat `prds-archived/<slug>.md` path when none do (this fallback
 * is only ever used for its string value — logging/note text in
 * prdArchivedSkipResult — never as an existence check).
 */
function archivedPrdPathForJob(job) {
  const slug = job && job.slug;
  const flatPath = path.join(prdDirForCwd(job && job.cwd), '..', 'prds-archived', `${slug}.md`);
  for (const dir of listArchivedPrdDirs((job && job.cwd) || DEFAULT_PROJECT_CWD)) {
    const candidate = safeSlugPathIn(dir, slug);
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return flatPath;
}

/**
 * True if a job's PRD has already been archived — in the flat legacy
 * `prds-archived/` dir OR in the Epic-scoped sibling archive dir every new
 * PRD actually lands in (archiveCompletedPrd archives into the source PRD's
 * OWN parent's prds-archived/, which for an Epic PRD is inside that Epic).
 * A queue entry whose PRD moved to either is stale — the work already
 * shipped — not a genuine missing-PRD failure.
 */
async function archivedTwinExists(job) {
  const slug = job && job.slug;
  for (const dir of listArchivedPrdDirs((job && job.cwd) || DEFAULT_PROJECT_CWD)) {
    const candidate = safeSlugPathIn(dir, slug);
    if (!candidate) continue;
    try {
      await fsp.access(candidate);
      return true;
    } catch { /* not here — try the next archive dir */ }
  }
  return false;
}

/**
 * Build the non-failure result + run meta for a queued job whose PRD source
 * is gone. Shared by both PRD-read failure exits in executeJob so the
 * stale-skip logic isn't duplicated. Two reasons, both exitCode: 0 (no RCA
 * feedback item, since neither is a real work failure):
 *   - 'prd-archived': the source was archived — archivedTwinExists found it
 *     under a prds-archived/ dir. The work already shipped.
 *   - 'prd-missing': the source is gone everywhere (ENOENT on every
 *     candidate dir, no archived twin either) — most commonly a PRD that
 *     existed at enqueue time and was deleted before dispatch (e.g. a test
 *     fixture that leaked into the live queue and was cleaned up by its own
 *     `finally` block). Retire the row rather than fail it.
 */
function prdArchivedSkipResult(job, cwd, sessionId, startedAt, safeLog, closeFd, metaPath, reason = 'prd-archived') {
  const msg = reason === 'prd-missing'
    ? 'PRD source no longer exists on disk — retiring stale queue entry'
    : (() => {
        const archivedTwin = archivedPrdPathForJob(job);
        return `PRD already archived (${archivedTwin}) — work shipped; retiring stale queue entry`;
      })();
  safeLog(`[scheduler] ${msg}\n`);
  closeFd();
  const finishedAt = Date.now();
  config.writeJsonSync(metaPath, {
    slug: job.slug, cwd, sessionId, exitCode: 0, skipped: reason,
    note: msg, startedAt, finishedAt, durationMs: 0,
  });
  return { exitCode: 0, durationMs: 0, skipped: reason, note: msg, sessionId };
}

/**
 * Search every candidate PRD dir for `<slug>.md` (legacy dir first, then
 * each active project's dir). Returns the containing dir, or null if the
 * slug isn't found anywhere. Used by slug-only callers (IPC handlers) that
 * don't have a job's cwd on hand.
 */
async function findPrdDir(slug) {
  for (const dir of candidatePrdsDirs()) {
    try {
      await fsp.access(path.join(dir, `${slug}.md`));
      return dir;
    } catch { /* not here — try the next candidate dir */ }
  }
  return null;
}

/**
 * Resolve `<dir>/<slug>.md` for a directory already known to contain (or be
 * about to receive) the slug, and enforce path containment. Returns the
 * absolute path on success, null on slug-escape attempts. The zod schema
 * for slugs already blocks `..` because the SLUG_RE excludes `/`, but
 * defense-in-depth: a second containment check after path.resolve costs
 * nothing and catches future regex laxity.
 */
function safeSlugPathIn(dir, slug) {
  const resolved = path.resolve(path.join(dir, `${slug}.md`));
  if (!resolved.startsWith(dir + path.sep)) return null;
  return resolved;
}

/**
 * Locate an EXISTING `<slug>.md` across every candidate PRD dir and return
 * its safe, containment-checked absolute path — or null if the slug isn't
 * found anywhere (or would escape its containing dir).
 */
async function safeSlugPath(slug) {
  const dir = await findPrdDir(slug);
  if (!dir) return null;
  return safeSlugPathIn(dir, slug);
}

/**
 * The two distinct failure modes safeSlugPath collapses into one nullable
 * return (the defect this fixes — see the PRD that added this helper's
 * Goal): a slug that fails SCHEDULE_SLUG_RE is a caller mistake ("invalid
 * slug"), while a well-formed slug that exists in no candidate PRD dir is a
 * lookup miss ("unknown slug") — an agent retrying the first as if it were
 * the second (or vice versa) burns a turn on the wrong fix. Returns
 * `{ ok: true, path }` or `{ ok: false, reason: 'invalid-slug' | 'not-found' }`.
 * `cwd`, if given, narrows the search to that one project's own PRD dirs
 * (prdDirForCwd + its Epic-scoped dirs — same pattern as getPrdParsed);
 * omitted, it searches every candidate dir machine-wide via findPrdDir.
 */
async function resolveSlugOrReason(slug, cwd) {
  if (!SCHEDULE_SLUG_RE.test(slug)) return { ok: false, reason: 'invalid-slug' };
  if (cwd) {
    for (const dir of [prdDirForCwd(cwd), ...listEpicPrdDirs(cwd)]) {
      const p = safeSlugPathIn(dir, slug);
      if (!p) continue;
      try {
        await fsp.access(p);
        return { ok: true, path: p };
      } catch { /* not in this dir — try the next candidate */ }
    }
    return { ok: false, reason: 'not-found' };
  }
  const dir = await findPrdDir(slug);
  if (!dir) return { ok: false, reason: 'not-found' };
  const p = safeSlugPathIn(dir, slug);
  if (!p) return { ok: false, reason: 'not-found' };
  return { ok: true, path: p };
}

/** Actionable message for `resolveSlugOrReason`'s 'not-found' reason. */
function unknownSlugMessage(slug) {
  return `unknown slug "${slug}": no PRD file with that name in any known project — call scheduler_list_prds (optionally with cwd) to see what exists`;
}

/**
 * Move a completed job's `<slug>.md` out of its PRD dir into that dir's
 * sibling `prds-archived/`, so a finished slug can't be re-fired by the
 * scheduler. Sibling-of-source (not the hard-coded legacy PRDS_ARCHIVE_DIR)
 * so a per-project PRD (`<cwd>/session-manager-operations/scheduler/prds/`)
 * archives into that SAME project's `prds-archived/`, not the global legacy
 * one — PRDS_ARCHIVE_DIR only happens to coincide with this for the legacy
 * PRDS_DIR. Mirrors the `schedule:clear-queue` archive logic (same
 * containment check). Non-throwing: a missing source file (already archived
 * or already gone) is a silent no-op, and any other error is logged as a
 * warning — an archive failure must never break job-completion bookkeeping.
 */
async function archiveCompletedPrd(slug, cwd) {
  try {
    const srcDir = (await findPrdDir(slug)) ?? prdDirForCwd(cwd);
    const src = safeSlugPathIn(srcDir, slug);
    if (!src) return;
    const archiveDir = path.join(srcDir, '..', 'prds-archived');
    await fsp.mkdir(archiveDir, { recursive: true });
    const dst = path.join(archiveDir, `${slug}.md`);
    await fsp.rename(src, dst);
  } catch (e) {
    if (e?.code !== 'ENOENT') {
      logs.writeLine({ level: 'warn', scope: 'scheduler', message: 'archiveCompletedPrd: rename failed', meta: { slug, error: e?.message } });
    }
  }
}

/**
 * Mark any still-runnable (pending/running) queue job for the given slugs as
 * completed. Called after a PRD's .md is manually archived (queueOps.cjs's
 * `schedule:archive-prd`) so a stale queue entry can never survive to fire
 * against a PRD that no longer exists in the live prds/ dir — the same
 * ENOENT-avoidance archivedTwinExists provides in executeJob, applied at the
 * archiving source instead of at fire-time. auto-archived slugs never need
 * this (selectAutoArchivable in queueOps.cjs only selects already-completed
 * jobs), so this is exercised only by the manual archive path.
 */
async function retireCompletedSlugs(slugs) {
  const list = Array.isArray(slugs) ? slugs.filter(Boolean) : [];
  if (list.length === 0) return;
  const slugSet = new Set(list);
  await mutate((s) => {
    for (const j of s.jobs) {
      if (!j || !slugSet.has(j.slug)) continue;
      if (j.status !== 'pending' && j.status !== 'running') continue;
      if (!transitionJob(j, 'completed', { reason: 'manual archive of an already-shipped PRD', source: 'retireCompletedSlugs' })) continue;
      j.finishedAt = new Date().toISOString();
      j.exitCode = 0;
      j.error = null;
      delete j.runtime;
    }
  });
  await broadcast({ flush: true });
}

// Bundled authoring guide seeded into the scheduler dir so the session-manager-dev
// plugin's /develop and /prd skills — which reference this stable `~`-absolute
// path — work on any user's machine, not just the author's.
const PRD_AUTHORING_TEMPLATE = path.join(__dirname, 'templates', 'PRD_AUTHORING.md');
const PRD_AUTHORING_DEST = path.join(ROOT, 'PRD_AUTHORING.md');

function ensureDirs() {
  fs.mkdirSync(PRDS_DIR, { recursive: true });
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  // Seed the authoring guide once; never clobber a user's edited copy.
  try {
    if (!fs.existsSync(PRD_AUTHORING_DEST) && fs.existsSync(PRD_AUTHORING_TEMPLATE)) {
      fs.copyFileSync(PRD_AUTHORING_TEMPLATE, PRD_AUTHORING_DEST);
    }
  } catch { /* non-fatal: the guide is a convenience, not load-bearing for a run */ }
}

/**
 * One-time, idempotent migration (PRD 808): move every PRD source .md file
 * still sitting in the legacy global PRDS_DIR into its own project's
 * `<cwd>/session-manager-operations/scheduler/prds/`, based on that PRD's
 * own frontmatter `cwd`. Runs at every boot — a no-op fs.readdir once
 * nothing is left to move. Files migratePrds couldn't resolve (missing/
 * unparseable cwd, cwd not on disk) are left in place and logged as a
 * warning — never silently dropped — so a human can fix the frontmatter.
 */
/**
 * consolidateAllFlatPrds(cwds) — run consolidateFlatPrds() over every given
 * project cwd, logging outcomes. Called from TWO places: once at boot (over
 * every historical project, via runPrdMigration below) AND at the top of
 * every reconcile() call (over every project reconcile itself would
 * otherwise scan), BEFORE reconcile scans the flat dir for PRD sources. The
 * reconcile()-level call is what makes "anything written to the retired flat
 * prds/ dir is swept into prds-archived/ without being executed" actually
 * true regardless of which of reconcile's several callers (tickQueue's poll,
 * job completion, the schedule:state/schedule:rescan IPC handlers,
 * rescheduleTimer) triggers the pass: a PRD dropped in the flat dir has no
 * queue row yet at that point, so it is never in LIVE_JOB_STATUSES and this
 * sweep archives it before reconcile can ever turn it into a pending job.
 */
async function consolidateAllFlatPrds(cwds) {
  for (const cwd of cwds) {
    try {
      const c = await consolidateFlatPrds(cwd);
      if (c.moved > 0) {
        console.log(`[scheduler] flat-PRD consolidation: archived ${c.moved} file(s) in ${cwd}`);
      }
      for (const f of c.failed) {
        logs.writeLine({
          level: 'warn', scope: 'scheduler',
          message: `flat-PRD consolidation: could not archive ${f.file}`,
          meta: { cwd, reason: f.reason },
        });
      }
      // Deliberately left behind because a live job still points at them
      // (PRD 992). Logged so a permanently-stuck flat PRD is visible rather
      // than looking like a clean consolidation.
      for (const s of c.skipped ?? []) {
        logs.writeLine({
          level: 'info', scope: 'scheduler',
          message: `flat-PRD consolidation: left ${s.file} in place`,
          meta: { cwd, reason: s.reason },
        });
      }
    } catch (e) {
      logs.writeLine({ level: 'warn', scope: 'scheduler', message: 'flat-PRD consolidation failed', meta: { cwd, error: e?.message } });
    }
  }
}

async function runPrdMigration() {
  let result;
  try {
    result = await migratePrds(PRDS_DIR);
  } catch (e) {
    logs.writeLine({ level: 'error', scope: 'scheduler', message: 'PRD migration failed', meta: { error: e?.message } });
    return null;
  }
  console.log(`[scheduler] PRD migration: moved ${result.moved}, skipped ${result.skipped}`);
  if (result.unresolved.length > 0) {
    logs.writeLine({
      level: 'warn',
      scope: 'scheduler',
      message: `PRD migration: ${result.unresolved.length} file(s) left in legacy dir`,
      meta: { legacyDir: PRDS_DIR, unresolved: result.unresolved },
    });
    for (const u of result.unresolved) {
      console.warn(`[scheduler] PRD migration: left ${u.file} in legacy dir (${u.reason})`);
    }
  }

  // Phase 2 (2026-07-31 domain-model decision): the flat per-project
  // `scheduler/prds/` dir is retired — new PRDs are epic-scoped, and anything
  // still sitting flat consolidates into `prds-archived/` for later special
  // processing. Queue rows for moved files are reaped by the archived-twin
  // retirement. Idempotent per project; failures are logged, never fatal.
  // (This boot-time pass is redundant with the one reconcile() now also runs
  // on every pass, but stays here so a fresh boot's very first log line
  // still reports the initial sweep — see consolidateAllFlatPrds's own
  // comment for why reconcile() is the load-bearing call site.)
  await consolidateAllFlatPrds(allProjectCwds());

  // Rollout migration for the PRD-authoring-lockdown feature: stamp every
  // pre-existing PRD as legacy-adopted BEFORE reconcile() ever runs its
  // provenance gate against it. Must run every boot (idempotent, cheap
  // scan-and-skip) rather than once — a project opened for the first time
  // after this shipped still has pre-existing unstamped PRDs the very first
  // time reconcile() sees them.
  try {
    const adopted = await legacyAdoptExistingPrds();
    if (adopted.stamped > 0) {
      console.log(`[scheduler] legacy-adopt migration: stamped ${adopted.stamped} pre-existing PRD(s) as createdVia=legacy-adopted`);
    }
    for (const f of adopted.failed) {
      logs.writeLine({ level: 'warn', scope: 'scheduler', message: 'legacy-adopt migration: could not stamp PRD', meta: f });
    }
  } catch (e) {
    logs.writeLine({ level: 'error', scope: 'scheduler', message: 'legacy-adopt migration failed', meta: { error: e?.message } });
  }

  return result;
}

// Matches only numbered timestamp backups (queue.json.bak-<epoch>), not the
// bare `queue.json.bak` single-shot copy some older code paths left behind.
const QUEUE_BAK_RE = /^queue\.json\.bak-\d+$/;
const QUEUE_BAK_KEEP = 5;

/**
 * Sweeps accumulated queue.json.bak-<epoch> files down to the newest
 * QUEUE_BAK_KEEP, deleting the rest. Runs at boot. `entries` comes from
 * fs.readdir(ROOT), so every candidate path is already contained in ROOT.
 */
async function sweepQueueBackups() {
  let entries;
  try {
    entries = await fsp.readdir(ROOT);
  } catch {
    return;
  }
  const baks = entries.filter((f) => QUEUE_BAK_RE.test(f));
  if (baks.length <= QUEUE_BAK_KEEP) return;

  baks.sort((a, b) => {
    const ta = Number(a.slice('queue.json.bak-'.length));
    const tb = Number(b.slice('queue.json.bak-'.length));
    return tb - ta; // newest (largest epoch) first
  });
  const toDelete = baks.slice(QUEUE_BAK_KEEP);
  let removed = 0;
  for (const f of toDelete) {
    try {
      await fsp.unlink(path.join(ROOT, f));
      removed++;
    } catch (e) {
      console.warn('[scheduler] backup sweep: unlink failed', f, e?.message);
    }
  }
  if (removed > 0) {
    console.log(`[scheduler] backup sweep: removed ${removed} old queue.json.bak-* file(s), kept ${QUEUE_BAK_KEEP}`);
  }
}

// Atomic JSON write helpers delegate to config.cjs's shared implementation.
// Sync variant is required for the executeJob exit handler (Promise resolver
// callback that must flush meta.json before resolving) — replacing with async
// would deadlock the exit path.
const config = require('./config.cjs');
const atomicWriteJsonSync = (p, data) => config.writeJsonSync(p, data);

// ---------- scheduler-state.json (sidecar) ----------

function loadSchedulerState() {
  try {
    const raw = fs.readFileSync(SCHEDULER_STATE_PATH, 'utf8');
    const s = JSON.parse(raw);
    if (s.lastObservedReset) cachedNextReset = s.lastObservedReset;
    if (typeof s.consecutiveFailures === 'number') consecutiveFailures = s.consecutiveFailures;
    if (typeof s.backoffMs === 'number') backoffMs = s.backoffMs;
    if (typeof s.pauseClearedManuallyAt === 'number') pauseClearedManuallyAt = s.pauseClearedManuallyAt;
    if (typeof s.lastPollAt === 'number') lastPollAt = s.lastPollAt;
  } catch { /* first boot or corrupt — start fresh */ }
}

function persistSchedulerState() {
  // Sync write: called from many sync hot paths (clearPause, pollLoop catch
  // block) and the sidecar is tiny (<1 KB). Converting to async here would
  // require threading awaits through pause/resume bookkeeping for negligible
  // benefit — the file is well under one page.
  try {
    config.writeJsonSync(SCHEDULER_STATE_PATH, {
      version: 1,
      lastObservedReset: cachedNextReset,
      lastResetObservedAt: cachedNextReset ? Date.now() : null,
      lastPollAt,
      consecutiveFailures,
      backoffMs,
      pausedReason: null,
      pausedSince: null,
      pauseClearedManuallyAt,
    });
  } catch (e) {
    console.warn('[scheduler] failed to persist scheduler state', e?.message);
  }
}

// ---------- heartbeat log ----------

function appendHeartbeat(entry) {
  try {
    const line = JSON.stringify(entry) + '\n';
    let size = 0;
    try { size = fs.statSync(HEARTBEAT_PATH).size; } catch { /* new file */ }
    if (size >= HEARTBEAT_MAX_BYTES) {
      const rotated = HEARTBEAT_PATH + '.1';
      try { fs.unlinkSync(rotated); } catch { /* */ }
      try { fs.renameSync(HEARTBEAT_PATH, rotated); } catch { /* */ }
    }
    fs.appendFileSync(HEARTBEAT_PATH, line);
  } catch (e) {
    console.warn('[scheduler] heartbeat write failed', e?.message);
  }
}

/**
 * computeStallSummary(state) → { stalled, total, running, pending, byProject }
 *
 * Pure, no IO. `state` is a merged queue-store read ({ jobs, invalidJobs,
 * paused }). The engine (reconcile/reaper/auto-fix/reverify) already
 * operates machine-wide via queueStore's stateCwds() — this function is
 * MONITORING, and monitoring must not collapse per-project reality into one
 * boolean. `stalled` (top-level) is the pre-existing machine-wide roll-up:
 * the queue holds work — valid rows OR rows quarantined for an invalid
 * status — but nothing anywhere is running or pending and the scheduler
 * isn't paused. The 2026-08-07 incident sat exactly in this state for 4+
 * hours: 2 jobs, 0 running, 0 pending, and the only visible symptom was a
 * heartbeat `counts` object that had silently minted a `queued` bucket
 * instead of reporting anything actionable.
 *
 * `byProject[cwd].stalled` is the PER-PROJECT verdict added for the
 * "burrow went dark while other projects were busy" gap: a project can hold
 * jobs (including ones parked `quarantined`) with 0 running and 0 pending
 * while the machine-wide `stalled` above reads false because a different
 * project has running/pending work. Each project's own status counts
 * (`byProject[cwd][status]`) already summed to a total before this — the
 * fix is only the boolean, not the counting.
 */
function computeStallSummary(state) {
  const jobs = Array.isArray(state?.jobs) ? state.jobs : [];
  const invalidJobs = Array.isArray(state?.invalidJobs) ? state.invalidJobs : [];
  let running = 0;
  let pending = 0;
  const byProject = {};
  for (const j of jobs) {
    if (j.status === 'running') running += 1;
    if (j.status === 'pending') pending += 1;
    const key = j.cwd || '(unknown)';
    byProject[key] = byProject[key] || {};
    byProject[key][j.status] = (byProject[key][j.status] || 0) + 1;
  }
  for (const inv of invalidJobs) {
    const key = inv.row?.cwd || '(unknown)';
    byProject[key] = byProject[key] || {};
    byProject[key].invalid = (byProject[key].invalid || 0) + 1;
  }
  const total = jobs.length + invalidJobs.length;
  const stalled = total > 0 && running === 0 && pending === 0 && !state?.paused;
  for (const key of Object.keys(byProject)) {
    const counts = byProject[key];
    const projRunning = counts.running || 0;
    const projPending = counts.pending || 0;
    const projTotal = Object.keys(counts)
      .filter((k) => k !== 'stalled')
      .reduce((sum, k) => sum + counts[k], 0);
    counts.stalled = projTotal > 0 && projRunning === 0 && projPending === 0 && !state?.paused;
  }
  return { stalled, total, running, pending, byProject };
}

/**
 * computeBlockedChains(jobs) → [{ cwd, blockedBy, blocked }]
 *
 * Pure, no IO. The gap computeStallSummary above cannot see.
 *
 * `stalled` is defined as `running === 0 && pending === 0`, which encodes an
 * assumption that a PENDING row is healthy in-progress work. It is not: a
 * pending row whose `dependsOn` chain terminates in a TERMINAL non-completed
 * status (`failed`/`skipped`) can never be dispatched by pickForProject, and
 * never will be, but it still counts toward `pending` and so reads as a
 * healthy queue to every monitor in the app.
 *
 * On 2026-09-05 starry-night-ships held 42 such rows behind one `failed`
 * job for three hours. Machine-wide `stalled` was false (42 pending),
 * per-project `stalled` was false (42 pending), the queue-health sweep
 * doesn't count `failed` at all, and the supervisor only probes `running` —
 * so nothing anywhere reported a problem while nothing could ever run.
 *
 * Reported per project as { blockedBy: [terminal slugs], blocked: count }.
 * Transitive by construction: a row blocked by a row that is itself blocked
 * resolves through the same walk.
 */
function computeBlockedChains(jobs) {
  const rows = (Array.isArray(jobs) ? jobs : []).filter(Boolean);
  const byCwd = new Map();
  for (const j of rows) {
    const key = j.cwd || '(unknown)';
    if (!byCwd.has(key)) byCwd.set(key, []);
    byCwd.get(key).push(j);
  }

  const out = [];
  for (const [cwd, projectJobs] of byCwd) {
    // Reuse the picker's OWN dep resolution so this can never disagree with
    // what the scheduler will actually dispatch (bare-name fallback included).
    const rowBySlug = new Map(projectJobs.map((j) => [j.slug, j]));
    const rowsByBareSlug = new Map();
    for (const j of projectJobs) {
      const bare = String(j.slug ?? '').replace(/^\d+-/, '');
      if (!rowsByBareSlug.has(bare)) rowsByBareSlug.set(bare, []);
      rowsByBareSlug.get(bare).push(j);
    }
    const rowsForDep = (slug) => {
      const exact = rowBySlug.get(slug);
      if (exact) return [exact];
      return rowsByBareSlug.get(String(slug ?? '').replace(/^\d+-/, '')) ?? [];
    };

    // Memoised walk: does this row's dep closure hit a terminally-stuck row?
    const TERMINAL_STUCK = new Set(['failed', 'skipped']);
    const verdicts = new Map(); // slug -> Set of terminal blocker slugs
    const visiting = new Set();
    const blockersFor = (job) => {
      if (!job) return new Set();
      if (verdicts.has(job.slug)) return verdicts.get(job.slug);
      if (visiting.has(job.slug)) return new Set(); // dependsOn cycle — not our problem here
      visiting.add(job.slug);
      const found = new Set();
      for (const depSlug of job.dependsOn ?? []) {
        for (const dep of rowsForDep(depSlug)) {
          if (TERMINAL_STUCK.has(dep.status)) found.add(dep.slug);
          else if (dep.status !== 'completed') for (const b of blockersFor(dep)) found.add(b);
        }
      }
      visiting.delete(job.slug);
      verdicts.set(job.slug, found);
      return found;
    };

    const blockedBy = new Set();
    let blocked = 0;
    for (const j of projectJobs) {
      if (j.status !== 'pending') continue;
      const bs = blockersFor(j);
      if (bs.size === 0) continue;
      blocked += 1;
      for (const b of bs) blockedBy.add(b);
    }
    if (blocked > 0) out.push({ cwd, blockedBy: [...blockedBy].sort(), blocked });
  }
  return out;
}

/**
 * findStaleQuarantinedJobs(jobs, now, thresholdMs) → [{ slug, cwd, ageMs }]
 *
 * Pure, no IO. A 'quarantined' row (no createdVia provenance) can otherwise
 * sit forever with nothing looking at it — quarantine only ever clears via a
 * human adopting or archiving it. This is the escalation half of that gate:
 * any quarantined row whose recorded quarantine timestamp (statusHistory's
 * `to === 'quarantined'` entry — stamped at creation, or backfilled from the
 * PRD file's mtime by reconcile() for rows quarantined before that stamp
 * existed) is older than `thresholdMs` is reported so the caller can
 * warn-log and surface it distinctly. A row with no recoverable timestamp is
 * skipped rather than guessed at.
 */
function findStaleQuarantinedJobs(jobs, now, thresholdMs) {
  const stale = [];
  for (const j of jobs ?? []) {
    if (j.status !== 'quarantined') continue;
    const entry = (j.statusHistory || []).find((h) => h.to === 'quarantined');
    if (!entry) continue;
    const since = Date.parse(entry.at);
    if (Number.isNaN(since)) continue;
    const ageMs = now - since;
    if (ageMs >= thresholdMs) stale.push({ slug: j.slug, cwd: j.cwd ?? null, ageMs });
  }
  return stale;
}

/**
 * findOverrunningJobs(jobs, now, { factor, floorMs }) → [{ slug, cwd, estimateMinutes, ranMs, ratio }]
 *
 * Pure, no IO. A RUNNING job whose elapsed time exceeds
 * `max(estimateMinutes * factor, floorMs)` is overrunning its own PRD's
 * declared estimate.
 *
 * This closes the gap between the two existing kill paths, which a
 * long-running-but-chatty job slips straight through:
 *  - MAX_JOB_DURATION_MS (4h) is a deadman — a 20-minute PRD at 3h is 9x
 *    over estimate and still an hour away from it.
 *  - IDLE_OUTPUT_KILL_MS (20m) only fires when the log mtime STALLS; an
 *    agent stuck in a productive-looking loop keeps writing and never trips it.
 * `estimateMinutes` was parsed, stored and displayed but never once compared
 * against actual runtime, so the only thing standing between a runaway job
 * and the 4h ceiling was a human noticing. (2026-08-08: a PRD ran 3h+ and was
 * caught only because the operator opened a second session to look.)
 *
 * Escalation only — see JOB_OVERRUN_FACTOR's note on why this must not kill.
 * A job with no usable estimate is skipped rather than guessed at.
 */
function findOverrunningJobs(jobs, now, { factor, floorMs } = {}) {
  const f = typeof factor === 'number' && factor > 0 ? factor : JOB_OVERRUN_FACTOR;
  const floor = typeof floorMs === 'number' && floorMs >= 0 ? floorMs : JOB_OVERRUN_FLOOR_MS;
  const out = [];
  for (const j of jobs ?? []) {
    if (j.status !== 'running') continue;
    const est = Number(j.estimateMinutes);
    if (!Number.isFinite(est) || est <= 0) continue; // no estimate to overrun
    const startedAt = Date.parse(j.startedAt ?? '');
    if (Number.isNaN(startedAt)) continue;
    const ranMs = now - startedAt;
    if (ranMs <= 0) continue;
    const thresholdMs = Math.max(est * 60_000 * f, floor);
    if (ranMs < thresholdMs) continue;
    out.push({
      slug: j.slug,
      cwd: j.cwd ?? null,
      estimateMinutes: est,
      ranMs,
      ratio: ranMs / (est * 60_000),
    });
  }
  return out;
}

/**
 * findStrandedInvestigations(jobs, now, maxMs, isAlive = claudePidAlive)
 *   → [{ slug, cwd, ageMs, restoreStatus }]
 *
 * Pure (besides the warn-log side effect on the two unprovable-age cases
 * below), no other IO. spawnInvestigation's own restore of a job's
 * pre-investigation status runs entirely inside the process that spawned the
 * probe (its withChildAndLog onExit handler, or the synchronous-throw catch
 * path) — so a job left 'investigating' when the app itself dies or restarts
 * has NOTHING left to restore it. The comment at spawnInvestigation's onExit
 * asserts "'investigating' must never be the job's resting state"; this is
 * the sweep that makes that true across a restart, not just within one.
 *
 * A row qualifies only when ALL of:
 *  - status is 'investigating'
 *  - its most recent transition INTO 'investigating' (statusHistory's last
 *    `to === 'investigating'` entry — a job can be investigated more than
 *    once across its life, e.g. a retried auto-fix) is older than `maxMs`
 *  - it has no live probe process behind it (checked via runtime.pid, set by
 *    spawnInvestigation once its child spawns and cleared on every restore
 *    path, the same shape reapDeadRunningJobs already uses for 'running' rows)
 *
 * `restoreStatus` is that transition entry's `from` — the exact value
 * spawnInvestigation itself would have restored to (`failedJob.status ||
 * 'failed'`), which for a row that already finished and recorded
 * finishedAt+exitCode (the burrow-834 shape) is whatever terminal status was
 * computed for that outcome BEFORE the probe was spawned — this sweep never
 * re-derives it from exitCode, only replays the already-recorded decision.
 *
 * A row with no recoverable transition timestamp cannot have its age proven,
 * so it is warn-logged and left alone rather than guessed at — same posture
 * as findStaleQuarantinedJobs/findOverrunningJobs.
 *
 * `restoreStatus` is validated against LEGAL_TRANSITIONS['investigating']
 * before being returned — `statusHistory`'s `from` should only ever be
 * 'failed' or 'needs_review' (the only two states LEGAL_TRANSITIONS allows
 * into 'investigating'), but a corrupted/unexpected value must not be handed
 * straight to transitionJob: an illegal target is refused outright (row stays
 * stuck at 'investigating', re-detected as stranded every sweep with no path
 * out), so an out-of-set `from` falls back to 'failed' here instead.
 */
const INVESTIGATING_RESTORE_TARGETS = new Set(LEGAL_TRANSITIONS.investigating);
function findStrandedInvestigations(jobs, now, maxMs, isAlive = claudePidAlive) {
  const out = [];
  for (const j of jobs ?? []) {
    if (j.status !== 'investigating') continue;
    const entries = (j.statusHistory || []).filter((h) => h.to === 'investigating');
    const entry = entries[entries.length - 1];
    if (!entry) {
      console.warn(`[scheduler] findStrandedInvestigations: ${j.slug} is 'investigating' with no statusHistory entry recording the transition — cannot prove age, leaving alone`);
      continue;
    }
    const since = Date.parse(entry.at ?? '');
    if (Number.isNaN(since)) {
      console.warn(`[scheduler] findStrandedInvestigations: ${j.slug} has an unparseable investigating-transition timestamp (${entry.at}) — cannot prove age, leaving alone`);
      continue;
    }
    const ageMs = now - since;
    if (ageMs < maxMs) continue; // a live probe must not be yanked out from under itself
    const pid = j.runtime?.pid;
    if (pid && isAlive(pid)) continue; // probe genuinely still running — not stranded
    const restoreStatus = INVESTIGATING_RESTORE_TARGETS.has(entry.from) ? entry.from : 'failed';
    out.push({ slug: j.slug, cwd: j.cwd ?? null, ageMs, restoreStatus });
  }
  return out;
}

// An empty queue and an unreadable queue are NOT the same thing, and
// conflating them is destructive: reconcile() treats every PRD .md with no
// matching jobs[] row as a brand-new goal and re-mints it as 'pending', so a
// single failed read that yields `jobs: []` re-queues the entire archive of
// already-completed work — then mutate() writes that empty array back and the
// real statuses are gone. (2026-07-31: 189 completed jobs resurrected and
// fired into an ENOENT retry storm.)
//
// So: a MISSING file is a legitimately empty queue (first boot). A file that
// exists but won't read or parse is `unreadable` — a poison state that must
// never reach reconcile() or writeQueue(). Callers get the flag, not a lie.
// (The single-file EMPTY_QUEUE/shapeQueue readers were retired with the
// global queue.json — queueStore.cjs's merged readers own the shape now.)

// Quarantine a corrupt shard alongside itself (once per process — the first
// copy is the one that matters; later ticks would just overwrite it with the
// same bytes) so a human can diff it against the .bak-* snapshots.
let quarantined = false;
function flagUnreadable(state) {
  if (!state.unreadable) return state;
  if (!quarantined && state.unreadablePath) {
    quarantined = true;
    try {
      fs.copyFileSync(state.unreadablePath, `${state.unreadablePath}.corrupt-${Date.now()}`);
    } catch { /* best-effort: the read already failed, the copy may too */ }
  }
  console.error(`[scheduler] queue state unreadable — refusing to treat as empty: ${state.unreadable}`);
  logs.writeLine({
    level: 'error', scope: 'scheduler',
    message: 'queue state unreadable — scheduling halted until it reads clean',
    meta: { path: state.unreadablePath, error: state.unreadable },
  });
  return state;
}

// Storage is FEDERATED (lib/queueStore.cjs, 2026-07-31): per-project job
// shards under `<cwd>/session-manager-operations/scheduler/state/queue.json`
// plus one machine-runtime file (config/paused/lastRunAt). Reads merge every
// shard into the single state object all downstream logic already expects;
// writes split it back. The old global scheduled-plans/queue.json is retired
// (split at boot by queueStore.migrateLegacyGlobalQueue).

// Sync queue read — passed to the supervisor module (which calls it from
// supervisorTick / applyAction with no await) and the heartbeat interval.
// IPC handlers and mutate() use readQueue (async) below.
function readQueueSync() {
  const s = queueStore.readMergedSync();
  s.config = { ...DEFAULT_CONFIG, ...(s.config || {}) };
  return flagUnreadable(s);
}

// Async queue read — used on all IPC hot paths. Reading queue.json sync was
// blocking the main thread inside ipcMain.handle callbacks; awaiting the
// shard reads hands control back to the renderer between files.
async function readQueue() {
  const s = await queueStore.readMerged();
  s.config = { ...DEFAULT_CONFIG, ...(s.config || {}) };
  return flagUnreadable(s);
}

async function writeQueue(state) {
  // Last line of defence: never persist a state derived from a failed read.
  if (state && state.unreadable) {
    throw new Error(`refusing to write queue state from an unreadable read (${state.unreadable})`);
  }
  ensureDirs();
  await queueStore.writeSplit(state, state.config?.defaultCwd ?? DEFAULT_PROJECT_CWD);
}

// ---------- serialized mutation queue ----------

// All read-modify-write operations on queue.json go through mutate() so
// concurrent job completions in a parallel wave cannot lose each other's
// status updates. mutateTail is always a resolved promise even when the
// preceding mutate threw, so the chain never deadlocks.
let mutateTail = Promise.resolve();

function mutate(fn) {
  const next = mutateTail.then(async () => {
    const state = await readQueue();
    // Bail BEFORE fn runs: a mutator handed an unreadable (therefore empty)
    // state would compute its result from a queue that isn't there, and
    // writeQueue would then persist that fiction over the real file.
    if (state.unreadable) {
      throw new Error(`queue mutation skipped: queue.json unreadable (${state.unreadable})`);
    }
    const ret = await fn(state);
    await writeQueue(state);
    return ret;
  });
  mutateTail = next.catch(() => {}); // keep chain alive on errors
  return next;
}

// ---------- PRD parsing ----------

/**
 * Parse YAML-ish frontmatter — only the keys we use. We don't take a
 * yaml dep; the schema is small (title, cwd, estimateMinutes, parallelGroup)
 * and the format is documented in the user-facing README.
 */
// PRD parsing + dir-mtime cache live in scheduler/prdParser.cjs. Local wrappers
// preserve the existing call shape (callers don't need to thread PRDS_DIR).
const parsePrdRaw = prdParser.parsePrdRaw;
const parsePrd = prdParser.parsePrd;
// Aggregates every candidate PRD dir's files into one flat, sorted list.
// prdParser's dir-mtime cache is keyed per-dir internally by its own single
// mtime var, so scanning N dirs here costs N stat+readdir passes rather than
// one — acceptable: PRD counts per project are bounded (hundreds, not
// millions), and correctness across multiple project dirs matters more than
// preserving the single-dir cache's steady-state zero-read fast path.
async function listPrdFiles() {
  ensureDirs();
  const dirs = candidatePrdsDirs();
  const perDir = await Promise.all(dirs.map((dir) => prdParser.listPrdFiles(dir)));
  return perDir.flat().sort();
}

/**
 * Atomically mint a brand-new parallel-group NN for a PRD about to be
 * authored under the given project's own PRDs dir (falls back to
 * DEFAULT_PROJECT_CWD's dir when no cwd is supplied). See
 * prdParser.allocateParallelGroup for the collision-proof mechanics. Callers
 * wanting to join an EXISTING group (deliberate parallel siblings) skip this
 * and just reuse the NN prefix.
 */
async function allocateParallelGroup(cwd) {
  const dir = prdDirForCwd(cwd);
  await fsp.mkdir(dir, { recursive: true });
  // PRD 832: numbers are unique across the WHOLE project, not just the
  // allocator's bookkeeping dir — scan every Epic prds/ dir plus the
  // archive so a number used anywhere (even by a hand-authored or archived
  // PRD) is never reissued. The reservation markers + high-water sidecar
  // stay in `dir`; the cross-dir max only raises the floor.
  const targetCwd = cwd || DEFAULT_PROJECT_CWD;
  const extraDirs = [
    ...listEpicPrdDirs(targetCwd),
    path.join(prdDirForCwd(targetCwd), '..', 'prds-archived'),
  ];
  let extraFloor = 0;
  for (const d of extraDirs) {
    try {
      extraFloor = Math.max(extraFloor, await prdParser.maxParallelGroupInUse(d));
    } catch { /* missing dir — nothing allocated there */ }
  }
  return prdParser.allocateParallelGroup(dir, { extraFloor });
}

/**
 * Best-effort kill of a child claude PID that the previous app instance spawned
 * but never reaped. Used by init() to clean up the orphan tree on boot.
 *
 * Safety:
 *   - PID-recycling: between app death and this call, another process may have
 *     reused the PID. We read /proc/<pid>/cmdline (Linux) or `ps -p` (macOS)
 *     and only SIGTERM if the cmdline starts with the claude bin path.
 *   - Detached process group: jobs are spawned with detached:true so we kill
 *     -pid (the group). If the group leader is already gone, that fails
 *     silently and we fall back to single-pid kill.
 *   - Returns synchronously after issuing SIGTERM; a 5s SIGKILL follow-up is
 *     scheduled via setTimeout to clean up any process ignoring SIGTERM.
 *
 * Returns: 'killed' (cmdline matched + signal sent), 'gone' (pid not alive),
 *          'mismatch' (pid alive but cmdline doesn't look like claude),
 *          'unknown' (couldn't read cmdline — leave the pid alone).
 */
function killOrphanClaudePid(pid) {
  if (!pid || typeof pid !== 'number' || pid <= 1) return 'gone';
  try { process.kill(pid, 0); } catch { return 'gone'; }
  let cmdline = '';
  try {
    cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
  } catch {
    try {
      const out = require('node:child_process').execSync(`ps -p ${pid} -o command=`, { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] });
      cmdline = out.trim();
    } catch { return 'unknown'; }
  }
  if (!/\bclaude\b/.test(cmdline)) return 'mismatch';
  try { process.kill(-pid, 'SIGTERM'); }
  catch { try { process.kill(pid, 'SIGTERM'); } catch { /* race: died between checks */ } }
  setTimeout(() => {
    try { process.kill(pid, 0); } catch { return; /* already gone */ }
    try { process.kill(-pid, 'SIGKILL'); }
    catch { try { process.kill(pid, 'SIGKILL'); } catch { /* race */ } }
  }, 5000).unref?.();
  return 'killed';
}

/**
 * Validate that a string is safe to pass as a child_process.spawn argv element.
 *
 * Node.js rejects argv strings containing NUL bytes with a cryptic error:
 *   "The argument 'args[1]' must be a string without null bytes. Received '...'"
 *
 * The error message truncates the offending string at ~120 chars, so when it
 * surfaces in the queue.json `error` field the user has no way to find the
 * actual byte. The real incident (2026-05-21, PRD 03-doc-editor-foundation)
 * was a single NUL inside backtick code-fence in the PRD body. Total wall-clock
 * to diagnose: ~30min. This validator catches it pre-spawn and reports the
 * file + offset + surrounding context.
 *
 * Also flags other ASCII control bytes (< 0x20 except TAB/LF/CR), since they
 * are virtually always a typo or copy-paste artifact in a markdown PRD body
 * and may cause subtle issues in claude's prompt tokenizer.
 */
function validatePromptForSpawn(body, srcLabel) {
  for (let i = 0; i < body.length; i++) {
    const code = body.charCodeAt(i);
    if (code < 0x20 && code !== 0x09 && code !== 0x0A && code !== 0x0D) {
      const start = Math.max(0, i - 20);
      const end = Math.min(body.length, i + 20);
      const ctx = body.slice(start, end).replace(/[\x00-\x1F]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
      const hex = code.toString(16).padStart(2, '0');
      return {
        ok: false,
        error: `PRD body contains control char 0x${hex} at byte offset ${i} in ${srcLabel} (context: "${ctx}"). child_process.spawn would reject this with a truncated error message; remove the control char and re-queue.`,
      };
    }
  }
  return { ok: true };
}

// ---------- queue reconciliation ----------

/**
 * sourcePromptId backfill (PRD 830) is pending-only: a pending row always
 * takes the freshly-parsed value (explicit frontmatter, or the dir-derived
 * epic id parsePrd falls back to when frontmatter has none) since it hasn't
 * started executing yet. A running/completed row's sourcePromptId is left
 * exactly as it was minted at dispatch time — reconcile must not rewrite
 * linkage on work already in flight or finished.
 */
function reconcileSourcePromptId(job, parsedSourcePromptId) {
  return job.status === 'pending'
    ? (parsedSourcePromptId ?? job.sourcePromptId ?? null)
    : job.sourcePromptId;
}

/**
 * Walk prds/, ensure every .md has a queue entry. Drop entries whose .md
 * is gone. Refresh title/cwd/parallelGroup from disk every reconcile so
 * editing the .md after queueing is honored.
 *
 * Status is preserved: pending stays pending, completed stays completed.
 * Newly-discovered PRDs land as `pending`.
 */
// Epic ids already warned about (PRD-bearing but absent from
// active-index.json). Module-scoped so the warning is one line per Epic per
// process rather than one per 60s reconcile tick.
const warnedUnregisteredEpics = new Set();

async function reconcile(state) {
  // Defence in depth — tickQueue already gates on this, but reconcile is the
  // function that would do the damage (every unmatched PRD .md becomes a
  // fresh 'pending' row), so it refuses the poison state itself.
  if (state && state.unreadable) {
    throw new Error(`reconcile skipped: queue.json unreadable (${state.unreadable})`);
  }
  // Sweep the retired flat prds/ dir BEFORE scanning it below. reconcile()
  // has several callers besides tickQueue's ~60s poll (broadcast,
  // rescheduleTimer, the schedule:state IPC handler, schedule:rescan) — this
  // lives here, not in any one caller, so the "a hand-written PRD in the flat
  // dir is swept before it can become a job" guarantee holds regardless of
  // which caller triggers this reconcile pass. A freshly hand-written file
  // has no queue row yet, so it is never "live" and gets archived here
  // instead of ever reaching the onDisk scan below.
  await consolidateAllFlatPrds(allProjectCwds());
  const files = await listPrdFiles();
  const onDisk = new Map();
  for (const f of files) {
    try {
      // Per-file await: parsing is mtime-cached so steady-state hits zero
      // disk reads; on cold cache the awaits keep the main thread responsive.
      const p = await parsePrd(f);
      onDisk.set(p.slug, p);
    } catch (e) {
      console.warn('[scheduler] failed to parse', f, e?.message);
    }
  }

  const next = [];
  const seen = new Set();
  // Terminal (completed/failed) jobs whose .md vanished from disk BEFORE
  // their row ever crossed HISTORY_RETENTION_MS in partitionJobs — i.e. the
  // common case, since archiveCompletedPrd() (called right when a job
  // finishes, scheduler.cjs's `newlyCompletedPrds` handling) moves the PRD
  // file immediately, while partitionJobs' appendHistory only fires after 7
  // days. Bug found 2026-08-02: the old code below dropped these rows on the
  // very next reconcile() pass with NO history write at all — the file-gone
  // check couldn't tell "already recorded to history.jsonl on a prior pass"
  // apart from "never recorded anywhere", so a job that completed and had
  // its file auto-archived within minutes lost its history entirely. Both
  // Queue and History tabs then read as empty even for projects with real,
  // successfully-completed work. Collected here; reconciled against
  // historyTerminalBySlug() below and backfilled before being dropped.
  const terminalDroppedNeedingHistoryCheck = [];
  for (const job of state.jobs) {
    const p = onDisk.get(job.slug);
    if (!p) {
      // A terminal job whose .md is gone was archived on purpose — dropping
      // its row is the intended end of the auto-archive flow, PROVIDED it's
      // already durably recorded in history.jsonl (checked below).
      //
      // A PENDING or RUNNING job whose .md is merely not VISIBLE is a
      // different thing entirely, and dropping it destroys queued work: the
      // file may be unreadable, on a project whose dir failed to enumerate,
      // or mid-move. "I can't see it" is not "the user deleted it", so the
      // row survives — worst case it re-resolves on the next pass.
      if (job.status === 'pending' || job.status === 'running' || job.status === 'quarantined') {
        // Exception: a PENDING row whose PRD has an archived twin was
        // retired on purpose (work landed by other means — e.g. implemented
        // inline — and the source .md moved to prds-archived/). Keeping it
        // would show a phantom "scheduled" job forever; firing it would just
        // hit executeJob's archived-twin skip anyway. Running rows are left
        // alone — the reaper owns their lifecycle. A quarantined row's file
        // going merely-not-visible must survive too — quarantine is meant to
        // be loud and reversible, never a silent drop (see this function's
        // header comment on the 2026-08-01 outage a silent skip caused).
        if (job.status === 'pending' && (await archivedTwinExists(job))) {
          console.log(`[scheduler] reconcile: retiring pending job ${job.slug} — PRD already archived (work landed elsewhere)`);
          continue;
        }
        seen.add(job.slug);
        next.push({ ...job });
        console.warn(`[scheduler] reconcile: keeping ${job.status} job ${job.slug} — PRD source not visible in any candidate dir`);
      } else if (job.status === 'completed' || job.status === 'failed' || job.status === 'skipped') {
        terminalDroppedNeedingHistoryCheck.push(job);
      }
      continue;
    }
    seen.add(job.slug);
    const updatedJob = {
      ...job,
      title: p.title,
      cwd: p.cwd,
      parallelGroup: p.parallelGroup,
      estimateMinutes: p.estimateMinutes,
      sourcePromptId: reconcileSourcePromptId(job, p.sourcePromptId),
      sourceTabId: p.sourceTabId,
      // Unlike sourcePromptId (frozen once a row leaves 'pending'), epicId is
      // refreshed from disk every pass: the PRD's directory IS its Epic
      // membership, so moving the file between Epic dirs must re-point the row.
      epicId: p.epicId ?? job.epicId ?? null,
      dependsOn: p.dependsOn,
      quietMachine: p.quietMachine === true,
      originSessionId: job.originSessionId
        ?? resolveOriginSessionId(p.cwd, p.epicId ?? reconcileSourcePromptId(job, p.sourcePromptId)),
      bodyPreview: p.body.split('\n').slice(0, 6).join('\n'),
      agentType: p.agentType ?? job.agentType ?? null,
    };
    // Adopt path: a row parked 'quarantined' (no createdVia provenance when
    // discovered) whose PRD file now carries a stamp — written via the
    // update-prd API's adopt patch, either the Scheduler tab's one-click
    // "adopt PRD" action or a manual scheduler_update_prd call — promotes to
    // 'pending' the very next reconcile pass. This is the ONLY way a
    // quarantined row becomes runnable; nothing else in reconcile() clears
    // that status.
    if (updatedJob.status === 'quarantined' && p.createdVia) {
      transitionJob(updatedJob, 'pending', {
        reason: `adopted via API (createdVia=${p.createdVia})`,
        source: 'reconcile-adopt',
      });
      console.log(`[scheduler] reconcile: adopted quarantined PRD ${job.slug} — createdVia=${p.createdVia}`);
      appendAuditEvent('scheduler_prd_adopted', { slug: job.slug, cwd: p.cwd, createdVia: p.createdVia, source: 'reconcile' });
    }
    // Backfill a quarantine timestamp for rows quarantined before the
    // statusHistory stamp below existed (e.g. the burrow-project rows
    // quarantined under the PRD-authoring lockdown) — findStaleQuarantinedJobs
    // needs SOME timestamp to escalate an un-adopted row past its age
    // threshold, and the PRD file's own mtime is the best available proxy
    // for "when this file first showed up unstamped" for a row that has
    // never been touched since.
    if (updatedJob.status === 'quarantined' && !(updatedJob.statusHistory || []).some((h) => h.to === 'quarantined')) {
      try {
        const at = new Date(fs.statSync(p.path).mtimeMs).toISOString();
        const history = Array.isArray(updatedJob.statusHistory) ? [...updatedJob.statusHistory] : [];
        history.push({ from: null, to: 'quarantined', reason: 'backfilled from PRD file mtime', source: 'reconcile-backfill', at });
        updatedJob.statusHistory = history;
      } catch { /* best-effort only — a missing/unreadable file just skips the backfill */ }
    }
    next.push(updatedJob);
  }
  // Slugs on disk with no matching state.jobs row are normally brand-new
  // PRDs — but once queueHistory.partitionJobs (above, later this same
  // function) has been dropping terminal jobs into history.jsonl across
  // prior reconcile passes, an old completed/failed job's row can ALSO be
  // "unmatched" simply because it already left jobs[]. Without this check
  // it would get resurrected below as a fresh 'pending' entry and the
  // scheduler would genuinely re-execute an already-completed PRD — the
  // exact backlog this auto-archive feature exists to clean up. Only pay
  // the history lookup when there's actually an unmatched slug to resolve.
  const unmatchedSlugs = [];
  for (const [slug] of onDisk) {
    if (!seen.has(slug)) unmatchedSlugs.push(slug);
  }
  // Rows quarantined by queueStore.shapeJobs because their `status` failed
  // ScheduleJobSchema (e.g. the 1021/1022 incident's `"status": "queued"`) —
  // see the repair pass below, right after historyBySlug is available.
  const invalidJobs = Array.isArray(state.invalidJobs) ? state.invalidJobs : [];
  const historyBySlug = (unmatchedSlugs.length > 0 || terminalDroppedNeedingHistoryCheck.length > 0 || invalidJobs.length > 0)
    ? await queueHistory.historyTerminalBySlug()
    : new Map();

  // Backfill: any terminal job dropped above whose slug isn't already in
  // history.jsonl gets written now, before its row is gone for good. This is
  // the fix for the bug described where the loop collects
  // terminalDroppedNeedingHistoryCheck — without it, a job whose PRD file was
  // auto-archived immediately on completion (the normal case) is lost from
  // both jobs[] and history.jsonl in the same reconcile pass.
  if (terminalDroppedNeedingHistoryCheck.length > 0) {
    const missing = terminalDroppedNeedingHistoryCheck.filter((j) => !historyBySlug.has(j.slug));
    if (missing.length > 0) {
      await queueHistory.appendHistory(missing);
      console.log(`[scheduler] reconcile: backfilled ${missing.length} completed/failed job(s) into history.jsonl (PRD file already archived, row about to drop)`);
    }
  }

  // Repair pass: an invalid row must self-heal within this one tick, not
  // wait for its slug to also drop out of `seen` via some unrelated code
  // path. Before this pass, reconcile was add-only (`if (seen.has(slug))
  // continue` below) — a quarantined row simply vanished from state.jobs
  // with no log of what its bad status actually was and no repair, which is
  // how the 1021/1022 rows sat invisible for 4+ hours (2026-08-07).
  let repairedInvalidCount = 0;
  for (const inv of invalidJobs) {
    if (seen.has(inv.slug)) continue; // a valid row for this slug already exists
    const oldStatus = inv.row?.status;
    const hist = historyBySlug.get(inv.slug) ?? latestTerminalOutcomeForSlug(inv.slug, { runsDir: RUNS_DIR });
    if (hist) {
      // Never resurrect: this slug already has a durable terminal record
      // elsewhere (history.jsonl or a run sidecar) — repairing its corrupted
      // row back to 'pending' would re-execute already-shipped work. Drop
      // the row (its real outcome is recorded elsewhere), loudly.
      console.warn(`[scheduler] reconcile: dropping invalid queue row ${inv.slug} (status was ${JSON.stringify(oldStatus)}) — already terminal (${hist.status}) in history/run sidecar, not resurrecting`);
      appendAuditEvent('scheduler_row_repaired', {
        slug: inv.slug, cwd: inv.row?.cwd ?? null, oldStatus: oldStatus ?? null,
        action: 'dropped-already-terminal', terminalStatus: hist.status, issues: inv.issues,
      });
      continue;
    }
    const p = onDisk.get(inv.slug);
    if (!p) {
      // PRD file also gone with no terminal record anywhere — nothing to
      // repair against. queueStore already logged the quarantine once.
      continue;
    }
    const job = {
      ...inv.row,
      slug: inv.slug,
      title: p.title,
      cwd: p.cwd,
      parallelGroup: p.parallelGroup,
      estimateMinutes: p.estimateMinutes,
      sourcePromptId: p.sourcePromptId ?? inv.row?.sourcePromptId ?? null,
      sourceTabId: p.sourceTabId ?? inv.row?.sourceTabId ?? null,
      epicId: p.epicId ?? inv.row?.epicId ?? null,
      dependsOn: p.dependsOn,
      quietMachine: p.quietMachine === true,
      originSessionId: inv.row?.originSessionId ?? resolveOriginSessionId(p.cwd, p.epicId ?? p.sourcePromptId),
      bodyPreview: p.body.split('\n').slice(0, 6).join('\n'),
      agentType: p.agentType ?? inv.row?.agentType ?? null,
    };
    const reason = `reconcile: repaired invalid status ${JSON.stringify(oldStatus)}`;
    // A repair is not a lifecycle transition — the corrupted `status` was
    // never a legal predecessor to check against LEGAL_TRANSITIONS, so this
    // goes through transitionJob's allowAnyFrom escape hatch (still gets the
    // normal mutation/statusHistory/audit trail, just skips the legality
    // gate on `from`) rather than a bare field assignment.
    transitionJob(job, 'pending', { reason, source: 'reconcile-repair', allowAnyFrom: true });
    if (job.runId || job.startedAt || job.runtime) {
      // This row had actually begun executing before its status got
      // corrupted.
      job.runId = null;
      job.startedAt = null;
      job.finishedAt = null;
      job.exitCode = null;
      delete job.runtime;
      delete job.verifierVerdict;
    }
    job.error = null;
    seen.add(inv.slug);
    next.push(job);
    repairedInvalidCount += 1;
    console.warn(`[scheduler] reconcile: repaired invalid queue row ${inv.slug} — status was ${JSON.stringify(oldStatus)}, reset to 'pending' (${inv.issues})`);
    appendAuditEvent('scheduler_row_repaired', {
      slug: inv.slug, cwd: p.cwd, oldStatus: oldStatus ?? null, newStatus: 'pending', issues: inv.issues,
    });
  }
  if (repairedInvalidCount > 0) {
    console.warn(`[scheduler] reconcile: repaired ${repairedInvalidCount} invalid queue row(s) this pass`);
  }

  // Terminal-in-history slugs whose .md file is still on disk: fed into the
  // auto-archive selection pass below (as synthetic completed entries) so
  // their file can still be swept, without ever creating a live job row
  // for them (that row already exists, durably, in history.jsonl).
  const historyArchiveCandidates = [];

  // Cache active-index.json reads per cwd across this reconcile pass — many
  // unmatched PRDs typically share a project, and readActiveIndex is a
  // synchronous fs.readFileSync.
  const epicStatusCache = new Map(); // cwd -> { sessions }
  function epicStatus(cwd, epicId) {
    if (!cwd || !epicId) return null;
    let idx = epicStatusCache.get(cwd);
    if (!idx) {
      idx = readActiveIndex(cwd);
      epicStatusCache.set(cwd, idx);
    }
    return idx.sessions[epicId]?.status ?? null;
  }

  let staleNewDiscoveryCount = 0;
  for (const [slug, p] of onDisk) {
    if (seen.has(slug)) continue;
    // Security gate: a PRD's file location IS its Epic membership
    // (prdLocations.deriveEpicIdFromPrdPath / p.epicId). Before this check,
    // the scheduler queued ANY .md file it found under an Epic's prds/ dir
    // regardless of that Epic's status or even whether it was ever properly
    // minted — so a PRD filed under a 'proposed' Epic (agent-proposed,
    // awaiting human Approve & start via EpicApprovalBar), or one dropped
    // straight onto disk under a directory that was never registered via
    // ensureEpic()/active-index.json at all (bypassing the app entirely),
    // would still execute as a claude -p job with --dangerously-skip-permissions.
    // Block ONLY an explicit 'proposed' — the actual human gate. The human's
    // Approve action flips status to 'active' (state/promptSessions.ts) and
    // the very next reconcile pass picks the PRD up with no other change.
    //
    // This deliberately does NOT require a positive 'active' registration.
    // That stricter form shipped briefly and caused a 6-hour silent outage
    // (2026-08-01): 23 real PRDs whose Epic dir existed on disk but had no
    // active-index.json entry were skipped forever with no log line, so the
    // scheduler looked simply dead. Absence of an entry is not evidence of a
    // rogue writer — an Epic archived on completion also leaves active-index,
    // and other paths can create the dir without registering it. Fail-closed
    // is right for the approval gate; it is wrong as a blanket requirement,
    // because the failure mode is invisible and unrecoverable by the user.
    const ownerStatus = epicStatus(p.cwd, p.epicId);
    if (p.epicId && ownerStatus === 'proposed') {
      continue;
    }
    // Unregistered Epic dir: allowed, but never silently — this is the only
    // signal that a PRD's Epic is missing from the index it should be in.
    if (p.epicId && ownerStatus === null && !warnedUnregisteredEpics.has(p.epicId)) {
      warnedUnregisteredEpics.add(p.epicId);
      console.warn(`[scheduler] epic ${p.epicId} (${p.cwd}) has PRDs on disk but no active-index.json entry — queuing anyway; register or archive it to silence this`);
    }
    const hist = historyBySlug.get(slug);
    if (hist) {
      if (hist.status === 'completed') {
        historyArchiveCandidates.push({ slug, status: hist.status, finishedAt: hist.finishedAt });
      }
      // 'failed' (or any other terminal status found in history) is left
      // alone entirely: not resurrected, not archived — matches "needs_
      // review and failed PRD files are NEVER auto-archived."
      continue;
    }
    // history.jsonl may not exist yet (nothing has crossed HISTORY_RETENTION_MS
    // since the feature shipped), which leaves historyBySlug empty and the
    // guard above inert. Fall back to reading the slug's own newest run
    // sidecars straight off disk — same "don't resurrect an already-terminal
    // slug" intent, independent of history.jsonl's existence.
    const fallback = latestTerminalOutcomeForSlug(slug, { runsDir: RUNS_DIR });
    if (fallback) {
      if (fallback.status === 'completed') {
        historyArchiveCandidates.push({ slug, status: fallback.status, finishedAt: fallback.finishedAt });
      }
      continue;
    }
    const entry = {
      slug,
      title: p.title,
      cwd: p.cwd,
      parallelGroup: p.parallelGroup,
      estimateMinutes: p.estimateMinutes,
      sourcePromptId: p.sourcePromptId,
      sourceTabId: p.sourceTabId,
      epicId: p.epicId ?? null,
      dependsOn: p.dependsOn,
      quietMachine: p.quietMachine === true,
      originSessionId: resolveOriginSessionId(p.cwd, p.epicId ?? p.sourcePromptId),
      bodyPreview: p.body.split('\n').slice(0, 6).join('\n'),
      agentType: p.agentType ?? null,
      status: 'pending',
      // Enqueue time (PRD 1086/1087): the cross-project fairness tiebreak and
      // the starvation escalation both need a provable age for a pending row;
      // before this stamp a freshly minted row carried no timestamp at all.
      queuedAt: new Date().toISOString(),
      runId: null,
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      error: null,
    };
    // Newly-discovered fix-plan PRD: stamp its investigationDepth relative to
    // the original job it heals, so selectAutoFixTargets/spawnInvestigation
    // can bound the fix-of-a-fix recursion (see MAX_INVESTIGATION_DEPTH).
    // Non-fix-plan jobs get no explicit field — they read as depth 1 via `?? 1`.
    if (isFixPlanSlug(slug)) {
      const parent = healTargetForFix(slug, state.jobs);
      entry.investigationDepth = parent ? (parent.investigationDepth ?? 1) + 1 : 2;
    }
    // Provenance gate (PRD-authoring lockdown): a PRD discovered with no
    // `createdVia` stamp was never written through scheduler_create_prd/
    // chat:create-prd (prdCreate.cjs always stamps 'scheduler-api') or the
    // legacy-adopt boot migration ('legacy-adopted') — it bypassed the
    // sanctioned API, most likely via a raw Write/Edit tool call the
    // guard-prd-writes.cjs PreToolUse hook should have denied. Fix-plan PRDs
    // are exempt: spawnInvestigation's own probe writes them directly by
    // design (a trusted, scheduler-spawned internal loop, not an
    // agent/human authoring a PRD), matching the isFixPlanSlug convention
    // used everywhere else this distinction matters.
    //
    // Quarantine is loud and reversible, never a silent skip (see the
    // 2026-08-01 23-PRD outage this file's header references for what a
    // SILENT skip costs): logged at warn, audited, and surfaced in the
    // Scheduler tab's Quarantined filter with a one-click adopt action
    // (schedule:adopt-prd) that stamps the file via the same update-prd API
    // route the MCP tool uses — reconcile()'s adopt path above promotes it
    // to 'pending' on the very next pass, within one tick of being stamped.
    if (!p.createdVia && !isFixPlanSlug(slug)) {
      entry.status = 'quarantined';
      // Stamped at creation (not via transitionJob, since this is a
      // brand-new row minted directly at 'quarantined' rather than
      // transitioning through 'pending') so findStaleQuarantinedJobs has a
      // real quarantine timestamp to escalate against, instead of only the
      // reconcile-backfill fallback above.
      entry.statusHistory = [{
        from: null,
        to: 'quarantined',
        reason: 'missing createdVia provenance frontmatter',
        source: 'reconcile',
        at: new Date().toISOString(),
      }];
      console.warn(`[scheduler] reconcile: quarantining unstamped PRD ${slug} (${p.path}) — no createdVia provenance; adopt it from the Scheduler tab's Quarantined filter or via scheduler_update_prd to make it runnable`);
      appendAuditEvent('prd_quarantined', { slug, cwd: p.cwd, path: p.path, reason: 'missing createdVia provenance frontmatter' });
    }
    // A PRD with no queue row and no terminal record is normally a
    // brand-new file — but one whose mtime already predates a full poll
    // interval means it sat unpicked (a prior reconcile pass should have
    // caught it, or it's arriving from a source that bypassed the app's
    // normal write path). Report it rather than silently treating "first
    // seen this pass" as "just created".
    try {
      const ageMs = Date.now() - fs.statSync(p.path).mtimeMs;
      if (ageMs > POLL_INTERVAL_MS) {
        staleNewDiscoveryCount += 1;
        console.warn(`[scheduler] reconcile: discovered PRD ${slug} with no queue row and no terminal record — file is ${Math.round(ageMs / 1000)}s old, only first seen this pass`);
      }
    } catch { /* stat is best-effort reporting only */ }
    next.push(entry);
  }
  if (staleNewDiscoveryCount > 0) {
    console.warn(`[scheduler] reconcile: ${staleNewDiscoveryCount} PRD(s) discovered this pass were already older than one poll interval with no prior queue row`);
  }
  const sorted = next.sort((a, b) => b.slug.localeCompare(a.slug));

  // Move terminal jobs past the retention window out to history.jsonl so
  // queue.json (mutation cost, broadcast payload, pickNextBatch scan) stays
  // small. Append BEFORE dropping so a crash between the two can't lose a
  // record — appendHistory dedupes by slug+runId, so a replay of the same
  // batch on next boot is a safe no-op.
  const nowMs = Date.now();
  const { hot, toArchive } = queueHistory.partitionJobs(sorted, nowMs);
  if (toArchive.length > 0) {
    await queueHistory.appendHistory(toArchive);
    console.log(`[scheduler] queue history: archived ${toArchive.length} job(s), jobs[] ${sorted.length} -> ${hot.length}`);
    state.jobs = hot;
  } else {
    state.jobs = sorted;
  }

  // Auto-archive completed PRDs' .md files out of the live prds/ dir. Runs
  // AFTER the history append above (which is awaited) so a job's queue row
  // is always durably in history.jsonl before its file can be moved — a
  // file is never removed ahead of its queue row. `sorted` (not `hot`) is
  // passed so a job that just crossed retention THIS pass is eligible for
  // file-archiving in the same pass, per its already-persisted history row.
  // `historyArchiveCandidates` adds slugs whose row left jobs[] on an
  // EARLIER pass (or before this feature shipped) — same predicate applies
  // via selectAutoArchivable, they just don't get a live job row.
  try {
    const archiveInput = historyArchiveCandidates.length > 0
      ? sorted.concat(historyArchiveCandidates)
      : sorted;
    const archiveResult = await queueOps.autoArchiveCompleted({ jobs: archiveInput }, { nowMs });
    if (archiveResult.archived > 0) {
      console.log(`[scheduler] auto-archived ${archiveResult.archived} completed PRD file(s) -> ${archiveResult.archivedTo}`);
    }
  } catch (e) {
    console.warn('[scheduler] autoArchiveCompleted failed', e?.message);
  }

  return state;
}

// ---------- next-reset detection ----------

let cachedNextReset = null; // bare ISO string or null
let cachedUtilization = null; // five_hour utilization %, 0–100, or null if unknown

/** Fetches latest usage from billing API. Throws on any error — callers handle it. */
async function refreshNextReset() {
  const r = await billing.fetchUsage();
  if (r.kind !== 'ok') throw new Error(`usage fetch failed (${r.kind}): ${r.message ?? ''}`);
  cachedNextReset = r.data?.usage?.five_hour?.resets_at ?? null;
  cachedUtilization = r.data?.usage?.five_hour?.utilization ?? cachedUtilization;
  return cachedNextReset;
}

function getNextResetCached() {
  return cachedNextReset;
}

// ---------- health / poll state ----------

let bootedAt = Date.now();
let lastPollAt = null;
let lastPollOk = false;
let consecutiveFailures = 0;
let backoffMs = 0;
let backoffNextAt = null;
let firstFailureAt = null;
let firstNon429FailureAt = null; // tracks only transient/config failures; 429s don't count toward network-pause threshold
let lastFailureKind = null; // 'transient' | 'meter_rate_limited' | 'auth' | null
let pauseClearedManuallyAt = null;
// PRD 1119: consecutive-rapid-rate-limit hard-pause tracking, keyed per slug.
// See isCooldownSuppressed/nextRapidRateLimitCount below for the pure rules.
const consecutiveRapidRateLimitsBySlug = new Map();

// ---------- timer ----------

let mainWindow = null;
let fireTimer = null;
let resumeTimer = null;
let pollLoopTimer = null;
let rescheduleInterval = null;
let heartbeatInterval = null;
// Stall-detector state (computeStallSummary), read/written only inside the
// heartbeat interval below. Keyed per-project cwd (never a single value) —
// a single module-level flag would let one busy project's activity clear or
// suppress another stalled project's alert. stallSince.get(cwd): wall-clock
// ms that project's stalled condition was first observed, absent when clear.
// stallToasted.get(cwd): rate-limits that project's error-log + toast to
// once per stall episode (cleared the moment that project stops being
// stalled) rather than every 60s heartbeat tick.
let stallSince = new Map();
let stallToasted = new Map();
// (The 5-minute feedback sweep that used to piggyback on this heartbeat is
// gone: it scanned each active project's session-manager-operations/feedback/
// and auto-queued a /process-feedback PRD. Both the folder and that skill are
// retired, and nothing auto-creates work any more — a parked job is surfaced
// back into the Epic that authored its PRD instead. See lib/rcaReport.cjs.)
// In-memory set of slugs currently spawned in this process. Prevents
// double-spawn when runDueJobs() is called while jobs are in flight.
const runningSet = new Set();
// Auto-fix investigations spawn Opus `claude -p` OUTSIDE runningSet/pickNextBatch,
// so they must be capped independently or a boot with N needs_review jobs fans out
// N concurrent Opus processes — the >3-concurrent class that OOM-killed Electron.
// Over-cap requests are QUEUED (not dropped) and drained as slots free, so a failed
// PRD that never reaches 'needs_review' still eventually gets its fix-plan authored.
let investigationsInFlight = 0;
const MAX_CONCURRENT_INVESTIGATIONS = 1;
const deferredInvestigations = new Map(); // fixable-job slug -> { failedJob, runDir }

function drainDeferredInvestigation() {
  if (investigationsInFlight >= MAX_CONCURRENT_INVESTIGATIONS) return;
  const next = deferredInvestigations.entries().next();
  if (next.done) return;
  const [slug, ctx] = next.value;
  deferredInvestigations.delete(slug);
  spawnInvestigation(ctx.failedJob, ctx.runDir).catch((e) => {
    console.error('[scheduler] drained investigation error', slug, e);
  });
}
let cancelToken = { cancelled: false };
// Last memory-gate observation; included in snapshot for renderer visibility.
let lastMemGate = null;
// CPU-load launch gate (PRD 1085, lib/loadGate.cjs) — innermost launch
// predicate after pool → project cap → memory. Withholds launches only.
const loadGate = createLoadGate();

// Last tickQueue outcome, kept for the UI. tickQueue already computes a precise
// reason for every way a batch can come back empty (dependency holds, slot
// exhaustion, the memory gate, pause, manual policy) and used to throw all of
// it into console.log — so the Home slot count read "5" while the queue was
// actually pinned at 1 with nothing on screen explaining why. This is that
// explanation, recorded once per tick and broadcast with the rest of the state.
let lastTick = null;
function recordTick(outcome, extra = {}) {
  lastTick = { ...outcome, ...extra, at: new Date().toISOString() };
  return outcome;
}

/**
 * Pure: applies clearPause()'s effect on the tick cancel-token.
 *
 * ROOT CAUSE (2026-07-14 stall, PRD 543/544): setPaused() cancels the
 * in-flight tick batch by setting cancelToken.cancelled = true (e.g. when a
 * job's run is rate-limited). That flag was previously only ever reset back
 * to false inside runDueJobs() (used by the force-tick/run-now IPC handlers
 * and the resume-timer callback). clearPause() itself — the function the
 * poll-loop's auth/network auto-recovery and the manual "Resume" button
 * actually call — never reset it. So once ANY pause fired and was later
 * cleared through one of THOSE paths instead of runDueJobs(), cancelToken
 * .cancelled stayed permanently true, and tickQueue()'s very first guard
 * (`if (cancelToken.cancelled) return {fired:false, reason:'cancelled'}`)
 * silently short-circuited every future tick — from spawnJob's own
 * post-completion tick, from the when-available poll, and from the
 * dead-process reaper — forever, even though queue.json's `paused` field
 * was correctly null and every other gate (enabled, concurrency, memory)
 * said go. This explains the full incident: lastRunAt froze at the last
 * tick that got past the guard, new PRDs kept appearing as `pending`
 * because reconcile() also runs independently from the `schedule:state` IPC
 * read (unrelated to tickQueue), and only a manual force-tick (which goes
 * through runDueJobs()) could ever unwedge it.
 *
 * Exported so this regression is unit-testable without touching the real
 * scheduler's fs-backed queue.json.
 */
function applyPauseCleared(wasPaused, token) {
  if (wasPaused) token.cancelled = false;
  return token;
}

function attachWindow(w) { mainWindow = w; }

/**
 * Build the snapshot payload consumed by both the `schedule:state` IPC
 * handler and the `schedule:state` broadcast event. The IPC return adds a
 * `paths` map (renderer uses it for "open folder" actions); broadcast omits
 * it because subscribers don't need to re-derive paths on every tick.
 */
function buildScheduleStatePayload(state, { withPaths = false } = {}) {
  const payload = {
    config: state.config,
    jobs: state.jobs,
    scheduledFor: state.scheduledFor,
    lastRunAt: state.lastRunAt,
    nextReset: getNextResetCached(),
    paused: state.paused,
    // Launch circuit breaker (issue #11): which personas cannot launch right
    // now and why, plus any degraded-mode env in force. Empty objects when healthy.
    launchBlocks: state.launchBlocks ?? {},
    launchMitigations: state.launchMitigations ?? {},
    utilization: cachedUtilization,
    pollHealth: {
      lastPollAt,
      lastPollOk,
      consecutiveFailures,
      lastFailureKind,
    },
    memGate: lastMemGate,
    // Why nothing is launching when the box is CPU-saturated (PRD 1085).
    loadGate: loadGate.snapshot(),
    lastTick,
    // The machine-wide slot pool IS the concurrency limit — there is no
    // separate scheduler cap any more. `source` distinguishes the
    // SM_SESSION_SLOTS env override from the persisted Home-tab value so the
    // UI can disable its own control when the env has taken over.
    effectiveConcurrency: (() => {
      const snap = sessionSlots.snapshot();
      return {
        cap: snap.total,
        free: Math.max(0, snap.total - snap.inUse),
        source: snap.envOverride ? 'env' : 'pool',
      };
    })(),
  };
  if (withPaths) {
    payload.paths = { root: ROOT, prds: PRDS_DIR, runs: RUNS_DIR, queue: queueStore.MACHINE_STATE_PATH };
  }
  return payload;
}

// Trailing-edge debounce for the `schedule:state` IPC push: a burst of
// broadcast() calls (boot reverify healing several rows, poll-loop refreshes,
// queue-linter fixups) arms one BROADCAST_COALESCE_MS timer and sends a
// single payload built fresh at fire time, instead of one full-payload push
// per mutation. Callers where latency matters (pause/resume, job
// start/finish/reap/reset) pass `{ flush: true }` to bypass the window and
// send immediately.
const broadcastCoalescer = createBroadcastCoalescer({
  delayMs: BROADCAST_COALESCE_MS,
  send: (payload) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    sendIfAlive(mainWindow, 'schedule:state', payload);
  },
  getPayload: async () => buildScheduleStatePayload(await readQueue()),
});

async function broadcast(opts = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const state = await readQueue();
  await reconcile(state);
  await writeQueue(state);
  if (opts.flush) {
    await broadcastCoalescer.flush();
  } else {
    broadcastCoalescer.schedule();
  }
}

function clearFireTimer() {
  if (fireTimer) {
    clearTimeout(fireTimer);
    fireTimer = null;
  }
}

function computeFireAt(state, nextResetIso) {
  // Only the legacy 'on-reset' policy uses scheduled fire times. Other
  // policies fire either immediately on demand ('manual') or via the
  // when-available poll loop.
  if (state.config.firePolicy !== 'on-reset') return null;
  if (!nextResetIso) return null;
  const reset = new Date(nextResetIso).getTime();
  if (Number.isNaN(reset)) return null;
  return reset + (state.config.offsetMinutes * 60_000);
}

async function rescheduleTimer() {
  clearFireTimer();
  // Wrap in try/catch — on failure use the cached value so the on-reset
  // timer can still be armed from the last known reset.
  let nextResetIso;
  try {
    nextResetIso = await refreshNextReset();
  } catch {
    nextResetIso = cachedNextReset;
  }
  const fireAt = await mutate(async (state) => {
    await reconcile(state);
    const fa = computeFireAt(state, nextResetIso);
    state.scheduledFor = fa ? new Date(fa).toISOString() : null;
    return fa;
  });
  await broadcast();
  if (!fireAt) return;

  const delay = Math.max(1000, fireAt - Date.now());
  fireTimer = setTimeout(() => { runDueJobs().catch(() => {}); }, delay);
  console.log(`[scheduler] next fire in ${Math.round(delay / 1000)}s @ ${new Date(fireAt).toISOString()}`);
}

// ---------- pause / resume ----------

const MANUAL_PAUSE_COOLDOWN_MS = 300_000;
// PRD 1119: after this many consecutive rate-limited dispatches of the SAME
// slug that EACH also finished in under RAPID_RATE_LIMIT_WINDOW_MS, the rate
// limit is not a stale/flaky auto-detection any more — it's real and
// persistent for this job. Engage a hard pause the manual-clear cooldown
// cannot suppress at all. This exists because the freshness check alone
// (isCooldownSuppressed) is not sufficient: if the computed resumeAt is
// itself wrong or stale (e.g. a failed usage-API fetch), the resume timer
// can keep re-clearing the pause every ~30s, and every SUBSEQUENT dispatch
// is genuinely "fresh" (it started after that re-clear) — so freshness alone
// would let the spin continue indefinitely within the same 5-minute cooldown
// window. The rapid-repeat count is an independent circuit breaker of last
// resort for exactly that case.
const CONSECUTIVE_RAPID_RATE_LIMIT_THRESHOLD = 3;
const RAPID_RATE_LIMIT_WINDOW_MS = 30_000;

/**
 * Pure: should setPaused()'s manual-override cooldown suppress WRITING this
 * pause? `force` (the rapid-repeat hard pause) always answers no — that path
 * exists precisely to bypass the cooldown. Otherwise, suppress only while
 * inside the cooldown window AND the triggering observation is stale, i.e.
 * it was NOT produced by a run that started after the human's manual clear.
 * A run that started after the clear is fresh evidence the human's fix (if
 * any) did not hold, and must be allowed to re-engage the pause regardless
 * of the cooldown — the cooldown's job is to ignore STALE auto-detections,
 * never to ignore new evidence.
 */
function isCooldownSuppressed({ pauseClearedManuallyAt: clearedAt, now, observedAt, force }) {
  if (force) return false;
  if (!clearedAt) return false;
  if (now - clearedAt >= MANUAL_PAUSE_COOLDOWN_MS) return false;
  const isFresh = typeof observedAt === 'number' && observedAt > clearedAt;
  return !isFresh;
}

/**
 * Pure: the next consecutive-rapid-rate-limit count for a slug, given its
 * previous count and this run's outcome. Increments only on a rate-limited
 * run that ALSO ran under RAPID_RATE_LIMIT_WINDOW_MS (a genuine "dispatch,
 * 429, die" cycle — not a job that ran for a while before hitting the
 * limit). Resets to 0 on any non-rate-limited outcome. A rate-limited-but-
 * slow run leaves the count unchanged: still a rate limit, just not the
 * rapid-spin shape this cap exists to catch.
 */
function nextRapidRateLimitCount(prevCount, { rateLimited, durationMs }) {
  if (!rateLimited) return 0;
  if (durationMs < RAPID_RATE_LIMIT_WINDOW_MS) return (prevCount || 0) + 1;
  return prevCount || 0;
}

async function setPaused(reason, resumeAtIso, opts = {}) {
  const { observedAt = null, force = false } = opts;
  // Honor manual-override cooldown: if the user cleared a pause within the
  // last 5 minutes, suppress auto-pause re-engagement UNLESS this pause is
  // backed by a fresh observation (a run that started after the clear) or is
  // forced (the rapid-repeat hard pause, which the cooldown cannot suppress).
  if (isCooldownSuppressed({ pauseClearedManuallyAt, now: Date.now(), observedAt, force })) {
    console.log(`[scheduler] setPaused(${reason}) suppressed by manual override cooldown`);
    return;
  }
  if (force) {
    console.log(`[scheduler] setPaused(${reason}) forced past manual override cooldown — rapid-repeat rate-limit cap engaged`);
  } else if (pauseClearedManuallyAt && Date.now() - pauseClearedManuallyAt < MANUAL_PAUSE_COOLDOWN_MS) {
    console.log(`[scheduler] setPaused(${reason}) engaging despite manual override cooldown — triggering run started after the manual clear`);
  }

  // For 'network' with no explicit resumeAt, auto-resume after 30 minutes.
  let effectiveResumeAt = resumeAtIso;
  if (reason === 'network' && !resumeAtIso) {
    effectiveResumeAt = new Date(Date.now() + 30 * 60_000).toISOString();
  }

  await mutate((s) => {
    if (s.paused && s.paused.reason === reason) {
      if (effectiveResumeAt) s.paused.resumeAt = effectiveResumeAt;
    } else {
      s.paused = { reason, since: new Date().toISOString(), resumeAt: effectiveResumeAt || null };
    }
  });
  await broadcast({ flush: true });
  cancelToken.cancelled = true;
  if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
  if (!effectiveResumeAt) return;

  // Resume 30s after the reset to give the auth/billing endpoint time to flip.
  const delay = Math.max(30_000, new Date(effectiveResumeAt).getTime() - Date.now() + 30_000);
  if (delay > 0x7fffffff) {
    console.warn(`[scheduler] paused (${reason}); resumeAt too far for setTimeout (${delay}ms)`);
    return;
  }
  resumeTimer = setTimeout(async () => {
    await clearPause('resume-timer');
    runDueJobs().catch(() => {});
  }, delay);
  console.log(`[scheduler] paused (${reason}); auto-resume in ${Math.round(delay / 1000)}s`);
}

async function clearPause(source) {
  if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
  const humanOverride = source === 'manual' || source === 'run-now';
  const wasPaused = await mutate((s) => {
    // A human Resume / Run now also re-closes every launch circuit breaker:
    // the operator is asserting the environment is fixed (CLI updated,
    // re-logged-in). The next dispatch of each persona is its probe; if the
    // environment is still broken the breaker simply re-arms.
    if (humanOverride && s.launchBlocks && Object.keys(s.launchBlocks).length) {
      console.log(`[scheduler] clearPause (${source}): clearing launch blocks [${Object.keys(s.launchBlocks).join(', ')}]`);
      for (const j of s.jobs) if (j.status === 'pending' && j.heldReason && /^launch blocked/.test(j.heldReason)) delete j.heldReason;
      s.launchBlocks = {};
    }
    if (!s.paused) return false;
    console.log(`[scheduler] clearPause (${source || 'manual'})`);
    s.paused = null;
    return true;
  });
  // Un-cancel the tick guard on every recovery path, not just runDueJobs().
  applyPauseCleared(wasPaused, cancelToken);
  // Track manual clears for the auto-pause cooldown.
  if (source === 'manual' || source === 'run-now') {
    pauseClearedManuallyAt = Date.now();
    // The user has just affirmed the queue should run — clear the failure
    // counters so the renderer doesn't keep nagging about stale poll fails.
    // The next poll will set them again if the condition still applies.
    consecutiveFailures = 0;
    backoffMs = 0;
    backoffNextAt = null;
    firstFailureAt = null;
    firstNon429FailureAt = null;
    lastFailureKind = null;
    persistSchedulerState();
  }
  if (wasPaused) await broadcast({ flush: true });
}

/**
 * Mutate a job in place to "pending" with cleared run metadata.
 *
 * Refuses (no-ops, returns false) on a job already in a terminal success
 * state ('completed') unless opts.force is true — resetting a completed job
 * re-fires the PRD and re-executes already-shipped work (the false-failure
 * class PRD 812-workbench-review-nits-cleanup demonstrated: a completed job
 * was reset to pending and re-ran a correct no-op that then got flagged
 * needs_review). All internal call sites operate on jobs that are still
 * 'running'/'failed' at the point they call this, so the guard is a no-op
 * for them; only an external reset request (IPC/admin API) can target an
 * already-'completed' job, and that path is exactly what this guards.
 */
function resetJobFields(job, errorMsg, opts = {}) {
  if ((job.status === 'completed' || job.status === 'skipped') && opts.force !== true) return false;
  if (!transitionJob(job, 'pending', { reason: errorMsg ?? 'reset to pending', source: opts.source ?? 'resetJobFields' })) return false;
  job.runId = null;
  job.startedAt = null;
  job.finishedAt = null;
  job.exitCode = null;
  job.error = errorMsg ?? null;
  delete job.runtime;
  delete job.verifierVerdict;
  delete job.uncommittedPaths;
  delete job.resumeRecoveryAttempted;
  // Same "this run's outcome, not durable across a reset" category as the
  // fields above — a stale 'archive' recoveryAction from a prior life of this
  // slug must never survive a reset and silently exclude a genuinely-new
  // needs_review episode from selectAutoFixTargets (applyRcaClassification
  // only overwrites these on a successful RCA write, so without this they
  // can otherwise linger forever when RCA is disabled or errors).
  delete job.rcaFailureClass;
  delete job.rcaRecoveryAction;
  // Like exitCode: this run's outcome, not durable across a reset — a stale
  // leak badge from a prior attempt must not linger once the job re-fires.
  delete job.leakedDescendants;
  // A pending row is about to re-run fresh — a stale leftover badge or a
  // stale pre-run baseline from the attempt that just ended must not linger
  // and be mistaken for THIS (not-yet-run) attempt's own output. spawnJob
  // persists a brand-new guardBaseline at the next dispatch.
  delete job.guardBaseline;
  delete job.guardHeadBefore;
  delete job.leftoverPaths;
  delete job.leftoverCount;
  delete job.leftoverPathsTruncated;
  delete job.preRunDirtyPaths;
  // Deliberately NOT deleting job.landedCommit: it must outlive a reset so a
  // re-fired run of this same slug can pass it to verifyRun as
  // priorLandedCommit (pass_no_commit_prior_run_verified exemption).
  return true;
}

// Grace period between a boot orphan's SIGTERM and reading its log to
// classify the outcome — matches killOrphanClaudePid's own internal 5s
// SIGKILL follow-up delay, plus a small margin so classification always runs
// after that SIGKILL has had a chance to land.
const BOOT_ORPHAN_KILL_GRACE_MS = 6000;

/**
 * partitionBootOrphans(jobs, isAlive?) → { immediate: string[], deferred: string[] }
 *
 * Pure decision split for boot reconciliation. A 'running' job whose recorded
 * pid is still alive must NOT be classified from its log yet — the orphaned
 * process may still be writing to it, so reading now risks misclassifying a
 * job that is about to emit result:success as no_result and double-running it.
 * Ported from reconcileQueueOffline's cross-tick escalation (see
 * scripts/lib/watchdogHelpers.cjs) — here it's a single deferred window since
 * this process stays up to revisit it, rather than a separate short-lived
 * watchdog process needing another tick.
 */
function partitionBootOrphans(jobs, isAlive = claudePidAlive) {
  const immediate = [];
  const deferred = [];
  for (const j of jobs) {
    if (j.status !== 'running') continue;
    const pid = j.runtime?.pid;
    if (pid && isAlive(pid)) {
      deferred.push(j.slug);
    } else {
      immediate.push(j.slug);
    }
  }
  return { immediate, deferred };
}

/**
 * applyOrphanOutcome(job, outcome, killNote?) → void
 *
 * Mutates `job` in place to finalize a boot-orphaned 'running' job given its
 * classified run outcome: success/failed finalize terminally; no_result/unknown
 * re-queues to pending bounded by ORPHAN_REQUEUE_CAP. The status-mutation
 * semantics (and the cap-exhaustion boundary) match the now-deleted
 * reconcileQueueOffline (scripts/lib/watchdogHelpers.cjs) verbatim; killNote
 * plumbing differs slightly (see call sites) since this path always knows
 * pid liveness up front rather than re-checking per tick.
 */
function applyOrphanOutcome(job, outcome, killNote = '') {
  const now = new Date().toISOString();
  if (outcome === 'success') {
    transitionJob(job, 'completed', { reason: 'boot orphan reconciliation: run succeeded', source: 'applyOrphanOutcome' });
    job.exitCode = 0;
    job.error = null;
    job.finishedAt = now;
    delete job.runtime;
  } else if (outcome === 'failed') {
    transitionJob(job, 'failed', { reason: `orphaned: app restarted while running${killNote}`, source: 'applyOrphanOutcome' });
    job.exitCode = job.exitCode ?? 1;
    job.error = `orphaned: app restarted while running${killNote}`;
    job.finishedAt = now;
    delete job.runtime;
  } else {
    const tries = job.orphanRetries ?? 0;
    if (tries < ORPHAN_REQUEUE_CAP) {
      resetJobFields(job, `orphaned: app restarted mid-run, re-queued (attempt ${tries + 1}/${ORPHAN_REQUEUE_CAP})${killNote}`, { source: 'applyOrphanOutcome' });
      job.orphanRetries = tries + 1;
    } else {
      transitionJob(job, 'failed', { reason: `orphaned: app restarted while running, exhausted ${ORPHAN_REQUEUE_CAP} re-queue attempts${killNote}`, source: 'applyOrphanOutcome' });
      job.exitCode = job.exitCode ?? 1;
      job.error = `orphaned: app restarted while running, exhausted ${ORPHAN_REQUEUE_CAP} re-queue attempts${killNote}`;
      job.finishedAt = now;
      delete job.runtime;
    }
  }
}

/**
 * isNotifiableTerminalStatus(effectiveStatus) → boolean
 *
 * Gates notifyOriginatingTab to true terminal transitions only: 'completed'
 * and 'failed'. Excludes 'needs_review' (not yet truly done — may still
 * auto-fix) and, implicitly, the rateLimited/paused-queue path, which never
 * reaches effectiveStatus computation at all (it takes the treatAsPending
 * branch in spawnJob and resets the job to pending instead).
 */
function isNotifiableTerminalStatus(effectiveStatus) {
  return effectiveStatus === 'completed' || effectiveStatus === 'failed';
}

/**
 * Scans a run log's tail for the last `{"type":"result",...}` JSONL event
 * (the claude harness's final message) and returns its `result` string, or
 * null if the log is missing, unreadable, or has no parseable result line.
 * Never throws — a missing/torn log must not break notifyOriginatingTab.
 */
function extractResultTextFromLog(logPath) {
  if (!logPath) return null;
  try {
    const tail = readTail(logPath, RESULT_TEXT_TAIL_BYTES);
    if (!tail) return null;
    const lines = tail.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line || !line.includes('"type":"result"')) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed.result === 'string') return parsed.result;
      } catch {
        // torn/partial line — keep scanning backward
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * resolveNotifyPrd(job, parsePrdRaw) → Promise<parsed PRD | null>
 *
 * Locate and parse a finishing job's PRD for the notification path, trying
 * the live Epic-scoped dir first (findPrdDir scans candidatePrdsDirs) and
 * then the archived twin (archivedPrdPathForJob scans listArchivedPrdDirs).
 *
 * Both lookups are required, and `prdPathForJob` is deliberately NOT used
 * here (PRD 985). It resolves to `resolvePrdWriteDir(cwd)` — the RETIRED
 * flat `<cwd>/session-manager-operations/scheduler/prds/` dir, which today
 * holds only zero-byte `.reserved-NNN` number stubs and no PRD at all, so it
 * ENOENT'd for every Epic-scoped PRD. On top of that, archiveCompletedPrd
 * renames the file into `prds-archived/` immediately BEFORE the notify call
 * (see tickQueue's newlyCompletedPrds loop), so even a correct live-dir
 * lookup finds nothing by the time we run. The net effect was that `prd`
 * was always null on the completed path: sourcePromptId never resolved, no
 * transcript turn was written, no response event was appended, and the
 * completed PRD silently never reported back to the Epic that authored it.
 * Verified live: PRDs 961/962/963/964/967 all completed 2026-08-03 and not
 * one response event landed on either authoring Epic's chain.
 *
 * Never throws — an unreadable/absent PRD returns null and each caller
 * falls back to the job's own `epicId`.
 */
async function resolveNotifyPrd(job, parsePrdRaw) {
  if (!job || !job.slug) return null;
  const livePath = await resolveVerifyPrdPath(job);
  if (livePath) {
    const parsed = await parsePrdRaw(livePath).catch(() => null);
    if (parsed) return parsed;
  }
  const archivedPath = archivedPrdPathForJob(job);
  if (!archivedPath) return null;
  return await parsePrdRaw(archivedPath).catch(() => null);
}

/**
 * resolveVerifyPrdPath(job) → Promise<string|null>
 *
 * Path-only sibling of resolveNotifyPrd's live-dir lookup (PRD 985/991):
 * find `<slug>.md` via findPrdDir's full candidate search (legacy flat dir +
 * every project's Epic-scoped dirs) and return its safe, containment-checked
 * path. Used by verifyRun call sites, which need a path string to read the
 * PRD body from — not a parsed object — so it stops short of the
 * parse-then-fall-back-to-archived step resolveNotifyPrd layers on top.
 * Deliberately does NOT fall back to `prdPathForJob` (the retired flat dir,
 * see that function's own doc comment) — a null here means the caller
 * should treat the PRD as unresolved, not read a path that is known to
 * never contain the file.
 */
async function resolveVerifyPrdPath(job) {
  if (!job || !job.slug) return null;
  const liveDir = await findPrdDir(job.slug).catch(() => null);
  return liveDir ? safeSlugPathIn(liveDir, job.slug) : null;
}

/**
 * resolveFixPlanPath(failedJob) → { fixPath, fixSlug, group, livePrdDir }
 *
 * Where spawnInvestigation's auto-fix plan for `failedJob` must be written.
 * The plan belongs in the SAME dir the original PRD lives in right now
 * (`livePrdDir`, from resolveVerifyPrdPath's live-dir search — usually the
 * originating Epic's `epics/<epicId>/prds/`), never the retired flat dir:
 * consolidateFlatPrds (prdMigration.cjs) sweeps only the flat dir and
 * archives any `.md` there with no live queue row, which a freshly-authored
 * fix plan never has yet — so writing it flat means the very next
 * reconcile() pass (src/main/scheduler.cjs's consolidateAllFlatPrds call)
 * archives it before it can ever be enqueued. `livePrdDir` is null (and the
 * flat dir, `prdDirForCwd`, is used instead) only when the original PRD
 * can't be found live anywhere on disk — an archived twin is deliberately
 * NOT treated as a live location for this purpose.
 *
 * Exported as a pure(ish) helper (one fs-free branch, one await) so tests
 * can prove the round trip — fix plan lands beside its original and
 * survives a consolidateFlatPrds(cwd) pass — without spawning a real
 * investigation.
 */
async function resolveFixPlanPath(failedJob) {
  const livePrdPath = await resolveVerifyPrdPath(failedJob);
  const livePrdDir = livePrdPath ? path.dirname(livePrdPath) : null;
  const baseSlug = failedJob.slug.replace(/^\d+-/, '');
  const group = failedJob.parallelGroup ?? 99;
  const fixSlug = `${String(group).padStart(2, '0')}-fix-${baseSlug}`;
  const fixPath = path.join(livePrdDir ?? prdDirForCwd(failedJob.cwd), `${fixSlug}.md`);
  return { fixPath, fixSlug, group, livePrdDir };
}

/**
 * notifyOriginatingTab(job) → void
 *
 * On a true terminal transition (completed/failed — never the benign
 * rateLimited auto-pause, which resets the job to pending instead), publish
 * a short status notification for the PRD that queued this job.
 *
 * Resolution order (PRD 814, extended by PRD 854): (1) if the PRD's
 * `sourcePromptId` resolves to a known, still-active PromptSession (minted
 * for a dev-work dispatch, PRD 813) under the job's cwd, append a 'response'
 * PromptSessionEvent to THAT session's own event chain — its own scoped Epic
 * conversation (EpicDetail.tsx), not whatever tab happens to be active — and
 * stop; (2) otherwise, fall back to pushing a short status prompt via
 * enqueueExternalPrompt (PRD 753) at a target id resolved from, in order,
 * the PRD's own `sourceTabId` frontmatter, then `sourcePromptId` again (a PRD
 * dispatched straight from an Epic's composer, dispatchPromptSessionToPrd,
 * never sets sourceTabId — sourcePromptId IS the Epic id and is a valid
 * chat:external-send target too, which the renderer now resolves against
 * both open tabs and known Epics, refusing a completed one), then the first
 * open tab (per sessionsStore's persisted tabs.json) whose cwd matches the
 * job's cwd — first match only, no fan-out to multiple matching tabs; (3)
 * no-op. The cwd-match step only runs when NEITHER sourceTabId nor
 * sourcePromptId is present in frontmatter at all — `sendPrompt` (
 * enqueueExternalPrompt) is fire-and-forget IPC with no ack, so once step
 * (2) picks either id it is not retried even if the renderer can't resolve
 * it either (e.g. a stale/garbage id) — same non-guaranteed-delivery
 * tradeoff this function already accepted for sourceTabId pre-PRD-854.
 * Never throws to the caller (fire-and-forget from spawnJob). Deps are
 * injectable (mirrors partitionBootOrphans's isAlive param) so unit tests
 * can exercise the resolution logic without touching disk/electron.
 */
async function notifyOriginatingTab(job, {
  parsePrdRaw = prdParser.parsePrdRaw,
  loadSessions = sessionsStore.load,
  sendPrompt = enqueueExternalPrompt,
  appendResponseEvent = appendResponseEventIfKnown,
  appendTranscriptTurn = promptSessionTranscript.appendTurn,
  readResultFromLog = extractResultTextFromLog,
  enqueueValidation = maybeEnqueueValidationPrompt,
} = {}) {
  try {
    const prd = await resolveNotifyPrd(job, parsePrdRaw);
    const message = `PRD ${job.slug} finished: ${job.status}. Check Scheduler for details.`;

    // The EPIC this check-in belongs to. Deliberately does NOT consider
    // `sourceTabId` — that is a Terminal tab id, not an Epic id, and
    // appending an Epic event chain onto one would be a category error (a
    // pre-813 PRD carrying only sourceTabId must still take the
    // chat:external-send path below; covered by the 'no sourcePromptId at
    // all (pre-813 PRD)' test).
    //
    // `job.epicId` is the last resort and is what makes the notification
    // survive an entirely unreadable PRD: the queue row carries the Epic FK
    // independently of the .md on disk (20 of 21 history rows had it when
    // PRD 985 was written), so a parse failure degrades to "notified without
    // frontmatter detail" instead of "silently dropped". Mirrors
    // notifyNeedsReview, which has had this fallback since PRD 854 — which
    // is precisely why needs_review routing kept working while
    // completed/failed routing did not.
    const epicId = prd?.sourcePromptId || job.epicId || null;

    // Persist the job's real result text (not just the short status chip
    // above) to the durable per-Epic transcript, keyed off whichever id
    // notifyOriginatingTab would otherwise notify. Unlike the event append
    // above, this one DOES accept sourceTabId — the durable transcript is
    // keyed by whatever id the run is associated with, not strictly by Epic
    // (pre-existing behaviour, unchanged by PRD 985 apart from the epicId
    // fallback). Best-effort: a missing cwd/epic id, an unreadable run log,
    // or an IPC error here must never block the notification below.
    const epicIdForTranscript = prd?.sourcePromptId || prd?.sourceTabId || job.epicId || null;
    if (epicIdForTranscript && job.cwd) {
      try {
        const logPath = job.runId ? path.join(RUNS_DIR, job.runId, `${job.slug}.log`) : null;
        const resultText = readResultFromLog(logPath);
        await appendTranscriptTurn(job.cwd, epicIdForTranscript, {
          role: 'assistant',
          text: resultText || message,
        });
      } catch (e) {
        console.error('[scheduler] notifyOriginatingTab transcript append error', job?.slug, e);
      }
    }

    if (epicId) {
      // PRD 986: the check-in event is born validation:'unvalidated' — never
      // 'verified' — regardless of the job's self-reported outcome. The
      // check-in is a request to validate, not an assertion of done.
      const routed = await appendResponseEvent(job.cwd || null, epicId, message, {
        prdSlug: job.slug,
        outcome: job.status,
        validation: 'unvalidated',
      }).catch((e) => {
        console.error('[scheduler] notifyOriginatingTab appendResponseEvent error', job?.slug, e);
        return false;
      });
      if (routed) {
        // PRD 986: a successful check-in append triggers ONE validation
        // prompt into the authoring Epic's own session, asking it to verify
        // every acceptance criterion against the real working tree and reply
        // VERIFIED or REFUTED. Fire-and-forget, same convention as this
        // function's own call site in tickQueue: a failure to enqueue is
        // logged inside the hook, never thrown, and never blocks the job's
        // status transition or the response-event append (which already
        // happened above). All gating (kill-switch SM_EPIC_VALIDATION_DISABLE,
        // active-Epic check, once-per-(epicId, prdSlug), loop guard, slot-pool
        // routing) lives in lib/epicValidationHook.cjs.
        try {
          enqueueValidation(
            {
              cwd: job.cwd || null,
              epicId,
              prdSlug: job.slug,
              prdPath: prd?.path || archivedPrdPathForJob(job) || null,
              outcome: job.status,
              eventValidation: 'unvalidated',
            },
            { sendPrompt },
          );
        } catch (e) {
          console.error('[scheduler] notifyOriginatingTab enqueueValidation error', job?.slug, e);
        }
        return;
      }
    }

    // appendResponseEvent already refused above (unknown id, completed
    // Epic, or disk error) — the sourcePromptId fallback below re-sends to
    // the SAME id via chat:external-send, which the renderer independently
    // re-checks against its own live PromptSession store. Deliberate
    // defense-in-depth (main's disk-backed check vs. the renderer's
    // in-memory one can disagree/race), not a redundant duplicate to prune.
    let targetTabId = prd?.sourceTabId || prd?.sourcePromptId || job.epicId || null;
    if (!targetTabId) {
      const jobCwd = job.cwd || null;
      if (jobCwd) {
        const { tabs } = await loadSessions();
        const match = (tabs || []).find((t) => t && t.cwd === jobCwd);
        targetTabId = match?.id || null;
      }
    }
    if (!targetTabId) {
      console.log(`[scheduler] notifyOriginatingTab: no open tab and no Epic for ${job.slug}, skipping`);
      return;
    }

    sendPrompt(targetTabId, message);
  } catch (e) {
    console.error('[scheduler] notifyOriginatingTab error', job?.slug, e);
  }
}

/**
 * notifyNeedsReview(job, report) → Promise<boolean>
 *
 * A job parked in `needs_review` is a question, not a result: something about
 * the PRD was unclear, unverifiable, or ran past its acceptance criteria.
 * That question belongs in the conversation that WROTE the PRD, so this
 * appends a 'response' event to the authoring Epic's own chain (the same
 * channel notifyOriginatingTab uses for completed/failed, which deliberately
 * excludes needs_review — isNotifiableTerminalStatus). It resolves the Epic
 * from the PRD's `sourcePromptId`, falling back to the job's own `epicId`.
 *
 * Join-only by construction: appendResponseEventIfKnown refuses an unknown or
 * non-active session and returns false. Nothing here can create an Epic — if
 * no open authoring Epic exists, the root-cause report in the run directory
 * is the whole record and the Scheduler tab is where it surfaces.
 */
async function notifyNeedsReview(job, report, {
  parsePrdRaw = prdParser.parsePrdRaw,
  appendResponseEvent = appendResponseEventIfKnown,
} = {}) {
  try {
    if (!job || !report || !report.filed) return false;
    const prd = await resolveNotifyPrd(job, parsePrdRaw);
    const epicId = prd?.sourcePromptId || job.epicId || null;
    if (!epicId || !job.cwd) {
      console.log(`[scheduler] notifyNeedsReview: no authoring Epic for ${job.slug}, report only`);
      return false;
    }
    const message = `${report.summary}. Root-cause report: ${report.path}`;
    // PRD 986: like every scheduler check-in, born 'unvalidated' — the RCA
    // report is itself a question, not a verified outcome. No validation
    // prompt is enqueued here: that fires only for the terminal
    // completed/failed path (notifyOriginatingTab); needs_review already
    // routes its own question via this very report.
    return await appendResponseEvent(job.cwd, epicId, message, {
      prdSlug: job.slug,
      outcome: 'needs_review',
      validation: 'unvalidated',
    });
  } catch (e) {
    console.error('[scheduler] notifyNeedsReview error', job?.slug, e);
    return false;
  }
}

/** Scan the tail of a job's log for a network-outage signal: the structured
 *  `terminal_reason":"api_error"` field alongside a network-class error
 *  string. This is NOT a real code defect — spawning an auto-fix
 *  investigation for it just burns a second run diagnosing an outage (PRD
 *  543's ENOTFOUND incident, 2026-07-14). Deliberately narrow: only fires on
 *  the structured terminal_reason field, never on ad-hoc "error" text that
 *  legitimately appears in TDD red-phase transcripts. */
function detectNetworkErrorInLog(logPath) {
  try {
    const text = readTail(logPath, 16384);
    if (!text) return false;
    if (!/"terminal_reason":"api_error"/.test(text)) return false;
    return /ENOTFOUND/.test(text)
      || /ECONNREFUSED/.test(text)
      || /ETIMEDOUT/.test(text)
      || /EAI_AGAIN/.test(text)
      || /network is unreachable/i.test(text);
  } catch {
    return false;
  }
}

// Bounded retry cap for transient (signal-kill or network-outage) failures.
// A small constant, not a config knob: the point is that it is impossible to
// loop unboundedly (queueOps.cjs lints for unbounded loops; see the fizzpop
// poll-hang in PRD_AUTHORING.md for why an unbounded retry is a real hazard).
const TRANSIENT_RETRY_CAP = 2;

/**
 * Classify a failed job's outcome as one of: retry it (transient, bounded),
 * fail it without auto-fix (transient but unsafe to retry, or the retry cap
 * is exhausted), or investigate it (a genuine code failure). Pure/no I/O so
 * the transient-vs-terminal boundary can be unit-tested directly rather than
 * only through a live spawnJob run.
 *
 * A 143/137 exit within the idle-watchdog window is a signal-kill transient
 * (external kill, not a real failure — see the call site's long-form
 * rationale). A `terminal_reason:"api_error"` + network-class error
 * (ENOTFOUND etc., detected by detectNetworkErrorInLog) is an outage
 * transient (PRD 543/545 incident) — same bounded-retry treatment, not a
 * second parallel classifier.
 */
function classifyFailureOutcome({ exitCode, networkError, durationMs, transientRetries, newlyDirtyCount }) {
  const signalTransient = (exitCode === 143 || exitCode === 137) && durationMs < IDLE_OUTPUT_KILL_MS;
  const networkTransient = networkError === true;
  const transient = signalTransient || networkTransient;
  if (!transient) return { action: 'investigate' };

  const transientKind = networkTransient ? 'network' : `exit=${exitCode}`;
  const retries = transientRetries ?? 0;
  // A transient failure can still leave partial work on disk (the 543
  // ENOTFOUND run wrote its renderer, then died before committing). Requeuing
  // over that dirt would either re-implement on top of it or conflict with
  // it — refuse and fail instead of silently re-running over orphaned edits.
  if (newlyDirtyCount > 0) {
    return { action: 'fail-dirty', transientKind, newlyDirtyCount };
  }
  if (retries >= TRANSIENT_RETRY_CAP) {
    return { action: 'fail-cap', transientKind, retries };
  }
  return { action: 'retry', transientKind, retries };
}

/**
 * Commit-guard verdict decision. Pure/no I/O so the false-positive defenses
 * can be unit-tested directly rather than only through a live spawnJob run.
 * Returns the flagged verifyResult replacement, or null if the guard should
 * not fire (any of the defenses below applies).
 *
 * Runs for BOTH shapes of "no commit landed": (a) newlyDirty.length > 0 — the
 * finish protocol's COMMIT step didn't run and left evidence behind — and
 * (b) newlyDirty.length === 0 on a clean tree — the strongest possible silent
 * no-op signal (exitCode 0, no commit, nothing even left dirty; PRD 972's
 * shape). Before PRD 972-followup, case (b) bypassed the guard entirely
 * because the call site only invoked commitGuardVerdict when the working
 * tree was dirty — closed by widening that call site's condition, not by
 * changing this function's four defenses below, which still apply to both
 * shapes identically:
 *   - siblingRunning: on a SHARED tree only — a concurrent job in the same
 *     cwd makes working-tree evidence unreliable in both directions (extra
 *     dirt OR a clean tree that isn't this job's doing). Suppressed by
 *     ranInWorktree: when this job ran in its own git worktree, the
 *     newly-dirty set and the integrated HEAD are attributable to this job
 *     alone regardless of what siblings were doing concurrently in their own
 *     worktrees, so the excuse does not apply (PRD 109 shipped 'completed'
 *     with nothing committed specifically because this carve-out fired
 *     unconditionally during a high-concurrency run).
 *   - jobSelfCommitted: HEAD moved during the run, so the job's deliverable
 *     landed even if dirt (from a concurrent actor) remains.
 *   - legitimateNoOp (COMPLETED_EQUIVALENT_VERDICTS): runVerify.cjs's own
 *     pass_no_commit exemptions (pass_no_commit_already_shipped, etc.)
 *     already independently proved a truthful PASS-with-no-commit is
 *     correct; without this check the commit-guard double-punishes that
 *     same honest no-op (incidents: 655-needs-review-rca-feedback-hook,
 *     672-fix-feedback-session-manager, 2026-07-31).
 *   - isFixPlanJob (zero-edit case only): a fix-plan investigation
 *     (slug ^\d+-fix-) legitimately concluding "the original work already
 *     landed, nothing to change" makes no commit on an already-clean tree —
 *     runVerify.cjs:896 exempts this same shape from ever raising
 *     pass_no_commit in the first place (so its verdict stays 'clean', not a
 *     COMPLETED_EQUIVALENT member — legitimateNoOp alone can't catch it),
 *     which is why this is a distinct exemption. Only applies when
 *     newlyDirty is empty: a fix-plan job that left real dirt behind is
 *     still a genuine finish-protocol violation (incident:
 *     523-fix-bounded-fix-plan-retry, 2026-07-12).
 */
function commitGuardVerdict({ newlyDirty, siblingRunning, ranInWorktree, jobSelfCommitted, legitimateNoOp, isFixPlanJob, verifyResult, salvagePatch }) {
  if ((siblingRunning && !ranInWorktree) || jobSelfCommitted || legitimateNoOp) return null;
  const dirty = newlyDirty || [];
  if (dirty.length === 0 && isFixPlanJob) return null;

  const carried = [...(verifyResult?.annotations ?? [])];
  if (verifyResult && verifyResult.verdict !== 'clean') {
    carried.push({ verdict: verifyResult.verdict, reason: verifyResult.reason });
  }

  if (dirty.length === 0) {
    return {
      verdict: 'silent_no_op',
      reason: 'finish protocol incomplete: run exited 0, made no commit, and left the working tree exactly as it started — no evidence any work was done',
      downgradeTo: 'needs_review',
      annotations: carried.length ? carried : undefined,
    };
  }

  const sample = dirty.slice(0, 3).join(', ');
  const salvageNote = salvagePatch ? ` — recoverable from salvage patch ${salvagePatch}` : '';
  return {
    verdict: 'uncommitted_changes',
    reason: `finish protocol incomplete: ${dirty.length} uncommitted file(s) left in working tree (e.g. ${sample})${salvageNote}`,
    downgradeTo: 'needs_review',
    annotations: carried.length ? carried : undefined,
    // The exact dirty-path list, persisted on the job row (see the
    // commit-guard call site) so a later resume-recovery attempt
    // (selectResumeRecoveryTarget) can name these paths without re-running
    // `git status` against a tree that may have moved on since.
    dirtyPaths: dirty,
  };
}

// Every path list this job leaves attributed on the row is capped here so a
// pathological run (thousands of newly-dirty files) never bloats queue.json
// or history.jsonl — the count is still recorded in full via leftoverCount,
// only the displayed sample is capped.
const LEFTOVER_PATHS_CAP = 50;

/**
 * Pure: turn a newly-dirty path list (or null, meaning "couldn't tell" —
 * never "left nothing") into the `leftoverPaths`/`leftoverCount`/
 * `leftoverPathsTruncated` triple stamped on a terminal job row, or null when
 * there is nothing to attribute (empty list, or the list itself is
 * unavailable). One shape for both the worktree-leftover path and the
 * in-place baseline-delta path — see this function's callers in spawnJob and
 * reapDeadRunningJobs, both of which diff against a persisted pre-run
 * baseline so a human's or a sibling's pre-existing WIP is never
 * misattributed to this job.
 */
function leftoverFieldsFrom(paths) {
  if (!Array.isArray(paths) || paths.length === 0) return null;
  const fields = {
    leftoverPaths: paths.slice(0, LEFTOVER_PATHS_CAP),
    leftoverCount: paths.length,
  };
  if (paths.length > LEFTOVER_PATHS_CAP) fields.leftoverPathsTruncated = true;
  return fields;
}

/** Stamps (or clears) the leftover-attribution fields on a job row in place. */
function applyLeftoverFields(row, paths) {
  delete row.leftoverPaths;
  delete row.leftoverCount;
  delete row.leftoverPathsTruncated;
  const fields = leftoverFieldsFrom(paths);
  if (fields) Object.assign(row, fields);
}

// Same bloat concern as LEFTOVER_PATHS_CAP, applied to the PRE-run dirty
// snapshot (foreign WIP the job did not create) instead of the post-run
// leftover delta.
const PRE_RUN_DIRTY_PATHS_CAP = 200;

/**
 * Pure: cap a dirty-path list at PRE_RUN_DIRTY_PATHS_CAP, appending a
 * `+N more` marker entry when truncated, so queue.json/history.jsonl never
 * take on an unbounded row for a pathologically dirty shared tree. Returns
 * [] for null/empty input (never null) — callers gate storage/prompt
 * injection on `.length` the same way carriedPaths already does.
 */
function capDirtyPaths(paths, cap = PRE_RUN_DIRTY_PATHS_CAP) {
  if (!Array.isArray(paths) || paths.length === 0) return [];
  if (paths.length <= cap) return paths.slice();
  return [...paths.slice(0, cap), `+${paths.length - cap} more`];
}

// Stable, machine-greppable delimiter — a downstream PRD (verifier scoring
// foreign-WIP test failures separately) greps the executor log for this
// exact marker, so its text must never be reworded casually.
const FOREIGN_WIP_DELIMITER = '--- FOREIGN WORKING-TREE STATE (not your work) ---';
const FOREIGN_WIP_END_DELIMITER = '--- END FOREIGN WORKING-TREE STATE ---';

/**
 * Pure: build the executor-prompt section warning about pre-existing dirty
 * paths this job does not own — either base WIP carried into an isolated
 * worktree (PRD 1094's carriedPaths, checked first since it's the more
 * specific/authoritative case) or the raw pre-run dirty snapshot of a shared
 * (non-isolated) tree. Returns '' when both lists are empty so a clean spawn
 * produces a byte-identical prompt to before this section existed.
 */
function buildForeignWipSection({ preRunDirtyPaths, carriedPaths } = {}) {
  const carried = Array.isArray(carriedPaths) ? carriedPaths.filter(Boolean) : [];
  if (carried.length) {
    return [
      FOREIGN_WIP_DELIMITER,
      'This job is running in an isolated git worktree, but the following paths carry uncommitted base-tree work-in-progress that was carried into this checkout so the tree is self-consistent. The authoritative copy of these files lives in the MAIN tree, not this worktree.',
      'These files were already modified before this job started. They are NOT this job\'s work:',
      ...carried.map((p) => `  ${p}`),
      'Do not stage, commit, revert, or stash these paths. A test failure confined to these paths is not this job\'s regression.',
      FOREIGN_WIP_END_DELIMITER,
    ].join('\n');
  }
  const dirty = Array.isArray(preRunDirtyPaths) ? preRunDirtyPaths.filter(Boolean) : [];
  if (dirty.length) {
    return [
      FOREIGN_WIP_DELIMITER,
      'This job is running in a SHARED working tree (not isolated in its own worktree). The following paths were already modified when this job started:',
      ...dirty.map((p) => `  ${p}`),
      'These files are NOT this job\'s work. Do not stage, commit, revert, or stash them. A test failure confined to these paths is not this job\'s regression.',
      FOREIGN_WIP_END_DELIMITER,
    ].join('\n');
  }
  return '';
}

/**
 * Resume-first recovery (PRD 1111). A job parked in needs_review with verdict
 * 'uncommitted_changes' has a live claude session (job.sessionId, minted by
 * spawnJob's `--session-id`) that already has full context of the work it
 * left uncommitted — resuming it via `claude -p --resume <sessionId>` lets it
 * finish its own finish-protocol COMMIT step, instead of spawnInvestigation
 * cold-reading the log to author a fix-plan PRD that a FRESH session then has
 * to re-derive that same context for. Pure/no I/O so the eligibility rule can
 * be unit-tested directly, matching classifyFailureOutcome/commitGuardVerdict.
 *
 * Bounded to exactly one attempt via job.resumeRecoveryAttempted, stamped
 * atomically with the 'running' transition inside spawnJob's own dispatch
 * mutate (see spawnJob) — never here — so a crash between this function
 * returning a target and the resume child actually spawning cannot leave the
 * job re-eligible.
 *
 * Kill-switch: SM_RESUME_RECOVERY_DISABLE=1 restores today's behaviour
 * exactly (always returns null), mirroring SM_RCA_DISABLE/SM_DOD_DISABLE.
 */
function selectResumeRecoveryTarget(job) {
  if (process.env.SM_RESUME_RECOVERY_DISABLE === '1') return null;
  if (!job || job.status !== 'needs_review') return null;
  if (job.verifierVerdict !== 'uncommitted_changes') return null;
  if (typeof job.sessionId !== 'string' || job.sessionId.length === 0) return null;
  if (job.resumeRecoveryAttempted === true) return null;
  const dirtyPaths = Array.isArray(job.uncommittedPaths)
    ? job.uncommittedPaths.filter((p) => typeof p === 'string' && p.length > 0)
    : [];
  if (!dirtyPaths.length) return null;
  return { slug: job.slug, sessionId: job.sessionId, dirtyPaths, salvagePatch: job.salvagePatch || null };
}

/**
 * Short deterministic preamble for a resume-recovery dispatch — NEVER the
 * original PRD body (the resumed session already has that in its own
 * conversation history; re-embedding it would just waste context and risk
 * contradicting whatever state the session actually left behind). Names the
 * exact paths recorded on the parked job row so the resumed run can verify
 * them on disk before trusting them, rather than re-deriving them itself.
 */
function buildResumeRecoveryPreamble({ dirtyPaths, salvagePatch }) {
  const pathList = dirtyPaths.map((p) => `- ${p}`).join('\n');
  const salvageLine = salvagePatch
    ? `\nA salvage patch of this work was also captured at: ${salvagePatch} — apply it if any of the paths above are missing from the working tree.\n`
    : '';
  return `RESUME RECOVERY: your previous run in this same session left uncommitted work on disk and exited before the finish protocol's COMMIT step ran. This is a continuation of that same session, not a new task — do not restart from scratch.

The following path(s) were recorded as uncommitted when this job was parked for review:
${pathList}
${salvageLine}
Do the following now:
1. Run \`git status\` and verify each path above is present on disk and reflects your intended work. If a path is missing, investigate before recreating it — don't blindly redo work that may already be committed or salvaged elsewhere.
2. Run the project's verification gate (typecheck/lint/tests) in the FOREGROUND — wait for it to finish and read its real exit code before proceeding. Do not background it.
3. If the gate is green, stage exactly the paths you created or modified for this work and commit them: \`git add <path> [<path>...] && git commit -m "<type>(<scope>): <summary>"\`.
4. If the gate is red, fix it, then commit.

As the LAST LINE of your final result text, emit exactly one of:
  SCHEDULER_VERDICT: PASS
  SCHEDULER_VERDICT: FAIL <one-line reason>
Print PASS only once the commit above has actually landed.`;
}

/**
 * Pure argv builder for a `claude -p` child spawn, shared so the
 * resume-vs-fresh-session choice is made in exactly one place. `resume`
 * selects `--resume <sessionId>` (reconnect) INSTEAD of `--session-id
 * <sessionId>` (mint) — the two flags are mutually exclusive, never both.
 * `--model` is always explicit (never left to the CLI's drifting default —
 * see conventions.md). `systemPrompt`, when given (the PRD's `agentType`
 * persona body, resolved by agentModelResolve.cjs's resolvePrdPersonaForSpawn),
 * is passed as `--append-system-prompt` so the executor IS that persona at
 * launch rather than being asked in prose to adopt one.
 */
function buildClaudeSpawnArgs({ prompt, model, sessionId, resume, systemPrompt }) {
  return [
    '-p', prompt,
    '--model', model,
    ...(systemPrompt ? ['--append-system-prompt', systemPrompt] : []),
    '--dangerously-skip-permissions',
    '--output-format', 'stream-json',
    '--verbose',
    ...(resume ? ['--resume', sessionId] : ['--session-id', sessionId]),
  ];
}

// ---------- execution ----------

// Allocates the runId/dir pair at dispatch time WITHOUT creating the
// directory — a dispatch that aborts inside spawnJob before executeJob's
// openLog() call (slot-acquire miss, worktree-cap deferral, launch-gate
// block, ...) must leave no trace on disk. The directory is materialised
// lazily, the first time something actually needs to write into it (see
// openLog's mkdirSync in executeJob below). Because tickQueue hands ONE
// shared batch dir to every spawnJob in the batch, several jobs may race to
// create it — `recursive: true` makes that race safe.
function pickRunDir() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(RUNS_DIR, ts);
  return { runId: ts, dir };
}

/**
 * Execute a single PRD job. Writes stdout/stderr to a log file and a meta
 * JSON sidecar. Accepts an optional onPid(pid) callback called synchronously
 * after spawn so callers can persist the pid before the job finishes.
 *
 * Uses withChildAndLog for the child lifecycle (fd open/close, watchdog timers).
 * Watchdogs are declared as an array; the result-tailer's exit-code mapping
 * (success+killedBySignal → 0) is scheduler-specific and lives in onExit.
 */
async function executeJob(job, runDir, defaultCwd, onPid, execCwd, resumeTarget = null, foreignWip = null, launchEnv = null) {
  const logPath = path.join(runDir, `${job.slug}.log`);
  const metaPath = path.join(runDir, `${job.slug}.meta.json`);
  // `cwd` stays the MAIN tree throughout — PRD lookup (findPrdDir/prdPathForJob)
  // and every git call below key off this value, never the worktree. Only the
  // spawned child's own process cwd (spawnCwd) may point at a job worktree —
  // see jobWorktree.cjs's header comment for why the two must never merge.
  const cwd = job.cwd || defaultCwd;
  const spawnCwd = execCwd || cwd;
  const startedAt = Date.now();
  // Resume mode (PRD 1111) reconnects to the SAME session that left the
  // uncommitted work — reusing its id via `--resume` instead of minting a
  // fresh one via `--session-id` is the entire point of the recovery.
  const sessionId = resumeTarget ? resumeTarget.sessionId : randomUUID();

  // Materialise the (possibly shared-batch) run dir lazily, right before the
  // first write into it — see pickRunDir's comment for why this is deferred
  // this far. recursive:true makes it safe if a sibling job in the same
  // batch dir already created it.
  fs.mkdirSync(runDir, { recursive: true });

  // Phase 1: open log fd so we can emit pre-spawn diagnostics (early-exit
  // error paths) before the child is created. withChildAndLog takes ownership
  // of fd/safeLog/closeFd from the point it is called.
  const { fd, safeLog, closeFd } = openLog(logPath);

  safeLog(`[scheduler] starting ${job.slug} at ${new Date().toISOString()}\n[scheduler] cwd=${cwd}` +
    (spawnCwd !== cwd ? ` (running isolated in worktree ${spawnCwd})` : '') + '\n\n');

  // Dead-cwd guard: verify the target directory exists and is traversable
  // before handing it to the child process. Checks spawnCwd (where the child
  // ACTUALLY runs) — cwd is only used for PRD/git bookkeeping.
  try { fs.accessSync(spawnCwd, fs.constants.X_OK); }
  catch {
    const errMsg = `cwd does not exist on this machine: ${cwd}`;
    safeLog(`[scheduler] ${errMsg}\n`);
    closeFd();
    // Sync write: this is an early-exit error path inside an async function,
    // so we could await, but using the sync variant keeps the error path
    // ordering identical to the spawn-failed branch below (also sync).
    config.writeJsonSync(metaPath, { slug: job.slug, cwd, sessionId, exitCode: -1, error: errMsg, startedAt, finishedAt: Date.now(), durationMs: 0 });
    return { exitCode: -1, durationMs: 0, error: errMsg, sessionId };
  }

  let prompt;
  let prdPath = null;
  if (resumeTarget) {
    // Resume mode (PRD 1111): a short deterministic preamble naming the
    // recorded dirty paths, NEVER the original PRD body — the resumed
    // session already has that in its own conversation history via
    // --resume, and re-embedding it here would just contradict whatever
    // state the session actually left on disk.
    prompt = buildResumeRecoveryPreamble({ dirtyPaths: resumeTarget.dirtyPaths, salvagePatch: resumeTarget.salvagePatch });
  } else {
  // Read full PRD body fresh from disk (queue stored only the preview).
  // Resolve through findPrdDir's full candidate search (legacy flat dir +
  // every project's Epic-scoped dirs) first, so the common case — a live
  // Epic-scoped PRD — is a first-try hit instead of probing the retired flat
  // dir and only then falling back.
  const resolvedDir = await findPrdDir(job.slug);
  prdPath = resolvedDir ? path.join(resolvedDir, `${job.slug}.md`) : prdPathForJob(job);
  try {
    const parsed = await parsePrd(prdPath);
    // The review → security-review → verify → commit finish sequence is
    // folded in below via composeExecutorPrompt, after the Epic digest is
    // resolved — never concatenated here, so it can't end up ahead of the
    // digest in the composed prompt (PRD 992).
    prompt = parsed.body;
  } catch (e) {
    // The project-scoped dir isn't the only place a PRD source can live — a
    // writer that hasn't migrated to prdLocations.cjs yet (or a not-yet-run
    // boot migration) can leave it in the legacy global dir. Fall back to
    // findPrdDir's full candidate search before failing the job outright.
    const fallbackDir = await findPrdDir(job.slug);
    if (fallbackDir) {
      const fallbackPath = path.join(fallbackDir, `${job.slug}.md`);
      safeLog(`[scheduler] PRD not in project dir; found ${job.slug}.md in ${fallbackDir}\n`);
      try {
        const parsed = await parsePrd(fallbackPath);
        prompt = parsed.body;
        prdPath = fallbackPath;
      } catch (e2) {
        // Found the dir a moment ago but the read still failed. Case A: the
        // source has since been archived — stale-skip as usual. Case B: it
        // was deleted out from under us in the window between findPrdDir and
        // parsePrd (ENOENT) with no archived twin — also a stale row, not a
        // real failure. Anything else (malformed/unreadable PRD) is a real
        // failure and keeps exitCode: -1.
        if (await archivedTwinExists(job)) {
          return prdArchivedSkipResult(job, cwd, sessionId, startedAt, safeLog, closeFd, metaPath, 'prd-archived');
        }
        if (e2 && e2.code === 'ENOENT') {
          return prdArchivedSkipResult(job, cwd, sessionId, startedAt, safeLog, closeFd, metaPath, 'prd-missing');
        }
        safeLog(`[scheduler] failed to read PRD: ${e2?.message}\n`);
        closeFd();
        return { exitCode: -1, durationMs: 0, error: e2?.message };
      }
    } else {
      // No candidate dir has the slug at all. Case A: it was archived —
      // stale-skip. Case B: the read error is ENOENT (the common case: a
      // source that existed at enqueue time and is gone by dispatch, e.g. a
      // leaked test fixture) with no archived twin — retire as stale rather
      // than a hard failure. Anything else (a real read/parse error) still
      // fails the job.
      if (await archivedTwinExists(job)) {
        return prdArchivedSkipResult(job, cwd, sessionId, startedAt, safeLog, closeFd, metaPath, 'prd-archived');
      }
      if (e && e.code === 'ENOENT') {
        return prdArchivedSkipResult(job, cwd, sessionId, startedAt, safeLog, closeFd, metaPath, 'prd-missing');
      }
      safeLog(`[scheduler] failed to read PRD: ${e?.message}\n`);
      closeFd();
      return { exitCode: -1, durationMs: 0, error: e?.message };
    }
  }
  } // end resumeTarget ? preamble : normal-PRD-read

  let contextDigestApplied = false;
  let originSessionId = null;
  if (!resumeTarget) {
  // Prepend the Epic's own session digest (PRD 950/958) when this job traces
  // back to a known Epic — additive only, never mutates the PRD body itself.
  // A missing/unresolved epicId or a digest build failure is a silent no-op:
  // the PRD's own body must remain sufficient to complete the job on its own.
  const digestEpicId = job.epicId ?? job.sourcePromptId ?? null;
  originSessionId = resolveOriginSessionId(cwd, digestEpicId);
  let digestText = '';
  if (originSessionId) {
    try {
      digestText = await buildContextDigest({ cwd, epicId: digestEpicId });
      if (digestText) contextDigestApplied = true;
    } catch (e) {
      safeLog(`[scheduler] context digest build failed (job still dispatches without it): ${e?.message ?? e}\n`);
      digestText = '';
    }
  }
  // Quiet-machine degraded dispatch (PRD 1107): this job opted into
  // `quietMachine: true` but waited past quietMachineWaitMs() without the
  // machine ever going quiet, so pickNextBatch dispatched it anyway rather
  // than wedge the queue forever. Told to the executor as a plain prompt
  // line — its own wall-clock/timing acceptance criteria were measured (or
  // will be measured) under CPU contention from sibling jobs, not on a
  // quiet machine, so it should not report a timing result as trustworthy
  // without saying so.
  if (job.quietLeaseDegraded === true) {
    prompt = `NOTE: this job requested \`quietMachine: true\` but the machine never went idle within the `
      + `configured wait window, so it was dispatched anyway (degraded). Any timing/frame-rate/performance `
      + `measurement in this run may be affected by CPU contention from other concurrent jobs — say so explicitly `
      + `in your result rather than reporting it as a clean measurement.\n\n${prompt}`;
  }
  // Always route through composeExecutorPrompt (even with an empty digest)
  // so the finish protocol is appended in the prompt's tail exactly once,
  // after any digest fence rather than concatenated ahead of it.
  prompt = composeExecutorPrompt({ prdBody: prompt, digestText, finishProtocol: FINISH_PROTOCOL });

  // Foreign-WIP manifest (starry-night-ships PRD 148 postmortem): the
  // scheduler already knows, at spawn time, which dirty paths this job did
  // not create — either a shared tree's pre-existing dirty set or worktree
  // WIP carried in from the base tree (PRD 1094). Telling the executor
  // explicitly here means it never has to bisect by content to prove a test
  // failure isn't its own regression. '' (clean spawn) leaves prompt
  // byte-identical to before this section existed.
  const foreignWipSection = buildForeignWipSection(foreignWip || {});
  if (foreignWipSection) {
    prompt = `${prompt}\n\n${foreignWipSection}`;
  }
  } // end !resumeTarget digest/finish-protocol composition

  const promptCheck = validatePromptForSpawn(prompt, resumeTarget ? `<resume recovery preamble for ${job.slug}>` : prdPath);
  if (!promptCheck.ok) {
    safeLog(`[scheduler] ${promptCheck.error}\n`);
    closeFd();
    config.writeJsonSync(metaPath, { slug: job.slug, cwd, sessionId, exitCode: -1, error: promptCheck.error, startedAt, finishedAt: Date.now(), durationMs: 0 });
    return { exitCode: -1, durationMs: 0, error: promptCheck.error, sessionId };
  }

  // PRD agentType → persona + model (PRD 1115): resolved for both fresh and
  // resume dispatches, keyed off job.agentType (persisted on the queue row
  // by reconcile()) rather than re-reading the PRD file — a resumed session
  // must keep launching as the SAME persona it started as. Never throws;
  // a dangling/absent agentType falls back to no persona + FALLBACK_MODEL
  // and is logged once by resolvePrdPersonaForSpawn itself.
  const personaResolution = await agentModelResolve.resolvePrdPersonaForSpawn({ cwd, agentType: job.agentType });
  safeLog(`[scheduler] agentType=${job.agentType || '(none)'} persona=${personaResolution.personaPath || '(fallback — no persona applied)'} model=${personaResolution.model}\n`);

  return await new Promise((resolve) => {
    const claudeBin = resolveClaudeBin();
    // Strip Claude Code env and secrets that leak in when session-manager is
    // launched from a `claude` shell. CLAUDE_EFFORT=xhigh forces Opus and
    // overrides `--model sonnet`, so scheduled jobs burn Opus credits silently.
    // PATH must include Homebrew/user bins or the job's node/git children ENOENT
    // when Electron was launched from Finder/Dock on macOS (stripped PATH).
    // SM_PROJECT_ROOT is the main-tree cwd (never spawnCwd, which may be a
    // job/epic worktree) — forwarded by scheduler-mcp-server.cjs as
    // originProjectRoot so a job running inside its own worktree can still
    // resolve the real project for create-prd/open-session/readiness. See
    // projectRootResolve.cjs.
    // SM_SCHEDULER_JOB_SLUG marks the child (and the MCP servers it
    // inherits its env to) as a headless scheduled executor, so
    // scheduler-mcp-server.cjs can refuse scheduler_create_prd from inside a
    // run (issue #11 list C1 — the PRD 460 self-queue incident). Only a
    // persona whose whole job is decomposition may still queue.
    // `launchEnv` is the launch circuit breaker's degraded-mode env (e.g.
    // MAX_THINKING_TOKENS=0 while an outdated CLI's thinking parameter is
    // being rejected — lib/launchFailure.cjs); applied last so it wins.
    const childEnv = cleanChildEnv({
      PATH: pathWithUserBins(),
      SM_PROJECT_ROOT: cwd,
      SM_SCHEDULER_JOB_SLUG: job.slug,
      SM_SCHEDULER_JOB_MAY_QUEUE: job.agentType === 'architect' ? '1' : '0',
      BASH_DEFAULT_TIMEOUT_MS: String(BASH_DEFAULT_TIMEOUT_MS),
      BASH_MAX_TIMEOUT_MS: String(BASH_MAX_TIMEOUT_MS),
      ...(launchEnv && typeof launchEnv === 'object' ? launchEnv : {}),
    });
    if (launchEnv && Object.keys(launchEnv).length) {
      safeLog(`[scheduler] launch mitigation env applied: ${Object.entries(launchEnv).map(([k, v]) => `${k}=${v}`).join(' ')}\n`);
    }

    // Track whether the agent has emitted a `result` event in its JSONL stream.
    // null until seen; then one of "success" | "error_max_turns" | … per the
    // claude harness's result subtype taxonomy.
    // Declared here (outer scope) so the onExit handler can reference it for
    // the success+killedBySignal → exitCode:0 mapping.
    let agentResultSubtype = null;

    // ---------- watchdog declarations ----------
    //
    // All three use fire-once-on-condition semantics (auto-clear on first fire).
    // Secondary timers created inside action() are registered via ctx.addTimer()
    // so they are cleared on child exit even if fired after the primary watchdog.

    // Result-tailer: scan the log tail for a {"type":"result"} event. On
    // detection, start a grace timer — the agent declared done, so it should
    // exit promptly. If it doesn't, SIGTERM the process group (the
    // cellar-publish failure mode: unbounded background bashes kept the parent
    // alive 22 min after the agent emitted result=success).
    // Note: killedByWatchdog is set inside the cascade timer, NOT when the
    // result is first detected, so a clean exit during the grace period leaves
    // killedByWatchdog null (not misattributed to this watchdog).
    const resultTailWatchdog = {
      label: 'result-tail',
      intervalMs: RESULT_TAIL_POLL_MS,
      shouldFire(ctx) {
        try {
          const tail = readTail(ctx.logPath, RESULT_TAIL_BYTES);
          if (!tail) return false;
          const m = tail.match(/\{"type":"result","subtype":"([a-z_]+)"/);
          if (!m) return false;
          agentResultSubtype = m[1];
          return true;
        } catch { return false; }
      },
      action(ctx) {
        ctx.safeLog(`\n[scheduler] result event detected (subtype=${agentResultSubtype}); ` +
          `starting ${Math.round(POST_RESULT_GRACE_MS/1000)}s exit-grace timer\n`);
        const postResultTimer = setTimeout(() => {
          ctx.safeLog(`\n[scheduler] post-result grace expired (${Math.round(POST_RESULT_GRACE_MS/1000)}s); ` +
            `child still alive — SIGTERM process group\n`);
          ctx.killedByWatchdog = 'result-tail';
          ctx.killTree('SIGTERM');
          const postResultKillTimer = setTimeout(() => {
            ctx.safeLog(`\n[scheduler] still alive ${Math.round(POST_RESULT_KILL_MS/1000)}s after SIGTERM — SIGKILL\n`);
            ctx.killTree('SIGKILL');
          }, POST_RESULT_KILL_MS);
          if (postResultKillTimer.unref) postResultKillTimer.unref();
          ctx.addTimer(postResultKillTimer);
        }, POST_RESULT_GRACE_MS);
        if (postResultTimer.unref) postResultTimer.unref();
        ctx.addTimer(postResultTimer);
      },
    };

    // Deadman: kill the child unconditionally after MAX_JOB_DURATION_MS.
    // shouldFire: () => true means the interval fires once at intervalMs then
    // auto-clears (fire-once-on-condition with a condition that's always true).
    const deadmanWatchdog = {
      label: 'deadman',
      intervalMs: MAX_JOB_DURATION_MS,
      shouldFire: () => true,
      action(ctx) {
        ctx.safeLog(`\n[scheduler] watchdog SIGKILL after ${MAX_JOB_DURATION_MS}ms\n`);
        ctx.killedByWatchdog = 'deadman';
        ctx.killTree('SIGKILL');
      },
    };

    // Idle-output watchdog: if log mtime stalls for IDLE_OUTPUT_KILL_MS the
    // agent is presumed stuck (network stall, infinite tool loop, compaction
    // wedge). SIGTERM the group, SIGKILL after POST_RESULT_KILL_MS.
    const idleTailWatchdog = {
      label: 'idle-tail',
      intervalMs: IDLE_CHECK_INTERVAL_MS,
      shouldFire(ctx) {
        try {
          const stat = fs.statSync(ctx.logPath);
          return Date.now() - stat.mtimeMs > IDLE_OUTPUT_KILL_MS;
        } catch { return false; }
      },
      action(ctx) {
        let idleMs = 0;
        try { idleMs = Date.now() - fs.statSync(ctx.logPath).mtimeMs; } catch { /* */ }
        ctx.safeLog(`\n[scheduler] idle-output watchdog: log mtime stalled ` +
          `${Math.round(idleMs/1000)}s (> ${Math.round(IDLE_OUTPUT_KILL_MS/1000)}s threshold) — SIGTERM process group\n`);
        ctx.killedByWatchdog = 'idle-tail';
        ctx.killTree('SIGTERM');
        const idleKillTimer = setTimeout(() => {
          ctx.safeLog(`\n[scheduler] idle watchdog: still alive ${Math.round(POST_RESULT_KILL_MS/1000)}s after SIGTERM — SIGKILL\n`);
          ctx.killTree('SIGKILL');
        }, POST_RESULT_KILL_MS);
        if (idleKillTimer.unref) idleKillTimer.unref();
        ctx.addTimer(idleKillTimer);
      },
    };

    // ---------- spawn ----------

    const { child } = withChildAndLog({
      fd,
      logPath,
      safeLog,
      closeFd,
      spawn: {
        command: claudeBin,
        // Resume mode passes `--resume <sessionId>` (reconnect to the SAME
        // session) INSTEAD of `--session-id <sessionId>` (mint a new one) —
        // never both, see buildClaudeSpawnArgs.
        args: buildClaudeSpawnArgs({
          prompt,
          model: personaResolution.model,
          sessionId,
          resume: !!resumeTarget,
          systemPrompt: personaResolution.systemPrompt,
        }),
        options: {
          cwd: spawnCwd,
          env: childEnv,
          // detached:true puts the child in its own process group so we can kill
          // the entire descendant tree (including any stray background bashes the
          // agent spawned) with `process.kill(-pid)`. Without this, child.kill()
          // only kills the immediate `claude` process, leaving orphaned subprocs
          // that keep the parent alive (the 2026-05-10 cellar-publish hang).
          detached: true,
        },
      },
      watchdogs: [resultTailWatchdog, deadmanWatchdog, idleTailWatchdog],
      onExit({ exitCode, signal, killedByWatchdog: _kbw, error, spawnFailed, leakedDescendants, safeLog: sl }) {
        const durationMs = Date.now() - startedAt;
        const leaked = leakedDescendants ?? [];
        if (leaked.length > 0) {
          sl(`\n[scheduler] leaked ${leaked.length} descendant(s) swept from job process group: ` +
            `${leaked.map((p) => `pid=${p.pid} comm=${p.comm} pcpu=${p.pcpu} etimes=${p.etimes}s`).join(', ')}\n`);
        }

        if (error) {
          // Covers both synchronous spawn failure and child 'error' events.
          const errMsg = spawnFailed
            ? `spawn failed: ${error?.message ?? String(error)}`
            : error.message;
          sl(`\n[scheduler] ${errMsg}\n`);
          // Sync write: inside a Promise executor callback; must flush meta
          // before resolve() so the spawnJob mutate() that follows sees it.
          config.writeJsonSync(metaPath, { slug: job.slug, cwd, sessionId, exitCode: -1, error: errMsg, startedAt, finishedAt: Date.now(), durationMs, leakedDescendants: leaked, schedulerBootedAt: SCHEDULER_BOOTED_AT, schedulerCodeSha: SCHEDULER_CODE_SHA, originSessionId, contextDigestApplied });
          resolve({ exitCode: -1, durationMs, error: errMsg, leakedDescendants: leaked, sessionId });
          return;
        }

        // If we killed the child (via any watchdog or externally) AND the agent
        // had already emitted result=success, the work succeeded; only the
        // cleanup hung. Map the kill exit code to 0 so the job is marked
        // completed, not failed.
        // Node's child.on('exit') reports either code (normal) or signal (killed);
        // when killed by signal, code is null. We also check 143 (128+SIGTERM)
        // and 137 (128+SIGKILL) in case the process exited via signal-as-code.
        let effectiveCode = exitCode;
        const killedBySignal = signal === 'SIGTERM' || signal === 'SIGKILL' || exitCode === 143 || exitCode === 137 || exitCode === null;
        const mappedToSuccess = agentResultSubtype === 'success' && killedBySignal;
        if (mappedToSuccess) {
          effectiveCode = 0;
          sl(`\n[scheduler] mapping exit code=${exitCode} signal=${signal} → 0 ` +
            `(result=success was emitted before kill)\n`);
        }
        sl(`\n[scheduler] exit code=${effectiveCode} (raw code=${exitCode} signal=${signal}) ` +
          `duration=${Math.round(durationMs / 1000)}s\n`);
        const rateLimited = effectiveCode !== 0 && detectRateLimitInLog(logPath);
        const networkError = effectiveCode !== 0 && !rateLimited && detectNetworkErrorInLog(logPath);
        // Non-run detection (issue #11 lists A1–A3): the harness's `result`
        // event tells us whether the model ever got a turn. A first-request
        // API rejection (num_turns ≤ 1, output_tokens 0, `API Error:` text)
        // is a broken ENVIRONMENT, not a failed PRD — spawnJob routes it to
        // the launch circuit breaker instead of failed/investigation.
        const resultStats = launchFailure.readResultEvent(logPath);
        const launchFailed = (effectiveCode !== 0 && !rateLimited && !networkError)
          ? launchFailure.classifyLaunchFailure(resultStats)
          : null;
        if (launchFailed) {
          sl(`\n[scheduler] LAUNCH FAILURE (${launchFailed.kind}${launchFailed.httpStatus ? ` HTTP ${launchFailed.httpStatus}` : ''}): ` +
            `${launchFailed.message} — no turn was taken; this is not a PRD failure\n`);
        }
        // Sync write: child 'exit' handler must flush meta before resolve()
        // so the spawnJob mutate() that follows sees the persisted exit code.
        config.writeJsonSync(metaPath, {
          slug: job.slug, cwd, sessionId, exitCode: effectiveCode, rateLimited, networkError,
          launchFailure: launchFailed,
          numTurns: resultStats?.numTurns ?? null, outputTokens: resultStats?.outputTokens ?? null,
          totalCostUsd: resultStats?.totalCostUsd ?? null, terminalReasonFromHarness: resultStats?.terminalReason ?? null,
          launchEnvApplied: launchEnv && Object.keys(launchEnv).length ? Object.keys(launchEnv) : [],
          startedAt, finishedAt: Date.now(), durationMs, leakedDescendants: leaked,
          agentResultSubtype, mappedFromSignal: mappedToSuccess ? signal || `code=${exitCode}` : null,
          schedulerBootedAt: SCHEDULER_BOOTED_AT, schedulerCodeSha: SCHEDULER_CODE_SHA,
          originSessionId, contextDigestApplied,
        });
        resolve({ exitCode: effectiveCode, durationMs, rateLimited, networkError, launchFailure: launchFailed, resultStats, leakedDescendants: leaked, sessionId });
      },
    });

    if (child) {
      safeLog(`[scheduler] spawned pid=${child.pid} sessionId=${sessionId} (process group)\n\n`);
      // Make this job the OOM killer's preferred victim over Electron.
      biasJobOomScore(child.pid);
      // Fire-and-forget pid persistence — best effort.
      if (onPid) onPid(child.pid, sessionId, cwd).catch(() => {});
    }
  });
}

// pickNextBatch and pickForProject are defined in lib/schedulerBatch.cjs and
// required at the top of this file. Group-ordering gates are evaluated per
// project (keyed by cwd) so jobs in different repos run concurrently up to
// the cap; within one project, sequential-group semantics are preserved.

/**
 * Recognize fix-plan slugs (NN-fix-...) so we don't recurse on a fix-plan that
 * itself failed. The pattern matches the slug we generate in spawnInvestigation.
 */
function isFixPlanSlug(slug) {
  return /^\d+-fix-/.test(slug);
}

/**
 * The fix-plan slug spawnInvestigation authors for a given failed job —
 * shared by selectAutoFixTargets (queue-membership check) and
 * reverifyNeedsReview's autofix_plan_unqueued annotation (same check, run
 * one or more passes later) so both use one slug formula.
 */
function fixSlugFor(job) {
  return `${String(job.parallelGroup ?? 99).padStart(2, '0')}-fix-${job.slug.replace(/^\d+-/, '')}`;
}

/**
 * Returns true for statuses that a fix-plan completion should promote
 * (clear) on the original job. Both 'failed' and 'needs_review' are
 * recoverable via a fix-plan; 'completed', 'running', 'pending' are not.
 */
function isPromotableOriginal(status) {
  return status === 'failed' || status === 'needs_review';
}

/**
 * Pure helper: given a completed fix-plan slug (e.g. '451-fix-foo'), find the
 * SPECIFIC promotable original job it heals. Matches on the full
 * numeric-prefixed slug ('451-foo'), not just the base ('foo') — two
 * needs_review jobs can share a base slug with different NN prefixes
 * (e.g. '451-foo' and '453-foo'), and a fix plan must only heal the
 * lineage whose NN it was authored against. Exported for tests.
 */
function healTargetForFix(fixSlug, jobs) {
  const originalSlug = fixSlug.replace(/^(\d+)-fix-/, '$1-');
  return jobs.find((x) => x.slug === originalSlug && isPromotableOriginal(x.status)) || null;
}

/**
 * Build the Opus investigation prompt. Pure/hermetic so its content can be
 * unit-tested (no spawn, no fs). Inputs are the already-resolved values that
 * spawnInvestigation computes.
 */
function buildInvestigationPrompt({ failedJob, cwd, failedLogPath, originalBody, logTail, fixPath, group }) {
  const abandonedBackgroundTaskNote = failedJob.verifierVerdict === 'abandoned_background_task' ? `

# Known failure class: abandoned background task
This job's verifier verdict is \`abandoned_background_task\`: the transcript shows a Bash command
auto-backgrounded past its foreground timeout, and the run ended waiting for a "you will be
notified when it completes" callback a headless run structurally cannot receive. This is NOT
evidence the work failed — it is evidence the run stopped short of its finish protocol. The work is
usually already written and correct; only the commit is missing.

By the time this investigation runs, the failed job's isolated worktree (if it ran in one) has
already been cleaned up — \`${cwd}\` is the BASE repo, not that worktree, so a plain \`git status\`/
\`git diff\` there will usually show nothing even though real work was produced. The scheduler
salvages any uncommitted diff from a killed job's worktree BEFORE deleting it${
    failedJob.salvagePatch ? `, and this job's salvage patch was captured at:\n\n   ${failedJob.salvagePatch}` : ', to a `.uncommitted.patch` file next to the run log — check the run dir for one'
  }.

The fix-plan PRD you write for this MUST instruct its executor to, in order:
1. Check for a salvage patch (named \`<slug>.uncommitted.patch\` in the run directory${failedJob.salvagePatch ? `, e.g. \`${failedJob.salvagePatch}\`` : ''}) and, if found, apply it to the working tree BEFORE inspecting \`git status\`/\`git diff\` in ${cwd} for uncommitted changes matching the original PRD's acceptance criteria.
2. If the work is present (via the applied patch or already in the tree) and satisfies the acceptance criteria, run the project's verify commands and COMMIT it — do not re-implement or re-plan the PRD from scratch.
3. Only fall back to re-implementing whatever acceptance criteria are genuinely missing after applying any salvage patch, not the whole PRD.` : '';
  return `You are investigating a failed scheduled job in the session-manager queue. Your ONLY job is to write a fix-plan PRD file. Do NOT attempt the fix yourself.${abandonedBackgroundTaskNote}

# Failed job
- Slug: ${failedJob.slug}
- Title: ${failedJob.title}
- cwd: ${cwd}
- Exit code: ${failedJob.exitCode}
- Full failure log: ${failedLogPath}

# Original PRD body (this is what the job was trying to do)
\`\`\`
${originalBody}
\`\`\`

# Last ~16KB of the failure log (stream-json format from \`claude -p\`)
\`\`\`
${logTail}
\`\`\`

# Your task
1. Read the full failure log at ${failedLogPath} if the tail above isn't sufficient.
2. Read source files in ${cwd} as needed to understand the context.
3. Identify the root cause of the failure.
3.5. Before writing the fix-plan PRD file, print a block summarizing the root
   cause in 15 lines or fewer, in exactly this form (plain text between the
   tags, no markdown fences):

   <RCA>
   <your root-cause summary here>
   </RCA>

   This is parsed out of your transcript and folded into the RCA feedback item
   already filed for this job, so it must stand alone (the reader won't have
   your reasoning, only this block).
4. Write a NEW fix-plan PRD file at exactly this path:

   ${fixPath}

5. The frontmatter MUST be exactly this format (no extra keys):
   \`\`\`
   ---
   title: Fix: <short summary of the fix>
   cwd: ${cwd}
   parallelGroup: ${group}
   estimateMinutes: <your time estimate>
   ---
   \`\`\`
   \`cwd\` must be the git repo root where the fix will actually land. If the failed job's cwd is
   not that repo (e.g. a scratch dir like \`/tmp\`), set \`cwd:\` to the correct repo root instead —
   the scheduler's commit guard and post-run verifier read git state from this path, and a
   non-repo cwd parks even a fully green, committed run in \`needs_review\`.
6. The PRD body MUST be self-contained — \`claude -p\` runs it on a fresh Sonnet session with NO conversation context. Include:
   - Root-cause analysis (what went wrong and why)
   - Concrete fix steps (specific files / commands / edits)
   - Verification command(s) the next agent should run to confirm the fix
   - Acceptance criteria
   - Before writing the fix-plan PRD body, read
     \`plugins/session-manager-dev/skills/develop/standards.md\` (resolve it relative to the failed
     job's repo root — for session-manager-authored PRDs that is this cwd). Inline its
     \`## Execution discipline (headless runs)\` section VERBATIM into the new fix-plan PRD under an
     \`## Engineering standards\` heading, exactly as the \`/develop\` skill's Phase 1 does for normal
     PRDs. Reuse that convention — do not invent a second, paraphrased set of warnings. The headless
     Sonnet executor that runs your fix-plan sees no skills and no conversation, so inlining these
     rules verbatim is the only way they reach it.
   - Known failure class — "delegated instead of executed": if the failure log tail above shows the
     failed run invoked the \`Skill\` tool with a \`session-manager-dev:develop\` or
     \`session-manager-dev:process-feedback\` argument, and/or called \`ScheduleWakeup\`, and then exited
     0 without producing the diff/tests its PRD demanded, recognize this as a self-delegation failure.
     In that case LEAD the fix-plan PRD by quoting VERBATIM the canonical rule from standards.md's
     Execution discipline section — "You ARE the executor — never re-queue or self-schedule" — rather
     than authoring new prose. Instruct the fix-plan's executor plainly that a queued PRD is the task,
     not evidence of completion, and that the deliverable is the code diff.

DO NOT attempt the fix. ONLY write the file. When the file exists, exit immediately.`;
}

/**
 * Pure predicate: a run whose meta.json shows a clean exit (exitCode 0) and
 * whose verdicts.json verdict is completed-equivalent (clean / the
 * pass_no_commit exemptions) has nothing left to diagnose — spawning an
 * Opus investigation for it just manufactures a depth+1 fix-of-a-fix PRD for
 * already-shipped work. Any missing/malformed input is treated as "don't
 * skip" (fail-open: never let a missing artifact suppress a real
 * investigation). Exported for tests.
 */
function shouldSkipInvestigationForCleanRun({ meta, verdicts }) {
  if (!meta || meta.exitCode !== 0) return false;
  if (!verdicts || !COMPLETED_EQUIVALENT_VERDICTS.has(verdicts.verdict)) return false;
  return true;
}

/**
 * Reads <runDir>/<slug>.meta.json + <slug>.verdicts.json off disk for the
 * shouldSkipInvestigationForCleanRun guard. Fails safe to {} on any read/parse
 * error (never suppresses an investigation on a missing artifact).
 */
function readRunOutcomeSidecars(runDir, slug) {
  const readJson = (p) => {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
  };
  return {
    meta: readJson(path.join(runDir, `${slug}.meta.json`)),
    verdicts: readJson(path.join(runDir, `${slug}.verdicts.json`)),
  };
}

/**
 * Spawn an Opus investigation session for a failed job. The investigator's job
 * is to read the failure log + original PRD, identify the root cause, and write
 * a fix-plan PRD into prds/<NN>-fix-<base>.md. Reconcile picks it up; the next
 * Sonnet slot fires it. Investigations themselves are NOT queue entries — they
 * run out-of-band, so they don't consume the concurrency cap. They DO consume
 * tokens, which the when-available throttle will reflect on the next poll.
 *
 * Skipped if the failed job is itself a fix-plan (avoids infinite recursion),
 * or if the run being investigated actually verified clean (nothing to fix —
 * see shouldSkipInvestigationForCleanRun).
 */
const INVESTIGATION_LAUNCH_KEY = 'investigation';

async function spawnInvestigation(failedJob, runDir) {
  // The probe launches with the same CLI as the job it diagnoses. While
  // that CLI cannot launch at all (launch circuit breaker, issue #11 list
  // B1: probes e4f82da2/d374e6bf died on the same HTTP 400 as the runs
  // they were investigating) there is nothing to diagnose — skip, loudly.
  {
    const state = await readQueue().catch(() => null);
    const block = state?.launchBlocks?.[INVESTIGATION_LAUNCH_KEY];
    const jobBlock = state?.launchBlocks?.[launchFailure.launchBlockKeyFor(failedJob)];
    const gate = launchFailure.evaluateLaunchGate(block || jobBlock, { now: Date.now(), claudeVersion: await probeClaudeVersion() });
    if (gate.state === 'blocked') {
      console.log(`[scheduler] skip investigation: ${failedJob.slug} — ${gate.reason}`);
      await mutate((s) => {
        const j = s.jobs.find((x) => x.slug === failedJob.slug);
        if (j) { j.autoFixOutcome = 'launch-blocked'; j.autoFixNote = gate.reason; }
      }).catch(() => {});
      return { deferred: false };
    }
  }
  // Resume-first recovery (PRD 1111) always gets first refusal — a job
  // eligible for a bounded `--resume` dispatch must never also get a
  // cold-read fix-plan PRD authored in the same pass. selectResumeRecoveryTarget
  // returns null for every job shape spawnInvestigation is normally called
  // with (e.g. plain 'failed' jobs never carry verifierVerdict
  // 'uncommitted_changes'), so this is a no-op for the common case.
  if (selectResumeRecoveryTarget(failedJob)) {
    console.log(`[scheduler] skip investigation: ${failedJob.slug} is resume-recovery eligible`);
    return { deferred: false };
  }
  if (isFixPlanBeyondDepthCap(failedJob.slug, failedJob.investigationDepth)) {
    console.log(`[scheduler] skip investigation: ${failedJob.slug} is a fix plan at/beyond depth cap (depth=${failedJob.investigationDepth ?? 'none'})`);
    return { deferred: false };
  }
  {
    const { meta, verdicts } = readRunOutcomeSidecars(runDir, failedJob.slug);
    if (shouldSkipInvestigationForCleanRun({ meta, verdicts })) {
      console.log(`[scheduler] skip investigation: ${failedJob.slug} last run verified ${verdicts.verdict} (exit 0) — nothing to diagnose`);
      return { deferred: false };
    }
  }
  if (investigationsInFlight >= MAX_CONCURRENT_INVESTIGATIONS) {
    // Queue for retry when a slot frees rather than dropping — otherwise a failed
    // job (never 'needs_review', so reverifyNeedsReview won't retry it) would
    // silently never get an auto-authored fix-plan.
    if (!deferredInvestigations.has(failedJob.slug)) {
      deferredInvestigations.set(failedJob.slug, { failedJob, runDir });
      console.log(`[scheduler] investigation queued for ${failedJob.slug} (slot busy, ${deferredInvestigations.size} waiting)`);
    }
    return { deferred: true };
  }
  // Reserve the slot synchronously (before any await) so concurrent callers can't
  // both pass the cap check. Released in onExit, on any pre-spawn early return, or
  // on a synchronous throw (try/catch below) — and releasing hands the slot to a
  // queued investigation so none are stranded.
  investigationsInFlight++;
  let slotReleased = false;
  const releaseSlot = () => {
    if (slotReleased) return;
    slotReleased = true;
    investigationsInFlight--;
    drainDeferredInvestigation();
  };
  try {

  const failedLogPath = path.join(runDir, `${failedJob.slug}.log`);
  const investigationLogPath = path.join(runDir, `${failedJob.slug}.investigation.log`);

  // livePrdDir is the SAME dir the original PRD lives in right now (usually
  // its Epic-scoped `epics/<epicId>/prds/`) — the fix plan must land there
  // too, since consolidateFlatPrds only ever sweeps the retired flat dir
  // (prdDirForCwd) and would archive a freshly-authored fix plan on the very
  // next reconcile() pass before it ever gets a queue row. Only fall back to
  // the flat dir when the original PRD can't be found on disk at all — an
  // archived twin (archivedPrdPathForJob) is deliberately NOT used for the
  // write dir, only for reading originalBody below.
  let originalBody = '';
  const { fixPath, fixSlug, group, livePrdDir } = await resolveFixPlanPath(failedJob);
  try {
    const originalPath = livePrdDir ? path.join(livePrdDir, `${failedJob.slug}.md`) : archivedPrdPathForJob(failedJob);
    originalBody = (await parsePrd(originalPath)).body;
  } catch {
    originalBody = failedJob.bodyPreview || '(original PRD missing from disk)';
  }

  const logTail = readTail(failedLogPath, 16 * 1024) || '(failed to read log)';

  if (fs.existsSync(fixPath)) {
    console.log(`[scheduler] skip investigation: fix plan already exists at ${fixPath}`);
    releaseSlot();
    return { deferred: false };
  }

  // cwd fallback: if the failed job's cwd is missing on disk, the investigator
  // child would itself fail to spawn (ENOENT). Fall back to DEFAULT_PROJECT_CWD
  // so the investigation can still write a fix plan that updates the cwd or
  // re-creates the missing project directory.
  let cwd = failedJob.cwd || DEFAULT_PROJECT_CWD;
  try { fs.accessSync(cwd, fs.constants.X_OK); }
  catch {
    console.warn(`[scheduler] investigation cwd missing (${cwd}); falling back to ${DEFAULT_PROJECT_CWD}`);
    cwd = DEFAULT_PROJECT_CWD;
  }
  // A non-git cwd is unusable as a fix-plan cwd: the commit guard, worktree
  // isolation, and runVerify's PASS+commit sentinel override all read git
  // state from job.cwd, so a fix plan rooted at e.g. /tmp gets parked in
  // needs_review even when its commit really landed. (Incident:
  // 99-fix-e2e-needs-review-test, 2026-08-07 — green, committed 6ecbd40,
  // PASS sentinel, still needs_review.)
  if (!isGitRepoSync(cwd)) {
    console.warn(`[scheduler] investigation cwd is not a git repo (${cwd}); falling back to ${DEFAULT_PROJECT_CWD}`);
    cwd = DEFAULT_PROJECT_CWD;
  }
  const prompt = buildInvestigationPrompt({ failedJob, cwd, failedLogPath, originalBody, logTail, fixPath, group });

  // Phase 1: open log fd for pre-spawn diagnostics.
  const { fd, safeLog, closeFd } = openLog(investigationLogPath);
  const sessionId = randomUUID();
  safeLog(`[scheduler] investigation starting for ${failedJob.slug} at ${new Date().toISOString()}\n[scheduler] target fix PRD: ${fixPath}\n[scheduler] sessionId=${sessionId}\n\n`);

  const investigationPromptCheck = validatePromptForSpawn(prompt, `<investigation prompt for ${failedJob.slug}>`);
  if (!investigationPromptCheck.ok) {
    safeLog(`\n[scheduler] ${investigationPromptCheck.error}\n`);
    closeFd();
    releaseSlot();
    return { deferred: false };
  }

  // Mark the job 'investigating' so the Queue UI shows an active status for
  // the whole probe duration — previously this left the job's persisted
  // status frozen at 'failed'/'needs_review' the entire time, which read as
  // "nothing is happening" even though an Opus process was actively running.
  await mutate((s) => {
    const j = s.jobs.find((x) => x.slug === failedJob.slug);
    if (j) transitionJob(j, 'investigating', { reason: 'spawning investigation probe', source: 'spawnInvestigation:start' });
  });
  await broadcast({ flush: true });

  const claudeBin = resolveClaudeBin();
  const childEnv = cleanChildEnv({
    PATH: pathWithUserBins(), // Homebrew/user bins for macOS
    BASH_DEFAULT_TIMEOUT_MS: String(BASH_DEFAULT_TIMEOUT_MS),
    BASH_MAX_TIMEOUT_MS: String(BASH_MAX_TIMEOUT_MS),
  });

  // Investigation needs only a deadman watchdog — no idle-tail or result-tail
  // since investigations are short-running Opus probes with a hard ceiling.
  const deadmanWatchdog = {
    label: 'deadman',
    intervalMs: MAX_INVESTIGATION_DURATION_MS,
    shouldFire: () => true,
    action(ctx) {
      ctx.safeLog(`\n[scheduler] investigation watchdog SIGKILL after ${MAX_INVESTIGATION_DURATION_MS}ms\n`);
      ctx.killedByWatchdog = 'deadman';
      ctx.killTree('SIGKILL');
    },
  };

  // Phase 2: spawn with lifecycle managed by withChildAndLog.
  const { child } = withChildAndLog({
    fd,
    logPath: investigationLogPath,
    safeLog,
    closeFd,
    spawn: {
      command: claudeBin,
      args: [
        '-p', prompt,
        '--model', 'opus',
        '--dangerously-skip-permissions',
        '--output-format', 'stream-json',
        '--verbose',
        '--session-id', sessionId,
      ],
      options: { cwd, env: childEnv },
    },
    watchdogs: [deadmanWatchdog],
    onExit({ exitCode, error, spawnFailed, safeLog: sl }) {
      releaseSlot();
      // Restore the pre-investigation status now that the probe has exited —
      // 'investigating' must never be the job's resting state.
      mutate((s) => {
        const j = s.jobs.find((x) => x.slug === failedJob.slug);
        if (j && j.status === 'investigating') {
          transitionJob(j, failedJob.status || 'failed', { reason: 'investigation probe exited — restoring prior status', source: 'spawnInvestigation:onExit' });
          delete j.runtime;
        }
      })
        .then(() => broadcast({ flush: true }))
        .catch(() => {});
      if (error) {
        const errMsg = spawnFailed
          ? `investigation spawn failed: ${error?.message ?? String(error)}`
          : `investigation error: ${error.message}`;
        sl(`\n[scheduler] ${errMsg}\n`);
        // Stamp the outcome even on this early exit — otherwise the job is
        // left with autoFixAttempted: true and no outcome, which used to
        // read as a permanent dead-end (see selectAutoFixTargets).
        mutate((s) => {
          const j = s.jobs.find((x) => x.slug === failedJob.slug);
          if (j) j.autoFixOutcome = 'error';
        }).catch(() => {});
        return;
      }
      sl(`\n[scheduler] investigation exit code=${exitCode}\n`);
      if (exitCode !== 0) {
        const probeResult = launchFailure.readResultEvent(investigationLogPath);
        const probeLaunchFailure = launchFailure.classifyLaunchFailure(probeResult);
        if (probeLaunchFailure) {
          sl(`\n[scheduler] investigation LAUNCH FAILURE (${probeLaunchFailure.kind}): ${probeLaunchFailure.message} — arming '${INVESTIGATION_LAUNCH_KEY}' launch block\n`);
          probeClaudeVersion().then((claudeVersion) => mutate((s) => {
            s.launchBlocks = s.launchBlocks || {};
            s.launchBlocks[INVESTIGATION_LAUNCH_KEY] = launchFailure.armLaunchBlock(s.launchBlocks[INVESTIGATION_LAUNCH_KEY] || null, {
              kind: probeLaunchFailure.kind, httpStatus: probeLaunchFailure.httpStatus, message: probeLaunchFailure.message,
              now: Date.now(), claudeVersion, slug: failedJob.slug, runId: failedJob.runId ?? null,
            });
            const j = s.jobs.find((x) => x.slug === failedJob.slug);
            if (j) { j.autoFixOutcome = 'launch-blocked'; j.autoFixNote = `investigation probe never ran: ${probeLaunchFailure.message}`; }
          })).catch(() => {});
          return;
        }
      }
      // Fold the investigation's <RCA> summary into the root-cause report already
      // written for this job (needs_review jobs only — writeRcaReport no-ops when
      // failedJob has no verifierVerdict, e.g. plain 'failed' jobs never got one).
      const investigationText = extractRcaBlock(readTail(investigationLogPath, 64 * 1024));
      if (investigationText) {
        writeRcaReport({
          job: failedJob,
          runDir,
          verdict: failedJob.verifierVerdict,
          annotations: failedJob.verifierAnnotations,
          investigationText,
        }).catch((e) => {
          console.error('[scheduler] writeRcaReport (investigation enrichment) error', failedJob.slug, e);
        });
      }
      if (fs.existsSync(fixPath)) {
        console.log(`[scheduler] investigation produced fix plan: ${fixSlug}`);
        mutate((s) => {
          const j = s.jobs.find((x) => x.slug === failedJob.slug);
          if (j) j.autoFixOutcome = 'plan';
        }).catch(() => {});
      } else {
        console.log(`[scheduler] investigation finished WITHOUT producing fix plan (slug=${failedJob.slug}, code=${exitCode})`);
        // Record the no-plan outcome so selectAutoFixTargets can offer one
        // bounded retry instead of permanently dead-ending behind the
        // 1-attempt cap (autoFixAttempted stays true).
        mutate((s) => {
          const j = s.jobs.find((x) => x.slug === failedJob.slug);
          if (j) j.autoFixOutcome = 'no-plan';
        }).catch(() => {});
      }
      // Trigger a tick so the new fix plan is reconciled into the queue and fired.
      tickQueue().catch(() => {});
    },
  });

  if (child) {
    safeLog(`[scheduler] investigation pid=${child.pid}\n\n`);
    // Recorded so findStrandedInvestigations (a post-restart maintenance
    // sweep — the live process has no other way to know a probe is still
    // running) can tell a live probe apart from one whose owning process is
    // long gone, the same way reapDeadRunningJobs checks a running job's
    // runtime.pid.
    mutate((s) => {
      const j = s.jobs.find((x) => x.slug === failedJob.slug);
      if (j && j.status === 'investigating') j.runtime = { pid: child.pid };
    }).catch(() => {});
  }
  return { deferred: false };
  } catch (e) {
    // A synchronous throw before onExit is wired (e.g. resolveClaudeBin not found,
    // openLog failure, spawn setup) must not strand the reserved slot, and must
    // not strand the job on the transient 'investigating' status either.
    releaseSlot();
    mutate((s) => {
      const j = s.jobs.find((x) => x.slug === failedJob.slug);
      if (j && j.status === 'investigating') {
        transitionJob(j, failedJob.status || 'failed', { reason: 'investigation spawn threw before exiting — restoring prior status', source: 'spawnInvestigation:catch' });
        delete j.runtime;
      }
    })
      .then(() => broadcast({ flush: true }))
      .catch(() => {});
    throw e;
  }
}

/**
 * computeLaunchHolds(state) → Map<slug, reason>
 *
 * The launch circuit breaker's per-tick view (lib/launchFailure.cjs, issue
 * #11): every pending row whose persona is blocked is held with its reason;
 * when a persona's backoff has elapsed exactly ONE of its pending rows is
 * left pickable (the half-open probe) and the rest are held behind it. A
 * CLI version change drops the block outright — that is the incident's real
 * fix (`claude update`) and the queue must resume on the next tick.
 * Mutates nothing; spawnJob makes the durable decision at dispatch.
 */
async function computeLaunchHolds(state, { now = Date.now(), claudeVersion } = {}) {
  const held = new Map();
  const blocks = state?.launchBlocks;
  if (!blocks || typeof blocks !== 'object' || !Object.keys(blocks).length) return held;
  const version = claudeVersion === undefined ? await probeClaudeVersion() : claudeVersion;
  const probeAllowed = new Set();
  for (const j of state.jobs || []) {
    if (j.status !== 'pending') continue;
    const key = launchFailure.launchBlockKeyFor(j);
    const block = blocks[key];
    if (!block) continue;
    const gate = launchFailure.evaluateLaunchGate(block, { now, claudeVersion: version });
    if (gate.state === 'open') continue;
    if (gate.state === 'probe' && !probeAllowed.has(key)) {
      probeAllowed.add(key);
      continue;
    }
    held.set(j.slug, gate.state === 'probe'
      ? `launch blocked (${block.kind}) — waiting for this tick's probe of '${key}'`
      : gate.reason);
  }
  return held;
}

/**
 * A run that never got a turn (res.launchFailure — see executeJob's onExit)
 * is routed here instead of the failed/investigation path (issue #11 lists
 * A1–A3, B1): the row goes back to `pending` carrying the API's own message
 * as its error, no retry budget is consumed, no auto-fix probe is spawned
 * (it would die the same way), and the persona's launch circuit breaker is
 * armed so the queue stops re-dispatching identical doomed launches while
 * still self-healing on backoff / CLI update / human Retry.
 */
/**
 * Pure state mutation behind handleLaunchFailure (exported for tests): arms
 * the persona's breaker and returns the job's `running` row to `pending`
 * carrying the API message. Returns the armed block.
 */
function applyLaunchFailure(s, { job, lf, runId, launchKey, mitigationApplied, claudeVersion, now = Date.now() }) {
  s.launchBlocks = s.launchBlocks || {};
  s.launchMitigations = s.launchMitigations || {};
  const prev = s.launchBlocks[launchKey] || null;
  const armed = launchFailure.armLaunchBlock(prev, {
    kind: lf.kind, httpStatus: lf.httpStatus, message: lf.message, now, claudeVersion,
    slug: job.slug, runId, mitigationApplied,
  });
  s.launchBlocks[launchKey] = armed;
  // A mitigation that was in force and still failed is no longer proven —
  // drop it so the hint and the next probe are honest.
  if (mitigationApplied && s.launchMitigations[launchKey]) delete s.launchMitigations[launchKey];
  const i = (s.jobs || []).findIndex((x) => x.slug === job.slug);
  if (i >= 0 && s.jobs[i].status === 'running') {
    const prevCount = s.jobs[i].launchFailure?.count ?? 0;
    const msg = `launch failure (${lf.kind}${lf.httpStatus ? ` HTTP ${lf.httpStatus}` : ''}): ${lf.message}`;
    resetJobFields(s.jobs[i], msg, { source: 'spawnJob:launch-failure' });
    s.jobs[i].launchFailure = {
      kind: lf.kind, httpStatus: lf.httpStatus ?? null, message: lf.message,
      at: new Date(now).toISOString(), runId, count: prevCount + 1, mitigationApplied,
    };
    s.jobs[i].terminalReason = `launch_failure:${lf.kind}`;
    s.jobs[i].heldReason = armed.exhausted
      ? `launch blocked (${lf.kind}) after ${armed.attempts} failed probe(s) — ${armed.hint}`
      : `launch blocked (${lf.kind}) — re-probe at ${armed.until}. ${armed.hint}`;
  }
  return armed;
}

async function handleLaunchFailure({ job, res, runId, runDir, launchKey, launchEnv, claudeVersion }) {
  const lf = res.launchFailure;
  const now = Date.now();
  const mitigationApplied = !!(launchEnv && Object.keys(launchEnv).length);
  let armed = null;
  await mutate((s) => {
    armed = applyLaunchFailure(s, { job, lf, runId, launchKey, mitigationApplied, claudeVersion, now });
  });
  launchFailure.writeOutcomeSidecar(runDir, job.slug, {
    runId,
    exitCode: res.exitCode,
    durationMs: res.durationMs ?? null,
    numTurns: res.resultStats?.numTurns ?? null,
    outputTokens: res.resultStats?.outputTokens ?? null,
    totalCostUsd: res.resultStats?.totalCostUsd ?? null,
    verdict: null,
    status: 'pending',
    terminalReason: `launch_failure:${lf.kind}`,
    launchFailure: { kind: lf.kind, httpStatus: lf.httpStatus ?? null, message: lf.message },
    launchEnvApplied: launchEnv ? Object.keys(launchEnv) : [],
    filesChanged: 0,
    landedCommit: null,
  });
  try {
    appendError({
      cwd: job.cwd || DEFAULT_PROJECT_CWD,
      scope: 'scheduler',
      level: 'error',
      message: `launch failure (${lf.kind}) for ${job.slug}: ${lf.message} — persona '${launchKey}' blocked, attempt ${armed?.attempts}${armed?.exhausted ? ' (exhausted; needs CLI update or Retry)' : ''}`,
      meta: { slug: job.slug, runId, kind: lf.kind, httpStatus: lf.httpStatus ?? null, claudeVersion: claudeVersion ?? null, mitigationApplied, hint: armed?.hint },
    });
  } catch { /* durable logging must never break the queue */ }
  console.error(`[scheduler] ${job.slug}: LAUNCH FAILURE (${lf.kind}${lf.httpStatus ? ` HTTP ${lf.httpStatus}` : ''}) — ${lf.message}. ` +
    `Persona '${launchKey}' blocked (attempt ${armed?.attempts}${armed?.until ? `, re-probe at ${armed.until}` : ', exhausted'}). ${armed?.hint}`);
  await broadcast({ flush: true });
}

async function spawnJob(job, runId, runDir, defaultCwd, resumeTarget = null) {
  // Session-Manager owns the machine-wide `claude -p` pool (sessionSlots.cjs)
  // — the scheduler REQUESTS capacity, it doesn't own a private cap. A miss
  // leaves the job pending; the next tick retries when a slot frees up.
  const slotToken = sessionSlots.acquire(`scheduler:${job.slug}`);
  if (!slotToken) {
    console.log(`[scheduler] no session slot free for ${job.slug} — deferring (${JSON.stringify(sessionSlots.snapshot().holders.map((h) => h.owner))})`);
    return;
  }
  runningSet.add(job.slug);
  // Exclusive quiet-machine lease (PRD 1107) — acquired here, in the same
  // slot-acquire/dispatch step as sessionSlots, and released in this
  // function's own finally below alongside sessionSlots.release, so every
  // exit path (normal exit, timeout, SIGTERM, crash) that already frees the
  // session slot also frees the lease. pickNextBatch only ever hands this
  // function a quietMachine job when the lease was free at pick time, so
  // acquire() here should never fail in practice — but check anyway rather
  // than assume, since a lease held by a stale slug would otherwise wedge
  // silently.
  const quietLeaseAcquired = job.quietMachine === true && quietMachineLease.acquire(job.slug);
  try {
    // Worktree isolation cap check (PRD 1112) — probed BEFORE the job is
    // marked 'running', so a job that can't get isolation right now is a
    // DEFERRAL, not a fallback: it stays 'pending' and is retried on the
    // next dispatch pass, exactly like the sessionSlots miss above, instead
    // of degrading into an in-place run in a tree a sibling job may be
    // actively writing to (the shared-tree collision this cap exists to
    // prevent). Every OTHER worktree.ok===false reason (not a git repo,
    // disabled, carry-over failure) keeps the existing in-place fallback —
    // only the cap-reached reason is a deferral, checked here via
    // createJobWorktree's own reason string so the two paths never
    // silently drift out of sync with gitWorktree.cjs's actual wording.
    const preflightWorktree = resumeTarget
      ? { ok: false, reason: 'resume-recovery: running in place to reuse the session\'s prior working tree' }
      : await jobWorktree.createJobWorktree({ cwd: job.cwd || defaultCwd, slug: job.slug });
    if (!preflightWorktree.ok && /^worktree cap reached\b/.test(preflightWorktree.reason || '')) {
      console.log(`[scheduler] ${job.slug}: deferring — ${preflightWorktree.reason}`);
      await mutate((s) => {
        const idx = s.jobs.findIndex((x) => x.slug === job.slug);
        if (idx >= 0) s.jobs[idx].heldReason = preflightWorktree.reason;
      });
      await broadcast({ flush: true });
      return;
    }
    // Launch circuit breaker (lib/launchFailure.cjs, issue #11). Re-evaluated
    // here, not just in tickQueue, because the block can change between the
    // pick and this dispatch (another job's probe just failed). 'blocked' →
    // hold the row; 'probe' → this job is the single half-open probe and is
    // stamped as such so no sibling probes the same broken persona at once.
    const launchKey = launchFailure.launchBlockKeyFor(job);
    const claudeVersionNow = await probeClaudeVersion();
    let launchEnv = null;
    let launchProbe = false;
    const launchGate = await mutate((s) => {
      s.launchBlocks = s.launchBlocks || {};
      s.launchMitigations = s.launchMitigations || {};
      const mitigation = s.launchMitigations[launchKey];
      if (mitigation && claudeVersionNow && mitigation.claudeVersion && mitigation.claudeVersion !== claudeVersionNow) {
        console.log(`[scheduler] launch gate: CLI version changed (${mitigation.claudeVersion} → ${claudeVersionNow}) — dropping ${launchKey} mitigation to retry a clean launch`);
        delete s.launchMitigations[launchKey];
      }
      const block = s.launchBlocks[launchKey];
      const gate = launchFailure.evaluateLaunchGate(block, { now: Date.now(), claudeVersion: claudeVersionNow });
      if (gate.state === 'open' && block) {
        console.log(`[scheduler] launch gate: clearing ${launchKey} block (${gate.reason})`);
        delete s.launchBlocks[launchKey];
      }
      if (gate.state === 'blocked') {
        const idx = s.jobs.findIndex((x) => x.slug === job.slug);
        if (idx >= 0) s.jobs[idx].heldReason = gate.reason;
        return gate;
      }
      if (gate.state === 'probe') {
        block.probing = { slug: job.slug, at: new Date().toISOString() };
        launchProbe = true;
        launchEnv = block.mitigationEnv || null;
      } else if (s.launchMitigations[launchKey]?.env) {
        launchEnv = { ...s.launchMitigations[launchKey].env };
      }
      return gate;
    });
    if (launchGate.state === 'blocked') {
      console.log(`[scheduler] ${job.slug}: deferring — ${launchGate.reason}`);
      await broadcast({ flush: true });
      return;
    }
    if (launchProbe) {
      console.log(`[scheduler] ${job.slug}: dispatching as launch probe for '${launchKey}'${launchEnv ? ` with mitigation ${JSON.stringify(launchEnv)}` : ''}`);
    }

    // Captured here (not read back off `job`, a pre-dispatch snapshot that
    // mutate()'s fresh-from-disk read never touches) so the rate-limited
    // branch below has this run's OWN start time — the freshness check
    // (isCooldownSuppressed) needs to know whether this specific dispatch
    // started after the manual clear, not whatever startedAt this row
    // carried from a prior run.
    let dispatchStartedAtMs = null;
    await mutate((s) => {
      const idx = s.jobs.findIndex((x) => x.slug === job.slug);
      if (idx >= 0) {
        transitionJob(s.jobs[idx], 'running', {
          reason: resumeTarget ? 'dispatched for resume-recovery' : 'dispatched for execution',
          source: 'spawnJob:dispatch',
        });
        delete s.jobs[idx].heldReason;
        s.jobs[idx].runId = runId;
        s.jobs[idx].startedAt = new Date().toISOString();
        dispatchStartedAtMs = Date.parse(s.jobs[idx].startedAt);
        if (job.quietMachine === true) {
          s.jobs[idx].quietMachine = true;
          s.jobs[idx].quietLeaseDegraded = job.quietLeaseDegraded === true;
        }
        // Stamp the bounded one-attempt marker BEFORE the resume spawn, in
        // the SAME mutate as the 'running' transition, so an app crash
        // between here and the child actually spawning still leaves this
        // job un-retriable (selectResumeRecoveryTarget returns null once
        // this is true) rather than silently re-firing forever.
        if (resumeTarget) {
          s.jobs[idx].resumeRecoveryAttempted = true;
        }
      }
    });
    await broadcast({ flush: true });

    // Commit-guard baseline: snapshot the working tree BEFORE the run so the
    // post-run check flags only paths THIS job left dirty, not pre-existing WIP.
    const guardCwd = job.cwd || defaultCwd;
    const guardBaseline = await uncommittedChanges(guardCwd);
    const guardHeadBefore = await gitHead(guardCwd);
    // Shared-tree stash guard baseline (incident 2026-09-01): captured
    // unconditionally, before worktree isolation is even attempted, so an
    // in-place run always has a true pre-run snapshot to diff against. See
    // checkSharedTreeGuard below, gated to in-place runs only.
    const stashBaseline = await stashList(guardCwd);

    // Persist the pre-run baseline onto the row itself (not just the local
    // variable) so a finalizer that never reaches the rest of THIS function
    // — namely reapDeadRunningJobs, when the process vanishes mid-run — can
    // still compute a truthful newly-dirty delta instead of having no
    // baseline at all. `runtime` (unlike this) is deleted on finalize; this
    // survives until the finalize mutate below explicitly clears it.
    //
    // preRunDirtyPaths is the SAME snapshot, capped and reworked into the
    // executor-facing manifest (buildForeignWipSection) telling the job which
    // paths it does not own — unlike guardBaseline/guardHeadBefore, it is
    // deliberately left on the row through to history.jsonl (not deleted at
    // finalize) so a post-hoc reader can tell whether a completed job ran
    // against foreign WIP.
    const preRunDirtyPaths = capDirtyPaths(guardBaseline);
    await mutate((s) => {
      const idx = s.jobs.findIndex((x) => x.slug === job.slug);
      if (idx >= 0) {
        s.jobs[idx].guardBaseline = guardBaseline || [];
        s.jobs[idx].guardHeadBefore = guardHeadBefore || null;
        if (preRunDirtyPaths.length) s.jobs[idx].preRunDirtyPaths = preRunDirtyPaths;
        else delete s.jobs[idx].preRunDirtyPaths;
      }
    });

    // Worktree isolation (PRD 994): give this job its own linked `git worktree`
    // checkout so its edits/tests/commit never collide with a sibling job or
    // an interactive session in the SAME repo. `worktree.ok` is false (with a
    // logged reason) for a non-git cwd, a dirty base tree, or
    // SM_JOB_WORKTREE_DISABLE=1 — every case falls back to running in place,
    // never a hard failure. (The cap-reached reason was already handled above
    // as a pre-dispatch DEFERRAL — a job never reaches this point with that
    // reason.) See jobWorktree.cjs's header comment for why job.cwd
    // (guardCwd) itself is NEVER repointed at the worktree dir. Reuses
    // `preflightWorktree` computed above the 'running' transition — it
    // already IS this job's worktree attempt (or already-created checkout),
    // so calling createJobWorktree a second time here would double-create
    // (or double-count the cap) for the exact same job.
    const worktree = preflightWorktree;
    if (worktree.ok) {
      console.log(`[scheduler] ${job.slug}: isolated in worktree ${worktree.dir} (branch ${worktree.branch})`);
    } else {
      console.log(`[scheduler] ${job.slug}: running in main tree (worktree not used: ${worktree.reason})`);
      // Surface any degraded-isolation fallback on the job row itself so it's
      // queryable from the queue instead of console-only — except the
      // deliberate env-disable flag, which is an intentional opt-out, not a
      // degradation worth flagging.
      if (!jobWorktree.isWorktreeDisabled()) {
        await mutate((s) => {
          const idx = s.jobs.findIndex((x) => x.slug === job.slug);
          if (idx >= 0) s.jobs[idx].worktreeFallbackReason = worktree.reason;
        });
      }
    }
    // Base-tree WIP carried into the worktree (createWorktree, PRD 1094) —
    // recorded on the job row so integration can exclude these paths from
    // the branch diff below, and so it's queryable from the queue.
    const carriedPaths = (worktree.ok && Array.isArray(worktree.carriedPaths)) ? worktree.carriedPaths : [];
    if (carriedPaths.length) {
      await mutate((s) => {
        const idx = s.jobs.findIndex((x) => x.slug === job.slug);
        if (idx >= 0) s.jobs[idx].carriedPaths = carriedPaths;
      });
    }

    // Integrate the job's branch back into guardCwd's own HEAD, THEN tear the
    // worktree checkout down — both must happen BEFORE any git read below
    // (verify/commit-guard/sigterm check all read guardCwd), so a commit made
    // inside the worktree is a real commit on the main tree by the time those
    // checks run, exactly like an in-place commit would be. A leftover
    // uncommitted file in the worktree would otherwise vanish unnoticed when
    // the checkout is removed — captured here (worktreeLeftoverDirty) and
    // folded into the commit-guard's dirty-file list further down.
    //
    // Wrapped in try/finally (not straight-line) so an unexpected throw from
    // executeJob itself still runs integration+cleanup — otherwise a bug
    // elsewhere in executeJob would leak the worktree checkout (and its
    // activeWorktreeCount slot) for the rest of this process's life.
    let res;
    let worktreeLeftoverDirty = [];
    let worktreeIntegrationFailure = null;
    // Set only when integrateJobBranch's stderr-parsing auto-resolve fired
    // (PRD 1125) — surfaced on the job row so the Queue UI can say the merge
    // self-healed rather than silently looking like an ordinary merge.
    let mergeAutoResolved = null;
    let mergeAutoResolvedPaths = null;
    // A job's uncommitted-work patch, whichever isolation mode produced it —
    // set by EITHER branch below, never both (worktree.ok picks exactly one
    // shape for the whole run). Named generically (not "worktree...") because
    // an in-place run salvages one too (PRD 1098).
    let salvagePatch = null;
    // Which foreign-WIP shape applies to THIS run: an isolated worktree only
    // ever needs to disclose carriedPaths (its checkout starts clean apart
    // from those carried paths); an in-place/shared-tree run discloses the
    // raw pre-run dirty snapshot instead. Never both — see
    // buildForeignWipSection.
    const foreignWip = worktree.ok ? { carriedPaths } : { preRunDirtyPaths };
    try {
      res = await executeJob(job, runDir, defaultCwd, async (pid, sessionId, cwd) => {
        await mutate((s) => {
          const idx = s.jobs.findIndex((x) => x.slug === job.slug);
          if (idx >= 0) {
            s.jobs[idx].sessionId = sessionId;
            s.jobs[idx].runtime = { pid, runId, startedAt: s.jobs[idx].startedAt, sessionId, cwd };
          }
        });
        await broadcast({ flush: true });
      }, worktree.ok ? worktree.dir : undefined, resumeTarget, foreignWip, launchEnv);
    } finally {
      if (worktree.ok) {
        worktreeLeftoverDirty = (await uncommittedChanges(worktree.dir)) || [];
        // Salvage the worktree's full diff (tracked + untracked) to the run
        // dir BEFORE the checkout is removed below — otherwise a job killed
        // before its finish-protocol commit loses that work outright, with
        // no branch, no stash, no patch anywhere. Best-effort: never blocks
        // integration/cleanup and never changes the job's verdict.
        if (worktreeLeftoverDirty.length) {
          const salvagePath = path.join(runDir, `${job.slug}.uncommitted.patch`);
          const salvage = await jobWorktree.salvageJobWorktreeDiff({ dir: worktree.dir, outFile: salvagePath });
          if (salvage && salvage.ok) {
            salvagePatch = salvagePath;
            console.log(`[scheduler] ${job.slug}: salvaged ${salvage.bytes} byte(s) of uncommitted worktree diff to ${salvagePath}`);
          }
        }
        const integration = await jobWorktree.integrateJobBranch({ cwd: guardCwd, branch: worktree.branch, slug: job.slug, carriedPaths });
        if (integration.ok && integration.reason === 'carried-wip-only') {
          console.log(`[scheduler] ${job.slug}: worktree branch ${worktree.branch} touched only carried base WIP paths — skipping merge (carried-wip-only)`);
        }
        if (!integration.ok) {
          worktreeIntegrationFailure = integration.reason;
          console.error(`[scheduler] ${job.slug}: worktree branch integration FAILED (${integration.reason}) — branch ${worktree.branch} preserved in ${guardCwd} for manual recovery`);
        } else if (integration.integrated) {
          console.log(`[scheduler] ${job.slug}: worktree branch ${worktree.branch} integrated into ${guardCwd}${integration.mergeCommit ? ' (merge commit)' : ' (fast-forward)'}`);
          if (integration.autoResolved) {
            mergeAutoResolved = integration.autoResolved;
            mergeAutoResolvedPaths = integration.resolvedPaths || [];
            console.log(`[scheduler] ${job.slug}: merge auto-resolved (${integration.autoResolved}) — discarded ${mergeAutoResolvedPaths.length} identical working-tree duplicate(s): ${mergeAutoResolvedPaths.join(', ')}`);
          }
        }
        await jobWorktree.cleanupJobWorktree({
          cwd: guardCwd,
          dir: worktree.dir,
          branch: worktree.branch,
          keepBranch: !integration.ok,
        });
      } else {
        // In-place run (non-git cwd, cap reached, env-disabled, or a carry-over
        // failure) — there is no throwaway checkout to diff, so salvage only
        // the DELTA this job itself dirtied: paths in guardBaseline are a
        // human's or a sibling job's pre-existing WIP and must never appear in
        // this job's patch. Runs for every exit code (finally always fires
        // once `res` resolves, success or not) including signal deaths and the
        // rate-limited/halt path — a killed in-place run is exactly the case
        // this exists to cover. Never mutates guardCwd's index or stashes:
        // salvageDirtyDelta is read-only (git status + git diff only).
        try {
          const after = await uncommittedChanges(guardCwd);
          if (after) {
            const baseSet = new Set(guardBaseline || []);
            const deltaPaths = after.filter((p) => !baseSet.has(p));
            if (deltaPaths.length) {
              const salvagePath = path.join(runDir, `${job.slug}.uncommitted.patch`);
              const salvage = await jobWorktree.salvageJobDirtyDelta({ cwd: guardCwd, paths: deltaPaths, outFile: salvagePath });
              if (salvage && salvage.ok) {
                salvagePatch = salvagePath;
                console.log(`[scheduler] ${job.slug}: salvaged ${salvage.bytes} byte(s) of uncommitted in-place diff (${deltaPaths.length} path(s)) to ${salvagePath}`);
              }
            }
          }
        } catch (e) {
          console.error(`[scheduler] ${job.slug}: in-place salvage failed`, e);
        }
      }
    }

    // Newly-dirty leftover computation — hoisted OUT of the exit===0 branch
    // (below) so it runs for every terminal outcome: exit 0, any non-zero
    // exit including 137/143, and the rate-limited/halt path alike. This is
    // the exact same shape the exit=0 commit-guard and the transient-failure
    // classifier each used to compute independently (guardCwd's own
    // baseline-delta UNION worktreeLeftoverDirty, which is already
    // inherently-new since it came from a fresh worktree checkout with no
    // baseline to diff against) — computed once here and reused by both
    // below, plus by the terminal-finalize mutate for leftoverPaths/
    // leftoverCount. null only when git-status itself is unavailable
    // (non-git cwd / git errored) — NEVER treated as "left nothing", exactly
    // like every other best-effort git-state check in this function.
    const afterGuardCwd = await uncommittedChanges(guardCwd);
    // stripAppOwnedChurn: the app writes session-manager-operations/ (queue.json,
    // history.jsonl, active-index.json, transcripts) DURING this job's own guard
    // window, so those land in the delta and get blamed on the job. A job can
    // never be responsible for them — see jobDirtFilter.cjs. Applied here, at
    // the single place the delta is computed, so the commit guard, the
    // transient-retry dirty check and leftoverPaths all agree.
    const newlyDirtyAll = afterGuardCwd === null
      ? null
      : stripAppOwnedChurn([...new Set([
          ...afterGuardCwd.filter((p) => !new Set(guardBaseline || []).has(p)),
          ...worktreeLeftoverDirty,
        ])]);

    if (res.launchFailure) {
      await handleLaunchFailure({ job, res, runId, runDir, launchKey, launchEnv, claudeVersion: claudeVersionNow });
      return;
    }
    if (launchFailure.resultShowsRealTurn(res.resultStats)) {
      // The launch worked (whatever happens to the run next) — close the
      // breaker for this persona. If the probe only got through thanks to a
      // mitigation env, keep applying that env to every later launch of the
      // persona until the CLI version changes; otherwise the very next job
      // would fail the same way and re-arm the block (a flap per job).
      await mutate((s) => {
        const block = s.launchBlocks?.[launchKey];
        if (!block) return;
        delete s.launchBlocks[launchKey];
        if (launchEnv && Object.keys(launchEnv).length) {
          s.launchMitigations = s.launchMitigations || {};
          s.launchMitigations[launchKey] = {
            kind: block.kind,
            env: { ...launchEnv },
            since: new Date().toISOString(),
            claudeVersion: claudeVersionNow ?? block.claudeVersion ?? null,
            hint: launchFailure.launchFailureHint(block.kind, { claudeVersion: claudeVersionNow ?? block.claudeVersion }),
          };
          console.log(`[scheduler] launch gate: ${launchKey} recovered via mitigation ${JSON.stringify(launchEnv)} — kept in force until the CLI version changes`);
        } else {
          console.log(`[scheduler] launch gate: ${launchKey} recovered — block cleared after ${block.attempts} failed probe(s)`);
        }
      });
    }

    if (res.rateLimited) {
      const resetIso = await refreshNextReset().catch(() => cachedNextReset);
      const observedAt = dispatchStartedAtMs;
      const prevCount = consecutiveRapidRateLimitsBySlug.get(job.slug) || 0;
      const nextCount = nextRapidRateLimitCount(prevCount, { rateLimited: true, durationMs: res.durationMs });
      consecutiveRapidRateLimitsBySlug.set(job.slug, nextCount);
      const forceHardPause = nextCount >= CONSECUTIVE_RAPID_RATE_LIMIT_THRESHOLD;
      if (forceHardPause) {
        console.log(`[scheduler] ${job.slug}: ${nextCount} consecutive rate-limited dispatches under ${RAPID_RATE_LIMIT_WINDOW_MS / 1000}s each — engaging hard pause`);
      }
      await setPaused('rate_limit', resetIso, { observedAt, force: forceHardPause });
    } else {
      consecutiveRapidRateLimitsBySlug.delete(job.slug);
    }

    // Stale queue entry: the PRD was archived (already shipped) or is gone
    // from disk entirely (deleted before dispatch). Both are retire-not-fail
    // results from prdArchivedSkipResult with exitCode 0 and no transcript —
    // no verify pass, no commit guard, no RCA feedback item — but only
    // 'prd-archived' actually means the work shipped (archivedTwinExists
    // found the file under a prds-archived/ dir). 'prd-missing' means no
    // executor ever ran at all, so it must NOT land on the same 'completed'
    // status a genuine successful run produces — that conflation is what let
    // 20 never-executed sigma PRDs read as shipped (2026-08-30 incident).
    if (res.skipped) {
      const targetStatus = res.skipped === 'prd-missing' ? 'skipped' : 'completed';
      await mutate((s) => {
        const idx = s.jobs.findIndex((x) => x.slug === job.slug);
        if (idx >= 0) {
          transitionJob(s.jobs[idx], targetStatus, { reason: res.note ?? 'PRD archived or missing — treated as already-shipped', source: 'spawnJob:skip-archived' });
          s.jobs[idx].finishedAt = new Date().toISOString();
          s.jobs[idx].exitCode = 0;
          s.jobs[idx].error = null;
          delete s.jobs[idx].runtime;
        }
      });
      await broadcast({ flush: true });
      return;
    }

    // Post-run verification: for exit=0 runs, scan the transcript and check
    // dependency prerequisites before stamping 'completed'. This catches the
    // false-positive class where an agent exits cleanly while leaving failures
    // in its tool output (see incidents: PRD 39, 44, 56 on 2026-05-23→24).
    // Called outside mutate() so the queue lock is not held during I/O.
    let verifyResult = null;
    // Persisted onto the job row (see the mutate() block below) whenever
    // this run's own HEAD advances, so a LATER re-fire of the same slug can
    // pass it back into verifyRun as priorLandedCommit (see the
    // pass_no_commit_prior_run_verified exemption in runVerify.cjs).
    let jobLandedCommitThisRun = null;
    let sharedTreeGuard = null;
    if (res.exitCode === 0 && !res.rateLimited) {
      // Detect whether the job self-committed by comparing HEAD before/after.
      // Used by the sentinel override: SCHEDULER_VERDICT: PASS + a landed
      // commit together override incidental transcript noise verdicts.
      const headAtExit = await gitHead(guardCwd);
      const committedDuringRun = await computeCommittedDuringRun(
        guardCwd,
        guardHeadBefore,
        headAtExit,
        job.startedAt,
        new Date().toISOString(),
      );
      if (guardHeadBefore && headAtExit && headAtExit !== guardHeadBefore) {
        jobLandedCommitThisRun = headAtExit;
      }

      const prdPath = (await resolveVerifyPrdPath(job)) ?? archivedPrdPathForJob(job);
      const stateForDeps = await readQueue();
      // priorLandedCommit: the commit a PREVIOUS run of this same slug landed,
      // if any — prefer the live jobs[] row (survives a resetJob, see
      // resetJobFields), fall back to history.jsonl for a slug that already
      // left jobs[]. Never the commit THIS run just made (committedDuringRun
      // already covers that case).
      const liveRow = stateForDeps.jobs.find((j) => j.slug === job.slug);
      let priorLandedCommit = liveRow?.landedCommit ?? null;
      if (!priorLandedCommit) {
        const hist = await queueHistory.historyTerminalBySlug().catch(() => null);
        priorLandedCommit = hist?.get(job.slug)?.landedCommit ?? null;
      }
      verifyResult = await verifyRun({
        runDir,
        prdPath,
        queueEntry: job,
        allJobs: stateForDeps.jobs,
        committedDuringRun,
        priorLandedCommit,
      }).catch((e) => ({
        verdict: 'verify_unavailable',
        reason: `verifier threw: ${e?.message ?? String(e)}`,
        downgradeTo: 'needs_review',
      }));
      if (verifyResult.verdict !== 'clean') {
        console.log(
          `[scheduler] verifier: ${job.slug} verdict=${verifyResult.verdict}` +
          ` → ${verifyResult.downgradeTo ?? 'completed'}: ${verifyResult.reason}`,
        );
      }
    }

    // Commit guard: a clean exit that landed no commit means the finish
    // protocol's COMMIT step did not run. Surface it as needs_review instead
    // of letting it masquerade as 'completed' (the PRD 03/04 left-uncommitted
    // incident, and PRD 972's zero-edit variant of the same failure). Runs
    // for BOTH shapes — newly-dirty files left behind, AND an already-clean
    // tree with no commit at all — since a clean exit that commits nothing
    // and dirties nothing is the strongest possible silent-no-op signal, not
    // proof the guard has nothing to check. commitGuardVerdict's own doc
    // comment (above) covers all four false-positive defenses that apply to
    // both shapes: baseline DELTA (below), sibling skip, self-commit skip,
    // legitimate-no-op skip, and (zero-edit only) the fix-plan exemption.
    // Non-git cwds resolve to null and are skipped (the guard is best-effort).
    //
    // Runs even when a transcript-pattern verdict already fired: the commit-guard
    // is a MATERIALLY-CHECKABLE signal (real git state) and outranks pattern hits.
    // Skipped only when the job is about to re-fire (HALT / deps_unmet → pending),
    // where working-tree state is irrelevant. When both fire, the uncommitted
    // verdict owns the needs_review reason and the pattern hit is demoted to an
    // annotation, so a real "finish protocol incomplete" is distinguishable from
    // transcript noise in the queue (feedback 2026-06-10 addendum).
    const guardWillRefire = verifyResult && verifyResult.downgradeTo === 'pending';
    const guardIsLegitimateNoOp = verifyResult && COMPLETED_EQUIVALENT_VERDICTS.has(verifyResult.verdict);
    if (res.exitCode === 0 && !res.rateLimited && !guardWillRefire && !guardIsLegitimateNoOp) {
      // afterGuardCwd === null means non-git cwd (or git errored) —
      // best-effort skip, same as always; only a git-status result (even an
      // empty one) counts as evidence for the zero-edit path. newlyDirtyAll
      // was computed once, above, right after the try/finally.
      if (afterGuardCwd !== null) {
        const newlyDirty = newlyDirtyAll;
        const guardState = await readQueue().catch(() => ({ jobs: [] }));
        const siblingRunning = (guardState.jobs || []).some(
          (j) => j.slug !== job.slug && j.status === 'running' && (j.cwd || defaultCwd) === guardCwd,
        );
        const guardHeadAfter = await gitHead(guardCwd);
        const jobSelfCommitted = guardHeadBefore && guardHeadAfter && guardHeadAfter !== guardHeadBefore;
        const guardVerdict = commitGuardVerdict({
          newlyDirty,
          siblingRunning,
          ranInWorktree: worktree.ok,
          jobSelfCommitted,
          legitimateNoOp: guardIsLegitimateNoOp,
          isFixPlanJob: isFixPlanSlug(job.slug),
          verifyResult,
          salvagePatch,
        });
        if (guardVerdict) {
          verifyResult = guardVerdict;
          const what = newlyDirty.length > 0 ? `left ${newlyDirty.length} files uncommitted` : 'made no commit on an already-clean tree';
          console.log(`[scheduler] commit-guard: ${job.slug} ${what} → needs_review`);
        }
      }
    }

    // Worktree branch integration failure is a materially-checkable git-state
    // signal exactly like the commit-guard above, and takes the same priority:
    // a job whose commit could not be merged back into the main tree is NOT a
    // success, whatever its exit code or verifier verdict said — the commit
    // guard AC explicitly requires this failure be surfaced as an explicit job
    // outcome, never silently dropped alongside the branch it's stranded on.
    if (worktreeIntegrationFailure) {
      verifyResult = {
        verdict: 'worktree_integration_failed',
        reason: `worktree branch integration failed: ${worktreeIntegrationFailure} — branch preserved for manual merge`,
        downgradeTo: 'needs_review',
      };
    }

    // Shared-tree stash guard (incident 2026-09-01): only meaningful for an
    // IN-PLACE run — worktree.ok isolates the job's git state into its own
    // checkout, so nothing there can leak into guardCwd. Best-effort and run
    // regardless of exit code: a job can discard shared state on its way to
    // a non-zero exit just as easily as on a clean one.
    if (!worktree.ok) {
      sharedTreeGuard = await module.exports.checkSharedTreeGuard({
        cwd: guardCwd,
        stashBaseline,
        dirtyBaseline: guardBaseline,
        headBefore: guardHeadBefore,
        slug: job.slug,
      });
      // A restored stash alone isn't silence — it's logged loudly above and
      // surfaced on the job row below — but a path that's still missing
      // (restore failed, or two-plus stashes we refused to guess between, or
      // a revert with no stash to restore at all) must not finish green.
      if (sharedTreeGuard && (sharedTreeGuard.restoreFailed || sharedTreeGuard.ambiguousStashes || sharedTreeGuard.reverted)) {
        verifyResult = {
          verdict: 'shared_tree_reverted',
          reason: sharedTreeGuard.reverted
            ? `job discarded pre-existing state in the shared tree: ${sharedTreeGuard.reverted.length} path(s) reverted with no commit to explain it (${sharedTreeGuard.reverted.slice(0, 3).join(', ')})`
            : sharedTreeGuard.restoreFailed
              ? `job stashed the shared tree and the stash could not be auto-restored: ${sharedTreeGuard.restoreFailed}`
              : `job created ${sharedTreeGuard.ambiguousStashes.length} stashes in the shared tree — ambiguous, not auto-restored (${sharedTreeGuard.ambiguousStashes.join(', ')})`,
          downgradeTo: 'needs_review',
        };
      }
    }

    // SIGTERM commit check: reuse the same commit-window scan the exit=0
    // guard uses above (one commit-detection path, not two) to see whether a
    // 143 (SIGTERM) run still landed a deliverable before it died. Scoped
    // narrowly to exit 143 — never applied to other non-zero exit codes or to
    // rateLimited (already handled separately, above).
    let sigtermCommitFound = false;
    if (res.exitCode === 143 && !res.rateLimited) {
      const guardHeadAtSigterm = await gitHead(guardCwd);
      sigtermCommitFound = await computeCommittedDuringRun(
        guardCwd,
        guardHeadBefore,
        guardHeadAtSigterm,
        job.startedAt,
        new Date().toISOString(),
      );
    }

    let actuallyFailed = false;
    let failedJobSnapshot = null;
    let needsInvestigationNow = false;
    let investigationJobSnapshot = null;
    let needsReviewRcaSnapshot = null;
    let resumeRecoveryJob = null;
    let resumeRecoveryTarget = null;
    let terminalNotifySnapshot = null;
    const newlyCompletedPrds = [];
    await mutate((s) => {
      const i2 = s.jobs.findIndex((x) => x.slug === job.slug);
      // A job already moved off 'running' by someone else (namely
      // remote.cancelJob, PRD 1024 — it SIGTERMs the process then finalizes
      // the row to 'failed' before this exit handler necessarily runs) is
      // not this run's to finalize: doing so anyway could re-legalize the
      // row via a legal failed->completed/needs_review edge (see
      // scheduleJobTransitions.cjs's LEGAL_TRANSITIONS) and silently
      // undo the cancellation. Skip — the row already reflects its real
      // terminal state.
      if (i2 >= 0 && s.jobs[i2].status !== 'running') return;
      if (i2 >= 0) {
        const treatAsPending = res.rateLimited || (s.paused && s.paused.reason === 'rate_limit');
        if (treatAsPending) {
          resetJobFields(s.jobs[i2], res.rateLimited ? 'paused: rate limit' : 'paused: queue halted', { source: 'spawnJob:halt-reset' });
        } else {
          // Determine effective status, applying the verifier verdict for exit=0 runs.
          let effectiveStatus;
          let sigtermOverrideReason = null;
          const sigtermOverride = res.exitCode !== 0
            ? classifySigtermWithCommit(res.exitCode, sigtermCommitFound)
            : null;
          if (sigtermOverride) {
            effectiveStatus = sigtermOverride.status;
            sigtermOverrideReason = sigtermOverride.reason;
          } else if (res.exitCode !== 0) {
            effectiveStatus = 'failed';
          } else if (
            !verifyResult
            || COMPLETED_EQUIVALENT_VERDICTS.has(verifyResult.verdict)
          ) {
            effectiveStatus = 'completed';
          } else if (verifyResult.downgradeTo === 'pending') {
            // HALT or deps_unmet: reset to pending so the job re-fires.
            resetJobFields(s.jobs[i2], verifyResult.reason, { source: 'spawnJob:verify-downgrade' });
            return; // job already mutated by resetJobFields; skip the rest
          } else {
            // transcript_errors or verify_unavailable: escalate to needs_review.
            effectiveStatus = 'needs_review';
          }

          transitionJob(s.jobs[i2], effectiveStatus, { reason: sigtermOverrideReason ?? `run finished with exit ${res.exitCode}`, source: 'spawnJob:finalize' });
          s.jobs[i2].finishedAt = new Date().toISOString();
          s.jobs[i2].exitCode = res.exitCode;
          s.jobs[i2].leakedDescendants = res.leakedDescendants ?? [];
          if (salvagePatch) {
            s.jobs[i2].salvagePatch = salvagePatch;
          } else {
            delete s.jobs[i2].salvagePatch;
          }
          s.jobs[i2].error = effectiveStatus === 'needs_review'
            ? (verifyResult?.reason ?? sigtermOverrideReason ?? null)
            // A failed job (non-zero exit) never consults verifyResult above,
            // but a worktree integration failure is still worth surfacing on
            // the row so the stranded branch isn't silently invisible —
            // concatenated (not `||`), so it's never dropped when res.error
            // is ALSO set (e.g. a real exit failure whose branch also failed
            // to integrate must show both, not just the first one).
            : [res.error, worktreeIntegrationFailure ? verifyResult.reason : null].filter(Boolean).join('; ') || null;
          // Persist the commit THIS run landed (if HEAD advanced) so a later
          // re-fire of the same slug can prove its own no-op re-run is
          // truthful via the pass_no_commit_prior_run_verified exemption.
          // Survives resetJobFields — see that function's comment.
          if (jobLandedCommitThisRun) {
            s.jobs[i2].landedCommit = jobLandedCommitThisRun;
          }
          // Persist the verifier's verdict string so the renderer can show it.
          if (verifyResult?.verdict && verifyResult.verdict !== 'clean') {
            s.jobs[i2].verifierVerdict = verifyResult.verdict;
          } else {
            delete s.jobs[i2].verifierVerdict;
          }
          // Closed-set outcome taxonomy (issue #11 list A2) so a queue row
          // says WHY it ended without anyone opening the transcript.
          s.jobs[i2].terminalReason = launchFailure.deriveTerminalReason({
            effectiveStatus, exitCode: res.exitCode, verifyResult, sigtermOverride, worktreeIntegrationFailure,
          });
          delete s.jobs[i2].launchFailure;
          delete s.jobs[i2].heldReason;
          // Persist the commit-guard's exact dirty-path list (verdict
          // 'uncommitted_changes' only) so a later resume-recovery attempt
          // (selectResumeRecoveryTarget) can name these paths without
          // re-running `git status` against a tree that may have moved on.
          if (verifyResult?.verdict === 'uncommitted_changes' && Array.isArray(verifyResult.dirtyPaths)) {
            // Capped the same way preRunDirtyPaths/leftoverPaths are — an
            // uncapped list here would let a pathologically dirty tree bloat
            // queue.json/history.jsonl and the resume-recovery prompt built
            // from it (buildResumeRecoveryPreamble/selectResumeRecoveryTarget).
            s.jobs[i2].uncommittedPaths = capDirtyPaths(verifyResult.dirtyPaths);
          } else {
            delete s.jobs[i2].uncommittedPaths;
          }
          // Worktree merge self-healed (PRD 1125) — every blocking path was
          // proven byte-identical to the branch, so the duplicate was
          // discarded and the merge retried once, successfully. Surfaced so
          // the Queue UI shows a self-heal instead of an ordinary merge.
          if (mergeAutoResolved) {
            s.jobs[i2].mergeAutoResolved = mergeAutoResolved;
            s.jobs[i2].mergeAutoResolvedPaths = capDirtyPaths(mergeAutoResolvedPaths);
          } else {
            delete s.jobs[i2].mergeAutoResolved;
            delete s.jobs[i2].mergeAutoResolvedPaths;
          }
          // Non-blocking notes (e.g. a recovered missing-dependency probe, or a
          // pattern hit demoted because a materially-checkable verdict outranked
          // it) — surfaced even on completed jobs so the signal isn't lost.
          if (verifyResult?.annotations && verifyResult.annotations.length) {
            s.jobs[i2].verifierAnnotations = verifyResult.annotations.map(
              (a) => `${a.verdict}: ${a.reason}`,
            );
          } else {
            delete s.jobs[i2].verifierAnnotations;
          }
          // Shared-tree guard outcome (restored stash / unresolved revert /
          // ambiguous stashes) — visible on the row even when a restored
          // stash left the run otherwise green, so it's never silent.
          if (sharedTreeGuard) {
            s.jobs[i2].sharedTreeGuard = sharedTreeGuard;
          } else {
            delete s.jobs[i2].sharedTreeGuard;
          }
          delete s.jobs[i2].runtime;
          // Pre-run baseline no longer needed once this run has finalized —
          // its whole purpose (letting THIS finalize compute a truthful
          // delta) is done; a fresh one is captured at the next dispatch.
          delete s.jobs[i2].guardBaseline;
          delete s.jobs[i2].guardHeadBefore;
          // Leftover-attribution fields (PRD: capture+surface uncommitted
          // work on every terminal path, not just exit=0) — set for EVERY
          // terminal outcome above (completed/failed/needs_review alike),
          // not just the exit=0 commit-guard branch, so a bare `failed` row
          // is visually distinguishable from one that quietly left work
          // behind. newlyDirtyAll is null when git-status was unavailable
          // (non-git cwd) — applyLeftoverFields treats null like "nothing to
          // attribute" via its Array.isArray guard, same as an empty array.
          applyLeftoverFields(s.jobs[i2], newlyDirtyAll);

          if (isNotifiableTerminalStatus(effectiveStatus)) {
            terminalNotifySnapshot = { ...s.jobs[i2] };
          }
          if (effectiveStatus === 'completed') {
            newlyCompletedPrds.push({ slug: s.jobs[i2].slug, cwd: s.jobs[i2].cwd });
          }
          if (effectiveStatus === 'failed') {
            actuallyFailed = true;
            failedJobSnapshot = { ...s.jobs[i2] };
          } else if (effectiveStatus === 'needs_review') {
            // Snapshot for the RCA feedback hook (fired outside mutate(), below).
            // Every needs_review transition gets an RCA — including uncommitted_changes,
            // the least self-healing verdict — but never a rate-limit pause (that
            // takes the treatAsPending branch above and never reaches here).
            needsReviewRcaSnapshot = { ...s.jobs[i2] };

            // Resume-first recovery (PRD 1111): evaluated BEFORE the auto-fix
            // eligibility check below — a job whose verdict is
            // 'uncommitted_changes' with a live sessionId gets one bounded
            // `--resume` dispatch instead of a cold-read fix-plan
            // investigation. Snapshot only (no I/O inside mutate()); the
            // actual dispatch happens outside mutate(), below. Never sets
            // needsInvestigationNow — the two are mutually exclusive for the
            // same tick, mirroring the `else if` used outside mutate().
            const target = selectResumeRecoveryTarget(s.jobs[i2]);
            if (target) {
              resumeRecoveryJob = { ...s.jobs[i2] };
              resumeRecoveryTarget = target;
            } else {
            // Same-tick auto-fix (feedback 2026-07-12): rather than waiting up to
            // 10 min for reverifyNeedsReview()'s periodic pass, check right here
            // whether this job qualifies for auto-fix (same eligibility rule
            // reverifyNeedsReview uses via selectAutoFixTargets) and, if so, spawn
            // the investigation immediately. Stamp autoFixAttempted BEFORE the
            // investigation fires (mirrors reverifyNeedsReview's auto-fix section)
            // so the periodic pass 10 min later sees it already attempted and
            // does not spawn a duplicate.
            const fixSlugExists = (slug) => candidatePrdsDirs().some((dir) => fs.existsSync(path.join(dir, `${slug}.md`)));
            if (
              process.env.SM_AUTOFIX_DISABLE !== '1' &&
              isEligibleForImmediateAutoFix(s.jobs[i2], s.jobs, fixSlugExists)
            ) {
              const isRetryAttempt = s.jobs[i2].autoFixAttempted === true;
              s.jobs[i2].autoFixAttempted = true;
              if (!s.jobs[i2].runId) s.jobs[i2].runId = runId;
              if (isRetryAttempt) {
                s.jobs[i2].autoFixRetries = (s.jobs[i2].autoFixRetries ?? 0) + 1;
                delete s.jobs[i2].autoFixOutcome;
              }
              needsInvestigationNow = true;
              investigationJobSnapshot = { ...s.jobs[i2] };
            }
            }
          }
          // Auto-promote: when a fix-* PRD completes successfully, the original
          // failed PRD's work is logically done. Flip its status to 'completed'
          // so the cross-group failure gate in pickNextBatch releases. Without
          // this, the queue stalls indefinitely behind a stale failure even
          // though the auto-recovery did its job.
          if (effectiveStatus === 'completed' && isFixPlanSlug(job.slug)) {
            const orig = healTargetForFix(job.slug, s.jobs);
            if (orig) {
              const priorStatus = orig.status;
              console.log(`[scheduler] auto-promote: ${orig.slug} (${priorStatus}) → completed because ${job.slug} succeeded`);
              transitionJob(orig, 'completed', { reason: `auto-promoted: fix plan ${job.slug} succeeded`, source: 'spawnJob:auto-promote' });
              orig.exitCode = 0;
              orig.error = null;
              orig.completedBy = job.slug;
              delete orig.looksDone;
              if (priorStatus === 'needs_review') {
                delete orig.verifierVerdict;
              }
              newlyCompletedPrds.push({ slug: orig.slug, cwd: orig.cwd });
            }
          }
        }
      }
    });
    for (const { slug, cwd } of newlyCompletedPrds) {
      await archiveCompletedPrd(slug, cwd);
    }
    await broadcast({ flush: true });

    // Per-run outcome sidecar (issue #11 list B5): turns/tokens/verdict in one
    // small JSON next to the log so fleet health never needs a transcript parse.
    launchFailure.writeOutcomeSidecar(runDir, job.slug, {
      runId,
      exitCode: res.exitCode,
      durationMs: res.durationMs ?? null,
      numTurns: res.resultStats?.numTurns ?? null,
      outputTokens: res.resultStats?.outputTokens ?? null,
      totalCostUsd: res.resultStats?.totalCostUsd ?? null,
      verdict: verifyResult?.verdict ?? (res.exitCode === 0 ? 'clean' : null),
      status: terminalNotifySnapshot?.status ?? failedJobSnapshot?.status ?? null,
      terminalReason: terminalNotifySnapshot?.terminalReason ?? failedJobSnapshot?.terminalReason ?? null,
      launchFailure: null,
      launchEnvApplied: launchEnv ? Object.keys(launchEnv) : [],
      filesChanged: Array.isArray(newlyDirtyAll) ? newlyDirtyAll.length : null,
      landedCommit: jobLandedCommitThisRun ?? null,
    });

    if (terminalNotifySnapshot) {
      notifyOriginatingTab(terminalNotifySnapshot).catch((e) => {
        console.error('[scheduler] notifyOriginatingTab error', job.slug, e);
      });
    }

    if (needsReviewRcaSnapshot) {
      // Fire-and-forget, mirroring the DoD drain hook: never blocks the status
      // transition, never throws to this caller.
      writeRcaReport({
        job: needsReviewRcaSnapshot,
        runDir,
        verdict: needsReviewRcaSnapshot.verifierVerdict,
        annotations: needsReviewRcaSnapshot.verifierAnnotations,
      })
        .then(async (report) => {
          // Persist the classification onto the parked job row so the scheduler
          // can route on it (e.g. selectAutoFixTargets excluding 'archive')
          // without re-parsing the RCA markdown on every pass.
          await mutate((s) => {
            const j = s.jobs.find((x) => x.slug === needsReviewRcaSnapshot.slug);
            applyRcaClassification(j, report);
          }).catch(() => {});
          return notifyNeedsReview(needsReviewRcaSnapshot, report);
        })
        .catch((e) => {
          console.error('[scheduler] writeRcaReport error', job.slug, e);
        });
    }

    if (resumeRecoveryJob && resumeRecoveryTarget) {
      console.log(`[scheduler] needs_review ${job.slug} → resume-recovery (session ${resumeRecoveryTarget.sessionId}, ${resumeRecoveryTarget.dirtyPaths.length} dirty path(s))`);
      spawnResumeRecovery(resumeRecoveryJob, resumeRecoveryTarget).catch((e) => {
        console.error('[scheduler] spawnResumeRecovery error', job.slug, e);
      });
    }

    if (actuallyFailed && failedJobSnapshot) {
      // Transient-failure detector. A 143/137 exit is ALWAYS a signal kill — the
      // agent never self-exits with those — so the only question is WHO killed it.
      // The scheduler's own intentional kills before the idle watchdog are the
      // result-tail post-success kill (which maps back to exit 0, so it never
      // reaches here) and the rare supervisor kill-agent. The idle-output
      // watchdog only fires at IDLE_OUTPUT_KILL_MS (20 min) of stalled output,
      // and the deadman at 4 h. THEREFORE any 143/137 with a run shorter than the
      // idle threshold is an EXTERNAL/transient kill — an app restart (incl. our
      // own self-restart on publish/HMR — see feedback 2026-06-15-01), an
      // OOM-kill, or a manual kill — not a real failure. Re-queue it (bounded)
      // instead of marking it failed + spawning a spurious fix-plan. (Was 45 s,
      // which wrongly hard-failed externally-killed jobs like 115 SIGTERM'd at
      // 67 s.) Genuine watchdog kills (idle ≥20 min, deadman 4 h) run longer than
      // the threshold and still fall through to investigation.
      const ec = failedJobSnapshot.exitCode;
      const retries = failedJobSnapshot.transientRetries ?? 0;
      const maybeTransient = (ec === 143 || ec === 137) || res.networkError === true;
      // newlyDirtyAll was computed once, above, right after the try/finally —
      // reused here rather than re-querying git status a third time.
      const newlyDirtyCount = maybeTransient ? (newlyDirtyAll || []).length : 0;
      const dirtySample = maybeTransient ? (newlyDirtyAll || []).slice(0, 3).join(', ') : '';
      const decision = classifyFailureOutcome({
        exitCode: ec,
        networkError: res.networkError,
        durationMs: res.durationMs,
        transientRetries: retries,
        newlyDirtyCount,
      });

      if (decision.action === 'retry') {
        console.log(`[scheduler] transient failure (${decision.transientKind} dur=${res.durationMs}ms) — auto-retry ${decision.retries + 1}/${TRANSIENT_RETRY_CAP} for ${job.slug}`);
        await mutate((s) => {
          const i = s.jobs.findIndex((x) => x.slug === job.slug);
          if (i >= 0) {
            resetJobFields(s.jobs[i], null, { source: 'spawnJob:transient-retry' });
            s.jobs[i].transientRetries = decision.retries + 1;
          }
        });
        await broadcast({ flush: true });
      } else if (decision.action === 'fail-dirty') {
        const salvageNote = salvagePatch ? ` — recoverable from salvage patch ${salvagePatch}` : '';
        console.log(`[scheduler] transient failure (${decision.transientKind}) for ${job.slug} left ${newlyDirtyCount} uncommitted file(s) (e.g. ${dirtySample})${salvageNote} — not auto-requeuing`);
        await mutate((s) => {
          const i = s.jobs.findIndex((x) => x.slug === job.slug);
          if (i >= 0) {
            transitionJob(s.jobs[i], 'failed', { reason: `transient failure (${decision.transientKind}) left uncommitted work — not auto-requeued`, source: 'spawnJob:fail-dirty' });
            s.jobs[i].error = `transient failure (${decision.transientKind}) left ${newlyDirtyCount} uncommitted file(s) in working tree (e.g. ${dirtySample})${salvageNote} — not auto-requeued to avoid overwriting partial work; review and commit or discard manually`;
          }
        });
        await broadcast({ flush: true });
        // No auto-fix investigation: this isn't a code defect, and the
        // dirty tree needs a human, not a diagnosis run.
      } else if (decision.action === 'fail-cap') {
        // Retry cap exhausted: fail terminally, but a transient classification
        // never spawns an auto-fix investigation — there is no code defect to
        // diagnose, only a recurring outage.
        console.log(`[scheduler] transient failure (${decision.transientKind}) for ${job.slug} exhausted retry cap (${decision.retries}/${TRANSIENT_RETRY_CAP}) — failing without auto-fix`);
        await mutate((s) => {
          const i = s.jobs.findIndex((x) => x.slug === job.slug);
          if (i >= 0) {
            s.jobs[i].error = `transient failure (${decision.transientKind}) exhausted retry cap (${decision.retries}/${TRANSIENT_RETRY_CAP}) — marking failed without auto-fix investigation`;
          }
        });
        await broadcast({ flush: true });
      } else {
        spawnInvestigation(failedJobSnapshot, runDir).catch((e) => {
          console.error('[scheduler] spawnInvestigation error', job.slug, e);
        });
      }
    } else if (needsInvestigationNow && investigationJobSnapshot) {
      console.log(`[scheduler] needs_review ${job.slug} → immediate auto-fix investigation (not waiting for periodic reverify)`);
      spawnInvestigation(investigationJobSnapshot, runDir).catch((e) => {
        console.error('[scheduler] spawnInvestigation error', job.slug, e);
      });
    }
  } catch (e) {
    console.error('[scheduler] spawnJob error', job.slug, e);
  } finally {
    runningSet.delete(job.slug);
    // Slot release notifies subscribed pumps (chat lane) machine-wide.
    sessionSlots.release(slotToken);
    // Release the exclusive quiet-machine lease on EVERY exit path this
    // finally covers (normal exit, timeout, SIGTERM, crash) — see the
    // acquire-site comment above. Bounded: a lease this function never
    // acquired is simply a no-op release.
    if (quietLeaseAcquired) quietMachineLease.release(job.slug);
    // Each job completion is a signal to advance the queue.
    tickQueue().catch(() => {});
  }
}

/**
 * Dispatch a resume-recovery attempt (PRD 1111) for a job already found
 * eligible by selectResumeRecoveryTarget. Thin wrapper around spawnJob —
 * reuses its entire slot-acquire/worktree/verify/commit-guard/finalize
 * machinery unchanged, so a resume run that itself parks or fails falls
 * through to the SAME spawnInvestigation fallback any other run would, with
 * zero special-casing. `job` and `resumeTarget` must be snapshots taken
 * BEFORE this call (this function does no eligibility re-check — spawnJob's
 * own dispatch mutate is what stamps resumeRecoveryAttempted, atomically
 * with the 'running' transition).
 */
async function spawnResumeRecovery(job, resumeTarget) {
  const { runId, dir: runDir } = pickRunDir();
  await spawnJob(job, runId, runDir, job.cwd || DEFAULT_PROJECT_CWD, resumeTarget);
}

// Serialized ticker: prevents two concurrent tickQueue() calls from racing
// on the same pending jobs. A simple promise tail suffices since pickNextBatch
// is synchronous and spawnJob is fire-and-forget.
let tickTail = Promise.resolve();

// `bypassLoadGate` is set only by the explicit human run-now / force-tick
// paths (via runDueJobs): the human is asking, so the CPU-load gate yields
// and logs that it did. Every automatic caller leaves it false.
function tickQueue({ bypassLoadGate = false } = {}) {
  const next = tickTail.then(async () => {
    const state = await readQueue();
    // Never reconcile against an unreadable queue: reconcile() would see zero
    // job rows for every PRD on disk and resurrect the lot as 'pending'.
    if (state.unreadable) {
      console.error('[scheduler] tickQueue skipped: queue.json unreadable');
      return { fired: false, reason: 'unreadable' };
    }
    if (state.paused) {
      console.log('[scheduler] tickQueue skipped: paused');
      return recordTick({ fired: false, reason: 'paused' }, { detail: 'scheduler paused' });
    }
    if (cancelToken.cancelled) return { fired: false, reason: 'cancelled' };

    // The retired-flat-dir sweep now lives inside reconcile() itself (see its
    // own comment) so every caller of reconcile — not just this tick — gets
    // the guarantee.
    await reconcile(state);
    // Session-Manager's machine-wide slot pool is the ONLY concurrency limit
    // the picker answers to (plus the memory gate below). The scheduler used
    // to also carry a private `concurrencyCap` of 3 — the exact per-consumer
    // cap that sessionSlots.cjs was written to replace — which silently
    // ceilinged the queue at 3 while the pool the user configured said 5.
    const freeSlots = sessionSlots.available();
    const heldSlugs = await computeLaunchHolds(state);
    const { batch, reason: holdReason, holds } = pickNextBatch(state.jobs, runningSet, freeSlots, {
      leaseHeld: quietMachineLease.isHeld(),
      machineInUse: sessionSlots.inUse(),
      now: Date.now(),
      heldSlugs,
    });
    if (batch.length === 0 && freeSlots === 0) {
      const snap = sessionSlots.snapshot();
      const pendingCount = state.jobs.filter((j) => j.status === 'pending').length;
      console.log(`[scheduler] slot gate: 0 of ${snap.total} session slots free (${snap.holders.map((h) => h.owner).join(', ')}) — deferring ${pendingCount} pending job(s)`);
      return recordTick(
        { fired: false, reason: 'slots-exhausted', deferredCount: pendingCount, holders: snap.holders },
        { detail: `${snap.total} of ${snap.total} session slots busy (${snap.holders.map((h) => h.owner).join(', ')})`, holds },
      );
    }
    if (batch.length === 0) {
      // Queue drained — run the definition-of-done gate fire-and-forget.
      // Non-blocking: does not hold the mutate lock; errors are logged, not thrown.
      runDefinitionOfDoneOnDrain(state, { cancelToken }).catch((err) => {
        console.log(`[scheduler] dod-drain: ${err?.message ?? String(err)}`);
      });
      if (holdReason) return recordTick({ fired: false, reason: 'held', detail: holdReason }, { holds });
      // Distinguish "genuinely nothing to do" from "the batch was already
      // fired by a concurrent tickQueue() call" (e.g. the periodic
      // when-available poll winning a race against a manual force-tick —
      // pickNextBatch correctly returns reason:null in both cases since
      // neither is a hold; the caller-facing message needs to tell them
      // apart so "No pending jobs" doesn't read as wrong next to a job
      // that is visibly running).
      const runningCount = Math.max(
        runningSet.size,
        state.jobs.filter((j) => j.status === 'running').length,
      );
      if (runningCount > 0) {
        return recordTick({ fired: false, reason: 'already-running', runningCount }, { holds });
      }
      return recordTick({ fired: false, reason: 'drained' }, { holds });
    }

    const availableMb = getAvailableMemMb();
    // Reserve a fixed slice for the Electron host before the per-job gate, so a
    // job is never started into the host's own headroom (that path OOM-kills
    // Electron and SIGHUPs every pty — 2026-06-16 incident).
    const jobBudgetMb = availableForJobs(availableMb, RESERVED_HOST_MB);
    // The slot pool already bounded `batch` (it was passed as freeSlots to
    // pickNextBatch above), so only the memory gate can narrow it further.
    const allowed = memoryLimitedBatchSize(
      jobBudgetMb, MIN_FREE_MB_PER_JOB, runningSet.size, batch.length,
    );
    if (allowed === 0) {
      const threshold = RESERVED_HOST_MB + MIN_FREE_MB_PER_JOB * (runningSet.size + 1);
      console.log(`[scheduler] memory gate: available=${availableMb} MB < threshold=${threshold} MB (host reserve ${RESERVED_HOST_MB} + ${MIN_FREE_MB_PER_JOB}/job × ${runningSet.size + 1}) — deferring ${batch.length} job(s)`);
      lastMemGate = { availableMb, threshold, deferred: true, at: new Date().toISOString() };
      return recordTick(
        { fired: false, reason: 'memory-deferred', deferredCount: batch.length, availableMb, threshold },
        { detail: `memory gate: ${availableMb} MB free, need ${threshold} MB`, holds },
      );
    }
    const gatedBatch = batch.slice(0, allowed);
    if (gatedBatch.length < batch.length) {
      console.log(`[scheduler] memory gate: available=${availableMb} MB — clamped batch ${batch.length} → ${gatedBatch.length} (host reserve ${RESERVED_HOST_MB} + ${MIN_FREE_MB_PER_JOB}/job)`);
      lastMemGate = { availableMb, threshold: RESERVED_HOST_MB + MIN_FREE_MB_PER_JOB * (runningSet.size + gatedBatch.length), deferred: false, clamped: true, at: new Date().toISOString() };
    } else {
      // Ungated full batch: clear stale gate snapshot so status doesn't show
      // a stale deferral from a previous tick.
      lastMemGate = null;
    }

    // Load gate (PRD 1085) — the INNERMOST launch predicate, evaluated only
    // once every outer gate (sessionSlots pool → per-project cap inside
    // pickNextBatch → memory above) has already admitted `gatedBatch`. It
    // never touches running jobs and never becomes a second pool: it only
    // withholds this tick's launches while the 1-minute loadavg per core is
    // over LOAD_GATE_PER_CORE. An explicit human Run now bypasses it.
    const load = loadGate.evaluate({ bypass: bypassLoadGate });
    if (load.bypassed) {
      console.log(`[scheduler] load gate: BYPASSED by run-now (loadavg1=${load.loadavg1} cores=${load.cores} ratio=${load.ratio} > ${load.threshold})`);
    } else if (load.gated) {
      const line = `[scheduler] load gate: loadavg1=${load.loadavg1} cores=${load.cores} ratio=${load.ratio} > ${load.threshold} — holding ${gatedBatch.length} eligible job(s)`;
      if (load.escalate) {
        const top = topCpuConsumers(3);
        console.warn(`${line} for ${Math.round(load.gatedSinceMs / 60_000)}m; top CPU: ${top.length ? top.join(' | ') : 'n/a'}`);
      } else {
        console.log(line);
      }
      if (load.shouldAudit) {
        appendAuditEvent('launch_load_gated', {
          loadavg1: load.loadavg1, cores: load.cores, ratio: load.ratio, threshold: load.threshold,
          held: gatedBatch.map((j) => j.slug), gatedSinceMs: load.gatedSinceMs,
        });
      }
      return recordTick(
        { fired: false, reason: 'load-deferred', deferredCount: gatedBatch.length, ratio: load.ratio, threshold: load.threshold },
        { detail: `load gate: ${load.loadavg1} / ${load.cores} cores = ${load.ratio} > ${load.threshold}`, holds },
      );
    }

    await mutate((s) => { s.lastRunAt = new Date().toISOString(); });
    await broadcast();

    const { runId, dir: runDir } = pickRunDir();
    for (const job of gatedBatch) {
      if (cancelToken.cancelled) break;
      // spawnJob is fire-and-forget; it calls tickQueue() on completion.
      spawnJob(job, runId, runDir, state.config.defaultCwd).catch(() => {});
    }
    return recordTick({ fired: true, count: gatedBatch.length, group: gatedBatch[0]?.parallelGroup }, { holds });
  });
  tickTail = next.catch(() => {});
  return next;
}

// Translates a tickQueue()/runDueJobs() outcome descriptor into a renderer-facing
// ActionOutcome for the schedule:force-tick IPC handler.
function forceTickOutcome(result) {
  if (!result) return { ok: true, kind: 'info', message: 'No pending jobs' };
  if (result.fired) {
    const groupSuffix = result.group !== undefined ? ` (group g${result.group})` : '';
    return { ok: true, kind: 'info', message: `Fired ${result.count} job(s)${groupSuffix}` };
  }
  switch (result.reason) {
    case 'drained':
      return { ok: true, kind: 'info', message: 'No pending jobs' };
    case 'already-running':
      return { ok: true, kind: 'info', message: `Already running — ${result.runningCount} job(s) in flight` };
    case 'paused':
      return { ok: true, kind: 'warn', message: 'Scheduler is paused' };
    case 'unreadable':
      return { ok: false, kind: 'error', message: 'queue.json is unreadable — scheduling halted; a .corrupt-<ts> copy was saved next to it' };
    case 'cancelled':
      return { ok: true, kind: 'warn', message: 'Batch cancelled — try again' };
    case 'memory-deferred':
      return { ok: true, kind: 'warn', message: `Deferred ${result.deferredCount} job(s) — low memory (${result.availableMb} MB available, need ${result.threshold} MB)` };
    case 'slots-exhausted':
      return { ok: true, kind: 'warn', message: `Deferred ${result.deferredCount} job(s) — all session slots in use (${(result.holders ?? []).map((h) => h.owner).join(', ')})` };
    case 'held': {
      const detail = String(result.detail ?? '').replace(/^\[scheduler\]\s*[\w-]+\s*(?:\[[^\]]*\])?:\s*/, '');
      return { ok: true, kind: 'warn', message: detail || 'Batch held' };
    }
    default:
      return { ok: true, kind: 'info', message: 'No pending jobs' };
  }
}

async function runDueJobs({ bypassLoadGate = false } = {}) {
  const state = await readQueue();
  if (state.unreadable) {
    console.error('[scheduler] runDueJobs skipped: queue.json unreadable');
    return { fired: false, reason: 'unreadable' };
  }
  if (state.paused) {
    console.log('[scheduler] runDueJobs skipped: paused');
    return { fired: false, reason: 'paused' };
  }
  cancelToken = { cancelled: false };
  const result = await tickQueue({ bypassLoadGate });
  // Clear the one-shot scheduledFor without waiting for jobs to settle.
  await mutate((s) => { s.scheduledFor = null; });
  await broadcast();
  return result;
}

// ---------- when-available launch logic ----------

async function maybeLaunchWhenAvailable(state) {
  if (state.config.firePolicy !== 'when-available') return;
  if (state.paused) return;
  const pending = state.jobs.filter((j) => j.status === 'pending' && !runningSet.has(j.slug));
  if (pending.length === 0) return;
  if (cachedUtilization === null || cachedUtilization === undefined) return;
  if (cachedUtilization >= state.config.utilizationThreshold) {
    await broadcast();
    return;
  }
  console.log(`[scheduler] when-available: util=${cachedUtilization}%, ${pending.length} pending, ${runningSet.size} running — ticking`);
  tickQueue().catch((e) => console.error('[scheduler] tickQueue error', e));
}

/** How long a queue may hold ready work with nothing running before the
 *  starvation watchdog forces a tick. Deliberately longer than the poll
 *  loop's own cadence + backoff, so this only ever fires when the normal
 *  path has genuinely stopped driving the queue — it is a safety net, not a
 *  second scheduler. */
const QUEUE_STARVATION_MS = 10 * 60_000;

/**
 * classifyQueueStarvation({ jobs, paused, runningCount, lastRunAtMs, now, thresholdMs })
 *   → null | { kind: 'starved' | 'blocked', pending, dispatchable, blockedChains, idleMs }
 *
 * Pure, no IO. Answers the one question the user's invariant reduces to:
 * "there are PRDs in a queue — is anything actually going to run them?"
 *
 * Every stall this codebase has seen was a DIFFERENT cause with the SAME
 * shape: ready rows, nothing running, nobody ticking. A rate-limited exit
 * stamped terminal `failed` (2026-09-05, 42 rows); a spin loop past the
 * manual-clear cooldown; a worktree merge-back that left the project on a
 * job branch; a job parked `needs_review` with no fix plan; app churn
 * counted as unfinished work. Guarding each cause individually will always
 * lag the next one, so this guards the SHAPE instead.
 *
 * Two outcomes, deliberately distinguished — they need opposite responses:
 *   'starved' — at least one pending row is dispatchable RIGHT NOW and
 *               nothing is running. Whatever should have ticked, didn't.
 *               Forcing a tick is safe and fixes it.
 *   'blocked' — every pending row is behind a terminal/parked dependency.
 *               A tick cannot help; this needs a human (or a heal pass) to
 *               resolve the blocker, and must be reported as such rather
 *               than silently re-ticking forever.
 *
 * Returns null when the queue is healthy (work running, nothing pending,
 * paused on purpose, or simply not idle long enough yet).
 */
function classifyQueueStarvation({ jobs, paused, runningCount, lastRunAtMs, now, thresholdMs = QUEUE_STARVATION_MS } = {}) {
  if (paused) return null;                      // paused is a DECISION, not a stall
  if (runningCount > 0) return null;            // work is flowing
  const rows = Array.isArray(jobs) ? jobs : [];
  const pending = rows.filter((j) => j && j.status === 'pending');
  if (pending.length === 0) return null;        // nothing to run — not a stall

  const idleMs = Number.isFinite(lastRunAtMs) ? now - lastRunAtMs : Infinity;
  if (idleMs < thresholdMs) return null;        // give the normal path its chance first

  // Which pending rows could actually dispatch? Anything NOT named by a
  // blocked chain. computeBlockedChains already walks dependsOn with the
  // picker's own resolution, so the two can never disagree.
  const blockedChains = computeBlockedChains(rows);
  const blockedTotal = blockedChains.reduce((n, c) => n + c.blocked, 0);
  const dispatchable = pending.length - blockedTotal;

  return {
    kind: dispatchable > 0 ? 'starved' : 'blocked',
    pending: pending.length,
    dispatchable,
    blockedChains,
    idleMs,
  };
}

/**
 * The watchdog half: acts on classifyQueueStarvation. Called from the
 * heartbeat, which already runs on its own timer independent of the billing
 * poll loop — so a wedged or never-succeeding poll (the /api/oauth/usage
 * endpoint was itself 429ing all of 2026-09-05) can no longer leave a queue
 * with ready work idle indefinitely.
 */
async function runQueueStarvationWatchdog(state, { now = Date.now(), thresholdMs = QUEUE_STARVATION_MS } = {}) {
  const verdict = classifyQueueStarvation({
    jobs: state?.jobs,
    paused: state?.paused,
    runningCount: runningSet.size,
    lastRunAtMs: Date.parse(state?.lastRunAt ?? ''),
    now,
    thresholdMs,
  });
  if (!verdict) return null;

  const mins = Math.round(verdict.idleMs / 60_000);
  if (verdict.kind === 'blocked') {
    console.warn(
      `[scheduler] QUEUE BLOCKED: ${verdict.pending} pending job(s), 0 running, idle ${mins}m — every ready row is behind a `
      + `terminal or parked dependency, so ticking cannot help. Blockers: `
      + verdict.blockedChains.map((c) => `${c.cwd} [${c.blockedBy.join(', ')}]`).join(' · '),
    );
    appendAuditEvent('queue_blocked_stall', { pending: verdict.pending, idleMs: verdict.idleMs, chains: verdict.blockedChains });
    return verdict;
  }

  console.warn(
    `[scheduler] QUEUE STARVED: ${verdict.dispatchable} dispatchable job(s) of ${verdict.pending} pending, 0 running, `
    + `idle ${mins}m (>= ${Math.round(thresholdMs / 60_000)}m) — forcing a tick`,
  );
  appendAuditEvent('queue_starvation_forced_tick', { pending: verdict.pending, dispatchable: verdict.dispatchable, idleMs: verdict.idleMs });
  // A never-populated utilization reading is itself one of the ways the
  // when-available path silently never fires (maybeLaunchWhenAvailable
  // returns early on null). Treat unknown as safe here, exactly as the
  // billing meter's own 429 fallback already does.
  if (cachedUtilization === null || cachedUtilization === undefined) cachedUtilization = 0;
  await tickQueue({ bypassLoadGate: false }).catch((e) => console.error('[scheduler] starvation tick error', e));
  return verdict;
}

// ---------- dead-process reaper ----------

// Queue-health sweep cadence: hangs off reapDeadRunningJobs's own cycle
// counter (it already runs once per poll tick) rather than a second timer,
// so its cadence can never drift from the poll cadence or double-fire
// across a backoff reset.
let queueHealthSweepCycle = 0;
const QUEUE_HEALTH_SWEEP_EVERY_N_CYCLES = 20;

/**
 * runQueueHealthSweep(jobs) — read-only reporting pass over the queue
 * snapshot reapDeadRunningJobs already read this cycle. Never transitions a
 * job, never archives a PRD, never spawns anything; only logs and appends
 * an audit event for any project with drift worth a human glance.
 */
function runQueueHealthSweep(jobs) {
  try {
    for (const { cwd, neverRan, looksDone, stuck } of computeQueueHealth(jobs)) {
      console.log(`[scheduler] queue-health ${cwd}: ${neverRan} never_ran, ${looksDone} looks-done, ${stuck} stuck`);
      appendAuditEvent('scheduler_queue_health', { cwd, neverRan, looksDone, stuck });
    }
  } catch (e) {
    console.warn('[scheduler] queue-health sweep error', e?.message);
  }
}

/**
 * Scan running jobs, identify those whose claude process is provably dead OR
 * whose spawn never got far enough to record a runtime.pid in the first
 * place, and finalize them to completed/failed by reading the run log.
 * Called once per poll cycle. A job whose pid is alive (claudePidAlive) is
 * always skipped. A pidless job younger than PIDLESS_SPAWN_GRACE_MS is
 * skipped too (spawn may still be mid-flight) — see selectReapableJobs for
 * the full predicate. Exported so unit tests can invoke it directly.
 */
async function reapDeadRunningJobs() {
  try {
    // Do NOT gate on runningSet: spawnJob()'s finally block unconditionally
    // deletes a job's slug from runningSet even when the preceding completion
    // mutate() threw and was swallowed, leaving queue.json stuck at
    // status:"running" with no slug left in runningSet to trigger reconciliation.
    // queue.json is the source of truth for which jobs are actually running.
    const state = await readQueue();
    const { reapable, warnings } = selectReapableJobs(state.jobs, Date.now(), {
      pidAlive: claudePidAlive,
      grace: PIDLESS_SPAWN_GRACE_MS,
    });
    for (const w of warnings) {
      console.warn(`[scheduler] reapDeadRunningJobs: ${w.reason} slug=${w.slug} — leaving row alone`);
    }

    const dead = [];
    for (const { slug, pid, pidless, reason } of reapable) {
      const j = state.jobs.find((x) => x.slug === slug);
      const logPath = j?.runId
        ? path.join(RUNS_DIR, j.runId, `${j.slug}.log`)
        : null;
      // Absent/empty run dir → classifyRunOutcome finds no result event →
      // 'no_result' → non-success below → filed as failed, never completed.
      const outcome = logPath ? classifyRunOutcome(logPath) : 'unknown';
      // A pidless reap means the spawn never got far enough to record a
      // pid — the gate could not possibly have run, regardless of what
      // classifyRunOutcome makes of an absent/empty log.
      const gateOutcome = pidless ? 'never_ran' : mapOutcomeToGateOutcome(outcome);
      dead.push({ slug, pid, outcome, gateOutcome, pidless, reason });
    }

    queueHealthSweepCycle += 1;
    if (queueHealthSweepCycle % QUEUE_HEALTH_SWEEP_EVERY_N_CYCLES === 0) {
      runQueueHealthSweep(state.jobs);
    }

    if (dead.length === 0) return;

    // A rate-limited death is retryable, not terminal — mirror spawnJob's own
    // live-process handling (PRD 1117) exactly: engage the SAME setPaused
    // pause here too. Skipping this would reset the row to 'pending' but
    // leave dispatch unpaused, so the next tick immediately re-fires it into
    // the same still-active rate limit — the spin loop this PRD exists to
    // stop. Done once, outside mutate(), before finalizing any row below.
    if (dead.some((d) => d.outcome === 'rate_limited')) {
      const resetIso = await refreshNextReset().catch(() => cachedNextReset);
      const triggering = dead.find((d) => d.outcome === 'rate_limited');
      const triggeringRow = triggering ? state.jobs.find((x) => x.slug === triggering.slug) : null;
      const observedAtMs = triggeringRow?.startedAt ? Date.parse(triggeringRow.startedAt) : null;
      // Same rapid-repeat circuit breaker spawnJob's own res.rateLimited
      // branch drives (see consecutiveRapidRateLimitsBySlug above) — a
      // process that gets rate-limited and then dies without spawnJob's own
      // branch ever running is reconciled HERE instead, and must feed the
      // same counter or a stale/wrong resumeAt could keep re-clearing this
      // path's "fresh" pause every reap cycle with no hard cap ever engaging.
      const durationMs = Number.isFinite(observedAtMs) ? Date.now() - observedAtMs : Infinity;
      const prevCount = consecutiveRapidRateLimitsBySlug.get(triggering.slug) || 0;
      const nextCount = nextRapidRateLimitCount(prevCount, { rateLimited: true, durationMs });
      consecutiveRapidRateLimitsBySlug.set(triggering.slug, nextCount);
      const forceHardPause = nextCount >= CONSECUTIVE_RAPID_RATE_LIMIT_THRESHOLD;
      if (forceHardPause) {
        console.log(`[scheduler] ${triggering.slug}: ${nextCount} consecutive rate-limited dispatches under ${RAPID_RATE_LIMIT_WINDOW_MS / 1000}s each (reaped) — engaging hard pause`);
      }
      await setPaused('rate_limit', resetIso, { observedAt: observedAtMs, force: forceHardPause });
    }

    await mutate(async (s) => {
      for (const { slug, pid, outcome, gateOutcome, pidless, reason } of dead) {
        const idx = s.jobs.findIndex((x) => x.slug === slug);
        if (idx < 0 || s.jobs[idx].status !== 'running') continue; // race guard
        const rateLimited = outcome === 'rate_limited';
        const success = outcome === 'success';
        if (!rateLimited) consecutiveRapidRateLimitsBySlug.delete(slug);

        // Best-effort in-place leftover computation: a job whose owning
        // process vanished without spawnJob()'s own finally block ever
        // running (the exact case this reaper exists for) never got that
        // block's salvage OR leftover-attribution pass either. Only
        // attempted when the row carries a persisted pre-run baseline
        // (guardBaseline, persisted by spawnJob at dispatch — see there).
        // With no baseline there is no safe way to tell this job's own dirt
        // from a human's or a sibling's pre-existing WIP, so this skips
        // rather than ever dumping/attributing the whole tree.
        let deltaPaths = null;
        if (Array.isArray(s.jobs[idx].guardBaseline) && s.jobs[idx].runId) {
          try {
            const rowCwd = s.jobs[idx].cwd || s.config?.defaultCwd || DEFAULT_PROJECT_CWD;
            const after = await uncommittedChanges(rowCwd);
            if (after) {
              const baseSet = new Set(s.jobs[idx].guardBaseline);
              deltaPaths = after.filter((p) => !baseSet.has(p));
              if (deltaPaths.length) {
                const salvagePath = path.join(RUNS_DIR, s.jobs[idx].runId, `${slug}.uncommitted.patch`);
                const salvage = await jobWorktree.salvageJobDirtyDelta({ cwd: rowCwd, paths: deltaPaths, outFile: salvagePath });
                if (salvage && salvage.ok) {
                  s.jobs[idx].salvagePatch = salvagePath;
                  console.log(`[scheduler] reapDeadRunningJobs: salvaged ${salvage.bytes} byte(s) of uncommitted in-place diff for ${slug} to ${salvagePath}`);
                }
              }
            }
          } catch (e) {
            console.error(`[scheduler] reapDeadRunningJobs: in-place salvage failed for ${slug}`, e);
          }
        }
        const leftoverSuffix = deltaPaths && deltaPaths.length
          ? ` — left ${deltaPaths.length} files uncommitted`
          : '';
        const transitionReason = rateLimited
          ? `reaped: rate limit detected — reset to pending, not failed (outcome=${outcome})${leftoverSuffix}`
          : (pidless ? reason : `reaped: process gone (outcome=${outcome})`) + leftoverSuffix;

        if (rateLimited) {
          // Retryable, never terminal (PRD 1117) — same resetJobFields path
          // spawnJob's own rateLimited branch uses (see ~4797's
          // treatAsPending), so the row comes back exactly like any other
          // paused-for-rate-limit reset: fresh runId/startedAt/exitCode.
          resetJobFields(s.jobs[idx], transitionReason, { source: 'reapDeadRunningJobs:rate-limit' });
        } else {
          transitionJob(s.jobs[idx], success ? 'completed' : 'failed', { reason: transitionReason, source: 'reapDeadRunningJobs' });
          s.jobs[idx].exitCode = success ? 0 : (s.jobs[idx].exitCode ?? 1);
          s.jobs[idx].finishedAt = new Date().toISOString();
          s.jobs[idx].error = success ? null : `${transitionReason} (outcome=${outcome})`;
          s.jobs[idx].gateOutcome = gateOutcome;
        }
        delete s.jobs[idx].runtime;
        delete s.jobs[idx].guardBaseline;
        delete s.jobs[idx].guardHeadBefore;
        applyLeftoverFields(s.jobs[idx], deltaPaths);
        runningSet.delete(slug);
        // A dead job reaped here never reached spawnJob's own finally block
        // (that's this reaper's whole reason to exist — see its header
        // comment) — so if it held the quiet-machine lease, spawnJob never
        // got the chance to release it. Release it here too, or a
        // quietMachine job whose process silently vanished (OOM, a crash
        // with no exit event) wedges the lease held forever and stalls
        // dispatch for every project until the app restarts.
        if (s.jobs[idx].quietMachine === true) quietMachineLease.release(slug);
        if (rateLimited) {
          console.log(`[scheduler] reaped rate-limited job slug=${slug} — reset to pending, pause engaged`);
          appendAuditEvent('job_reaped_rate_limited', { slug, cwd: s.jobs[idx].cwd ?? null });
        } else if (pidless) {
          console.log(`[scheduler] reaped pidless zombie job slug=${slug} outcome=${outcome}`);
          appendAuditEvent('job_reaped_pidless', { slug, cwd: s.jobs[idx].cwd ?? null, outcome, graceMs: PIDLESS_SPAWN_GRACE_MS });
        } else {
          console.log(`[scheduler] reaped dead job slug=${slug} pid=${pid} outcome=${outcome}`);
        }
      }
    });

    await broadcast({ flush: true });
    tickQueue().catch(() => {});
  } catch (e) {
    console.warn('[scheduler] reapDeadRunningJobs error', e?.message);
  }
}

// ---------- poll loop with exponential backoff ----------

/**
 * Pure: given the current pause reason and whether a reset timestamp is cached,
 * return which clearPause source to pass after a successful billing poll, or null.
 * Exported for unit testing.
 */
function pollRecoveryClearSource(pauseReason, hasCachedReset) {
  if (pauseReason === 'network') return 'network-recovered';
  if (pauseReason === 'auth') return 'auth-recovered';
  if (pauseReason === 'reset_failure' && hasCachedReset) return 'reset-recovered';
  return null;
}

async function pollLoop() {
  try {
    await reapDeadRunningJobs().catch(() => {});

    // Enterprise auth (Bedrock / Vertex / API-key / corporate gateway): there is
    // no consumer 5-hour usage meter to poll. Don't hit an endpoint that will
    // 404/time-out and eventually pause the queue on 'network' — treat usage as
    // wide-open and fire on pending + memory alone. (Blackrock-style machines.)
    if (!billing.usageMeterApplicable()) {
      cachedUtilization = 0;
      consecutiveFailures = 0;
      backoffMs = 0;
      backoffNextAt = null;
      firstFailureAt = null;
      firstNon429FailureAt = null;
      lastFailureKind = null;
      lastPollAt = Date.now();
      lastPollOk = true;
      persistSchedulerState();
      let cur = await readQueue();
      // Clear a stale auth/network pause inherited from a prior consumer-auth
      // session so the queue isn't wedged. Never clears rate_limit/manual.
      if (cur.paused && (cur.paused.reason === 'auth' || cur.paused.reason === 'network')) {
        await clearPause('enterprise-auth');
        cur = await readQueue(); // re-read so the cleared pause is visible to launch THIS cycle
      }
      await maybeLaunchWhenAvailable(cur);
      await broadcast();
      return; // finally re-arms the timer
    }

    const r = await billing.fetchUsage();

    if (r.kind === 'ok') {
      cachedNextReset = r.data?.usage?.five_hour?.resets_at ?? cachedNextReset;
      cachedUtilization = r.data?.usage?.five_hour?.utilization ?? cachedUtilization;
      consecutiveFailures = 0;
      backoffMs = 0;
      backoffNextAt = null;
      firstFailureAt = null;
      firstNon429FailureAt = null;
      lastFailureKind = null;
      lastPollAt = Date.now();
      lastPollOk = true;
      persistSchedulerState();

      // Clear any pause that was waiting for a successful billing read.
      let cur = await readQueue();
      const clearSrc = pollRecoveryClearSource(cur.paused?.reason ?? null, !!cachedNextReset);
      if (clearSrc) {
        await clearPause(clearSrc);
        cur = await readQueue(); // re-read so the cleared pause launches work THIS cycle
      }

      await maybeLaunchWhenAvailable(cur);
      await broadcast();
    } else if (r.kind === 'meter_rate_limited') {
      // Billing meter is itself being rate-limited. Treat as "utilization unknown but safe":
      // fire available jobs anyway at utilization=0 rather than pausing the queue.
      lastPollAt = Date.now();
      lastPollOk = false;
      consecutiveFailures++;
      lastFailureKind = 'meter_rate_limited';
      // Don't update firstNon429FailureAt — 429s don't count toward the 30-min network-pause threshold.
      cachedUtilization = 0; // assume safe; fire any pending work
      console.log(`[scheduler] billing meter rate-limited (HTTP 429) — firing on heuristic (failure #${consecutiveFailures})`);
      const cur = await readQueue();
      await maybeLaunchWhenAvailable(cur);
      await broadcast();
    } else {
      lastPollAt = Date.now();
      lastPollOk = false;
      consecutiveFailures++;
      if (!firstFailureAt) firstFailureAt = Date.now();

      if (r.kind === 'auth') {
        lastFailureKind = 'auth';
        console.error(`[scheduler] auth failure (HTTP ${r.httpStatus}): ${r.message}`);
        await setPaused('auth', null);
      } else {
        // transient or config — apply exponential backoff and count toward 30-min threshold.
        lastFailureKind = 'transient';
        if (!firstNon429FailureAt) firstNon429FailureAt = Date.now();
        backoffMs = backoffMs ? Math.min(backoffMs * 2, 480_000) : 30_000;
        const totalNon429FailureMs = Date.now() - firstNon429FailureAt;
        console.log(`[scheduler] transient failure #${consecutiveFailures}: ${r.kind} ${r.message ?? ''}; retry in ${backoffMs / 1000}s`);

        // After 30 minutes of consecutive non-429 failures, set 'network' pause.
        if (totalNon429FailureMs > 30 * 60_000) {
          const cur2 = await readQueue();
          if (!cur2.paused || cur2.paused.reason === 'network') {
            await setPaused('network', null);
          }
        }
      }

      backoffNextAt = Date.now() + backoffMs;
      persistSchedulerState();
    }
  } catch (e) {
    // Unexpected error (e.g., IPC transport failure)
    lastPollAt = Date.now();
    lastPollOk = false;
    consecutiveFailures++;
    lastFailureKind = 'transient';
    if (!firstFailureAt) firstFailureAt = Date.now();
    if (!firstNon429FailureAt) firstNon429FailureAt = Date.now();
    backoffMs = backoffMs ? Math.min(backoffMs * 2, 480_000) : 30_000;
    backoffNextAt = Date.now() + backoffMs;
    persistSchedulerState();
  } finally {
    const delay = backoffMs || POLL_INTERVAL_MS;
    pollLoopTimer = setTimeout(() => { pollLoop().catch(() => {}); }, delay);
    if (pollLoopTimer.unref) pollLoopTimer.unref();
  }
}

// ---------- IPC ----------

// Pure helper: filter to completed/failed, merge with archived history
// entries (now that terminal jobs age out of jobs[] into history.jsonl —
// see queueHistory.cjs), dedupe by slug+runId (jobs[] wins on overlap —
// it's the fresher copy in the append-before-drop crash window), sort
// newest-finished first, cap to limit clamped to [1, 500] (default 50).
// O(n log n) on queue+history size (small at any realistic scale).
// Exported for unit testing. `historyEntries` defaults to [] so existing
// callers/tests that only pass `jobs` are unaffected.
function selectHistoryJobs(jobs, limit, historyEntries = []) {
  const cap = Math.max(1, Math.min(500, Number.isFinite(limit) ? Math.floor(limit) : 50));
  const hot = (Array.isArray(jobs) ? jobs : []).filter((j) => j && (j.status === 'completed' || j.status === 'failed' || j.status === 'skipped'));
  const seen = new Set(hot.map((j) => `${j.slug}|${j.runId ?? ''}`));
  const archived = (Array.isArray(historyEntries) ? historyEntries : []).filter((j) => {
    if (!j) return false;
    const key = `${j.slug}|${j.runId ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return [...hot, ...archived]
    .sort((a, b) => {
      const at = a.finishedAt ? Date.parse(a.finishedAt) : 0;
      const bt = b.finishedAt ? Date.parse(b.finishedAt) : 0;
      return bt - at;
    })
    .slice(0, cap);
}

// Transcript-scan verdicts that re-running verifyRun can re-evaluate. NOT
// 'uncommitted_changes' — that comes from the git commit-guard, which verifyRun
// does not inspect, so re-scanning it would always return 'clean' and wrongly
// heal a genuinely-unfinished job. 'no_verdict_sentinel' is included because
// its raising condition (sentinel === null && !committedDuringRun) depends on
// commit-detection, which committedInWindow() can fix retroactively (e.g. the
// git-log --all scan added for missed non-HEAD commits) — rescanning lets a
// job whose commit is now correctly detected clear on its own instead of
// staying stuck in needs_review forever. 'pass_no_commit' is included because
// verifyRun now exempts fix-plan jobs (slug ^\d+-fix-) from that check — a
// fix-plan job flagged before that exemption shipped gets a genuinely
// different verdict on rescan (2026-07-12: false-positive cascade where
// investigation jobs correctly found "nothing to fix" but were flagged
// anyway). For non-fix-plan jobs the exemption never applies, so rescanning
// their pass_no_commit verdict is a harmless no-op (same facts, same verdict).
const RESCANNABLE_VERDICTS = new Set(['transcript_errors', 'verify_unavailable', 'no_verdict_sentinel', 'abandoned_background_task', 'pass_no_commit', 'pass_no_commit_already_shipped']);

// Bounds fix-plan recursion: cap N permits at most N+1 fix jobs per original
// slug (depth 1 = the original job, depth 2 = its `-fix`, depth 3+ is
// excluded). With N=1 that's `<slug>-fix` and `<slug>-fix-fix`, never a third
// `-fix-fix-fix`. Lowered from 2 to 1 on 2026-08-31 (starry-night-ships):
// three concurrent chains (115-fix-fix, 113-fix-fix, 111-fix-fix-fix) were
// riding the old cap, and 115-fix-fix's own root-cause section read "The
// code was already CORRECT. Only verification and commit failed." — a third
// auto-retry re-runs an entire PRD and test battery to redo a `git commit`,
// at near-zero marginal success probability. Shared by selectAutoFixTargets
// and spawnInvestigation so both call sites agree on one threshold.
const MAX_INVESTIGATION_DEPTH = 1;

/**
 * True when a fix-plan job's investigationDepth is at or past the recursion
 * cap and it must be excluded from auto-fix eligibility. A fix-plan job with
 * no recorded investigationDepth (a job already in the queue before this
 * depth tracking shipped) is treated as excluded too, preserving the
 * pre-existing blanket-exclusion behavior for legacy jobs — no retroactive
 * migration. Non-fix-plan slugs are never capped here. Exported for tests.
 */
function isFixPlanBeyondDepthCap(slug, investigationDepth) {
  if (!isFixPlanSlug(slug)) return false;
  if (investigationDepth == null) return true;
  return investigationDepth >= MAX_INVESTIGATION_DEPTH + 1;
}

/**
 * Backfill a job's missing runId by scanning RUNS_DIR for a run directory
 * whose contents reference this job's slug (a '<slug>.log' file inside it).
 * A needs_review job can lose its runId (e.g. an old queue-schema gap) and
 * become invisible to every auto-resolution path that requires job.runId
 * truthy. O(number of run dirs) — a single readdir + per-dir existsSync
 * check, no nested loop over user-scaled data. Dir names are ISO timestamps,
 * so lexical-descending sort picks the newest match. Exported for tests.
 */
function resolveRunId(job, { runsDir = RUNS_DIR } = {}) {
  if (!job || job.runId) return job?.runId || null;
  if (!job.slug) return null;
  let dirs;
  try {
    dirs = fs.readdirSync(runsDir);
  } catch {
    return null;
  }
  const matches = dirs.filter((d) => {
    try {
      return fs.existsSync(path.join(runsDir, d, `${job.slug}.log`));
    } catch {
      return false;
    }
  });
  if (!matches.length) return null;
  matches.sort().reverse();
  return matches[0];
}

/**
 * Pure predicate: a needs_review job with no runId and no backfillable run
 * directory can never self-heal or get an auto-fix investigation — it must
 * be surfaced for a human rather than silently dead-ended. Exported for
 * tests.
 */
function isUnresolvableNeedsReview(job, { hasRunDir }) {
  return !!job && job.status === 'needs_review' && !job.runId && !hasRunDir;
}

/**
 * Pure predicate: an auto-fix attempt whose one bounded retry is already
 * spent, and whose outcome was NOT 'plan' (a produced plan is judged by
 * isPlanUnqueued instead — a plan is never retried, only annotated if it
 * never reaches the queue). Covers all three exhaustible outcomes
 * ('no-plan', 'error', and unstamped/undefined) — mirrors the retry
 * eligibility rule in selectAutoFixTargets so a job can never be retry-
 * eligible there and simultaneously un-annotatable here.
 */
function isExhaustedAutoFix(job) {
  return !!job && job.status === 'needs_review'
    && job.autoFixAttempted === true
    && job.autoFixOutcome !== 'plan'
    && (job.autoFixRetries ?? 0) >= 1;
}

/**
 * Pure predicate: an investigation produced a fix plan (autoFixOutcome ===
 * 'plan') but its fix-plan slug is not present among `queuedSlugs` — the
 * plan file failed to become a queue row (write failure, or some other
 * reason reconcile() never ingested it). `queuedSlugs` is the caller's
 * current job-slug set, passed in rather than read here so this stays pure.
 */
function isPlanUnqueued(job, queuedSlugs) {
  if (!job || job.status !== 'needs_review') return false;
  if (job.autoFixOutcome !== 'plan') return false;
  return !queuedSlugs.has(fixSlugFor(job));
}

/**
 * Pure predicate: is this job eligible for the boot re-verify self-heal? Only
 * needs_review jobs with a run log (own or backfilled via resolveRunId) AND a
 * transcript-scan verdict. Crucially EXCLUDES 'uncommitted_changes' (git
 * commit-guard) — verifyRun can't see git, so re-scanning it would falsely
 * heal an unfinished job. Exported for tests.
 */
/**
 * healRefusalReason(job, verdict, committedDuringRun) → string | null
 *
 * Guards reverifyNeedsReview's needs_review → completed self-heal. Returns a
 * refusal reason when the heal must NOT happen, or null to allow it.
 *
 * THE INCIDENT (PRD 983, 2026-08-03). Job 972 ran 34 s, edited zero files and
 * exited 0. verifyRun correctly raised `no_verdict_sentinel` (no commit AND no
 * SCHEDULER_VERDICT sentinel) with downgradeTo 'needs_review', and the job was
 * parked. One minute later this self-heal pass promoted it to `completed`, and
 * that false green shipped to the user.
 *
 * The mechanism is subtle and worth spelling out, because the individual parts
 * all look correct: `no_verdict_sentinel` is in RESCANNABLE_VERDICTS, so the
 * job was re-verified. The rescan recomputes `committedDuringRun` via
 * `committedInWindow`, which runs `git log --all --since=<startedAt>
 * --until=<finishedAt+60s>` with NO author, message, or slug filter — it
 * answers "did ANY commit land in this repo during that window", not "did THIS
 * job commit". With up to 3 concurrent scheduler jobs plus interactive
 * sessions sharing one repo, a sibling job's commit lands inside the window
 * routinely. `committedDuringRun` therefore flipped to true on the rescan,
 * runVerify's `if (sentinel === null && !committedDuringRun)` no longer fired,
 * `no_verdict_sentinel` was never re-raised, the issue list came back empty,
 * and the verdict concluded `clean` — a COMPLETED_EQUIVALENT verdict, so the
 * job healed. Another job's commit was silently credited to this one.
 *
 * The rule: a run that emitted no sentinel and landed no commit ATTRIBUTABLE
 * TO ITSELF has produced no evidence it did anything, and repo-wide
 * time-window evidence is not attribution. `landedCommit` is per-job and
 * survives a resetJob (resetJobFields), so it is the honest signal here.
 * Bias to needs_review: a false yellow costs a human glance, a false green
 * costs a silently-unfixed bug — which is exactly what happened.
 */
// abandoned_background_task shares no_verdict_sentinel's exact rescan path
// (same "sentinel === null && !commitEvidence" gate in runVerify, same
// committedDuringRun repo-wide-not-per-job attribution problem) — the PRD 983
// incident mechanism above applies identically, so it gets the same guard
// rather than a carve-out that would silently reopen the same false-heal hole.
const NO_ATTRIBUTABLE_COMMIT_VERDICTS = new Set(['no_verdict_sentinel', 'abandoned_background_task']);

function healRefusalReason(job, verdict, committedDuringRun) {
  if (!job || !verdict) return null;
  if (!COMPLETED_EQUIVALENT_VERDICTS.has(verdict.verdict)) return null;
  if (!NO_ATTRIBUTABLE_COMMIT_VERDICTS.has(job.verifierVerdict)) return null;
  // A commit this job actually recorded as its own is real evidence; the
  // repo-wide window scan is not.
  if (job.landedCommit) return null;
  return `${job.verifierVerdict} with no job-attributable commit — refusing to heal`
    + ` (committedInWindow=${committedDuringRun === true} is repo-wide, not proof this job delivered)`;
}

/**
 * True when a `failed` job's failure is unverified-shaped — no result event
 * was ever recorded for its run (classifyRunOutcome === 'no_result'), so no
 * SCHEDULER_VERDICT sentinel could have been parsed either, OR it already
 * carries a RESCANNABLE_VERDICTS verifierVerdict. A row that failed with a
 * real result event (classifyRunOutcome === 'failed', i.e. a genuine red
 * gate or a real non-zero-exit error) is excluded — that failure is
 * evidence, not silence, and must never become a heal candidate (PRD 1102).
 */
function isFailedUnverifiedShaped(job) {
  if (!job || job.status !== 'failed') return false;
  if (job.verifierVerdict && RESCANNABLE_VERDICTS.has(job.verifierVerdict)) return true;
  const runId = job.runId || resolveRunId(job);
  if (!runId) return false;
  const logPath = path.join(RUNS_DIR, runId, `${job.slug}.log`);
  return classifyRunOutcome(logPath) === 'no_result';
}

function isRescanCandidate(job) {
  if (!job) return false;
  if (!(job.runId || resolveRunId(job))) return false;
  if (job.status === 'needs_review') return RESCANNABLE_VERDICTS.has(job.verifierVerdict);
  if (job.status === 'failed') return isFailedUnverifiedShaped(job);
  return false;
}

/**
 * Self-healing pass over needs_review jobs. The verifier runs in-process, so a
 * fix to runVerify.cjs only takes effect for jobs verified AFTER an app
 * restart — jobs flagged by the old (buggy) verifier stay stuck in needs_review
 * forever. On boot we re-run the CURRENT verifier over every transcript-scan
 * needs_review job and auto-complete the ones that now pass clean, so verifier
 * improvements retroactively clear their own false positives (2026-06-10:
 * anchored ImportError detectors + harness-tool-error exemption healed 8 jobs).
 *
 * @returns {Promise<{rescanned:number, healed:string[]}>}
 */
/**
 * Pure helper — no I/O by default (resolveJobRunId is injectable; production
 * caller passes resolveRunId, which does touch disk). Returns the subset of
 * jobs eligible for automatic fix-plan authoring after a reverify pass
 * leaves them still in needs_review.
 *
 * Exclusion rules (all must pass):
 *   - status === 'needs_review'
 *   - a runId, own or backfilled via resolveJobRunId (need a run log to investigate)
 *   - not itself a fix-plan slug (avoids infinite recursion)
 *   - autoFixAttempted cap: a job with no prior attempt is eligible; a job
 *     whose prior attempt outcome was 'no-plan', 'error', or UNSTAMPED
 *     (investigation exited without recording any outcome — unknown is not
 *     "succeeded") gets ONE bounded retry (autoFixRetries < 1); a job whose
 *     outcome was 'plan' (a fix plan was produced) is never retried here —
 *     it either lands as a queue row on its own or gets flagged
 *     autofix_plan_unqueued by reverifyNeedsReview's annotation pass; an
 *     exhausted retry is excluded
 *   - no fix sibling on disk (fixSlugExists) or already in the queue
 */
/**
 * Persist a writeRcaReport() result onto its job row — job.rcaFailureClass /
 * job.rcaRecoveryAction — so selectAutoFixTargets and future routing can read
 * the classification straight off the queue row instead of re-parsing the RCA
 * markdown. Pure mutation of the passed-in job object; no I/O. A no-op when
 * the job is missing, has moved off needs_review (e.g. resumed and completed
 * before this async write landed), or the report was never filed (disabled,
 * error, etc). Returns whether it applied, for callers/tests that want to
 * assert on it.
 */
function applyRcaClassification(job, report) {
  if (!job || job.status !== 'needs_review' || !report?.filed) return false;
  job.rcaFailureClass = report.failureClass;
  job.rcaRecoveryAction = report.recoveryAction;
  return true;
}

function selectAutoFixTargets(jobs, { fixSlugExists, resolveJobRunId = resolveRunId }) {
  const slugsInQueue = new Set(jobs.map((j) => j.slug));
  return jobs.filter((job) => {
    if (job.status !== 'needs_review') return false;
    // A stale re-run whose work already shipped (rcaReport's 'already-shipped'
    // class) must never buy a fix-plan PRD — there is nothing to fix, and the
    // correct recovery (archiving the PRD) is a human/reconcile action, not
    // an investigation.
    if (job.rcaRecoveryAction === 'archive') return false;
    // Resume-first recovery (PRD 1111): a job still eligible for its one
    // bounded `--resume` attempt must never also become a fix-plan target
    // in the same pass — see spawnInvestigation's own identical guard.
    if (selectResumeRecoveryTarget(job)) return false;
    const runId = job.runId || resolveJobRunId(job);
    if (!runId) return false;
    if (isFixPlanBeyondDepthCap(job.slug, job.investigationDepth)) return false;
    if (job.autoFixAttempted) {
      const retryEligible = job.autoFixOutcome === 'no-plan'
        || job.autoFixOutcome === 'error'
        || job.autoFixOutcome == null;
      if (!retryEligible) return false;
      if ((job.autoFixRetries ?? 0) >= 1) return false;
    }
    const fixSlug = fixSlugFor(job);
    if (fixSlugExists(fixSlug)) return false;
    if (slugsInQueue.has(fixSlug)) return false;
    return true;
  });
}

/**
 * Pure helper — no I/O by default (fixSlugExists is injectable). Answers
 * "does this single needs_review job qualify for an auto-fix investigation
 * right now?" by delegating to selectAutoFixTargets's eligibility rules
 * (same-1-attempt cap, depth cap, no fix sibling) against the full job list,
 * then checking whether this job is among the returned targets. Shared by
 * spawnJob's immediate same-tick path and (indirectly, via
 * selectAutoFixTargets itself) reverifyNeedsReview's periodic path, so both
 * use one eligibility definition rather than two divergent copies.
 */
function isEligibleForImmediateAutoFix(job, allJobs, fixSlugExists) {
  const targets = selectAutoFixTargets(allJobs, {
    fixSlugExists,
    resolveJobRunId: () => job.runId,
  });
  return targets.some((t) => t.slug === job.slug);
}

/**
 * Widened evidence check (PRD 1102): does at least one commit land AFTER
 * this job's run window that touches a path the PRD itself declares? Scoped
 * to the PRD's own declared paths (never the whole repo) so a sibling job's
 * unrelated commit is not credited to this one — see healRefusalReason's own
 * rationale for why unscoped, repo-wide evidence is not attribution.
 *
 * Returns null (no annotation, never fabricated) when the PRD names no
 * paths — the caller then has only the existing, already-computed
 * committedInWindow signal to go on, same as before this PRD.
 *
 * @returns {Promise<{commits: string[], paths: string[], detectedAt: string} | null>}
 */
async function computeLooksDone(job) {
  const prdPath = (await resolveVerifyPrdPath(job)) ?? archivedPrdPathForJob(job);
  const paths = declaredPathsForPrd(prdPath);
  if (!paths.length) return null;
  await fetchAllRefs(job.cwd);
  const commits = await landedSinceRun(job.cwd, job.startedAt, paths);
  if (!commits.length) return null;
  return { commits, paths, detectedAt: new Date().toISOString() };
}

async function reverifyNeedsReview() {
  const snap = await readQueue();
  const candidates = snap.jobs.filter(isRescanCandidate);
  const healed = [];
  const leftForReview = [];
  const looksDoneUpdates = [];
  for (const job of candidates) {
    if (job.status === 'failed') {
      // A failed row never runs the transcript-verifier rescan below — that
      // machinery (verifyRun/COMPLETED_EQUIVALENT_VERDICTS) exists to
      // auto-COMPLETE a stale needs_review row, and a failed row must never
      // auto-complete through this pass (see the AC's conservative-in-the-
      // completing-direction constraint). The only thing a failed candidate
      // can gain here is a looksDone annotation + a failed → needs_review
      // transition, for a human to confirm.
      const looksDone = await computeLooksDone(job);
      if (looksDone) {
        looksDoneUpdates.push({ slug: job.slug, cwd: job.cwd, looksDone, fromFailed: true });
      } else {
        leftForReview.push({ slug: job.slug, reason: 'failed, unverified-shaped run — no post-window evidence on declared paths' });
      }
      continue;
    }
    const runDir = path.join(RUNS_DIR, job.runId || resolveRunId(job));
    const prdPath = (await resolveVerifyPrdPath(job)) ?? archivedPrdPathForJob(job);
    // Derive committedDuringRun from the recorded run window. The live
    // commit-guard uses gitHead() (before/after HEAD diff); here the run is
    // already over so we query git log filtered to [startedAt, finishedAt+60s].
    const committedDuringRun = await committedInWindow(job.cwd, job.startedAt, job.finishedAt);
    // priorLandedCommit: same lookup as spawnJob's post-run verify — the live
    // jobs[] row first (survives a resetJob), else history.jsonl.
    let priorLandedCommit = job.landedCommit ?? null;
    if (!priorLandedCommit) {
      const hist = await queueHistory.historyTerminalBySlug().catch(() => null);
      priorLandedCommit = hist?.get(job.slug)?.landedCommit ?? null;
    }
    let v = null;
    try {
      v = await verifyRun({
        runDir,
        prdPath,
        queueEntry: job,
        allJobs: snap.jobs,
        committedDuringRun,
        allowPreSentinelHeal: true,
        priorLandedCommit,
      });
    } catch { leftForReview.push({ slug: job.slug, reason: 'verifyRun threw' }); continue; }
    const refusal = healRefusalReason(job, v, committedDuringRun);
    let stillOpen = true;
    if (refusal) {
      leftForReview.push({ slug: job.slug, reason: refusal });
    } else if (v && COMPLETED_EQUIVALENT_VERDICTS.has(v.verdict)) {
      healed.push(job.slug);
      stillOpen = false;
    } else {
      leftForReview.push({ slug: job.slug, reason: v ? `${v.verdict}: ${v.reason}` : 'null verdict' });
    }
    // Still needs_review after the existing heal pass — widen the evidence
    // window before giving up on it entirely (unchanged heal semantics for
    // rows that already qualified above; this only adds an annotation).
    if (stillOpen) {
      const looksDone = await computeLooksDone(job);
      if (looksDone) {
        looksDoneUpdates.push({ slug: job.slug, cwd: job.cwd, looksDone, fromFailed: false });
      }
    }
  }
  if (looksDoneUpdates.length) {
    const bySlug = new Map(looksDoneUpdates.map((u) => [u.slug, u]));
    await mutate((s) => {
      for (const j of s.jobs) {
        const u = bySlug.get(j.slug);
        if (!u) continue;
        if (u.fromFailed) {
          transitionJob(j, 'needs_review', {
            reason: 'looks done — commit(s) since this run touch this PRD\'s declared paths; confirm before archiving',
            source: 'reverifyNeedsReview:looksDone',
          });
        }
        if (j.status !== 'needs_review') continue;
        j.looksDone = u.looksDone;
        const shaList = u.looksDone.commits.slice(0, 5).map((c) => c.slice(0, 7)).join(', ');
        j.error = `looks done — ${u.looksDone.commits.length} commit(s) since this run touch this PRD's paths (${shaList}); confirm before archiving`;
      }
    });
    console.log(`[scheduler] boot reverify: looksDone annotated for ${looksDoneUpdates.length} row(s): ${looksDoneUpdates.map((u) => u.slug).join(', ')}`);
    await broadcast();
  }
  if (healed.length) {
    const healSet = new Set(healed);
    const healedPrds = [];
    await mutate((s) => {
      for (const j of s.jobs) {
        if (j.status === 'needs_review' && healSet.has(j.slug)) {
          transitionJob(j, 'completed', { reason: 'boot reverify: stale needs_review healed', source: 'reverifyNeedsReview:heal' });
          j.error = null;
          delete j.verifierVerdict;
          delete j.looksDone;
          healedPrds.push({ slug: j.slug, cwd: j.cwd });
        }
      }
    });
    for (const { slug, cwd } of healedPrds) {
      await archiveCompletedPrd(slug, cwd);
    }
    console.log(`[scheduler] boot reverify: healed ${healed.length} stale needs_review → completed (${healed.join(', ')})`);
    await broadcast();
  }
  if (leftForReview.length) {
    const detail = leftForReview.map((e) => `${e.slug} (${e.reason})`).join(', ');
    console.log(`[scheduler] boot reverify: left for review: ${detail}`);
  }

  // Mirror the live-completion auto-promote (spawnJob, ~line 1583): ANY
  // completed fix-plan job whose original is still needs_review/failed means
  // the original's work is logically done. Runs every pass (not just against
  // jobs healed THIS pass) and over ALL completed fix-plan jobs, not just
  // ones just-healed above — a fix-plan job healed by a PRIOR boot/periodic
  // pass, or completed via a live run, is just as valid a promotion source.
  // Idempotent: an already-promoted original has status !== 'needs_review'/
  // 'failed', so isPromotableOriginal excludes it on repeat passes — safe to
  // re-run unconditionally. (2026-07-12: 521-fix-*/523-fix-* healed on one
  // boot but their originals stayed stuck needs_review on every subsequent
  // boot/tick, because the promotion only ran inside `if (healed.length)`
  // scoped to that single pass's fresh heals.)
  const promoted = [];
  const promotedPrds = [];
  await mutate((s) => {
    for (const job of s.jobs) {
      if (job.status !== 'completed' || !isFixPlanSlug(job.slug)) continue;
      const orig = healTargetForFix(job.slug, s.jobs);
      if (!orig) continue;
      const priorStatus = orig.status;
      transitionJob(orig, 'completed', { reason: `auto-promoted: fix plan ${job.slug} already completed`, source: 'reverifyNeedsReview:auto-promote' });
      orig.exitCode = 0;
      orig.error = null;
      orig.completedBy = job.slug;
      delete orig.looksDone;
      if (priorStatus === 'needs_review') delete orig.verifierVerdict;
      promoted.push(`${orig.slug} (was ${priorStatus}, via ${job.slug})`);
      promotedPrds.push({ slug: orig.slug, cwd: orig.cwd });
    }
  });
  for (const { slug, cwd } of promotedPrds) {
    await archiveCompletedPrd(slug, cwd);
  }
  if (promoted.length) {
    console.log(`[scheduler] boot reverify: auto-promoted ${promoted.length} original(s): ${promoted.join(', ')}`);
    await broadcast();
  }

  // Surface needs_review jobs that can never self-heal or get an auto-fix
  // investigation (no runId, no backfillable run dir) instead of leaving
  // them silently stranded. Also surface auto-fix jobs whose one bounded
  // retry is already exhausted (outcome 'no-plan', 'error', or unstamped —
  // selectAutoFixTargets treats all three as retry-eligible, so all three
  // must also be annotatable once the retry is spent), and jobs whose
  // investigation DID produce a fix plan that never became a queue row
  // (write failed, or reconcile hasn't picked it up for some other reason).
  // All three classes are annotated, never looped on — a needs_review job
  // must not exit this pass both un-retried and un-annotated.
  const afterHealForAnnotate = await readQueue();
  const unresolvable = afterHealForAnnotate.jobs.filter(
    (j) => isUnresolvableNeedsReview(j, { hasRunDir: !!resolveRunId(j) }) && j.verifierVerdict !== 'no_run_artifacts',
  );
  const exhaustedAutoFix = afterHealForAnnotate.jobs.filter(
    (j) => isExhaustedAutoFix(j) && j.verifierVerdict !== 'autofix_no_plan',
  );
  const queuedSlugs = new Set(afterHealForAnnotate.jobs.map((j) => j.slug));
  const planUnqueued = afterHealForAnnotate.jobs.filter(
    (j) => isPlanUnqueued(j, queuedSlugs) && j.verifierVerdict !== 'autofix_plan_unqueued',
  );
  if (unresolvable.length || exhaustedAutoFix.length || planUnqueued.length) {
    const unresolvableSet = new Set(unresolvable.map((j) => j.slug));
    const exhaustedSet = new Set(exhaustedAutoFix.map((j) => j.slug));
    const planUnqueuedSet = new Set(planUnqueued.map((j) => j.slug));
    await mutate((s) => {
      for (const j of s.jobs) {
        if (unresolvableSet.has(j.slug)) {
          j.verifierVerdict = 'no_run_artifacts';
          j.error = 'no run artifacts — manual review';
        } else if (exhaustedSet.has(j.slug)) {
          j.verifierVerdict = 'autofix_no_plan';
          j.error = 'auto-fix investigation produced no fix plan after retry — manual review';
        } else if (planUnqueuedSet.has(j.slug)) {
          j.verifierVerdict = 'autofix_plan_unqueued';
          j.error = 'auto-fix investigation produced a fix plan that never reached the queue — manual review';
        }
      }
    });
    if (unresolvable.length) {
      console.log(`[scheduler] boot reverify: no run artifacts for ${unresolvable.map((j) => j.slug).join(', ')} — flagged for manual review`);
    }
    if (exhaustedAutoFix.length) {
      console.log(`[scheduler] boot reverify: auto-fix retry exhausted for ${exhaustedAutoFix.map((j) => j.slug).join(', ')} — flagged for manual review`);
    }
    if (planUnqueued.length) {
      for (const j of planUnqueued) {
        console.log(`[scheduler] boot reverify: auto-fix plan never queued for ${j.slug} — flagged for manual review`);
      }
    }
    await broadcast();
  }

  // The annotate mutate above only runs conditionally — when it didn't fire,
  // afterHealForAnnotate is still the current on-disk state, so reuse it
  // instead of re-reading queue.json twice more back-to-back for the
  // resume-recovery and auto-fix passes below (neither of which mutates
  // synchronously: spawnResumeRecovery/spawnJob's own writes land later).
  const queueForResumeAndAutofix = (unresolvable.length || exhaustedAutoFix.length || planUnqueued.length)
    ? await readQueue()
    : afterHealForAnnotate;

  // Resume-first recovery (PRD 1111): before any fix-plan investigation is
  // authored below, offer the bounded one-attempt `--resume` dispatch to any
  // needs_review job this periodic pass finds still eligible — e.g. one the
  // same-tick check in spawnJob missed because the app restarted between
  // that job parking and this pass running. selectAutoFixTargets below
  // already excludes every job this loop dispatches, so a resumable job
  // never also gets a fix-plan PRD authored in the same pass.
  {
    for (const job of queueForResumeAndAutofix.jobs) {
      const target = selectResumeRecoveryTarget(job);
      if (!target) continue;
      console.log(`[scheduler] resume-recovery: needs_review ${job.slug} → resuming session ${target.sessionId}`);
      spawnResumeRecovery(job, target).catch((e) => {
        console.error('[scheduler] spawnResumeRecovery error', job.slug, e);
      });
    }
  }

  // Auto-fix: spawn a fix-plan investigation for each job still in
  // needs_review after the heal pass (kill-switch: SM_AUTOFIX_DISABLE=1).
  // spawnInvestigation early-returns once investigationsInFlight reaches
  // MAX_CONCURRENT_INVESTIGATIONS (queues the rest for retry), so this loop
  // cannot fan out past the cap regardless of how many targets are selected.
  if (process.env.SM_AUTOFIX_DISABLE !== '1') {
    const targets = selectAutoFixTargets(queueForResumeAndAutofix.jobs, {
      fixSlugExists: (s) => candidatePrdsDirs().some((dir) => fs.existsSync(path.join(dir, `${s}.md`))),
    });
    for (const job of targets) {
      const runId = job.runId || resolveRunId(job);
      const runDir = path.join(RUNS_DIR, runId);
      const isRetryAttempt = job.autoFixAttempted === true;
      // Persist the attempt BEFORE spawning — a crash mid-investigation still
      // counts it (mirrors orphanRetries). Safe even when the slot is busy: the
      // investigation is queued and drained as slots free, so it is genuinely
      // attempted rather than silently dropped.
      await mutate((s) => {
        const j = s.jobs.find((x) => x.slug === job.slug);
        if (j) {
          j.autoFixAttempted = true;
          if (!j.runId && runId) j.runId = runId;
          if (isRetryAttempt) {
            j.autoFixRetries = (j.autoFixRetries ?? 0) + 1;
            delete j.autoFixOutcome;
          }
        }
      });
      console.log(`[scheduler] auto-fix: needs_review ${job.slug} → authoring fix-plan (${isRetryAttempt ? 'retry' : '1/1'})`);
      spawnInvestigation(job, runDir).catch((e) => {
        console.error('[scheduler] auto-fix spawnInvestigation error', job.slug, e);
      });
    }
  }

  return { rescanned: candidates.length, healed, leftForReview, looksDone: looksDoneUpdates.map((u) => u.slug) };
}

/**
 * schedule:clear-queue's core state mutation, split out so it's testable
 * without ipcMain/electron: every victim (non-running job whose slug is in
 * `victimSlugs`) must leave a durable history.jsonl record before it
 * disappears from queue.json — a manual clear used to just filter the row
 * out with no trace (a job could vanish with zero audit trail; see the
 * 2026-08-30 sigma `788-pr-sweep-final-gate` incident). Non-terminal victims
 * (pending/investigating/needs_review/quarantined) are force-transitioned to
 * 'skipped' — never 'completed', since a manually-cleared job did not ship.
 * Victims already terminal (completed/failed/skipped) keep their real
 * status; they just get a statusHistory note + a history row so they don't
 * silently drop before aging past HISTORY_RETENTION_MS.
 *
 * Mutates `state.jobs` in place (drops the victims, same contract as
 * reconcile()) and returns the job snapshots to append to history.jsonl.
 */
function applyClearQueueVictims(state, victimSlugs, archiveNoteBySlug, archiveDir) {
  const historyEntries = [];
  for (const job of state.jobs) {
    if (!victimSlugs.has(job.slug)) continue;
    const reason = archiveNoteBySlug?.get(job.slug) ?? `PRD archived to ${archiveDir}`;
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'skipped') {
      // Already terminal — keep the real status, just record the clear.
      const history = Array.isArray(job.statusHistory) ? job.statusHistory : [];
      history.push({ from: job.status, to: job.status, reason, source: 'clear-queue', at: new Date().toISOString() });
      while (history.length > STATUS_HISTORY_CAP) history.shift();
      job.statusHistory = history;
    } else {
      transitionJob(job, 'skipped', { reason, source: 'clear-queue' });
    }
    if (!job.finishedAt) job.finishedAt = new Date().toISOString();
    historyEntries.push({ ...job });
  }
  state.jobs = state.jobs.filter((j) => !victimSlugs.has(j.slug));
  return historyEntries;
}

function registerScheduleHandlers() {
  ensureDirs();
  supervisor.registerHandlers();

  ipcMain.handle('schedule:state', async () => {
    const state = await readQueue();
    await reconcile(state);
    await writeQueue(state);
    return buildScheduleStatePayload(state, { withPaths: true });
  });

  // Session-Manager-wide claude -p slot pool (lib/sessionSlots.cjs) —
  // read-only diagnostic surface for the Home widget and the global
  // configuration tab.
  ipcMain.handle('schedule:session-slots', () => sessionSlots.snapshot());

  // Home-tab control for the same pool: user-set cap in [0, 10], default 5.
  // 0 pauses new claude -p launches machine-wide without killing anything
  // already running. SM_SESSION_SLOTS (if set) still overrides this at read
  // time — sessionSlots.snapshot().envOverride tells the UI to disable itself.
  ipcMain.handle('schedule:set-session-slots', validated(schemas.setSessionSlotsSchema, async (data) => {
    sessionSlots.setCap(data.cap);
    return sessionSlots.snapshot();
  }));

  ipcMain.handle('schedule:health', async () => {
    const state = await readQueue();
    const runningJobs = [];
    for (const j of state.jobs) {
      if (j.status === 'running' && j.runtime) {
        runningJobs.push({
          slug: j.slug,
          startedAt: j.startedAt ? Date.parse(j.startedAt) : 0,
          pid: j.runtime.pid ?? 0,
        });
      }
    }
    return {
      bootedAt,
      lastPollAt,
      lastPollOk,
      consecutiveFailures,
      lastFailureKind,
      backoffNextAt,
      nextResetCached: cachedNextReset,
      pausedSince: state.paused ? Date.parse(state.paused.since) : null,
      pauseReason: state.paused?.reason ?? null,
      runningJobs,
    };
  });

  ipcMain.handle('schedule:force-tick', async () => {
    // Bypass the billing-poll gate entirely — fire pending jobs immediately regardless of meter state.
    // Clears any existing pause first (same semantics as run-now).
    await clearPause('run-now');
    try {
      const result = await runDueJobs({ bypassLoadGate: true });
      return forceTickOutcome(result);
    } catch (e) {
      logs.writeLine({ level: 'error', scope: 'scheduler', message: 'runDueJobs error (force-tick)', meta: { error: e?.message } });
      return { ok: false, kind: 'error', message: `Failed to fire batch: ${e?.message ?? String(e)}` };
    }
  });

  // .default({}) so callers may omit the payload entirely (same as the old `partial || {}`).
  ipcMain.handle('schedule:set-config', validated(schemas.setConfigSchema.default({}), async (data) => {
    const config = await mutate((state) => {
      const { supervisor: supPartial, ...rest } = data;
      state.config = { ...state.config, ...rest };
      if (supPartial !== undefined) {
        state.config.supervisor = { ...(state.config.supervisor ?? {}), ...supPartial };
      }
      return state.config;
    });
    await rescheduleTimer();
    return { ok: true, config };
  }));

  ipcMain.handle('schedule:reset-job', validated(schemas.scheduleSlug, async ({ slug }) => {
    if (!(await safeSlugPath(slug))) return { ok: false, error: 'invalid slug' };
    const outcome = await mutate((state) => {
      const idx = state.jobs.findIndex((j) => j.slug === slug);
      if (idx < 0) return 'not-found';
      // Guard is in resetJobFields: refuses to reset an already-'completed'
      // job, which would otherwise re-fire a PRD whose deliverable already
      // landed (see resetJobFields' doc comment for the incident).
      return resetJobFields(state.jobs[idx], null, { source: 'ipc:schedule:reset-job' }) ? 'ok' : 'refused';
    });
    if (outcome === 'not-found') return { ok: false, error: 'not found' };
    if (outcome === 'refused') {
      return {
        ok: false,
        error: 'job already completed — resetting it would re-execute shipped work; archive the PRD instead',
      };
    }
    await broadcast({ flush: true });
    return { ok: true };
  }));

  // Renderer-facing counterpart to prdCreate.cjs's chat:create-prd handler
  // (index.cjs): calls the SAME remote.updatePrd the admin HTTP route/MCP
  // tool use, so "stamps it through the API" holds for the Scheduler tab's
  // one-click adopt action too, not just a direct fs write. Only a
  // 'quarantined' row is eligible — see reconcile()'s provenance gate.
  ipcMain.handle('schedule:adopt-prd', validated(schemas.scheduleSlug, async ({ slug }) => {
    if (!(await safeSlugPath(slug))) return { ok: false, kind: 'error', message: 'invalid slug' };
    const state = await readQueue();
    const job = state.jobs.find((j) => j.slug === slug);
    if (!job) return { ok: false, kind: 'error', message: 'not found' };
    if (job.status !== 'quarantined') {
      return { ok: false, kind: 'error', message: `job status is "${job.status}" — only a quarantined PRD may be adopted` };
    }
    const result = await remote.updatePrd({
      slug,
      cwd: job.cwd,
      frontmatter: { createdVia: 'legacy-adopted', issuedAt: new Date().toISOString() },
    });
    if (!result.ok) return { ok: false, kind: 'error', message: result.error ?? 'adopt failed' };
    appendAuditEvent('scheduler_prd_adopted', { slug, cwd: job.cwd ?? null, source: 'ipc:schedule:adopt-prd' });
    // Promote the row to 'pending' immediately rather than waiting for the
    // next poll tick — the Scheduler tab's "adopt PRD" click should be
    // visibly effective within this one round-trip.
    const freshState = await readQueue();
    await reconcile(freshState);
    await writeQueue(freshState);
    await broadcast({ flush: true });
    return { ok: true, kind: 'info', message: `Adopted ${slug} — it will run as a normal pending job` };
  }));

  ipcMain.handle('schedule:run-now', async () => {
    // Manual run-now overrides any auto-pause. Clear it first.
    await clearPause('run-now');
    runDueJobs({ bypassLoadGate: true }).catch((e) => logs.writeLine({ level: 'error', scope: 'scheduler', message: 'runDueJobs error (run-now)', meta: { error: e?.message } }));
    return { ok: true };
  });

  ipcMain.handle('schedule:resume', async () => {
    await clearPause('manual');
    return { ok: true };
  });

  // Re-scan prds/ folder and merge into queue.json. The `schedule:state`
  // handler already reconciles on read, but this gives the renderer an
  // explicit refresh path that also broadcasts so all views update.
  ipcMain.handle('schedule:rescan', async () => {
    const { added, removed } = await mutate(async (state) => {
      const before = new Set(state.jobs.map((j) => j.slug));
      await reconcile(state);
      const after = new Set(state.jobs.map((j) => j.slug));
      const added = [...after].filter((slug) => !before.has(slug)).length;
      const removed = [...before].filter((slug) => !after.has(slug)).length;
      return { added, removed };
    });
    await broadcast();
    let message;
    if (added === 0 && removed === 0) message = 'Rescanned — no new/removed PRD files';
    else if (added > 0 && removed === 0) message = `Rescanned — ${added} new PRD file(s) picked up`;
    else if (added === 0 && removed > 0) message = `Rescanned — ${removed} PRD file(s) removed from disk`;
    else message = `Rescanned — ${added} new PRD file(s) picked up, ${removed} removed from disk`;
    return { ok: true, kind: 'info', message };
  });

  ipcMain.handle('schedule:clear-queue', async () => {
    ensureDirs();
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const archiveDir = path.join(PRDS_ARCHIVE_DIR, ts);
    const state = await readQueue();
    const victims = state.jobs.filter((j) => j.status !== 'running');
    if (victims.length === 0) {
      return { ok: true, archived: 0, archivedTo: null };
    }
    await fsp.mkdir(archiveDir, { recursive: true });
    let archived = 0;
    const archiveNoteBySlug = new Map();
    for (const job of victims) {
      const srcDir = await findPrdDir(job.slug) ?? prdDirForCwd(job.cwd);
      const src = path.resolve(path.join(srcDir, `${job.slug}.md`));
      if (!src.startsWith(srcDir + path.sep)) continue;
      const dst = path.join(archiveDir, `${job.slug}.md`);
      try {
        await fsp.rename(src, dst);
        archived++;
        archiveNoteBySlug.set(job.slug, `PRD file archived to ${archiveDir}`);
      } catch (e) {
        // ENOENT: the .md is already gone (reconcile would drop it on next
        // read anyway). Either way, fall through and remove from queue.
        if (e?.code !== 'ENOENT') {
          logs.writeLine({ level: 'warn', scope: 'scheduler', message: 'clear-queue: rename failed', meta: { slug: job.slug, error: e?.message } });
        }
        archiveNoteBySlug.set(job.slug, `PRD file already gone (ENOENT) when archiving to ${archiveDir}`);
      }
    }
    await mutate(async (s) => {
      const victimSlugs = new Set(victims.map((j) => j.slug));
      const historyEntries = applyClearQueueVictims(s, victimSlugs, archiveNoteBySlug, archiveDir);
      // Append BEFORE this mutate's writeQueue persists s.jobs without the
      // victims (mutate() only writes after this callback resolves) — same
      // append-before-drop ordering queueHistory.cjs's reconcile() callers
      // use, so a crash right after this handler returns can never leave a
      // row gone from queue.json with nothing in history.jsonl yet.
      if (historyEntries.length > 0) {
        await queueHistory.appendHistory(historyEntries);
      }
      await reconcile(s);
      return null;
    });
    await broadcast();
    return { ok: true, archived, archivedTo: archiveDir };
  });

  ipcMain.handle('schedule:open-folder', async () => {
    const { shell } = require('electron');
    await shell.openPath(ROOT);
    return { ok: true };
  });

  ipcMain.handle('schedule:read-prd', validated(schemas.scheduleSlug, async ({ slug }) => {
    const filePath = await safeSlugPath(slug);
    if (!filePath) return { ok: false, error: 'invalid slug' };
    try {
      const text = await fsp.readFile(filePath, 'utf8');
      return { ok: true, text };
    } catch (e) {
      return { ok: false, error: e?.message };
    }
  }));

  ipcMain.handle('schedule:read-log', validated(schemas.scheduleReadLog, async ({ slug, runId }) => {
    // Defense-in-depth: re-check containment after path.resolve even though
    // SLUG_RE / RUN_ID_RE already forbid path separators.
    const logPath = path.resolve(path.join(RUNS_DIR, runId, `${slug}.log`));
    if (!logPath.startsWith(RUNS_DIR + path.sep)) {
      return { ok: false, error: 'invalid slug or runId' };
    }
    try {
      const text = await fsp.readFile(logPath, 'utf8');
      return { ok: true, text };
    } catch (e) {
      return { ok: false, error: e?.message };
    }
  }));

  ipcMain.handle('schedule:write-prd', validated(schemas.scheduleWritePrd, async (data) => {
    // Editing an existing PRD writes back to whichever dir it already lives
    // in; a brand-new slug (no cwd known yet — e.g. the renderer's "New PRD"
    // template, authored before the user fills in `cwd`) falls back to the
    // legacy global dir until it's re-saved with a real cwd and migrated by
    // the next reconcile-driven scan.
    const dir = (await findPrdDir(data.slug)) ?? PRDS_DIR;
    if (dir === PRDS_DIR) ensureDirs();
    const resolved = safeSlugPathIn(dir, data.slug);
    if (!resolved) return { ok: false, error: 'invalid slug' };
    try {
      await config.writeTextAtomic(resolved, data.body, { writer: 'scheduler' });
    } catch (e) {
      return { ok: false, error: e?.message ?? 'write failed' };
    }
    try {
      const stat = await fsp.stat(resolved);
      return { ok: true, bytesWritten: stat.size };
    } catch (e) {
      return { ok: false, error: e?.message ?? 'stat failed' };
    }
  }));

  ipcMain.handle('schedule:list-prds', async () => listPrdsInternal());

  // Return last N completed/failed jobs from queue.json, newest first.
  // Purely additive: no schema change, no archive-folder read needed.
  ipcMain.handle('schedule:get-history', async (_e, payload) => {
    const limit = (payload && typeof payload.limit === 'number') ? payload.limit : 50;
    try {
      const state = await readQueue();
      const historyEntries = await queueHistory.readHistory({ limit });
      return { ok: true, jobs: selectHistoryJobs(state.jobs, limit, historyEntries) };
    } catch (e) {
      return { ok: false, jobs: [], error: e?.message ?? 'read failed' };
    }
  });
}

async function init() {
  ensureDirs();
  // Boot phase — reconciliation, migrations, self-heal, first reset probe.
  // Guarded as a unit: everything below installs the timers that ARE the
  // running scheduler (poll loop, heartbeat, supervisor). A throw in here
  // used to reject init() and silently skip all of them, leaving an app
  // that looks up and holds the ownership lock but never ticks and never
  // writes a heartbeat — indistinguishable from a hung queue. Most of this
  // work is best-effort recovery; none of it is worth trading the scheduler
  // itself for. rescheduleTimer() in particular reaches the billing API,
  // which fails whenever the OAuth token is stale.
  try {
    // A slot freed anywhere (e.g. a chat run settled) may unblock a deferred
    // batch — advance the queue without waiting for the next 60s poll.
    sessionSlots.subscribe(() => { tickQueue().catch(() => {}); });
    // Retire the global queue.json: split its rows into per-project shards
    // BEFORE the first read below, so boot reconciliation sees the shards.
    try {
      const m = await queueStore.migrateLegacyGlobalQueue(DEFAULT_PROJECT_CWD);
      if (m.migrated) {
        console.log(`[scheduler] legacy global queue retired: ${m.moved} row(s) split across ${m.projects} project shard(s)`);
      }
    } catch (e) {
      console.error('[scheduler] legacy queue split failed', e?.message);
    }
    await runPrdMigration();
    sweepQueueBackups().catch((e) => console.warn('[scheduler] backup sweep failed', e?.message));

    // Hydrate cached state from the sidecar before any scheduling decisions.
    loadSchedulerState();
    bootedAt = Date.now();

    // Boot reconciliation: finalize any job that was 'running' when the app died.
    // Check the run log first — a job that emitted result/success before the crash
    // should be marked 'completed', not 'failed', so it doesn't wedge the queue
    // via the failure-gate. Also kill any still-live orphan claude child to prevent
    // it from continuing to write to the project unsupervised (2026-05-21 incident).
    //
    // classifyRunOutcome calls readTail → fs.readFileSync (up to 64 KB per job).
    // Pre-compute all outcomes BEFORE entering the mutate lock so the blocking I/O
    // does not stall the event loop or hold the mutateTail chain during startup.
    //
    // Jobs whose recorded pid is still alive are deferred (not classified here) —
    // see partitionBootOrphans. Everything else (dead pid or no pid) is safe to
    // classify immediately below.
    const bootSnap = readQueueSync();

    // Worktree boot reconciliation (PRD 994): a job worktree that survives an
    // app crash/host reboot must not leak disk or a dangling branch forever —
    // this sweeps every known project cwd (every cwd referenced by a queue
    // row, plus the default project) and removes any of OUR worktrees still
    // registered there. Best-effort: never blocks the rest of boot.
    try {
      const worktreeCwds = new Set(bootSnap.jobs.map((j) => j.cwd).filter(Boolean));
      worktreeCwds.add(DEFAULT_PROJECT_CWD);
      await jobWorktree.reconcileWorktreesOnBoot([...worktreeCwds]);
    } catch (e) {
      console.error('[scheduler] boot worktree reconciliation failed', e?.message);
    }

    // Epic worktree boot reconciliation (PRD 1033): same sweep, epic kind —
    // reaps only a worktree whose owning Epic is no longer 'active' in that
    // project's own active-index.json (see epicWorktreeBoot.cjs). Reuses the
    // same known-cwd set as the job sweep above; best-effort, never blocks
    // the rest of boot.
    try {
      const worktreeCwds = new Set(bootSnap.jobs.map((j) => j.cwd).filter(Boolean));
      worktreeCwds.add(DEFAULT_PROJECT_CWD);
      await reconcileEpicWorktreesOnBoot([...worktreeCwds]);
    } catch (e) {
      console.error('[scheduler] boot epic-worktree reconciliation failed', e?.message);
    }

    const { immediate: immediateSlugs, deferred: deferredSlugs } = partitionBootOrphans(bootSnap.jobs);
    const bootOutcomes = new Map();
    for (const j of bootSnap.jobs) {
      if (!immediateSlugs.includes(j.slug)) continue;
      const logPath = j.runId ? path.join(RUNS_DIR, j.runId, `${j.slug}.log`) : null;
      bootOutcomes.set(j.slug, logPath ? classifyRunOutcome(logPath) : 'unknown');
    }
    const bootReconciledCompletions = [];
    await mutate((state) => {
      for (const j of state.jobs) {
        if (j.status !== 'running' || !immediateSlugs.includes(j.slug)) continue;
        const outcome = bootOutcomes.get(j.slug) ?? 'unknown';
        const pid = j.runtime?.pid;
        const killNote = pid ? ` (orphan pid=${pid}: dead)` : '';
        applyOrphanOutcome(j, outcome, killNote);
        if (j.status === 'completed') bootReconciledCompletions.push({ slug: j.slug, cwd: j.cwd });
        console.log(`[scheduler] boot reconcile: slug=${j.slug} outcome=${outcome} → status=${j.status}`);
      }
    });
    for (const { slug, cwd } of bootReconciledCompletions) {
      await archiveCompletedPrd(slug, cwd);
    }

    // Still-alive orphans: SIGTERM (+ killOrphanClaudePid's own deferred SIGKILL
    // follow-up) now, but classification waits until BOOT_ORPHAN_KILL_GRACE_MS
    // later — reading the log while the orphan might still be writing to it
    // could misclassify an about-to-succeed run as no_result and double-run the
    // same PRD (2026-05-21 incident this guard exists for).
    for (const slug of deferredSlugs) {
      const j = bootSnap.jobs.find((x) => x.slug === slug);
      const pid = j?.runtime?.pid;
      const bootRunId = j?.runId ?? null; // captured now — guards against reconciling a DIFFERENT later run of the same slug
      if (!pid) continue;
      const result = killOrphanClaudePid(pid);
      const killNote = ` (orphan pid=${pid}: ${result})`;
      if (result === 'killed') {
        console.log(`[scheduler] boot: SIGTERM'd orphan claude pid=${pid} for ${slug} — deferring finalize ${BOOT_ORPHAN_KILL_GRACE_MS}ms`);
      }
      setTimeout(() => {
        const logPath = j.runId ? path.join(RUNS_DIR, j.runId, `${j.slug}.log`) : null;
        const outcome = logPath ? classifyRunOutcome(logPath) : 'unknown';
        let deferredCompletedCwd;
        mutate((state) => {
          const cur = state.jobs.find((x) => x.slug === slug);
          // Race guard: bail if the job already resolved, OR if it's already been
          // re-picked into a NEW run (different runId) within the grace window —
          // that new run is not the boot orphan we SIGTERM'd and must not be
          // touched by this stale classification.
          if (!cur || cur.status !== 'running' || cur.runId !== bootRunId) return;
          applyOrphanOutcome(cur, outcome, killNote);
          console.log(`[scheduler] boot reconcile (deferred): slug=${slug} outcome=${outcome} → status=${cur.status}`);
          deferredCompletedCwd = cur.status === 'completed' ? cur.cwd : undefined;
        }).then(() => {
          if (deferredCompletedCwd !== undefined) return archiveCompletedPrd(slug, deferredCompletedCwd);
        }).catch((e) => console.error(`[scheduler] deferred boot reconcile failed for ${slug}:`, e?.message));
      }, BOOT_ORPHAN_KILL_GRACE_MS).unref?.();
    }

    // If we boot up while paused with a resumeAt in the past, clear it. This
    // happens when the app was closed across the reset window.
    const boot = await readQueue();
    if (boot.paused && boot.paused.resumeAt && new Date(boot.paused.resumeAt).getTime() <= Date.now()) {
      await clearPause('boot-elapsed');
    } else if (boot.paused && boot.paused.resumeAt) {
      // Re-arm the resume timer (lost across restart).
      await setPaused(boot.paused.reason, boot.paused.resumeAt);
    }

    // Self-heal stale needs_review flags using the current verifier (see
    // reverifyNeedsReview). Runs once on boot so a shipped verifier fix clears
    // its own historical false positives without manual retagging.
    await reverifyNeedsReview().catch((e) => {
      console.error(`[scheduler] boot reverify failed: ${e?.message ?? e}`);
    });

    await rescheduleTimer();
  } catch (e) {
    console.error('[scheduler] boot phase failed — starting timers anyway:', e?.message);
    try {
      require('./logs.cjs').writeLine({
        scope: 'scheduler',
        level: 'error',
        message: 'boot phase failed; timers started anyway',
        meta: { error: e?.message },
      });
    } catch { /* logging must never be the thing that stops the scheduler */ }
  }
  // Refresh next-reset every 10 minutes — billing window can shift if usage
  // resets early or the auth token rotates. Tracked so re-init doesn't leak.
  if (rescheduleInterval) clearInterval(rescheduleInterval);
  rescheduleInterval = setInterval(() => {
    rescheduleTimer().catch(() => {});
    const s = readQueueSync();
    // Periodic self-heal: re-run the verifier over stale needs_review jobs so a
    // job whose work actually landed (committed in-window, no FAIL sentinel)
    // auto-clears WITHOUT waiting for the next app restart. Cheap-guarded — the
    // log scan only runs when something is actually flagged. Kill-switch:
    // SM_REVERIFY_PERIODIC_DISABLE=1 (boot reverify above stays always-on).
    // reverifyNeedsReview's auto-fix loop is capped downstream by
    // MAX_CONCURRENT_INVESTIGATIONS (spawnInvestigation queues/early-returns
    // past it), so this interval firing cannot fan out investigations.
    if (process.env.SM_REVERIFY_PERIODIC_DISABLE !== '1') {
      if (s.jobs.some((j) => j.status === 'needs_review')) {
        reverifyNeedsReview().catch(() => {});
      }
      // A quarantined row only ever promotes to 'pending' through
      // reconcile()'s adopt path (see reconcile()'s "Adopt path" comment) —
      // it re-checks the PRD file's createdVia stamp every pass. broadcast()
      // already runs reconcile+writeQueue on every normal poll tick, but an
      // idle queue (nothing pending/running to fire) can back off that
      // cadence for a long time; this guarantees an adopted-but-still-
      // quarantined row is re-checked within 10 minutes regardless.
      if (s.jobs.some((j) => j.status === 'quarantined')) {
        broadcast().catch(() => {});
      }
    }
    // Age-based escalation (independent of the self-heal kill-switch above —
    // this is a monitoring signal, not an auto-fix action): a quarantined
    // row nobody has adopted or archived past QUARANTINE_ESCALATE_MS is
    // warn-logged by project + slug + age so it cannot sit stranded and
    // silent (the four burrow-project rows this PRD was written against).
    for (const stale of findStaleQuarantinedJobs(s.jobs, Date.now(), QUARANTINE_ESCALATE_MS)) {
      console.warn(
        `[scheduler] QUARANTINED PRD STALE: project=${stale.cwd ?? '(unknown)'} slug=${stale.slug} `
        + `age=${Math.round(stale.ageMs / 3_600_000)}h (>= ${Math.round(QUARANTINE_ESCALATE_MS / 3_600_000)}h threshold) — `
        + `adopt it from the Scheduler tab's Quarantined filter, or archive it; nothing else will clear this`,
      );
      appendAuditEvent('prd_quarantine_stale', { slug: stale.slug, cwd: stale.cwd, ageMs: stale.ageMs });
    }

    // Estimate-relative overrun escalation. Sits in the blind spot between
    // the 4h deadman and the 20-minute idle-output watchdog: a job that keeps
    // producing output while looping trips neither, so nothing noticed a PRD
    // running 9x its own estimate until a human went looking. Escalate loudly;
    // never kill on an estimate (see JOB_OVERRUN_FACTOR).
    for (const over of findOverrunningJobs(s.jobs, Date.now())) {
      console.warn(
        `[scheduler] JOB OVERRUNNING ESTIMATE: project=${over.cwd ?? '(unknown)'} slug=${over.slug} `
        + `ran=${Math.round(over.ranMs / 60_000)}m vs estimate=${over.estimateMinutes}m `
        + `(${over.ratio.toFixed(1)}x, threshold ${JOB_OVERRUN_FACTOR}x floor ${Math.round(JOB_OVERRUN_FLOOR_MS / 60_000)}m) — `
        + `still running; the ${Math.round(MAX_JOB_DURATION_MS / 3_600_000)}h deadman has NOT fired yet. `
        + `Check the run log, then let it finish or cancel it via scheduler_cancel_job`,
      );
      appendAuditEvent('job_overrunning_estimate', {
        slug: over.slug, cwd: over.cwd, estimateMinutes: over.estimateMinutes, ranMs: over.ranMs, ratio: over.ratio,
      });
    }

    // Stranded-investigation restore. Unlike the two escalations above, this
    // one ACTS: 'investigating' is a transient status whose restore
    // (spawnInvestigation's onExit/catch) only runs inside the process that
    // spawned the probe, so an app restart mid-probe leaves the row frozen
    // there forever (see findStrandedInvestigations' header, and the
    // "'investigating' must never be the job's resting state" comment at
    // spawnInvestigation's onExit). This restores each stranded row to the
    // exact terminal status it already carried before the probe was
    // spawned — it never re-runs or re-investigates anything.
    const stranded = findStrandedInvestigations(s.jobs, Date.now(), INVESTIGATION_MAX_MS);
    if (stranded.length > 0) {
      mutate((ms) => {
        for (const st of stranded) {
          const j = ms.jobs.find((x) => x.slug === st.slug);
          if (!j || j.status !== 'investigating') continue; // race guard — may have resolved since the scan above
          transitionJob(j, st.restoreStatus, { reason: `stranded investigation restored after ${Math.round(st.ageMs / 60_000)}m with no live probe behind it`, source: 'findStrandedInvestigations' });
          delete j.runtime;
          console.warn(
            `[scheduler] STRANDED INVESTIGATION RESTORED: project=${st.cwd ?? '(unknown)'} slug=${st.slug} `
            + `age=${Math.round(st.ageMs / 3_600_000)}h (>= ${Math.round(INVESTIGATION_MAX_MS / 3_600_000)}h threshold), no live probe — `
            + `restored to '${st.restoreStatus}'`,
          );
          appendAuditEvent('investigation_stranded_restored', { slug: st.slug, cwd: st.cwd, ageMs: st.ageMs, restoreStatus: st.restoreStatus });
        }
      })
        .then(() => broadcast({ flush: true }))
        .catch(() => {});
    }

    // Per-project starvation (PRD 1087): a project with pending work that has
    // been passed over on every tick while OTHER projects dispatch. Nothing
    // else distinguishes "no pending work" from "pending work, never
    // started" — the 2026-09-01 NN-ordering starvation ran 3.5 h unnoticed.
    // Escalation only, same shape as the quarantine/overrun warnings above.
    for (const sp of findStarvedProjects(s.jobs, Date.now(), STARVATION_ESCALATE_MS)) {
      console.warn(
        `[scheduler] PROJECT STARVED: project=${sp.cwd} pending=${sp.pendingCount} oldest=${sp.oldestPendingSlug} `
        + `waiting=${Math.round(sp.ageMs / 60_000)}m (>= ${Math.round(STARVATION_ESCALATE_MS / 60_000)}m threshold) `
        + `while other projects are running — check the cross-project fairness rule in pickNextBatch`,
      );
      appendAuditEvent('project_starved', { cwd: sp.cwd, pendingCount: sp.pendingCount, oldestPendingSlug: sp.oldestPendingSlug, ageMs: sp.ageMs });
    }
  }, 10 * 60_000);

  // Self-rescheduling poll loop with exponential backoff. Replaces the
  // old fixed-interval pollTimer + initialPollTimeout.
  if (pollLoopTimer) clearTimeout(pollLoopTimer);
  // First tick fires after the standard warmup delay so billing is ready.
  pollLoopTimer = setTimeout(() => { pollLoop().catch(() => {}); }, USAGE_REFRESH_INTERVAL_MS);
  if (pollLoopTimer.unref) pollLoopTimer.unref();

  // Supervisor: probe running jobs for wedged poll-loops. Supervisor calls
  // its injected readQueue() synchronously from supervisorTick and applyAction,
  // so pass the sync variant; the 15-min probe cadence makes the blocking cost
  // negligible vs IPC handler latency.
  if (process.env.SM_SUPERVISOR_DISABLE !== '1') {
    supervisor.startSupervisor({ readQueue: readQueueSync });
  }

  // Heartbeat: once per minute, log queue state for 24h visibility.
  // setInterval callback is sync; readQueueSync stays sync to avoid awaiting
  // inside the timer body (and the 60s cadence makes the cost moot).
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  heartbeatInterval = setInterval(() => {
    const s = readQueueSync();
    // NEVER-STOP INVARIANT: if a queue holds ready PRDs and nothing is
    // running, something must drive it. This is the only driver that does
    // not depend on the billing poll loop, a pause timer, or a completing
    // job to schedule the next tick — every one of which has failed at
    // least once. See classifyQueueStarvation.
    if (!s.unreadable) {
      runQueueStarvationWatchdog(s).catch((e) => console.error('[scheduler] starvation watchdog error', e));
    }
    // Initialise from the real status union (scheduleJobSchema.cjs) rather
    // than a hand-maintained subset — the old `{ pending, running, completed,
    // failed }` literal silently minted a NEW key for any other value
    // (`counts[j.status] = (counts[j.status]||0)+1`), which is exactly how a
    // heartbeat with a `queued: 2` bucket looked like "normal" 24h
    // visibility instead of the alarm it should have been. Any row whose
    // status isn't in JOB_STATUSES (shouldn't happen post-quarantine, but
    // this is the last line of defence) routes into `unknown`, never a
    // freshly-minted key.
    const counts = Object.fromEntries(JOB_STATUSES.map((st) => [st, 0]));
    counts.unknown = 0;
    for (const j of s.jobs) {
      if (Object.prototype.hasOwnProperty.call(counts, j.status) && j.status !== 'unknown') {
        counts[j.status] += 1;
      } else {
        counts.unknown += 1;
      }
    }

    const stall = computeStallSummary(s);
    // Per-project alerting (see computeStallSummary's header): a project
    // stalled while others are busy must still fire, and one project
    // recovering must not clear or suppress another's still-open episode —
    // that is exactly what a single module-level stallSince/stallToasted
    // flag masked before (the burrow-vs-others incident this PRD fixes).
    const now = Date.now();
    const stalledCwds = Object.keys(stall.byProject).filter((cwd) => stall.byProject[cwd].stalled);
    for (const cwd of [...stallSince.keys()]) {
      if (!stalledCwds.includes(cwd)) {
        stallSince.delete(cwd);
        stallToasted.delete(cwd);
      }
    }
    const toAlert = [];
    for (const cwd of stalledCwds) {
      if (!stallSince.has(cwd)) stallSince.set(cwd, now);
      if (!stallToasted.get(cwd) && now - stallSince.get(cwd) >= POLL_INTERVAL_MS) {
        stallToasted.set(cwd, true);
        toAlert.push(cwd);
      }
    }
    if (toAlert.length > 0) {
      console.error(
        `[scheduler] STALL DETECTED in project(s): ${toAlert.join(', ')} — 0 running, 0 pending, not paused, `
        + `for >= ${Math.round(POLL_INTERVAL_MS / 1000)}s`,
        stall.byProject,
      );
      appendAuditEvent('scheduler_stall_detected', { projects: toAlert, total: stall.total, byProject: stall.byProject });
      if (mainWindow && !mainWindow.isDestroyed()) {
        sendIfAlive(mainWindow, 'schedule:stall', {
          message: `Scheduler stall in ${toAlert.length} project(s): ${toAlert.join(', ')}. Check the Scheduler tab.`,
          projects: toAlert,
          total: stall.total,
          byProject: stall.byProject,
        });
      }
    }

    appendHeartbeat({
      ts: Date.now(),
      pid: process.pid,
      counts,
      stall: { stalled: stall.stalled, total: stall.total },
      paused: s.paused ? { reason: s.paused.reason, resumeAt: s.paused.resumeAt } : null,
      nextReset: cachedNextReset,
      utilization: cachedUtilization,
      consecutiveFailures,
    });
  }, 60_000);
  if (heartbeatInterval.unref) heartbeatInterval.unref();

  // Wake-from-sleep: immediately re-poll and re-evaluate the queue.
  try {
    const { powerMonitor } = require('electron');
    powerMonitor.on('resume', () => {
      console.log('[scheduler] system resumed; re-polling and re-evaluating queue');
      if (pollLoopTimer) { clearTimeout(pollLoopTimer); pollLoopTimer = null; }
      backoffMs = 0;
      backoffNextAt = null;
      // Clear any paused-but-resumeAt-elapsed state immediately. Sync read:
      // the powerMonitor 'resume' callback fires rarely and isn't on the IPC
      // hot path; switching to async would require an IIFE wrapper for no gain.
      const wakeState = readQueueSync();
      if (wakeState.paused?.resumeAt && new Date(wakeState.paused.resumeAt).getTime() <= Date.now()) {
        clearPause('boot-elapsed').then(() => { runDueJobs().catch(() => {}); }).catch(() => {});
      }
      pollLoop().catch(() => {});
    });
  } catch (e) {
    console.warn('[scheduler] powerMonitor unavailable', e?.message);
  }
}

// Measured against this repo's own live+archived PRD set (868 entries
// across every local project — the admin route has no cwd filter by
// default): no single field dominates a listPrdsInternal() entry: title is
// the largest at ~30% of payload bytes, followed by slug/cwd/sourcePromptId/
// epicId at 12-14% each — the 353KB the route was shipping came from
// returning the full unbounded row count, not from one oversized field.
// This trims the fields an agent doesn't need to answer "what PRDs are
// there" (parallelGroup/estimateMinutes/sourcePromptId/epicId/
// archivedStatus); `fields=full` restores them.
function toCompactPrdEntry(entry) {
  const { slug, title, cwd, mtimeMs, archived, status, agentType } = entry;
  return { slug, title, cwd, mtimeMs, archived, status, agentType };
}

/**
 * listPrdsInternal() → every live + archived PRD across every project,
 * with each entry's real job status folded in (`status`: the live queue
 * row's status, or the resolved terminal status for an archived entry, or
 * null when no queue row exists yet — e.g. a PRD just written and not yet
 * picked up by reconcile()). Single source of truth for both the renderer's
 * `schedule:list-prds` IPC handler and the admin HTTP `GET
 * /admin/scheduler/prds` route (PRD 1024) — neither re-implements this scan.
 */
async function listPrdsInternal() {
  ensureDirs();
  const out = [];
  const seenSlugs = new Set();

  async function readDirInto(dir, { archived }) {
    let entries;
    try {
      entries = await fsp.readdir(dir);
    } catch (e) {
      if (e?.code !== 'ENOENT') {
        logs.writeLine({ level: 'warn', scope: 'scheduler', message: 'list-prds: readdir failed', meta: { dir, error: e?.message } });
      }
      return;
    }
    for (const name of entries) {
      if (!name.endsWith('.md') || name.startsWith('.')) continue;
      const filePath = path.join(dir, name);
      try {
        const parsed = await parsePrd(filePath);
        // A slug can't be both live and archived at once, but a duplicate
        // slug found in two archive dirs (shouldn't happen — archiving is
        // a single rename — but is cheap to guard) is skipped rather than
        // double-counted.
        if (seenSlugs.has(parsed.slug)) continue;
        seenSlugs.add(parsed.slug);
        const stat = await fsp.stat(filePath);
        const entry = {
          slug: parsed.slug,
          parallelGroup: parsed.parallelGroup,
          title: parsed.title,
          cwd: parsed.cwd || '',
          estimateMinutes: parsed.estimateMinutes,
          sourcePromptId: parsed.sourcePromptId,
          epicId: parsed.epicId ?? null,
          agentType: parsed.agentType ?? null,
          mtimeMs: stat.mtimeMs,
          archived,
        };
        out.push(entry);
      } catch (e) {
        logs.writeLine({ level: 'warn', scope: 'scheduler', message: 'list-prds: skipping unparseable file', meta: { name, error: e?.message } });
      }
    }
  }

  // Live PRDs first, so an archived duplicate (shouldn't exist, but a
  // stale rename copy is possible) never shadows the still-runnable live
  // entry.
  for (const dir of candidatePrdsDirs()) {
    await readDirInto(dir, { archived: false });
  }

  const archivedStart = out.length;
  for (const dir of candidateArchivedPrdsDirs()) {
    await readDirInto(dir, { archived: true });
  }

  // Every entry (live and archived) gets a real job status folded in.
  // Archived PRDs need one resolved defensively (live queue row, falling
  // back to history.jsonl) rather than hard-coded 'completed', so this
  // stays correct if the archive-only-completed invariant ever changes; a
  // live entry with no queue row yet (just written, not yet reconciled)
  // gets `status: null`.
  const [state, histBySlug] = await Promise.all([
    readQueue(),
    queueHistory.historyTerminalBySlug().catch(() => new Map()),
  ]);
  const liveStatusBySlug = new Map(state.jobs.map((j) => [j.slug, j.status]));
  for (let i = 0; i < out.length; i++) {
    const entry = out[i];
    // `entry` is a freshly-synthesized PRD-listing row, not a persisted
    // ScheduleJob — assigning its `status` here is not a queue-job status
    // transition (no queue.json row is mutated, no statusHistory/audit
    // trail applies), so it is intentionally exempt from the
    // transitionJob-only rule enforced by scheduleJobTransitionsGrep.test.cjs.
    if (i < archivedStart) {
      entry.status = liveStatusBySlug.get(entry.slug) ?? null;
    } else {
      entry.archivedStatus = resolveArchivedPrdStatus(entry.slug, liveStatusBySlug, histBySlug);
      entry.status = entry.archivedStatus;
    }
  }

  out.sort((a, b) => a.slug.localeCompare(b.slug, undefined, { numeric: true }));
  return out;
}

// remote — in-process (non-IPC) scheduler accessors, used by prdCreate.cjs
// and other main-process callers. (Named for the retired web-remote relay,
// its original consumer; kept because it still has in-process callers.)
const remote = {
  // `cwd` is optional: prdCreate.cjs's create flow passes the target
  // project's cwd explicitly (the file may not exist yet, so there's
  // nothing for findPrdDir to search for); the renderer's slug-only IPC
  // path (editing an already-queued PRD) omits it and relies on findPrdDir.
  async readPrd(slug, cwd) {
    let dir;
    if (cwd) {
      // The slug may live in the legacy flat dir or any Epic's prds/ under
      // this project; probe local dirs, defaulting to the flat dir (callers
      // use a miss there as the "doesn't exist yet" signal on create).
      const localDirs = [prdDirForCwd(cwd), ...listEpicPrdDirs(cwd)];
      dir = localDirs.find((d) => {
        const p = safeSlugPathIn(d, slug);
        return p && fs.existsSync(p);
      }) ?? prdDirForCwd(cwd);
    } else {
      dir = await findPrdDir(slug);
    }
    if (!dir) return { ok: false, error: 'invalid slug' };
    const filePath = safeSlugPathIn(dir, slug);
    if (!filePath) return { ok: false, error: 'invalid slug' };
    try {
      // realpath resolves symlinks; re-check boundary to block a rogue agent job
      // that places a symlink inside the PRDs dir pointing outside the safe root.
      const real = await fsp.realpath(filePath);
      if (!real.startsWith(dir + path.sep)) {
        return { ok: false, error: 'invalid slug' };
      }
      const text = await fsp.readFile(real, 'utf8');
      return { ok: true, text };
    } catch (e) {
      return { ok: false, error: e?.message };
    }
  },

  // `cwd` optional — see readPrd's comment above; prdCreate.cjs's create
  // flow supplies it (the destination project dir for a brand-new file that
  // doesn't exist yet, so findPrdDir would return nothing to write into).
  async writePrd(slug, body, cwd) {
    let dir;
    let epicTrace = null;
    if (cwd) {
      // Edit-in-place if this slug already lives anywhere under this project
      // (legacy flat dir or any Epic's prds/); otherwise this is a CREATE,
      // and every new PRD belongs to an Epic (CLAUDE.md domain model) — mint
      // one from the body's frontmatter title/tag.
      const localDirs = [prdDirForCwd(cwd), ...listEpicPrdDirs(cwd)];
      for (const d of localDirs) {
        const candidate = safeSlugPathIn(d, slug);
        if (candidate && fs.existsSync(candidate)) { dir = d; break; }
      }
      if (!dir) {
        // Every PRD must join an EXISTING, human-created Epic — ensureEpic
        // is join-only for every caller but the New Epic UI (epicMint.cjs's
        // SINGLE-CREATOR LAW), so this can never conjure one.
        const { fm } = splitFrontmatter(body);
        try {
          const epic = await ensureEpic(cwd, {
            // fm.sourcePromptId must be an existing Epic's promptSessionId
            // (== its active-index.json sessions key), NOT a
            // PromptTicket.id — epicMint.cjs's ensureEpic looks it up via
            // `index.sessions[explicitEpicId]` (see epicMint.cjs ~line 73),
            // a literal-equality join. Any other id (e.g. a PromptTicket.id)
            // simply won't match and this call throws below.
            epicId: fm.sourcePromptId,
            // Join-only call (no mintAuthority, explicit epicId): the
            // explicitEpicId branch in ensureEpic returns before `source` is
            // ever read, so this is a no-op today — kept for symmetry/audit
            // trail if that join path ever grows a source-touch.
            source: { producer: 'scheduler-dispatch', prdSlug: slug },
          });
          dir = epic.prdDir;
          epicTrace = epic.epicId;
        } catch (e) {
          return {
            ok: false,
            error: `no existing Epic to join (sourcePromptId=${fm.sourcePromptId ?? 'none'}): ${e?.message ?? 'unknown error'}. `
              + 'Create the Epic first via the New Epic UI, then pass its id as sourcePromptId.',
          };
        }
      }
      await fsp.mkdir(dir, { recursive: true });
    } else {
      dir = (await findPrdDir(slug)) ?? PRDS_DIR;
      if (dir === PRDS_DIR) ensureDirs();
    }

    // writePrd only ever JOINS an existing Epic now (no mintAuthority
    // above) — it can never mint one, so there is no orphaned-mint case left
    // to roll back here (contrast the old PRD 825/851 cleanup, removed).
    const resolved = safeSlugPathIn(dir, slug);
    if (!resolved) {
      return { ok: false, error: 'invalid slug' };
    }
    try {
      // Symlink defense, matching readPrd/readLog: safeSlugPathIn is lexical
      // and does NOT resolve symlinks, so a rogue job could plant a PRDs-dir
      // entry → an arbitrary $HOME path and have writeTextAtomic clobber it.
      // Resolve the real parent dir (the file itself may not exist yet) and
      // re-assert containment; also reject the target if it is already a
      // symlink.
      const realParent = await fsp.realpath(path.dirname(resolved));
      if (realParent !== dir && !realParent.startsWith(dir + path.sep)) {
        return { ok: false, error: 'invalid slug' };
      }
      const existing = await fsp.lstat(resolved).catch(() => null);
      if (existing && existing.isSymbolicLink()) {
        return { ok: false, error: 'invalid slug' };
      }
      await config.writeTextAtomic(resolved, body, { writer: 'scheduler' });
      const stat = await fsp.stat(resolved);
      if (epicTrace) {
        // Best-effort: record the dispatch on the Epic's event chain.
        try { await appendPrdCreatedEvent(cwd, epicTrace, slug); } catch { /* trace only */ }
      }
      return { ok: true, bytesWritten: stat.size, path: resolved, epicId: epicTrace };
    } catch (e) {
      return { ok: false, error: e?.message ?? 'write failed' };
    }
  },

  async resetJob(slug, opts = {}) {
    const resolved = await resolveSlugOrReason(slug, opts.cwd);
    if (!resolved.ok) {
      return { ok: false, error: resolved.reason === 'invalid-slug' ? 'invalid slug' : unknownSlugMessage(slug) };
    }
    const outcome = await mutate((state) => {
      // Same cwd filter as resolveSlugOrReason's file lookup above — slugs are
      // derived from title text with no cwd salt, so two different projects
      // can independently produce the identical slug; an opts.cwd caller must
      // reset THAT project's job, not just any queue row matching the string.
      const idx = state.jobs.findIndex((j) => j.slug === slug && (!opts.cwd || j.cwd === opts.cwd));
      if (idx < 0) return { kind: 'not-found' };
      // Terminal-status guard lives in resetJobFields itself; force:true
      // threads through to override it.
      if (!resetJobFields(state.jobs[idx], null, { force: opts.force === true, source: 'remote:resetJob' })) {
        return { kind: 'refused' };
      }
      return { kind: 'ok' };
    });
    if (outcome.kind === 'not-found') return { ok: false, error: 'not found' };
    if (outcome.kind === 'refused') {
      return {
        ok: false,
        error: 'job already completed — resetting it would re-execute shipped work; archive the PRD instead, or pass force:true',
      };
    }
    await broadcast({ flush: true });
    return { ok: true, slug, status: 'pending' };
  },

  async listJobs() {
    const state = await readQueue();
    return state.jobs.map((j) => ({ slug: j.slug, title: j.title, status: j.status, cwd: j.cwd, agentType: j.agentType ?? null }));
  },

  // Single queue row lookup, used by cancelJob/updatePrd's status guards and
  // the admin GET /admin/scheduler/prds?slug= route (PRD 1024).
  async getJob(slug) {
    const state = await readQueue();
    const job = state.jobs.find((j) => j.slug === slug);
    return job ? { slug: job.slug, title: job.title, status: job.status, cwd: job.cwd, error: job.error ?? null } : null;
  },

  // Every live+archived PRD across every project (listPrdsInternal, shared
  // with the renderer's schedule:list-prds IPC handler), filtered by the
  // admin route's cwd/epicId/status query params and paged by
  // limit/offset. Sort order is listPrdsInternal's own slug.localeCompare
  // (numeric) — stable across calls since it's a pure string sort, so
  // paging by offset can't skip or duplicate an entry between requests as
  // long as the underlying PRD set doesn't change mid-page.
  async listPrds(filter = {}) {
    const all = await listPrdsInternal();
    const filtered = all.filter((entry) => {
      if (filter.cwd && entry.cwd !== filter.cwd) return false;
      if (filter.epicId && entry.epicId !== filter.epicId) return false;
      if (filter.status && entry.status !== filter.status) return false;
      return true;
    });
    const total = filtered.length;
    const limit = filter.limit ?? 100;
    const offset = filter.offset ?? 0;
    const page = filtered.slice(offset, offset + limit);
    const prds = filter.fields === 'full' ? page : page.map(toCompactPrdEntry);
    return { prds, total, limit, offset, hasMore: offset + page.length < total };
  },

  // Full body + parsed frontmatter for one PRD, live or archived. Mirrors
  // readPrd's dir-search + symlink-defense pattern (see that method's
  // comment) rather than sharing code with it, since readPrd intentionally
  // returns raw text only and is a much narrower/hotter path (executeJob's
  // PRD re-reads) that shouldn't grow a second return shape.
  async getPrdParsed(slug, cwd) {
    let dir = null;
    let filePath = null;
    if (cwd) {
      for (const d of [prdDirForCwd(cwd), ...listEpicPrdDirs(cwd)]) {
        const p = safeSlugPathIn(d, slug);
        if (p && fs.existsSync(p)) { dir = d; filePath = p; break; }
      }
      if (!filePath) {
        for (const d of listArchivedPrdDirs(cwd)) {
          const p = safeSlugPathIn(d, slug);
          if (p && fs.existsSync(p)) { dir = d; filePath = p; break; }
        }
      }
    } else {
      dir = await findPrdDir(slug);
      filePath = dir ? safeSlugPathIn(dir, slug) : null;
      if (!filePath) {
        for (const d of candidateArchivedPrdsDirs()) {
          const p = safeSlugPathIn(d, slug);
          if (p && fs.existsSync(p)) { dir = d; filePath = p; break; }
        }
      }
    }
    if (!filePath) return { ok: false, error: 'invalid slug' };
    try {
      // Symlink defense, matching readPrd/writePrd's comment: safeSlugPathIn
      // is lexical and does not resolve symlinks.
      const real = await fsp.realpath(filePath);
      if (!real.startsWith(dir + path.sep)) return { ok: false, error: 'invalid slug' };
      const [raw, parsed] = await Promise.all([fsp.readFile(real, 'utf8'), prdParser.parsePrdRaw(real)]);
      return {
        ok: true,
        slug: parsed.slug,
        frontmatter: {
          title: parsed.title,
          cwd: parsed.cwd,
          estimateMinutes: parsed.estimateMinutes,
          parallelGroup: parsed.parallelGroup,
          sourcePromptId: parsed.sourcePromptId,
          sourceTabId: parsed.sourceTabId,
          epicId: parsed.epicId,
          dependsOn: parsed.dependsOn,
          createdVia: parsed.createdVia,
          issuedAt: parsed.issuedAt,
        },
        body: parsed.body,
        raw,
      };
    } catch (e) {
      return { ok: false, error: e?.message ?? 'read failed' };
    }
  },

  // Edits a NOT-yet-running PRD's frontmatter and/or body in place, refusing
  // once a queue row exists for it and that row is anything but 'pending'
  // (running/completed/failed/needs_review — editing the spec under a live
  // or already-finished executor would silently rewrite history). Reuses
  // prdFrontmatter.cjs's parsePrdFile/serializePrdFile round-trip pair (PRD
  // 1024) so unrecognized keys (e.g. dependsOn) and untouched recognized
  // keys' original line formatting survive unchanged.
  async updatePrd({ slug, cwd, frontmatter, body }) {
    const job = await this.getJob(slug);
    // 'quarantined' is also editable: it's the ONLY way a quarantined PRD's
    // createdVia stamp gets written (the adopt action below), so refusing it
    // here would make quarantine irreversible through the API.
    if (job && job.status !== 'pending' && job.status !== 'quarantined') {
      return { ok: false, error: `job status is "${job.status}" — only a not-yet-running PRD (status "pending"/"quarantined", or no queue row yet) may be edited` };
    }

    let dir = null;
    let filePath = null;
    if (cwd) {
      for (const d of [prdDirForCwd(cwd), ...listEpicPrdDirs(cwd)]) {
        const p = safeSlugPathIn(d, slug);
        if (p && fs.existsSync(p)) { dir = d; filePath = p; break; }
      }
    } else {
      dir = await findPrdDir(slug);
      filePath = dir ? safeSlugPathIn(dir, slug) : null;
    }
    if (!filePath) return { ok: false, error: 'PRD not found' };

    let raw;
    try {
      // Symlink defense, matching writePrd's comment: safeSlugPathIn is
      // lexical and does not resolve symlinks. updatePrd is a WRITE path
      // (unlike getPrdParsed's read-only realpath check), so also reject a
      // target that is itself already a symlink — a rogue job could plant
      // one inside the PRDs dir pointing outside the safe root.
      const real = await fsp.realpath(filePath);
      if (!real.startsWith(dir + path.sep)) return { ok: false, error: 'invalid slug' };
      const existing = await fsp.lstat(filePath).catch(() => null);
      if (existing && existing.isSymbolicLink()) return { ok: false, error: 'invalid slug' };
      raw = await fsp.readFile(real, 'utf8');
    } catch (e) {
      return { ok: false, error: e?.message ?? 'read failed' };
    }

    const { frontmatter: fm, body: origBody } = parsePrdFile(raw);
    if (frontmatter) {
      for (const key of Object.keys(frontmatter)) {
        if (frontmatter[key] === undefined) continue;
        fm[key] = frontmatter[key];
      }
    }
    const newBody = body !== undefined ? body : origBody;
    const newRaw = serializePrdFile(fm, newBody);

    try {
      await config.writeTextAtomic(filePath, newRaw, { writer: 'scheduler' });
      const stat = await fsp.stat(filePath);
      return { ok: true, slug, bytesWritten: stat.size };
    } catch (e) {
      return { ok: false, error: e?.message ?? 'write failed' };
    }
  },

  // Cancels a job that hasn't finished yet. A 'running' job's process group
  // is SIGTERM'd (reusing killOrphanClaudePid — the same kill path boot
  // reconciliation uses for an orphaned running job) before its queue row is
  // finalized; a 'pending' job has no process to kill. There is no
  // 'cancelled' status in the closed job-status set (pending/running/
  // completed/failed/needs_review — see CLAUDE.md's domain model), so a
  // cancelled job lands in 'failed' with an error naming the cause,
  // consistent with every other non-success terminal outcome. Refuses a
  // slug that's already terminal — nothing left to cancel.
  async cancelJob(slug, opts = {}) {
    if (!SCHEDULE_SLUG_RE.test(slug)) return { ok: false, error: 'invalid slug' };
    const state = await readQueue();
    const job = state.jobs.find((j) => j.slug === slug && (!opts.cwd || j.cwd === opts.cwd));
    if (!job) {
      return {
        ok: false,
        error: `unknown slug "${slug}": no queued job with that name${opts.cwd ? ` in cwd ${opts.cwd}` : ''} — call scheduler_list_jobs to see what exists`,
      };
    }
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'needs_review' || job.status === 'skipped') {
      return { ok: false, error: `job already terminal (status: "${job.status}") — nothing to cancel` };
    }
    const wasRunning = job.status === 'running';
    const pid = job.runtime?.pid;
    if (wasRunning && pid) {
      killOrphanClaudePid(pid);
    }
    await mutate((s) => {
      const idx = s.jobs.findIndex((j) => j.slug === slug);
      if (idx < 0) return;
      const j = s.jobs[idx];
      transitionJob(j, 'failed', { reason: 'cancelled via admin API', source: 'remote:cancelJob' });
      j.error = 'cancelled via admin API';
      j.finishedAt = new Date().toISOString();
      j.exitCode = j.exitCode ?? null;
      delete j.runtime;
    });
    await broadcast({ flush: true });
    return { ok: true, slug, status: 'failed', wasRunning, cwd: job.cwd ?? null };
  },

  // Exposes the module-level allocateParallelGroup (PRD 548) to callers that
  // only hold the `remote` object (lib/prdCreate.cjs's create-prd route) —
  // reuses the same allocator the file-based /develop authoring path relies
  // on implicitly, rather than re-deriving NN here.
  allocateParallelGroup,
};

// Registers the two job-management admin HTTP routes (PRD 689 — moved
// verbatim out of the former standalone admin HTTP server module's
// handleRequest, no behavior change) against an injected localAdminHttp.cjs
// transport. `remoteObj` is accepted as a parameter (defaults to this
// module's own `remote`) so the route logic stays testable in isolation
// without booting Electron, matching that former module's original
// dependency-injection pattern.
function registerAdminRoutes(adminHttp, remoteObj = remote) {
  adminHttp.registerRoute('GET', '/admin/scheduler/jobs', async (req, res) => {
    const jobs = await remoteObj.listJobs();
    sendJson(res, 200, jobs);
  });

  adminHttp.registerRoute('POST', '/admin/scheduler/reset-job', async (req, res) => {
    const raw = await readBody(req);
    let parsed;
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
      return;
    }
    const slug = typeof parsed.slug === 'string' ? parsed.slug : null;
    if (!slug) {
      sendJson(res, 400, { ok: false, error: 'missing slug' });
      return;
    }
    const force = parsed.force === true;
    const cwd = typeof parsed.cwd === 'string' ? parsed.cwd : undefined;
    const result = await remoteObj.resetJob(slug, { force, cwd });
    sendJson(res, 200, result);
  });
}

module.exports = { classifyQueueStarvation, runQueueStarvationWatchdog, QUEUE_STARVATION_MS, computeBlockedChains, stripAppOwnedChurn, findOverrunningJobs, JOB_OVERRUN_FACTOR, JOB_OVERRUN_FLOOR_MS, registerScheduleHandlers, attachWindow, init, ROOT, PRDS_DIR, healRefusalReason, writeQueue, reconcile, reconcileSourcePromptId, allocateParallelGroup, selectHistoryJobs, parsePorcelain, FINISH_PROTOCOL, IDLE_OUTPUT_KILL_MS, BASH_DEFAULT_TIMEOUT_MS, BASH_MAX_TIMEOUT_MS, remote, pickNextBatch, pickForProject, reapDeadRunningJobs, pollRecoveryClearSource, memoryLimitedBatchSize, availableForJobs, reverifyNeedsReview, isRescanCandidate, isFailedUnverifiedShaped, computeLooksDone, isPromotableOriginal, selectAutoFixTargets, applyRcaClassification, isEligibleForImmediateAutoFix, resolveRunId, isUnresolvableNeedsReview, isExhaustedAutoFix, isPlanUnqueued, fixSlugFor, healTargetForFix, buildInvestigationPrompt, isGitRepoSync, committedInWindow, computeCommittedDuringRun, classifySigtermWithCommit, isFixPlanSlug, isFixPlanBeyondDepthCap, MAX_INVESTIGATION_DEPTH, forceTickOutcome, applyPauseCleared, detectNetworkErrorInLog, detectRateLimitInLog, classifyFailureOutcome, commitGuardVerdict, leftoverFieldsFrom, applyLeftoverFields, LEFTOVER_PATHS_CAP, capDirtyPaths, buildForeignWipSection, PRE_RUN_DIRTY_PATHS_CAP, FOREIGN_WIP_DELIMITER, FOREIGN_WIP_END_DELIMITER, TRANSIENT_RETRY_CAP, buildScheduleStatePayload, partitionBootOrphans, applyOrphanOutcome, BOOT_ORPHAN_KILL_GRACE_MS, registerAdminRoutes, notifyOriginatingTab, notifyNeedsReview, isNotifiableTerminalStatus, extractResultTextFromLog, candidatePrdsDirs, candidateArchivedPrdsDirs, resolveArchivedPrdStatus, prdDirForCwd, prdPathForJob, archivedPrdPathForJob, archivedTwinExists, findPrdDir, resolveVerifyPrdPath, resolveFixPlanPath, resolveNotifyPrd, runPrdMigration, consolidateAllFlatPrds, shouldSkipInvestigationForCleanRun, archiveCompletedPrd, retireCompletedSlugs, SCHEDULER_BOOTED_AT, SCHEDULER_CODE_SHA, resetJobFields, executeJob, prdArchivedSkipResult, spawnJob, listPrdsInternal, computeStallSummary, findStaleQuarantinedJobs, QUARANTINE_ESCALATE_MS, applyClearQueueVictims, PIDLESS_SPAWN_GRACE_MS, findStrandedInvestigations, INVESTIGATION_MAX_MS, stashList, parseStashLine, pathsChangedSince, restoreSpecificStash, evaluateSharedTreeGuard, checkSharedTreeGuard, uncommittedChanges, gitHead, selectResumeRecoveryTarget, buildResumeRecoveryPreamble, buildClaudeSpawnArgs, spawnResumeRecovery, spawnInvestigation, computeLaunchHolds, handleLaunchFailure, applyLaunchFailure, setPaused, clearPause, tickQueue, runDueJobs, isCooldownSuppressed, nextRapidRateLimitCount, CONSECUTIVE_RAPID_RATE_LIMIT_THRESHOLD, RAPID_RATE_LIMIT_WINDOW_MS, MANUAL_PAUSE_COOLDOWN_MS, RUNS_DIR, pickRunDir };
