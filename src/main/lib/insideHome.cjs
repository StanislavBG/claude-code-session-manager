/**
 * insideHome.cjs — single chokepoint for "is this renderer-controlled path
 * inside $HOME?" Security boundary: bare `startsWith(home)` matches
 * `/home/bilkoEVIL` when home=`/home/bilko` (the classic prefix-trap). Both
 * the target and the home directory are resolved via realpath, and the
 * boundary is either exact equality or a path-separator boundary.
 *
 * Two exports, two policies:
 *   assertInsideHome(p) → { realPath }                — throws on failure
 *   checkInsideHome(p)  → { ok, realPath } | { ok, error }  — never throws
 *
 * Both follow the same algorithm:
 *   1. realpath the target. On ENOENT, fall back to path.resolve(p) so callers
 *      can validate "this is where I'm about to write" before the file exists.
 *   2. Compare against the cached realpath of os.homedir() with the
 *      equality-or-separator boundary check.
 *
 * The cached home realpath is computed once at module load. If $HOME can't be
 * resolved at startup we keep going with the literal value — boot-time
 * self-check in index.cjs surfaces that to the user.
 *
 * win32: containment compares lower-cased, path.win32-normalized paths; UNC
 * (`\\server\share`) and `\\?\` paths are always outside home.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/**
 * Canonicalize a path: native realpath (resolves 8.3 short names and subst
 * drives on Windows; falls back to the JS realpath), and a not-yet-existing
 * path resolves through its nearest existing ancestor with the missing tail
 * joined back on. deps: { fs, platform } injectable for tests.
 */
function realpath(p, deps = {}) {
  const fsx = deps.fs || fs;
  const pm = (deps.platform || process.platform) === 'win32' ? path.win32 : path;
  const rp = typeof fsx.realpathSync.native === 'function' ? fsx.realpathSync.native : fsx.realpathSync;
  const lex = pm.resolve(p);
  try {
    return rp(lex);
  } catch (e) {
    if (!e || e.code !== 'ENOENT') throw e;
  }
  const tail = [pm.basename(lex)];
  let dir = pm.dirname(lex);
  for (;;) {
    try {
      return pm.join(rp(dir), ...tail.reverse());
    } catch (e) {
      if (!e || e.code !== 'ENOENT') throw e;
      const parent = pm.dirname(dir);
      if (parent === dir) return lex; // filesystem root; give up safely
      tail.push(pm.basename(dir));
      dir = parent;
    }
  }
}

// Resolve home once. Falls back to literal homedir if realpath fails
// (which would be a misconfigured system; boot self-check in index.cjs
// surfaces it). Cached for the lifetime of the process.
const HOME_LITERAL = os.homedir();
let HOME_REAL;
try {
  HOME_REAL = realpath(HOME_LITERAL);
} catch {
  HOME_REAL = HOME_LITERAL;
}

function resolveTarget(p) {
  // Missing paths are validated via their nearest existing ancestor so the
  // containment check still applies (no stat-probe info disclosure).
  return realpath(p);
}

function isContainedWin32(target, root) {
  const norm = (v) => path.win32.normalize(v).toLowerCase().replace(/[\\/]+$/, '');
  const t = norm(target);
  const r = norm(root);
  // \\?\ and \\.\ prefixes can alias any location — never contained.
  if (/^[\\/]{2}[?.][\\/]/.test(t) || /^[\\/]{2}[?.][\\/]/.test(r)) return false;
  const tUnc = /^[\\/]{2}/.test(t);
  const rUnc = /^[\\/]{2}/.test(r);
  if (tUnc !== rUnc) return false;
  return t === r || t.startsWith(r + '\\');
}

/** Is realPath equal to, or beneath, root? Equality-or-separator boundary. */
function isContainedIn(realPath, root, platform = process.platform) {
  if (platform === 'win32') return isContainedWin32(realPath, root);
  return realPath === root || realPath.startsWith(root + path.posix.sep);
}

function isContained(realPath, home = HOME_REAL, platform = process.platform) {
  return isContainedIn(realPath, home, platform);
}

function assertInsideHome(p) {
  if (typeof p !== 'string' || !p) {
    throw new Error('path outside home');
  }
  let realPath;
  try {
    realPath = resolveTarget(p);
  } catch {
    throw new Error('path outside home');
  }
  if (!isContained(realPath)) {
    throw new Error('path outside home');
  }
  return { realPath };
}

function checkInsideHome(p) {
  if (typeof p !== 'string' || !p) {
    return { ok: false, error: 'path outside home' };
  }
  let realPath;
  try {
    realPath = resolveTarget(p);
  } catch {
    return { ok: false, error: 'path outside home' };
  }
  if (!isContained(realPath)) {
    return { ok: false, error: 'path outside home' };
  }
  return { ok: true, realPath };
}

/**
 * Home OR a main-process-registered project root. `roots` must come from
 * config.cjs's allowed-roots registry — never from a renderer request.
 * deps: { platform, home, fs } injectable for tests.
 */
function checkInsideHomeOrRoots(p, roots = [], deps = {}) {
  const platform = deps.platform || process.platform;
  const home = deps.home || HOME_REAL;
  const list = [...roots];
  const fail = () => ({
    ok: false,
    error: `path outside home and project roots: ${typeof p === 'string' ? p : String(p)}`,
  });
  if (typeof p !== 'string' || !p) return fail();
  let realPath;
  try {
    realPath = realpath(p, deps);
  } catch {
    return fail();
  }
  if (isContainedIn(realPath, home, platform)) return { ok: true, realPath };
  for (const root of list) {
    if (typeof root !== 'string' || !root) continue;
    let realRoot;
    try {
      realRoot = realpath(root, deps);
    } catch {
      realRoot = root;
    }
    if (isContainedIn(realPath, realRoot, platform)) return { ok: true, realPath };
  }
  return fail();
}

function assertInsideHomeOrRoots(p, roots = [], deps = {}) {
  const r = checkInsideHomeOrRoots(p, roots, deps);
  if (!r.ok) throw new Error(r.error);
  return { realPath: r.realPath };
}

module.exports = {
  assertInsideHome,
  checkInsideHome,
  assertInsideHomeOrRoots,
  checkInsideHomeOrRoots,
  isContained,
  isContainedIn,
  realpath,
};
