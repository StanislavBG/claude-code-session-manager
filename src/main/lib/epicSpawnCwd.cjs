'use strict';

/**
 * epicSpawnCwd.cjs — resolves the cwd a child process spawned FOR an Epic's
 * session should actually launch in: the Epic's isolated `git worktree`
 * checkout (`worktree.dir`) when one was created for it, else the Epic's
 * real project cwd unchanged (PRD 1033, wiring the primitives PRD 1032
 * built).
 *
 * Mirrors agentModelResolve.cjs's `findAgentTypeByClaudeSessionId` shape and
 * reuses the same join: an Epic-backed pty.cjs tab / chatRunner.cjs run is
 * keyed by `claudeSessionId` (Tab ID = claudeSessionId, CLAUDE.md), so the
 * matching PromptSession record — and its `worktree` field, when present —
 * is found by scanning `cwd`'s own active-index.json for that id. Plain sync
 * fs (via epicMint.cjs's readActiveIndex), no Electron deps, so callers can
 * use it from a synchronous spawn path without restructuring into async.
 *
 * ---------- the ops-root hazard (read before touching cwd plumbing) --------
 *
 * This resolves ONLY the value a caller hands to a child process's own `cwd`
 * spawn option. `cwd` itself — used for every ops-root read/write
 * (active-index.json, prompt-sessions, scheduler state, opsErrorLog, model
 * resolution) — must keep flowing unchanged everywhere else; see
 * gitWorktree.cjs's own header comment for the full incident history this
 * invariant guards against. Never substitute this function's return value
 * for `cwd` outside a literal spawn-cwd argument.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readActiveIndex } = require('./epicMint.cjs');

/**
 * True when `dir` is a directory that exists RIGHT NOW.
 *
 * `worktree.dir` is an absolute path under os.tmpdir() that gets PERSISTED
 * onto the Epic record in active-index.json — a file this project tracks in
 * git. It therefore outlives the checkout it names, in three ordinary ways:
 *
 *   1. Reboot / tmp sweep. Most Linux distros and macOS clear /tmp on boot
 *      (this host: `D /tmp 1777 root root 30d` in tmpfiles.d — `D` clears at
 *      boot AND ages entries out at 30d). Epics are deliberately long-lived
 *      (that is exactly why the epic kind has no short-lived cap and why boot
 *      reconciliation spares still-active Epics), so an active Epic routinely
 *      outlives its own checkout.
 *   2. Another machine. active-index.json is committed, so a clone carries a
 *      worktree.dir naming a path built from the ORIGINAL machine's tmpdir and
 *      a sha1 of the ORIGINAL machine's project cwd. It cannot exist here.
 *   3. Manual cleanup — `git worktree prune`, an rm -rf, a disk-space sweep.
 *
 * Without this check the spawn path handed a vanished directory straight to
 * node-pty / child_process as its cwd, which fails the spawn outright: the
 * Epic's Terminal and Chat both break with an opaque ENOENT instead of simply
 * falling back to the project's shared tree the way every other failure mode
 * in this chain does.
 */
function isUsableDir(dir, statImpl) {
  try {
    return statImpl(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Re-attach `branch` at `dir` (`git worktree add`). Sync + bounded; never throws. `dir` comes from
 * a git-tracked file, so it is only honoured when it sits in a `session-manager-epic-worktrees`
 * segment and the branch is an `sm-epic/` one — nothing else may be materialised from that record.
 * @returns {boolean} true when `dir` now exists as a checkout.
 */
function restoreEpicWorktree({ dir, branch, baseCwd }) {
  try {
    if (!path.isAbsolute(dir) || !path.isAbsolute(baseCwd)) return false;
    if (!path.resolve(dir).split(path.sep).includes('session-manager-epic-worktrees')) return false;
    if (typeof branch !== 'string' || !/^sm-epic\/[A-Za-z0-9._-]+$/.test(branch)) return false;
    const run = (args) => execFileSync('git', args, { cwd: baseCwd, stdio: 'ignore', timeout: 15_000 });
    run(['worktree', 'prune']);
    run(['worktree', 'add', dir, branch]);
    return isUsableDir(dir, fs.statSync);
  } catch {
    return false;
  }
}

/**
 * @param {{ cwd: string, claudeSessionId: string, deps?: object }} opts
 * @returns {string} `worktree.dir` when it exists (or was just restored), else `cwd`.
 *   Never a nonexistent path. The transcript-split hazard is guarded by
 *   epicSpawnPlan.cjs's reachability check, not by returning a dead path.
 */
function resolveEpicSpawnCwd({ cwd, claudeSessionId, deps = {} } = {}) {
  if (!cwd || !claudeSessionId) return cwd;
  try {
    const load = deps.readActiveIndex || readActiveIndex;
    const statSync = deps.statSync || fs.statSync;
    const { sessions } = load(cwd);
    for (const session of Object.values(sessions)) {
      if (session && session.claudeSessionId === claudeSessionId) {
        const dir = session.worktree?.dir;
        if (!dir) return cwd;
        if (!isUsableDir(dir, statSync)) {
          // The checkout is gone. A merged/disabled Epic's branch was deleted with it
          // (epicWorktreeMerge.cjs cleans up with keepBranch:false), so re-attaching can
          // never succeed — skip the two git subprocesses. Otherwise (spawn side only)
          // re-attach the Epic's branch at the SAME recorded path so the transcript
          // encoding is unchanged. Read-side callers (no `restore`) never mutate git state.
          const st = session.worktree?.status;
          const restorable = st !== 'merged' && st !== 'disabled';
          if (deps.restore && restorable) {
            const restored = (deps.restoreWorktree || restoreEpicWorktree)({ dir, branch: session.worktree?.branch, baseCwd: cwd });
            if (restored) {
              console.log(`[epicSpawnCwd] worktree dir gone (${dir}) — restored at same path`);
              return dir;
            }
            console.log(`[epicSpawnCwd] worktree dir gone (${dir}) — restore failed; falling back to ${cwd}`);
          } else if (deps.restore) {
            console.log(`[epicSpawnCwd] worktree dir gone (${dir}) — checkout was removed on ${st}; restore correctly skipped, falling back to ${cwd}`);
          } else {
            console.log(`[epicSpawnCwd] worktree dir gone (${dir}) — read-side falls back to ${cwd}`);
          }
          // Always a REAL directory; epicSpawnPlan.cjs refuses when the transcript is not
          // visible from this cwd, so this cannot silently fork a transcript.
          return cwd;
        }
        return dir;
      }
    }
  } catch {
    return cwd;
  }
  return cwd;
}

module.exports = { resolveEpicSpawnCwd, restoreEpicWorktree };
