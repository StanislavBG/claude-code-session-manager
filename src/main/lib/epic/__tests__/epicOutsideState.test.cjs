'use strict';

import { test, expect } from 'vitest';
const { computeEpicOutsideState, EPIC_OUTSIDE_STATES } = require('../epicOutsideState.cjs');

const T0 = Date.parse('2026-11-01T12:00:00.000Z');
const at = (min) => new Date(T0 + min * 60_000).toISOString();
const session = (status = 'active') => ({ id: 'e1', status });
const job = (slug, status, extra = {}) => ({ slug, status, epicId: 'e1', finishedAt: at(1), ...extra });
const verdict = (bare, min, v = 'verified', reason = '') => ({
  kind: 'response',
  at: at(min),
  prdSlug: bare,
  outcome: 'completed',
  validation: v,
  text: `Validation ${v.toUpperCase()}: ${bare}${reason ? ` — ${reason}` : ''}`,
});
const run = (over = {}) => computeEpicOutsideState({ session: session(), events: [], jobs: [], needsInput: false, chatBusy: false, ...over });

test('exports the closed state list', () => {
  expect(EPIC_OUTSIDE_STATES).toEqual(['closed', 'awaiting_approval', 'needs_input', 'blocked', 'working', 'in_review', 'verified', 'open']);
});

test('closed', () => {
  expect(run({ session: session('completed'), jobs: [job('1-a', 'failed')] }).state).toBe('closed');
});

test('awaiting_approval', () => {
  expect(run({ session: session('proposed'), needsInput: true }).state).toBe('awaiting_approval');
});

test('needs_input only when chat is not busy', () => {
  expect(run({ needsInput: true, jobs: [job('1-a', 'running')] }).state).toBe('needs_input');
  expect(run({ needsInput: true, chatBusy: true }).state).toBe('working');
});

test('blocked: refuted', () => {
  const r = run({ jobs: [job('1-a', 'completed'), job('2-b', 'failed', { error: 'boom' })], events: [verdict('a', 5, 'refuted', 'missing test')] });
  expect(r.state).toBe('blocked');
  expect(r.blocked).toEqual({ kind: 'refuted', prds: [{ slug: 'a', reason: 'missing test' }] });
  expect(r.refuted).toEqual([{ slug: 'a', reason: 'missing test' }]);
});

test('blocked: failed, with reason cut to 300 chars', () => {
  const r = run({ jobs: [job('1-a', 'failed', { error: 'x'.repeat(500) })] });
  expect(r.state).toBe('blocked');
  expect(r.blocked.kind).toBe('failed');
  expect(r.blocked.prds[0].slug).toBe('a');
  expect(r.blocked.prds[0].reason).toHaveLength(300);
});

test('blocked: needs_review uses reviewNotice reason or summary', () => {
  const r = run({ jobs: [job('1-a', 'needs_review', { reviewNotice: { summary: 'parked' } })] });
  expect(r.blocked).toEqual({ kind: 'needs_review', prds: [{ slug: 'a', reason: 'parked' }] });
  const r2 = run({ jobs: [job('1-a', 'needs_review', { reviewNotice: { reason: 'why', summary: 's' } })] });
  expect(r2.blocked.prds[0].reason).toBe('why');
});

test('blocked: quarantined', () => {
  const r = run({ jobs: [job('1-a', 'quarantined')] });
  expect(r.state).toBe('blocked');
  expect(r.blocked.kind).toBe('quarantined');
});

test('working: chatBusy or pending/running/investigating', () => {
  expect(run({ chatBusy: true }).state).toBe('working');
  for (const s of ['pending', 'running', 'investigating']) expect(run({ jobs: [job('1-a', s)] }).state).toBe('working');
  const r = run({ jobs: [job('1-a', 'investigating'), job('2-b', 'running'), job('3-c', 'pending')] });
  expect(r.prds).toMatchObject({ total: 3, pending: 1, running: 2 });
  expect(r.blocked).toBeNull();
});

test('in_review: a completed job with no verdict', () => {
  const r = run({ jobs: [job('1-a', 'completed'), job('2-b', 'completed')], events: [verdict('b', 5)] });
  expect(r.state).toBe('in_review');
  expect(r.unvalidated).toEqual(['a']);
  expect(r.verified).toEqual(['b']);
});

test('verified: every completed work job has a newer verified verdict', () => {
  const r = run({ jobs: [job('1-a', 'completed'), job('2-validate-plan', 'completed'), job('3-c', 'skipped')], events: [verdict('a', 5)] });
  expect(r.state).toBe('verified');
  expect(r.unvalidated).toEqual([]);
  expect(r.prds).toEqual({ total: 3, pending: 0, running: 0, completed: 2, failed: 0, needsReview: 0, quarantined: 0, skipped: 1 });
});

test('open: no jobs at all, and only-validator jobs', () => {
  expect(run().state).toBe('open');
  expect(run({ jobs: [job('2-validate-plan', 'completed')] }).state).toBe('open');
});

test('refuted then verified: newest verdict wins, no longer blocked', () => {
  const r = run({ jobs: [job('1-a', 'completed')], events: [verdict('a', 5, 'refuted', 'bad'), verdict('a', 9)] });
  expect(r.verified).toEqual(['a']);
  expect(r.refuted).toEqual([]);
  expect(r.state).toBe('verified');
});

test('a cancelled failed row does not block', () => {
  const rows = [
    job('1-a', 'failed', { cancelledAt: at(2), error: 'cancelled' }),
    job('2-b', 'needs_review', { statusHistory: [{ to: 'needs_review', source: 'remote:cancelJob' }] }),
    job('3-c', 'completed'),
  ];
  const r = run({ jobs: rows, events: [verdict('c', 5)] });
  expect(r.blocked).toBeNull();
  expect(r.state).toBe('verified');
});

test('a validator job with no verdict is not unvalidated', () => {
  const r = run({ jobs: [job('1-a', 'completed'), job('2-validate-plan', 'completed')], events: [verdict('a', 5)] });
  expect(r.unvalidated).toEqual([]);
});

test('a job re-run after its verdict is unvalidated again', () => {
  const r = run({ jobs: [job('1-a', 'completed', { finishedAt: at(10) })], events: [verdict('a', 5)] });
  expect(r.unvalidated).toEqual(['a']);
  expect(r.state).toBe('in_review');
});

test('only jobs for this Epic count (epicId or sourcePromptId)', () => {
  const r = run({ jobs: [job('1-a', 'failed', { epicId: 'e2' }), { slug: '2-b', status: 'completed', sourcePromptId: 'e1' }] });
  expect(r.prds.total).toBe(1);
  expect(r.state).toBe('in_review');
});

test('malformed inputs never throw; inputs are not mutated', () => {
  expect(() => computeEpicOutsideState()).not.toThrow();
  expect(() => computeEpicOutsideState({ session: null, events: 'x', jobs: [null, 5, {}], needsInput: 'yes' })).not.toThrow();
  expect(computeEpicOutsideState({ events: [null, { kind: 'response', prdSlug: 7 }], jobs: {} }).state).toBe('open');
  const events = Object.freeze([Object.freeze(verdict('a', 5))]);
  const jobs = Object.freeze([Object.freeze(job('1-a', 'completed'))]);
  expect(computeEpicOutsideState({ session: Object.freeze(session()), events, jobs }).state).toBe('verified');
});
