'use strict';

/**
 * reaperHelpers.cjs — pure helpers for the dead-process reaper in scheduler.cjs.
 *
 * Kept in a separate lib file so they can be unit-tested without importing
 * scheduler.cjs (which requires electron/ipcMain).
 */

const fs = require('node:fs');
const path = require('node:path');
const { readTail } = require('./fileTail.cjs');
const { detectRateLimitInLog } = require('./rateLimitDetect.cjs');

/**
 * Return true if pid is alive AND its cmdline looks like a claude process.
 *
 * Guards against PID recycling: on Linux we read /proc/<pid>/cmdline and
 * require /\bclaude\b/ in the command. On macOS (no /proc) we can't read
 * cmdline, so we conservatively return true — never false-reap a live PID
 * just because we can't verify its identity.
 *
 * Conservative by design: a false negative (live process treated as dead) is
 * far worse than a late reap.
 */
function claudePidAlive(pid) {
  if (!pid || typeof pid !== 'number' || pid <= 1) return false;
  try { process.kill(pid, 0); } catch { return false; }
  try {
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
    return /\bclaude\b/.test(cmd);
  } catch {
    // Can't read cmdline (macOS, permission denied) → assume alive.
    return true;
  }
}

/**
 * findLiveProcessForJob(job, { worktreeDir }) → pid | null
 *
 * Positive liveness scan for a 'running' row whose `runtime.pid` is missing —
 * the case a missing pid must NOT be read as "the process is gone" (2026-09-06
 * incident: 234-uranus-eight-tails-ox marked failed/never_ran while PID
 * 2174739 was a live `claude -p` still writing to that job's own worktree).
 *
 * Linux-`/proc` only. Scans every numeric `/proc/<pid>` entry and matches
 * either: `/proc/<pid>/cwd` resolves to `worktreeDir` (or a path nested under
 * it), or `/proc/<pid>/cmdline` contains both `claude` and the job's slug
 * (fallback for a worktree-disabled/in-place run, where there is no dedicated
 * worktreeDir to match against). Returns the first matching pid, or null if
 * none is found.
 *
 * Safe fallback by construction: on any platform without `/proc` (macOS,
 * Windows) `fs.readdirSync('/proc')` throws and this returns null immediately
 * — i.e. exactly today's behaviour (fail toward terminalizing), never a hang
 * or a thrown error propagating to the caller.
 */
function findLiveProcessForJob(job, { worktreeDir } = {}) {
  const slug = job?.slug;
  let entries;
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return null;
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (!pid || pid <= 1) continue;
    if (worktreeDir) {
      try {
        const cwdLink = fs.readlinkSync(`/proc/${pid}/cwd`);
        if (cwdLink === worktreeDir || cwdLink.startsWith(worktreeDir + path.sep)) return pid;
      } catch {
        // Process exited mid-scan, or permission denied — try the argv
        // fallback below before giving up on this pid.
      }
    }
    if (slug) {
      try {
        const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
        if (/\bclaude\b/.test(cmd) && cmd.includes(slug)) return pid;
      } catch {
        // Same as above — process gone or unreadable, keep scanning.
      }
    }
  }
  return null;
}

/**
 * True when `logPath` exists and has non-zero content — the literal "did the
 * run dir produce any log output" check that gates whether a pidless reap may
 * assert `gateOutcome: 'never_ran'`. A run whose log has real bytes in it DID
 * run, regardless of whether classifyRunOutcome found a clean result event in
 * it — asserting never_ran in that case would be a false claim (see
 * resolvePidlessGateOutcome below).
 */
function logHasOutput(logPath) {
  if (!logPath) return false;
  try {
    return fs.statSync(logPath).size > 0;
  } catch {
    return false;
  }
}

/**
 * Gate-outcome for a pidless reap, once no live process was found for it.
 * `never_ran` is asserted ONLY when the run dir produced no log output at
 * all — mapOutcomeToGateOutcome's own 'no_result' → 'never_ran' mapping is
 * otherwise too broad here: a log with real content but no clean result event
 * (e.g. killed mid-turn) proves the job DID run, so that case is reported as
 * 'failed' instead of the false 'never_ran'.
 */
function resolvePidlessGateOutcome(outcome, hasOutput) {
  if (!hasOutput) return 'never_ran';
  const mapped = mapOutcomeToGateOutcome(outcome);
  return mapped === 'never_ran' ? 'failed' : mapped;
}

