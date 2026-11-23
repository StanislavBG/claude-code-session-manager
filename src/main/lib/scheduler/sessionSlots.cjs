/**
 * sessionSlots.cjs — the Session-Manager-owned machine-wide `claude -p`
 * concurrency pool (2026-07-31 domain-model decision; made user-configurable
 * 2026-08-01).
 *
 * Caps and limits belong to Session-Manager, not to any one consumer: the
 * scheduler and chatRunner previously each enforced a private cap (3 and 2),
 * which combined could exceed the machine's real budget — the exact shape of
 * the 2026-06-10 five-parallel-`claude -p` OOM. Now every subsystem that
 * wants to launch a `claude -p` process REQUESTS a slot here first and
 * releases it when the process settles. There is one pool, sized to the
 * machine (default 5, user-adjustable [0, 10] from the Home tab; 0 pauses new
 * launches without touching already-running processes — SM_SESSION_SLOTS
 * still overrides everything for scripted/CI use, clamped to the same
 * [0, 10] range).
 *
 * Consumers keep their own scheduling policy (FIFO lanes, batch picking,
 * memory gates); this module only answers "may one more process start right
 * now?". Plain Node, no Electron deps, process-local state (the persisted cap
 * is the one exception — a tiny standalone JSON file, not routed through any
 * other module's config store) — all consumers live in the one Electron main
 * process, which is exactly why it can be the arbiter.
 *
 * Lanes (Task primitive): every holder carries a lane — 'general' (default:
 * chat, project brief, memory assist), 'job' (scheduler PRD jobs),
 * 'task-batch' and 'task-interactive' (headless Task runs). When the
 * interactive reserve is on (setInteractiveReserve) and the cap is >= 2, one
 * slot is HELD for 'task-interactive': non-interactive acquires succeed only
 * while non-interactive holders < cap - 1. The held slot is arithmetic only —
 * never a placeholder holder. Tasks may queue with waitForSlot(); a queued
 * waiter takes precedence over 'job' acquires (they return null while any
 * waiter queues), and waiters are granted interactive-first then FIFO,
 * synchronously inside release / setCap / expireDead / setInteractiveReserve
 * before any listener fires. Precedence only ever affects NEW grants: no
 * running holder is ever revoked or signalled.
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { sessionSlotsConfigPath } = require('./schedulerPaths.cjs');
const { appendAuditEvent } = require('../telemetry/auditLog.cjs');
const atomicFs = require('../util/atomicFs.cjs');
const { isProvablyDead, DEFAULT_GRACE_MS } = require('./reservationExpiry.cjs');

const MIN_SLOTS = 0;
const MAX_SLOTS = 32;
const DEFAULT_SLOTS = 5;


function clamp(n) {
  return Math.min(MAX_SLOTS, Math.max(MIN_SLOTS, n));
}

function readPersistedCap() {
  try {
    const raw = fs.readFileSync(sessionSlotsConfigPath(), 'utf8');
    const parsed = JSON.parse(raw);
    const cap = Number(parsed.cap);
    return Number.isFinite(cap) ? clamp(Math.trunc(cap)) : DEFAULT_SLOTS;
  } catch {
    return DEFAULT_SLOTS;
  }
}

/** Persist a new cap to disk (tmp + rename). Throws on an out-of-range value. */
function setCap(cap) {
  const n = Number(cap);
  if (!Number.isFinite(n) || Math.trunc(n) !== n || n < MIN_SLOTS || n > MAX_SLOTS) {
    throw new Error(`sessionSlots.setCap: cap must be an integer in [${MIN_SLOTS}, ${MAX_SLOTS}]`);
  }
  const configPath = sessionSlotsConfigPath();
  atomicFs.writeJsonAtomicSync(configPath, { cap: n });
  notify();
  return n;
}

function totalSlots() {
  if (process.env.SM_SESSION_SLOTS !== undefined) {
    const parsed = parseInt(process.env.SM_SESSION_SLOTS, 10);
    return Number.isFinite(parsed) ? clamp(parsed) : DEFAULT_SLOTS;
  }
  return readPersistedCap();
}

const LANES = ['general', 'job', 'task-batch', 'task-interactive'];
const WAIT_LANES = ['task-batch', 'task-interactive'];
const MAX_WAITERS = 50;

function normalizeLane(lane) {
  return LANES.includes(lane) ? lane : 'general';
}

