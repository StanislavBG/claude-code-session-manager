/**
 * scheduler/starvation.cjs — pure queue starvation/health classifiers and the
 * dispatch-idle clock. Extracted verbatim from scheduler.cjs; the watchdog that
 * arms timers / forces ticks stays there and calls in. No IO, no timers.
 */
'use strict';

const launchFailure = require('../lib/launchFailure.cjs');
const { STARVE_ESCALATION_MS } = require('../lib/schedulerConfig.cjs');

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

/** How long a queue may hold ready work with nothing running before the
 *  starvation watchdog forces a tick. Deliberately longer than the poll
 *  loop's own cadence + backoff, so this only ever fires when the normal
 *  path has genuinely stopped driving the queue — it is a safety net, not a
 *  second scheduler. */
const QUEUE_STARVATION_MS = 10 * 60_000;

/**
 * dispatchIdleMs({ lastRunAtMs, lastPauseClearedAtMs, schedulerBootedAtMs, now }) → ms
 *
 * Pure. The ONE dispatch-idleness clock: `now - max(lastRunAt, lastPauseClearedAt,
 * schedulerBootedAt)`. `lastRunAt` has exactly one writer (tickQueue, right
 * before the spawn loop) so it already means "a batch actually launched";
 * a pause clear and a scheduler boot are the other two moments the queue
 * legitimately (re)starts. Deliberately NOT `lastDispatchAttemptAt`, which
 * tickQueue stamps before every gate — a queue that ticks every 30 s and
 * launches nothing (leaked slot, stuck hold) would refresh that stamp
 * forever and never look idle (the structural repeat of the f18e161 bug
 * where lastRunAt was refreshed every poll). No finite input → Infinity.
 */
function dispatchIdleMs({ lastRunAtMs, lastPauseClearedAtMs, schedulerBootedAtMs, now } = {}) {
  const stamps = [lastRunAtMs, lastPauseClearedAtMs, schedulerBootedAtMs].filter(Number.isFinite);
  return stamps.length ? now - Math.max(...stamps) : Infinity;
}

/**
 * launchBlockedSlugs(jobs, launchBlocks) → Set<slug>
 *
 * Pure, sync (health.cjs runs as a cold process). Pending rows whose persona
 * has ANY launch-breaker entry — a superset of computeLaunchHolds, which
 * additionally lets one half-open probe row through per persona.
 */
function launchBlockedSlugs(jobs, launchBlocks) {
  const out = new Set();
  if (!launchBlocks || !Object.keys(launchBlocks).length) return out;
  for (const j of Array.isArray(jobs) ? jobs : []) {
    if (j && j.status === 'pending' && launchBlocks[launchFailure.launchBlockKeyFor(j)]) out.add(j.slug);
  }
  return out;
}

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
function classifyQueueStarvation({ jobs, paused, runningCount, lastRunAtMs, lastPauseClearedAtMs, schedulerBootedAtMs, heldSlugs, now, thresholdMs = QUEUE_STARVATION_MS } = {}) {
  if (paused) return null;                      // paused is a DECISION, not a stall
  if (runningCount > 0) return null;            // work is flowing
  const rows = Array.isArray(jobs) ? jobs : [];
  const pending = rows.filter((j) => j && j.status === 'pending');
  if (pending.length === 0) return null;        // nothing to run — not a stall

  const idleMs = dispatchIdleMs({ lastRunAtMs, lastPauseClearedAtMs, schedulerBootedAtMs, now });
  if (idleMs < thresholdMs) return null;        // give the normal path its chance first

  // Which pending rows could actually dispatch? Anything NOT named by a
  // blocked chain (computeBlockedChains walks dependsOn with the picker's own
  // resolution, so the two can never disagree) and NOT held by an open launch
  // breaker / the quietMachine lease (`heldSlugs` — a separate input, never
  // folded into the dependsOn walker). Held rows can't launch no matter how
  // often we tick, so they read as 'blocked' (needs a human), not 'starved'.
  const blockedChains = computeBlockedChains(rows);
  const held = heldSlugs?.has ? heldSlugs : new Set(heldSlugs ?? []);
  const open = held.size > 0 ? rows.filter((j) => !(j.status === 'pending' && held.has(j.slug))) : rows;
  const openBlocked = held.size > 0 ? computeBlockedChains(open) : blockedChains;
  const openPending = open.filter((j) => j.status === 'pending').length;
  const dispatchable = openPending - openBlocked.reduce((n, c) => n + c.blocked, 0);

  return {
    kind: dispatchable > 0 ? 'starved' : 'blocked',
    pending: pending.length,
    dispatchable,
    blockedChains,
    idleMs,
  };
}

