'use strict';

/**
 * timeoutShimScript.cjs — a dependency-free stand-in for GNU coreutils'
 * `timeout`, for machines that don't ship one (stock macOS has no `timeout`
 * binary at all, so a PRD gate command that starts with `timeout <seconds>
 * ...` fails outright there).
 *
 * This file is copied byte-for-byte (see timeoutShim.cjs's ensureTimeoutShim)
 * to `~/.claude/session-manager/bin/timeout-shim.cjs` and run from there by a
 * tiny POSIX launcher. It must never require anything outside Node's own
 * builtins, so it keeps working no matter where it lands or which Node it
 * runs under (plain `node`, or Electron with ELECTRON_RUN_AS_NODE=1 — both
 * launch this file as the main module with the same `process.argv` shape).
 *
 * Usage: timeout [OPTION] DURATION COMMAND [ARG]...
 *
 * This covers only the GNU `timeout` forms a PRD gate actually uses. It adds
 * no option GNU timeout lacks.
 *
 * DURATION is a number (float allowed), optionally suffixed s/m/h/d
 * (default s). 0 means no limit. A duration above Node's signed-32-bit
 * setTimeout cap (2,147,483,647 ms, about 24.8 days) is re-armed in chunks —
 * see setLongTimeout below — rather than passed straight to setTimeout,
 * which would silently fire after 1ms instead of waiting.
 *
 * Options: -s/--signal=SIGNAL (name or number, with or without the SIG
 * prefix; default TERM), -k/--kill-after=DURATION, --foreground,
 * --preserve-status, -v/--verbose, --help, --version, -- to end options.
 *
 * SIGNAL must name a real signal: a number must be a nonzero value from
 * os.constants.signals, and a name must match a key of os.constants.signals
 * once uppercased and SIG-prefixed. Anything else — including an empty
 * value, e.g. `--signal=` — is a usage error (exit 125), never a silent
 * fallback to the default. --kill-after=0 means no kill-after at all (same
 * as omitting -k), matching GNU: it does not arm a timer that fires
 * immediately.
 *
 * Rule: on timeout, signal the whole process group, not just the direct
 * child. Why: a child that is itself a wrapper (a shell, a test runner) can
 * spawn a grandchild that keeps running after the direct child is gone — only
 * a group-wide signal reaches it too.
 *
 * Exit codes (GNU-compatible):
 *   124    COMMAND timed out (unless --preserve-status)
 *   125    this script's own usage error
 *   126    COMMAND found but not runnable (EACCES)
 *   127    COMMAND not found (ENOENT)
 *   128+N  COMMAND was killed by signal N — covers 137 (128+SIGKILL), the
 *          case where DURATION expired, COMMAND ignored the first signal,
 *          and -k's follow-up SIGKILL was the one that actually landed
 *   otherwise  COMMAND's own exit code
 */

const { spawn } = require('node:child_process');
const os = require('node:os');

const HELP = `Usage: timeout [OPTION] DURATION COMMAND [ARG]...
Start COMMAND, and kill it if it is still running after DURATION.

  -s, --signal=SIGNAL    signal to send on timeout (name or number; default TERM)
  -k, --kill-after=DUR   also send KILL after DUR if COMMAND is still running
      --foreground       do not put COMMAND in its own process group
      --preserve-status  exit with COMMAND's own status, even after a timeout
  -v, --verbose          log signals sent to stderr
      --help             show this help and exit
      --version          show version and exit

DURATION is a number, optionally followed by s/m/h/d (default s). 0 means no limit.
`;

const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

function usageError(message) {
  process.stderr.write(`timeout: ${message}\n`);
  process.stderr.write(`Try 'timeout --help' for more information.\n`);
  process.exit(125);
}

/** Parses a GNU-style DURATION token into milliseconds. Returns null when the
 *  token is not a valid duration. Uses String#match rather than
 *  RegExp#exec — same result shape for a non-global pattern, just a form
 *  that doesn't read as a shell-exec call at a glance. */
