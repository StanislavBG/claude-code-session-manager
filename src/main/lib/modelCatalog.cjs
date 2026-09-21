'use strict';

/**
 * modelCatalog.cjs — pure observer answering "which model aliases, concrete model
 * ids and effort levels does the installed `claude` CLI offer right now".
 *
 * Sources per field (ladder: live → stale cache → CATALOG_FLOOR):
 *   aliases       ← `claude -p "/model"` probe
 *   effortLevels  ← `claude -p "/effort"` probe
 *   models        ← bounded streaming scan of the CLI binary for `claude-<family>-N…` ids
 *   settingsEffortLevels ← bundled settings schema (`properties.effortLevel.enum`)
 *   availableModels      ← settings.json scope chain allowlist (reported, never applied here)
 * Cached at ~/.claude/session-manager/model-catalog.json keyed by the installed CLI version (24 h TTL).
 * (NOT userData: config.cjs's validateWrite permits only update-check.json there, so a userData write
 * is silently swallowed.) An unknown (null) CLI version never reads a cache as fresh and never writes one.
 * Never throws/rejects. Influences no spawn decision; writes nothing under session-manager-operations/.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CACHE_FILE = 'model-catalog.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 45_000;
const SCAN_CHUNK_BYTES = 1024 * 1024;
// Longest real id is ~40 bytes; 128 comfortably covers an id split across two reads.
const SCAN_OVERLAP_BYTES = 128;
const MODEL_ID_RE = /claude-(?:opus|sonnet|haiku|fable)-[0-9][0-9-]*/g;
// A real CLI binary is tens of MB; test stubs and launcher shims are tiny shell scripts.
const MIN_SCAN_BYTES = 1024 * 1024;
const SCHEMA_PATH = path.join(__dirname, '..', '..', 'renderer', 'data', 'claude-settings-schema.json');

const CATALOG_FLOOR = Object.freeze({
  aliases: Object.freeze(['haiku', 'sonnet', 'opus', 'fable']),
  models: Object.freeze([]),
  effortLevels: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']),
  settingsEffortLevels: Object.freeze(['low', 'medium', 'high', 'xhigh']),
});

let inFlight = null;

/** `Usage: /model <name>. Available: a, b, or a full model ID.` → ['a','b'] (or null). */
function parseAliases(out) {
  const m = /Available:\s*([^\n]+)/.exec(String(out || ''));
  if (!m) return null;
  const list = m[1].trim().replace(/\.$/, '').split(',')
    .map((s) => s.trim())
    .filter((s) => s && !/^or a full model id$/i.test(s));
  return list.length ? list : null;
}

/** `Usage: /effort <low|medium|…>` → ['low','medium',…] (or null). */
function parseEffortLevels(out) {
  const m = /\/effort\s*<([^>]+)>/.exec(String(out || ''));
  if (!m) return null;
  const list = m[1].split('|').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : null;
}

/** `auto` is a `/effort` RESET verb, never a `--effort` value — keep it out of the selectable list. */
function selectableEffort(list) {
  const l = list ? list.filter((x) => x !== 'auto') : null;
  return l && l.length ? l : null;
}

/**
 * Streaming scan of `file` for concrete model ids. O(size) time, O(chunk+overlap) space.
 * A match touching the window end is deferred (it may be truncated) and re-found via the overlap.
 */
function scanModelIds(file, { fsImpl = fs, chunkSize = SCAN_CHUNK_BYTES, overlap = SCAN_OVERLAP_BYTES } = {}) {
  const found = new Set();
  const fd = fsImpl.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(chunkSize);
    let carry = '';
    for (;;) {
      const n = fsImpl.readSync(fd, buf, 0, chunkSize, null);
      const last = n <= 0;
      const win = carry + (last ? '' : buf.latin1Slice(0, n));
      MODEL_ID_RE.lastIndex = 0;
      let m;
      while ((m = MODEL_ID_RE.exec(win))) {
        if (!last && m.index + m[0].length >= win.length) continue;
        found.add(m[0].replace(/-+$/, ''));
      }
      if (last) break;
      carry = win.slice(-overlap);
    }
  } finally {
    try { fsImpl.closeSync(fd); } catch { /* best-effort */ }
  }
  return [...found].sort();
}