// token → { owner, at, claimedAt (ms), pid (null until stampPid), lane }
const holders = new Map();

let reserveOn = false;
// Each: { owner, lane, since (ms), seq, resolve, timer, signal, onAbort }
const waiters = [];
let waiterSeq = 0;

function reserveCount(total = totalSlots()) {
  return reserveOn && total >= 2 ? 1 : 0;
}

function nonInteractiveHolders() {
  let n = 0;
  for (const h of holders.values()) if (h.lane !== 'task-interactive') n += 1;
  return n;
}

/** How many more acquires of `lane` the pool admits now (ignores waiter precedence). */
function capacityFor(lane) {
  const total = totalSlots();
  const free = Math.max(0, total - holders.size);
  if (lane === 'task-interactive') return free;
  const budget = Math.max(0, total - reserveCount(total) - nonInteractiveHolders());
  return Math.min(free, budget);
}

function allowed(lane) {
  return capacityFor(lane) > 0;
}

function createHolder(owner, claimedAt, lane) {
  const token = crypto.randomUUID();
  holders.set(token, {
    owner: String(owner || 'unknown'),
    at: new Date(claimedAt).toISOString(),
    claimedAt,
    pid: null,
    lane,
  });
  return token;
}

function priority(lane) {
  return lane === 'task-interactive' ? 0 : 1;
}

function sortWaiters() {
  waiters.sort((a, b) => (priority(a.lane) - priority(b.lane)) || (a.since - b.since) || (a.seq - b.seq));
}

function detachWaiter(w) {
  if (w.timer) clearTimeout(w.timer);
  if (w.signal && w.onAbort) w.signal.removeEventListener('abort', w.onAbort);
  w.timer = null;
  w.onAbort = null;
}

/** Grant queued waiters (interactive first, then FIFO) while the head is admitted. */
function grantWaiters() {
  sortWaiters();
  while (waiters.length && allowed(waiters[0].lane)) {
    const w = waiters.shift();
    detachWaiter(w);
    w.resolve(createHolder(w.owner, Date.now(), w.lane));
  }
}

function notify() {
  grantWaiters();
  for (const fn of listeners) {
    try { fn(); } catch { /* a consumer's pump error is its own problem */ }
  }
}

/**
 * Turn the held interactive slot on/off (default off). Grants any waiter it unblocks.
 * An unchanged value is a no-op (no grants, no listener calls), so callers may re-sync per request.
 */
function setInteractiveReserve(on) {
  if (!!on === reserveOn) return reserveOn;
  reserveOn = !!on;
  notify();
  return reserveOn;
}

/** totalSlots() minus the held interactive slot — the most the scheduler may ever run. */
function jobCapacity() {
  const total = totalSlots();
  return Math.max(0, total - reserveCount(total));
}

/** How many acquires of `lane` would succeed right now (0 for 'job' while waiters queue). */
function availableFor(lane) {
  const l = normalizeLane(lane);
  if (l === 'job' && waiters.length > 0) return 0;
  return capacityFor(l);
}

function inUse() {
  return holders.size;
}

function available() {
  return Math.max(0, totalSlots() - holders.size);
}

/**
 * acquire(owner) → token string, or null when the pool is exhausted.
 * `owner` is a diagnostic label ("scheduler:<slug>", "chat:<tabId>") shown in
 * snapshot() so a stuck holder is attributable.
 */
function acquire(owner, { claimedAt = Date.now(), lane = 'general' } = {}) {
  const l = normalizeLane(lane);
  if (l === 'job' && waiters.length > 0) return null;
  if (!allowed(l)) return null;
  return createHolder(owner, claimedAt, l);
}

/**
 * waitForSlot(owner, { lane, timeoutMs, signal }) → Promise<token|null>.
 * Only for lanes 'task-batch' / 'task-interactive'. Resolves with a token as
 * soon as a slot is granted (immediately when one is free and no waiter of the
 * same-or-higher priority queues), or null on timeout / abort. Rejects with
 * err.code 'too_many_waiting' past MAX_WAITERS, 'bad_lane' for other lanes.
 */
