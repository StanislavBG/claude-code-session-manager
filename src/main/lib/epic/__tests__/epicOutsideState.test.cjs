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

// --- Finished PRDs known from check-in events once their queue rows are gone ---
const { knownPrdSlugs } = require('../epicOutsideState.cjs');
const checkin = (slug, min, outcome = 'completed', extra = {}) => ({
  kind: 'response',
  at: at(min),
  prdSlug: slug,
  outcome,
  validation: 'unvalidated',
  text: `PRD ${slug} ${outcome}`,
  ...extra,
});

test('no live rows: 22 checked-in PRDs each verified after its check-in → verified', () => {
  const events = [];
  for (let i = 1; i <= 22; i++) events.push(checkin(`${i}-work-${i}`, i, 'completed', { agentType: 'dev-lead' }));
  for (let i = 1; i <= 22; i++) events.push(verdict(`work-${i}`, 30));
  events.push(checkin('23-validate-plan', 31, 'completed', { agentType: 'validator' }));
  events.push(checkin('24-validate-plan-b', 32, 'completed'));
  const r = run({ events });
  expect(r.state).toBe('verified');
  expect(r.unvalidated).toEqual([]);
  expect(r.prds).toEqual({ total: 24, pending: 0, running: 0, completed: 24, failed: 0, needsReview: 0, quarantined: 0, skipped: 0 });
});

test('a check-in with no verdict and no row is unvalidated → in_review', () => {
  const r = run({ events: [checkin('1-a', 1)] });
  expect(r.state).toBe('in_review');
  expect(r.unvalidated).toEqual(['a']);
  expect(r.prds.total).toBe(1);
});

test('a verdict older than the newest completed check-in leaves the PRD unvalidated', () => {
  const r = run({ events: [checkin('1-a', 1), verdict('a', 2), checkin('1-a', 5)] });
  expect(r.unvalidated).toEqual(['a']);
  expect(r.state).toBe('in_review');
});

test('a live row wins over an older check-in', () => {
  const r = run({ jobs: [job('1-a', 'running')], events: [checkin('1-a', 1, 'failed')] });
  expect(r.state).toBe('working');
  expect(r.blocked).toBeNull();
  expect(r.prds).toMatchObject({ total: 1, running: 1, failed: 0 });
});

test('a failed check-in with no row blocks', () => {
  const r = run({ events: [checkin('1-a', 1), verdict('a', 2), checkin('2-b', 3, 'failed')] });
  expect(r.state).toBe('blocked');
  expect(r.blocked.kind).toBe('failed');
  expect(r.blocked.prds.map((p) => p.slug)).toEqual(['b']);
  expect(r.prds).toMatchObject({ total: 2, completed: 1, failed: 1 });
});

test('a needs_review check-in with no row blocks', () => {
  const r = run({ events: [checkin('1-a', 1, 'needs_review')] });
  expect(r.blocked).toMatchObject({ kind: 'needs_review', prds: [{ slug: 'a' }] });
});

test('a failed check-in does not block when its live row is cancelled', () => {
  const r = run({ jobs: [job('1-a', 'failed', { cancelledAt: at(2) })], events: [checkin('1-a', 1, 'failed')] });
  expect(r.blocked).toBeNull();
});

test('a completed re-run after a failed check-in clears it', () => {
  const r = run({ events: [checkin('1-a', 1, 'failed'), checkin('1-a', 5), verdict('a', 6)] });
  expect(r.blocked).toBeNull();
  expect(r.state).toBe('verified');
  expect(r.prds).toMatchObject({ total: 1, completed: 1, failed: 0 });
});

test('an unknown status counts only in total', () => {
  const r = run({ events: [checkin('1-a', 1, 'weird')] });
  expect(r.prds).toEqual({ total: 1, pending: 0, running: 0, completed: 0, failed: 0, needsReview: 0, quarantined: 0, skipped: 0 });
  expect(r.state).toBe('open');
});

test('knownPrdSlugs: union of rows and check-ins, full slugs, sorted, no repeats', () => {
  const slugs = knownPrdSlugs({
    session: session(),
    jobs: [job('2-b', 'running'), job('9-x', 'completed', { epicId: 'other' })],
    events: [checkin('1-a', 1), checkin('1-a', 2), checkin('2-b', 1, 'failed'), verdict('c', 3), checkin('3-validate-plan', 4)],
  });
  expect(slugs).toEqual(['1-a', '2-b', '3-validate-plan']);
  expect(knownPrdSlugs()).toEqual([]);
});

test('refuted reason: taken from the event reason field when it is a string', () => {
  const e = { ...verdict('a', 5, 'refuted', 'text reason'), reason: 'field reason — with a dash' };
  const r = run({ jobs: [job('1-a', 'completed')], events: [e] });
  expect(r.refuted).toEqual([{ slug: 'a', reason: 'field reason — with a dash' }]);
});

test('refuted reason: falls back to the text split when the event has no reason string', () => {
  const r = run({ jobs: [job('1-a', 'completed')], events: [{ ...verdict('a', 5, 'refuted', 'from text'), reason: 42 }] });
  expect(r.refuted).toEqual([{ slug: 'a', reason: 'from text' }]);
  const r2 = run({ jobs: [job('1-a', 'completed')], events: [verdict('a', 5, 'refuted', 'only text')] });
  expect(r2.refuted).toEqual([{ slug: 'a', reason: 'only text' }]);
});
