/**
 * schedule-state-cancelled.test.cjs — buildScheduleStatePayload marks each
 * human-cancelled queue row with `cancelled: true` (from the shared
 * lib/scheduler/cancelledRow.cjs isCancelledRow) so the renderer reads main's
 * answer instead of re-deriving it. The payload must never mutate the live rows.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/schedule-state-cancelled.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const { buildScheduleStatePayload } = require('../scheduler.cjs');

function row(slug, status, extra = {}) {
  return { slug, title: slug, status, error: null, ...extra };
}

function fakeState(jobs) {
  return { config: {}, jobs, scheduledFor: null, lastRunAt: null, paused: null };
}

test('cancelled rows get cancelled: true as shallow copies; others are untouched', () => {
  const cancelledFailed = row('a', 'failed', { cancelledAt: '2026-11-23T10:00:00Z', error: 'killed' });
  const cancelledReview = row('b', 'needs_review', { cancelledAt: '2026-11-23T10:00:00Z' });
  const realFailed = row('c', 'failed', { error: 'gate red' });
  const pending = row('d', 'pending');
  const jobs = [cancelledFailed, cancelledReview, realFailed, pending];
  const snapshot = JSON.parse(JSON.stringify(jobs));

  const payload = buildScheduleStatePayload(fakeState(jobs));
  const out = payload.jobs;

  expect(out).toHaveLength(4);
  expect(out[0].cancelled).toBe(true);
  expect(out[1].cancelled).toBe(true);
  expect(out[0]).not.toBe(cancelledFailed);
  expect(out[1]).not.toBe(cancelledReview);
  expect(out[0]).toEqual({ ...snapshot[0], cancelled: true });
  expect(out[1]).toEqual({ ...snapshot[1], cancelled: true });

  expect('cancelled' in out[2]).toBe(false);
  expect('cancelled' in out[3]).toBe(false);
  expect(out[2]).toBe(realFailed);
  expect(out[3]).toBe(pending);

  // Live rows are never mutated.
  expect(jobs).toEqual(snapshot);
  for (const j of jobs) expect('cancelled' in j).toBe(false);
});
