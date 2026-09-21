/**
 * health.cjs — health check for session-manager Electron app.
 * Verifies: app startup, IPC responsiveness, scheduler health, watchers active.
 * Exported as check() for /local-project-health skill.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { POLL_INTERVAL_MS, loadGateThreshold } = require('./lib/schedulerConfig.cjs');
const { opsPath } = require('./lib/opsOwnership.cjs');
const { effectivePaused } = require('./lib/upgradeDrain.cjs');
const { checkPersonaImports } = require('./lib/personaImportHealth.cjs');
const { checkDelegationReadiness } = require('./lib/delegationReadiness.cjs');
const { resolvePrdsDirs } = require('./lib/prdLocations.cjs');
const { migratePrds } = require('./lib/prdMigration.cjs');
const queueStore = require('./lib/queueStore.cjs');
const schedulerPaths = require('./lib/schedulerPaths.cjs');
const { evaluateDispatchLiveness } = require('./lib/watchdogHelpers.cjs');
const { computeStallSummary, computeDepHistorySatisfaction, FAILURE_STREAK_ESCALATION_MS, classifyQueueStarvation, launchBlockedSlugs, STARVE_ESCALATION_MS, REVERIFY_INTERVAL_MS } = require('./scheduler.cjs');
const { findStarvedProjects, findUnresolvableDepRoots, DEFAULT_PROJECT_CWD, DEP_HISTORY_FAIL_OPEN } = require('./lib/schedulerBatch.cjs');
const { auditLogPath, readTail } = require('./lib/auditLog.cjs');
const { resolveBuildIdentity } = require('./lib/buildIdentity.cjs');
const { DEFAULT_RUNS_DIR, computeReport, isRetentionEnabled, liveKeysFromJobs } = require('./lib/runLogRetention.cjs');
const { allProjectCwds } = require('./lib/activeSessions.cjs');
const { scanEpicTranscripts } = require('./lib/epicTranscriptDiagnostic.cjs');

const MAX_LOG_AGE_MS = 5 * 60_000; // 5 min — warn if no logs this old
const PROJECT_ROOT = path.resolve(__dirname, '../..');

// tickQueue() only fires (and updates lastRunAt) when a batch is actually
// spawned — it does not tick on a fixed cadence — but the poll loop that
// *invokes* tickQueue backs off starting from POLL_INTERVAL_MS (scheduler.cjs
// pollLoop). 3x gives the poll loop three chances to notice free capacity +
// pending work before we call it a stall, absorbing normal jitter (backoff,
// memory-gate deferrals, boot warmup) without waiting so long that a real
// outage goes unnoticed for hours (the 2026-07-14 incident sat stalled for
// 16.5h before anything asserted on it).
const TICK_STALL_MULTIPLIER = 3;
// A utilization hold whose reset is further out than this is not a routine 5h pause.
const LONG_HOLD_MS = 5 * 60 * 60_000;
const TICK_STALL_THRESHOLD_MS = TICK_STALL_MULTIPLIER * POLL_INTERVAL_MS;
// A heartbeat line older than this is treated as "the app isn't running /
// we can't observe live utilization" rather than "utilization is low" —
// scheduler-heartbeat.log is only appended to while Electron is running, so
// a stale line here is silent-on-purpose, not evidence of anything.
const HEARTBEAT_STALE_MS = 5 * 60_000;
const AUDIT_TAIL_BYTES = 1024 * 1024;

function runCheck(cmd, cwd = PROJECT_ROOT) {
  try {
    execFileSync('bash', ['-c', cmd], {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

// Reads the last line of scheduler-heartbeat.log, if fresh enough to trust.
// Returns null when the file is missing, empty, unparseable, or stale — all
// of which mean "can't observe live utilization right now", not "utilization
// is low".
function readFreshHeartbeat(heartbeatPath) {
  let lines;
  try {
    lines = fs.readFileSync(heartbeatPath, 'utf8').split('\n').filter(Boolean);
  } catch {
    return null;
  }
  if (lines.length === 0) return null;
  let entry;
  try {
    entry = JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
  if (entry.degraded === true) return null; // a subsystem threw — utilization was not read
  if (typeof entry.ts !== 'number' || Date.now() - entry.ts > HEARTBEAT_STALE_MS) return null;
  return entry;
}

// Evaluates whether the scheduler tick looks stalled: pending work exists,
// there's free capacity to run it, and nothing about the queue's own state
// explains why it hasn't. Kept as a pure function of (queueState, heartbeat,
// now) so it's testable without touching the filesystem.
function evaluateTickLiveness(queueState, heartbeat, now, runningCount) {
  const jobs = queueState.jobs || [];
  // A pending row whose dependsOn names a job that has not completed cannot be
  // dispatched yet — it is waiting on that job, not on a tick. Counting it made
  // a healthy dependsOn chain (one running, the rest waiting) read as a stall.
  const statusBySlug = new Map(jobs.map((j) => [j.slug, j.status]));
  const depsSatisfied = (j) => (j.dependsOn || []).every((d) => {
    const st = statusBySlug.get(d);
    return st === undefined || st === 'completed' || st === 'skipped';
  });
  const pending = jobs.filter((j) => j.status === 'pending' && depsSatisfied(j));
  const running = runningCount ?? jobs.filter((j) => j.status === 'running').length;
  const config = queueState.config || {};
  // The scheduler's private concurrencyCap is retired — the machine-wide
  // sessionSlots pool is the only limit. Read it lazily so this stays a pure
  // function of its args when a caller supplies slotCap explicitly.
  const concurrencyCap = queueState.slotCap
    ?? (() => { try { return require('./lib/sessionSlots.cjs').totalSlots(); } catch { return Infinity; } })();

  if (pending.length === 0) return { stalled: false, reason: 'no-pending-jobs' };
  if (effectivePaused(queueState)) return { stalled: false, reason: queueState.paused ? 'paused' : 'draining' };
  if (config.enabled === false) return { stalled: false, reason: 'disabled' };
  if (running >= concurrencyCap) return { stalled: false, reason: 'at-capacity' };
  // 'manual' means the operator fires batches by hand — the scheduler is not
  // supposed to pick these up on its own, so pending work sitting with free
  // capacity is the configured behaviour, not a stall. Without this, any queue
  // under a manual policy reported RED forever and drowned out real stalls.
  if (config.firePolicy === 'manual') return { stalled: false, reason: 'manual-fire-policy' };

  const lastRunAt = queueState.lastRunAt ? Date.parse(queueState.lastRunAt) : null;
  // No lastRunAt at all (fresh install, never ticked) — nothing to measure
  // staleness against yet; don't manufacture a false positive.
  if (lastRunAt == null || Number.isNaN(lastRunAt)) {
    return { stalled: false, reason: 'no-lastRunAt', caveat: true };
  }
  const tickAgeMs = now - lastRunAt;
  if (tickAgeMs <= TICK_STALL_THRESHOLD_MS) return { stalled: false, reason: 'recent-tick' };

  // Candidate stall. The 'when-available' firePolicy legitimately holds
  // pending jobs when billing utilization is at/above utilizationThreshold —
  // rule that out before calling it a stall.
  if (config.firePolicy === 'when-available' && typeof config.utilizationThreshold === 'number') {
    if (!heartbeat) {
      return {
        stalled: false,
        caveat: true,
        reason: 'cannot-verify-utilization',
        tickAgeMs,
        oldestPendingSlug: pending[0]?.slug,
      };
    }
    if (typeof heartbeat.utilization === 'number' && heartbeat.utilization >= config.utilizationThreshold) {
      // A hold on the binding window is benign only if it self-heals soon
      // (reset within 5h). A weekly hold, or an unknown reset horizon, can
      // last days — surface it rather than reading GREEN.
      const resetMs = heartbeat.nextReset ? Date.parse(heartbeat.nextReset) : NaN;
      const longHold = !Number.isFinite(resetMs) || resetMs - now > LONG_HOLD_MS;
      return {
        stalled: false,
        reason: 'utilization-at-threshold',
        utilization: heartbeat.utilization,
        window: heartbeat.utilizationWindow ?? null,
        nextReset: heartbeat.nextReset ?? null,
        ...(longHold ? { longHold: true } : {}),
      };
    }
  }

  return {
    stalled: true,
    reason: 'stalled',
    tickAgeMs,
    oldestPendingSlug: pending[0]?.slug,
    pendingCount: pending.length,
  };
}

// computeProjectProblemCounts(jobs) → { [cwd]: { failed, needs_review, quarantined } }
//
// health.cjs's machine-wide `failed` count answered "is the machine stuck",
// never "is any ONE project stuck" — a single project with 4 quarantined
// PRDs and nothing else running was invisible in a rollup dominated by other
// projects' healthy jobs. Breaks down every non-terminal-problem status
// (failed/needs_review/quarantined — deliberately NOT 'completed'/'running'/
// 'pending'/'investigating', which are not problems) by project cwd.
function computeProjectProblemCounts(jobs) {
  const byProject = {};
  for (const j of jobs || []) {
    if (j.status !== 'failed' && j.status !== 'needs_review' && j.status !== 'quarantined') continue;
    const cwd = j.cwd || '(unknown)';
    byProject[cwd] = byProject[cwd] || { failed: 0, needs_review: 0, quarantined: 0 };
    byProject[cwd][j.status] += 1;
  }
  return byProject;
}

// evaluateWorktreeCapBlocked(jobs, runningCount) → { ok, blocked, capBlockedSlugs? }
//
// The worktree cap (gitWorktree.cjs) can genuinely, correctly block every
// pending job at once — a real out-of-capacity condition, not a bug — but
// before this check existed that state was invisible to `npm run health`:
// nothing but a console.log line and a `heldReason` field on the row (see
// scheduler.cjs's spawnJob preflight). Rows in four separate project queues
// carried heldReason 'worktree cap reached (5 concurrent)' for 16 hours with
// zero entries in session-manager-operations/logs/ and nothing non-GREEN
// here. `runningCount === 0` is the load-bearing condition: while at least
// one job is running, the cap is doing its job as designed (bounding
// concurrency), not starving the queue.
function evaluateWorktreeCapBlocked(jobs, runningCount) {
  // queueStore.readMergedSync() hands back jobs as an object map (merged
  // across projects); other callers (tests, scheduler.cjs's own in-memory
  // state) pass a plain array — accept either rather than forcing every
  // caller to know this module's federated-storage detail.
  const jobList = Array.isArray(jobs) ? jobs : Object.values(jobs || {});
  const capBlocked = jobList.filter(
    (j) => j.status === 'pending' && /^worktree cap reached\b/.test(j.heldReason || '')
  );
  if ((runningCount ?? 0) === 0 && capBlocked.length > 0) {
    return {
      ok: false,
      blocked: true,
      capBlockedSlugs: capBlocked.map((j) => j.slug),
    };
  }
  return { ok: true, blocked: false };
}

// evaluatePerProjectStall(stallSummary, lastRunAtIso, now, thresholdMs) →
// { [cwd]: { stalled, pastThreshold?, ageMs?, caveat? } }
//
// computeStallSummary's per-project `stalled` flag (scheduler.cjs) is a
// point-in-time verdict with no duration attached — a project can flip
// stalled/unstalled within a single tick as work completes, so flagging RED
// the instant it's true would false-trip on ordinary queue churn. There is
// no per-project lastRunAt persisted (only a machine-wide one), so this
// reuses that machine-wide timestamp as the best available "has the
// scheduler ticked recently at all" signal, gated per-project by whether
// THAT project currently holds stalled work.
function evaluatePerProjectStall(stallSummary, lastRunAtIso, now, thresholdMs) {
  const lastRunAt = lastRunAtIso ? Date.parse(lastRunAtIso) : null;
  const results = {};
  for (const cwd of Object.keys(stallSummary?.byProject || {})) {
    const counts = stallSummary.byProject[cwd];
    if (!counts.stalled) {
      results[cwd] = { stalled: false };
      continue;
    }
    if (lastRunAt == null || Number.isNaN(lastRunAt)) {
      results[cwd] = { stalled: true, pastThreshold: false, caveat: 'no-lastRunAt' };
      continue;
    }
    const ageMs = now - lastRunAt;
    results[cwd] = { stalled: true, pastThreshold: ageMs >= thresholdMs, ageMs };
  }
  return results;
}

// Parses the "SIZE BUDGET — 12,000 chars" header line out of a project's
// CLAUDE.md text. Tolerant of the em-dash, bold markers, the leading
// blockquote '>', and the thousands comma. Returns null (not a throw, not a
// default) when the line is absent or unparseable — a CLAUDE.md that
// predates this convention has nothing to enforce, and that must stay a
// silent skip rather than a manufactured RED.
function parseClaudeMdBudget(text) {
  if (typeof text !== 'string') return null;
  const match = text.match(/SIZE BUDGET\s*[—-]+\s*([\d,]+)\s*chars/i);
  if (!match) return null;
  const n = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Pure comparison of CLAUDE.md's actual byte size against its self-declared
// budget (see parseClaudeMdBudget). budget === null means "no budget
// declared" — skip silently rather than treating it as 0 or infinite.
function evaluateClaudeMdBudget(chars, budget) {
  if (budget == null) return { ok: true, applicable: false };
  const overage = chars - budget;
  if (overage <= 0) return { ok: true, applicable: true, chars, budget };
  return {
    ok: false,
    applicable: true,
    chars,
    budget,
    overage,
    message: `CLAUDE.md is ${chars} chars, over its ${budget}-char budget by ${overage} (see the SIZE BUDGET note in CLAUDE.md)`,
  };
}

// Pure evaluator over migratePrds()'s { moved, skipped, unresolved } result —
// kept separate from the fs-touching check() call site so it's directly
// unit-testable, matching evaluateTickLiveness's pattern.
function evaluatePrdMigrationHealth(migrationResult, legacyPrdsDir) {
  const strandedCount = migrationResult.unresolved.length;
  return {
    ok: strandedCount === 0,
    legacyDir: legacyPrdsDir,
    strandedCount,
    ...(strandedCount > 0 ? { unresolved: migrationResult.unresolved } : {}),
  };
}

// Pure shaping of checkDelegationReadiness()'s result (delegationReadiness.cjs)
// into a health component + issue lines — kept separate from the fs-touching
// check() call site so it's directly unit-testable, matching
// evaluatePrdMigrationHealth's pattern. delegationReadiness.cjs already wraps
// every filesystem read (readJsonSafe / try-catch), so a missing/unreadable
// config surfaces here as one of `checks` with ok:false, never a throw.
function evaluateDelegationChainHealth(delegationResult) {
  const component = { ok: delegationResult.ok, checks: delegationResult.checks };
  const issues = delegationResult.checks
    .filter((c) => !c.ok)
    .map((c) => `Delegation readiness: ${c.label} failed — ${c.detail}${c.fix ? ` (fix: ${c.fix})` : ''}`);
  return { component, issues };
}

// computeEpicIndexDrift(cwd) → { orphan_rows, orphan_files, unmirrored,
//   orphanRowIds, orphanFileIds, unmirroredFiles }
//
// One project's drift between active-index.json (the index) and prompt-
// sessions/<id>.json (the status mirror epicStatusMirror.cjs writes on every
// status-changing write path). Pure filesystem read, never throws — an
// unreadable index or prompt-sessions dir degrades to empty rather than
// aborting the whole health check (matches evaluatePrdMigrationHealth's
// fail-open-on-read spirit).
function computeEpicIndexDrift(cwd) {
  let dir;
  try {
    dir = opsPath(cwd, 'prompt-sessions');
  } catch {
    return { orphan_rows: 0, orphan_files: 0, unmirrored: 0 }; // unusable cwd degrades to empty, same as an unreadable index below
  }
  const indexPath = path.join(dir, 'active-index.json');
  let sessions = {};
  let tombstones = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    sessions = parsed && typeof parsed.sessions === 'object' && parsed.sessions ? parsed.sessions : {};
    tombstones = parsed && typeof parsed.tombstones === 'object' && parsed.tombstones ? parsed.tombstones : {};
  } catch { /* missing/unreadable index — treat as empty, not a throw */ }

  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'active-index.json');
  } catch { /* prompt-sessions/ doesn't exist yet — nothing to compare */ }

  const fileIds = new Set(files.map((f) => f.slice(0, -'.json'.length)));
  const orphanRowIds = Object.keys(sessions).filter((id) => !fileIds.has(id));

  const orphanFileIds = [];
  const unmirroredFiles = [];
  for (const file of files) {
    const id = file.slice(0, -'.json'.length);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch {
      continue; // unreadable file — neither orphan nor unmirrored classification applies
    }
    if (!parsed || typeof parsed !== 'object' || !parsed.status) {
      unmirroredFiles.push(file);
      continue;
    }
    const looksLive = (parsed.status === 'proposed' || parsed.status === 'active') && !parsed.archivedAt;
    const hasRow = Object.prototype.hasOwnProperty.call(sessions, id);
    const isTombstoned = Object.prototype.hasOwnProperty.call(tombstones, id);
    if (looksLive && !hasRow && !isTombstoned) orphanFileIds.push(file);
  }

  return {
    orphan_rows: orphanRowIds.length,
    orphan_files: orphanFileIds.length,
    unmirrored: unmirroredFiles.length,
    orphanRowIds,
    orphanFileIds,
    unmirroredFiles,
  };
}

