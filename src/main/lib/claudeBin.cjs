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

/**
 * @param {{ platform?: string, env?: Record<string, string|undefined>, homedir?: string,
 *   accessSync?: (p: string, mode?: number) => void }} [opts] injectable for tests;
 *   passing any opts bypasses the process-lifetime cache.
 */
function resolveClaudeBin(opts) {
  // Explicit override wins and is never cached — lets operators pin a binary
  // and lets tests point the runner at a controllable stub process.
  if (process.env.SM_CLAUDE_BIN) return process.env.SM_CLAUDE_BIN;
  const injected = !!opts;
  if (!injected && cached) return cached;
  const platform = (opts && opts.platform) || process.platform;
  const env = (opts && opts.env) || process.env;
  const home = (opts && opts.homedir) || os.homedir();
  const accessSync = (opts && opts.accessSync) || fs.accessSync;
  let candidates;
  let mode;
  if (platform === 'win32') {
    const w = path.win32;
    candidates = [];
    if (env.USERPROFILE) candidates.push(w.join(env.USERPROFILE, '.local', 'bin', 'claude.exe')); // native installer
    if (env.APPDATA) candidates.push(w.join(env.APPDATA, 'npm', 'claude.cmd'));
    if (env.LOCALAPPDATA) candidates.push(w.join(env.LOCALAPPDATA, 'Programs', 'claude', 'claude.exe'));
    mode = fs.constants.F_OK; // X_OK is meaningless on Windows
  } else {
    // Merged candidate list — was forked in scheduler vs pluginInstall before.
    candidates = [
      path.join(home, '.claude', 'local', 'claude'),    // Claude Code bundled install
      path.join(home, '.local', 'bin', 'claude'),       // user pip-style install
      path.join(home, '.npm-global', 'bin', 'claude'),  // user npm-global
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
      '/usr/bin/claude',
    ];
    mode = fs.constants.X_OK;
  }
  for (const c of candidates) {
    try { accessSync(c, mode); if (!injected) cached = c; return c; } catch { /* */ }
  }
  if (!injected) cached = 'claude';
  return 'claude';
}

/** Test hook — forget the cached resolution. */
function __resetForTests() { cached = null; }

// ---------- process naming ----------
//
// Every `claude` spawn goes through claudeSpawnTarget so GNOME System Monitor
// shows a distinct comm per role (sm-claude-job / -chat / -aux) and a labelled
// argv0. See lib/procName.cjs for the mechanics. Invariants:
//  - SM_CLAUDE_BIN set → aliasing SKIPPED, raw value used verbatim (tests point
//    it at self-locating stubs; it must stay ONE binary, no path splitting).
//  - aliasBinFor fails open (returns realBin) → no argv0 is set either, so the
//    fallback is byte-identical to the pre-naming spawn.
//  - Every alias and argv0 label contains the word `claude`, which the four
//    /\bclaude\b/ cmdline gates (killOrphanClaudePid, claudePidAlive,
//    findLiveProcessForJob x2) depend on.
const ROLE_ALIASES = { job: 'sm-claude-job', chat: 'sm-claude-chat', aux: 'sm-claude-aux' };

/**
 * @param {'job'|'chat'|'aux'} role
 * @param {string} [detail] argv0 label detail (job slug / epic session id)
 * @param {string} [realBin] defaults to resolveClaudeBin()
 * @param {string[]} [args] the claude argv; only needed so a Windows .cmd/.bat shim can be wrapped
 * @param {{ platform?: string, env?: Record<string, string|undefined>, exists?: (p: string) => boolean }} [winOpts] injectable for tests
 * @returns {{ command: string, argv0?: string, args?: string[], windowsVerbatimArguments?: boolean }}
 *   spread `argv0` into spawn options; when `args` is present spawn with it instead of the caller's argv
 */
function claudeSpawnTarget(role, detail, realBin = resolveClaudeBin(), args = [], winOpts = {}) {
  const base = baseSpawnTarget(role, detail, realBin);
  const platform = winOpts.platform || process.platform;
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(base.command)) return base;
  // Node refuses to spawn a .cmd/.bat without a shell (EINVAL) — wrap in cmd.exe argv.
  const { resolveSpawn } = require('./winSpawn.cjs');
  const wrapped = resolveSpawn(base.command, args, { platform, ...(winOpts.env ? { env: winOpts.env } : {}), ...(winOpts.exists ? { exists: winOpts.exists } : {}) });
  return { ...base, ...wrapped };
}

function baseSpawnTarget(role, detail, realBin) {
  if (process.env.SM_CLAUDE_BIN) return { command: realBin };
  const alias = ROLE_ALIASES[role];
  if (!alias) return { command: realBin };
  try {
    const { aliasBinFor, smArgv0 } = require('./procName.cjs');
    const command = aliasBinFor(realBin, alias);
    if (command === realBin) return { command: realBin };
    return { command, argv0: smArgv0(role, detail) };
  } catch {
    return { command: realBin };
  }
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
      const target = claudeSpawnTarget('aux', 'version', bin, ['--version']);
      execFile(target.command, target.args || ['--version'], { timeout: VERSION_PROBE_TIMEOUT_MS, windowsHide: true, cwd: os.tmpdir(), ...(target.argv0 ? { argv0: target.argv0 } : {}), ...(target.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) }, (err, stdout) => {
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

module.exports = { resolveClaudeBin, __resetForTests, claudeSpawnTarget, probeClaudeVersion, resetClaudeVersionCache };
