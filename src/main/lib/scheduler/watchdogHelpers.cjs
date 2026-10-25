'use strict';

// watchdogHelpers.cjs — pure helpers for scheduler-watchdog.cjs (no side effects).
// Testable without spawning the watchdog entry script.

const fs = require('node:fs');
const path = require('node:path');
const schedulerPaths = require('./schedulerPaths.cjs');
const { isRestartingMarkerActive } = require('./upgradeDrain.cjs');
const { pidAlive } = require('../process/pidAlive.cjs');
const atomicFs = require('../util/atomicFs.cjs');
const { isPackagedApp } = require('../appRuntime.cjs');



// The in-app heartbeat ticks every 60 s; 3 missed ticks = stale.
const DEFAULT_MAX_AGE_MS = 180_000;

/** Local-TZ 'YYYY-MM-DD' for `d` (default now). Single source of truth for
 *  the watchdog's notion of "today" — used for both the log filename and the
 *  history-rollup once-per-day gate. */
function localDateStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Tail bytes to read — enough to hold several JSON heartbeat lines without
// loading a potentially 1 MB file. O(1) in file size.
const TAIL_BYTES = 4096;

/**
 * readLastHeartbeat(heartbeatPath?) → object | null
 *
 * Reads the last ~4 KB of the heartbeat log, reverse-scans for the last
 * non-empty line, and returns the full parsed JSON object.
 * Returns null on missing / empty / unparseable file.
 *
 * Single source of truth for the file-read + reverse-scan logic; used by
 * readLastHeartbeatTs() and heartbeatFresh().
 */
