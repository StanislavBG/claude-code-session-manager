/**
 * procName.cjs — make Session Manager's spawned processes distinguishable in
 * GNOME System Monitor / ps / htop.
 *
 *  - aliasBinFor(realBin, alias): the kernel sets `comm` (the "Process Name"
 *    column) to the basename of the path handed to execve, capped at 15 chars
 *    (TASK_COMM_LEN 16 incl. NUL). argv0 does NOT affect it, so we exec a
 *    symlink named `alias` that points at the real binary.
 *  - smArgv0(role, detail): a bounded argv0 label for /proc/pid/cmdline. It
 *    ALWAYS contains `claude` as a word — /\bclaude\b/ gates killOrphanClaudePid
 *    (scheduler.cjs), claudePidAlive and findLiveProcessForJob (reaperHelpers.cjs).
 *
 * Fail-open is absolute: any error returns the ORIGINAL bin. Naming must never
 * stop a job from launching.
 *
 * DELIBERATE exceptions to CLAUDE.md laws (do not "fix"):
 *  - The tmp+rename symlink primitive below is NOT config.cjs writeJson /
 *    writeTextAtomic: those write file contents and cannot create symlinks.
 *  - procnamesRoot() is intentionally NOT registered with config.cjs validateWrite /
 *    addAllowedRoot: that containment governs IPC-reachable writes; this is a
 *    main-process-internal write.
 *
 * Not to be confused with procIdentity.cjs (pid-recycling fingerprint).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { procnamesRoot } = require('./schedulerPaths.cjs');
const MAX_ALIAS_LEN = 15; // Linux TASK_COMM_LEN (16) minus NUL
const MAX_LABEL_LEN = 120;

let tmpSeq = 0;

function resolveBare(bin) {
  if (path.isAbsolute(bin)) return bin;
  try {
    // Lazy: openExternalApp requires 'electron', unavailable outside the app.
    const { findCommand } = require('./openExternalApp.cjs');
    const found = findCommand(bin);
    return found && path.isAbsolute(found) ? found : null;
  } catch { return null; }
}

/** O(1) fs ops. Returns alias path on success, else `realBin` unchanged. */
function aliasBinFor(realBin, alias) {
  if (typeof alias !== 'string' || !alias || alias.length > MAX_ALIAS_LEN || /[\\/\0]/.test(alias) || alias === '.' || alias === '..') {
    throw new Error(`procName: alias "${alias}" must be 1-${MAX_ALIAS_LEN} chars (Linux TASK_COMM_LEN) with no path separators`);
  }
  try {
    if (typeof realBin !== 'string' || !realBin) return realBin;
    const target = resolveBare(realBin);
    if (!target) return realBin;
    const aliasPath = path.join(procnamesRoot(), alias);
    let current = null;
    try { current = fs.readlinkSync(aliasPath); } catch { /* absent or not a link */ }
    if (current !== target) {
      fs.mkdirSync(procnamesRoot(), { recursive: true });
      const tmp = path.join(procnamesRoot(), `.${alias}.${process.pid}.${Date.now()}.${tmpSeq++}.tmp`);
      try {
        fs.symlinkSync(target, tmp);
        fs.renameSync(tmp, aliasPath); // atomic replace; never unlink-then-symlink
      } catch (err) {
        try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
        if (err && err.code !== 'EEXIST') throw err; // losing racer: swallow
      }
    }
    fs.accessSync(aliasPath, fs.constants.X_OK); // noexec / dangling probe
    return aliasPath;
  } catch {
    return realBin;
  }
}

/** `sm-claude-<role>:<detail>`, sanitised to [A-Za-z0-9._-], <= 120 chars. Always contains word `claude`. */
function smArgv0(role, detail) {
  const clean = (v) => String(v == null ? '' : v).replace(/[^A-Za-z0-9._-]/g, '');
  const r = clean(role) || 'proc';
  const d = clean(detail);
  return `sm-claude-${r}${d ? `:${d}` : ''}`.slice(0, MAX_LABEL_LEN);
}

/** Remove alias entries whose target no longer resolves to an executable. Never throws. O(entries). */
function pruneStaleAliases() {
  try {
    for (const name of fs.readdirSync(procnamesRoot())) {
      const p = path.join(procnamesRoot(), name);
      try {
        fs.accessSync(p, fs.constants.X_OK);
      } catch {
        try { fs.unlinkSync(p); } catch { /* best effort */ }
      }
    }
  } catch { /* root absent/unreadable */ }
}

module.exports = { aliasBinFor, smArgv0, procnamesRoot, pruneStaleAliases };