function parseDurationMs(token) {
  const m = String(token).match(/^(\d+(?:\.\d+)?)([smhd]?)$/);
  if (!m) return null;
  const multiplier = { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2]];
  return Number(m[1]) * multiplier * 1000;
}

/** Normalizes a signal option value (name with or without SIG prefix, or a
 *  number) to what node:child_process.kill expects. Returns null when the
 *  value names no known signal — including an empty value, which is a usage
 *  error, not a request for the default (the default is applied by
 *  parseArgs's own initial `opts.signal = 'SIGTERM'`, before this function
 *  ever runs). A numeric value is valid only when it is a nonzero entry of
 *  os.constants.signals — not just any digit string. */
function normalizeSignal(raw) {
  const token = String(raw).trim();
  if (/^\d+$/.test(token)) {
    const n = Number(token);
    if (n === 0 || !Object.values(os.constants.signals).includes(n)) return null;
    return n;
  }
  let name = token.toUpperCase();
  if (!name.startsWith('SIG')) name = `SIG${name}`;
  if (!(name in os.constants.signals)) return null;
  return name;
}

function signalNumber(sigName) {
  return os.constants.signals[sigName] || 0;
}

// Node's setTimeout takes a signed 32-bit ms value. A delay above
// MAX_SETTIMEOUT_MS (2,147,483,647 ms, about 24.8 days) wraps and fires
// after 1ms instead of waiting — so `timeout 30d cmd` would kill `cmd`
// immediately. setLongTimeout re-arms in MAX_SETTIMEOUT_MS chunks until the
// full delay has elapsed, then calls `fn` once. Returns a handle for
// clearLongTimeout; one handle covers every chunk, so clearing mid-wait
// still works.
const MAX_SETTIMEOUT_MS = 2_147_483_647;

function setLongTimeout(fn, ms) {
  const handle = { timer: null, cancelled: false };
  function arm(remaining) {
    const step = Math.min(remaining, MAX_SETTIMEOUT_MS);
    handle.timer = setTimeout(() => {
      if (handle.cancelled) return;
      const left = remaining - step;
      if (left > 0) arm(left);
      else fn();
    }, step);
  }
  arm(Math.max(0, ms));
  return handle;
}

function clearLongTimeout(handle) {
  if (!handle) return;
  handle.cancelled = true;
  if (handle.timer) clearTimeout(handle.timer);
}

/** Pure argv parser. Returns either {help:true}, {version:true},
 *  {error:string}, or the parsed option bag with `.rest` holding
 *  [DURATION, COMMAND, ...COMMAND_ARGS]. */