// evaluateEpicIndexHealth(cwds) → { component, issues }
//
// Shapes computeEpicIndexDrift's per-project result into a health component +
// issue lines, matching evaluateDelegationChainHealth's pattern. Only
// orphan_rows (an index row whose Epic file is gone — the actual data-loss
// signal) is an issue; orphan_files and unmirrored are informational drift,
// not failures — a fresh install or an Epic mid-migration legitimately has
// unmirrored files.
function evaluateEpicIndexHealth(cwds) {
  const byProject = {};
  const issues = [];
  let anyOrphanRows = false;
  for (const cwd of cwds) {
    const drift = computeEpicIndexDrift(cwd);
    byProject[cwd] = {
      orphan_rows: drift.orphan_rows,
      orphan_files: drift.orphan_files,
      unmirrored: drift.unmirrored,
    };
    if (drift.orphan_rows > 0) {
      anyOrphanRows = true;
      issues.push(
        `Epic index drift: ${cwd} has ${drift.orphan_rows} active-index.json row(s) with no matching `
        + `prompt-sessions/<id>.json file (${drift.orphanRowIds.join(', ')})`
      );
    }
  }
  return { component: { ok: !anyOrphanRows, byProject }, issues };
}

// Pure evaluator over ~/.claude/session-manager/scheduler-state.json's parsed
// content (the sidecar scheduler.cjs's pollLoop maintains for the billing
// usage-meter / rate-limit-window poller — see rateLimitPollerStreak tests).
// `state` null/missing means the poller has never run yet (fresh install) —
// not a failure, matches evaluatePrdMigrationHealth's fail-open-on-absence
// spirit. Kept separate from the fs-touching check() call site, same pattern
// as every other evaluate* helper in this file.
//
// Ladder is driven by the shared usageCircuit's OWN open/closed state and
// how long it's been open (usageCircuitState/usageCircuitOpenedAt, persisted
// by scheduler.cjs's persistSchedulerState — this process never holds the
// live in-memory circuit itself) — not a binary consecutiveFailures<5 check,
// which used to read GREEN right up until the exact failure that also fired
// the one-time WARN, then stayed flatly non-GREEN forever after with no way
// to tell "just tripped" from "down for hours" apart:
//   GREEN  — circuit closed (or half_open probing after a fresh backoff).
//   YELLOW — circuit open, less than FAILURE_STREAK_ESCALATION_MS (30 min).
//            Still `ok: true` — the circuit's OWN open threshold (3
//            consecutive failures, usageCircuit.cjs) is lower than the old
//            5-failure WARN, so treating YELLOW as `ok: false` here would
//            silently tighten the overall `npm run health` rollup's failure
//            bar from 5 down to 3. Graceful degradation (the whole point of
//            the breaker) should not itself read as a critical failure.
//   RED    — circuit open for FAILURE_STREAK_ESCALATION_MS or longer —
//            `ok: false`, matching the same 30-minute threshold the
//            escalation ladder (warnFailureStreakIfNeeded) re-alerts on.
function evaluateUsagePollerHealth(state, redThresholdMs = FAILURE_STREAK_ESCALATION_MS) {
  if (!state || typeof state !== 'object') return { ok: true, applicable: false };
  const consecutiveFailures = typeof state.consecutiveFailures === 'number' ? state.consecutiveFailures : 0;
  const backoffMs = typeof state.backoffMs === 'number' ? state.backoffMs : null;
  const lastPollAt = typeof state.lastPollAt === 'number' ? state.lastPollAt : null;
  const circuitState = typeof state.usageCircuitState === 'string' ? state.usageCircuitState : 'closed';
  const openedAt = typeof state.usageCircuitOpenedAt === 'number' ? state.usageCircuitOpenedAt : null;

  if (circuitState !== 'open' && circuitState !== 'half_open') {
    return { ok: true, applicable: true, color: 'GREEN', consecutiveFailures, backoffMs, lastPollAt };
  }

  const openMs = openedAt ? Math.max(0, Date.now() - openedAt) : 0;
  const color = openMs >= redThresholdMs ? 'RED' : 'YELLOW';
  return {
    ok: color !== 'RED',
    applicable: true,
    color,
    consecutiveFailures,
    backoffMs,
    lastPollAt,
    openedAt,
    openMs,
    message: `usage/rate-limit poller circuit is ${circuitState}, open for ${Math.round(openMs / 60_000)}m (${color}) — `
      + `${consecutiveFailures} consecutive failures, backoffMs=${backoffMs} — see logs scope=scheduler`,
  };
}

