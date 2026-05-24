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
 * Linux + darwin only. No Windows path handling.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Resolve home once. Falls back to literal homedir if realpath fails
// (which would be a misconfigured system; boot self-check in index.cjs
// surfaces it). Cached for the lifetime of the process — home doesn't
// move under us at runtime.
const HOME_LITERAL = os.homedir();
let HOME_REAL;
try {
  HOME_REAL = fs.realpathSync(HOME_LITERAL);
} catch {
  HOME_REAL = HOME_LITERAL;
}

function resolveTarget(p) {
  // realpath fails with ENOENT for paths that don't exist yet (writes,
  // mkdir destinations). Fall through to lexical resolve so the containment
  // check still applies — prevents info-disclosure via stat probes on
  // /etc/secrets/... that would be rejected later but reveal existence first.
  try {
    return fs.realpathSync(p);
  } catch (err) {
    if (err && err.code === 'ENOENT') return path.resolve(p);
    throw err;
  }
}

function isContained(realPath) {
  return realPath === HOME_REAL || realPath.startsWith(HOME_REAL + path.sep);
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

module.exports = { assertInsideHome, checkInsideHome };
