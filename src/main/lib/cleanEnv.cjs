const os = require('node:os');
const path = require('node:path');

const SECRET_KEY_RE = /^(?:.*_)?(TOKEN|API_?KEY|SECRET|PASSWORD|AUTHORIZATION|COOKIE|REFRESH[_-]?TOKEN|ACCESS[_-]?TOKEN)$/i;

/**
 * Common user + Homebrew bin dirs to PREPEND to a spawned child's PATH.
 * Electron can launch from Finder/Dock with a stripped PATH, and Apple Silicon
 * Homebrew lives under /opt/homebrew — without these, `claude`, git, node, etc.
 * are invisible to ptys and `claude -p` jobs on macOS. Single source of truth
 * so pty.cjs and pluginInstall.cjs can't drift (one of them was missing
 * /opt/homebrew and broke plugin install on Apple Silicon).
 */
function userBinDirs() {
  const home = os.homedir();
  return [
    path.join(home, '.claude', 'local'),
    path.join(home, '.local', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ];
}

/** Electron's PATH with the user/Homebrew bin dirs APPENDED as a fallback — the
 *  value to put in a spawned child's PATH so `claude`, node, git, etc. resolve
 *  on macOS even under a stripped Finder/Dock PATH. Appended (not prepended) so
 *  a user's version manager (nvm/asdf/volta/mise) earlier in PATH still wins and
 *  isn't shadowed by /opt/homebrew. */
function pathWithUserBins() {
  const base = process.env.PATH || '';
  return base ? `${base}:${userBinDirs().join(':')}` : userBinDirs().join(':');
}

/**
 * SM_PROC_ROLE attributes a child (and, by inheritance, every MCP server the
 * `claude` child spawns — we cannot rename those) via /proc/<pid>/environ.
 * Read by scripts/sm-ps.cjs. NOT SM_PROC_ROOT (procIdentity.cjs's /proc-root
 * test override) — unrelated variable.
 */
const PROC_ROLE_ENV = 'SM_PROC_ROLE';

/** Explicit `SM_PROC_ROLE` in `extra` wins; else inferred from the attribution
 *  vars each spawn site already sets (job slug → job, tab id → shell, chat
 *  session → chat); else `aux`. Inference keeps role stamping in ONE place. */
function inferProcRole(extra) {
  if (extra[PROC_ROLE_ENV]) return String(extra[PROC_ROLE_ENV]);
  if (extra.SM_SCHEDULER_JOB_SLUG) return 'job';
  if (extra.SESSION_MANAGER_TAB_ID) return 'shell';
  if (extra.SM_CHAT_SESSION_ID) return 'chat';
  return 'aux';
}

/** Stamp SM_PROC_ROLE onto a raw env object (for sites that deliberately do not
 *  use cleanChildEnv's secret stripping, e.g. runClaudeP/docEdit). Returns a copy. */
function withProcRole(env, role) {
  return { ...env, [PROC_ROLE_ENV]: role };
}

function cleanChildEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  env[PROC_ROLE_ENV] = inferProcRole(extra);
  for (const k of Object.keys(env)) {
    if (
      k === 'CLAUDE_EFFORT' ||
      k === 'CLAUDECODE' ||
      k === 'NODE_OPTIONS' ||
      k.startsWith('CLAUDE_CODE_') ||
      k.startsWith('npm_config_') ||
      SECRET_KEY_RE.test(k)
    ) {
      delete env[k];
    }
  }
  return env;
}

module.exports = { cleanChildEnv, withProcRole, inferProcRole, PROC_ROLE_ENV, userBinDirs, pathWithUserBins };
