'use strict';

/**
 * epicTransitions.cjs — the ONE place an Epic's `status` changes after mint.
 * Mint (birth as `proposed`) stays in epicMint.cjs; every later edge
 * (complete, discard, reopen) goes through `transitionEpic` here.
 *
 * The status law itself lives in
 * session-manager-operations/prompt-sessions/README.md#lifecycle — link it,
 * never restate it. This module only encodes its edges as a table.
 *
 * Semantics copy lib/scheduler/scheduleJobTransitions.cjs's transitionJob:
 *  - identity (status unchanged) is a no-op success, nothing recorded;
 *  - a legal edge mutates `epic.status`, writes an `epic_transition` audit
 *    record and appends `epic.status_changed` to the Epic's event log
 *    (fire-and-forget — a log failure never blocks the transition);
 *  - an illegal edge is refused: the Epic is left untouched, an
 *    `epic_transition_refused` audit record is written, and false is
 *    returned. Under test (NODE_ENV=test or VITEST set) it throws instead, so
 *    a call site asking for an illegal edge fails its own test loudly.
 *
 * Plain Node module (no Electron deps), like epicMint.cjs.
 */

const auditLog = require('../telemetry/auditLog.cjs');
// Module objects (not destructured) so tests can stub the audit + event emits.
const epicEventLog = require('./epicEventLog.cjs');
const opsErrorLog = require('../telemetry/opsErrorLog.cjs');

/**
 * Explicit from->to edges (see the README link above for what each means).
 * proposed->completed is Discard on a proposal, which the lifecycle law lists
 * as entering `completed` alongside markCompleted.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
const EPIC_LEGAL_TRANSITIONS = Object.freeze({
  proposed: Object.freeze(['active', 'completed']),
  active: Object.freeze(['completed']),
  completed: Object.freeze(['active']),
});

let refusedTransitionCount = 0;

function isTestEnv() {
  return process.env.NODE_ENV === 'test' || !!process.env.VITEST;
}

/**
 * @param {string|null|undefined} from
 * @param {string|null|undefined} to
 */
function isLegalEpicTransition(from, to) {
  if (from === to && typeof from === 'string' && from in EPIC_LEGAL_TRANSITIONS) return true;
  if (typeof from !== 'string' || typeof to !== 'string') return false;
  const edges = EPIC_LEGAL_TRANSITIONS[from];
  return Array.isArray(edges) && edges.includes(to);
}

/**
 * @param {string} cwd
 * @param {string} epicId
 * @param {Record<string, unknown>} event
 */
function emitEpicEvent(cwd, epicId, event) {
  /** @param {unknown} err */
  const onError = (err) => {
    try {
      opsErrorLog.appendError({
        cwd,
        scope: 'epic',
        level: 'error',
        epicId,
        message: `epic event append failed (${String(event.kind)}): ${err instanceof Error ? err.message : String(err)}`,
        meta: { kind: event.kind ?? null },
      });
    } catch { /* logging must never be the thing that fails */ }
  };
  try {
    const p = epicEventLog.appendEpicEvent(cwd, epicId, event);
    if (p && typeof p.catch === 'function') p.catch(onError);
  } catch (err) {
    onError(err);
  }
}

/**
 * transitionEpic(epic, to, { reason, source, allowAnyFrom }) → boolean.
 * Mutates `epic.status` in place on success. `epic.id` and `epic.cwd` name
 * the event log the transition is appended to (skipped when either is
 * missing). `allowAnyFrom` is the same narrow data-repair hatch transitionJob
 * has: a record with no readable prior status still goes through this
 * chokepoint (mutation, audit, event) without consulting the table.
 *
 * @param {{ id?: string, cwd?: string, status?: string|null } & Record<string, unknown>} epic
 * @param {string} to
 * @param {{ reason?: string|null, source?: string|null, allowAnyFrom?: boolean }} [opts]
 */
function transitionEpic(epic, to, { reason = null, source = null, allowAnyFrom = false } = {}) {
  if (!epic || typeof epic !== 'object') return false;
  const from = epic.status ?? null;
  const epicId = typeof epic.id === 'string' ? epic.id : null;
  const cwd = typeof epic.cwd === 'string' ? epic.cwd : null;

  const toKnown = typeof to === 'string' && to in EPIC_LEGAL_TRANSITIONS;
  if (!toKnown || (!allowAnyFrom && !isLegalEpicTransition(from, to))) {
    refusedTransitionCount += 1;
    const msg = `[epicTransitions] illegal transition refused: epicId=${epicId ?? '(unknown)'} `
      + `from=${from ?? '(none)'} to=${to ?? '(none)'} reason=${reason ?? '(none)'} source=${source ?? '(none)'}`;
    console.error(msg);
    auditLog.appendAuditEvent('epic_transition_refused', { epicId, cwd, from, to: to ?? null, reason, source });
    if (isTestEnv()) throw new Error(msg);
    return false;
  }

  if (from === to) return true; // identity — nothing changed, nothing to record

  epic.status = to;
  auditLog.appendAuditEvent('epic_transition', { epicId, cwd, from, to, reason, source });
  if (epicId && cwd) {
    emitEpicEvent(cwd, epicId, { kind: 'epic.status_changed', from, to, reason, source });
  }
  return true;
}

function getRefusedEpicTransitionCount() {
  return refusedTransitionCount;
}

function _resetRefusedEpicTransitionCountForTests() {
  refusedTransitionCount = 0;
}

module.exports = {
  EPIC_LEGAL_TRANSITIONS,
  isLegalEpicTransition,
  transitionEpic,
  getRefusedEpicTransitionCount,
  _resetRefusedEpicTransitionCountForTests,
};
