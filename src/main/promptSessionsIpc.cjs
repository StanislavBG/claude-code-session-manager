'use strict';

/**
 * Read-tier IPC for the Sessions (Epics) list/detail path. The renderer used to
 * read active-index.json, per-Epic archives and the Claude session JSONL via
 * config:readJson/listDir/readText — all `deny` for a remote (web) browser, so
 * the remote UI could never list or open a Session. These channels are the
 * dedicated, fenced replacement: every handler reads ONLY under
 * `<cwd>/session-manager-operations/prompt-sessions` (via opsPath()) — except
 * read-session-transcript, which resolves the project's own Claude JSONL via
 * transcripts.cjs — and refuses a cwd that is not a registered project root.
 * Reads only: the single-writer law (opsOwnership.cjs) is untouched.
 */

const fs = require('node:fs');
const path = require('node:path');

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

function norm(p) {
  return path.resolve(String(p)).replace(/[\\/]+$/, '');
}

/** Default registered-project source: persisted tabs plus every project Claude has seen. */
function defaultProjectRoots() {
  const roots = [];
  try {
    const sessionsStore = require('./sessionsStore.cjs');
    const data = JSON.parse(fs.readFileSync(sessionsStore.storePath(), 'utf8'));
    for (const t of data.tabs || []) if (t && typeof t.cwd === 'string' && t.cwd) roots.push(t.cwd);
  } catch { /* none */ }
  try {
    for (const c of require('./lib/activeSessions.cjs').allProjectCwds()) roots.push(c);
  } catch { /* none */ }
  return roots;
}

/**
 * Short-lived Set of registered roots. Rebuilds when older than ttlMs; a miss
 * rebuilds at most once per missRefreshMs before answering false. Holds only
 * roots from source(), never caller-supplied strings.
 */
function makeRegisteredRootsCache(source, { ttlMs = 10000, missRefreshMs = 1000, now = Date.now } = {}) {
  let set = null;
  let builtAt = 0;
  function rebuild() {
    const { projectRootOf } = require('./lib/activeSessions.cjs');
    const next = new Set();
    for (const r of source() || []) {
      if (typeof r !== 'string' || !r) continue;
      next.add(norm(r));
      next.add(norm(projectRootOf(r) || r));
    }
    set = next;
    builtAt = now();
  }
  return {
    has(cwd) {
      if (!set || now() - builtAt >= ttlMs) rebuild();
      if (set.has(cwd)) return true;
      if (now() - builtAt < missRefreshMs) return false;
      rebuild();
      return set.has(cwd);
    },
  };
}

let defaultRootsCache = null;
function __resetRegisteredRootsCacheForTests() { defaultRootsCache = null; }

function assertRegistered(cwd, projectRoots) {
  if (typeof cwd !== 'string' || !cwd || !path.isAbsolute(cwd)) throw new Error('cwd must be an absolute project path');
  const { projectRootOf } = require('./lib/activeSessions.cjs');
  const want = norm(projectRootOf(cwd) || cwd);
  if (projectRoots === defaultProjectRoots) {
    if (!defaultRootsCache) defaultRootsCache = makeRegisteredRootsCache(defaultProjectRoots);
    if (defaultRootsCache.has(want)) return;
    throw new Error('cwd is not a registered project root');
  }
  for (const r of projectRoots() || []) {
    if (typeof r !== 'string' || !r) continue;
    if (norm(r) === want || norm(projectRootOf(r) || r) === want) return;
  }
  throw new Error('cwd is not a registered project root');
}

function promptSessionsDir(cwd) {
  return require('./lib/opsOwnership.cjs').opsPath(cwd, 'prompt-sessions');
}