function readLastHeartbeat(heartbeatPath = schedulerPaths.heartbeatPath()) {
  let buf;
  try {
    const stat = fs.statSync(heartbeatPath);
    const size = stat.size;
    if (size === 0) return null;

    const readSize = Math.min(TAIL_BYTES, size);
    const fd = fs.openSync(heartbeatPath, 'r');
    try {
      buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, size - readSize);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }

  const lines = buf.toString('utf8').split('\n');
  // Walk lines in reverse to find last non-empty parseable one.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * readLastHeartbeatTs(heartbeatPath?) → number | null
 *
 * Returns the `ts` field (epoch ms) from the last heartbeat entry.
 * Returns null on missing / empty / unparseable file or missing ts field.
 */
function readLastHeartbeatTs(heartbeatPath = schedulerPaths.heartbeatPath()) {
  const entry = readLastHeartbeat(heartbeatPath);
  return (entry !== null && typeof entry.ts === 'number') ? entry.ts : null;
}

/**
 * heartbeatFresh(heartbeatPath?, maxAgeMs?) → boolean
 *
 * Returns true iff the last heartbeat ts is within maxAgeMs of `now`.
 * Missing / empty / unparseable file → false. A `degraded: true` line (a
 * heartbeat subsystem threw — see scheduler.cjs heartbeatTick) is NOT fresh:
 * the loop ran but could not read state, so it must not disarm the watchdog.
 */
function heartbeatFresh(heartbeatPath = schedulerPaths.heartbeatPath(), maxAgeMs = DEFAULT_MAX_AGE_MS) {
  const entry = readLastHeartbeat(heartbeatPath);
  if (entry === null || entry.degraded === true || typeof entry.ts !== 'number') return false;
  return (Date.now() - entry.ts) < maxAgeMs;
}

const DEFAULT_DISPATCH_DEAD_MS = 30 * 60_000;
const DEFAULT_TICK_WEDGED_DEAD_MS = 10 * 60_000;

/**
 * evaluateDispatchLiveness(entry, now, { deadMs, wedgedDeadMs }?) → { dead, reason }
 *
 * Pure. Observability only — a logically-dead scheduler (wedged tick chain,
 * leaked slots) still writes fresh heartbeats, so freshness alone can't see
 * it. `dead` when EITHER:
 *   - dispatch.lastTickReason === 'wedged' and lastDispatchAttemptAt is
 *     older than wedgedDeadMs (absent/unparseable counts as older) — a
 *     wedged reconcile never derives rows, so pendingDispatchable stays 0
 *     and the rule below can never fire (2026-09-25: watchdog logged
 *     'alive'/'nothing-dispatchable' every 3 min through a 30+ min mutate
 *     deadlock because of exactly this gap); or
 *   - ALL of: dispatch.lastRunAt older than deadMs (absent/unparseable
 *     counts as older), pendingDispatchable > 0, runningCount === 0.
 * Both rules require: heartbeat fresh (not degraded, within
 * DEFAULT_MAX_AGE_MS) and not paused/draining.
 * Callers must NOT relaunch on this: the process is alive, and a relaunch
 * would spawn a second app on top of it.
 */
function evaluateDispatchLiveness(entry, now = Date.now(), { deadMs = DEFAULT_DISPATCH_DEAD_MS, wedgedDeadMs = DEFAULT_TICK_WEDGED_DEAD_MS } = {}) {
  if (!entry || entry.degraded === true || typeof entry.ts !== 'number') {
    return { dead: false, reason: 'no-fresh-heartbeat' };
  }
  if (now - entry.ts >= DEFAULT_MAX_AGE_MS) return { dead: false, reason: 'heartbeat-stale' };
  const d = entry.dispatch;
  if (!d || typeof d !== 'object') return { dead: false, reason: 'no-dispatch-field' };
  if (d.paused) return { dead: false, reason: 'paused' };
  if (d.drain) return { dead: false, reason: 'draining' };
  if (d.lastTickReason === 'wedged') {
    const lastAttemptMs = Date.parse(d.lastDispatchAttemptAt ?? '');
    if (!Number.isFinite(lastAttemptMs) || now - lastAttemptMs > wedgedDeadMs) {
      return { dead: true, reason: 'tick-wedged' };
    }
  }
  if (!(d.pendingDispatchable > 0)) return { dead: false, reason: 'nothing-dispatchable' };
  if (d.runningCount !== 0) return { dead: false, reason: 'jobs-running' };
  const lastRunMs = Date.parse(d.lastRunAt ?? '');
  if (Number.isFinite(lastRunMs) && now - lastRunMs <= deadMs) return { dead: false, reason: 'recent-dispatch' };
  return { dead: true, reason: 'dispatch-dead' };
}

// Offline queue.json reconciliation (orphaned 'running' jobs whose pid died
// while Electron wasn't running) used to live here as reconcileQueueOffline().
// PRD 686 moved that responsibility into src/main/scheduler.cjs's own boot
// path (partitionBootOrphans/applyOrphanOutcome) now that PRD 685's watchdog
// relaunch means the app is never down long enough to need an external
// reconciler — the in-app scheduler is queue.json's single owner again.

// ── app liveness + auto-relaunch ─────────────────────────────────────────────
//
// The watchdog's one supervision job: is session-manager itself running, and
// if not, start it. Reuses the existing scheduler heartbeat (written every
// 60 s by scheduler.cjs's heartbeatInterval regardless of pause state) as the
// liveness signal — no second heartbeat file.

const DEFAULT_RELAUNCH_DEBOUNCE_MS = 90_000;
const DEFAULT_MAX_RELAUNCH_ATTEMPTS = 3;
// After the fast attempts are spent, keep retrying forever on this bounded backoff.
const DEFAULT_CAPPED_RETRY_MS = 30 * 60_000;

/**
 * checkAppLiveness(opts?) → { alive: boolean, reason: string }
 *
 * Primary signal: heartbeatFresh() within the existing max-age window.
 * Defense-in-depth: if the heartbeat is stale, but the pid it last recorded
 * is still alive (app under heavy load, tick just missed), treat as alive
 * rather than relaunching on top of a live process.
 */
function checkAppLiveness({
  heartbeatPath = schedulerPaths.heartbeatPath(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
} = {}) {
  if (heartbeatFresh(heartbeatPath, maxAgeMs)) {
    return { alive: true, reason: 'heartbeat-fresh' };
  }
  const last = readLastHeartbeat(heartbeatPath);
  if (last !== null && typeof last.pid === 'number' && pidAlive(last.pid)) {
    return { alive: true, reason: 'pid-alive-heartbeat-stale' };
  }
  return { alive: false, reason: 'stale-and-dead' };
}

/** Default { lastAttemptTs: null, attemptCount: 0 } on missing/unparseable state file. */
function readRelaunchState(statePath = schedulerPaths.watchdogRelaunchStatePath()) {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return {
      lastAttemptTs: typeof raw.lastAttemptTs === 'number' ? raw.lastAttemptTs : null,
      attemptCount: typeof raw.attemptCount === 'number' ? raw.attemptCount : 0,
      lastBackoffLogTs: typeof raw.lastBackoffLogTs === 'number' ? raw.lastBackoffLogTs : null,
    };
  } catch {
    return { lastAttemptTs: null, attemptCount: 0, lastBackoffLogTs: null };
  }
}

/**
 * resetRelaunchState — zero the attempt counter. Called by the watchdog on every
 * fresh, non-degraded heartbeat. Writes only when the state is not already zeroed.
 */
function resetRelaunchState({ statePath = schedulerPaths.watchdogRelaunchStatePath() } = {}) {
  const state = readRelaunchState(statePath);
  if (state.attemptCount === 0 && state.lastAttemptTs === null && state.lastBackoffLogTs === null) {
    return { reset: false };
  }
  writeRelaunchState(statePath, { lastAttemptTs: null, attemptCount: 0 });
  return { reset: true };
}

/** Atomic write via atomicFs.cjs (mirrors config.cjs writeJsonSync). */
function writeRelaunchState(statePath, state) {
  atomicFs.writeJsonAtomicSync(statePath, state);
}

function logRelaunchLine(logPath, message) {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
  } catch (e) {
    process.stderr.write(`[watchdog-relaunch] log write failed: ${e?.message}\n`);
  }
}

