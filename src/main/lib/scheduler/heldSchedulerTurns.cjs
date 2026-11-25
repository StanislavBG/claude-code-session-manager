'use strict';

/**
 * heldSchedulerTurns.cjs — the one place that decides whether a scheduler-started
 * chat turn (origin 'scheduler': PLAN SETTLED digests, job notices, auto-start
 * follow-ups) may start under the usage hold, and that keeps every held message
 * durably until the hold ends.
 *
 * Store: schedulerPaths.heldSchedulerTurnsPath() — { version: 1, entries: [] }.
 * Each entry: { id, tabId, kind, prompt, sessionId, cwd, heldAt, holdReason, holdDetail, lastAttempt? }.
 *
 * An 'unconfirmed' send that carries a requestId (the renderer ack timed out) stamps
 * its entries with lastAttempt { requestId, at } and drain skips them for
 * LAST_ATTEMPT_GRACE_MS: the renderer may still have run the turn. A late ack
 * (chatRunner → confirmLateDelivery(requestId)) removes them; no ack → resent once
 * after the grace.
 *
 * drain() delivers each tab's held messages ONCE, oldest first, as one coalesced
 * prompt; entries are removed only after the send resolved a disposition that
 * produced (or queued) a run.
 *
 * Must NOT require chatRunner.cjs or scheduler.cjs — both require this module.
 * No audit writes here: callers audit drain()'s return value.
 */

const crypto = require('node:crypto');
const { writeJsonAtomicSync, readJsonOrSync } = require('../util/atomicFs.cjs');
const { heldSchedulerTurnsPath } = require('./schedulerPaths.cjs');

const KINDS = Object.freeze(['settle-digest', 'job-notice', 'auto-start-follow-up', 'scheduler-notice']);
// 'held': the hold returned between the drain check and the send. The batch is not
// re-deferred (heldBatch), so the originals must stay or they are lost.
const NOT_ACCEPTED = new Set(['refused', 'unconfirmed', 'held']);
const LAST_ATTEMPT_GRACE_MS = 10 * 60 * 1000;

/** @type {null | (() => any)} */
let holdProvider = null;
/** @type {null | Promise<Array<{ tabId: string, delivered: number, dropped: number }>>} */
let draining = null;

function setHoldProvider(fn) {
  holdProvider = typeof fn === 'function' ? fn : null;
}

/** The current usage hold object, or null (no provider, provider throws, or no hold). */
function currentHold() {
  if (!holdProvider) return null;
  try {
    const hold = holdProvider();
    return hold && typeof hold === 'object' ? hold : null;
  } catch {
    return null;
  }
}

function isEntry(e) {
  return !!e && typeof e === 'object' && typeof e.id === 'string'
    && typeof e.tabId === 'string' && typeof e.prompt === 'string';
}

function readEntries() {
  let file;
  try { file = readJsonOrSync(heldSchedulerTurnsPath(), null); } catch { return []; }
  if (!file || typeof file !== 'object' || !Array.isArray(file.entries)) return [];
  return file.entries.filter(isEntry);
}

function writeEntries(entries) {
  writeJsonAtomicSync(heldSchedulerTurnsPath(), { version: 1, entries });
}

/**
 * Keep one scheduler message for later. The same tabId+kind+prompt already held
 * is not stored twice (the existing entry is returned).
 */
function defer({ tabId, prompt, kind, sessionId, cwd, hold } = /** @type {any} */ ({})) {
  if (typeof tabId !== 'string' || !tabId) throw new TypeError('defer: tabId required');
  if (typeof prompt !== 'string' || !prompt) throw new TypeError('defer: prompt required');
  const k = KINDS.includes(kind) ? kind : 'scheduler-notice';
  const entries = readEntries();
  const existing = entries.find((e) => e.tabId === tabId && e.kind === k && e.prompt === prompt);
  if (existing) return existing;
  const entry = {
    id: crypto.randomUUID(),
    tabId,
    kind: k,
    prompt,
    sessionId: typeof sessionId === 'string' && sessionId ? sessionId : null,
    cwd: typeof cwd === 'string' && cwd ? cwd : null,
    heldAt: new Date().toISOString(),
    holdReason: hold && typeof hold.reason === 'string' ? hold.reason : null,
    holdDetail: hold && typeof hold.detail === 'string' ? hold.detail : null,
  };
  entries.push(entry);
  writeEntries(entries);
  return entry;
}

function summary() {
  const entries = readEntries();
  return { count: entries.length, tabs: new Set(entries.map((e) => e.tabId)).size };
}

function byHeldAt(a, b) {
  const ta = Date.parse(a.heldAt) || 0;
  const tb = Date.parse(b.heldAt) || 0;
  return ta - tb;
}

