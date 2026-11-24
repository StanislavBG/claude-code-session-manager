'use strict';

/**
 * epicStateEmitter.cjs — event-driven Epic outside-state changes.
 *
 * Replaces the deleted tick watcher (epicStateWatcher.cjs, removed in
 * 909f6e47). pokeEpicState(cwd, epicId) debounces per Epic, then recomputes
 * the Epic's outside state through the same epicOutsideRead.getEpicRecord that
 * GET /admin/epic uses, and appends one `epic.state_changed` event
 *   { kind, from, to, blockedKind?, externalRef? }
 * to the Epic's own event log whenever (to, blockedKind) differs from the last
 * recorded one. The last state is recovered from that log on first use, so a
 * restart never repeats a row.
 *
 * Lifecycle shortcuts: lifecycleTo 'completed' → 'closed', 'proposed' →
 * 'awaiting_approval' (no recompute). lifecycleTo 'active' retries while the
 * record still reads another status (at most MAX_ACTIVE_RETRIES). A null
 * record → 'gone', only when a last state is set and is not closed/gone.
 *
 * At most one recompute per Epic runs at a time; a poke during one schedules
 * exactly one more. Nothing here throws or rejects.
 *
 * startEpicStateEmitter() subscribes to epicEventLog appends and pokes for
 * POKE_KINDS (never for epic.state_changed itself).
 */

const epicEventLog = require('./epicEventLog.cjs');
const { EPIC_OUTSIDE_STATES } = require('./epicOutsideState.cjs');

const KIND = 'epic.state_changed';
const EPIC_STATE_CHANGED_TO = Object.freeze([...EPIC_OUTSIDE_STATES, 'gone']);
const TO_SET = new Set(EPIC_STATE_CHANGED_TO);
const MAX_ACTIVE_RETRIES = 5;
const RECOVER_PAGE = 1000;
const RECOVER_MAX_PAGES = 50;
const POKE_KINDS = new Set([
  'epic.minted',
  'epic.status_changed',
  'job.queued',
  'job.status_changed',
  'job.needs_input',
  'human.answer',
  'human.message',
  'external.message',
  'validator.verdict',
  'outcome.recorded',
]);

const DEFAULT_OPTS = () => ({
  isTabBusy: () => false,
  listJobs: () => [],
  projectRoots: undefined,
  debounceMs: 1000,
});

/** @type {{ isTabBusy: (epicId: string) => boolean | Promise<boolean>, listJobs: () => any, projectRoots: undefined | (() => string[]), debounceMs: number }} */
let opts = DEFAULT_OPTS();
/** key → debounce timeout */
const timers = new Map();
/** key → in-flight recompute promise */
const running = new Map();
/** keys poked while their recompute ran */
const again = new Set();
/** key → { cwd, epicId, lifecycleTo, attempt } waiting for its timer */
const pending = new Map();
/** key → { state, blockedKind, externalRef } | null */
const last = new Map();
let unsubscribe = null;

const keyOf = (cwd, epicId) => `${cwd}\0${epicId}`;
const str = (v) => (typeof v === 'string' && v !== '' ? v : null);
const msg = (e) => (e && e.message ? e.message : String(e));

/** @param {{ isTabBusy?: Function, listJobs?: Function, projectRoots?: Function, debounceMs?: number }} [o] */
function configureEpicStateEmitter(o = {}) {
  if (!o || typeof o !== 'object') return;
  if (typeof o.isTabBusy === 'function') opts.isTabBusy = /** @type {any} */ (o.isTabBusy);
  if (typeof o.listJobs === 'function') opts.listJobs = /** @type {any} */ (o.listJobs);
  if ('projectRoots' in o) opts.projectRoots = typeof o.projectRoots === 'function' ? /** @type {any} */ (o.projectRoots) : undefined;
  if (Number.isFinite(o.debounceMs) && /** @type {number} */ (o.debounceMs) >= 0) opts.debounceMs = /** @type {number} */ (o.debounceMs);
}

/** The newest epic.state_changed in the Epic's log, or null. */
async function recoverLast(cwd, epicId) {
  let after = 0;
  let newest = null;
  for (let page = 0; page < RECOVER_MAX_PAGES; page++) {
    const res = await epicEventLog.readEpicEvents(cwd, epicId, { kinds: [KIND], after, limit: RECOVER_PAGE });
    if (res.events.length) newest = res.events[res.events.length - 1];
    if (!res.hasMore) break;
    after = res.cursor;
  }
  if (!newest) return null;
  return { state: str(newest.to), blockedKind: str(newest.blockedKind), externalRef: str(newest.externalRef) };
}

function arm(key, delay = opts.debounceMs) {
  const t = timers.get(key);
  if (t) clearTimeout(t);
  const h = setTimeout(() => {
    timers.delete(key);
    fire(key);
  }, delay);
  if (h && typeof h.unref === 'function') h.unref();
  timers.set(key, h);
}

