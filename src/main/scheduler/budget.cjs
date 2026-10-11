/**
 * scheduler/budget.cjs — pure stall / stranded-row / job-overrun / wall-clock-budget
 * selectors, failure-streak/backoff predicates and the dependsOn history-satisfaction
 * lookup. Extracted verbatim from scheduler.cjs; the watchdogs and queue
 * mutations stay there and call in.
 */
'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { claudePidAlive } = require('../lib/scheduler/reaperHelpers.cjs');
const queueHistory = require('../lib/scheduler/queueHistory.cjs');
const { listArchivedPrdDirs } = require('../lib/prd/prdLocations.cjs');
const { LEGAL_TRANSITIONS } = require('../lib/scheduler/scheduleJobTransitions.cjs');
const { DEFAULT_PROJECT_CWD, DEP_HISTORY_FAIL_OPEN } = require('../lib/scheduler/schedulerBatch.cjs');
const {
  JOB_OVERRUN_FACTOR: JOB_OVERRUN_FACTOR_DEFAULT,
  JOB_OVERRUN_FLOOR_MS: JOB_OVERRUN_FLOOR_MS_DEFAULT,
  JOB_BUDGET_FACTOR: JOB_BUDGET_FACTOR_DEFAULT,
  JOB_BUDGET_FLOOR_MS: JOB_BUDGET_FLOOR_MS_DEFAULT,
  JOB_BUDGET_CEILING_MS: JOB_BUDGET_CEILING_MS_DEFAULT,
} = require('../lib/scheduler/schedulerConfig.cjs');

// Shared by every SM_*-env-overridable numeric constant below (bare factors
// use unitMs=1; minute-denominated knobs use unitMs=60_000) — one parse rule
// instead of one hand-copied ternary per constant.
function numEnvOverride(envVar, unitMs, fallback) {
  const raw = process.env[envVar];
  return raw ? Number(raw) * unitMs : fallback;
}
const JOB_OVERRUN_FACTOR = numEnvOverride('SM_JOB_OVERRUN_FACTOR', 1, JOB_OVERRUN_FACTOR_DEFAULT);
const JOB_OVERRUN_FLOOR_MS = numEnvOverride('SM_JOB_OVERRUN_FLOOR_MINUTES', 60_000, JOB_OVERRUN_FLOOR_MS_DEFAULT);
// Same three numbers as JOB_OVERRUN_FACTOR/JOB_OVERRUN_FLOOR_MS today (3x,
// 45min) is coincidental, not structural — this triad ACTS (kills) where
// JOB_OVERRUN_* only ever escalates (see JOB_OVERRUN_FACTOR's own header);
// tune them independently, don't re-couple on a future pass just because the
// defaults happen to match right now.
const JOB_BUDGET_FACTOR = numEnvOverride('SM_JOB_BUDGET_FACTOR', 1, JOB_BUDGET_FACTOR_DEFAULT);
const JOB_BUDGET_FLOOR_MS = numEnvOverride('SM_JOB_BUDGET_FLOOR_MINUTES', 60_000, JOB_BUDGET_FLOOR_MS_DEFAULT);
const JOB_BUDGET_CEILING_MS = numEnvOverride('SM_JOB_BUDGET_CEILING_MINUTES', 60_000, JOB_BUDGET_CEILING_MS_DEFAULT);

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
  // A drained queue (every row completed/skipped) is idle, not stalled — a
  // stall needs at least one parked problem row (failed/needs_review/
  // quarantined/invalid) that is waiting on someone.
  const isProblemStatus = (st) => st !== 'completed' && st !== 'skipped';
  const stalled = total > 0 && running === 0 && pending === 0 && !state?.paused
    && (invalidJobs.length > 0 || jobs.some((j) => isProblemStatus(j.status)));
  for (const key of Object.keys(byProject)) {
    const counts = byProject[key];
    const projRunning = counts.running || 0;
    const projPending = counts.pending || 0;
    const projTotal = Object.keys(counts)
      .filter((k) => k !== 'stalled')
      .reduce((sum, k) => sum + counts[k], 0);
    const projProblem = Object.keys(counts)
      .some((k) => k !== 'stalled' && k !== 'completed' && k !== 'skipped' && counts[k] > 0);
    counts.stalled = projTotal > 0 && projRunning === 0 && projPending === 0 && !state?.paused && projProblem;
  }
  return { stalled, total, running, pending, byProject };
}