/** True only for a large non-shell-script file — never scan a stub/launcher shim. */
function isScannableBinary(file, fsImpl) {
  const st = fsImpl.statSync(file);
  if (!st.isFile() || st.size < MIN_SCAN_BYTES) return false;
  const fd = fsImpl.openSync(file, 'r');
  try {
    const head = Buffer.alloc(64);
    const n = fsImpl.readSync(fd, head, 0, 64, 0);
    return !/^#!\s*\/\S*(?:\/env\s+)?(?:ba|z|da|k)?sh\b/.test(head.latin1Slice(0, n));
  } finally {
    try { fsImpl.closeSync(fd); } catch { /* best-effort */ }
  }
}

function readSettingsEffortLevels(fsImpl) {
  try {
    const e = JSON.parse(fsImpl.readFileSync(SCHEMA_PATH, 'utf8')).properties.effortLevel.enum;
    return Array.isArray(e) && e.length ? e.map(String) : null;
  } catch { return null; }
}

function readAvailableModels(cwd, d, fsImpl) {
  const home = d.homeDir ? d.homeDir() : os.homedir();
  let root = null;
  if (cwd) {
    try { root = (d.projectRootOf || require('./activeSessions.cjs').projectRootOf)(path.resolve(cwd)); } catch { root = path.resolve(cwd); }
  }
  const files = [path.join(home, '.claude', 'settings.json')];
  if (root) files.push(path.join(root, '.claude', 'settings.json'), path.join(root, '.claude', 'settings.local.json'));
  let merged = null;
  for (const f of files) {
    try {
      const a = JSON.parse(fsImpl.readFileSync(f, 'utf8')).availableModels;
      if (Array.isArray(a)) merged = [...(merged || []), ...a.filter((x) => typeof x === 'string')];
    } catch { /* missing/unreadable scope */ }
  }
  return merged ? [...new Set(merged)] : null;
}

function readCache(file, fsImpl) {
  try {
    const c = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    return c && typeof c === 'object' ? c : null;
  } catch { return null; }
}

