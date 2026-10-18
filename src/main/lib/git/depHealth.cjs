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
 * Neither function throws. The check runs on the scheduler main loop, so it is
 * O(deps) stats with no directory walks.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const MAX_DEPS = 200;
const MAX_MISSING = 20;
const TAIL_CHARS = 2000;

/**
 * @param {string} mainCwd
 * @returns {{ ok: boolean, skipped?: string, reason?: string, missing?: string[] }}
 */
function checkMainDependencyHealth(mainCwd) {
  try {
    if (!fs.existsSync(path.join(mainCwd, 'pnpm-lock.yaml'))) return { ok: true, skipped: 'not-pnpm' };
    const modules = path.join(mainCwd, 'node_modules');
    let isDir = false;
    try { isDir = fs.statSync(modules).isDirectory(); } catch { /* missing */ }
    if (!isDir) return { ok: false, reason: 'node_modules-missing' };
    if (!fs.existsSync(path.join(modules, '.modules.yaml'))) return { ok: false, reason: 'modules-yaml-missing' };

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
        'pnpm',
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

module.exports = { checkMainDependencyHealth, repairMainDependencies };