/**
 * classifyQueueStarvationByProject({ jobs, paused, runningSet, lastRunAtMs, now, thresholdMs })
 *   → [{ cwd, kind: 'starved' | 'blocked', pending, dispatchable, blockedChains, idleMs }]
 *
 * Per-project driver around classifyQueueStarvation's pure single-project
 * core. `runningCount > 0` inside that core used to be fed the MACHINE-WIDE
 * `runningSet.size`, which meant one long-lived job in ANY project disarmed
 * the watchdog for EVERY other project on the box — observed live
 * 2026-09-12: a job in starry-night-ships ran 80+ minutes while two other
 * projects sat starved/blocked for hours, and the watchdog never fired once
 * because "work is flowing" was true somewhere else. Partitioning by cwd
 * (the same grouping computeBlockedChains already does) fixes DETECTION only
 * — the idle clock (see dispatchIdleMs) stays machine-wide, since
 * `lastRunAt` is machine-level state, and only one tick is ever
 * forced per watchdog pass regardless of how many cwds are starved.
 *
 * Pure, no IO. Returns [] when paused (a DECISION, not a stall) or when no
 * project has a verdict.
 */
function classifyQueueStarvationByProject({ jobs, paused, runningSet: runningSlugs, lastRunAtMs, lastPauseClearedAtMs, schedulerBootedAtMs, heldSlugs, now, thresholdMs = QUEUE_STARVATION_MS } = {}) {
  if (paused) return [];
  const rows = (Array.isArray(jobs) ? jobs : []).filter(Boolean);
  const byCwd = new Map();
  for (const j of rows) {
    const key = j.cwd || '(unknown)';
    if (!byCwd.has(key)) byCwd.set(key, []);
    byCwd.get(key).push(j);
  }

  const verdicts = [];
  for (const [cwd, projectJobs] of byCwd) {
    // Same source of truth tickQueue itself uses for "is anything running":
    // the in-process runningSet OR a row already stamped status:'running'.
    const projRunningCount = projectJobs.filter(
      (j) => j.status === 'running' || runningSlugs?.has?.(j.slug),
    ).length;
    const verdict = classifyQueueStarvation({
      jobs: projectJobs,
      paused: false,
      runningCount: projRunningCount,
      lastRunAtMs,
      lastPauseClearedAtMs,
      schedulerBootedAtMs,
      heldSlugs,
      now,
      thresholdMs,
    });
    if (verdict) verdicts.push({ cwd, ...verdict });
  }
  return verdicts;
}

