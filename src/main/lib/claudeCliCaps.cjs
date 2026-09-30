'use strict';

/**
 * claudeCliCaps.cjs — probes the installed `claude` CLI for
 * `--permission-prompts` support once per process, caches the result.
 *
 * Headless spawns (scheduler/supervisor/docEdit/runClaudeP) have no human
 * attached, so a tool that waits on AskUserQuestion or a permission prompt
 * would stall the job forever. `--permission-prompts none` (CLI v2.1.285+)
 * auto-denies those prompts and removes human-requiring tools. Older CLIs
 * don't recognize the flag, so it's only appended when `claude --help`
 * confirms support.
 *
 * Only a SUCCESSFUL probe (a real supported/unsupported determination from
 * actual `--help` text) is cached for the rest of the process — an error
 * (ENOENT, timeout, a throw) is never cached: this call returns [] (the safe
 * default: omit the flag) but a LATER call re-probes, subject to a
 * once-per-60s backoff so a persistently broken binary doesn't turn every
 * headless spawn attempt into a fresh probe.
 *
 * The probe spawns the SAME binary/spawn target every real headless spawn
 * site uses — `claudeSpawnTarget('aux', ...)` from claudeBin.cjs — not a raw
 * `resolveClaudeBin()` result, so what gets probed is provably what later
 * gets spawned (aliasing/argv0 labeling included).
 */

const claudeBinLib = require('./claudeBin.cjs');

const PROBE_TIMEOUT_MS = 10_000;
const FLAG_ARGS = ['--permission-prompts', 'none'];
const DEFAULT_REPROBE_AFTER_ERROR_MS = 60_000;

let _execFile = require('node:child_process').execFile;

/** Test hook — inject a stub execFile(file, args, opts, cb) instead of spawning the real CLI. */
function _setExecFileForTest(fn) {
  _execFile = fn || require('node:child_process').execFile;
}

/** Test hook — forget the cached probe result and any error backoff so the next call re-probes immediately. */
function _resetForTest() {
  cachedArgs = null;
  inflight = null;
  lastErrorAt = 0;
  reprobeAfterErrorMs = DEFAULT_REPROBE_AFTER_ERROR_MS;
}

/** Test hook — shrink the once-per-60s error backoff so a re-probe-after-error test doesn't need to sleep 60s. */
function _setReprobeBackoffMsForTest(ms) {
  reprobeAfterErrorMs = typeof ms === 'number' && ms >= 0 ? ms : DEFAULT_REPROBE_AFTER_ERROR_MS;
}

let cachedArgs = null; // set ONLY by a successful probe — never by an error path
let inflight = null;
let lastErrorAt = 0;
let reprobeAfterErrorMs = DEFAULT_REPROBE_AFTER_ERROR_MS;

/**
 * Probes `claude --help` once per process (successful result only); every
 * call (including concurrent/later ones) resolves the same cached arg array
 * once a successful probe has landed. A probe error is never cached — this
 * call still resolves [] for the caller, but the NEXT call re-probes for
 * real once `reprobeAfterErrorMs` has elapsed since the last error.
 */
function ensureCliCapsProbed() {
  if (cachedArgs) return Promise.resolve(cachedArgs);
  if (inflight) return inflight;
  if (lastErrorAt && Date.now() - lastErrorAt < reprobeAfterErrorMs) {
    return Promise.resolve([]);
  }

  let bin;
  try { bin = claudeBinLib.resolveClaudeBin(); } catch { bin = 'claude'; }
  let target;
  try { target = claudeBinLib.claudeSpawnTarget('aux', 'cli-caps-probe', bin); } catch { target = { command: bin }; }

  // NOTE: `inflight` is cleared via `.finally()` below, never directly
  // inside this executor. A real `execFile` callback is always async, but a
  // TEST stub firing its callback synchronously would otherwise run
  // `succeed`/`fail` (and their `inflight = null`) to completion BEFORE the
  // `inflight = promise` assignment two lines down ever runs — leaving
  // `inflight` wedged at a stale, already-settled promise forever, so this
  // function would never re-probe again regardless of the cache/backoff
  // state. `.finally()` callbacks always run as a microtask, strictly after
  // the synchronous assignment below, so this ordering hazard can't recur.
  const promise = new Promise((resolve) => {
    const succeed = (args) => {
      cachedArgs = args;
      resolve(args);
    };
    const fail = () => {
      lastErrorAt = Date.now();
      resolve([]);
    };
    try {
      const execOpts = { timeout: PROBE_TIMEOUT_MS, windowsHide: true };
      if (target.argv0) execOpts.argv0 = target.argv0;
      _execFile(target.command, ['--help'], execOpts, (err, stdout) => {
        if (err) {
          console.warn('[claudeCliCaps] claude --help probe failed; headless spawns will omit --permission-prompts:', err?.message || err);
          fail();
          return;
        }
        succeed(String(stdout || '').includes('--permission-prompts') ? FLAG_ARGS.slice() : []);
      });
    } catch (e) {
      console.warn('[claudeCliCaps] claude --help probe threw; headless spawns will omit --permission-prompts:', e?.message || e);
      fail();
    }
  });
  inflight = promise;
  promise.finally(() => {
    if (inflight === promise) inflight = null;
  });
  return promise;
}

/** Sync accessor for the cached probe result — [] until ensureCliCapsProbed() has resolved successfully at least once. */
function headlessPermissionArgs() {
  return cachedArgs ? cachedArgs.slice() : [];
}

module.exports = {
  headlessPermissionArgs,
  ensureCliCapsProbed,
  _setExecFileForTest,
  _resetForTest,
  _setReprobeBackoffMsForTest,
};
