'use strict';

/**
 * epicOutsideRead.cjs — the record an outside app reads for one Epic.
 *
 * Joins the project's active index (or, for a completed Epic, its archive
 * file), the scheduler job rows, the awaiting-input reader and
 * computeEpicOutsideState into one plain record. Read-only; every read is
 * guarded so a broken file yields null or an empty list, and nothing throws.
 *
 * Scheduler + chat liveness come in as injected functions (listJobs,
 * isTabBusy) with safe defaults (no jobs, never busy) so this module needs no
 * running scheduler. An unregistered project reads as nothing.
 */

const path = require('node:path');
const { readActiveIndex } = require('./epicMint.cjs');
const { computeEpicOutsideState } = require('./epicOutsideState.cjs');
const { findEpicByExternalRef } = require('./externalRefIndex.cjs');
const { awaitingInputSessions } = require('../../exchanges.cjs');
const { readArchived, defaultProjectRoots, makeRegisteredRootsCache } = require('../../promptSessionsIpc.cjs');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const OPEN_STATUSES = new Set(['proposed', 'active']);

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' && v !== '' ? v : null);
const norm = (p) => path.resolve(String(p)).replace(/[\\/]+$/, '');

let defaultRootsCache = null;

/** Same rule as promptSessionsIpc's assertRegistered, but answers a boolean. */
function isRegistered(cwd, projectRoots) {
  try {
    if (typeof cwd !== 'string' || !cwd || !path.isAbsolute(cwd)) return false;
    const { projectRootOf } = require('../activeSessions.cjs');
    const want = norm(projectRootOf(cwd) || cwd);
    if (projectRoots === defaultProjectRoots) {
      if (!defaultRootsCache) defaultRootsCache = makeRegisteredRootsCache(defaultProjectRoots);
      return defaultRootsCache.has(want);
    }
    for (const r of projectRoots() || []) {
      if (typeof r !== 'string' || !r) continue;
      if (norm(r) === want || norm(projectRootOf(r) || r) === want) return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function loadJobs(listJobs) {
  try {
    const out = await listJobs();
    if (Array.isArray(out)) return out;
    if (isObj(out) && Array.isArray(out.jobs)) return out.jobs;
  } catch { /* no jobs */ }
  return [];
}

async function loadAwaiting(cwd) {
  try {
    const set = await awaitingInputSessions(cwd);
    return set instanceof Set ? set : new Set();
  } catch {
    return new Set();
  }
}

async function busy(isTabBusy, epicId) {
  try {
    return (await isTabBusy(epicId)) === true;
  } catch {
    return false;
  }
}

/** goalText split at the first blank line → { title, goal }; absent parts are null. */
function splitGoal(goalText) {
  if (typeof goalText !== 'string') return { title: null, goal: null };
  const m = /\r?\n[ \t]*\r?\n/.exec(goalText);
  const head = (m ? goalText.slice(0, m.index) : goalText).trim();
  const tail = m ? goalText.slice(m.index + m[0].length).trim() : '';
  return { title: head || null, goal: tail || null };
}

function buildRecord(cwd, epicId, session, events, jobs, needsInput, chatBusy) {
  const computed = computeEpicOutsideState({ session: { ...session, id: epicId }, events, jobs, needsInput, chatBusy });
  const source = isObj(session.source) ? session.source : {};
  const { title, goal } = splitGoal(session.goalText);
  return {
    epicId,
    cwd: str(session.cwd) || cwd,
    title,
    goal,
    tag: str(session.tag),
    agentType: str(session.agentType),
    status: str(session.status),
    state: computed.state,
    blocked: computed.blocked,
    prds: computed.prds,
    verified: computed.verified,
    refuted: computed.refuted,
    unvalidated: computed.unvalidated,
    externalRef: str(source.externalRef),
    source: {
      producer: str(source.producer),
      fromCwd: str(source.fromCwd),
      fromEpicId: str(source.fromEpicId),
      macroId: str(source.macroId),
    },
    createdAt: str(session.createdAt),
    completedAt: str(session.completedAt),
  };
}

function eventsOf(index, epicId) {
  const chain = isObj(index.events) ? index.events[epicId] : null;
  return Array.isArray(chain) ? chain : [];
}

function openSession(index, epicId) {
  const s = isObj(index.sessions) && Object.prototype.hasOwnProperty.call(index.sessions, epicId)
    ? index.sessions[epicId]
    : null;
  return isObj(s) && OPEN_STATUSES.has(s.status) ? s : null;
}

async function openRecord(cwd, epicId, session, index, jobs, awaiting, isTabBusy) {
  const claudeSessionId = str(session.claudeSessionId);
  const needsInput = claudeSessionId != null && awaiting.has(claudeSessionId);
  const chatBusy = await busy(isTabBusy, epicId);
  return buildRecord(cwd, epicId, session, eventsOf(index, epicId), jobs, needsInput, chatBusy);
}

function archivedRecord(cwd, epicId, projectRoots, jobs) {
  try {
    const res = readArchived(cwd, epicId, { projectRoots });
    const data = res && res.exists ? res.data : null;
    if (!isObj(data) || !str(data.archivedAt) || !isObj(data.session)) return null;
    const session = { ...data.session, status: 'completed' };
    const events = Array.isArray(data.events) ? data.events : [];
    return buildRecord(cwd, epicId, session, events, jobs, false, false);
  } catch {
    return null;
  }
}

/**
 * One Epic by id or externalRef: open from the active index, else completed
 * from its archive file (only when archivedAt is set). Null on no match.
 *
 * @param {string} cwd
 * @param {{ id?: string, externalRef?: string, isTabBusy?: (epicId: string) => boolean | Promise<boolean>, listJobs?: () => any, projectRoots?: () => string[] }} [opts]
 */
async function getEpicRecord(cwd, opts = {}) {
  try {
    const {
      id, externalRef,
      isTabBusy = () => false,
      listJobs = () => [],
      projectRoots = defaultProjectRoots,
    } = isObj(opts) ? opts : {};
    if (!isRegistered(cwd, projectRoots)) return null;

    let epicId = str(id);
    if (!epicId && str(externalRef)) {
      const hit = await findEpicByExternalRef({ cwd, externalRef });
      epicId = hit ? str(hit.epicId) : null;
    }
    if (!epicId) return null;

    const index = readActiveIndex(cwd);
    const session = openSession(index, epicId);
    const jobs = await loadJobs(listJobs);
    if (session) {
      const awaiting = await loadAwaiting(cwd);
      return await openRecord(cwd, epicId, session, index, jobs, awaiting, isTabBusy);
    }
    return archivedRecord(cwd, epicId, projectRoots, jobs);
  } catch {
    return null;
  }
}

function clampInt(v, dflt, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/**
 * A project's open (proposed/active) Epics, newest createdAt first.
 *
 * @param {string} cwd
 * @param {{ state?: string, limit?: number, offset?: number, isTabBusy?: (epicId: string) => boolean | Promise<boolean>, listJobs?: () => any, projectRoots?: () => string[] }} [opts]
 */
async function listOpenEpicRecords(cwd, opts = {}) {
  const o = isObj(opts) ? opts : {};
  const limit = o.limit == null ? DEFAULT_LIMIT : clampInt(o.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = o.offset == null ? 0 : clampInt(o.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const empty = { epics: [], total: 0, limit, offset, hasMore: false };
  try {
    const {
      state,
      isTabBusy = () => false,
      listJobs = () => [],
      projectRoots = defaultProjectRoots,
    } = o;
    if (!isRegistered(cwd, projectRoots)) return empty;

    const index = readActiveIndex(cwd);
    const open = [];
    for (const epicId of Object.keys(isObj(index.sessions) ? index.sessions : {})) {
      const s = openSession(index, epicId);
      if (s) open.push([epicId, s]);
    }
    const t = (s) => { const n = Date.parse(s.createdAt); return Number.isFinite(n) ? n : -Infinity; };
    open.sort((a, b) => t(b[1]) - t(a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

    const jobs = await loadJobs(listJobs);
    const awaiting = await loadAwaiting(cwd);
    const records = [];
    for (const [epicId, s] of open) {
      records.push(await openRecord(cwd, epicId, s, index, jobs, awaiting, isTabBusy));
    }
    const filtered = typeof state === 'string' && state ? records.filter((r) => r.state === state) : records;
    const epics = filtered.slice(offset, offset + limit);
    return { epics, total: filtered.length, limit, offset, hasMore: offset + epics.length < filtered.length };
  } catch {
    return empty;
  }
}

module.exports = { listOpenEpicRecords, getEpicRecord };
