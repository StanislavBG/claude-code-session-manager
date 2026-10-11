'use strict';

const { execFile } = require('node:child_process');
const path = require('node:path');

const START = '__SM_PATH_START__';
const END = '__SM_PATH_END__';
const DEFAULT_TIMEOUT_MS = 3000;

/**
 * A packaged macOS app launched from Finder/Dock inherits only
 * /usr/bin:/bin:/usr/sbin:/sbin, so nvm/asdf/volta/fnm/Homebrew installs of
 * node, git and claude are invisible. Ask the user's login shell for its PATH.
 * Complements cleanEnv.pathWithUserBins (fixed dirs, appended).
 */

/** @param {{shell?: string, platform?: string, timeoutMs?: number, env?: NodeJS.ProcessEnv}} [opts] */
function resolveShell(opts) {
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  return opts.shell || env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
}

/**
 * Login-shell PATH, or null on timeout / non-zero exit / missing markers /
 * win32 (fail-open: callers keep their current PATH).
 * @param {{shell?: string, platform?: string, timeoutMs?: number, env?: NodeJS.ProcessEnv}} [opts]
 * @returns {Promise<string|null>}
 */
function readLoginShellPath(opts = {}) {
  const platform = opts.platform || process.platform;
  if (platform === 'win32') return Promise.resolve(null);
  const shell = resolveShell(opts);
  const cmd = `printf '%s' '${START}'; printf '%s' "$PATH"; printf '%s' '${END}'`;
  return new Promise((resolve) => {
    try {
      execFile(
        shell,
        ['-ilc', cmd],
        { timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, env: opts.env || process.env, encoding: 'utf8' },
        (err, stdout) => {
          if (err) return resolve(null);
          const out = String(stdout || '');
          const s = out.indexOf(START);
          if (s < 0) return resolve(null);
          const from = s + START.length;
          const e = out.indexOf(END, from);
          if (e < 0) return resolve(null);
          resolve(out.slice(from, e));
        },
      );
    } catch {
      resolve(null);
    }
  });
}

/**
 * Prepend login-shell PATH entries not already present to env.PATH
 * (order preserved, deduped, empties dropped).
 * @param {{shell?: string, platform?: string, timeoutMs?: number, env?: NodeJS.ProcessEnv}} [opts]
 * @returns {Promise<{applied: boolean, added: number}>}
 */
async function applyLoginShellPath(opts = {}) {
  const platform = opts.platform || process.platform;
  if (platform === 'win32') return { applied: false, added: 0 };
  const loginPath = await readLoginShellPath(opts);
  if (loginPath === null) return { applied: false, added: 0 };
  const env = opts.env || process.env;
  const current = (env.PATH || '').split(path.delimiter).filter(Boolean);
  const seen = new Set(current);
  const fresh = [];
  for (const entry of loginPath.split(path.delimiter)) {
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    fresh.push(entry);
  }
  if (fresh.length) env.PATH = [...fresh, ...current].join(path.delimiter);
  return { applied: true, added: fresh.length };
}

module.exports = { readLoginShellPath, applyLoginShellPath };
