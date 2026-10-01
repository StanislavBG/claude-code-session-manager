/**
 * timeoutShim.cjs — installs a dependency-free `timeout` shim under the
 * user's home, for machines whose `timeout` is missing or non-GNU (stock
 * macOS ships none at all), and exposes `withTimeoutShimOnPath` so a child
 * spawn's PATH can fall back to it.
 *
 * Mirrors guardShims.cjs's pattern: a stable path under
 * `~/.claude/session-manager/`, written with `writeTextAtomic`, idempotent
 * (a re-run with unchanged content writes nothing), and `addAllowedRoot`
 * called first so a test's temp "home" passes config.cjs's write-boundary
 * check the same way the real home does.
 *
 * `timeout-shim.cjs` under the shim dir is a verbatim copy of
 * timeoutShimScript.cjs, read from disk at call time (not inlined here) so
 * the installed copy can never drift from the source file. `timeout` is a
 * tiny POSIX launcher that runs it with `node`, falling back to the current
 * Electron binary (`execPath`) with ELECTRON_RUN_AS_NODE=1 when no `node` is
 * on PATH.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeTextAtomic, addAllowedRoot } = require('../config.cjs');

function shimDir(homeDir = os.homedir()) {
  return path.join(homeDir, '.claude', 'session-manager', 'bin');
}

function shimPath(homeDir = os.homedir()) {
  return path.join(shimDir(homeDir), 'timeout');
}

function scriptDestPath(homeDir = os.homedir()) {
  return path.join(shimDir(homeDir), 'timeout-shim.cjs');
}

// Single-quote the exec path for POSIX sh: close the quote, escape any
// literal `'` as `'\''`, reopen it. A plain path with no `'` in it just
// comes back wrapped in quotes.
function quoteForShell(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function launcherBody(execPath) {
  return `#!/bin/sh
SHIM_DIR=$(dirname "$0")
if command -v node >/dev/null 2>&1; then
  exec node "$SHIM_DIR/timeout-shim.cjs" "$@"
fi
ELECTRON_RUN_AS_NODE=1 exec ${quoteForShell(execPath)} "$SHIM_DIR/timeout-shim.cjs" "$@"
`;
}

function readIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Writes the shim pair under `<homeDir>/.claude/session-manager/bin`.
 * Each file is written only when its content differs from what's already on
 * disk, and the launcher's mode is set to 0755 unconditionally (even on a
 * no-op run) so a permission change outside this function self-heals on the
 * next call. Never throws: returns `{ok:true, changed, path}` (`path` is the
 * launcher path) on success, `{ok:false, error}` on failure, and
 * `{ok:false, skipped:true}` on win32, where there is no POSIX shell to run
 * the launcher.
 */
async function ensureTimeoutShim({ homeDir = os.homedir(), execPath = process.execPath } = {}) {
  if (process.platform === 'win32') return { ok: false, skipped: true };
  try {
    addAllowedRoot(homeDir);
    const scriptDest = scriptDestPath(homeDir);
    const launcherDest = shimPath(homeDir);
    const scriptContent = fs.readFileSync(path.join(__dirname, 'timeoutShimScript.cjs'), 'utf8');
    const launcherContent = launcherBody(execPath);

    let changed = false;
    if (readIfExists(scriptDest) !== scriptContent) {
      await writeTextAtomic(scriptDest, scriptContent);
      changed = true;
    }
    if (readIfExists(launcherDest) !== launcherContent) {
      await writeTextAtomic(launcherDest, launcherContent);
      changed = true;
    }
    fs.chmodSync(launcherDest, 0o755);
    return { ok: true, changed, path: launcherDest };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

/**
 * Appends the shim dir to `pathValue`, at the end, so a real `timeout`
 * earlier on PATH (GNU coreutils, Homebrew, ...) keeps winning. No-op when
 * the shim dir is already anywhere in `pathValue` — never adds a duplicate.
 */
function withTimeoutShimOnPath(pathValue, homeDir = os.homedir()) {
  const dir = shimDir(homeDir);
  const current = pathValue == null ? '' : String(pathValue);
  const parts = current.split(path.delimiter).filter(Boolean);
  if (parts.includes(dir)) return current;
  if (!parts.length) return dir;
  return `${current}${path.delimiter}${dir}`;
}

module.exports = {
  shimDir,
  shimPath,
  ensureTimeoutShim,
  withTimeoutShimOnPath,
};