function buildCoalescedPrompt(entries) {
  const list = [...entries].sort(byHeldAt);
  const n = list.length;
  const parts = [
    `The usage hold kept ${n} scheduler message(s) for this session while automatic work was paused. They are delivered now, oldest first.`,
  ];
  list.forEach((e, i) => { parts.push(`--- ${i + 1} of ${n} ---\n${e.prompt}`); });
  return parts.join('\n\n');
}

/** True while an entry's last unconfirmed attempt may still be acked late. */
function inAttemptGrace(e, now) {
  const a = e.lastAttempt;
  if (!a || typeof a !== 'object' || typeof a.requestId !== 'string') return false;
  const at = Date.parse(a.at);
  return Number.isFinite(at) && now - at < LAST_ATTEMPT_GRACE_MS;
}

/** Stamp the given entry ids with lastAttempt (one atomic write). */
function stampAttempt(ids, requestId) {
  const at = new Date().toISOString();
  const entries = readEntries();
  let changed = false;
  for (const e of entries) {
    if (ids.has(e.id)) { e.lastAttempt = { requestId, at }; changed = true; }
  }
  if (changed) writeEntries(entries);
}

/**
 * The renderer acked a timed-out send late (a run was produced): remove exactly
 * the entries stamped with that requestId, in one atomic write. Returns the count.
 */
function confirmLateDelivery(requestId) {
  if (typeof requestId !== 'string' || !requestId) return 0;
  const entries = readEntries();
  const left = entries.filter((e) => !(e.lastAttempt && e.lastAttempt.requestId === requestId));
  const removed = entries.length - left.length;
  if (removed > 0) writeEntries(left);
  return removed;
}

async function drainOnce({ send, isStillNeeded }) {
  const now = Date.now();
  const entries = readEntries().filter((e) => !inAttemptGrace(e, now));
  if (entries.length === 0) return [];
  /** @type {Map<string, any[]>} */
  const groups = new Map();
  for (const e of [...entries].sort(byHeldAt)) {
    if (!groups.has(e.tabId)) groups.set(e.tabId, []);
    groups.get(e.tabId).push(e);
  }
  const remove = new Set();
  const results = [];
  for (const [tabId, group] of groups) {
    const keep = [];
    let dropped = 0;
    for (const e of group) {
      let needed = true;
      if (typeof isStillNeeded === 'function') {
        try { needed = (await isStillNeeded(e)) !== false; } catch { needed = true; }
      }
      if (needed) keep.push(e);
      else { dropped += 1; remove.add(e.id); }
    }
    let delivered = 0;
    if (keep.length > 0) {
      const head = keep.find((e) => e.sessionId) ?? keep[0];
      const withCwd = keep.find((e) => e.cwd) ?? keep[0];
      let disposition = 'unconfirmed';
      let requestId = null;
      try {
        const res = await send(tabId, buildCoalescedPrompt(keep), {
          origin: 'scheduler',
          heldBatch: true,
          sessionId: head.sessionId ?? undefined,
          cwd: withCwd.cwd ?? undefined,
        });
        disposition = res && typeof res.disposition === 'string' ? res.disposition : 'unconfirmed';
        requestId = res && typeof res.requestId === 'string' && res.requestId ? res.requestId : null;
      } catch {
        disposition = 'unconfirmed';
      }
      // Stamp right away (synchronously after the send resolved) so a late ack
      // arriving while other tabs are still sending finds its entries.
      if (disposition === 'unconfirmed' && requestId) {
        stampAttempt(new Set(keep.map((e) => e.id)), requestId);
      }
      if (!NOT_ACCEPTED.has(disposition)) {
        delivered = keep.length;
        for (const e of keep) remove.add(e.id);
      }
    }
    results.push({ tabId, delivered, dropped });
  }
  if (remove.size > 0) {
    // Re-read: entries deferred while sends were in flight are kept.
    writeEntries(readEntries().filter((e) => !remove.has(e.id)));
  }
  return results;
}

/**
 * Deliver every tab's held messages once. Single-flight: a call while a drain
 * runs returns that drain's promise.
 * @param {{ send: (tabId: string, prompt: string, extra: object) => Promise<{ disposition: string }>, isStillNeeded?: (entry: any) => boolean | Promise<boolean> }} opts
 */
function drain(opts) {
  if (draining) return draining;
  if (!opts || typeof opts.send !== 'function') return Promise.resolve([]);
  draining = drainOnce(opts).finally(() => { draining = null; });
  return draining;
}

module.exports = {
  KINDS,
  setHoldProvider,
  currentHold,
  defer,
  summary,
  buildCoalescedPrompt,
  drain,
  confirmLateDelivery,
  LAST_ATTEMPT_GRACE_MS,
};
