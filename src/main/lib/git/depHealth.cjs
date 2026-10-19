/**
 * depHealth.cjs — detect and repair a broken pnpm node_modules in the main checkout.
 *
 * Incident: a `pnpm install` run through a symlinked worktree node_modules purged
 * the main checkout's modules dir, so every later gate went red with
 * `Cannot find module .../node_modules/typescript/bin/tsc`. Recovery is
 * `pnpm install --offline` in the main checkout; it needs CI=1 plus
 * `--config.confirmModulesPurge=false`, otherwise pnpm prompts and aborts with
 * ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY.
 *
 * Second incident (Bilko, 2026-10-18): the same install rewrote 37 workspace links
 * in the main checkout's node_modules to point into a job worktree; once the
 * worktree was deleted they all dangled. Workspace packages are not in the root
 * package.json deps, so the deps check missed it. findWorktreeEscapingLinks flags
 * top-level links that resolve into a worktree root or dangle.
 *
 * Neither function throws. The check runs on the scheduler main loop, so it is
 * O(deps) stats plus one bounded top-level readdir (no deep walks).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const MAX_DEPS = 200;
const MAX_MISSING = 20;
const TAIL_CHARS = 2000;
const MAX_SCANNED = 2000;

function defaultWorktreeRoots() {
  try {
    const sp = require('../scheduler/schedulerPaths.cjs');
    return [sp.worktreeRoot('job'), sp.worktreeRoot('epic')].filter((r) => typeof r === 'string' && r);
  } catch {
    return [];
  }
}

/**
 * Scan node_modules/* and node_modules/@scope/* (lstat only, no deeper) for symlinks
 * that resolve into a worktree root or whose target is gone.
 * @param {string} mainCwd
 * @param {{ worktreeRoots?: string[] }} [opts]
 * @returns {{ intoWorktree: string[], dangling: string[] }}
 */
function findWorktreeEscapingLinks(mainCwd, opts = {}) {
  const intoWorktree = [];
  const dangling = [];
  try {
    const rawRoots = Array.isArray(opts.worktreeRoots) ? opts.worktreeRoots : defaultWorktreeRoots();
    const roots = [];
    for (const r of rawRoots) {
      if (!r) continue;
      roots.push(path.resolve(r));
      try { roots.push(fs.realpathSync(r)); } catch { /* root absent */ }
    }
    const modules = path.join(mainCwd, 'node_modules');
    let scanned = 0;
    const check = (rel) => {
      const full = path.join(modules, rel);
      let target;
      try {
        target = fs.realpathSync(full);
      } catch (e) {
        if (dangling.length < MAX_MISSING) dangling.push(rel);
        return;
      }
      if (roots.some((r) => target.startsWith(r + path.sep)) && intoWorktree.length < MAX_MISSING) {
        intoWorktree.push(rel);
      }
    };
    const entries = fs.readdirSync(modules, { withFileTypes: true });
    outer: for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      if (++scanned > MAX_SCANNED) break;
      if (ent.name.startsWith('@')) {
        let subs = [];
        try { subs = fs.readdirSync(path.join(modules, ent.name), { withFileTypes: true }); } catch { continue; }
        for (const sub of subs) {
          if (sub.name.startsWith('.')) continue;
          if (++scanned > MAX_SCANNED) break outer;
          if (sub.isSymbolicLink()) check(`${ent.name}/${sub.name}`);
        }
      } else if (ent.isSymbolicLink()) {
        check(ent.name);
      }
    }
  } catch {
    return { intoWorktree: [], dangling: [] };
  }
  return { intoWorktree, dangling };
}

/**
 * @param {string} mainCwd
 * @param {{ worktreeRoots?: string[] }} [opts]
 * @returns {{ ok: boolean, skipped?: string, reason?: string, missing?: string[] }}
 */
function checkMainDependencyHealth(mainCwd, opts = {}) {
  try {
    if (!fs.existsSync(path.join(mainCwd, 'pnpm-lock.yaml'))) return { ok: true, skipped: 'not-pnpm' };
    const modules = path.join(mainCwd, 'node_modules');
    let isDir = false;
    try { isDir = fs.statSync(modules).isDirectory(); } catch { /* missing */ }
    if (!isDir) return { ok: false, reason: 'node_modules-missing' };
    if (!fs.existsSync(path.join(modules, '.modules.yaml'))) return { ok: false, reason: 'modules-yaml-missing' };

    const links = findWorktreeEscapingLinks(mainCwd, { worktreeRoots: opts && opts.worktreeRoots });
    if (links.intoWorktree.length) return { ok: false, reason: 'links-into-worktree', missing: links.intoWorktree };
    if (links.dangling.length) return { ok: false, reason: 'dangling-links', missing: links.dangling };

    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(mainCwd, 'package.json'), 'utf8'));
    } catch {
      return { ok: true, skipped: 'no-package-json' };
    }
    if (!pkg || typeof pkg !== 'object') return { ok: true, skipped: 'no-package-json' };
    const names = [
      ...Object.keys(pkg.dependencies || {}),
      ...Object.keys(pkg.devDependencies || {}),
    ].slice(0, MAX_DEPS);
    const missing = [];
    for (const name of names) {
      try {
        fs.statSync(path.join(modules, name, 'package.json'));
      } catch {
        if (missing.length < MAX_MISSING) missing.push(name);
      }
    }
    return missing.length ? { ok: false, reason: 'unresolved-deps', missing } : { ok: true };
  } catch {
    return { ok: true, skipped: 'no-package-json' };
  }
}

/**
 * @param {string} mainCwd
 * @returns {Promise<{ ok: boolean, code: number|null, tail: string }>}
 */
function repairMainDependencies(mainCwd) {
  return new Promise((resolve) => {
    try {
      execFile(
        process.env.SM_PNPM_BIN || 'pnpm',
        ['install', '--offline', '--frozen-lockfile', '--config.confirmModulesPurge=false'],
        { cwd: mainCwd, env: { ...process.env, CI: '1' }, timeout: 300_000, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const tail = `${stdout || ''}${stderr || ''}`.slice(-TAIL_CHARS) || (err ? String(err.message) : '');
          if (!err) return resolve({ ok: true, code: 0, tail });
          resolve({ ok: false, code: typeof err.code === 'number' ? err.code : null, tail: tail || String(err.message) });
        },
      );
    } catch (e) {
      resolve({ ok: false, code: null, tail: String((e && e.message) || e) });
    }
  });
}

module.exports = { checkMainDependencyHealth, findWorktreeEscapingLinks, repairMainDependencies };