function parseArgs(argv) {
  const opts = { signal: 'SIGTERM', killAfter: null, foreground: false, preserveStatus: false, verbose: false };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--') { i += 1; break; }
    if (a === '--help') return { help: true };
    if (a === '--version') return { version: true };
    if (a === '--foreground') { opts.foreground = true; i += 1; continue; }
    if (a === '--preserve-status') { opts.preserveStatus = true; i += 1; continue; }
    if (a === '-v' || a === '--verbose') { opts.verbose = true; i += 1; continue; }
    if (a === '-s' || a === '--signal') {
      if (argv[i + 1] === undefined) return { error: `option '${a}' requires an argument` };
      opts.signal = argv[i + 1]; i += 2; continue;
    }
    if (a.startsWith('--signal=')) { opts.signal = a.slice('--signal='.length); i += 1; continue; }
    if (a === '-k' || a === '--kill-after') {
      if (argv[i + 1] === undefined) return { error: `option '${a}' requires an argument` };
      opts.killAfter = argv[i + 1]; i += 2; continue;
    }
    if (a.startsWith('--kill-after=')) { opts.killAfter = a.slice('--kill-after='.length); i += 1; continue; }
    if (a.startsWith('-') && a !== '-') return { error: `unrecognized option '${a}'` };
    break;
  }
  opts.rest = argv.slice(i);
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { process.stdout.write(HELP); process.exit(0); return; }
  if (opts.version) { process.stdout.write('timeout-shim (session-manager) 1.0\n'); process.exit(0); return; }
  if (opts.error) { usageError(opts.error); return; }

  const rest = opts.rest || [];
  if (rest.length < 1) { usageError('missing operand'); return; }
  const [durationToken, command, ...commandArgs] = rest;
  if (!command) { usageError(`missing command after DURATION '${durationToken}'`); return; }

  const durationMs = parseDurationMs(durationToken);
  if (durationMs === null) { usageError(`invalid time interval '${durationToken}'`); return; }

  let killAfterMs = null;
  if (opts.killAfter != null) {
    killAfterMs = parseDurationMs(opts.killAfter);
    if (killAfterMs === null) { usageError(`invalid time interval '${opts.killAfter}'`); return; }
  }

  const signal = normalizeSignal(opts.signal);
  if (signal === null) { usageError(`invalid signal '${opts.signal}'`); return; }

  let child = null;
  let settled = false;
  let timedOut = false;
  let killAfterFired = false;
  let timer = null;
  let killAfterTimer = null;

  const forwardHandlers = {};
  for (const sig of FORWARDED_SIGNALS) {
    forwardHandlers[sig] = () => { if (child) killGroup(sig); };
    process.on(sig, forwardHandlers[sig]);
  }

  function finish(code) {
    if (settled) return;
    settled = true;
    if (timer) clearLongTimeout(timer);
    if (killAfterTimer) clearLongTimeout(killAfterTimer);
    for (const sig of FORWARDED_SIGNALS) process.removeListener(sig, forwardHandlers[sig]);
    process.exit(code);
  }

  // Signal the whole process group first (so a grandchild the direct child
  // spawned, without detaching further, dies too); fall back to the direct
  // pid only when the group signal itself fails (e.g. --foreground, where
  // the child shares OUR group rather than leading its own).
  function killGroup(sig) {
    try {
      process.kill(-child.pid, sig);
    } catch {
      try { process.kill(child.pid, sig); } catch { /* already gone */ }
    }
  }

  try {
    child = spawn(command, commandArgs, { stdio: 'inherit', detached: !opts.foreground });
  } catch (err) {
    finish(err && err.code === 'EACCES' ? 126 : 127);
    return;
  }

  if (durationMs > 0) {
    timer = setLongTimeout(() => {
      timedOut = true;
      if (opts.verbose) process.stderr.write(`timeout: sending signal ${String(signal)} to command '${command}'\n`);
      killGroup(signal);
      // killAfterMs === 0 means "no kill-after", same as -k not given at
      // all — GNU timeout never arms a kill timer that fires immediately.
      if (killAfterMs != null && killAfterMs > 0) {
        killAfterTimer = setLongTimeout(() => {
          killAfterFired = true;
          if (opts.verbose) process.stderr.write(`timeout: sending signal KILL to command '${command}'\n`);
          killGroup('SIGKILL');
        }, killAfterMs);
      }
    }, durationMs);
  }

  child.on('error', (err) => {
    finish(err && err.code === 'EACCES' ? 126 : 127);
  });

  child.on('exit', (code, sig) => {
    if (sig) {
      // Died from a signal. If that signal was OUR timeout's original
      // (not-yet-escalated-to-KILL) signal, report the conventional 124 —
      // unless the caller asked to see the command's real status instead.
      if (timedOut && !killAfterFired && !opts.preserveStatus) { finish(124); return; }
      finish(128 + signalNumber(sig));
      return;
    }
    if (timedOut && !opts.preserveStatus) { finish(124); return; }
    finish(code == null ? 0 : code);
  });
}

if (require.main === module) main();