// Reads + parses a scheduler-state.json-shaped sidecar at `statePath`,
// classifying the outcome into exactly one of three shapes so the caller
// never has to distinguish "absent" from "corrupt" itself:
//   { missing: true }                — ENOENT: never run yet, not a failure
//   { errorMessage: string }         — unreadable OR unparseable (corrupt)
//   { state: object }                — parsed successfully
// Takes an explicit path (rather than reading SCHEDULER_STATE_PATH directly)
// so it's unit-testable against a real temp file instead of mocking global
// fs or exercising the full (slow, machine-coupled) check().
// A DISPATCHABLE pending job (not merely pending) with 0 running and no
// dispatch attempt in this long is the exact shape of the 2026-09-11
// incident (27 pending across two projects, 0 running, for days, every
// other surface reporting healthy). Deliberately much longer than
// scheduler.cjs's own QUEUE_STARVATION_MS (10 min) — that's the watchdog's
// OWN forcing threshold; this is the "even the watchdog isn't helping
// anymore" signal a human needs to see.
const DISPATCH_STALL_THRESHOLD_MS = 2 * 60 * 60_000;
// Early-warning tier off the SAME launch-keyed clock (lastRunAt — a batch
// actually launched): still ok:true, but flagged so a slow leak surfaces
// well before the 2-hour cold-report threshold.
const DISPATCH_WARN_THRESHOLD_MS = 15 * 60_000;

