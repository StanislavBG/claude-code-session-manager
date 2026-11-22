'use strict';

/**
 * epicStateWatcher.cjs — turns "outside apps poll for Epic state" into events.
 *
 * runEpicStateWatch({ cwds, jobs }) reads every open Epic of each cwd through
 * epicOutsideRead.listOpenEpicRecords, compares each record's outside-facing
 * state with the snapshot at schedulerPaths.epicStateSnapshotPath(), appends
 * one `epic_state_changed` audit row per change, then rewrites the snapshot.
 *
 * Snapshot: { version: 1, epics: { "<cwd>\0<epicId>": { state, blockedKind, externalRef, at } } }.
 * No snapshot file → the run seeds it and emits nothing. Entries of cwds not in
 * the call, and of a cwd whose read threw, are kept as they are. Never rejects;
 * concurrent calls share one in-flight promise. Not scheduled here — the
 * scheduler tick calls it.
 */

const outsideRead = require('./epicOutsideRead.cjs');
const { appendAuditEvent } = require('../telemetry/auditLog.cjs');
const { epicStateSnapshotPath } = require('../scheduler/schedulerPaths.cjs');
const { writeJsonAtomic, readJsonOr } = require('../util/atomicFs.cjs');

const SNAPSHOT_VERSION = 1;
const PAGE_LIMIT = 200;
const SEP = '\0';

let isTabBusy = () => false;
/** Test seam: registered-project list passed to the reader; undefined = the reader's default. */
let projectRoots;
let inflight = null;

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' && v !== '' ? v : null);

/** @param {{ isTabBusy?: (epicId: string) => boolean | Promise<boolean>, projectRoots?: () => string[] }} [opts] */
function configureEpicStateWatcher(opts = {}) {
  const o = isObj(opts) ? opts : {};
  isTabBusy = typeof o.isTabBusy === 'function' ? o.isTabBusy : () => false;
  projectRoots = typeof o.projectRoots === 'function' ? o.projectRoots : undefined;
}

function readerOpts(jobs, extra) {
  const o = { isTabBusy, listJobs: () => jobs, ...extra };
  if (projectRoots) o.projectRoots = projectRoots;
  return o;
}

/** Every open record of one cwd, paging until hasMore is false. Throws on a reader failure. */
async function readAllOpen(cwd, jobs) {
  const out = [];
  let offset = 0;
  for (;;) {
    const page = await outsideRead.listOpenEpicRecords(cwd, readerOpts(jobs, { limit: PAGE_LIMIT, offset }));
    const epics = isObj(page) && Array.isArray(page.epics) ? page.epics : [];
    out.push(...epics);
    if (!page || !page.hasMore || epics.length === 0) return out;
    offset += epics.length;
  }
}

function entryOf(rec, at) {
  return {
    state: str(rec.state),
    blockedKind: isObj(rec.blocked) ? str(rec.blocked.kind) : null,
    externalRef: str(rec.externalRef),
    at,
  };
}

function change(cwd, epicId, from, to, blockedKind, externalRef) {
  const row = { cwd, epicId, from, to };
  if (blockedKind) row.blockedKind = blockedKind;
  if (externalRef) row.externalRef = externalRef;
  return row;
}

async function closedOrGone(cwd, epicId, jobs) {
  try {
    const rec = await outsideRead.getEpicRecord(cwd, readerOpts(jobs, { id: epicId }));
    return rec && rec.status === 'completed' ? 'closed' : 'gone';
  } catch {
    return 'gone';
  }
}

async function watchOnce({ cwds, jobs } = {}) {
  const changes = [];
  try {
    const cwdList = Array.isArray(cwds) ? [...new Set(cwds.filter((c) => typeof c === 'string' && c))] : [];
    const jobList = Array.isArray(jobs) ? jobs : [];
    const file = epicStateSnapshotPath();
    const prev = await readJsonOr(file, null);
    const seeding = !isObj(prev) || !isObj(prev.epics);
    const prevEpics = seeding ? {} : prev.epics;
    const next = { ...prevEpics };
    const now = new Date().toISOString();

    for (const cwd of cwdList) {
      let records;
      try {
        records = await readAllOpen(cwd, jobList);
      } catch (e) {
        console.error('[epicStateWatcher] read failed, skipping', cwd, e?.message ?? String(e));
        continue;
      }
      const prefix = `${cwd}${SEP}`;
      const seen = new Set();
      for (const rec of records) {
        const epicId = isObj(rec) ? str(rec.epicId) : null;
        if (!epicId) continue;
        const key = `${prefix}${epicId}`;
        seen.add(key);
        const old = isObj(prevEpics[key]) ? prevEpics[key] : null;
        const cur = entryOf(rec, now);
        if (!old) {
          if (!seeding) changes.push(change(cwd, epicId, null, cur.state, cur.blockedKind, cur.externalRef));
          next[key] = cur;
        } else if (old.state !== cur.state || (old.blockedKind ?? null) !== cur.blockedKind) {
          changes.push(change(cwd, epicId, str(old.state), cur.state, cur.blockedKind, cur.externalRef));
          next[key] = cur;
        } else {
          next[key] = { ...cur, at: str(old.at) || now };
        }
      }
      for (const key of Object.keys(prevEpics)) {
        if (!key.startsWith(prefix) || seen.has(key)) continue;
        const epicId = key.slice(prefix.length);
        const old = isObj(prevEpics[key]) ? prevEpics[key] : {};
        const to = await closedOrGone(cwd, epicId, jobList);
        changes.push(change(cwd, epicId, str(old.state), to, null, str(old.externalRef)));
        delete next[key];
      }
    }

    for (const row of changes) appendAuditEvent('epic_state_changed', row);
    try {
      await writeJsonAtomic(file, { version: SNAPSHOT_VERSION, epics: next });
    } catch (e) {
      console.error('[epicStateWatcher] snapshot write failed', e?.message ?? String(e));
    }
  } catch (e) {
    console.error('[epicStateWatcher] watch failed', e?.message ?? String(e));
  }
  return changes;
}

/**
 * @param {{ cwds: string[], jobs: any[] }} args
 * @returns {Promise<Array<{ cwd: string, epicId: string, from: string|null, to: string|null, blockedKind?: string, externalRef?: string }>>}
 */
function runEpicStateWatch(args) {
  if (inflight) return inflight;
  inflight = watchOnce(args).finally(() => { inflight = null; });
  return inflight;
}

module.exports = { configureEpicStateWatcher, runEpicStateWatch };