/**
 * defaultSpawnRelaunch(opts?) — launches a new session-manager instance the
 * same way a user would: `npx claude-code-session-manager@latest` (the
 * documented distribution method — CLAUDE.md's "Distribution" section), so
 * this keeps working across npm publishes with no local path to maintain.
 *
 * Detached + stdio redirected to logPath + unref()'d so the watchdog's own
 * (short-lived) process doesn't block on the launched app and the app
 * survives the watchdog exiting.
 */
/**
 * relaunchSpec(opts?) — what the watchdog spawns to bring the app back.
 * Packaged installer builds have no npx: relaunch the app binary itself.
 * @param {{ packaged?: boolean, execPath?: string }} [opts]
 * @returns {{ command: string, args: string[], packaged: boolean }}
 */
function relaunchSpec(opts) {
  if (isPackagedApp(opts)) {
    return { command: (opts && opts.execPath) || process.execPath, args: [], packaged: true };
  }
  return { command: 'npx', args: ['claude-code-session-manager@latest'], packaged: false };
}

/** Resolve an executable on a PATH string (no shell). Returns null when absent. */
function findOnPath(name, envPath) {
  if (typeof envPath !== 'string') return null;
  for (const dir of envPath.split(':')) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* keep scanning */ }
  }
  return null;
}

/**
 * relaunchInvocation — pure. Under systemd (INVOCATION_ID set) the relaunch must
 * live in its own transient user unit, or the oneshot watchdog unit's cgroup
 * teardown kills it. KillMode=process so a successor spawned by the old app's
 * npx survives that npx exiting.
 */
function relaunchInvocation({ spec, env, logPath, now, systemdRunPath }) {
  if (typeof env?.INVOCATION_ID === 'string' && env.INVOCATION_ID !== '' && typeof systemdRunPath === 'string') {
    return {
      mode: 'systemd-run',
      command: systemdRunPath,
      args: [
        '--user', '--collect', '--quiet',
        `--unit=session-manager-relaunch-${now}`,
        '-p', 'KillMode=process',
        '-p', `StandardOutput=append:${logPath}`,
        '-p', `StandardError=append:${logPath}`,
        `--setenv=PATH=${env.PATH}`,
        '--',
        spec.command, ...spec.args,
      ],
    };
  }
  return { mode: 'detached', command: spec.command, args: spec.args };
}