/**
 * classifyQueueHealth({ jobs, paused, launchBlocks, runningSet, freeSlots,
 *                        totalSlots, lastRunAtMs, lastPauseClearedAtMs, schedulerBootedAtMs, now, cwd, thresholdMs })
 *   → { kind, cwd, pending, dispatchable, blockedChains, needsReviewCount, runningCount, ... }
 *
 * Single source of truth for the Scheduler page's queue-health header: the
 * one thing a human staring at a stale-looking queue needs is "which of the
 * genuinely different causes is this" (all slots busy? every pending row
 * blocked on a dependency? the dispatch driver itself never ticked?) — this
 * function names that cause instead of leaving the renderer to re-derive it.
 *
 * Reuses classifyQueueStarvation for the blocked/stalled read so the header
 * can never disagree with runQueueStarvationWatchdog's own decision to force
 * a tick: both are handed the same launch-keyed idle clock (dispatchIdleMs) and
 * the same computeBlockedChains walk under the hood. Called here with
 * `thresholdMs: 0` first (a live header must say "blocked" the instant every
 * pending row is dependency-stuck, not wait out the watchdog's own 10-minute
 * grace period) — the returned `idleMs` is then compared against the REAL
 * `thresholdMs` to decide 'stalled' vs the healthy 'running' default, which
 * is exactly the comparison classifyQueueStarvation would make internally.
 *
 * `pending`/`dispatchable`/`blockedChains`/`needsReviewCount` are always
 * populated (via computeBlockedChains — the exact primitive
 * classifyQueueStarvation itself calls) regardless of kind, so a 'saturated'
 * or 'running' header can still say how much of the backlog is dependency-
 * blocked, not just the kinds where that's the headline cause.
 *
 * Kinds, in the priority order they're checked (paused is a decision, not a
 * stall; an open launch breaker explains an otherwise-inexplicable
 * non-dispatch before slot/dependency causes are even considered):
 *   'paused'         — the scheduler itself is paused.
 *   'launch-blocked' — a pending row's persona has an active circuit-breaker
 *                       entry (lib/launchFailure.cjs).
 *   'idle'           — nothing pending in this scope.
 *   'saturated'      — pending work exists but every session slot is in use.
 *   'blocked'        — nothing running, slots free, every pending row's
 *                       dependsOn chain terminates in a non-completed row.
 *   'stalled'        — nothing running, slots free, at least one row is
 *                       dispatchable right now, and the dispatch driver has
 *                       been idle >= thresholdMs (agrees with the watchdog).
 *   'running'        — the healthy default: work is flowing, or the driver
 *                       hasn't been idle long enough to call a stall yet.
 *
 * Pure, no IO. `cwd` scopes jobs/pending/blocked/needsReview to one project
 * (the Scheduler nav row is PROJECT-face — see CLAUDE.md); `freeSlots` /
 * `totalSlots` / `launchBlocks` stay machine-wide inputs by design, same as
 * WindowStrip's existing scopeCwd split.
 */
