'use strict';
/**
 * Copy Claude Code's CLAUDE.md external-include approval from a parent project
 * path to a new worktree path in the global config (~/.claude.json).
 *
 * Why: Claude Code (2.1.330) keys `projects[<path>]` by the session's own git
 * root (`git rev-parse --show-toplevel`), so each new Epic/job worktree starts
 * without `hasClaudeMdExternalIncludesApproved` and silently skips @-imports
 * that resolve outside the repo (e.g. symlinked contracts).
 *
 * Concurrency: Claude Code holds the `<file>.lock` directory (proper-lockfile
 * mkdir protocol) while it writes; we take the same lock, re-read fresh under
 * it, and write atomically (tmp + rename) so no concurrent write is lost.
 * hasTrustDialogAccepted is never copied.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeTextAtomic, writeTextAtomicSync } = require('../util/atomicFs.cjs');

const STALE_MS = 10000;
const WAIT_MS = 2000;
const A = 'hasClaudeMdExternalIncludesApproved';
const W = 'hasClaudeMdExternalIncludesWarningShown';

function claudeJsonPath(env = process.env) {
  if (env && env.CLAUDE_CONFIG_DIR) return path.join(env.CLAUDE_CONFIG_DIR, '.claude.json');
  return path.join(os.homedir(), '.claude.json');
}

function parentEntry(projects, fromPath) {
  const key = path.resolve(fromPath);
  if (projects[key]) return projects[key];
  try {
    const real = fs.realpathSync(key);
    return projects[real];
  } catch { return undefined; }
}

function applyApproval(config, fromPath, toPath) {
  if (!config || typeof config !== 'object' || !config.projects || typeof config.projects !== 'object') return config;
  const fromKey = path.resolve(fromPath);
  const toKey = path.resolve(toPath);
  if (fromKey === toKey) return config;
  const parent = parentEntry(config.projects, fromPath);
  if (!parent || parent[A] !== true) return config;
  const existing = config.projects[toKey];
  if (existing && existing[A] === true && existing[W] === true) return config;
  const base = existing && typeof existing === 'object' ? existing : {
    allowedTools: [], mcpContextUris: [], mcpServers: {}, enabledMcpjsonServers: [],
    disabledMcpjsonServers: [], hasTrustDialogAccepted: false,
  };
  return { ...config, projects: { ...config.projects, [toKey]: { ...base, [A]: true, [W]: true } } };
}

/** @returns {'ok'|'retry'} */
function tryLock(lockDir) {
  try { fs.mkdirSync(lockDir); return 'ok'; } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    try {
      if (Date.now() - fs.statSync(lockDir).mtimeMs > STALE_MS) { fs.rmdirSync(lockDir); return tryLock(lockDir); }
    } catch { /* vanished or raced; retry */ }
    return 'retry';
  }
}

function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
const jitter = () => 25 + Math.floor(Math.random() * 25);

function prepare(configPath, fromPath, toPath) {
  let raw; let stat;
  try { stat = fs.statSync(configPath); raw = fs.readFileSync(configPath, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { result: { ok: false, reason: 'missing' } };
    return { result: { ok: false, reason: 'unreadable' } };
  }
  let config;
  try { config = JSON.parse(raw); } catch { return { result: { ok: false, reason: 'unparseable' } }; }
  const next = applyApproval(config, fromPath, toPath);
  if (next === config) return { result: { ok: true, changed: false } };
  const text = JSON.stringify(next, null, 2) + (raw.endsWith('\n') ? '\n' : '');
  return { text, mode: stat.mode & 0o777 };
}

async function copyExternalIncludeApproval({ fromPath, toPath, configPath } = {}) {
  const file = configPath || claudeJsonPath();
  const lockDir = `${file}.lock`;
  try {
    if (!fs.existsSync(file)) return { ok: false, reason: 'missing' };
    const t0 = Date.now();
    while (tryLock(lockDir) !== 'ok') {
      if (Date.now() - t0 >= WAIT_MS) return { ok: false, reason: 'lock-timeout' };
      await new Promise((r) => setTimeout(r, jitter()));
    }
    try {
      const p = prepare(file, fromPath, toPath);
      if (p.result) return p.result;
      await writeTextAtomic(file, p.text, { mode: p.mode });
      return { ok: true, changed: true };
    } finally { try { fs.rmdirSync(lockDir); } catch { /* already gone */ } }
  } catch (e) { return { ok: false, reason: String((e && e.message) || e) }; }
}

function copyExternalIncludeApprovalSync({ fromPath, toPath, configPath } = {}) {
  const file = configPath || claudeJsonPath();
  const lockDir = `${file}.lock`;
  try {
    if (!fs.existsSync(file)) return { ok: false, reason: 'missing' };
    const t0 = Date.now();
    while (tryLock(lockDir) !== 'ok') {
      if (Date.now() - t0 >= WAIT_MS) return { ok: false, reason: 'lock-timeout' };
      sleepSync(jitter());
    }
    try {
      const p = prepare(file, fromPath, toPath);
      if (p.result) return p.result;
      writeTextAtomicSync(file, p.text, { mode: p.mode });
      return { ok: true, changed: true };
    } finally { try { fs.rmdirSync(lockDir); } catch { /* already gone */ } }
  } catch (e) { return { ok: false, reason: String((e && e.message) || e) }; }
}

module.exports = { claudeJsonPath, applyApproval, copyExternalIncludeApproval, copyExternalIncludeApprovalSync };
