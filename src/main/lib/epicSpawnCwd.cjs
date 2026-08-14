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

const { readActiveIndex } = require('./epicMint.cjs');

/**
 * @param {{ cwd: string, claudeSessionId: string, deps?: object }} opts
 * @returns {string} `worktree.dir` when the matching Epic has one, else `cwd` unchanged.
 */
function resolveEpicSpawnCwd({ cwd, claudeSessionId, deps = {} } = {}) {
  if (!cwd || !claudeSessionId) return cwd;
  try {
    const load = deps.readActiveIndex || readActiveIndex;
    const { sessions } = load(cwd);
    for (const session of Object.values(sessions)) {
      if (session && session.claudeSessionId === claudeSessionId) {
        return session.worktree?.dir || cwd;
      }
    }
  } catch {
    return cwd;
  }
  return cwd;
}

module.exports = { resolveEpicSpawnCwd };