/**
 * evaluateQueueDispatchHealth(queueState, runningCount, now, thresholdMs) →
 * { ok, blocked?, starved?, pending?, dispatchable?, idleMs?, message? }
 *
 * Reuses classifyQueueStarvation's own verdict rather than re-deriving a
 * second "is the queue stuck" heuristic — evaluateTickLiveness above already
 * has one, but it does not distinguish a genuinely blocked dependsOn chain
 * (which no amount of ticking can fix) from real dispatchable starvation, so
 * reusing it here would report a dependency-blocked project as unhealthy
 * dispatch even though nothing is actually wrong with dispatch itself. A
 * `blocked` verdict therefore stays `ok: true` (never trips the health gate)
 * but is still reported by name so it isn't silently invisible either.
 */
function evaluateQueueDispatchHealth(queueState, runningCount, now, thresholdMs = DISPATCH_STALL_THRESHOLD_MS, warnMs = DISPATCH_WARN_THRESHOLD_MS) {
  // Clock = lastRunAt (launches), never lastDispatchAttemptAt (loop-alive
  // heartbeat, refreshed by ticks that launch nothing). Cold process: no
  // in-memory pause/boot stamps to fold in. Breaker-held rows count blocked.
  const verdict = classifyQueueStarvation({
    jobs: queueState?.jobs,
    paused: effectivePaused(queueState),
    runningCount,
    lastRunAtMs: Date.parse(queueState?.lastRunAt ?? ''),
    heldSlugs: launchBlockedSlugs(queueState?.jobs, queueState?.launchBlocks),
    now,
    thresholdMs: Math.min(warnMs, thresholdMs),
  });
  if (!verdict) return { ok: true };
  if (verdict.kind === 'blocked') {
    return {
      ok: true,
      blocked: true,
      pending: verdict.pending,
      message: `${verdict.pending} pending job(s) behind a blocked dependsOn chain or open launch breaker — dispatch cannot help, needs a human`,
    };
  }
  const ageMin = Math.round(verdict.idleMs / 60_000);
  const critical = verdict.idleMs >= thresholdMs;
  return {
    ok: !critical,
    ...(critical ? { starved: true } : { warn: true }),
    pending: verdict.pending,
    dispatchable: verdict.dispatchable,
    idleMs: verdict.idleMs,
    message: `${verdict.dispatchable} dispatchable pending job(s), 0 running, no launch in ~${ageMin}m `
      + (critical
        ? `(threshold ${Math.round(thresholdMs / 60_000)}m) — dispatch appears stuck`
        : `(warn at ${Math.round(warnMs / 60_000)}m, fail at ${Math.round(thresholdMs / 60_000)}m) — dispatch may be stalling`),
  };
}

/**
 * evaluateUnresolvableDepHealth(jobs, satisfiedSlugsByCwd) →
 *   { ok, projects?: [{ cwd, roots, pending }], message? }
 *
 * Pure. A project whose EVERY pending row is held (directly or transitively)
 * behind a dependsOn slug that names no live row and no history/archive
 * record is fully blocked with a healthy engine — the 2026-09-18 fo-01 stall
 * (21 pending rows, 0 running, one archived root, every other component
 * GREEN). classifyQueueStarvation's 'blocked' kind cannot see this shape (it
 * only walks failed/skipped ROWS), and evaluateQueueDispatchHealth keeps
 * 'blocked' ok:true by design, so this is the component that fails it, naming
 * the root slug(s). Reuses the picker's own resolver (findUnresolvableDepRoots)
 * so health can never disagree with what dispatch actually holds. A project
 * with anything running, or any dispatchable pending row, is not fully blocked.
 * O(jobs + deps) per project; a fail-open project (history unreadable) is skipped.
 */
function evaluateUnresolvableDepHealth(jobs, satisfiedSlugsByCwd) {
  const byCwd = new Map();
  for (const j of Array.isArray(jobs) ? jobs : []) {
    if (!j) continue;
    const cwd = j.cwd || DEFAULT_PROJECT_CWD;
    if (!byCwd.has(cwd)) byCwd.set(cwd, []);
    byCwd.get(cwd).push(j);
  }
  const projects = [];
  for (const [cwd, rows] of byCwd) {
    const satisfied = satisfiedSlugsByCwd?.get?.(cwd) ?? new Set();
    if (satisfied === DEP_HISTORY_FAIL_OPEN) continue;
    const pending = rows.filter((j) => j.status === 'pending');
    if (pending.length === 0 || rows.some((j) => j.status === 'running')) continue;
    const roots = findUnresolvableDepRoots(rows, satisfied);
    if (roots.length === 0) continue;
    const rootSet = new Set(roots);
    const bare = (x) => String(x ?? '').replace(/^\d+-/, '');
    const held = new Set();
    let grew = true;
    while (grew) {
      grew = false;
      for (const j of pending) {
        if (held.has(j.slug)) continue;
        const isHeld = (j.dependsOn ?? []).some((d) => rootSet.has(d)
          || pending.some((p) => held.has(p.slug) && (p.slug === d || bare(p.slug) === bare(d))));
        if (isHeld) { held.add(j.slug); grew = true; }
      }
    }
    if (held.size === pending.length) projects.push({ cwd, roots, pending: pending.length });
  }
  if (projects.length === 0) return { ok: true };
  return {
    ok: false,
    projects,
    message: projects
      .map((p) => `${p.cwd}: all ${p.pending} pending job(s) held behind unresolvable dependsOn root ${p.roots.join(', ')} `
        + '(no live row, no history/archive record) — restore its completion record or fix the dependsOn')
      .join('; '),
  };
}

/**
 * latestStarveEscalationReasons(auditLogPath) → { [cwd]: holdReason }
 *
 * health.cjs runs as its own cold process (`npm run health`), so it has no
 * access to the live scheduler's in-memory `lastTick` — the durable
 * audit-log.jsonl trail (auditLog.cjs) is the only place the hold reason a
 * 'project_starve_escalated' event already recorded (scheduler.cjs's
 * runStarveEscalationSweep) survives to be read from here. Reads the SAME
 * recorded value rather than re-deriving it; the last record per cwd wins.
 * Missing/unreadable log → {} (no reasons known yet), never a throw.
 */
function latestStarveEscalationReasons(auditLogPath) {
  // Bounded reverse tail — the log is never rotated (28 MB+), and the latest
  // escalation per cwd is by definition recent.
  const lines = readTail(AUDIT_TAIL_BYTES, auditLogPath);
  const byCwd = {};
  for (const line of lines) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec?.kind === 'project_starve_escalated' && rec.cwd) byCwd[rec.cwd] = rec.holdReason ?? 'unknown';
  }
  return byCwd;
}

