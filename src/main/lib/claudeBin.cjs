/**
 * claudeBin.cjs — shared resolver for the `claude` executable.
 *
 * Both scheduler.cjs and supervisor.cjs need to spawn `claude -p` jobs.
 * Both used to duplicate this list. Single source of truth here.
 *
 * Returns the first executable candidate found, falling back to bare
 * "claude" so spawn() can still try PATH lookup.
 *
 * Cached after first successful resolution. Process-lifetime.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

let cached = null;

function resolveClaudeBin() {
  // Explicit override wins and is never cached — lets operators pin a binary
  // and lets tests point the runner at a controllable stub process.
  if (process.env.SM_CLAUDE_BIN) return process.env.SM_CLAUDE_BIN;
  if (cached) return cached;
  // Merged candidate list — was forked in scheduler vs pluginInstall before.
  const home = os.homedir();
  const candidates = [
    path.join(home, '.claude', 'local', 'claude'),    // Claude Code bundled install
    path.join(home, '.local', 'bin', 'claude'),       // user pip-style install
    path.join(home, '.npm-global', 'bin', 'claude'),  // user npm-global
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    '/usr/bin/claude',
  ];
  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); cached = c; return c; } catch { /* */ }
  }
  cached = 'claude';
  return cached;
}

// ---------- version probe ----------
//
// `claude --version`, cached. The scheduler's launch circuit breaker
// (lib/launchFailure.cjs) records the CLI version a launch block was armed
// under and drops the block the moment the version changes — the incident
// behind it (issue #11: an outdated CLI sending a thinking parameter the
// model rejects) is fixed by `claude update`, and the queue must notice
// that without a human pressing anything. Async, bounded, never throws:
// a probe failure yields null and the breaker simply loses the
// version-change shortcut (backoff still recovers).
const VERSION_TTL_MS = 5 * 60_000;
const VERSION_PROBE_TIMEOUT_MS = 8_000;
let versionCache = { at: 0, value: null, inflight: null };

function probeClaudeVersion({ now = Date.now(), execFileImpl } = {}) {
  // Operator/test pin: skips executing the binary entirely.
  if (process.env.SM_CLAUDE_VERSION) return Promise.resolve(process.env.SM_CLAUDE_VERSION);
  if (versionCache.inflight) return versionCache.inflight;
  if (versionCache.value !== null && now - versionCache.at < VERSION_TTL_MS) {
    return Promise.resolve(versionCache.value);
  }
  const execFile = execFileImpl || require('node:child_process').execFile;
  const bin = resolveClaudeBin();
  versionCache.inflight = new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      versionCache = { at: Date.now(), value, inflight: null };
      resolve(value);
    };
    try {
      // cwd is a neutral temp dir on purpose: the version does not depend on
      // it, and the binary must never be handed the caller's working tree —
      // a stub `claude` (tests point SM_CLAUDE_BIN at one) that writes
      // markers or commits into process.cwd() once did so in the real repo.
      execFile(bin, ['--version'], { timeout: VERSION_PROBE_TIMEOUT_MS, windowsHide: true, cwd: os.tmpdir() }, (err, stdout) => {
        if (err) return done(null);
        const m = /(\d+\.\d+\.\d+[^\s]*)/.exec(String(stdout || ''));
        done(m ? m[1] : (String(stdout || '').trim() || null));
      });
    } catch {
      done(null);
    }
  });
  return versionCache.inflight;
}

/** Test hook — forget the cached version so the next probe re-executes. */
function resetClaudeVersionCache() {
  versionCache = { at: 0, value: null, inflight: null };
}

module.exports = { resolveClaudeBin, probeClaudeVersion, resetClaudeVersionCache };
