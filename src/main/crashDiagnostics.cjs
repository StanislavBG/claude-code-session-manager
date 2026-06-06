// Crash & OOM diagnostics for the main process.
//
// WHY THIS EXISTS: the app has been dying "silently" — its own logs end
// mid-stream with no error line. That signature is a *native* termination
// (kernel OOM-kill / SIGKILL / renderer segfault), which `process.on
// ('uncaughtException')` can NEVER catch because no JS exception is thrown;
// the process just disappears. System journal confirmed repeated
// `oom-kill` events against the Electron renderer (Chromium tags renderers
// with oom_score_adj:300, making them the kernel's first victim under
// memory pressure). Because the app holds a `powerSaveBlocker` suspend
// inhibitor, its death releases the org.freedesktop.login1 inhibitor and
// Pop!_OS idle-suspends — hence "app crashes -> machine falls asleep".
//
// This module adds the four things needed to catch the next occurrence:
//   1. Chromium crash-reason hooks — render-process-gone / child-process-gone
//      surface `reason: 'oom' | 'crashed' | 'killed'` and the dead process type.
//   2. A memory heartbeat — per-process working-set sampled on an interval and
//      persisted to a sentinel file, so the LAST sample before a SIGKILL
//      survives the crash and is logged at next boot.
//   3. An unclean-shutdown sentinel — if the previous run never marked a clean
//      exit, we log a WARN at boot with that last memory sample (the OOM
//      postmortem the app could not write while dying).
//   4. powerMonitor + blocker-state logging — ties suspend/resume events and
//      the inhibitor's health to the crash timeline.

const { app, powerSaveBlocker, powerMonitor, crashReporter } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

let logs = null;
let getPowerBlockerId = () => -1;
let onSuspendWhileAlive = null;
let heartbeatTimer = null;
let sentinelPath = null;
let startedAtIso = null;
let lastSample = null;

// Warn threshold for total working set across all Electron processes. The OOM
// journal showed a single renderer hitting ~900 MB anon-rss before the kernel
// stepped in; warning at 1.5 GB total gives an early signal in the app's own
// log BEFORE the kill, turning a silent death into a visible ramp. Override
// with SM_MEM_WARN_MB.
const MEM_WARN_MB = Number(process.env.SM_MEM_WARN_MB) || 1500;
// Heartbeat cadence. 30s is fine-grained enough to catch the last sample
// before an OOM yet cheap (getAppMetrics is O(numProcesses), ~5-10 procs).
const HEARTBEAT_MS = Number(process.env.SM_MEM_HEARTBEAT_MS) || 30_000;

function sentinelFile() {
  return path.join(app.getPath('userData'), 'logs', 'last-run.json');
}

// crashReporter collects local minidumps for renderer/GPU SIGSEGV/SIGABRT
// crashes (NOT OOM — a SIGKILL leaves no dump). Local-only, never uploaded.
// Must run before the app is ready, so call this at module require time from
// index.cjs's top level.
function startCrashReporter() {
  try {
    crashReporter.start({
      productName: 'claude-code-session-manager',
      companyName: 'session-manager',
      uploadToServer: false,
      compress: true,
    });
  } catch { /* best-effort: diagnostics must never break boot */ }
}

// Snapshot per-process memory. app.getAppMetrics() returns one entry per
// Electron process (Browser/GPU/Tab/Utility) with workingSetSize in KB.
function sampleMemory() {
  let metrics = [];
  try { metrics = app.getAppMetrics(); } catch { /* not ready yet */ }
  const procs = metrics.map((m) => ({
    pid: m.pid,
    type: m.type,
    name: m.name || m.serviceName || undefined,
    // workingSetSize is in KB; normalize to MB for readability.
    mb: Math.round((m.memory?.workingSetSize || 0) / 1024),
  }));
  const totalMb = procs.reduce((s, p) => s + p.mb, 0);
  const mu = process.memoryUsage();
  return {
    ts: new Date().toISOString(),
    totalMb,
    main: {
      rssMb: Math.round(mu.rss / 1048576),
      heapUsedMb: Math.round(mu.heapUsed / 1048576),
      externalMb: Math.round(mu.external / 1048576),
    },
    powerBlockerHeld: (() => {
      try { return powerSaveBlocker.isStarted(getPowerBlockerId()); } catch { return null; }
    })(),
    procs,
  };
}

function persistSentinel(clean) {
  if (!sentinelPath) return;
  const payload = {
    open: !clean,            // true while running; flipped false on clean quit
    pid: process.pid,
    startedAt: startedAtIso,
    closedAt: clean ? new Date().toISOString() : undefined,
    lastSample,
  };
  try {
    fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
    fs.writeFileSync(sentinelPath, JSON.stringify(payload), { mode: 0o600 });
    // `mode` only applies on CREATE; re-assert 0600 so a pre-existing file (or
    // one created under a looser umask) can't keep world-readable perms.
    fs.chmodSync(sentinelPath, 0o600);
  } catch { /* best-effort */ }
}