/**
 * findStaleQuarantinedJobs(jobs, now, thresholdMs) → [{ slug, cwd, ageMs }]
 *
 * Pure, no IO. A 'quarantined' row (no createdVia provenance) can otherwise
 * sit forever with nothing looking at it — quarantine used to clear only via
 * a human adopting or archiving it; autoResolveQuarantine below now gives it
 * a bounded automatic exit too. This function stays the escalation/warn half
 * of that gate: any quarantined row whose recorded quarantine timestamp
 * (statusHistory's `to === 'quarantined'` entry — stamped at creation, or
 * backfilled from the PRD file's mtime by reconcile() for rows quarantined
 * before that stamp existed) is older than `thresholdMs` is reported so the
 * caller can warn-log and surface it distinctly. A row with no recoverable
 * timestamp is skipped rather than guessed at.
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
 * computeJobBudgetMs(estimateMinutes, { factor, floorMs, ceilingMs }) → number
 *
 * Pure. `budgetMs = clamp(estimateMinutes * factor, floorMs, ceilingMs)` — see
 * JOB_BUDGET_FACTOR's header comment (schedulerConfig.cjs) for the measured
 * p50/p90/max this is calibrated against. A missing/zero/non-finite estimate
 * is treated as 0, which the floor clamp then dominates — "jobs with a
 * missing estimate get the floor" falls straight out of the clamp, no
 * special-casing needed.
 */
function computeJobBudgetMs(estimateMinutes, { factor, floorMs, ceilingMs } = {}) {
  const f = typeof factor === 'number' && factor > 0 ? factor : JOB_BUDGET_FACTOR;
  const floor = typeof floorMs === 'number' && floorMs >= 0 ? floorMs : JOB_BUDGET_FLOOR_MS;
  const ceiling = typeof ceilingMs === 'number' && ceilingMs > 0 ? ceilingMs : JOB_BUDGET_CEILING_MS;
  const est = Number(estimateMinutes);
  const minutes = Number.isFinite(est) && est > 0 ? est : 0;
  return Math.min(Math.max(minutes * f * 60_000, floor), ceiling);
}

/**
 * classifyBudgetKill(res, landedCommitEvidence) → { status, reason, landedCommit } | null
 *
 * Pure. `res` is executeJob's resolved outcome — only fires when
 * `res.killedByWatchdog === 'budget'` (stamped by the budget watchdog inside
 * executeJob, never inferred from exit code/duration alone, so it can never
 * collide with an ordinary idle-tail/deadman/external kill). ALWAYS routes to
 * needs_review — never 'failed' (spawnJob's ordinary non-zero-exit default)
 * and never silently 'completed' (executeJob's onExit excludes
 * killedByWatchdog === 'budget' from the result=success → exit 0 mapping
 * idle-tail/deadman get) — so a budget kill is a visible, actionable park,
 * never a retry (classifyFailureOutcome/selectAutoFixTargets only ever see
 * 'failed'/ordinary needs_review rows, not this one — see
 * selectAutoFixTargets' own budget_exceeded exclusion) and never a discard:
 * `landedCommitEvidence`, when the caller resolved one via the SAME
 * commit-guard evidence check the plain sigterm/exit paths already use, is
 * threaded onto the row as `landedCommit` so a job that HAD already
 * committed before overrunning is still adjudicated on its git evidence.
 */
