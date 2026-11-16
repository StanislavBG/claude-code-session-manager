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

function makeRefResolver({ cwd, trackedFiles = [], exists = fs.existsSync, home = os.homedir(), extraBases = [] }) {
  // Extra absolute bases (e.g. the ops root) a repo-relative ref may resolve under; home-confined.
  const bases = extraBases
    .filter((b) => typeof b === 'string' && path.isAbsolute(b))
    .map((b) => path.normalize(b))
    .filter((b) => underHome(b, home));
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
    for (const base of bases) {
      if (exists(path.join(base, rel))) return true;
    }
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

const MAX_RENAME_HOPS = 10;
const RENAME_LINE_RE = /^R\d*\t([^\t]+)\t([^\t]+)$/;

/**
 * Map<oldPath, finalPath> from the repo's rename history, one git call.
 * git log prints newest first, so the first time an old path is seen wins.
 * Chains old -> mid -> new are followed up to MAX_RENAME_HOPS, only through
 * renames newer than the previous hop; a cycle stops at the last unvisited
 * path, and a chain that returns to its start is dropped (the path lives
 * where it began). `exec` is injectable for tests.
 * Complexity: O(lines + renames * MAX_RENAME_HOPS).
 */
function listRenames(cwd, exec = execFile) {
  return new Promise((resolve) => {
    exec(
      'git',
      ['-C', cwd, 'log', '--diff-filter=R', '--name-status', '--format=', '-M', 'HEAD'],
      { timeout: 10_000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(new Map());
        // direct: old -> { to, order }, order 0 = newest rename.
        const direct = new Map();
        let order = 0;
        for (const line of String(stdout).split('\n')) {
          const m = RENAME_LINE_RE.exec(line.replace(/\r$/, ''));
          if (!m) continue;
          if (!direct.has(m[1])) direct.set(m[1], { to: m[2], order });
          order++;
        }
        const out = new Map();
        for (const [from, first] of direct) {
          const visited = new Set([from]);
          let cur = first.to;
          let curOrder = first.order;
          let returned = false;
          visited.add(cur);
          for (let hop = 1; hop < MAX_RENAME_HOPS; hop++) {
            const next = direct.get(cur);
            // Only a LATER rename of the new path continues the chain.
            if (next === undefined || next.order >= curOrder) break;
            if (next.to === from) { returned = true; break; }
            if (visited.has(next.to)) break;
            visited.add(next.to);
            cur = next.to;
            curOrder = next.order;
          }
          if (!returned && cur !== from) out.set(from, cur);
        }
        resolve(out);
      }
    );
  });
}

module.exports = { makeRefResolver, listTrackedFiles, listRenames };