/**
 * evaluateBuildFreshness({running, installedOnDisk, repoHead}) → component
 *
 * Pure; each input is a short git sha or null. restartNeeded: the on-disk
 * install differs from what the live heartbeat says is running. publishNeeded:
 * repo HEAD differs from the installed build. Both are reported, neither is
 * critical (never flips status.ok).
 */
function evaluateBuildFreshness({ running = null, installedOnDisk = null, repoHead = null } = {}) {
  const differs = (a, b) => !!a && !!b && !(a.startsWith(b) || b.startsWith(a));
  const restartNeeded = differs(running, installedOnDisk);
  const publishNeeded = differs(repoHead, installedOnDisk);
  const notes = [];
  if (restartNeeded) notes.push(`restart needed: running ${running}, installed ${installedOnDisk}`);
  if (publishNeeded) notes.push(`publish needed: repo HEAD ${repoHead}, installed ${installedOnDisk}`);
  return { ok: true, running, installedOnDisk, repoHead, restartNeeded, publishNeeded, ...(notes.length ? { note: notes.join('; ') } : {}) };
}

/**
 * evaluateStarveEscalationHealth(jobs, now, thresholdMs, escalationReasons)
 *   → { ok, projects?, message? }
 *
 * Pure over its inputs. Reuses findStarvedProjects — the exact per-cwd
 * STARVED verdict the live escalation (scheduler.cjs) acts on — so health
 * reports the identical set of starved-past-threshold projects, never a
 * re-derived one. `escalationReasons` supplies the hold reason per cwd (see
 * latestStarveEscalationReasons); a cwd with no recorded reason yet reports
 * 'unknown' rather than failing.
 */
function evaluateStarveEscalationHealth(jobs, now, thresholdMs, escalationReasons = {}) {
  const starved = findStarvedProjects(jobs, now, thresholdMs);
  if (starved.length === 0) return { ok: true };
  const projects = starved.map((sp) => ({
    cwd: sp.cwd,
    pendingCount: sp.pendingCount,
    ageMs: sp.ageMs,
    holdReason: escalationReasons[sp.cwd] ?? 'unknown',
  }));
  const message = `Project(s) starved past the ${Math.round(thresholdMs / 60_000)}m escalation threshold: ${
    projects.map((p) => `${p.cwd} (${Math.round(p.ageMs / 60_000)}m, ${p.pendingCount} pending, hold=${p.holdReason})`).join('; ')
  }`;
  return { ok: false, projects, message };
}

function loadUsagePollerState(statePath) {
  let raw;
  try {
    raw = fs.readFileSync(statePath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { missing: true };
    return { errorMessage: `cannot read scheduler-state.json: ${e.message}` };
  }
  try {
    return { state: JSON.parse(raw) };
  } catch (parseErr) {
    return { errorMessage: `scheduler-state.json is corrupt: ${parseErr.message}` };
  }
}

/**
 * evaluateBlockingParkHealth(jobs, now, thresholdMs = REVERIFY_INTERVAL_MS) →
 *   { ok, parks?: [{ cwd, slug, verdict, ageMs, dependents }], message? }
 *
 * Pure. A `needs_review` row parked longer than one full periodic-reverify
 * interval that STILL holds >= 1 pending dependent (transitively, through
 * pending rows, via dependsOn — exact or bare slug, same matching as the
 * picker) is a silently-blocking park: the self-heal ladder had a full pass
 * and did not release it. 2026-09-18: 1229-fo-03 held 19 of 20 pending rows
 * while every other component read GREEN. Parked-since is the row's last
 * `to: needs_review` statusHistory entry (fallback finishedAt); a row with no
 * recoverable timestamp is skipped rather than guessed at. O(jobs + deps).
 */
function evaluateBlockingParkHealth(jobs, now, thresholdMs = REVERIFY_INTERVAL_MS) {
  const rows = (Array.isArray(jobs) ? jobs : []).filter(Boolean);
  const bare = (x) => String(x ?? '').replace(/^\d+-/, '');
  const byCwd = new Map();
  for (const j of rows) {
    const cwd = j.cwd || DEFAULT_PROJECT_CWD;
    if (!byCwd.has(cwd)) byCwd.set(cwd, []);
    byCwd.get(cwd).push(j);
  }
  const parks = [];
  for (const [cwd, group] of byCwd) {
    const pending = group.filter((j) => j.status === 'pending');
    if (pending.length === 0) continue;
    for (const park of group) {
      if (park.status !== 'needs_review') continue;
      const history = Array.isArray(park.statusHistory) ? park.statusHistory : [];
      let at = null;
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i]?.to === 'needs_review') { at = history[i].at; break; }
      }
      const since = Date.parse(at ?? park.finishedAt ?? '');
      if (Number.isNaN(since) || now - since <= thresholdMs) continue;
      const held = new Set();
      const heldBy = (d, root) => root.slug === d || bare(root.slug) === bare(d);
      let grew = true;
      while (grew) {
        grew = false;
        for (const j of pending) {
          if (held.has(j.slug)) continue;
          if ((j.dependsOn ?? []).some((d) => heldBy(d, park) || pending.some((p) => held.has(p.slug) && heldBy(d, p)))) {
            held.add(j.slug);
            grew = true;
          }
        }
      }
      if (held.size > 0) parks.push({ cwd, slug: park.slug, verdict: park.verifierVerdict ?? null, ageMs: now - since, dependents: held.size });
    }
  }
  if (parks.length === 0) return { ok: true };
  return {
    ok: false,
    parks,
    message: parks
      .map((p) => `${p.slug} (${p.cwd}) parked needs_review${p.verdict ? `/${p.verdict}` : ''} for ${Math.round(p.ageMs / 60_000)}m `
        + `(> one ${Math.round(REVERIFY_INTERVAL_MS / 60_000)}m reverify interval) is blocking ${p.dependents} pending dependent(s) — `
        + 'the self-heal ladder did not release it; resolve it or scheduler_reset_job')
      .join('; '),
  };
}

