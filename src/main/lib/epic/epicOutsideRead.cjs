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
 * running scheduler. Open-Epic reads (active index) skip the registration
 * check: it enumerates ~/.claude/projects (11k+ dirs, ~21 s cold). Only the
 * archive path checks it, because readArchived requires a registered project,
 * so a completed Epic in an unregistered project reads as nothing.
 */

const path = require('node:path');
const { readActiveIndex } = require('./epicMint.cjs');
const { computeEpicOutsideState, knownPrdSlugs } = require('./epicOutsideState.cjs');
const { findEpicByExternalRef } = require('./externalRefIndex.cjs');
const { awaitingInputSessions } = require('../../exchanges.cjs');
const { readArchived, defaultProjectRoots, makeRegisteredRootsCache } = require('../../promptSessionsIpc.cjs');
const { gatherEpicJobReceipt } = require('./epicJobReceipt.cjs');
const { summarizeTranscriptFile } = require('./transcriptUsage.cjs');
const { resolveEpicTranscriptPath } = require('./epicTranscriptPath.cjs');
const { StartedBySchema } = require('./scriptStartedBy.cjs');
const { isSafeEpicId } = require('../prd/prdLocations.cjs');
const fs = require('node:fs');
const { opsPath } = require('../opsOwnership.cjs');
const { readJsonOrSync } = require('../util/atomicFs.cjs');
const { parseValidatorVerdict } = require('../scheduler/validatorVerdictSchema.cjs');
const { bareSlug } = require('../prd/depSlugResolve.cjs');
const { readPlanReviewFiles } = require('../scheduler/planReviewStore.cjs');
const { splitFrontmatter, parseFixes } = require('../prd/prdFrontmatter.cjs');
const { planReviewStats } = require('../scheduler/planReviewStats.cjs');

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

const DEFAULT_ROOTS_TTL_MS = 10000;
let defaultRootsList = null;
let defaultRootsListAt = 0;

/** The registered roots, each folded to its project root and de-duplicated. */
function registeredRoots(projectRoots) {
  let raw;
  if (projectRoots === defaultProjectRoots) {
    if (!defaultRootsList || Date.now() - defaultRootsListAt >= DEFAULT_ROOTS_TTL_MS) {
      defaultRootsList = defaultProjectRoots() || [];
      defaultRootsListAt = Date.now();
    }
    raw = defaultRootsList;
  } else {
    raw = projectRoots() || [];
  }
  const { projectRootOf } = require('../activeSessions.cjs');
  const out = new Set();
  for (const r of raw) {
    if (typeof r !== 'string' || !r || !path.isAbsolute(r)) continue;
    out.add(norm(projectRootOf(r) || r));
  }
  return [...out];
}

/**
 * Which registered project holds this Epic — open in its active index, or
 * completed in its per-Epic archive. { cwd } on one match, { ambiguous: cwds }
 * on several, null on none or an unsafe id. Reads only each root's
 * prompt-sessions/ folder; never throws.
 *
 * @param {string} epicId
 * @param {{ projectRoots?: () => string[] }} [opts]
 * @returns {{ cwd: string } | { ambiguous: string[] } | null}
 */