function waitForSlot(owner, { lane = 'task-batch', timeoutMs = 0, signal } = {}) {
  if (!WAIT_LANES.includes(lane)) {
    const err = new Error(`sessionSlots.waitForSlot: lane must be one of ${WAIT_LANES.join(', ')}`);
    /** @type {any} */ (err).code = 'bad_lane';
    return Promise.reject(err);
  }
  if (signal && signal.aborted) return Promise.resolve(null);
  const blockedByQueue = waiters.some((w) => priority(w.lane) <= priority(lane));
  if (!blockedByQueue && allowed(lane)) {
    return Promise.resolve(createHolder(owner, Date.now(), lane));
  }
  if (waiters.length >= MAX_WAITERS) {
    const err = new Error(`sessionSlots.waitForSlot: ${MAX_WAITERS} waiters already queued`);
    /** @type {any} */ (err).code = 'too_many_waiting';
    return Promise.reject(err);
  }
  return new Promise((resolve) => {
    const w = { owner: String(owner || 'unknown'), lane, since: Date.now(), seq: waiterSeq++, resolve, timer: null, signal: signal || null, onAbort: null };
    const giveUp = () => {
      const i = waiters.indexOf(w);
      if (i === -1) return;
      waiters.splice(i, 1);
      detachWaiter(w);
      resolve(null);
    };
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) w.timer = setTimeout(giveUp, timeoutMs);
    if (signal) {
      w.onAbort = giveUp;
      signal.addEventListener('abort', giveUp, { once: true });
    }
    waiters.push(w);
    sortWaiters();
  });
}

/** stampPid(token, pid) — record the child pid once known, so expireDead can prove death by pid. */
function stampPid(token, pid) {
  const h = holders.get(token);
  if (!h || !Number.isInteger(pid) || pid <= 0) return false;
  h.pid = pid;
  return true;
}

/**
 * expireDead — release `scheduler:` reservations whose owner is provably dead
 * (see reservationExpiry.isProvablyDead). `chat:` / `project-brief:` tokens are
 * never touched. Accounting only: no process is signalled. Returns the released
 * owners. Each release is audited once (the token is gone after release).
 * @param {{ liveSlugs: Set<string>, pidAlive?: Function, now?: number, graceMs?: number }} opts
 */
function expireDead({ liveSlugs, pidAlive, now = Date.now(), graceMs = DEFAULT_GRACE_MS } = {}) {
  const live = liveSlugs instanceof Set ? liveSlugs : new Set(liveSlugs || []);
  const expired = [];
  for (const [token, h] of [...holders]) {
    if (!h.owner.startsWith('scheduler:')) continue;
    const slug = h.owner.slice('scheduler:'.length);
    if (!isProvablyDead(h, { live: live.has(slug), pidAlive, now, graceMs })) continue;
    holders.delete(token);
    expired.push(h.owner);
    appendAuditEvent('slot_reservation_expired', { owner: h.owner, pid: h.pid, claimedAt: h.at });
  }
  if (expired.length) notify();
  return expired;
}

// Release listeners: each consumer registers its own "a slot freed — try to
// start work" pump so a scheduler release wakes the chat lane and vice versa.
// Also fired when the cap itself increases (setCap), for the same reason.
const listeners = new Set();
function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** release(token) — idempotent; releasing an unknown/already-released token is a no-op. */
function release(token) {
  const had = holders.delete(token);
  if (had) notify();
  return had;
}

/** Diagnostic view for status surfaces and tests. */
function snapshot() {
  return {
    total: totalSlots(),
    inUse: holders.size,
    holders: [...holders.values()].map((h) => ({ ...h })),
    waiters: waiters.map((w) => ({ owner: w.owner, lane: w.lane, since: w.since })),
    reserve: reserveCount(),
    min: MIN_SLOTS,
    max: MAX_SLOTS,
    default: DEFAULT_SLOTS,
    envOverride: process.env.SM_SESSION_SLOTS !== undefined,
  };
}

/** Test hook: drop all held slots, queued waiters and the reserve. */
function __resetForTests() {
  holders.clear();
  for (const w of waiters.splice(0)) detachWaiter(w);
  reserveOn = false;
}

module.exports = {
  MIN_SLOTS,
  MAX_SLOTS,
  DEFAULT_SLOTS,
  LANES,
  MAX_WAITERS,
  totalSlots,
  setCap,
  inUse,
  available,
  acquire,
  waitForSlot,
  availableFor,
  jobCapacity,
  setInteractiveReserve,
  stampPid,
  expireDead,
  release,
  subscribe,
  snapshot,
  __resetForTests,
};
