/**
 * insideHome.cjs — security invariant: every renderer-controlled cwd must
 * resolve (after realpath, symlink-safe) to a path inside the user's home
 * directory. Four call sites used to reimplement this: pty.cjs spawn,
 * watchers.cjs add, index.cjs checkInsideHome, ipcSchemas.cjs setConfigSchema
 * defaultCwd refine. The check is a single chokepoint here.
 *
 * Returns { ok: true, realCwd } on success or { ok: false, error } on rejection.
 * Realpath of the cwd is returned so callers can use it without recomputing.
 *
 * NOTE: schemas can't easily call this (zod refines are inline); they retain
 * a simpler `startsWith` check that does NOT symlink-resolve. The runtime
 * resolution here is the authoritative one — schemas are belt-and-suspenders.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function assertCwdInsideHome(cwd) {
  if (typeof cwd !== 'string' || !cwd) {
    return { ok: false, error: 'cwd must be a non-empty string' };
  }
  const home = os.homedir();
  let realCwd;
  try {
    realCwd = fs.realpathSync(cwd);
  } catch {
    realCwd = path.resolve(cwd);
  }
  if (realCwd !== home && !realCwd.startsWith(home + path.sep)) {
    return { ok: false, error: `cwd outside home directory: ${realCwd}` };
  }
  return { ok: true, realCwd };
}

module.exports = { assertCwdInsideHome };