function fire(key) {
  if (running.has(key)) {
    again.add(key);
    return;
  }
  const p = pending.get(key);
  if (!p) return;
  pending.delete(key);
  const prom = recompute(p).catch((e) => {
    console.error('[epicStateEmitter] recompute failed', p.epicId, msg(e));
  }).finally(() => {
    running.delete(key);
    if (again.delete(key)) fire(key);
  });
  running.set(key, prom);
}

/**
 * pokeEpicState(cwd, epicId, { lifecycleTo? }) — schedule a debounced
 * recompute of this Epic's outside state. Never throws.
 */
function pokeEpicState(cwd, epicId, o = {}) {
  try {
    if (typeof cwd !== 'string' || !cwd || typeof epicId !== 'string' || !epicId) return;
    const key = keyOf(cwd, epicId);
    const p = pending.get(key) || { cwd, epicId, lifecycleTo: undefined, attempt: 0 };
    const lt = o && typeof o === 'object' ? str(o.lifecycleTo) : null;
    if (lt) p.lifecycleTo = lt;
    p.attempt = 0;
    pending.set(key, p);
    arm(key);
  } catch (e) {
    console.error('[epicStateEmitter] poke failed', epicId, msg(e));
  }
}

function scheduleRetry(key, cwd, epicId, attempt) {
  const p = pending.get(key);
  if (p) {
    if (!p.lifecycleTo) p.lifecycleTo = 'active';
  } else {
    pending.set(key, { cwd, epicId, lifecycleTo: 'active', attempt });
  }
  arm(key);
}

async function recompute({ cwd, epicId, lifecycleTo, attempt }) {
  const key = keyOf(cwd, epicId);
  try {
    if (!last.has(key)) last.set(key, await recoverLast(cwd, epicId));
    const prev = last.get(key) || null;

    /** @type {{ state: string|null, blockedKind: string|null, externalRef: string|null } | null} */
    let next = null;
    if (lifecycleTo === 'completed') {
      next = { state: 'closed', blockedKind: null, externalRef: prev ? prev.externalRef : null };
    } else if (lifecycleTo === 'proposed') {
      next = { state: 'awaiting_approval', blockedKind: null, externalRef: prev ? prev.externalRef : null };
    } else {
      const outsideRead = require('./epicOutsideRead.cjs'); // lazy: pulls in promptSessionsIpc
      const readOpts = { id: epicId, isTabBusy: opts.isTabBusy, listJobs: opts.listJobs };
      if (opts.projectRoots) readOpts.projectRoots = opts.projectRoots;
      const rec = await outsideRead.getEpicRecord(cwd, readOpts);
      if (!rec) {
        if (!prev || !prev.state || prev.state === 'closed' || prev.state === 'gone') return;
        next = { state: 'gone', blockedKind: null, externalRef: prev.externalRef };
      } else {
        if (lifecycleTo === 'active' && rec.status !== 'active' && attempt < MAX_ACTIVE_RETRIES) {
          scheduleRetry(key, cwd, epicId, attempt + 1);
          return;
        }
        const state = str(rec.state);
        next = {
          state,
          blockedKind: state === 'blocked' ? str(rec.blocked && rec.blocked.kind) : null,
          externalRef: str(rec.externalRef),
        };
      }
    }

    if (!next.state || !TO_SET.has(next.state)) {
      console.error('[epicStateEmitter] dropped unknown state', cwd, epicId, next.state);
      return;
    }
    if (prev && prev.state === next.state && (prev.blockedKind || null) === (next.blockedKind || null)) return;

    /** @type {Record<string, unknown>} */
    const event = { kind: KIND, from: prev ? prev.state : null, to: next.state };
    if (next.blockedKind) event.blockedKind = next.blockedKind;
    if (next.externalRef) event.externalRef = next.externalRef;
    await epicEventLog.appendEpicEvent(cwd, epicId, event);
    last.set(key, next);
  } catch (e) {
    console.error('[epicStateEmitter] recompute failed', epicId, msg(e));
  }
}

function onAppended(cwd, record) {
  if (!record || !POKE_KINDS.has(record.kind)) return;
  const epicId = str(record.epicId);
  if (!epicId) return;
  pokeEpicState(cwd, epicId, record.kind === 'epic.status_changed' ? { lifecycleTo: record.to } : {});
}

/** Subscribe to event-log appends (idempotent). Returns an unsubscribe function. */
function startEpicStateEmitter() {
  if (!unsubscribe) unsubscribe = epicEventLog.onEpicEventAppended(onAppended);
  return () => {
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
  };
}

/** Test helper: resolve once no timer or recompute is left. */
async function _settleForTests() {
  for (let i = 0; i < 1000 && (timers.size || running.size || pending.size); i++) {
    if (running.size) await Promise.all([...running.values()]);
    else await new Promise((r) => setTimeout(r, Math.min(opts.debounceMs, 50) + 1));
  }
}

function _resetForTests() {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  running.clear();
  again.clear();
  pending.clear();
  last.clear();
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  opts = DEFAULT_OPTS();
}

module.exports = {
  EPIC_STATE_CHANGED_TO,
  configureEpicStateEmitter,
  pokeEpicState,
  startEpicStateEmitter,
  _settleForTests,
  _resetForTests,
};