const strList = (v) => (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string') ? v : null);

/** Ladder: live → stale cache → floor. Returns [value, source]. */
function ladder(live, liveSource, stale, floor) {
  if (live) return [live, liveSource];
  const s = strList(stale);
  if (s) return [s, 'cache'];
  return [[...floor], 'floor'];
}

async function doResolve({ cwd, force, deps }) {
  const d = deps || {};
  const env = d.env || process.env;
  const fsImpl = d.fs || fs;
  const now = (d.now || Date.now)();
  let cacheFile = null;
  try {
    const home = d.homeDir ? d.homeDir() : os.homedir();
    if (home) cacheFile = path.join(home, '.claude', 'session-manager', CACHE_FILE);
  } catch { /* no home → no cache */ }
  const cached = cacheFile ? readCache(cacheFile, fsImpl) : null;
  if (cached && Array.isArray(cached.effortLevels)) cached.effortLevels = selectableEffort(cached.effortLevels);

  const availableModels = readAvailableModels(cwd, d, fsImpl);
  const settingsEffort = readSettingsEffortLevels(fsImpl);
  const settingsEffortLevels = settingsEffort || strList(cached && cached.settingsEffortLevels) || [...CATALOG_FLOOR.settingsEffortLevels];

  const fromCache = (c) => ({
    aliases: c.aliases, models: c.models || [], effortLevels: c.effortLevels,
    settingsEffortLevels, availableModels,
    claudeVersion: c.claudeVersion ?? null, probedAt: c.probedAt ?? null,
    sources: { aliases: 'cache', models: 'cache', effortLevels: 'cache' }, degraded: Boolean(c.degraded),
  });

  // Hermetic e2e: never spawn — any usable cache, else the floor.
  if (env.SM_E2E === '1') {
    if (cached && strList(cached.aliases) && strList(cached.effortLevels)) return fromCache(cached);
    return {
      aliases: [...CATALOG_FLOOR.aliases], models: [], effortLevels: [...CATALOG_FLOOR.effortLevels],
      settingsEffortLevels, availableModels, claudeVersion: null, probedAt: null,
      sources: { aliases: 'floor', models: 'floor', effortLevels: 'floor' }, degraded: true,
    };
  }

  let claudeVersion = null;
  try { claudeVersion = (await (d.probeClaudeVersion || require('./claudeBin.cjs').probeClaudeVersion)()) || null; } catch { /* unknown */ }

  if (!force && cached && claudeVersion && cached.claudeVersion === claudeVersion && !cached.degraded
    && strList(cached.aliases) && strList(cached.effortLevels)) {
    const age = now - Date.parse(cached.probedAt);
    if (age >= 0 && age < CACHE_TTL_MS) return fromCache(cached);
  }

  const run = d.runClaudeP || require('./runClaudeP.cjs').runClaudeP;
  const probe = async (prompt) => {
    try { return await run(prompt, { model: 'haiku', timeoutMs: PROBE_TIMEOUT_MS }); } catch { return { ok: false }; }
  };
  const [modelRes, effortRes] = await Promise.all([probe('/model'), probe('/effort')]);
  const liveAliases = modelRes && modelRes.ok ? parseAliases(modelRes.out) : null;
  const liveEffort = effortRes && effortRes.ok ? selectableEffort(parseEffortLevels(effortRes.out)) : null;

  let liveModels = null;
  try {
    const bin = (d.resolveClaudeBin || require('./claudeBin.cjs').resolveClaudeBin)();
    const real = fsImpl.realpathSync(bin);
    if (!isScannableBinary(real, fsImpl)) throw new Error('not a scannable binary');
    const ids = (d.scanModelIds || scanModelIds)(real, { fsImpl });
    liveModels = ids.length ? ids : null;
  } catch { /* unreadable/missing binary */ }

  const [aliases, aliasSrc] = ladder(liveAliases, 'probe', cached && cached.aliases, CATALOG_FLOOR.aliases);
  const [effortLevels, effortSrc] = ladder(liveEffort, 'probe', cached && cached.effortLevels, CATALOG_FLOOR.effortLevels);
  const [models, modelsSrc] = ladder(liveModels, 'binary', cached && cached.models, CATALOG_FLOOR.models);
  const degraded = !(liveAliases && liveEffort && liveModels);

  const catalog = {
    aliases, models, effortLevels, settingsEffortLevels, availableModels,
    claudeVersion, probedAt: new Date(now).toISOString(),
    sources: { aliases: aliasSrc, models: modelsSrc, effortLevels: effortSrc }, degraded,
  };
  // Unknown version = unknown cache key: writing it would stamp `claudeVersion: null` over a real entry.
  if (!degraded && cacheFile && claudeVersion) {
    try { await (d.writeJson || require('../config.cjs').writeJson)(cacheFile, catalog); } catch { /* cache is best-effort */ }
  }
  return catalog;
}

/** Resolve the live catalog. Never throws. Concurrent calls share one in-flight resolve. */
function resolveModelCatalog({ cwd, force, deps } = {}) {
  if (inFlight) return inFlight;
  inFlight = doResolve({ cwd, force, deps })
    .catch(() => ({
      aliases: [...CATALOG_FLOOR.aliases], models: [], effortLevels: [...CATALOG_FLOOR.effortLevels],
      settingsEffortLevels: [...CATALOG_FLOOR.settingsEffortLevels], availableModels: null,
      claudeVersion: null, probedAt: null,
      sources: { aliases: 'floor', models: 'floor', effortLevels: 'floor' }, degraded: true,
    }))
    .finally(() => { inFlight = null; });
  return inFlight;
}

module.exports = { resolveModelCatalog, CATALOG_FLOOR, parseAliases, parseEffortLevels, scanModelIds };
