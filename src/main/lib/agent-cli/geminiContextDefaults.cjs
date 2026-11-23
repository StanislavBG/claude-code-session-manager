'use strict';
// SM-owned Gemini CLI system-defaults file. Gemini CLI reads only GEMINI.md as
// context by default, so a Gemini Epic in an AGENTS.md project would start with
// no project map. This writes a copy of the machine's real system-defaults
// file (lowest settings layer, so user/project context.fileName still wins)
// with AGENTS.md and GEMINI.md added to context.fileName, under the agent-cli
// state root, and returns its path for GEMINI_CLI_SYSTEM_DEFAULTS_PATH.
// CLAUDE.md is deliberately NOT added: Gemini follows @-imports, so a
// CLAUDE.md stub (@AGENTS.md) beside AGENTS.md would load the map twice.
// Pure helper: injected env/platform/fs/dir; no spawn, no network.

const nodeFs = require('node:fs');
const path = require('node:path');
const { writeJsonAtomicSync } = require('../util/atomicFs.cjs');
const { rootDir } = require('./agentCliSessionStore.cjs');

const OUTPUT_FILE = 'gemini-system-defaults.json';
const CONTEXT_NAMES = ['AGENTS.md', 'GEMINI.md'];

const PLATFORM_DEFAULTS = {
  linux: '/etc/gemini-cli/system-defaults.json',
  darwin: '/Library/Application Support/GeminiCli/system-defaults.json',
  win32: 'C:\\ProgramData\\gemini-cli\\system-defaults.json',
};

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** The path Gemini CLI itself would read system defaults from. */
function realSystemDefaultsPath({ env = process.env, platform = process.platform } = {}) {
  const override = env && env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH;
  if (typeof override === 'string' && override.trim()) return override;
  return PLATFORM_DEFAULTS[platform] || PLATFORM_DEFAULTS.linux;
}

/**
 * Read the real file. Missing → {}; unreadable, malformed, or not a JSON
 * object → undefined (caller returns null and writes nothing).
 */
function readRealDefaults(fs, file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return {};
    return undefined;
  }
  if (String(raw).trim() === '') return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return isPlainObject(parsed) ? parsed : undefined;
}

function mergedFileNames(existing) {
  const base = typeof existing === 'string'
    ? [existing]
    : Array.isArray(existing) ? existing.filter((n) => typeof n === 'string') : [];
  const out = [];
  for (const n of [...base, ...CONTEXT_NAMES]) if (!out.includes(n)) out.push(n);
  return out;
}

function ensureGeminiSystemDefaults({
  env = process.env,
  platform = process.platform,
  fs = nodeFs,
  dir,
} = {}) {
  const real = readRealDefaults(fs, realSystemDefaultsPath({ env, platform }));
  if (real === undefined) return null;
  const context = isPlainObject(real.context) ? real.context : {};
  const merged = {
    ...real,
    context: { ...context, fileName: mergedFileNames(context.fileName) },
  };
  const outFile = path.join(dir || rootDir(), OUTPUT_FILE);
  const next = `${JSON.stringify(merged, null, 2)}\n`;
  let current = null;
  try { current = fs.readFileSync(outFile, 'utf8'); } catch { /* not written yet */ }
  if (current !== next) writeJsonAtomicSync(outFile, merged, { mode: 0o600 });
  return { path: outFile };
}

module.exports = {
  ensureGeminiSystemDefaults,
  realSystemDefaultsPath,
  OUTPUT_FILE,
  CONTEXT_NAMES,
};
