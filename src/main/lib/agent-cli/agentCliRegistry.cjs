/**
 * agentCliRegistry.cjs — static catalog of the non-Claude agent CLIs a session
 * can run (Codex, Gemini CLI, Antigravity, Cursor Agent, OpenCode), a binary
 * resolver with a per-CLI test override, a bounded detection probe for the New
 * Session picker, and a lazy adapter lookup.
 *
 * Detection only — never installs anything. These CLIs are optional and are
 * deliberately NOT part of prereqs.cjs (the boot Setup checklist).
 *
 * Every probe is injectable via `deps` ({ findCommand, execFile, realpathSync,
 * now }) so tests spawn nothing.
 */
'use strict';

const fs = require('node:fs');
const childProcess = require('node:child_process');

const PROBE_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 60_000;
const VERSION_MAX = 120;

const AGENT_CLI_CATALOG = Object.freeze({
  codex: Object.freeze({
    label: 'Codex',
    bins: Object.freeze(['codex']),
    install: 'npm install -g @openai/codex',
    login: 'codex login',
    authEnv: Object.freeze(['OPENAI_API_KEY', 'CODEX_API_KEY']),
    docs: 'https://developers.openai.com/codex/cli',
  }),
  gemini: Object.freeze({
    label: 'Gemini CLI',
    bins: Object.freeze(['gemini']),
    install: 'npm install -g @google/gemini-cli',
    login: null,
    authEnv: Object.freeze(['GEMINI_API_KEY', 'GOOGLE_API_KEY']),
    docs: 'https://github.com/google-gemini/gemini-cli',
  }),
  antigravity: Object.freeze({
    label: 'Antigravity CLI',
    bins: Object.freeze(['agy']),
    install: null,
    login: null,
    authEnv: Object.freeze([]),
    docs: 'https://antigravity.google/docs/cli/',
  }),
  cursor: Object.freeze({
    label: 'Cursor Agent',
    bins: Object.freeze(['cursor-agent', 'agent']),
    install: 'curl https://cursor.com/install -fsS | bash',
    login: 'cursor-agent login',
    authEnv: Object.freeze(['CURSOR_API_KEY']),
    docs: 'https://cursor.com/docs/cli/overview',
  }),
  opencode: Object.freeze({
    label: 'OpenCode',
    bins: Object.freeze(['opencode']),
    install: 'npm install -g opencode-ai',
    login: 'opencode auth login',
    authEnv: Object.freeze([
      'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY',
      'GOOGLE_GENERATIVE_AI_API_KEY', 'GROQ_API_KEY', 'XAI_API_KEY', 'DEEPSEEK_API_KEY', 'MISTRAL_API_KEY',
    ]),
    docs: 'https://opencode.ai/docs/',
  }),
});

const CATALOG_IDS = Object.freeze(Object.keys(AGENT_CLI_CATALOG));

function isCatalogId(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(AGENT_CLI_CATALOG, id);
}

// Lazy: openExternalApp.cjs pulls in electron + cleanEnv at load time.
function defaultFindCommand(name) {
  return require('../openExternalApp.cjs').findCommand(name);
}

function defaultExecFile(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  });
}

function withDefaults(deps) {
  const d = deps || {};
  return {
    findCommand: d.findCommand || defaultFindCommand,
    execFile: d.execFile || defaultExecFile,
    realpathSync: d.realpathSync || fs.realpathSync,
    now: d.now || Date.now,
  };
}

/**
 * Resolve the executable for a non-Claude agent CLI.
 * SM_AGENT_CLI_BIN_<ID> wins (never cached); otherwise the first catalog bin
 * on PATH. Cursor's bare `agent` name is generic, so it only counts when its
 * realpath points into a Cursor install.
 * @returns {string|null}
 */
function resolveAgentCliBin(id, deps) {
  if (!isCatalogId(id)) return null;
  const override = process.env['SM_AGENT_CLI_BIN_' + id.toUpperCase()];
  if (override) return override;
  const d = withDefaults(deps);
  for (const bin of AGENT_CLI_CATALOG[id].bins) {
    let found = null;
    try { found = d.findCommand(bin); } catch { found = null; }
    if (!found) continue;
    if (id === 'cursor' && bin === 'agent') {
      let real = '';
      try { real = String(d.realpathSync(found)); } catch { real = ''; }
      if (!real.toLowerCase().includes('cursor')) continue;
    }
    return found;
  }
  return null;
}

function probeEnv() {
  const { pathWithUserBins } = require('../process/cleanEnv.cjs');
  return { ...process.env, PATH: pathWithUserBins() };
}

async function probeVersion(execFile, binPath) {
  try {
    const r = await execFile(binPath, ['--version'], {
      env: probeEnv(),
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
      shell: false,
    });
    const out = typeof r === 'string' ? r : (r && (r.stdout || r.stderr)) || '';
    const first = String(out).trim().split(/\r?\n/)[0].trim();
    return first ? first.slice(0, VERSION_MAX) : null;
  } catch {
    return null;
  }
}

let cache = null; // { at: number, rows: object[] }

/**
 * One row per non-Claude CLI: {id,label,installed,path,version,install,docs,login}.
 * Cached 60 s unless opts.refresh. Never rejects.
 */
async function detectAgentClis(opts, deps) {
  const d = withDefaults(deps);
  const refresh = !!(opts && opts.refresh);
  let t = 0;
  try { t = Number(d.now()) || 0; } catch { t = 0; }
  if (!refresh && cache && t - cache.at < CACHE_TTL_MS && t >= cache.at) {
    return cache.rows.map((r) => ({ ...r }));
  }
  const rows = await Promise.all(CATALOG_IDS.map(async (id) => {
    const entry = AGENT_CLI_CATALOG[id];
    let binPath = null;
    try { binPath = resolveAgentCliBin(id, d); } catch { binPath = null; }
    const version = binPath ? await probeVersion(d.execFile, binPath) : null;
    return {
      id,
      label: entry.label,
      installed: !!binPath,
      path: binPath,
      version,
      install: entry.install,
      docs: entry.docs,
      login: entry.login,
    };
  }));
  cache = { at: t, rows };
  return rows.map((r) => ({ ...r }));
}

/** Test hook: drop the detection cache. */
function _resetCache() { cache = null; }

/**
 * Lazily load the adapter module for a non-Claude CLI. Each require uses a
 * literal path — no path is ever built from the caller's string. Returns null
 * for unknown ids, 'claude', or an adapter that has not been written yet.
 */
function adapterFor(id) {
  if (!isCatalogId(id)) return null;
  try {
    switch (id) {
      case 'codex': return require('./adapters/codex.cjs');
      case 'gemini': return require('./adapters/gemini.cjs');
      case 'antigravity': return require('./adapters/antigravity.cjs');
      case 'cursor': return require('./adapters/cursor.cjs');
      case 'opencode': return require('./adapters/opencode.cjs');
      default: return null;
    }
  } catch (e) {
    // Only an absent adapter file is tolerated; a broken adapter still throws.
    if (e && e.code === 'MODULE_NOT_FOUND' && String(e.message).includes(`adapters/${id}.cjs`)) return null;
    throw e;
  }
}

module.exports = {
  AGENT_CLI_CATALOG,
  resolveAgentCliBin,
  detectAgentClis,
  adapterFor,
  _resetCache,
  PROBE_TIMEOUT_MS,
  CACHE_TTL_MS,
};
