'use strict';

// watchdogHelpers.cjs — pure helpers for scheduler-watchdog.cjs (no side effects).
// Testable without spawning the watchdog entry script.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');


// Mirrors scheduler.cjs:215 (single source of truth there; kept in sync here).
const DEFAULT_HEARTBEAT_PATH = path.join(
  os.homedir(), '.claude', 'session-manager', 'scheduler-heartbeat.log',
);

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
function readLastHeartbeat(heartbeatPath = DEFAULT_HEARTBEAT_PATH) {
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
function readLastHeartbeatTs(heartbeatPath = DEFAULT_HEARTBEAT_PATH) {
  const entry = readLastHeartbeat(heartbeatPath);
  return (entry !== null && typeof entry.ts === 'number') ? entry.ts : null;
}

/**
 * heartbeatFresh(heartbeatPath?, maxAgeMs?) → boolean
 *
 * Returns true iff the last heartbeat ts is within maxAgeMs of `now`.
 * Missing / empty / unparseable file → false.
 */
function heartbeatFresh(heartbeatPath = DEFAULT_HEARTBEAT_PATH, maxAgeMs = DEFAULT_MAX_AGE_MS) {
  const ts = readLastHeartbeatTs(heartbeatPath);
  if (ts === null) return false;
  return (Date.now() - ts) < maxAgeMs;
}

/**
 * isPidAlive(pid) → boolean
 *
 * Plain liveness check via process.kill(pid, 0) (no signal sent). Single
 * source of truth for the "is this recorded pid still alive" check used by
 * checkAppLiveness's defense-in-depth relaunch gate.
 *
 * EPERM (pid exists, owned by another user) counts as alive — only ESRCH
 * (no such process) means dead. Watchdog and app run as the same user in
 * practice, so this distinction rarely matters here, but treating EPERM as
 * "dead" would be wrong on its face (the process demonstrably exists).
 */
function isPidAlive(pid) {
  if (typeof pid !== 'number' || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
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

const DEFAULT_RELAUNCH_STATE_PATH = path.join(
  os.homedir(), '.claude', 'session-manager', 'watchdog-relaunch-state.json',
);
const DEFAULT_RELAUNCH_LOG_PATH = path.join(
  os.homedir(), '.claude', 'logs', 'scheduler-watchdog-relaunch.log',
);
const DEFAULT_RELAUNCH_DEBOUNCE_MS = 90_000;
const DEFAULT_MAX_RELAUNCH_ATTEMPTS = 3;

/**
 * checkAppLiveness(opts?) → { alive: boolean, reason: string }
 *
 * Primary signal: heartbeatFresh() within the existing max-age window.
 * Defense-in-depth: if the heartbeat is stale, but the pid it last recorded
 * is still alive (app under heavy load, tick just missed), treat as alive
 * rather than relaunching on top of a live process.
 */
function checkAppLiveness({
  heartbeatPath = DEFAULT_HEARTBEAT_PATH,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
} = {}) {
  if (heartbeatFresh(heartbeatPath, maxAgeMs)) {
    return { alive: true, reason: 'heartbeat-fresh' };
  }
  const last = readLastHeartbeat(heartbeatPath);
  if (last !== null && typeof last.pid === 'number' && isPidAlive(last.pid)) {
    return { alive: true, reason: 'pid-alive-heartbeat-stale' };
  }
  return { alive: false, reason: 'stale-and-dead' };
}

/** Default { lastAttemptTs: null, attemptCount: 0 } on missing/unparseable state file. */
function readRelaunchState(statePath = DEFAULT_RELAUNCH_STATE_PATH) {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return {
      lastAttemptTs: typeof raw.lastAttemptTs === 'number' ? raw.lastAttemptTs : null,
      attemptCount: typeof raw.attemptCount === 'number' ? raw.attemptCount : 0,
    };
  } catch {
    return { lastAttemptTs: null, attemptCount: 0 };
  }
}

/** Atomic write: tmp-<pid>-<ts> → rename (mirrors config.cjs writeJsonSync). */
function writeRelaunchState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tmpPath = `${statePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, statePath);
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
function defaultSpawnRelaunch({ logPath = DEFAULT_RELAUNCH_LOG_PATH } = {}) {
  const { spawn } = require('node:child_process');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const fd = fs.openSync(logPath, 'a');
  try {
    const child = spawn('npx', ['claude-code-session-manager@latest'], {
      detached: true,
      stdio: ['ignore', fd, fd],
    });
    child.on('error', (e) => {
      logRelaunchLine(logPath, `spawn error: ${e?.message}`);
    });
    child.unref();
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * maybeRelaunchApp(opts?) → { relaunched: boolean, reason: string, attemptCount: number }
 *
 * Debounced, capped auto-relaunch:
 *   - alive (heartbeat fresh or pid alive)             → no-op, reset attempt state.
 *   - dead + attemptCount already at maxAttempts         → skip, log diagnostic (give up).
 *   - dead + last attempt < debounceMs ago                → skip (still booting).
 *   - dead + debounce elapsed + under cap               → spawn, bump attemptCount, log.
 *
 * attemptCount only resets to 0 once a fresh heartbeat is observed (i.e. a
 * relaunch actually succeeded), so 3 relaunch attempts that each fail to
 * produce a fresh heartbeat permanently cap further attempts until a human
 * intervenes or the app comes up some other way.
 */
function maybeRelaunchApp({
  heartbeatPath = DEFAULT_HEARTBEAT_PATH,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  statePath = DEFAULT_RELAUNCH_STATE_PATH,
  logPath = DEFAULT_RELAUNCH_LOG_PATH,
  debounceMs = DEFAULT_RELAUNCH_DEBOUNCE_MS,
  maxAttempts = DEFAULT_MAX_RELAUNCH_ATTEMPTS,
  now = Date.now(),
  spawnFn = defaultSpawnRelaunch,
} = {}) {
  const liveness = checkAppLiveness({ heartbeatPath, maxAgeMs });
  const state = readRelaunchState(statePath);

  if (liveness.alive) {
    if (state.attemptCount !== 0 || state.lastAttemptTs !== null) {
      writeRelaunchState(statePath, { lastAttemptTs: null, attemptCount: 0 });
    }
    return { relaunched: false, reason: 'alive', attemptCount: 0 };
  }

  if (state.attemptCount >= maxAttempts) {
    logRelaunchLine(
      logPath,
      `giving up: ${state.attemptCount} relaunch attempt(s) already made and heartbeat is still stale — manual intervention required`,
    );
    return { relaunched: false, reason: 'capped', attemptCount: state.attemptCount };
  }

  if (state.lastAttemptTs !== null && (now - state.lastAttemptTs) < debounceMs) {
    return { relaunched: false, reason: 'debounce', attemptCount: state.attemptCount };
  }

  const attemptCount = state.attemptCount + 1;
  spawnFn({ logPath });
  writeRelaunchState(statePath, { lastAttemptTs: now, attemptCount });
  logRelaunchLine(
    logPath,
    `relaunch attempt ${attemptCount}/${maxAttempts}: spawning "npx claude-code-session-manager@latest" (heartbeat stale, last-known pid dead)`,
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

const DEFAULT_STAMP_PATH = path.join(
  os.homedir(), '.claude', 'session-manager', 'history-rollup.stamp',
);
const DEFAULT_LOCK_PATH = path.join(
  os.homedir(), '.claude', 'session-manager', 'history-rollup.lock',
);
const DEFAULT_LOCK_STALE_MS = 10 * 60 * 1000; // 10 min
const DEFAULT_FINALIZE_BUDGET_MS = 60_000;

function readStampDate(stampPath) {
  try {
    return fs.readFileSync(stampPath, 'utf8').trim();
  } catch {
    return null;
  }
}

/** Atomic write: tmp-<pid>-<ts> → rename (mirrors config.cjs writeJsonSync). */
function writeStampDate(stampPath, date) {
  fs.mkdirSync(path.dirname(stampPath), { recursive: true });
  const tmpPath = `${stampPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, date, 'utf8');
  fs.renameSync(tmpPath, stampPath);
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
  const { finalizeClosedDays } = require('../../src/main/historyAggregator.cjs');
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
  stampPath = DEFAULT_STAMP_PATH,
  lockPath = DEFAULT_LOCK_PATH,
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
  isPidAlive,
  localDateStr,
  maybeFinalizeHistory,
  tryAcquireLock,
  releaseLock,
  checkAppLiveness,
  readRelaunchState,
  writeRelaunchState,
  defaultSpawnRelaunch,
  maybeRelaunchApp,
  DEFAULT_HEARTBEAT_PATH,
  DEFAULT_MAX_AGE_MS,
  DEFAULT_STAMP_PATH,
  DEFAULT_LOCK_PATH,
  DEFAULT_LOCK_STALE_MS,
  DEFAULT_FINALIZE_BUDGET_MS,
  DEFAULT_RELAUNCH_STATE_PATH,
  DEFAULT_RELAUNCH_LOG_PATH,
  DEFAULT_RELAUNCH_DEBOUNCE_MS,
  DEFAULT_MAX_RELAUNCH_ATTEMPTS,
};
