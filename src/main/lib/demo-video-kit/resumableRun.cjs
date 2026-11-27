'use strict';
// Demo-video kit resumable run: one long kit step (e.g. a slow local voice)
// runs under a detached supervisor, and callers wait for it in slices.
//
// Why: a headless scheduler job's foreground Bash call is capped at 15 minutes
// and its idle watchdog fires after 20 minutes without output, so a step that
// can take longer must outlive one call. Each call runs startOrAttach (same
// key -> attach to the live run) then waitForResult for one slice; 'pending'
// means "call again".
//
// How it ends: on Linux the job's scope and the scheduler's leftover sweep stop
// the supervisor's process group with the job. On every platform (macOS sweeps
// only the job's own process group) the caller lease ends it: startOrAttach and
// every waitForResult check refresh <stateDir>/lease, and the supervisor writes
// an 'abandoned' result and SIGTERMs its whole group once no caller has checked
// in for DEFAULT_LEASE_MS.
//
// Why own pid check, single-write result file and tolerant JSON read although
// src/main/lib/AGENTS.md says to reuse process/pidAlive.cjs and
// util/atomicFs.cjs: kit files are seeded to ~/.claude/session-manager/
// demo-video-kit/ and must load standalone (node built-ins and this folder
// only), so they cannot require those modules. A partial result.json reads as
// "not written yet".
//
// Files in stateDir: state.json { key, pid, startedAt }, lease (mtime only),
// result.json { key, result }, run.log (supervisor + step stdout/stderr of the
// latest fresh run; truncated on each fresh start), start.lock (held only while
// startOrAttach starts a run, so two concurrent starts spawn one supervisor).
//
// Process tree: on POSIX the supervisor leads its own process group and stops
// the whole group (SIGTERM) on lease expiry and after its step exits, so a
// voice wrapper's grandchildren never outlive the run. On win32 the same
// points run `taskkill /PID <pid> /T /F` (winTreeKillArgv).
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const DEFAULT_LEASE_MS = 20 * 60 * 1000;
const LEASE_CHECK_MAX_MS = 15 * 1000;
const DEFAULT_POLL_MS = 1000;
const LOG_TAIL_BYTES = 500;
const START_LOCK_STALE_MS = 30 * 1000;
const START_LOCK_WAIT_MS = 50;
const START_LOCK_MAX_WAITS = 40;

const statePath = (d) => path.join(d, 'state.json');
const leasePath = (d) => path.join(d, 'lease');
const resultPath = (d) => path.join(d, 'result.json');
const logPath = (d) => path.join(d, 'run.log');
const lockPath = (d) => path.join(d, 'start.lock');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** process.kill(pid, 0): ESRCH = dead, EPERM = alive (someone else's). */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err && err.code === 'EPERM'; }
}

function rmQuiet(file) {
  try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
}

function refreshLease(stateDir) {
  const p = leasePath(stateDir);
  try {
    fs.closeSync(fs.openSync(p, 'a'));
    const now = new Date();
    fs.utimesSync(p, now, now);
  } catch { /* stateDir gone: the run was stopped */ }
}

function readState(stateDir) {
  const s = readJson(statePath(stateDir));
  return s && typeof s === 'object' && typeof s.key === 'string' && Number.isInteger(s.pid) ? s : null;
}

/** Single write of { key, result }; readers treat a partial file as not written yet. */
function writeResult(stateDir, key, result) {
  fs.writeFileSync(resultPath(stateDir), JSON.stringify({ key, result }));
}

function readResult(stateDir, key) {
  const r = readJson(resultPath(stateDir));
  if (!r || typeof r !== 'object' || r.key !== key || !('result' in r)) return null;
  return r;
}

