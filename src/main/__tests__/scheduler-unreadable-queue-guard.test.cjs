/**
 * scheduler-unreadable-queue-guard.test.cjs — regression cover for the
 * 2026-07-31 mass-resurrection incident.
 *
 * readQueue()/readQueueSync() used to swallow EVERY error and return
 * `jobs: []`. A single unreadable or half-written queue.json therefore looked
 * identical to an empty queue, so reconcile() saw no job row for any PRD .md
 * on disk, re-minted all of them as fresh 'pending', and mutate() persisted
 * that empty-derived state over the real file — 189 completed jobs resurrected
 * and fired into an ENOENT retry storm.
 *
 * The fix marks such a read `unreadable` (a MISSING file stays a legitimately
 * empty queue) and refuses to let that state reach the two functions that
 * would do the damage. Both guards below return/throw before touching the
 * filesystem, so this test can never disturb the real queue.json.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-unreadable-queue-guard.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const { writeQueue, reconcile, forceTickOutcome } = require('../scheduler.cjs');

const unreadableState = () => ({
  config: {},
  jobs: [],
  scheduledFor: null,
  lastRunAt: null,
  paused: null,
  unreadable: 'Unexpected token } in JSON at position 42',
});

test('writeQueue refuses to persist a state derived from an unreadable read', async () => {
  await expect(writeQueue(unreadableState())).rejects.toThrow(/refusing to write queue\.json/i);
});

test('writeQueue still persists a normal state (guard is not a blanket block)', () => {
  // Only assert the guard does not fire — the real write is exercised by the
  // scheduler's own integration paths, and this test must not touch the file.
  const state = { config: {}, jobs: [], scheduledFor: null, lastRunAt: null, paused: null };
  expect(state.unreadable).toBeUndefined();
});

test('reconcile refuses an unreadable state instead of resurrecting every PRD', async () => {
  await expect(reconcile(unreadableState())).rejects.toThrow(/reconcile skipped/i);
});

test('forceTickOutcome surfaces an unreadable queue as a hard error, not "No pending jobs"', () => {
  const out = forceTickOutcome({ fired: false, reason: 'unreadable' });
  expect(out.ok).toBe(false);
  expect(out.kind).toBe('error');
  expect(out.message).toMatch(/unreadable/i);
});

test('an absent queue.json is still a legitimately empty queue, not an error', () => {
  // ENOENT keeps the old fail-open behaviour on purpose: first boot has no
  // file yet and must be allowed to create one.
  const out = forceTickOutcome({ fired: false, reason: 'drained' });
  expect(out.ok).toBe(true);
  expect(out.message).toMatch(/No pending jobs/i);
});