/**
 * Classify the terminal outcome of a completed run by reading the last 64 KB
 * of its log file and scanning for the LAST `{"type":"result"}` JSONL event.
 *
 * Returns:
 *   'success'      — last result event has subtype=success and is_error !== true
 *   'rate_limited' — the log tail shows the same rate-limit signal spawnJob's own
 *                    live-process check uses (detectRateLimitInLog, the shared
 *                    single source of truth) — a NEW, distinct outcome from
 *                    'failed' (PRD 1117): a rate-limited death is retryable, not
 *                    a genuine gate failure, and must never collapse into 'failed'
 *   'failed'       — last result event exists but indicates a genuine error
 *   'no_result'    — no result event found in the tail (process may have been killed
 *                    before emitting one, or the log is absent/empty)
 *   'unknown'      — unexpected error reading/parsing (outer catch)
 */
function classifyRunOutcome(logPath) {
  try {
    const text = readTail(logPath, 65536);
    let lastResult = null;
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('{')) continue;
      try {
        const obj = JSON.parse(t);
        if (obj && obj.type === 'result') lastResult = obj;
      } catch { /* partial line at tail boundary or non-JSON scheduler log line */ }
    }
    // ORDER IS LOAD-BEARING. The rate-limit check must come AFTER the success
    // determination, never before it. The CLI emits an informational
    // `rate_limit_event` with status:"allowed_warning" on essentially every
    // run once utilization is non-zero, and detectRateLimitInLog matches its
    // "rateLimitType" field — so checking first classified genuinely
    // SUCCESSFUL runs as rate_limited. Measured on 2026-09-05 against the
    // eight most recent runs whose own meta.json recorded exitCode:0 and
    // rateLimited:false, four came back 'rate_limited' (e.g.
    // 200-campaign-toolkit-weak-points-and-stuns: 55 turns, is_error:false,
    // terminalReasonFromHarness:'completed', landed commit 7fd05f7 — matched
    // purely on an allowed_warning five_hour event). In reapDeadRunningJobs
    // that resets a finished job to 'pending' to re-run shipped work AND
    // engages setPaused('rate_limit') with no rate limit in effect — strictly
    // worse than the terminal-'failed' bug the rate_limit branch was added to
    // fix. See the guard test in this file's __tests__ sibling.
    if (lastResult && lastResult.subtype === 'success' && lastResult.is_error !== true) return 'success';
    // Still checked ahead of 'no_result': a run killed mid-flight by a rate
    // limit may never emit a result event at all, and that is a rate-limited
    // death, not silence.
    if (detectRateLimitInLog(logPath)) return 'rate_limited';
    if (!lastResult) return 'no_result';
    return 'failed';
  } catch {
    return 'unknown';
  }
}

/**
 * Map classifyRunOutcome()'s four-way result onto the smaller, persisted
 * `gateOutcome` a job row carries. 'no_result' really means the verdict gate
 * never fired — the process died or was killed before it could emit one —
 * a different fact from 'failed' (a verdict event exists and says error,
 * i.e. the gate ran and went red). Collapsing both behind the same free-text
 * `error` string is exactly the ambiguity this field exists to remove.
 */
function mapOutcomeToGateOutcome(outcome) {
  switch (outcome) {
    case 'success': return 'passed';
    case 'failed': return 'failed';
    case 'no_result': return 'never_ran';
    default: return 'unknown';
  }
}

// Max times an orphaned job may be re-queued before giving up (marking failed).
// Single source of truth: both the in-app reaper (scheduler.cjs) and the external
// offline watchdog (watchdogHelpers.cjs) import this so their give-up budgets can
// never drift apart (they increment the SAME j.orphanRetries field).
const ORPHAN_REQUEUE_CAP = 5;