/** Last `bytes` of run.log as text ('' when missing). */
function readLogTail(stateDir, bytes = LOG_TAIL_BYTES) {
  let fd;
  try {
    fd = fs.openSync(logPath(stateDir), 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, Math.max(0, bytes));
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

function killQuiet(pid, sig) {
  try { process.kill(pid, sig); } catch { /* ESRCH: already gone */ }
}

/** win32 argv that ends pid and every descendant. */
function winTreeKillArgv(pid) {
  return ['taskkill', '/PID', String(pid), '/T', '/F'];
}

/** End pid's whole tree: taskkill /T on win32, SIGTERM to its process group on POSIX. */
function killTree(pid) {
  if (process.platform === 'win32') {
    const argv = winTreeKillArgv(pid);
    try { spawnSync(argv[0], argv.slice(1), { shell: false, windowsHide: true, stdio: 'ignore' }); } catch { /* ignore */ }
    return;
  }
  killQuiet(-pid, 'SIGTERM');
  killQuiet(pid, 'SIGTERM');
}

/** Synchronous pause without a busy loop. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Stop the recorded run (its whole process tree) and clear its files. */
function stopRun(stateDir) {
  const s = readState(stateDir);
  if (s) killTree(s.pid);
  rmQuiet(statePath(stateDir));
  rmQuiet(resultPath(stateDir));
  rmQuiet(leasePath(stateDir));
}

/**
 * Start `argv` (node args, run with process.execPath) under a detached
 * supervisor, or attach when the same key's supervisor is still alive.
 * -> { pid, started }
 */
function startOrAttach({ stateDir, key, argv, cwd, leaseMs = DEFAULT_LEASE_MS }) {
  if (!stateDir || typeof key !== 'string' || !key) throw new Error('resumableRun: stateDir and key are required');
  if (!Array.isArray(argv) || argv.length === 0) throw new Error('resumableRun: argv must be a non-empty array');
  fs.mkdirSync(stateDir, { recursive: true });
  const attached = attachLive(stateDir, key);
  if (attached) return attached;
  const lock = lockPath(stateDir);
  let waits = 0;
  let staleRemoved = false;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx'));
      break;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
    }
    // Another caller is starting a run: attach to it once it is recorded.
    const other = attachLive(stateDir, key);
    if (other) return other;
    let age = 0;
    try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { /* released meanwhile: retry */ }
    if (age > START_LOCK_STALE_MS && !staleRemoved) {
      staleRemoved = true;
      rmQuiet(lock);
      continue;
    }
    if (waits >= START_LOCK_MAX_WAITS) {
      throw new Error(`resumableRun: start lock ${lock} is still held after ${START_LOCK_MAX_WAITS * START_LOCK_WAIT_MS} ms`);
    }
    waits++;
    sleepSync(START_LOCK_WAIT_MS);
  }
  try {
    return startLocked({ stateDir, key, argv, cwd, leaseMs });
  } finally {
    rmQuiet(lock);
  }
}

/** Same key with a live supervisor -> attach result; otherwise null. */
function attachLive(stateDir, key) {
  const s = readState(stateDir);
  if (s && s.key === key && pidAlive(s.pid)) {
    refreshLease(stateDir);
    return { pid: s.pid, started: false };
  }
  return null;
}

/** Called with start.lock held: re-check, then start a fresh run. */
function startLocked({ stateDir, key, argv, cwd, leaseMs }) {
  const s = readState(stateDir);
  if (s && pidAlive(s.pid)) {
    if (s.key === key) {
      refreshLease(stateDir);
      return { pid: s.pid, started: false };
    }
    stopRun(stateDir);
  }
  // A fresh run: its waiter must see only its own result and its own log.
  rmQuiet(resultPath(stateDir));
  refreshLease(stateDir);
  const logFd = fs.openSync(logPath(stateDir), 'w');
  let child;
  try {
    child = spawn(process.execPath, [__filename, '__supervise', stateDir, key, String(leaseMs), '--', ...argv], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      cwd,
      env: process.env,
    });
    child.unref();
  } finally {
    fs.closeSync(logFd);
  }
  fs.writeFileSync(statePath(stateDir), JSON.stringify({ key, pid: child.pid, startedAt: Date.now() }));
  refreshLease(stateDir);
  return { pid: child.pid, started: true };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait up to waitMs (never more than waitMs + pollMs) for the key's result.
 * -> { status: 'done', result } | { status: 'pending', pid, elapsedMs } | { status: 'lost', error }
 */