function loadActiveIndex(cwd, { projectRoots = defaultProjectRoots } = {}) {
  assertRegistered(cwd, projectRoots);
  const file = path.join(promptSessionsDir(cwd), 'active-index.json');
  try {
    return { exists: true, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { exists: false, data: null };
    return { exists: false, data: null, error: String(err && err.message ? err.message : err) };
  }
}

function listArchived(cwd, { projectRoots = defaultProjectRoots } = {}) {
  assertRegistered(cwd, projectRoots);
  try {
    const ids = fs.readdirSync(promptSessionsDir(cwd), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.json') && e.name !== 'active-index.json')
      .map((e) => e.name.slice(0, -'.json'.length))
      .filter((id) => ID_RE.test(id));
    return { ok: true, ids };
  } catch (err) {
    return { ok: false, ids: [], error: String(err && err.message ? err.message : err) };
  }
}

function readArchived(cwd, epicId, { projectRoots = defaultProjectRoots } = {}) {
  assertRegistered(cwd, projectRoots);
  if (typeof epicId !== 'string' || !ID_RE.test(epicId) || epicId === 'active-index') throw new Error('invalid epicId');
  try {
    return { exists: true, data: JSON.parse(fs.readFileSync(path.join(promptSessionsDir(cwd), `${epicId}.json`), 'utf8')) };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { exists: false, data: null };
    return { exists: false, data: null, error: String(err && err.message ? err.message : err) };
  }
}

function readSessionTranscript(cwd, sessionId, { projectRoots = defaultProjectRoots, resolvePath } = {}) {
  assertRegistered(cwd, projectRoots);
  if (typeof sessionId !== 'string' || !ID_RE.test(sessionId)) throw new Error('invalid sessionId');
  const file = (resolvePath || ((c, s) => require('./transcripts.cjs').transcriptPath(c, s)))(cwd, sessionId);
  try {
    if (fs.statSync(file).size > MAX_TRANSCRIPT_BYTES) return { exists: true, text: '', error: 'transcript too large' };
    return { exists: true, text: fs.readFileSync(file, 'utf8') };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { exists: false, text: '' };
    return { exists: false, text: '', error: String(err && err.message ? err.message : err) };
  }
}

/**
 * Write one completed Epic's archive (<cwd>/…/prompt-sessions/<id>.json).
 * Path is built here from opsPath(); the writer id is hardcoded 'epics'
 * (single-writer law). Refuses a non-registered cwd and an archive whose
 * session.id does not match the named epicId.
 */
async function writeArchive(cwd, epicId, archive, { projectRoots = defaultProjectRoots, writeJson } = {}) {
  assertRegistered(cwd, projectRoots);
  if (typeof epicId !== 'string' || !ID_RE.test(epicId) || epicId === 'active-index') throw new Error('invalid epicId');
  if (!archive || typeof archive !== 'object' || !archive.session || archive.session.id !== epicId) {
    throw new Error('archive.session.id must match epicId');
  }
  const config = require('./config.cjs');
  config.addAllowedRoot(norm(cwd));
  const file = path.join(promptSessionsDir(cwd), `${epicId}.json`);
  await (writeJson || config.writeJson)(file, archive, { writer: 'epics' });
  return { ok: true };
}

function registerPromptSessionsReadHandlers() {
  const { ipcMain } = require('electron');
  const { schemas: s, validated: v } = require('./ipcSchemas.cjs');
  ipcMain.handle('promptSessions:load-active-index', v(s.promptSessionsCwd, ({ cwd }) => loadActiveIndex(cwd)));
  ipcMain.handle('promptSessions:list-archived', v(s.promptSessionsCwd, ({ cwd }) => listArchived(cwd)));
  ipcMain.handle('promptSessions:read-archived', v(s.promptSessionsReadArchived, ({ cwd, epicId }) => readArchived(cwd, epicId)));
  ipcMain.handle('promptSessions:write-archive', v(s.promptSessionsWriteArchive, ({ cwd, epicId, archive }) => writeArchive(cwd, epicId, archive)));
  ipcMain.handle('promptSessions:read-session-transcript', v(s.promptSessionsReadSessionTranscript, ({ cwd, sessionId }) => readSessionTranscript(cwd, sessionId)));
}

module.exports = { makeRegisteredRootsCache, __resetRegisteredRootsCacheForTests, loadActiveIndex, listArchived, readArchived, readSessionTranscript, writeArchive, registerPromptSessionsReadHandlers };