function classifyQueueHealth({
  jobs, paused, launchBlocks, runningSet: runningSlugs, freeSlots, totalSlots,
  lastRunAtMs, lastPauseClearedAtMs, schedulerBootedAtMs, now, cwd = null, thresholdMs = QUEUE_STARVATION_MS,
} = {}) {
  const rows = (Array.isArray(jobs) ? jobs : []).filter(Boolean);
  const projectJobs = cwd ? rows.filter((j) => j.cwd === cwd) : rows;
  const pendingRows = projectJobs.filter((j) => j.status === 'pending');
  const runningRows = projectJobs.filter((j) => j.status === 'running' || runningSlugs?.has?.(j.slug));
  const needsReviewCount = projectJobs.filter((j) => j.status === 'needs_review').length;

  // computeBlockedChains is the SAME primitive classifyQueueStarvation calls
  // internally, computed once here so EVERY kind (not just 'blocked'/
  // 'stalled') carries real dispatchable-vs-blocked counts instead of a null.
  const blockedChains = computeBlockedChains(projectJobs);
  const blockedTotal = blockedChains.reduce((n, c) => n + c.blocked, 0);
  const dispatchable = Math.max(0, pendingRows.length - blockedTotal);
  const base = {
    cwd, pending: pendingRows.length, dispatchable, blockedChains, needsReviewCount, runningCount: runningRows.length,
  };

  if (paused) return { ...base, kind: 'paused', reason: paused.reason ?? null };

  // launch-blocked: only a persona a PENDING row in this scope actually uses
  // — a breaker open for a persona nothing here needs is not this scope's
  // problem (matches WindowStrip's own unconditional-banner-per-block read).
  const neededAgentTypes = new Set(pendingRows.map((j) => launchFailure.launchBlockKeyFor(j)));
  for (const [key, block] of Object.entries(launchBlocks ?? {})) {
    if (block && neededAgentTypes.has(key)) {
      return { ...base, kind: 'launch-blocked', agentType: key, block };
    }
  }

  if (pendingRows.length === 0) return { ...base, kind: 'idle' };

  // classifyQueueStarvation only ever classifies while nothing is running
  // (its own runningCount > 0 guard) — that boundary is also exactly where
  // slot saturation, not dependency shape, is the honest cause.
  if (runningRows.length > 0) {
    if (Number.isFinite(freeSlots) && freeSlots <= 0) {
      return { ...base, kind: 'saturated', totalSlots: totalSlots ?? null };
    }
    return { ...base, kind: 'running' };
  }

  // Nothing running: hand the SAME rows + idle clock to classifyQueueStarvation
  // (thresholdMs: 0 — a live header must say "blocked" the instant every
  // pending row is dependency-stuck, not wait out the watchdog's own grace
  // period) purely for its idleMs reading; its own dispatchable/blockedChains
  // are mathematically identical to `base`'s (same computeBlockedChains walk
  // over the same rows), so `base` already carries them.
  const immediate = classifyQueueStarvation({
    jobs: projectJobs, paused: false, runningCount: 0,
    lastRunAtMs, lastPauseClearedAtMs, schedulerBootedAtMs, now, thresholdMs: 0,
  });
  // pending.length is already > 0 above, so `immediate` can only be null when
  // the clock stamp is itself in the future (clock skew) — fall back to
  // computing idleMs the same way rather than asserting a kind we can't
  // back up with a real number.
  const idleMs = immediate ? immediate.idleMs
    : dispatchIdleMs({ lastRunAtMs, lastPauseClearedAtMs, schedulerBootedAtMs, now });
  if (dispatchable === 0) return { ...base, kind: 'blocked', idleMs };
  const kind = idleMs >= thresholdMs ? 'stalled' : 'running';
  return { ...base, kind, idleMs };
}

/**
 * selectStarveEscalations(starvedProjects, escalatedCwds, thresholdMs)
 *   → { toEscalate: [...sp], toClear: [cwd, ...] }
 *
 * Pure. `starvedProjects` is this sweep's findStarvedProjects() output (the
 * per-cwd STARVED verdict — cwd, pendingCount, oldestPendingSlug, ageMs);
 * `escalatedCwds` is the Set already latched from a prior sweep.
 *
 * toEscalate: rows crossing thresholdMs for the FIRST time this stretch —
 * i.e. old enough AND not already latched.
 * toClear: previously-latched cwds no longer reported as starved at all this
 * sweep, so a LATER starve on that project escalates again instead of being
 * silently suppressed forever by a stale latch.
 */
function selectStarveEscalations(starvedProjects, escalatedCwds, thresholdMs = STARVE_ESCALATION_MS) {
  const stillStarved = new Set(starvedProjects.map((sp) => sp.cwd));
  const toClear = [...escalatedCwds].filter((cwd) => !stillStarved.has(cwd));
  const toEscalate = starvedProjects.filter((sp) => sp.ageMs >= thresholdMs && !escalatedCwds.has(sp.cwd));
  return { toEscalate, toClear };
}

module.exports = {
  computeBlockedChains,
  QUEUE_STARVATION_MS,
  STARVE_ESCALATION_MS,
  dispatchIdleMs,
  launchBlockedSlugs,
  classifyQueueStarvation,
  classifyQueueStarvationByProject,
  classifyQueueHealth,
  selectStarveEscalations,
};
