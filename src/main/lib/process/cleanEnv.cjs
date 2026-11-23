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
function userBinDirs(opts) {
  const platform = (opts && opts.platform) || process.platform;
  const P = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'win32') {
    const env = (opts && opts.env) || process.env;
    const w = P;
    const dirs = [];
    if (env.USERPROFILE) dirs.push(w.join(env.USERPROFILE, '.local', 'bin'));
    if (env.APPDATA) dirs.push(w.join(env.APPDATA, 'npm'));
    if (env.ProgramFiles) {
      dirs.push(w.join(env.ProgramFiles, 'Git', 'cmd'));
      dirs.push(w.join(env.ProgramFiles, 'nodejs'));
    }
    return dirs;
  }
  const home = (opts && opts.homedir) || os.homedir();
  return [
    P.join(home, '.claude', 'local'),
    P.join(home, '.local', 'bin'),
    P.join(home, '.npm-global', 'bin'),
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
 *  isn't shadowed by /opt/homebrew. Windows: ';' delimiter, and PATH is read
 *  case-insensitively (the variable is usually `Path`). */
function pathWithUserBins(opts) {
  const platform = (opts && opts.platform) || process.platform;
  const env = (opts && opts.env) || process.env;
  const win = platform === 'win32';
  const delim = (win ? path.win32 : path.posix).delimiter;
  let base = env.PATH || '';
  if (win && !base) {
    const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
    base = (key && env[key]) || '';
  }
  const dirs = userBinDirs({ ...(opts || {}), platform, env }).join(delim);
  return base && dirs ? `${base}${delim}${dirs}` : base || dirs;
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

/**
 * The ONLY spawn sites allowed to hand a headless child an env that still
 * carries secret-shaped keys. Both are internal one-shot `claude -p` helpers
 * that deliberately inherit process.env verbatim (withProcRole, not
 * cleanChildEnv). Adding an entry is a deliberate security decision.
 */
const CREDENTIAL_EXCEPTIONS = Object.freeze([
  Object.freeze({ site: 'runClaudeP', reason: 'internal one-shot aux claude -p (no tools beyond its sandbox, --strict-mcp-config); inherits process.env so the CLI auth env it was launched with keeps working' }),
  Object.freeze({ site: 'docEdit', reason: 'internal one-shot aux claude -p that rewrites a doc the user asked to edit; inherits process.env for the same CLI-auth reason as runClaudeP' }),
]);

/** Spawn sites that must pass a credential-free env. */
const CREDENTIAL_CHECKED_SITES = Object.freeze(['scheduler-job', 'task', 'chat', 'chat-agent']);

/** Secret-shaped keys (SECRET_KEY_RE) present in env with a non-empty value. */
function credentialKeys(env) {
  return Object.keys(env || {}).filter((k) => SECRET_KEY_RE.test(k) && env[k] !== undefined && env[k] !== null && env[k] !== '');
}

/**
 * Spawn-time assertion: throw if `env` carries any key matching
 * SECRET_KEY_RE. The error names each offending key, never its value.
 * `site` must be a known spawn site: an exception site passes unchecked, a
 * checked site is scanned, and an unknown site is refused outright.
 * @param {Record<string, any>} env
 * @param {{ site: string }} opts
 */
function assertNoCredentials(env, opts) {
  const site = opts && typeof opts.site === 'string' ? opts.site : '';
  if (CREDENTIAL_EXCEPTIONS.some((e) => e.site === site)) return;
  if (!CREDENTIAL_CHECKED_SITES.includes(site)) {
    const err = /** @type {Error & { code?: string }} */ (new Error(`assertNoCredentials: unknown spawn site ${JSON.stringify(site)} — refused`));
    err.code = 'credential_site_unknown';
    throw err;
  }
  const keys = credentialKeys(env);
  if (keys.length) {
    const err = /** @type {Error & { code?: string, keys?: string[] }} */ (new Error(`assertNoCredentials: ${site} env carries credential keys: ${keys.join(', ')} — refused`));
    err.code = 'credentials_in_env';
    err.keys = keys;
    throw err;
  }
}

/** Copy of env with every SECRET_KEY_RE key removed. */
function stripCredentials(env) {
  const out = { ...(env || {}) };
  for (const k of Object.keys(out)) if (SECRET_KEY_RE.test(k)) delete out[k];
  return out;
}

module.exports = { cleanChildEnv, assertNoCredentials, stripCredentials, CREDENTIAL_EXCEPTIONS, CREDENTIAL_CHECKED_SITES, SECRET_KEY_RE, withProcRole, inferProcRole, PROC_ROLE_ENV, userBinDirs, pathWithUserBins };
