/**
 * reviewNoticeWiring.test.cjs — wires reviewNotice.cjs's pure selection logic
 * (covered on its own in reviewNotice.test.cjs) into scheduler.cjs's
 * flushDueReviewNotices, notifyNeedsReview and rescheduleIntervalTick's
 * hold-expiry else-branch.
 *
 * Mocks queueStore's readMerged/readMergedSync/writeSplit (same seam as
 * scheduler-mutate-reentrancy.test.cjs) so this never touches a real
 * queue.json — the fixture job array IS the queue, read fresh on every
 * readQueue()/readQueueSync() call and mutated in place by mutate(), which is
 * enough to observe flushDueReviewNotices' own effects (reviewNotice.sentAt)
 * without writing anything to disk. appendResponseEvent is the injected mock
 * everywhere except the two rescheduleIntervalTick tests below, which drive
 * the real no-DI call site on purpose — there it falls through to the real
 * appendResponseEventIfKnown, which safely returns false on a missing
 * active-index.json (no session known, nothing written) rather than needing
 * its own fixture.
 *
 * HOME is overridden to a tmp dir BEFORE requiring scheduler.cjs — same
 * reason as scheduler-mutate-reentrancy.test.cjs (several main/lib modules
 * bake os.homedir() into top-level consts at first require).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/reviewNoticeWiring.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let scheduler;
let queueStore;
let PROJECT_CWD;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'review-notice-wiring-home-'));
  process.env.HOME = tmpHome;
  delete process.env.SM_REVIEW_NOTICE_HOLD_MINUTES;
  delete process.env.SM_REVIEW_NOTICE_IMMEDIATE;

  // scheduler.cjs itself is only required once per worker; PROJECT_CWD just
  // needs to be a real, writable path in case anything along the way stats it.
  PROJECT_CWD = path.join(tmpHome, 'project');
  fs.mkdirSync(PROJECT_CWD, { recursive: true });

  scheduler = require('../scheduler.cjs');
  queueStore = require('../lib/queueStore.cjs');
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const MIN_MS = 60_000;
const NOW = Date.parse('2026-10-01T12:00:00.000Z');

function freshState(jobs) {
  return {
    config: {}, jobs, scheduledFor: null, lastRunAt: null, lastDispatchAttemptAt: null,
    paused: null, drain: null, launchBlocks: {}, launchMitigations: {}, invalidJobs: [], unreadableCwds: [],
  };
}

// Mocks the two queueStore IO seams flushDueReviewNotices' readQueue()/mutate()
// go through, so every call reads/writes the SAME in-memory `jobs` array —
// mutations inside a mutate() body are visible on the caller's own reference.
function mockQueueStore(jobs, { readDelayMs = 0 } = {}) {
  const readMerged = vi.spyOn(queueStore, 'readMerged').mockImplementation(async () => {
    if (readDelayMs) await new Promise((r) => setTimeout(r, readDelayMs));
    return freshState(jobs);
  });
  // rescheduleIntervalTick reads through the SYNC seam (readQueueSync ->
  // queueStore.readMergedSync), never the async one above — mocked too so a
  // test that drives the tick directly sees this same fixture.
  const readMergedSync = vi.spyOn(queueStore, 'readMergedSync').mockImplementation(() => freshState(jobs));
  const writeSplit = vi.spyOn(queueStore, 'writeSplit').mockResolvedValue(undefined);
  return { readMerged, readMergedSync, writeSplit };
}

function parkedJob(overrides = {}) {
  return {
    slug: 'job-a',
    cwd: PROJECT_CWD,
    status: 'needs_review',
    reviewNotice: {
      summary: 'stopped', reportPath: null, cause: 'uncommitted_changes', epicId: 'epic-1',
      firstParkedAt: new Date(NOW - 1000).toISOString(), sentAt: null,
    },
    ...overrides,
  };
}

// --- flushDueReviewNotices: quiet at park time ---

test('a freshly parked row, still inside the hold window, is not sent', async () => {
  const job = parkedJob();
  mockQueueStore([job]);
  const appendResponseEvent = vi.fn().mockResolvedValue(true);

  await scheduler.flushDueReviewNotices({ appendResponseEvent, now: NOW });

  expect(appendResponseEvent).not.toHaveBeenCalled();
  expect(job.reviewNotice.sentAt).toBeNull();
});

// --- flushDueReviewNotices: the two doors that make a notice due ---

test('an auto-resolve skip (the ladder gave up) sends one grouped event and marks the row sent', async () => {
  const job = parkedJob({
    status: 'skipped',
    needsReviewAutoResolvedSkip: true,
    autoFixAttempted: true,
  });
  mockQueueStore([job]);
  const appendResponseEvent = vi.fn().mockResolvedValue(true);

  await scheduler.flushDueReviewNotices({ appendResponseEvent, now: NOW });

  expect(appendResponseEvent).toHaveBeenCalledTimes(1);
  const [cwd, epicId, message, meta] = appendResponseEvent.mock.calls[0];
  expect(cwd).toBe(PROJECT_CWD);
  expect(epicId).toBe('epic-1');
  expect(message).toContain('gave up and skipped the job');
  expect(meta).toMatchObject({ prdSlug: 'job-a', outcome: 'needs_review', validation: 'unvalidated' });
  expect(job.reviewNotice.sentAt).toBe(new Date(NOW).toISOString());
});

test('a needs_review row that has sat past the hold window sends, with no skip involved', async () => {
  const job = parkedJob({
    reviewNotice: { ...parkedJob().reviewNotice, firstParkedAt: new Date(NOW - 250 * MIN_MS).toISOString() },
  });
  mockQueueStore([job]);
  const appendResponseEvent = vi.fn().mockResolvedValue(true);

  await scheduler.flushDueReviewNotices({ appendResponseEvent, now: NOW });

  expect(appendResponseEvent).toHaveBeenCalledTimes(1);
  expect(job.reviewNotice.sentAt).not.toBeNull();
});

test('a needs_review row under the default 240-minute hold is left alone', async () => {
  const job = parkedJob({
    reviewNotice: { ...parkedJob().reviewNotice, firstParkedAt: new Date(NOW - 60 * MIN_MS).toISOString() },
  });
  mockQueueStore([job]);
  const appendResponseEvent = vi.fn().mockResolvedValue(true);

  await scheduler.flushDueReviewNotices({ appendResponseEvent, now: NOW });

  expect(appendResponseEvent).not.toHaveBeenCalled();
  expect(job.reviewNotice.sentAt).toBeNull();
});

// --- no resend ---

test('a second flush does not resend an already-sent notice', async () => {
  const job = parkedJob({ status: 'skipped', needsReviewAutoResolvedSkip: true });
  mockQueueStore([job]);
  const appendResponseEvent = vi.fn().mockResolvedValue(true);

  await scheduler.flushDueReviewNotices({ appendResponseEvent, now: NOW });
  await scheduler.flushDueReviewNotices({ appendResponseEvent, now: NOW + 60_000 });

  expect(appendResponseEvent).toHaveBeenCalledTimes(1);
});

// --- grouping across rows sharing (cwd, epicId, cause) ---

test('two due rows sharing (cwd, epicId, cause) are sent as one message and both marked sent', async () => {
  const jobA = parkedJob({ slug: 'job-a', status: 'skipped', needsReviewAutoResolvedSkip: true });
  const jobB = parkedJob({ slug: 'job-b', status: 'skipped', needsReviewAutoResolvedSkip: true });
  mockQueueStore([jobA, jobB]);
  const appendResponseEvent = vi.fn().mockResolvedValue(true);

  await scheduler.flushDueReviewNotices({ appendResponseEvent, now: NOW });

  expect(appendResponseEvent).toHaveBeenCalledTimes(1);
  const [, , message] = appendResponseEvent.mock.calls[0];
  expect(message).toContain('2 PRD(s) stopped for the same reason');
  expect(message).toContain('job-a, job-b');
  expect(jobA.reviewNotice.sentAt).not.toBeNull();
  expect(jobB.reviewNotice.sentAt).not.toBeNull();
});

// --- no authoring Epic: report-only, but still marked sent ---

test('a due row with no resolved Epic logs report-only, sends nothing, but is still marked sent', async () => {
  const job = parkedJob({
    status: 'skipped',
    needsReviewAutoResolvedSkip: true,
    reviewNotice: { ...parkedJob().reviewNotice, epicId: null },
  });
  mockQueueStore([job]);
  const appendResponseEvent = vi.fn().mockResolvedValue(true);

  await scheduler.flushDueReviewNotices({ appendResponseEvent, now: NOW });

  expect(appendResponseEvent).not.toHaveBeenCalled();
  expect(job.reviewNotice.sentAt).not.toBeNull();
});

// --- single-flight ---

test('two overlapping calls share one pass over the queue — only one send happens', async () => {
  const job = parkedJob({ status: 'skipped', needsReviewAutoResolvedSkip: true });
  const { readMerged } = mockQueueStore([job], { readDelayMs: 30 });
  const appendResponseEvent = vi.fn().mockResolvedValue(true);

  const p1 = scheduler.flushDueReviewNotices({ appendResponseEvent, now: NOW });
  const p2 = scheduler.flushDueReviewNotices({ appendResponseEvent, now: NOW });
  await Promise.all([p1, p2]);

  // One pass = one outer readQueue() + one more inside its own mutate() that
  // stamps sentAt — 2 calls total. A second, independent pass from the
  // overlapping call would double that to 4; the single-flight guard keeps
  // it at 2, and keeps the send itself to exactly one.
  expect(readMerged).toHaveBeenCalledTimes(2);
  expect(appendResponseEvent).toHaveBeenCalledTimes(1);
});

// --- rescheduleIntervalTick: the hold-expiry gap ---
//
// Before this fix, flushDueReviewNotices only ran from inside the ladder's
// own mutate().finally() — so a needs_review row the ladder never touches at
// all (ineligible for isEligibleForNeedsReviewAutoResolve, or every target
// array empty for some other reason) had NO path that ever flushed its
// notice once the hold expired. It would sit `sentAt: null` forever. These
// two tests drive rescheduleIntervalTick itself, through its real (no-DI)
// call to flushDueReviewNotices, rather than calling flushDueReviewNotices
// directly as the tests above do.

test('rescheduleIntervalTick flushes a notice whose hold expired when the ladder found no targets this tick', async () => {
  // status: 'needs_review', no verifierVerdict/autoFixAttempted/failed/
  // quarantined fields anywhere in the queue — autoResetTargets, stuckFailed,
  // exhaustedNeedsReviewTargets and quarantineTargets are all empty, so the
  // ladder's own `if` is false and only the new `else if` can fire this.
  const job = parkedJob({
    reviewNotice: {
      ...parkedJob().reviewNotice,
      firstParkedAt: new Date(Date.now() - 250 * MIN_MS).toISOString(),
    },
  });
  const { readMerged } = mockQueueStore([job]);
  process.env.SM_REVERIFY_PERIODIC_DISABLE = '1'; // keep the unrelated periodic-reverify pass out of this

  try {
    scheduler.rescheduleIntervalTick();
    // The else-branch calls flushDueReviewNotices() with no override, same as
    // the ladder's own .finally() call site — single-flight means awaiting it
    // here joins that SAME in-flight pass rather than starting a second one.
    await scheduler.flushDueReviewNotices();
  } finally {
    delete process.env.SM_REVERIFY_PERIODIC_DISABLE;
  }

  expect(readMerged).toHaveBeenCalled();
  expect(job.reviewNotice.sentAt).not.toBeNull();
});

test('rescheduleIntervalTick does not flush when no row carries an unsent notice', () => {
  const job = parkedJob({
    reviewNotice: { ...parkedJob().reviewNotice, sentAt: new Date().toISOString() },
  });
  const { readMerged } = mockQueueStore([job]);
  process.env.SM_REVERIFY_PERIODIC_DISABLE = '1';

  try {
    scheduler.rescheduleIntervalTick();
  } finally {
    delete process.env.SM_REVERIFY_PERIODIC_DISABLE;
  }

  // The else-branch's own guard (s.jobs.some(unsent reviewNotice)) is
  // evaluated synchronously against the tick's own snapshot — false here, so
  // flushDueReviewNotices (and the extra queue read it would cost) never runs.
  expect(readMerged).not.toHaveBeenCalled();
});

// --- notifyNeedsReview: the SM_REVIEW_NOTICE_IMMEDIATE=1 kill switch's target ---

test('notifyNeedsReview sends one immediate message when the report was filed', async () => {
  const appendResponseEvent = vi.fn().mockResolvedValue(true);
  const job = { slug: '1-a', cwd: PROJECT_CWD, epicId: 'epic-1' };
  const report = { filed: true, summary: 'root cause: uncommitted changes', path: '/runs/1/root-cause-1-a.md' };

  const sent = await scheduler.notifyNeedsReview(job, report, { appendResponseEvent });

  expect(sent).toBe(true);
  expect(appendResponseEvent).toHaveBeenCalledTimes(1);
  const [cwd, epicId, message, meta] = appendResponseEvent.mock.calls[0];
  expect(cwd).toBe(PROJECT_CWD);
  expect(epicId).toBe('epic-1');
  expect(message).toContain('root cause: uncommitted changes');
  expect(message).toContain('/runs/1/root-cause-1-a.md');
  expect(meta).toMatchObject({ prdSlug: '1-a', outcome: 'needs_review', validation: 'unvalidated' });
});

test('notifyNeedsReview sends nothing when the report was never filed', async () => {
  const appendResponseEvent = vi.fn().mockResolvedValue(true);
  const job = { slug: '1-a', cwd: PROJECT_CWD, epicId: 'epic-1' };

  const sent = await scheduler.notifyNeedsReview(job, { filed: false }, { appendResponseEvent });

  expect(sent).toBe(false);
  expect(appendResponseEvent).not.toHaveBeenCalled();
});
