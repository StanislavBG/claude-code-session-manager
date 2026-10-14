'use strict';

/**
 * The one predicate deciding whether a path a memory mentions still resolves.
 * Top-level in lib/ beside memoryStale.cjs (its sibling consumer); no domain
 * subfolder fits. IO is injected (`exists`, `trackedFiles`, `home`) so it is
 * unit-testable with no real fs; only `listTrackedFiles` shells out to git.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

function isBadRel(rel) {
  if (typeof rel !== 'string' || rel === '') return true;
  if (rel.startsWith('/') || rel.startsWith('~')) return true;
  return rel.split(/[\\/]/).includes('..');
}

function underHome(abs, home) {
  const r = path.relative(home, abs);
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
}

function makeRefResolver({ cwd, trackedFiles = [], exists = fs.existsSync, home = os.homedir() }) {
  const exact = new Set(trackedFiles);
  const byBase = new Map();
  for (const p of trackedFiles) {
    const base = path.posix.basename(p);
    const list = byBase.get(base);
    if (list) list.push(p); else byBase.set(base, [p]);
  }

  function expandRoot(root) {
    if (typeof root !== 'string' || root === '') return null;
    if (root === '~') return home;
    if (root.startsWith('~/')) return path.join(home, root.slice(2));
    return path.isAbsolute(root) ? path.normalize(root) : null;
  }

  return function resolve(rel, roots = []) {
    if (isBadRel(rel)) return false;
    if (exists(path.join(cwd, rel))) return true;
    if (exact.has(rel)) return true;
    const candidates = byBase.get(path.posix.basename(rel));
    if (candidates && candidates.some((p) => p === rel || p.endsWith('/' + rel))) return true;
    for (const root of roots) {
      const abs = expandRoot(root);
      if (abs && underHome(abs, home) && exists(path.join(abs, rel))) return true;
    }
    return false;
  };
}

function listTrackedFiles(cwd) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, 'ls-files'], { timeout: 10_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? [] : String(stdout).split('\n').filter(Boolean));
    });
  });
}

module.exports = { makeRefResolver, listTrackedFiles };
