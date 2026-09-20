'use strict';

/**
 * epicTranscriptPath.cjs — answers "where does this Epic session's JSONL
 * transcript actually live?".
 *
 * The CLI writes `~/.claude/projects/<encodeCwd(spawn cwd)>/<id>.jsonl`, and an
 * Epic's spawn cwd is normally its isolated worktree dir (chatRunner.cjs and
 * pty.cjs via epicSpawnPlan.cjs), falling back to the project cwd when the
 * worktree is merged/gone. Turn 1 can still land under the
 * project encoding (the worktree mint is fire-and-forget), and the worktree dir
 * itself is routinely swept from /tmp while its transcript survives under
 * ~/.claude/projects. So candidates are built from the recorded `worktree.dir`
 * even when that directory no longer exists.
 *
 * Bounded: never enumerates ~/.claude/projects, only stats its candidate list.
 * The active-index.json read and the archive scan are memoised per cwd on
 * mtimeMs + size (same shape as transcripts.cjs's usageCache) because
 * usageFor() can call this for up to 500 ids in one IPC.
 *
 * Ops-root hazard (see epicSpawnCwd.cjs): `cwd` here is the PROJECT cwd used
 * for ops-root reads; this returns transcript paths only, never a spawn cwd.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { encodeCwd } = require('./encodeCwd.cjs');
const { readActiveIndex } = require('./epicMint.cjs');
const { resolveEpicSpawnCwd } = require('./epicSpawnCwd.cjs');

/** Map<cwd, { key, sessions }> — active-index.json parse, keyed on mtime+size. */
const indexCache = new Map();
/** Map<cwd, { dirKey, files: Map<name,{key,sid,dir}>, byId: Map<sid,string[]> }> */
const archiveCache = new Map();

function __resetCacheForTests() {
  indexCache.clear();
  archiveCache.clear();
}

function emptyResult() {
  return { path: null, candidates: [], existsAnywhere: false, existingPaths: [] };
}

function statKey(statSync, p) {
  try {
    const s = statSync(p);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return 'missing';
  }
}

function opsFile(cwd, ...segments) {
  const { opsPath } = require('./opsOwnership.cjs');
  return opsPath(cwd, 'prompt-sessions', ...segments);
}

/** Sessions map from active-index.json; O(1) stat when unchanged. */
function cachedSessions(cwd, deps, statSync) {
  const key = statKey(statSync, opsFile(cwd, 'active-index.json'));
  const hit = indexCache.get(cwd);
  if (hit && hit.key === key) return hit.sessions;
  let sessions = {};
  try {
    sessions = (deps.readActiveIndex || readActiveIndex)(cwd).sessions || {};
  } catch {
    sessions = {};
  }
  indexCache.set(cwd, { key, sessions });
  return sessions;
}

/** Worktree dirs recorded for `sid` across archived per-Epic JSON files. */
function archivedWorktreeDirs(cwd, sid, statSync) {
  let dirPath;
  try {
    dirPath = opsFile(cwd);
  } catch {
    return [];
  }
  const dirKey = statKey(statSync, dirPath);
  let entry = archiveCache.get(cwd);
  if (entry && entry.dirKey === dirKey) return entry.byId.get(sid) || [];
  const prevFiles = entry ? entry.files : new Map();
  const files = new Map();
  let names = [];
  try {
    names = fs.readdirSync(dirPath);
  } catch {
    names = [];
  }
  for (const name of names) {
    if (!name.endsWith('.json') || name === 'active-index.json') continue;
    const file = path.join(dirPath, name);
    const key = statKey(statSync, file);
    const prev = prevFiles.get(name);
    if (prev && prev.key === key) {
      files.set(name, prev);
      continue;
    }
    let rec = { key, sid: null, dir: null };
    try {
      const s = JSON.parse(fs.readFileSync(file, 'utf8'))?.session;
      if (s && typeof s.claudeSessionId === 'string' && typeof s.worktree?.dir === 'string') {
        rec = { key, sid: s.claudeSessionId, dir: s.worktree.dir };
      }
    } catch {
      // malformed archive → no hint
    }
    files.set(name, rec);
  }
  const byId = new Map();
  for (const rec of files.values()) {
    if (!rec.sid || !rec.dir) continue;
    const list = byId.get(rec.sid) || [];
    list.push(rec.dir);
    byId.set(rec.sid, list);
  }
  entry = { dirKey, files, byId };
  archiveCache.set(cwd, entry);
  return byId.get(sid) || [];
}

/**
 * @param {{ cwd: string, claudeSessionId: string, deps?: object }} opts
 * @returns {{ path: string|null, candidates: string[], existsAnywhere: boolean, existingPaths: string[] }}
 */
function resolveEpicTranscriptPath({ cwd, claudeSessionId, deps = {} } = {}) {
  if (!cwd || typeof cwd !== 'string' || !claudeSessionId || typeof claudeSessionId !== 'string') {
    return emptyResult();
  }
  // The id becomes a filename — refuse anything that could escape the project dir.
  if (/[\\/\0]/.test(claudeSessionId) || claudeSessionId === '.' || claudeSessionId === '..') {
    return emptyResult();
  }
  const statSync = deps.statSync || fs.statSync;
  const projectsDir = path.join(deps.homeDir || os.homedir(), '.claude', 'projects');
  const file = (dir) => path.join(projectsDir, encodeCwd(dir), `${claudeSessionId}.jsonl`);

  const worktreeDirs = [];
  try {
    const sessions = cachedSessions(cwd, deps, statSync);
    let inIndex = false;
    for (const s of Object.values(sessions)) {
      if (s && s.claudeSessionId === claudeSessionId) {
        inIndex = true;
        if (typeof s.worktree?.dir === 'string' && s.worktree.dir) worktreeDirs.push(s.worktree.dir);
      }
    }
    if (!inIndex) worktreeDirs.push(...archivedWorktreeDirs(cwd, claudeSessionId, statSync));
  } catch {
    // unreadable ops state → fall through to whatever candidates we have
  }

  let spawnCwd = cwd;
  try {
    spawnCwd = resolveEpicSpawnCwd({ cwd, claudeSessionId, deps: { ...deps, readActiveIndex: () => ({ sessions: cachedSessions(cwd, deps, statSync) }) } }) || cwd;
  } catch {
    spawnCwd = cwd;
  }

  const candidates = [...new Set([file(spawnCwd), ...worktreeDirs.map(file), file(cwd)])];

  const existing = [];
  for (const p of candidates) {
    try {
      const st = statSync(p);
      if (st.isFile()) existing.push({ p, mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      // absent
    }
  }
  const existingPaths = existing.map((e) => e.p);
  const newest = (list) => list.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
  const nonEmpty = existing.filter((e) => e.size > 0);
  let chosen = candidates[0];
  if (nonEmpty.length) chosen = newest(nonEmpty).p;
  else if (existing.length) chosen = existing[0].p;

  return { path: chosen, candidates, existsAnywhere: existing.length > 0, existingPaths };
}

module.exports = { resolveEpicTranscriptPath, __resetCacheForTests };
