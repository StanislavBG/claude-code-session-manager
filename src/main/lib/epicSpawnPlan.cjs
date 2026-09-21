'use strict';

/**
 * epicSpawnPlan.cjs — decides the spawn cwd AND the --resume/--session-id flag for an Epic's
 * chat run TOGETHER (PRD 1319). They used to be computed independently: the flag from "does a
 * transcript exist under ANY encoding" and the cwd separately, so a transcript stranded under a
 * swept /tmp worktree encoding produced `--resume` from a cwd that cannot see it ("No
 * conversation found"), the flag-swap retry then hit `--session-id` ("already in use"), and both
 * doors were locked.
 *
 * Three-way decision: (1) re-attach — resolveEpicSpawnCwd({restore:true}) re-attaches the Epic's
 * own branch at the SAME recorded path (encoding unchanged), so the CLI sees the transcript again;
 * (2) project-cwd fallback — when that spawn cwd cannot see the transcript but the project cwd can
 * (transcript filed under encodeCwd(project cwd)), spawn from the project cwd; nothing forks since
 * it writes to the directory it already occupies; (3) refuse BEFORE spawning with a message stating
 * the real cause, never claim a flag that cannot work. Reachable = "some existing transcript lives
 * under encodeCwd(candidate cwd)" and the candidate is a real directory.
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
const { projectRootOf } = require('./activeSessions.cjs');
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
 *   | { ok: false, code: 'epic_closed'|'session_unreachable'|'spawn_cwd_missing', message: string }}
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

  let execCwd = (deps.resolveSpawnCwd || resolveEpicSpawnCwd)({ cwd, claudeSessionId, deps: { restore: true, readActiveIndex: deps.readActiveIndex, statSync: deps.statSync, restoreWorktree: deps.restoreWorktree } });

  if (resolved && resolved.existsAnywhere) {
    const projectsDir = path.join(deps.homeDir || os.homedir(), '.claude', 'projects');
    // O(candidates × existingPaths); both are tiny. Candidate order: chosen execCwd, then project cwd.
    const findReachable = (dir) => {
      if (!isDir(dir, statSync)) return null;
      const home = path.join(projectsDir, encodeCwd(dir));
      return resolved.existingPaths.find((p) => path.dirname(p) === home) || null;
    };
    // The transcript may already live under the project encoding; spawning there writes back to
    // the directory it occupies, so nothing forks. `projectRootOf(cwd)` only contributes for a LIVE
    // worktree caller cwd (it returns a vanished worktree path unchanged, so it adds nothing there);
    // `epic.cwd`/`worktree.baseCwd` are not probed — the Epic is only found via the caller cwd, which
    // is already a candidate, so they could never change an outcome.
    let projectRoot = null;
    try { projectRoot = projectRootOf(cwd); } catch { /* unresolvable → skip */ }
    const candidates = [...new Set([execCwd, cwd, projectRoot].filter((d) => typeof d === 'string' && d))];
    let reachableDir = null;
    for (const dir of candidates) {
      if (findReachable(dir)) { reachableDir = dir; break; }
    }
    if (reachableDir) {
      execCwd = reachableDir;
      unreachable.delete(claudeSessionId);
    } else {
      // Name a directory that would actually work: an existing candidate is only worth naming if
      // its encoding owns a transcript, which none did — so name the recorded worktree checkout.
      const missing = brokenDir || execCwd;
      const wt = epic?.worktree;
      const recovery = wt?.status === 'merged'
        ? `That checkout was removed when the Epic was merged to main and its ${wt.branch || 'sm-epic/*'} branch was deleted, so it cannot be recreated. Start a new Epic.`
        : `The checkout is gone and could not be re-attached (it may have been swept from its temp/state directory). Recreate it (git worktree add "${missing}" ${wt?.branch || '<sm-epic branch>'}) or start a new Epic.`;
      const message =
        `Session ${claudeSessionId} cannot be resumed: its transcript is at ${resolved.existingPaths[0]}, ` +
        `which the CLI only finds when run from ${missing}. ${recovery}`;
      unreachable.set(claudeSessionId, { dir: missing, message });
      return { ok: false, code: 'session_unreachable', message };
    }
  }

  if (!isDir(execCwd, statSync)) {
    return {
      ok: false,
      code: 'spawn_cwd_missing',
      message: `Cannot spawn session ${claudeSessionId}: directory ${execCwd} does not exist. Pass the Epic's project cwd (the project root, not a removed worktree path) as the caller cwd.`,
    };
  }

  return { ok: true, execCwd, useResume, transcriptPath: resolved?.path ?? null };
}

module.exports = { planEpicSpawn, __resetForTests };
