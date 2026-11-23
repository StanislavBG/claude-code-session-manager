'use strict';

/**
 * phaseProjection.cjs — one outside "phase" for every Epic, scheduler job and Task.
 *
 * Top-level in lib/ (not under epic/, scheduler/ or tasks/) because it spans
 * all three domains: each has its own status vocabulary, and an outside
 * reader needs ONE small answer to "is anything happening, and is it mine to
 * act on?". Pure: no fs, no clock, no mutation.
 *
 *   idle             — nothing is running and nothing is asked of anyone
 *   running          — work is in flight (or queued to run)
 *   rescheduling     — something stopped and the scheduler's own recovery
 *                      ladder is still working on it
 *   waiting_on_human — a real question is open, or the ladder gave up
 *   terminated       — finished for good (done, skipped, cancelled, closed)
 *
 * Matches src/renderer/lib/needsHuman.ts: a needs_review park is the
 * scheduler's job ("being fixed"), never the human's — UNTIL the ladder gives
 * up. The ladder's give-up signal is the grouped review notice going out
 * (reviewNotice.sentAt — sent only when the ladder fails or the hold window
 * ends; lib/scheduler/reviewNotice.cjs), or a park the ladder never touches
 * by design (verdict 'refire_capped', see scheduler/reviewLadder.cjs
 * isRefireCapped). A run that asked a question (verdict 'needs_human') and an
 * Epic chat with an open question (needs-input) are real questions.
 */

const { isCancelledRow } = require('./scheduler/cancelledRow.cjs');

const PHASES = Object.freeze(['idle', 'running', 'rescheduling', 'waiting_on_human', 'terminated']);

/** Precedence when several jobs make up one Epic: the first match wins. */
const EPIC_PRECEDENCE = Object.freeze(['waiting_on_human', 'rescheduling', 'running']);

const isObj = (v) => v != null && typeof v === 'object';

/** True when a needs_review row is no longer the ladder's to fix. */
function ladderGaveUp(job) {
  if (job.verifierVerdict === 'refire_capped') return true;
  const n = isObj(job.reviewNotice) ? job.reviewNotice : null;
  return !!(n && typeof n.sentAt === 'string' && n.sentAt);
}

/**
 * @param {any} job a scheduler queue row (or any { status, ... } shape)
 * @returns {'idle'|'running'|'rescheduling'|'waiting_on_human'|'terminated'}
 */
function phaseOfJob(job) {
  if (!isObj(job)) return 'idle';
  const status = typeof job.status === 'string' ? job.status : '';
  if (isCancelledRow(job)) return 'terminated';
  switch (status) {
    case 'pending': return 'idle';
    case 'running': return 'running';
    // An auto-fix investigation and a quarantine are both ladder rungs.
    case 'investigating':
    case 'quarantined': return 'rescheduling';
    case 'failed': return ladderGaveUp(job) ? 'waiting_on_human' : 'rescheduling';
    case 'needs_review':
      if (job.verifierVerdict === 'needs_human') return 'waiting_on_human';
      return ladderGaveUp(job) ? 'waiting_on_human' : 'rescheduling';
    case 'completed':
    case 'skipped': return 'terminated';
    default: return 'idle';
  }
}

/**
 * @param {{ status?: string, needsInput?: boolean, chatBusy?: boolean, jobPhases?: string[], refuted?: number }} [args]
 *   status    — the Epic's lifecycle status (proposed / active / completed)
 *   jobPhases — phaseOfJob of each of the Epic's known PRDs
 *   refuted   — count of PRDs whose newest verdict is refuted (the Epic's
 *               automated turn queues their fix, so: rescheduling)
 * @returns {'idle'|'running'|'rescheduling'|'waiting_on_human'|'terminated'}
 */
function phaseOfEpic(args) {
  const a = isObj(args) ? args : {};
  if (a.status === 'completed') return 'terminated';
  // A proposed Epic waits for a human to approve it.
  if (a.status === 'proposed') return 'waiting_on_human';
  if (a.needsInput === true && a.chatBusy !== true) return 'waiting_on_human';
  const phases = Array.isArray(a.jobPhases) ? a.jobPhases : [];
  if (phases.includes('waiting_on_human')) return 'waiting_on_human';
  if (phases.includes('rescheduling') || (typeof a.refuted === 'number' && a.refuted > 0)) return 'rescheduling';
  // A queued (idle) PRD inside an active Epic is work about to run.
  if (a.chatBusy === true || phases.includes('running') || phases.includes('idle')) return 'running';
  return 'idle';
}

/**
 * @param {any} task a folded Task ledger row ({ status: 'running' | an end status })
 * @returns {'idle'|'running'|'rescheduling'|'waiting_on_human'|'terminated'}
 */
function phaseOfTask(task) {
  const status = isObj(task) && typeof task.status === 'string' ? task.status : '';
  if (!status) return 'idle';
  if (status === 'running') return 'running';
  // Every other Task status is a terminal end status (taskLedger.cjs
  // TERMINAL_STATUSES); a Task is never retried by Session Manager.
  return 'terminated';
}

module.exports = { PHASES, EPIC_PRECEDENCE, phaseOfJob, phaseOfEpic, phaseOfTask };
