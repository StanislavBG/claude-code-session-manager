'use strict';

/**
 * epicSpawnPlan.cjs — decides the spawn cwd AND the --resume/--session-id flag for an Epic's
 * chat run TOGETHER (PRD 1319). They used to be computed independently: the flag from "does a
 * transcript exist under ANY encoding" and the cwd separately, so a transcript stranded under a
 * swept /tmp worktree encoding produced `--resume` from a cwd that cannot see it ("No
 * conversation found"), the flag-swap retry then hit `--session-id` ("already in use"), and both
 * doors were locked.
 *
 * Chosen fix: (a) first — resolveEpicSpawnCwd({restore:true}) re-attaches the Epic's own branch
 * at the SAME recorded path (encoding unchanged), so the CLI sees the transcript again. When that
 * is impossible, (b): refuse BEFORE spawning with an actionable message naming the missing
 * worktree path, never claim a flag that cannot work. Reachability = "some existing transcript
 * lives under encodeCwd(spawn cwd)" and the spawn cwd is a real directory.
 *
 * Also refuses requests routed to a closed (`completed`) Epic, and keeps a per-session circuit
 * breaker: once a session is found unreachable, later requests are refused after ONE stat (is the
 * worktree dir still missing?) without re-running the restore git commands.
 *
 * Ops-root hazard (epicSpawnCwd.cjs): `execCwd` returned here is for the spawn cwd option ONLY;
 * ops reads/writes keep using the project `cwd` (projectRootOf / resolveProjectRoot).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { encodeCwd } = require('./encodeCwd.cjs');
const { readActiveIndex } = require('./epicMint.cjs');
const { resolveEpicSpawnCwd } = require('./epicSpawnCwd.cjs');
const { resolveEpicTranscriptPath } = require('./epicTranscriptPath.cjs');

/** Map<sessionId, { dir, message }> — sessions found unreachable; valid while `dir` stays missing. */
const unreachable = new Map();

function __resetForTests() {
  unreachable.clear();
}

function isDir(dir, statSync) {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** The Epic record for a session id: active-index first, else a bounded scan of archived `<id>.json`. */
function findEpic(cwd, claudeSessionId, deps) {
  try {
    for (const s of Object.values((deps.readActiveIndex || readActiveIndex)(cwd).sessions || {})) {
      if (s && s.claudeSessionId === claudeSessionId) return s;
    }
  } catch { /* unreadable index → try archives */ }
  try {
    const { opsPath } = require('./opsOwnership.cjs');
    const dir = opsPath(cwd, 'prompt-sessions');
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json') || name === 'active-index.json') continue;
      try {
        const s = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))?.session;
        if (s && s.claudeSessionId === claudeSessionId) return s;
      } catch { /* malformed archive */ }
    }
  } catch { /* no ops dir */ }
  return null;
}

/**
 * @param {{ cwd: string, claudeSessionId: string, fallbackResume?: boolean, deps?: object }} opts
 * @returns {{ ok: true, execCwd: string, useResume: boolean, transcriptPath: string|null }
 *   | { ok: false, code: 'epic_closed'|'session_unreachable', message: string }}
 */
function planEpicSpawn({ cwd, claudeSessionId, fallbackResume = false, deps = {} } = {}) {
  const statSync = deps.statSync || fs.statSync;
  const epic = findEpic(cwd, claudeSessionId, deps);

  if (epic && epic.status === 'completed') {
    return {
      ok: false,
      code: 'epic_closed',
      message: `This Epic is closed (completed) — it no longer accepts requests. Start a new Epic instead of routing work into session ${claudeSessionId}.`,
    };
  }

  const brokenDir = epic?.worktree?.dir;
  const tripped = unreachable.get(claudeSessionId);
  if (tripped && !isDir(tripped.dir, statSync)) return { ok: false, code: 'session_unreachable', message: tripped.message };
  unreachable.delete(claudeSessionId);

  let useResume = !!fallbackResume;
  let resolved = null;
  try {
    resolved = resolveEpicTranscriptPath({ cwd, claudeSessionId, deps });
    useResume = !!resolved.existsAnywhere;
  } catch { /* keep the caller-supplied flag */ }

  const execCwd = (deps.resolveSpawnCwd || resolveEpicSpawnCwd)({ cwd, claudeSessionId, deps: { restore: true, readActiveIndex: deps.readActiveIndex, statSync: deps.statSync, restoreWorktree: deps.restoreWorktree } });

  if (resolved && resolved.existsAnywhere) {
    const projectsDir = path.join(deps.homeDir || os.homedir(), '.claude', 'projects');
    const home = path.join(projectsDir, encodeCwd(execCwd));
    const reachable = isDir(execCwd, statSync) && resolved.existingPaths.some((p) => path.dirname(p) === home);
    if (!reachable) {
      const missing = brokenDir || execCwd;
      const message =
        `Session ${claudeSessionId} cannot be resumed: its transcript is at ${resolved.existingPaths[0]}, ` +
        `which the CLI only finds when run from ${missing}, and that worktree no longer exists and could not be ` +
        `re-attached (likely swept from /tmp). Recreate it (git worktree add "${missing}" ${epic?.worktree?.branch || '<sm-epic branch>'}) ` +
        `or start a new Epic.`;
      unreachable.set(claudeSessionId, { dir: missing, message });
      return { ok: false, code: 'session_unreachable', message };
    }
  }

  return { ok: true, execCwd, useResume, transcriptPath: resolved?.path ?? null };
}

module.exports = { planEpicSpawn, __resetForTests };