/**
 * selectReapableJobs(jobs, now, { pidAlive, grace }) → { reapable, warnings }
 *
 * Pure predicate (no IO — `pidAlive` is injected) deciding which 'running'
 * rows reapDeadRunningJobs() should finalize this cycle. Two distinct dead
 * shapes:
 *  - has a runtime.pid, but the process is gone (pidAlive(pid) === false):
 *    the existing, unchanged behaviour.
 *  - has NO runtime.pid at all: previously skipped forever ("spawn may be
 *    mid-flight; give it a cycle" with no age bound). Now reaped once
 *    `startedAt` is older than `grace` — the spawn never got far enough to
 *    record a pid and nothing pid-bound can ever catch it (see
 *    PIDLESS_SPAWN_GRACE_MS's header for why the grace window is safe).
 *
 * A pidless row whose `startedAt` is missing or unparseable is neither
 * reaped nor skipped silently — age can't be proven, so it is surfaced in
 * `warnings` instead (the caller logs it) and left alone.
 *
 * `findLiveProcess` (optional, `(job) → pid | null`) is consulted for a
 * pidless row ONLY once its age clears `grace` — i.e. right before it would
 * otherwise be terminalized. A pid it finds means the process is actually
 * alive despite the missing runtime.pid record: the row is diverted into
 * `recovered` (never `reapable`) so the caller can re-stamp the pid and leave
 * the row `running`, instead of terminalizing a job that is still doing real
 * work (2026-09-06 incident — see findLiveProcessForJob's header). Omitting
 * `findLiveProcess` (existing callers/tests) preserves prior behaviour
 * exactly: every pidless row past grace reaps, none are ever recovered.
 */
/**
 * Pure, never-throws formatter for the dispatch-phase breadcrumb appended to
 * a pidless reap's reason string. Returns '' when the row carries no
 * breadcrumb at all (an older-build row, or one that never reached the
 * running-stamped mutate) so that case's message stays byte-identical to
 * the pre-breadcrumb text — nothing downstream that matches on it breaks.
 * A present `dispatchPhase` with a missing/unparseable `dispatchPhaseAt`
 * still names the phase, just without the `at <ts>` clause — the reaper
 * must stay a pure decision layer that cannot crash the tick over a
 * malformed timestamp.
 */
function formatDispatchPhaseSuffix(j) {
  if (!j || typeof j.dispatchPhase !== 'string' || !j.dispatchPhase) return '';
  const at = typeof j.dispatchPhaseAt === 'string' && !Number.isNaN(Date.parse(j.dispatchPhaseAt))
    ? j.dispatchPhaseAt
    : null;
  return at
    ? ` (last dispatch phase: ${j.dispatchPhase} at ${at})`
    : ` (last dispatch phase: ${j.dispatchPhase})`;
}

/**
 * resolvePidlessFailureOverride(job) → { verdict, landedCommit, reason } | null
 *
 * The evidence-before-failure guard this PRD adds (1173): a pidless reap
 * about to stamp 'failed' purely because `runtime.pid` was never recorded
 * must first check whether THIS ROW already carries a `landedCommit` — proof
 * (from an earlier dispatch of the same slug, since `landedCommit` is
 * deliberately never cleared by a reset — see scheduler.cjs's comment near
 * resetJobFields) that a real commit landed on the branch. Returns null when
 * there is no such evidence, leaving the existing 'failed' transition for a
 * genuinely-never-spawned row completely untouched.
 *
 * DESTINATION CHOICE — needs_review, never completed. `landedCommit` is
 * real git evidence (it is only ever stamped from an actual HEAD advance or
 * a proven branch-integration — see jobLandedCommitThisRun / the dead-pid
 * reap's own isBranchAlreadyIntegrated+computeCommittedDuringRun proof in
 * scheduler.cjs), so it is never speculative in the sense of "guessed before
 * the work ran". But the pidless-reap path performs NO fresh integration
 * check of its own for the CURRENT run (that proof only runs for the dead-pid
 * branch's `dead` entries with outcome==='success' — see
 * scheduler.cjs's integrationResults loop) — so at this call site there is no
 * re-verified guarantee that the recorded commit corresponds to *this*
 * dispatch rather than surviving, unreaped, from an earlier one. Real
 * evidence that under-specifies correspondence to the current run is exactly
 * the needs_review shape, not completed: a human (or the finish-protocol
 * commit-guard on the next dispatch) can resolve it conclusively with
 * `git show <sha>`, but this pure predicate must not guess.
 */
function resolvePidlessFailureOverride(job) {
  const landedCommit = job?.landedCommit || null;
  if (!landedCommit) return null;
  return {
    verdict: 'pidless_reap_with_landed_commit',
    landedCommit,
    reason: `pidless reap found no runtime.pid, but this row already carries landedCommit ${landedCommit} — routing to needs_review instead of failed; verify with \`git show ${landedCommit}\``,
  };
}