async function waitForResult({ stateDir, key, waitMs, pollMs = DEFAULT_POLL_MS }) {
  const t0 = Date.now();
  const wait = Math.max(0, Number(waitMs) || 0);
  const poll = Math.max(1, Number(pollMs) || DEFAULT_POLL_MS);
  for (;;) {
    refreshLease(stateDir);
    let r = readResult(stateDir, key);
    if (r) return { status: 'done', result: r.result };
    const s = readState(stateDir);
    if (!s || s.key !== key || !pidAlive(s.pid)) {
      r = readResult(stateDir, key); // the step may have written it just before exiting
      if (r) return { status: 'done', result: r.result };
      const why = !s || s.key !== key ? `no run recorded for key ${key}` : `run ${s.pid} ended without a result`;
      return { status: 'lost', error: `${why}; log tail:\n${readLogTail(stateDir, LOG_TAIL_BYTES)}` };
    }
    const spent = Date.now() - t0;
    if (spent >= wait) {
      return { status: 'pending', pid: s.pid, elapsedMs: Date.now() - (Number(s.startedAt) || t0) };
    }
    await sleep(Math.min(poll, wait - spent));
  }
}

function supervise(args) {
  const [stateDir, key, leaseArg, sep, ...argv] = args;
  const leaseMs = Number(leaseArg) > 0 ? Number(leaseArg) : DEFAULT_LEASE_MS;
  if (sep !== '--' || argv.length === 0) {
    process.stderr.write('resumableRun supervisor: missing step argv\n');
    process.exit(2);
  }
  // Not detached: the step and anything it spawns stay in this process group.
  const step = spawn(process.execPath, argv, { stdio: ['ignore', 'inherit', 'inherit'], cwd: process.cwd() });
  const every = Math.min(LEASE_CHECK_MAX_MS, Math.max(1, Math.floor(leaseMs / 4)));
  let timer = null;
  const startLeaseClock = () => {
    // The lease clock starts when the step process actually exists, not when
    // startOrAttach ran: a loaded machine can delay this supervisor past leaseMs.
    refreshLease(stateDir);
    timer = setInterval(() => {
      let age = Infinity;
      try { age = Date.now() - fs.statSync(leasePath(stateDir)).mtimeMs; } catch { /* missing lease = no caller */ }
      if (age <= leaseMs) return;
      clearInterval(timer);
      try {
        writeResult(stateDir, key, { ok: false, error: `abandoned: no caller for ${Math.round(leaseMs / 60000)} min` });
      } catch { /* stateDir gone */ }
      process.stderr.write(`resumableRun supervisor: lease expired, stopping group ${process.pid}\n`);
      killTree(process.pid);
      process.exit(1);
    }, every);
  };
  step.on('spawn', startLeaseClock);
  step.on('error', (err) => {
    process.stderr.write(`resumableRun supervisor: step failed to start: ${err.message}\n`);
    if (timer) clearInterval(timer);
    process.exit(1);
  });
  step.on('exit', (code, signal) => {
    if (timer) clearInterval(timer);
    // The step wrote its result before exiting; stop whatever it left in this
    // group (e.g. a voice wrapper's grandchildren). The waiter is not in it.
    const exitCode = code ?? (signal ? 1 : 0);
    process.on('SIGTERM', () => process.exit(exitCode));
    killTree(process.pid);
    process.exit(exitCode);
  });
}

if (require.main === module && process.argv[2] === '__supervise') {
  supervise(process.argv.slice(3));
}

module.exports = { startOrAttach, waitForResult, writeResult, stopRun, readLogTail, winTreeKillArgv, DEFAULT_LEASE_MS };