function defaultSpawnRelaunch({
  logPath = schedulerPaths.watchdogRelaunchLogPath(), packaged, execPath, spawnFn, spawnSyncFn,
  env: envIn = process.env, now = Date.now(),
} = {}) {
  const cp = require('node:child_process');
  const spawn = spawnFn || cp.spawn;
  const spawnSync = spawnSyncFn || cp.spawnSync;
  const spec = relaunchSpec({ packaged, execPath });
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const env = { ...envIn };
  // The watchdog may itself run as node via the app binary; the relaunched app must not.
  if (spec.packaged) delete env.ELECTRON_RUN_AS_NODE;
  const inv = relaunchInvocation({
    spec, env, logPath, now,
    systemdRunPath: env.INVOCATION_ID ? findOnPath('systemd-run', env.PATH) : null,
  });
  let result = { mode: 'detached' };
  if (inv.mode === 'systemd-run') {
    const r = spawnSync(inv.command, inv.args, { timeout: 15000, stdio: 'ignore', env });
    if (r && !r.error && r.status === 0) {
      return { mode: 'systemd-run', ok: true, unit: `session-manager-relaunch-${now}` };
    }
    logRelaunchLine(logPath, `systemd-run failed (${r?.error?.message || `status ${r?.status}`}) — falling back to detached spawn`);
    result = { mode: 'detached-fallback' };
  }
  const fd = fs.openSync(logPath, 'a');
  try {
    const child = spawn(spec.command, spec.args, {
      detached: true,
      stdio: ['ignore', fd, fd],
      env,
    });
    child.on('error', (e) => {
      logRelaunchLine(logPath, `spawn error: ${e?.message}`);
    });
    child.unref();
  } finally {
    fs.closeSync(fd);
  }
  return result;
}

/**
 * maybeRelaunchApp(opts?) → { relaunched: boolean, reason: string, attemptCount: number }
 *
 * Debounced, capped auto-relaunch:
 *   - alive (heartbeat fresh or pid alive)             → no-op, reset attempt state.
 *   - dead + attemptCount at maxAttempts, last attempt < cappedRetryMs ago
 *                                                         → skip ('backoff'), one log line per window.
 *   - dead + attemptCount at maxAttempts, window elapsed  → spawn again (retries forever).
 *   - dead + last attempt < debounceMs ago                → skip (still booting).
 *   - dead + debounce elapsed + under cap               → spawn, bump attemptCount, log.
 *
 * attemptCount resets to 0 when the alive branch here sees a live app, and the
 * watchdog script also calls resetRelaunchState() on every fresh heartbeat.
 */