function selectReapableJobs(jobs, now, { pidAlive, grace, findLiveProcess } = {}) {
  const reapable = [];
  const warnings = [];
  const recovered = [];
  for (const j of jobs ?? []) {
    if (j.status !== 'running') continue;
    const pid = j.runtime?.pid;
    if (pid) {
      if (pidAlive(pid)) continue;
      reapable.push({ slug: j.slug, pid, pidless: false });
      continue;
    }
    const startedAt = Date.parse(j.startedAt ?? '');
    if (Number.isNaN(startedAt)) {
      warnings.push({ slug: j.slug, reason: 'pidless row with missing/unparseable startedAt — cannot prove age' });
      continue;
    }
    const ageMs = now - startedAt;
    if (ageMs < grace) continue; // spawn may still be mid-flight
    const livePid = typeof findLiveProcess === 'function' ? findLiveProcess(j) : null;
    if (livePid) {
      recovered.push({ slug: j.slug, pid: livePid });
      continue;
    }
    reapable.push({
      slug: j.slug,
      pid: null,
      pidless: true,
      reason: `reaped: no runtime.pid recorded after ${Math.round(grace / 60_000)}m — spawn never completed${formatDispatchPhaseSuffix(j)}`,
      failureOverride: resolvePidlessFailureOverride(j),
    });
  }
  return { reapable, warnings, recovered };
}

/**
 * isAlreadySatisfiedOnMain(commits) → { sha, verdict, reason } | null
 *
 * Pure decision layer for the finish-protocol commit-guard's second,
 * independently-evidenced route to 'completed' (PRD 1136). The commit-guard
 * in scheduler.cjs parks a clean exit / no-commit / clean-tree run as
 * `needs_review` ("finish protocol incomplete") because that shape is
 * normally the strongest signal that nothing happened — but it is also
 * exactly the shape a run produces when its PRD's work was ALREADY merged to
 * main before the run dispatched (2026-09-06: 1133-reaper-must-verify-
 * integration-before-completed and 1134-land-stranded-sm-job-branches, both
 * false-negatived this way and then auto-fix-minted a redundant `-fix-`
 * child against a codebase where the change was already present).
 *
 * Takes the already-git-queried list of commit SHAs (newest first, caller's
 * job — see scheduler.cjs's findSatisfyingCommitOnMain) that are reachable
 * from `main`, newer than the job's `queuedAt`, and touch the PRD's own
 * declared paths. Returns the winning verdict naming the satisfying sha, or
 * `null` when there is no such commit — the caller must then leave the
 * existing 'finish protocol incomplete' → needs_review verdict untouched.
 * This function never widens what counts as evidence; it only decides what
 * to do once the caller's git query has already proven a satisfying commit
 * exists, so it can never turn a genuine no-op into a false 'completed'.
 */
function isAlreadySatisfiedOnMain(commits) {
  if (!Array.isArray(commits) || commits.length === 0) return null;
  const sha = commits[0];
  return {
    sha,
    verdict: 'already_satisfied_on_main',
    reason: `already satisfied by ${sha} — a commit on main newer than this run's queuedAt already touches this PRD's declared paths`,
  };
}

/**
 * resolveCommitGuardOutcome(guardVerdict, satisfyingCommits) → verdict | null
 *
 * The full finalize-time decision this PRD adds: takes commitGuardVerdict's
 * own output (scheduler.cjs) plus the already-git-queried satisfying-commit
 * list (scheduler.cjs's findSatisfyingCommitOnMain) and decides which verdict
 * actually wins. Only ever touches the 'silent_no_op' shape — a guardVerdict
 * of null (no violation) or 'uncommitted_changes' (real dirt left behind)
 * passes through completely untouched, so this can never weaken the
 * uncommitted-changes guarantee PRD 1133 introduced. Pure — no I/O, no git —
 * so the whole finalize decision is directly unit-testable without spawning
 * a real job.
 */
function resolveCommitGuardOutcome(guardVerdict, satisfyingCommits) {
  if (!guardVerdict || guardVerdict.verdict !== 'silent_no_op') return guardVerdict ?? null;
  const satisfied = isAlreadySatisfiedOnMain(satisfyingCommits);
  if (!satisfied) return guardVerdict;
  return { verdict: satisfied.verdict, reason: satisfied.reason, satisfyingSha: satisfied.sha };
}

module.exports = {
  claudePidAlive,
  classifyRunOutcome,
  mapOutcomeToGateOutcome,
  ORPHAN_REQUEUE_CAP,
  selectReapableJobs,
  findLiveProcessForJob,
  logHasOutput,
  resolvePidlessGateOutcome,
  resolvePidlessFailureOverride,
  isAlreadySatisfiedOnMain,
  resolveCommitGuardOutcome,
  formatDispatchPhaseSuffix,
};