function heartbeat() {
  lastSample = sampleMemory();
  // Persist every tick so the final pre-crash sample survives a SIGKILL.
  persistSentinel(false);
  const top = [...lastSample.procs].sort((a, b) => b.mb - a.mb).slice(0, 4);
  const level = lastSample.totalMb >= MEM_WARN_MB ? 'warn' : 'debug';
  logs?.writeLine({
    scope: 'crash-diag',
    level,
    message: level === 'warn' ? 'memory high' : 'memory heartbeat',
    meta: {
      totalMb: lastSample.totalMb,
      mainRssMb: lastSample.main.rssMb,
      powerBlockerHeld: lastSample.powerBlockerHeld,
      top: top.map((p) => `${p.type}:${p.mb}MB`),
    },
  });
}

// Read the previous run's sentinel. If it was still `open`, the app died
// without a clean quit — almost certainly the OOM-kill we're hunting. Log it
// as the postmortem the dying process couldn't write, including its last
// memory sample so we can see the footprint at time of death.
function checkPreviousRun() {
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(sentinelPath, 'utf8')); } catch { return; }
  if (!prev || prev.open !== true) return;
  const s = prev.lastSample;
  logs?.writeLine({
    scope: 'crash-diag',
    level: 'error',
    message: 'previous session ended UNCLEANLY (likely OOM-kill / native crash — no graceful quit)',
    meta: {
      prevPid: prev.pid,
      startedAt: prev.startedAt,
      lastSampleTs: s?.ts,
      lastTotalMb: s?.totalMb,
      lastMainRssMb: s?.main?.rssMb,
      lastTop: s && Array.isArray(s.procs) ? [...s.procs].sort((a, b) => b.mb - a.mb).slice(0, 4).map((p) => `${p.type}:${p.mb}MB`) : undefined,
      powerBlockerHeldAtDeath: s?.powerBlockerHeld,
      hint: 'Check `journalctl -k | grep -i oom` around lastSampleTs to confirm the kernel OOM-killer.',
    },
  });
}

function registerCrashHooks() {
  // Renderer death — reason is the prize: 'oom' | 'crashed' | 'killed' |
  // 'launch-failed' | 'integrity-failure'. This fires even when the kernel
  // OOM-kills only the renderer (main process survives to log it).
  app.on('render-process-gone', (_e, _wc, details) => {
    logs?.writeLine({
      scope: 'crash-diag',
      level: 'error',
      message: 'render-process-gone',
      meta: { reason: details?.reason, exitCode: details?.exitCode, lastTotalMb: lastSample?.totalMb },
    });
  });

  // GPU / Utility / Pepper / network-service child death.
  app.on('child-process-gone', (_e, details) => {
    logs?.writeLine({
      scope: 'crash-diag',
      level: 'error',
      message: 'child-process-gone',
      meta: {
        type: details?.type,
        name: details?.name || details?.serviceName,
        reason: details?.reason,
        exitCode: details?.exitCode,
        lastTotalMb: lastSample?.totalMb,
      },
    });
  });

  // powerMonitor ties the suspend story to the crash timeline. If we ever log
  // a 'suspend' while the app is alive, the inhibitor failed; if the app dies
  // first, the unclean-shutdown postmortem at next boot is the trail instead.
  try {
    powerMonitor.on('suspend', () => {
      logs?.writeLine({ scope: 'crash-diag', level: 'warn', message: 'system suspend (powerMonitor) — inhibitor did NOT hold while app alive', meta: { powerBlockerHeld: lastSample?.powerBlockerHeld } });
      // Self-heal: a suspend firing while we're alive means the OS-level lock
      // lapsed (e.g. our systemd-inhibit child died, or Electron's blocker is a
      // no-op under COSMIC). Re-assert it on resume so the NEXT idle window is
      // covered instead of silently leaving the machine unprotected.
      try { onSuspendWhileAlive?.(); } catch { /* never let a heal attempt break logging */ }
    });
    powerMonitor.on('resume', () => {
      logs?.writeLine({ scope: 'crash-diag', level: 'info', message: 'system resume (powerMonitor)' });
    });
  } catch { /* powerMonitor needs a ready app on some platforms */ }
}

function init(opts) {
  logs = opts.logs;
  if (typeof opts.getPowerBlockerId === 'function') getPowerBlockerId = opts.getPowerBlockerId;
  if (typeof opts.onSuspendWhileAlive === 'function') onSuspendWhileAlive = opts.onSuspendWhileAlive;
  sentinelPath = sentinelFile();
  startedAtIso = new Date().toISOString();

  checkPreviousRun();       // postmortem for the previous (possibly OOM'd) run
  persistSentinel(false);   // mark this run as open
  registerCrashHooks();

  heartbeat();              // immediate baseline sample
  heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS);
  if (heartbeatTimer.unref) heartbeatTimer.unref(); // don't keep the loop alive
}

// Call from will-quit so a graceful exit is distinguishable from an OOM-kill.
function markCleanShutdown() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  persistSentinel(true);
}

module.exports = { startCrashReporter, init, markCleanShutdown };