// opts.skipTypecheck: skip the whole-repo `tsc` shell-out (~15s idle, unbounded under CPU load).
// For callers that assert on one other component; the typescript component is then
// reported { ok: true, skipped: true } so it can never read as a real pass.
async function check(opts = {}) {
  const start = Date.now();
  const status = {
    ok: true,
    timestamp: new Date().toISOString(),
    components: {},
    issues: [],
  };

  // 1. Check Node.js and key dependencies exist.
  try {
    const nodeVer = execFileSync('node', ['--version'], { encoding: 'utf8' }).trim();
    status.components.nodejs = { ok: true, version: nodeVer };
  } catch (e) {
    status.components.nodejs = { ok: false, error: e.message };
    status.issues.push('Node.js not available');
    status.ok = false;
  }

  // 1.5. Check TypeScript compilation (no errors).
  const typesOk = opts.skipTypecheck ? true : runCheck('npm run typecheck 2>&1 | grep -q "error" && exit 1 || exit 0');
  status.components.typescript = opts.skipTypecheck ? { ok: true, skipped: true } : { ok: typesOk };
  if (!typesOk) {
    status.issues.push('TypeScript compilation has errors');
    status.ok = false;
  }

  // 1.6. Check build artifact exists.
  const distExists = fs.existsSync(path.join(PROJECT_ROOT, 'dist/index.html'));
  status.components.build_artifact = { ok: distExists, path: 'dist/index.html' };
  if (!distExists) {
    status.issues.push('Build artifact missing (run: npm run build)');
    status.ok = false;
  }

  // 1.7. Check test infrastructure exists.
  const hasPlaywright = fs.existsSync(path.join(PROJECT_ROOT, 'playwright.config.ts'));
  const hasE2E = fs.existsSync(path.join(PROJECT_ROOT, 'e2e'));
  status.components.test_infrastructure = {
    ok: hasPlaywright && hasE2E,
    playwright: hasPlaywright,
    e2e_dir: hasE2E,
  };

  // 2. Check config directory exists and is writable.
  const configDir = schedulerPaths.claudeHome();
  try {
    await fsp.access(configDir, fs.constants.R_OK | fs.constants.W_OK);
    const stat = await fsp.stat(configDir);
    status.components.config_dir = {
      ok: true,
      path: configDir,
      writable: true,
    };
  } catch (e) {
    status.components.config_dir = {
      ok: false,
      error: e.message,
      path: configDir,
    };
    status.issues.push(`Config dir not accessible: ${e.message}`);
    status.ok = false;
  }

  // 3. Check scheduler state (federated, 2026-07-31): machine runtime file +
  // per-project job shards merged via queueStore — the retired global
  // queue.json is no longer consulted.
  const queuePath = schedulerPaths.machineStatePath();
  let queueState = null;
  try {
    queueState = queueStore.readMergedSync();
    if (queueState.unreadable) throw new Error(queueState.unreadable);
    for (const u of queueState.unreadableCwds ?? []) {
      status.issues.push(`Scheduler queue shard quarantined for ${u.cwd}: ${u.error} — that project is skipped until it reads clean`);
    }
    // A torn scheduler-machine.json is now recovered rather than halting
    // dispatch (queueStore.cjs's findLongestValidJsonPrefix) — but recovery
    // happening at all means the file failed to parse moments ago, which is
    // exactly the "machine-runtime file fails to parse" signal health must
    // surface as non-GREEN even though scheduling itself kept running.
    if (queueState.machineStateRecovered) {
      status.issues.push(
        `scheduler-machine.json failed to parse and was recovered (mode=${queueState.machineStateRecoveryMode}) — see logs scope=scheduler`
      );
    }
    const runningCount = Object.values(queueState.jobs || {}).filter(
      (j) => j.status === 'running'
    ).length;
    const failedCount = Object.values(queueState.jobs || {}).filter(
      (j) => j.status === 'failed'
    ).length;
    const needsReviewCount = Object.values(queueState.jobs || {}).filter(
      (j) => j.status === 'needs_review'
    ).length;
    const quarantinedCount = Object.values(queueState.jobs || {}).filter(
      (j) => j.status === 'quarantined'
    ).length;
    const heartbeat = readFreshHeartbeat(schedulerPaths.heartbeatPath());
    const liveness = evaluateTickLiveness(queueState, heartbeat, Date.now(), runningCount);

    // Per-project rollup (PRD: monitoring must not collapse per-project
    // reality into one machine-wide boolean — see computeStallSummary /
    // computeProjectProblemCounts headers). A project holding ONLY
    // failed/needs_review/quarantined rows (0 running, 0 pending) never
    // trips evaluateTickLiveness above, since that check requires actual
    // pending work — this is what let the burrow project go dark.
    const stallSummary = computeStallSummary(queueState);
    const now = Date.now();
    const perProjectStall = evaluatePerProjectStall(stallSummary, queueState.lastRunAt, now, TICK_STALL_THRESHOLD_MS);
    const projectsPastThreshold = Object.entries(perProjectStall)
      .filter(([, v]) => v.pastThreshold)
      .map(([cwd]) => cwd);

    status.components.scheduler_queue = {
      ok: !liveness.stalled && projectsPastThreshold.length === 0 && !queueState.machineStateRecovered
        && (queueState.unreadableCwds ?? []).length === 0,
      path: queuePath,
      jobs: Object.keys(queueState.jobs || {}).length,
      running: runningCount,
      // Deliberate restart drain (lib/upgradeDrain.cjs) — reported so it is never read as a stall.
      drain: queueState.drain?.active ? { since: queueState.drain.since ?? null, requestedAt: queueState.drain.requestedAt ?? null } : null,
      failed: failedCount,
      needsReview: needsReviewCount,
      quarantined: quarantinedCount,
      byProject: computeProjectProblemCounts(queueState.jobs),
      perProjectStall,
      tickLiveness: liveness.reason,
      machineStateRecovered: queueState.machineStateRecovered ?? false,
      quarantinedCwds: (queueState.unreadableCwds ?? []).map((u) => u.cwd),
      machineStateRecoveryMode: queueState.machineStateRecoveryMode ?? null,
      // Informational only (PRD 1085): current 1-min loadavg per core vs the
      // launch-gate threshold, so a "nothing is launching" report can be
      // read next to the reason without opening the app.
      loadRatio: (() => {
        const cores = (os.cpus() || []).length;
        const l1 = os.loadavg()[0];
        return cores > 0 && Number.isFinite(l1) ? Number((l1 / cores).toFixed(3)) : null;
      })(),
      loadGateThreshold: loadGateThreshold(),
    };
    if (liveness.longHold) {
      status.components.scheduler_queue.longHold = {
        window: liveness.window, utilization: liveness.utilization, nextReset: liveness.nextReset,
      };
      status.issues.push(
        `Queue held on the ${liveness.window ?? 'binding'} usage window at ${liveness.utilization}% (≥ threshold); `
        + (liveness.nextReset ? `resets ${liveness.nextReset}` : 'reset time unknown')
        + ' — hold may last days, not a normal short pause'
      );
    }
    if (liveness.stalled) {
      const ageMin = Math.round(liveness.tickAgeMs / 60_000);
      status.components.scheduler_queue.stalledJob = liveness.oldestPendingSlug;
      status.components.scheduler_queue.tickAgeMs = liveness.tickAgeMs;
      status.issues.push(
        `Scheduler tick appears stalled: "${liveness.oldestPendingSlug}" (and ${liveness.pendingCount - 1} other pending job(s)) has been waiting ~${ageMin}m with free capacity and no tick progress`
      );
    } else if (liveness.caveat) {
      status.components.scheduler_queue.caveat =
        liveness.reason === 'cannot-verify-utilization'
          ? `Tick hasn't advanced in a while but scheduler-heartbeat.log is missing/stale, so current billing utilization can't be checked — cannot rule out a legitimate when-available hold`
          : 'No lastRunAt recorded yet — cannot assess tick liveness';
    }
    if (projectsPastThreshold.length > 0) {
      status.components.scheduler_queue.stalledProjects = projectsPastThreshold;
      for (const cwd of projectsPastThreshold) {
        const ageMin = Math.round(perProjectStall[cwd].ageMs / 60_000);
        const counts = status.components.scheduler_queue.byProject[cwd] || {};
        status.issues.push(
          `Project fully stalled: ${cwd} — 0 running, 0 pending, only problem jobs `
          + `(failed=${counts.failed ?? 0} needs_review=${counts.needs_review ?? 0} quarantined=${counts.quarantined ?? 0}), `
          + `no scheduler tick in ~${ageMin}m (threshold ${Math.round(TICK_STALL_THRESHOLD_MS / 60_000)}m)`
        );
      }
    }
    // Same classification the external watchdog logs (observability only).
    const dispatchLiveness = evaluateDispatchLiveness(heartbeat, now);
    status.components.scheduler_queue.dispatchLiveness = dispatchLiveness;
    if (dispatchLiveness.dead) {
      status.issues.push('Scheduler dispatch appears dead: heartbeat is fresh but nothing has launched in 30m+ with dispatchable work pending and nothing running');
    }
    status.components.queue_dispatch = evaluateQueueDispatchHealth(queueState, runningCount, now);
    if (!status.components.queue_dispatch.ok || status.components.queue_dispatch.blocked) {
      status.issues.push(`Queue dispatch: ${status.components.queue_dispatch.message}`);
    }
    try {
      status.components.queue_dep_roots = evaluateUnresolvableDepHealth(
        queueState.jobs, await computeDepHistorySatisfaction(queueState),
      );
    } catch (e) {
      status.components.queue_dep_roots = { ok: true, error: `dep-root check failed: ${e?.message}` };
    }
    if (!status.components.queue_dep_roots.ok) {
      status.issues.push(`Queue dependsOn: ${status.components.queue_dep_roots.message}`);
    }

    status.components.blocking_parks = evaluateBlockingParkHealth(queueState.jobs, now);
    if (!status.components.blocking_parks.ok) {
      status.issues.push(`Blocking park: ${status.components.blocking_parks.message}`);
    }

    // Per-project starve escalation (bounded consequence for project_starved
    // — see runStarveEscalationSweep in scheduler.cjs). Distinct from
    // queue_dispatch above: that's machine-wide dispatch liveness, this is
    // "has any ONE project been starved past the LATER escalation threshold",
    // the exact condition the 2026-09-12 19h Bilko starve went unreported by.
    status.components.project_starve_escalation = evaluateStarveEscalationHealth(
      queueState.jobs, now, STARVE_ESCALATION_MS, latestStarveEscalationReasons(auditLogPath()),
    );
    if (!status.components.project_starve_escalation.ok) {
      status.issues.push(status.components.project_starve_escalation.message);
    }

    // Worktree cap blocking every dispatchable pending job with nothing
    // running (see evaluateWorktreeCapBlocked's header) — a distinct
    // condition from generic tick/dispatch staleness above, since a leaked
    // cap count can hold a row `pending` with a fresh heldReason on every
    // single tick (tickQueue keeps reaching spawnJob, per PRD 1141/1144's
    // live evidence), never tripping evaluateTickLiveness's staleness check.
    const worktreeCapBlocked = evaluateWorktreeCapBlocked(queueState.jobs, runningCount);
    status.components.scheduler_queue.worktreeCapBlocked = worktreeCapBlocked;
    if (!worktreeCapBlocked.ok) {
      status.components.scheduler_queue.ok = false;
      status.issues.push(
        `Worktree cap is blocking dispatch with 0 jobs running: ${worktreeCapBlocked.capBlockedSlugs.join(', ')}`
      );
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      status.issues.push(`Scheduler queue unreadable: ${e.message}`);
    }
    status.components.scheduler_queue = {
      ok: e.code === 'ENOENT', // ok if queue doesn't exist yet
      path: queuePath,
      exists: false,
      error: e.code === 'ENOENT' ? 'not yet created' : e.message,
    };
    status.components.queue_dispatch = { ok: true };
  }

  // 3.5. Usage/rate-limit poller (scheduler.cjs pollLoop) — a distinct
  // subsystem from scheduler_queue above: it can be alive (lastPollAt keeps
  // advancing) while failing every single poll, silently, with nothing else
  // surfacing it (the 57-consecutive-failure incident this check exists to
  // catch). Missing state file means the poller hasn't run yet — not a
  // failure. A CORRUPT file (the torn-write class fixed for the sibling
  // scheduler-machine.json in f56bdc0) is NOT the same as missing — surfaced
  // as non-GREEN rather than fail-open, via loadUsagePollerState below.
  const loaded = loadUsagePollerState(schedulerPaths.schedulerStatePath());
  if (loaded.missing) {
    status.components.usage_poller = { ok: true, applicable: false };
  } else if (loaded.errorMessage) {
    status.components.usage_poller = { ok: false, applicable: true, error: loaded.errorMessage };
    status.issues.push(`Usage/rate-limit poller: ${loaded.errorMessage}`);
  } else {
    status.components.usage_poller = evaluateUsagePollerHealth(loaded.state);
    if (status.components.usage_poller.message) status.issues.push(status.components.usage_poller.message);
  }

  // 4. Check PRDs directories — one per active project
  // (session-manager-operations/scheduler/prds/), summed. PRD 809.
  const prdsDirs = resolvePrdsDirs();
  let totalPrdCount = 0;
  let anyPrdsDirAccessible = false;
  const prdsDirErrors = [];
  for (const dir of prdsDirs) {
    try {
      await fsp.access(dir, fs.constants.R_OK);
      const files = await fsp.readdir(dir);
      totalPrdCount += files.filter((f) => f.endsWith('.md')).length;
      anyPrdsDirAccessible = true;
    } catch (e) {
      if (e.code !== 'ENOENT') {
        prdsDirErrors.push(`${dir}: ${e.message}`);
      }
    }
  }
  if (prdsDirErrors.length > 0) {
    status.issues.push(`PRDs directory not accessible: ${prdsDirErrors.join('; ')}`);
  }
  status.components.scheduler_prds = {
    ok: prdsDirErrors.length === 0,
    dirs: prdsDirs,
    count: totalPrdCount,
    ...(prdsDirs.length === 0 || anyPrdsDirAccessible ? {} : { exists: false }),
  };

  // 4.5. Check for stranded legacy-dir PRDs left behind by runPrdMigration()
  // (scheduler.cjs). A stranded PRD is the cheapest generic leading indicator
  // of a stale installed build vs. the git repo — it fires regardless of
  // *why* the build is stale (the 2026-07-31 burrow-project ENOENT + the
  // 223-file/189-resurrected-job incident both trace back to this).
  const legacyPrdsDir = schedulerPaths.prdsRoot();
  try {
    const migrationResult = await migratePrds(legacyPrdsDir);
    status.components.prd_migration = evaluatePrdMigrationHealth(migrationResult, legacyPrdsDir);
  } catch (e) {
    status.components.prd_migration = { ok: false, legacyDir: legacyPrdsDir, error: e.message };
  }
  if (!status.components.prd_migration.ok) {
    status.issues.push(
      status.components.prd_migration.error
        ? `PRD migration check failed: ${status.components.prd_migration.error}`
        : `PRD migration: ${status.components.prd_migration.strandedCount} file(s) stranded in legacy dir ${legacyPrdsDir} — could not be resolved into a per-project dir`
    );
  }

  // 5. Check transcripts directory (where live session logs are tailed).
  const projectsDir = schedulerPaths.claudeProjectsDir();
  try {
    await fsp.access(projectsDir, fs.constants.R_OK);
    status.components.transcripts_dir = {
      ok: true,
      path: projectsDir,
    };
  } catch (e) {
    // Not fatal — transcripts dir may not exist until first session.
    status.components.transcripts_dir = {
      ok: true,
      path: projectsDir,
      note: 'not yet created (normal for fresh install)',
    };
  }

  // 6. Check session-manager's own logs (informational, not blocking).
  const smLogsDir = schedulerPaths.watchdogLogsDir();
  let logAge = null;
  try {
    const files = await fsp.readdir(smLogsDir);
    if (files.length > 0) {
      const latestLog = files.sort().pop();
      const logPath = path.join(smLogsDir, latestLog);
      const stat = await fsp.stat(logPath);
      logAge = Date.now() - stat.mtimeMs;
    }
    status.components.app_logs = {
      ok: true,
      path: smLogsDir,
      latestLogAgeMs: logAge,
      note: logAge ? `Last log ${Math.round(logAge / 60_000)}m ago` : 'app not yet run',
    };
  } catch (e) {
    status.components.app_logs = {
      ok: true,
      path: smLogsDir,
      note: 'logs directory not yet created (normal for fresh installs)',
    };
  }

  // 6.4. Check project CLAUDE.md against its own self-declared SIZE BUDGET
  // header (see the CLAUDE.md size-budget note). Skips silently when no
  // budget line is present — this is not required for every project.
  try {
    const claudeMdPath = path.join(PROJECT_ROOT, 'CLAUDE.md');
    const claudeMdText = fs.readFileSync(claudeMdPath, 'utf8');
    const chars = Buffer.byteLength(claudeMdText, 'utf8');
    const budget = parseClaudeMdBudget(claudeMdText);
    const budgetResult = evaluateClaudeMdBudget(chars, budget);
    status.components.claude_md_budget = budgetResult;
    if (!budgetResult.ok) {
      status.issues.push(budgetResult.message);
    }
  } catch (e) {
    status.components.claude_md_budget = { ok: true, applicable: false };
  }

  // 6.5. Check ~/.claude/CLAUDE.md's @import chain resolves cleanly.
  // Informational only — a broken/stale persona import degrades instruction
  // fidelity, not app health, so it never flips status.ok to false. See
  // personaImportHealth.cjs.
  const personaImports = checkPersonaImports();
  status.components.persona_imports = personaImports;
  if (!personaImports.ok) {
    for (const broken of personaImports.brokenImports) {
      status.issues.push(
        `Persona import broken: "${broken.importPath}" ${broken.exists ? 'is empty' : 'does not exist'}`
      );
    }
  }

  // 6.55. Delegation-chain readiness — answers "can this machine actually
  // delegate work to the scheduler?" (see delegationReadiness.cjs's header:
  // when the scheduler MCP isn't registered, scheduler_create_prd is simply
  // absent from the agent's tool list — no error to catch, so an agent asked
  // to delegate just implements inline instead). Critical: a failing check
  // here means Epics silently stop queueing PRDs on this machine.
  try {
    const delegation = await checkDelegationReadiness({ cwd: PROJECT_ROOT });
    const { component, issues: delegationIssues } = evaluateDelegationChainHealth(delegation);
    status.components.delegation_chain = component;
    status.issues.push(...delegationIssues);
  } catch (e) {
    status.components.delegation_chain = { ok: false, error: e.message };
    status.issues.push(`Delegation readiness check failed: ${e.message}`);
  }

  // 6.6. Run-log retention report (informational only — never blocks health).
  // Read-only against the REAL scheduled-plans/runs/ dir: reports current
  // usage + what the configured policy (if any) would remove. Nothing is
  // ever deleted here; see runLogRetention.cjs's header for the safety
  // model. schedulerRunLogRetention lives in scheduler-machine.json's
  // `config`, same home as every other scheduler machine setting.
  try {
    const retentionCfg = queueState?.config?.schedulerRunLogRetention;
    const liveKeys = liveKeysFromJobs(queueState?.jobs || [], { runsDir: DEFAULT_RUNS_DIR });
    const report = computeReport(
      DEFAULT_RUNS_DIR,
      retentionCfg?.policy || {},
      { liveKeys }
    );
    status.components.run_log_retention = {
      ok: true,
      path: DEFAULT_RUNS_DIR,
      totalBytes: report.usage.totalBytes,
      dirCount: report.usage.dirCount,
      runCount: report.usage.runCount,
      oldestRunAt: report.usage.oldestRunAt,
      policyConfigured: !!retentionCfg?.policy,
      retentionEnabled: isRetentionEnabled(queueState?.config || {}),
      wouldRemoveCount: report.eligibleSummary.count,
      wouldRemoveBytes: report.eligibleSummary.bytes,
      wouldRemoveDirs: report.removableDirs.length,
    };
  } catch (e) {
    status.components.run_log_retention = { ok: true, error: e.message };
  }

  // 6.65. Epic index drift — orphan_rows/orphan_files/unmirrored across every
  // project this machine has ever opened (allProjectCwds, no recency filter
  // — a quiet project still owns its Epics). See computeEpicIndexDrift's
  // header.
  try {
    const { component, issues: epicIndexIssues } = evaluateEpicIndexHealth(allProjectCwds());
    status.components.epic_index = component;
    status.issues.push(...epicIndexIssues);
  } catch (e) {
    status.components.epic_index = { ok: false, error: e.message };
    status.issues.push(`Epic index health check failed: ${e.message}`);
  }

  // 6.66. Epic transcript location (NON-fatal warning): a mislocated/duplicated
  // transcript is read correctly by epicTranscriptPath, so it never reddens the
  // rollup (not in criticalComponents). See scripts/check-epic-transcripts.cjs.
  try {
    const findings = scanEpicTranscripts({ cwds: allProjectCwds() });
    status.components.epic_transcripts = { ok: true, findings: findings.length, duplicated: findings.filter((f) => f.classification === 'duplicated').length };
    if (findings.length > 0) {
      status.issues.push(`Warning: ${findings.length} Epic transcript(s) mislocated/duplicated — run: node scripts/check-epic-transcripts.cjs`);
    }
  } catch (e) {
    status.components.epic_transcripts = { ok: true, error: e.message };
  }

  // 6.7. Build freshness (informational): running heartbeat vs installed
  // build-info vs repo HEAD.
  try {
    let repoHead = null;
    try {
      repoHead = execFileSync('git', ['-C', PROJECT_ROOT, 'rev-parse', '--short', 'HEAD'], {
        timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || null;
    } catch { /* not a git checkout */ }
    status.components.build = evaluateBuildFreshness({
      running: readFreshHeartbeat(schedulerPaths.heartbeatPath())?.build?.codeSha ?? null,
      installedOnDisk: resolveBuildIdentity().codeSha ?? null,
      repoHead,
    });
  } catch (e) {
    status.components.build = { ok: true, error: e.message };
  }

  // 7. Summary scoring: ok if all critical components pass.
  // Critical: nodejs, config dir, typescript, build artifact, test infrastructure.
  // Non-fatal: scheduler/transcripts dirs may not exist on fresh install.
  // Informational: app log age (shows if app is running, but not blocking).
  const criticalComponents = ['nodejs', 'config_dir', 'typescript', 'build_artifact', 'test_infrastructure', 'scheduler_queue', 'queue_dispatch', 'queue_dep_roots', 'blocking_parks', 'project_starve_escalation', 'usage_poller', 'prd_migration', 'claude_md_budget', 'delegation_chain'];
  status.ok = criticalComponents.every((c) => status.components[c]?.ok !== false);

  status.elapsedMs = Date.now() - start;
  return status;
}

// CLI entry point: `node src/main/health.cjs`
if (require.main === module) {
  (async () => {
    const result = await check();
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  })();
}

module.exports = {
  check,
  evaluateTickLiveness,
  readFreshHeartbeat,
  evaluatePrdMigrationHealth,
  evaluateDelegationChainHealth,
  computeEpicIndexDrift,
  evaluateEpicIndexHealth,
  computeProjectProblemCounts,
  evaluateWorktreeCapBlocked,
  evaluatePerProjectStall,
  parseClaudeMdBudget,
  evaluateClaudeMdBudget,
  evaluateUsagePollerHealth,
  loadUsagePollerState,
  evaluateQueueDispatchHealth,
  evaluateUnresolvableDepHealth,
  evaluateBlockingParkHealth,
  evaluateStarveEscalationHealth,
  evaluateBuildFreshness,
  latestStarveEscalationReasons,
  DISPATCH_STALL_THRESHOLD_MS,
  DISPATCH_WARN_THRESHOLD_MS,
  TICK_STALL_THRESHOLD_MS,
  HEARTBEAT_STALE_MS,
};