function classifyBudgetKill(res, landedCommitEvidence) {
  if (!res || res.killedByWatchdog !== 'budget') return null;
  return {
    status: 'needs_review',
    reason: res.budgetKillReason || `wall-clock budget exceeded (exit ${res.exitCode})`,
    landedCommit: landedCommitEvidence || null,
  };
}

/**
 * isJobBudgetExempt(job) → boolean
 *
 * Pure. `quietMachine: true` PRDs (their whole point is running alone,
 * un-contended, for a timing-sensitive measurement) and any PRD with an
 * explicit `budgetExempt: true` opt-out have no wall-clock kill ceiling.
 */
function isJobBudgetExempt(job) {
  return job?.quietMachine === true || job?.budgetExempt === true;
}

/** Pure predicate the budget watchdog's shouldFire calls — single source of
 * truth for "has this job run past its own budget" so it's unit-testable
 * without spinning up real timers. */
function shouldKillForBudget(elapsedMs, budgetMs) {
  return elapsedMs >= budgetMs;
}

/**
 * resolveBudgetKillOutcome({ killedByWatchdog, killedBySignal, durationMs, jobBudgetMs, estimateMinutes })
 *   → { killedByWatchdog: 'budget'|null, budgetKillReason: string|null }
 *
 * Pure. `ctx.killedByWatchdog` is stamped by the budget watchdog's action()
 * the instant its periodic shouldFire() observes elapsedMs >= jobBudgetMs —
 * but that setInterval tick and the child's real 'exit' event both run on
 * the SAME single-threaded event loop, so it's possible to observe the
 * budget threshold crossed and call ctx.killTree() in the same window the
 * agent happens to exit cleanly (exit 0) or fails on its own for an
 * unrelated reason — ctx.killTree() against an already-exited pid is a
 * silent no-op (ESRCH, caught), but the flag would still read 'budget'
 * unless gated here. Only trusted when the exit SHAPE actually looks like a
 * signal kill (killedBySignal — mirrors the exact same check onExit already
 * uses for its own mappedToSuccess exclusion), so a clean exit=0 or an
 * ordinary unrelated non-zero failure racing the watchdog's tick is never
 * misclassified as a budget kill downstream.
 */