function findEpicProject(epicId, opts = {}) {
  try {
    if (!isSafeEpicId(epicId)) return null;
    const { projectRoots = defaultProjectRoots } = isObj(opts) ? opts : {};
    const hits = [];
    for (const root of registeredRoots(projectRoots)) {
      try {
        if (openSession(readActiveIndex(root), epicId) || archivedEntry(root, epicId, projectRoots)) hits.push(root);
      } catch { /* this root holds nothing readable */ }
    }
    if (hits.length === 0) return null;
    if (hits.length === 1) return { cwd: hits[0] };
    return { ambiguous: hits.sort() };
  } catch {
    return null;
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

const atMs = (v) => (typeof v === 'string' ? Date.parse(v) : NaN);

/**
 * Checked validator verdicts for an Epic, from the scheduler's
 * plan-records/<epicId>/*.verdicts.json files ({ validator, runId, at,
 * schedulerVerdict, verdicts }). Newest `at` per bare PRD slug wins (a file
 * with no parseable `at` loses to any dated one; later file name wins a tie);
 * sorted by prd. Unreadable or invalid files are skipped; a missing folder
 * gives []. Read-only; never throws.
 *
 * @param {string} cwd
 * @param {string} epicId
 * @returns {{ prd: string, verdict: string, reason: string, criteria: any[], findings: any[], validator: string|null, at: string|null }[]}
 */
function readVerdictFiles(cwd, epicId) {
  try {
    if (!isSafeEpicId(epicId)) return [];
    const dir = opsPath(cwd, 'plan-records', epicId);
    let names;
    try { names = fs.readdirSync(dir); } catch { return []; }
    const best = new Map(); // bare -> { entry, t }
    for (const name of names.filter((n) => n.endsWith('.verdicts.json')).sort()) {
      const data = readJsonOrSync(path.join(dir, name), null);
      if (!isObj(data)) continue;
      const input = { schedulerVerdict: data.schedulerVerdict, verdicts: data.verdicts };
      if (typeof data.failReason === 'string') input.failReason = data.failReason;
      const parsed = parseValidatorVerdict(input);
      if (!parsed.ok) continue;
      const fileAt = str(data.at);
      const t = atMs(fileAt);
      for (const v of parsed.value.verdicts) {
        const bare = bareSlug(v.prd);
        const prev = best.get(bare);
        const newer = !prev
          || (Number.isFinite(t) && (!Number.isFinite(prev.t) || t >= prev.t))
          || (!Number.isFinite(t) && !Number.isFinite(prev.t));
        if (!newer) continue;
        best.set(bare, {
          t,
          entry: {
            prd: bare,
            verdict: v.verdict,
            reason: v.reason,
            criteria: v.criteria,
            findings: v.findings,
            validator: str(data.validator),
            at: fileAt,
          },
        });
      }
    }
    return [...best.values()].map((b) => b.entry).sort((a, b) => (a.prd < b.prd ? -1 : a.prd > b.prd ? 1 : 0));
  } catch {
    return [];
  }
}

/** Re-sanitize a stored startedBy; anything invalid or absent reads as null (a person pressed it). */
function startedByOf(raw) {
  if (raw == null) return null;
  const r = StartedBySchema.safeParse(raw);
  return r.success ? r.data : null;
}

let MAX_FIX_FILES = 2000;
let MAX_FIX_CACHE = 5000;
/** Test seam: override the per-call file cap and the total cache bound. */
function _setFixesCapsForTests(files, cache) {
  MAX_FIX_FILES = files == null ? 2000 : files;
  MAX_FIX_CACHE = cache == null ? 5000 : cache;
}
/** Leading PRD number of a file name; -1 when it has none. */
function prdNN(name) {
  const m = /^(\d+)/.exec(name);
  return m ? Number(m[1]) : -1;
}
/** abs path -> { mtimeMs, size, fixes } — a repeat read re-parses only files whose stat changed. */
const fixesCache = new Map();

/** fixes[] ({ prd, missKind }) from this Epic's PRD files (prds/ and prds-archived/); [] on any failure. At most MAX_FIX_FILES files per call (the newest by name are kept). */
function readEpicFixes(cwd, epicId) {
  const out = [];
  try {
    if (!isSafeEpicId(epicId)) return out;
    const base = path.join(opsPath(cwd, 'scheduler', 'epics'), epicId);
    let files = [];
    for (const sub of ['prds', 'prds-archived']) {
      let names;
      try { names = fs.readdirSync(path.join(base, sub)); } catch { continue; }
      for (const n of names) if (n.endsWith('.md')) files.push({ n, p: path.join(base, sub, n) });
    }
    files.sort((x, y) => prdNN(x.n) - prdNN(y.n) || (x.n < y.n ? -1 : x.n > y.n ? 1 : x.p < y.p ? -1 : x.p > y.p ? 1 : 0));
    files = files.map((f) => f.p);
    if (files.length > MAX_FIX_FILES) files = files.slice(-MAX_FIX_FILES);
    const seen = new Set(files);
    for (const file of files) {
      try {
        const st = fs.statSync(file);
        let hit = fixesCache.get(file);
        if (!hit || hit.mtimeMs !== st.mtimeMs || hit.size !== st.size) {
          const { fm } = splitFrontmatter(fs.readFileSync(file, 'utf8'));
          const list = typeof fm.fixes === 'string' ? parseFixes(fm.fixes) : null;
          hit = { mtimeMs: st.mtimeMs, size: st.size, fixes: (list || []).map((f) => ({ prd: f.prd, missKind: f.missKind })) };
          fixesCache.set(file, hit);
          while (fixesCache.size > MAX_FIX_CACHE) fixesCache.delete(fixesCache.keys().next().value);
        }
        for (const f of hit.fixes) out.push({ prd: f.prd, missKind: f.missKind });
      } catch { fixesCache.delete(file); /* skip unreadable or deleted PRD */ }
    }
    // Drop deleted/out-of-scope files of this Epic from the cache.
    const prefix = base + path.sep;
    for (const k of fixesCache.keys()) if (k.startsWith(prefix) && !seen.has(k)) fixesCache.delete(k);
  } catch { /* none */ }
  return out;
}

function buildRecord(cwd, epicId, session, events, jobs, needsInput, chatBusy) {
  const computed = computeEpicOutsideState({ session: { ...session, id: epicId }, events, jobs, needsInput, chatBusy });
  const source = isObj(session.source) ? session.source : {};
  const { title, goal } = splitGoal(session.goalText);
  const verdicts = readVerdictFiles(cwd, epicId);
  const planReviews = readPlanReviewFiles(cwd, epicId);
  return {
    epicId,
    cwd: str(session.cwd) || cwd,
    title,
    goal,
    tag: str(session.tag),
    agentType: str(session.agentType),
    status: str(session.status),
    state: computed.state,
    phase: computed.phase,
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
      startedBy: startedByOf(source.startedBy),
    },
    createdAt: str(session.createdAt),
    completedAt: str(session.completedAt),
    verdicts,
    planReviews,
    planReviewStats: planReviewStats({ planReviews, verdictFiles: verdicts, fixes: readEpicFixes(cwd, epicId) }),
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

/** The archived (completed) session + its events, or null (also for an unregistered project). */
function archivedEntry(cwd, epicId, projectRoots) {
  try {
    if (!isRegistered(cwd, projectRoots)) return null;
    const res = readArchived(cwd, epicId, { projectRoots });
    const data = res && res.exists ? res.data : null;
    if (!isObj(data) || !str(data.archivedAt) || !isObj(data.session)) return null;
    return {
      session: { ...data.session, status: 'completed' },
      events: Array.isArray(data.events) ? data.events : [],
    };
  } catch {
    return null;
  }
}

/**
 * Job-run cost for every PRD the Epic is known to have (live rows + check-ins
 * on its chain, so finished PRDs whose rows are gone still count) since the
 * session was created; null on failure.
 */
async function jobsReceipt(cwd, epicId, session, events, jobs, runsRoot) {
  try {
    const slugs = knownPrdSlugs({ session: { ...session, id: epicId }, events, jobs });
    const created = Date.parse(session.createdAt);
    return await gatherEpicJobReceipt({
      cwd,
      slugs,
      sinceMs: Number.isFinite(created) ? created : undefined,
      runsRoot,
    });
  } catch {
    return null;
  }
}

/** Token usage of the Epic's chat transcript; null when no file is found or on failure. */
async function chatReceipt(cwd, session, resolveTranscriptPath) {
  try {
    const claudeSessionId = str(session.claudeSessionId);
    if (!claudeSessionId) return null;
    const hit = resolveTranscriptPath({ cwd, claudeSessionId });
    // The real resolver hands back its first candidate even when nothing exists.
    if (!isObj(hit) || !str(hit.path) || hit.existsAnywhere === false) return null;
    return await summarizeTranscriptFile(hit.path);
  } catch {
    return null;
  }
}

async function buildReceipt(cwd, epicId, session, events, jobs, runsRoot, resolveTranscriptPath) {
  const [jobsPart, chatPart] = await Promise.all([
    jobsReceipt(cwd, epicId, session, events, jobs, runsRoot),
    chatReceipt(cwd, session, resolveTranscriptPath),
  ]);
  return { jobs: jobsPart, chat: chatPart };
}

/**
 * One Epic by id or externalRef: open from the active index, else completed
 * from its archive file (only when archivedAt is set). Null on no match.
 *
 * `receipt: true` adds `receipt: { jobs, chat }` — jobs = gatherEpicJobReceipt
 * over the Epic's known PRD slugs (knownPrdSlugs) since createdAt, chat = summarizeTranscriptFile of
 * the resolved transcript (null when none). Each part is null on failure.
 * Without it no run folder or transcript is read. `runsRoot` and
 * `resolveTranscriptPath` are injectable for tests.
 *
 * @param {string} cwd
 * @param {{ id?: string, externalRef?: string, receipt?: boolean, isTabBusy?: (epicId: string) => boolean | Promise<boolean>, listJobs?: () => any, projectRoots?: () => string[], runsRoot?: string, resolveTranscriptPath?: (a: { cwd: string, claudeSessionId: string }) => any }} [opts]
 */
async function getEpicRecord(cwd, opts = {}) {
  try {
    const {
      id, externalRef, receipt,
      isTabBusy = () => false,
      listJobs = () => [],
      projectRoots = defaultProjectRoots,
      runsRoot,
      resolveTranscriptPath = resolveEpicTranscriptPath,
    } = isObj(opts) ? opts : {};
    if (typeof cwd !== 'string' || !cwd || !path.isAbsolute(cwd)) return null;

    let epicId = str(id);
    if (!epicId && str(externalRef)) {
      const hit = await findEpicByExternalRef({ cwd, externalRef });
      epicId = hit ? str(hit.epicId) : null;
    }
    if (!epicId) return null;

    const index = readActiveIndex(cwd);
    const open = openSession(index, epicId);
    const jobs = await loadJobs(listJobs);
    let session;
    let events;
    let record;
    if (open) {
      session = open;
      events = eventsOf(index, epicId);
      const awaiting = await loadAwaiting(cwd);
      record = await openRecord(cwd, epicId, open, index, jobs, awaiting, isTabBusy);
    } else {
      const archived = archivedEntry(cwd, epicId, projectRoots);
      if (!archived) return null;
      session = archived.session;
      events = archived.events;
      record = buildRecord(cwd, epicId, session, archived.events, jobs, false, false);
    }
    if (receipt !== true) return record;
    return { ...record, receipt: await buildReceipt(cwd, epicId, session, events, jobs, runsRoot, resolveTranscriptPath) };
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
    } = o;
    if (typeof cwd !== 'string' || !cwd || !path.isAbsolute(cwd)) return empty;

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

module.exports = { readEpicFixes, _setFixesCapsForTests, _fixesCacheSizeForTests: () => fixesCache.size, get MAX_FIX_FILES() { return MAX_FIX_FILES; }, get MAX_FIX_CACHE() { return MAX_FIX_CACHE; }, readVerdictFiles, listOpenEpicRecords, getEpicRecord, findEpicProject };
