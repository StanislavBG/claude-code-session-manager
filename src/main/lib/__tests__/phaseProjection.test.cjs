'use strict';

import { test, expect } from 'vitest';
const { PHASES, phaseOfJob, phaseOfEpic, phaseOfTask } = require('../phaseProjection.cjs');
const { computeEpicOutsideState } = require('../epic/epicOutsideState.cjs');
const { TERMINAL_STATUSES } = require('../tasks/taskLedger.cjs');
const { TASK_FIELDS } = require('../tasks/taskAdminRoutes.cjs');

test('the phase set is closed', () => {
  expect([...PHASES]).toEqual(['idle', 'running', 'rescheduling', 'waiting_on_human', 'terminated']);
});

test('every job status maps to a phase', () => {
  const cases = {
    pending: 'idle',
    running: 'running',
    investigating: 'rescheduling',
    quarantined: 'rescheduling',
    failed: 'rescheduling',
    needs_review: 'rescheduling',
    completed: 'terminated',
    skipped: 'terminated',
  };
  for (const [status, phase] of Object.entries(cases)) {
    expect(phaseOfJob({ slug: 'x', status }), status).toBe(phase);
    expect(PHASES).toContain(phase);
  }
  expect(phaseOfJob({ status: 'weird' })).toBe('idle');
  expect(phaseOfJob(null)).toBe('idle');
});

test('needs_review: rescheduling while the ladder works, waiting_on_human once it gives up', () => {
  // Parked, notice recorded but not sent — the ladder is still working.
  expect(phaseOfJob({ status: 'needs_review', verifierVerdict: 'sentinel_fail', reviewNotice: { firstParkedAt: '2026-11-23T00:00:00Z' } })).toBe('rescheduling');
  // Exhausted auto-fix still has the bounded auto-resolve rungs ahead.
  expect(phaseOfJob({ status: 'needs_review', autoFixAttempted: true, autoFixOutcome: 'no-plan', autoFixRetries: 1 })).toBe('rescheduling');
  // The grouped notice went out: the ladder failed or the hold ended.
  expect(phaseOfJob({ status: 'needs_review', reviewNotice: { firstParkedAt: '2026-11-23T00:00:00Z', sentAt: '2026-11-23T04:00:00Z' } })).toBe('waiting_on_human');
  // Re-fire capped parks are never touched by the ladder.
  expect(phaseOfJob({ status: 'needs_review', verifierVerdict: 'refire_capped' })).toBe('waiting_on_human');
  // A stuck failed row whose notice was sent also waits on a human.
  expect(phaseOfJob({ status: 'failed', reviewNotice: { sentAt: '2026-11-23T04:00:00Z' } })).toBe('waiting_on_human');
});

test('an open question waits on a human', () => {
  expect(phaseOfJob({ status: 'needs_review', verifierVerdict: 'needs_human', humanQuestion: 'Which DB?' })).toBe('waiting_on_human');
  expect(phaseOfEpic({ status: 'active', needsInput: true })).toBe('waiting_on_human');
  // A busy chat is not a waiting question.
  expect(phaseOfEpic({ status: 'active', needsInput: true, chatBusy: true })).toBe('running');
});

test('cancelled rows are terminated', () => {
  expect(phaseOfJob({ status: 'failed', cancelledAt: '2026-11-23T00:00:00Z' })).toBe('terminated');
  expect(phaseOfJob({ status: 'needs_review', statusHistory: [{ to: 'needs_review', source: 'remote:cancelJob' }] })).toBe('terminated');
});

test('Epic statuses', () => {
  expect(phaseOfEpic({ status: 'completed', jobPhases: ['running'] })).toBe('terminated');
  expect(phaseOfEpic({ status: 'proposed' })).toBe('waiting_on_human');
  expect(phaseOfEpic({ status: 'active' })).toBe('idle');
  expect(phaseOfEpic({ status: 'active', jobPhases: ['terminated'] })).toBe('idle');
  expect(phaseOfEpic({ status: 'active', jobPhases: ['idle', 'terminated'] })).toBe('running');
  expect(phaseOfEpic({ status: 'active', chatBusy: true })).toBe('running');
  expect(phaseOfEpic({ status: 'active', jobPhases: ['running', 'rescheduling'] })).toBe('rescheduling');
  expect(phaseOfEpic({ status: 'active', jobPhases: ['rescheduling', 'waiting_on_human'] })).toBe('waiting_on_human');
  expect(phaseOfEpic({ status: 'active', refuted: 1 })).toBe('rescheduling');
  expect(phaseOfEpic(undefined)).toBe('idle');
});

test('Task statuses', () => {
  expect(phaseOfTask({ status: 'running' })).toBe('running');
  for (const s of TERMINAL_STATUSES) expect(phaseOfTask({ status: s }), s).toBe('terminated');
  expect(phaseOfTask({})).toBe('idle');
  expect(phaseOfTask(null)).toBe('idle');
});

test('GET /admin/epic state carries phase', () => {
  const session = { id: 'e1', status: 'active' };
  const jobs = [{ slug: '01-a', epicId: 'e1', status: 'needs_review', verifierVerdict: 'sentinel_fail' }];
  expect(computeEpicOutsideState({ session, events: [], jobs }).phase).toBe('rescheduling');
  const sent = [{ ...jobs[0], reviewNotice: { sentAt: '2026-11-23T04:00:00Z' } }];
  expect(computeEpicOutsideState({ session, events: [], jobs: sent }).phase).toBe('waiting_on_human');
  expect(computeEpicOutsideState({ session: { id: 'e1', status: 'completed' }, events: [], jobs }).phase).toBe('terminated');
});

test('GET /admin/tasks rows carry phase', () => {
  expect(TASK_FIELDS).toContain('phase');
});