function resolveBudgetKillOutcome({ killedByWatchdog, killedBySignal, durationMs, jobBudgetMs, estimateMinutes }) {
  if (killedByWatchdog !== 'budget' || !killedBySignal) {
    return { killedByWatchdog: killedByWatchdog === 'budget' ? null : (killedByWatchdog ?? null), budgetKillReason: null };
  }
  return {
    killedByWatchdog: 'budget',
    budgetKillReason: `wall-clock budget exceeded: ran ${Math.round(durationMs / 60_000)}m against a ${Math.round(jobBudgetMs / 60_000)}m budget (estimateMinutes=${estimateMinutes ?? 0})`,
  };
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

/**
 * computeDepHistorySatisfaction(state) → Map<cwd, Set<string>|symbol>
 *
 * PRD 1122's once-per-tick dependsOn history/archive lookup: for every
 * distinct project cwd with jobs this tick, builds the set of dep slugs that
 * have no live queue row but are nonetheless known-satisfied — a completed
 * record in that project's own `state/history.jsonl` shard
 * (queueHistory.completedSlugsForCwd, scoped per-project so a same-named PRD
 * in an unrelated project can never satisfy a dep here), or a `.md` file
 * under any of that project's `prds-archived/` dirs (listArchivedPrdDirs —
 * covers both the retired flat layout and every Epic's own sibling archive).
 * findBlockingDep (schedulerBatch.cjs) treats a dep slug as blocking
 * whenever it has no live row AND is absent from this set, so a typo or a
 * double-prefixed slug (the exact 2026-09-06 starry-night-ships incident)
 * HOLDS its dependent instead of silently dispatching it.
 *
 * Fails OPEN per project, never queue-wide: a history-shard or archive-scan
 * read error for one cwd degrades that cwd's value to
 * `DEP_HISTORY_FAIL_OPEN` (findBlockingDep then treats every rowless dep in
 * that project as satisfied, exactly today's pre-1122 behaviour) with a
 * logged warning — it never throws out of this function and never blocks
 * every OTHER project's dispatch for one project's bad fs state.
 *
 * Computed ONCE here, before pickNextBatch runs, and threaded down as pure
 * data (quietOpts.satisfiedSlugsByCwd) — schedulerBatch.cjs itself does no
 * I/O, so this is the only fs read this gate costs per tick, not one per job
 * per dep.
 */
async function computeDepHistorySatisfaction(state) {
  const byCwd = new Map();
  const cwds = new Set((state?.jobs || []).map((j) => j.cwd || DEFAULT_PROJECT_CWD));
  for (const cwd of cwds) {
    const satisfied = new Set();
    try {
      for (const slug of await queueHistory.completedSlugsForCwd(cwd)) satisfied.add(slug);
      for (const dir of listArchivedPrdDirs(cwd)) {
        let entries;
        try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
        for (const ent of entries) {
          if (ent.isFile() && ent.name.endsWith('.md')) { satisfied.add(ent.name.slice(0, -3)); continue; }
          // Option (b) of PRD 1286: a manual archive (queueOps.archiveOne, the
          // schedule:archive-prd route and scheduler_archive_prd MCP tool) files the PRD
          // under prds-archived/<ISO-ts>/<slug>.md — one level DEEPER than the auto-archive
          // layout. Reading only the top level made every manually-archived slug invisible
          // here, so once its row aged out its dependents held forever as 'unresolved'.
          // A dep whose PRD file was archived is satisfied; a dep with NO file, row or
          // history record (never ran, or a typo) still holds — nothing is dropped.
          if (!ent.isDirectory()) continue;
          let inner;
          try { inner = await fsp.readdir(path.join(dir, ent.name)); } catch { continue; }
          for (const name of inner) {
            if (name.endsWith('.md')) satisfied.add(name.slice(0, -3));
          }
        }
      }
    } catch (e) {
      console.warn(`[scheduler] depHistorySatisfaction: history/archive lookup failed for ${cwd} (${e?.message}) — falling back to fail-open dep resolution for this project this tick`);
      byCwd.set(cwd, DEP_HISTORY_FAIL_OPEN);
      continue;
    }
    byCwd.set(cwd, satisfied);
  }
  return byCwd;
}

// Bounded automatic exit for a quarantined row (this PRD): up to
// QUARANTINE_RESOLVE_CAP auto-resolve attempts, each gated on having sat
// `quarantined` for QUARANTINE_ESCALATE_MS, before autoResolveQuarantine
// below settles the row to 'skipped' rather than leaving it as a dead end
// only a human `scheduler_reset_job`/adopt action could ever clear. A single
// attempt is enough in practice — the outcome is terminal — but the counter
// still guards against two overlapping ticks both trying to resolve the
// same row.
const QUARANTINE_RESOLVE_CAP = 1;

/**
 * Kill-switch gate for the quarantine auto-resolve pass below
 * (SM_QUARANTINE_AUTORESOLVE_DISABLE=1), same shape as
 * failedAutoResetDisabled/needsReviewAutoResolveDisabled.
 */
function quarantineAutoResolveDisabled() {
  return process.env.SM_QUARANTINE_AUTORESOLVE_DISABLE === '1';
}

/**
 * selectQuarantineAutoResolveTargets(jobs, now, thresholdMs) →
 *   [{ slug, cwd, ageMs }]
 *
 * Pure selector — no IO. Same age computation as findStaleQuarantinedJobs
 * above, bounded additionally by quarantineResolveAttempts so a row already
 * auto-resolved (or mid-resolve on a race) is never re-selected. Deliberately
 * does NOT check createdVia here — that requires a disk read of the PRD
 * file, and doing it at selection time would let this pass act on a
 * snapshot that's gone stale by the time the mutate() pass actually runs.
 * autoResolveQuarantine below re-reads createdVia fresh, immediately before
 * transitioning, inside the same mutate() callback that applies this
 * selector's targets — see that function's own header for why.
 */
function selectQuarantineAutoResolveTargets(jobs, now, thresholdMs) {
  const targets = [];
  for (const j of jobs ?? []) {
    if (j.status !== 'quarantined') continue;
    if ((j.quarantineResolveAttempts ?? 0) >= QUARANTINE_RESOLVE_CAP) continue;
    const entry = (j.statusHistory || []).find((h) => h.to === 'quarantined');
    if (!entry) continue;
    const since = Date.parse(entry.at);
    if (Number.isNaN(since)) continue;
    const ageMs = now - since;
    if (ageMs < thresholdMs) continue;
    targets.push({ slug: j.slug, cwd: j.cwd ?? null, ageMs });
  }
  return targets;
}

// Ceiling on pollLoop's exponential poll backoff (both the 'transient'/'config'
// branch and the 'meter_rate_limited' branch below share this cap — a single
// constant so the two never drift to different ceilings).
const BACKOFF_MAX_MS = 480_000; // 8 minutes
// Threshold past which a growing consecutiveFailures streak stops being normal
// jitter and becomes worth a human's attention. health.cjs imports this so the
// WARN and the `npm run health` non-GREEN trip at the exact same count.
const FAILURE_STREAK_WARN_THRESHOLD = 5;
// How often a PERSISTING failure streak re-escalates (audit event +
// opsErrorLog line) after the initial WARN, and the health.cjs YELLOW->RED
// threshold for how long the usageCircuit has been open — one constant so
// the log cadence and the health-color flip never drift apart.
const FAILURE_STREAK_ESCALATION_MS = 30 * 60_000; // 30 minutes

/** Pure: exponential backoff with a cap, shared by every pollLoop failure branch. Exported for unit testing. */
function nextBackoffMs(prevBackoffMs) {
  return prevBackoffMs ? Math.min(prevBackoffMs * 2, BACKOFF_MAX_MS) : 30_000;
}

/**
 * Pure: should this failure count trigger the one-time streak WARN? Exported
 * for unit testing. `alreadyWarned` is the current streak's warned flag —
 * true for every failure after the threshold-crossing one, so this returns
 * true exactly once per streak.
 */
function shouldWarnFailureStreak(consecutiveFailures, alreadyWarned, threshold = FAILURE_STREAK_WARN_THRESHOLD) {
  return consecutiveFailures >= threshold && !alreadyWarned;
}

/**
 * Pure: `failureStreakWarned === true` must always carry a numeric
 * `failureStreakWarnedAt` (a state file may hold one without the other), so
 * the escalation message never renders "after nullm". Backfills `nowMs`.
 */
function restoreFailureStreakWarnedAt(warned, warnedAt, nowMs) {
  if (!warned) return typeof warnedAt === 'number' ? warnedAt : null;
  return typeof warnedAt === 'number' ? warnedAt : nowMs;
}

/** Pure: whole minutes a warned streak has persisted; never null/NaN. */
function persistedStreakMinutes(warnedAt, nowMs) {
  return typeof warnedAt === 'number' ? Math.round((nowMs - warnedAt) / 60_000) : 0;
}

/**
 * Pure: does a PERSISTING failure streak warrant another escalation (audit
 * event + opsErrorLog line) at `nowMs`? Exported for unit testing. Only
 * relevant once the streak has already crossed `warnThreshold` (the initial
 * WARN); `lastEscalatedAtMs` null means no escalation has fired yet this
 * streak, so the first one is due immediately. Re-arms automatically once a
 * streak clears (the caller resets `lastEscalatedAtMs` to null alongside
 * `failureStreakWarned`), so a later independent streak escalates again.
 */
function shouldEscalateFailureStreak(consecutiveFailures, lastEscalatedAtMs, nowMs, thresholdMs = FAILURE_STREAK_ESCALATION_MS, warnThreshold = FAILURE_STREAK_WARN_THRESHOLD) {
  if (consecutiveFailures < warnThreshold) return false;
  if (!lastEscalatedAtMs) return true;
  return nowMs - lastEscalatedAtMs >= thresholdMs;
}

/**
 * Leftover quarantine (PRD 1128). Resume-first recovery gets exactly one
 * `--resume` attempt (selectResumeRecoveryTarget above); when that attempt
 * ALSO parks needs_review with 'uncommitted_changes', the leftovers are
 * about to sit dirty in the SHARED tree forever — git then refuses any later
 * worktree merge for this cwd that would overwrite them, turning one parked
 * job into a project-wide stall (216-jupiter-sand-kazekage, 2026-09-06).
 * Pure/no I/O, mirroring selectResumeRecoveryTarget so the eligibility rule
 * is unit-testable directly.
 *
 * Bounded to exactly one attempt via job.leftoverQuarantineAttempted, stamped
 * synchronously by the caller in the SAME mutate as this decision (never
 * here) — see spawnJob's finalize and reverifyNeedsReview's periodic pass.
 *
 * Kill-switch: SM_LEFTOVER_QUARANTINE_DISABLE=1 restores today's behaviour
 * exactly (always returns null), mirroring SM_RESUME_RECOVERY_DISABLE.
 */
function selectLeftoverQuarantineTarget(job) {
  if (process.env.SM_LEFTOVER_QUARANTINE_DISABLE === '1') return null;
  if (!job || job.status !== 'needs_review') return null;
  if (job.verifierVerdict !== 'uncommitted_changes') return null;
  if (job.resumeRecoveryAttempted !== true) return null;
  if (job.leftoverQuarantineAttempted === true) return null;
  const uncommittedPaths = Array.isArray(job.uncommittedPaths)
    ? job.uncommittedPaths.filter((p) => typeof p === 'string' && p.length > 0)
    : [];
  if (!uncommittedPaths.length) return null;
  // The single most important constraint: never touch a path that was
  // ALREADY dirty at this run's own dispatch time (preRunDirtyPaths) — that
  // is foreign WIP (a human's or a sibling's), not this job's own leftover.
  const preRunDirty = new Set(Array.isArray(job.preRunDirtyPaths) ? job.preRunDirtyPaths : []);
  const paths = uncommittedPaths.filter((p) => !preRunDirty.has(p));
  if (!paths.length) return null;
  return { slug: job.slug, cwd: job.cwd, paths };
}

module.exports = {
  BACKOFF_MAX_MS,
  FAILURE_STREAK_WARN_THRESHOLD,
  FAILURE_STREAK_ESCALATION_MS,
  nextBackoffMs,
  shouldWarnFailureStreak,
  restoreFailureStreakWarnedAt,
  persistedStreakMinutes,
  shouldEscalateFailureStreak,
  selectLeftoverQuarantineTarget,

  QUARANTINE_RESOLVE_CAP,
  quarantineAutoResolveDisabled,
  selectQuarantineAutoResolveTargets,
  JOB_OVERRUN_FACTOR,
  JOB_OVERRUN_FLOOR_MS,
  JOB_BUDGET_FACTOR,
  JOB_BUDGET_FLOOR_MS,
  JOB_BUDGET_CEILING_MS,
  computeStallSummary,
  findStaleQuarantinedJobs,
  findOverrunningJobs,
  computeJobBudgetMs,
  classifyBudgetKill,
  isJobBudgetExempt,
  shouldKillForBudget,
  resolveBudgetKillOutcome,
  findStrandedInvestigations,
  computeDepHistorySatisfaction,
};
