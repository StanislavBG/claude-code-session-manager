'use strict';

/**
 * stdioGuard.cjs — keep console writes to a dead stdout/stderr from becoming
 * uncaughtExceptions.
 *
 * Incident: bin/cli.cjs spawns Electron with stdio ['inherit','inherit','pipe'],
 * so a terminal launch hands the main process the terminal's tty as stdout.
 * Once that terminal closes every write fails with EIO (tty) or EPIPE (pipe),
 * and every console.log after the first became an uncaughtException
 * "write EIO" — 6,603 telemetry reports from one Mac in 5 days (only ~3/min
 * got through, thanks to telemetryClient's errorDedupAllows).
 *
 * Why Node's console does not save us: getStdout()/getStderr() set
 * stream._destroy = dummyDestroy, which calls cb(err) then this._undestroy().
 * On the FIRST failed write, console's write callback sees
 * _writableState.errorEmitted === false and adds once('error', noop), so it is
 * swallowed; emitErrorNT then sets errorEmitted = true. On the NEXT failed
 * write the callback sees errorEmitted === true and adds no listener;
 * dummyDestroy -> _undestroy resets errorEmitted to false and emitErrorNT
 * emits 'error' with zero listeners -> uncaughtException. Reproduced on Node
 * 22.22.1 and Electron 42.11.10 (Node 24.19.0): 10 console.log after the
 * reader closed -> 9 uncaughtException; with any permanent 'error' listener
 * on process.stdout -> 0.
 *
 * The fix: one permanent 'error' listener per stream. On a dead-stream code
 * the stream's write becomes a no-op so nothing further is attempted. The
 * log callback is injected (the file logger in production) — never console,
 * which would recurse into the dead stream.
 */

const DEAD_CODES = new Set(['EIO', 'EPIPE', 'ECONNRESET', 'ENXIO', 'EBADF']);

/** @type {WeakMap<object, { dead: boolean, loggedCodes: Set<string> }>} */
const state = new WeakMap();

function defaultStreams() {
  return [{ name: 'stdout', stream: process.stdout }, { name: 'stderr', stream: process.stderr }];
}

function normalize(entry, i) {
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.on === 'function') {
    let name = `stream${i}`;
    try {
      if (entry === process.stdout) name = 'stdout';
      else if (entry === process.stderr) name = 'stderr';
    } catch { /* ignore */ }
    return { name, stream: entry };
  }
  const s = entry.stream;
  if (!s || typeof s !== 'object' || typeof s.on !== 'function') return null;
  return { name: typeof entry.name === 'string' ? entry.name : `stream${i}`, stream: s };
}

function noopWrite(chunk, encoding, cb) {
  const fn = typeof encoding === 'function' ? encoding : cb;
  if (typeof fn === 'function') process.nextTick(fn);
  return true;
}

function safeLog(log, info) {
  if (typeof log !== 'function') return;
  try { log(info); } catch { /* logging must never throw */ }
}

/**
 * @param {{ streams?: Array<any>, log?: (info: { stream: string, code: string }) => void }} [opts]
 * @returns {void}
 */
function guardStdio({ streams, log } = {}) {
  try {
    const list = Array.isArray(streams) ? streams : defaultStreams();
    list.forEach((entry, i) => {
      try {
        const n = normalize(entry, i);
        if (!n || state.has(n.stream)) return;
        const st = { dead: false, loggedCodes: new Set() };
        state.set(n.stream, st);
        n.stream.on('error', (err) => {
          const code = String((err && err.code) || 'UNKNOWN');
          if (DEAD_CODES.has(code)) {
            if (st.dead) return;
            st.dead = true;
            try { n.stream.write = noopWrite; } catch { /* ignore */ }
            safeLog(log, { stream: n.name, code });
            return;
          }
          if (st.loggedCodes.has(code)) return;
          st.loggedCodes.add(code);
          safeLog(log, { stream: n.name, code });
        });
      } catch { /* never throw */ }
    });
  } catch { /* never throw */ }
}

/** @param {any} err */
function isDeadStdioWriteError(err) {
  if (!err || typeof err !== 'object') return false;
  return err.syscall === 'write' && DEAD_CODES.has(err.code);
}

/** @returns {(err: any) => boolean} true = report this uncaught error */
function createUncaughtReportFilter() {
  let seenDead = false;
  return (err) => {
    if (!isDeadStdioWriteError(err)) return true;
    if (seenDead) return false;
    seenDead = true;
    return true;
  };
}

module.exports = { guardStdio, isDeadStdioWriteError, createUncaughtReportFilter };