function maybeRelaunchApp({
  heartbeatPath = schedulerPaths.heartbeatPath(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  statePath = schedulerPaths.watchdogRelaunchStatePath(),
  logPath = schedulerPaths.watchdogRelaunchLogPath(),
  debounceMs = DEFAULT_RELAUNCH_DEBOUNCE_MS,
  maxAttempts = DEFAULT_MAX_RELAUNCH_ATTEMPTS,
  cappedRetryMs = DEFAULT_CAPPED_RETRY_MS,
  now = Date.now(),
  spawnFn = defaultSpawnRelaunch,
  restartingMarkerPath = schedulerPaths.restartingMarkerPath(),
} = {}) {
  const liveness = checkAppLiveness({ heartbeatPath, maxAgeMs });
  const state = readRelaunchState(statePath);

  if (liveness.alive) {
    if (state.attemptCount !== 0 || state.lastAttemptTs !== null || state.lastBackoffLogTs !== null) {
      writeRelaunchState(statePath, { lastAttemptTs: null, attemptCount: 0 });
    }
    return { relaunched: false, reason: 'alive', attemptCount: 0 };
  }

  // A deliberate drain-restart is mid-exit: the old process is going away ON
  // PURPOSE and its successor is booting. Relaunching now would race the
  // single-instance lock. The marker's lifetime is bounded, so a restart that
  // never comes up is picked up again once it expires.
  if (isRestartingMarkerActive({ file: restartingMarkerPath, now })) {
    return { relaunched: false, reason: 'restarting', attemptCount: state.attemptCount };
  }

  if (state.attemptCount >= maxAttempts) {
    const sinceLast = state.lastAttemptTs === null ? Infinity : now - state.lastAttemptTs;
    if (sinceLast < cappedRetryMs) {
      const nextRetryInMs = cappedRetryMs - sinceLast;
      const logged = state.lastBackoffLogTs;
      if (logged === null || logged < state.lastAttemptTs || now - logged >= cappedRetryMs) {
        logRelaunchLine(
          logPath,
          `backoff: ${state.attemptCount} relaunch attempt(s) made and heartbeat is still stale — next retry in ${Math.ceil(nextRetryInMs / 60_000)} min`,
        );
        writeRelaunchState(statePath, {
          lastAttemptTs: state.lastAttemptTs, attemptCount: state.attemptCount, lastBackoffLogTs: now,
        });
      }
      return { relaunched: false, reason: 'backoff', attemptCount: state.attemptCount, nextRetryInMs };
    }
    // Window elapsed: fall through to spawn (skips debounce, which is shorter).
  } else if (state.lastAttemptTs !== null && (now - state.lastAttemptTs) < debounceMs) {
    return { relaunched: false, reason: 'debounce', attemptCount: state.attemptCount };
  }

  const attemptCount = state.attemptCount + 1;
  const spawned = spawnFn({ logPath, now });
  const how = spawned && spawned.mode === 'systemd-run'
    ? `via systemd-run unit ${spawned.unit || `session-manager-relaunch-${now}`}${spawned.ok === false ? ' (failed)' : ''}`
    : spawned && spawned.mode === 'detached-fallback' ? 'detached (systemd-run fallback)' : 'detached';
  writeRelaunchState(statePath, { lastAttemptTs: now, attemptCount });
  logRelaunchLine(
    logPath,
    `relaunch attempt ${attemptCount}${attemptCount > maxAttempts ? ' (backoff retry)' : `/${maxAttempts}`}: spawning ${how} (heartbeat stale, last-known pid dead)`,
  );
  return { relaunched: true, reason: 'launched', attemptCount };
}

// ── maybeFinalizeHistory ─────────────────────────────────────────────────────
//
// Precomputes closed History-dashboard days outside Electron, so the app's
// first paint after a boot (possibly weeks after the app was last open) is
// instant, and old transcripts stay safe to age out without losing analytics.
// See src/main/historyAggregator.cjs's finalizeClosedDays() for the actual
// walk/persist logic — this is just the once-per-day scheduling + lock
// wrapper around it, tailored to being invoked repeatedly by a systemd timer.

const DEFAULT_LOCK_STALE_MS = 10 * 60 * 1000; // 10 min
const DEFAULT_FINALIZE_BUDGET_MS = 60_000;

function readStampDate(stampPath) {
  try {
    return fs.readFileSync(stampPath, 'utf8').trim();
  } catch {
    return null;
  }
}

/** Atomic write via atomicFs.cjs (mirrors config.cjs writeJsonSync). */
function writeStampDate(stampPath, date) {
  atomicFs.writeTextAtomicSync(stampPath, date);
}

/**
 * tryAcquireLock(lockPath, staleMs) → boolean
 *
 * O_EXCL ('wx') lock file so the in-app Electron boot pass and this cron
 * pass never interleave writes to the rollup. A lock older than staleMs is
 * assumed abandoned (a crashed holder) and reclaimed; otherwise the caller
 * loses the race and must skip silently.
 */
function tryAcquireLock(lockPath, staleMs = DEFAULT_LOCK_STALE_MS) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  try {
    fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }

  let st;
  try {
    st = fs.statSync(lockPath);
  } catch {
    st = null; // lock vanished between our failed create and this stat
  }

  if (st !== null && Date.now() - st.mtimeMs <= staleMs) {
    return false; // held by a live (or at least recent) owner — loser skips
  }

  // Stale (or already gone) — reclaim. The unlink+wx pair isn't atomic, so
  // two concurrent reclaimers could theoretically both win here — but that
  // only happens when the prior holder already crashed/vanished, and the
  // resulting "both run finalize" outcome is benign: appendRollupDays is
  // append-only + last-write-wins-deduped, so a redundant concurrent pass
  // costs extra work, not corrupted data.
  try {
    if (st !== null) fs.unlinkSync(lockPath);
    fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

function releaseLock(lockPath) {
  try { fs.unlinkSync(lockPath); } catch { /* already gone / never created */ }
}

/** Lazily require historyAggregator.cjs — deferred so a missing PRD-650
 *  dependency fails inside maybeFinalizeHistory's try/catch, not at require
 *  time for the whole watchdog script. */
function defaultFinalizeClosedDays(opts) {
  const { finalizeClosedDays } = require('../../historyAggregator.cjs');
  return finalizeClosedDays(opts);
}

/**
 * maybeFinalizeHistory(opts?) → Promise<{ ran, reason, date, finalizedDates? }>
 *
 * Runs at most once per local day (stamp-file gated, O(1) same-day skip).
 * Guards against interleaving with the in-app Electron boot pass via an
 * O_EXCL lock file. Bounded by opts.budgetMs so a huge transcript corpus
 * can't make a single watchdog tick run long; a budget-partial pass does
 * NOT stamp the day complete, so a later tick resumes/retries.
 *
 * opts:
 *   stampPath   — override for testing (default ~/.claude/session-manager/history-rollup.stamp)
 *   lockPath    — override for testing (default ~/.claude/session-manager/history-rollup.lock)
 *   staleLockMs — lock staleness threshold (default 10 min)
 *   budgetMs    — cap forwarded to finalizeClosedDays (default 60_000)
 *   dryRun      — compute without writing (default SM_WATCHDOG_DRYRUN === '1')
 *   finalizeFn  — injectable finalizeClosedDays for testing
 */
async function maybeFinalizeHistory({
  stampPath = schedulerPaths.historyRollupStampPath(),
  lockPath = schedulerPaths.historyRollupLockPath(),
  staleLockMs = DEFAULT_LOCK_STALE_MS,
  budgetMs = DEFAULT_FINALIZE_BUDGET_MS,
  dryRun = process.env.SM_WATCHDOG_DRYRUN === '1',
  finalizeFn = defaultFinalizeClosedDays,
} = {}) {
  const today = localDateStr();

  if (readStampDate(stampPath) === today) {
    return { ran: false, reason: 'already-finalized-today', date: today };
  }

  if (!tryAcquireLock(lockPath, staleLockMs)) {
    return { ran: false, reason: 'lock-contended', date: today };
  }

  try {
    const result = await finalizeFn({ budgetMs, dryRun });

    if (dryRun) {
      return { ran: false, reason: 'dry-run', date: today, finalizedDates: result.finalizedDates };
    }

    if (!result.partial) {
      writeStampDate(stampPath, today);
      return { ran: true, reason: 'finalized', date: today, finalizedDates: result.finalizedDates };
    }

    return { ran: true, reason: 'partial', date: today, finalizedDates: result.finalizedDates };
  } finally {
    releaseLock(lockPath);
  }
}

module.exports = {
  readLastHeartbeat,
  readLastHeartbeatTs,
  heartbeatFresh,
  evaluateDispatchLiveness,
  localDateStr,
  maybeFinalizeHistory,
  tryAcquireLock,
  releaseLock,
  checkAppLiveness,
  readRelaunchState,
  resetRelaunchState,
  writeRelaunchState,
  defaultSpawnRelaunch,
  relaunchInvocation,
  findOnPath,
  relaunchSpec,
  maybeRelaunchApp,
  DEFAULT_MAX_AGE_MS,
  DEFAULT_DISPATCH_DEAD_MS,
  DEFAULT_TICK_WEDGED_DEAD_MS,
  DEFAULT_LOCK_STALE_MS,
  DEFAULT_FINALIZE_BUDGET_MS,
  DEFAULT_RELAUNCH_DEBOUNCE_MS,
  DEFAULT_MAX_RELAUNCH_ATTEMPTS,
  DEFAULT_CAPPED_RETRY_MS,
};

// Lazy default-path getters (SM_SCHEDULER_HOME resolved at read, never at require).
for (const [name, resolve] of [
  ['DEFAULT_HEARTBEAT_PATH', schedulerPaths.heartbeatPath],
  ['DEFAULT_STAMP_PATH', schedulerPaths.historyRollupStampPath],
  ['DEFAULT_LOCK_PATH', schedulerPaths.historyRollupLockPath],
  ['DEFAULT_RELAUNCH_STATE_PATH', schedulerPaths.watchdogRelaunchStatePath],
  ['DEFAULT_RELAUNCH_LOG_PATH', schedulerPaths.watchdogRelaunchLogPath],
]) {
  Object.defineProperty(module.exports, name, { get: resolve, enumerable: true });
}
