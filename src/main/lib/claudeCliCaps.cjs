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
 */

const { resolveClaudeBin } = require('./claudeBin.cjs');

const PROBE_TIMEOUT_MS = 10_000;
const FLAG_ARGS = ['--permission-prompts', 'none'];

let _execFile = require('node:child_process').execFile;

/** Test hook — inject a stub execFile(file, args, opts, cb) instead of spawning the real CLI. */
function _setExecFileForTest(fn) {
  _execFile = fn || require('node:child_process').execFile;
}

/** Test hook — forget the cached probe result so the next call re-probes. */
function _resetForTest() {
  cachedArgs = null;
  inflight = null;
}

let cachedArgs = null;
let inflight = null;

/** Probes `claude --help` once per process; every call (including concurrent/later ones) resolves the same cached arg array. */
function ensureCliCapsProbed() {
  if (cachedArgs) return Promise.resolve(cachedArgs);
  if (inflight) return inflight;
  let bin;
  try { bin = resolveClaudeBin(); } catch { bin = 'claude'; }
  inflight = new Promise((resolve) => {
    const done = (args) => {
      cachedArgs = args;
      inflight = null;
      resolve(args);
    };
    try {
      _execFile(bin, ['--help'], { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
        if (err) {
          console.warn('[claudeCliCaps] claude --help probe failed; headless spawns will omit --permission-prompts:', err?.message || err);
          done([]);
          return;
        }
        done(String(stdout || '').includes('--permission-prompts') ? FLAG_ARGS.slice() : []);
      });
    } catch (e) {
      console.warn('[claudeCliCaps] claude --help probe threw; headless spawns will omit --permission-prompts:', e?.message || e);
      done([]);
    }
  });
  return inflight;
}

/** Sync accessor for the cached probe result — [] until ensureCliCapsProbed() has resolved at least once. */
function headlessPermissionArgs() {
  return cachedArgs ? cachedArgs.slice() : [];
}

module.exports = { headlessPermissionArgs, ensureCliCapsProbed, _setExecFileForTest, _resetForTest };
