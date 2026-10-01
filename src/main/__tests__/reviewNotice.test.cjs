/**
 * reviewNotice.test.cjs — unit tests for src/main/lib/reviewNotice.cjs, the
 * pure helpers behind the quiet, grouped needs_review notice: a park records
 * a notice and sends nothing; one grouped message goes out only once the
 * self-heal ladder gives up (an auto-resolve skip) or the hold time passes.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/reviewNotice.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const {
  DEFAULT_HOLD_MINUTES,
  buildReviewNotice,
  selectDueReviewNotices,
  formatReviewNotice,
  holdMsFromEnv,
} = require('../lib/reviewNotice.cjs');

// --- buildReviewNotice ---

test('buildReviewNotice uses the filed report\'s own summary and path', () => {
  const job = { slug: '1-foo', verifierVerdict: 'uncommitted_changes' };
  const report = { filed: true, summary: 'root cause: uncommitted changes', path: '/runs/1/root-cause-1-foo.md' };
  const notice = buildReviewNotice({ job, report, epicId: 'epic-1', now: '2026-10-01T00:00:00.000Z' });
  expect(notice.summary).toBe('root cause: uncommitted changes');
  expect(notice.reportPath).toBe('/runs/1/root-cause-1-foo.md');
  expect(notice.cause).toBe('uncommitted_changes');
  expect(notice.epicId).toBe('epic-1');
  expect(notice.firstParkedAt).toBe('2026-10-01T00:00:00.000Z');
  expect(notice.sentAt).toBeNull();
});

test('buildReviewNotice falls back to a deterministic summary and null path when report is null', () => {
  const job = { slug: '2-bar', verifierVerdict: 'transcript_errors' };
  const notice = buildReviewNotice({ job, report: null, epicId: null, now: '2026-10-01T00:00:00.000Z' });
  expect(notice.summary).toBe('2-bar stopped (transcript_errors)');
  expect(notice.reportPath).toBeNull();
});

test('buildReviewNotice falls back the same way when the report explicitly skipped filing', () => {
  const job = { slug: '3-baz', verifierVerdict: 'no_verdict_sentinel' };
  const report = { filed: false, reason: 'no-verdict' };
  const notice = buildReviewNotice({ job, report, epicId: null, now: '2026-10-01T00:00:00.000Z' });
  expect(notice.summary).toBe('3-baz stopped (no_verdict_sentinel)');
  expect(notice.reportPath).toBeNull();
});

test('buildReviewNotice appends integrationFailureKind onto the cause when set', () => {
  const job = { slug: '4-qux', verifierVerdict: 'worktree_integration_failed', integrationFailureKind: 'stray_checkout' };
  const notice = buildReviewNotice({ job, report: null, epicId: null, now: '2026-10-01T00:00:00.000Z' });
  expect(notice.cause).toBe('worktree_integration_failed:stray_checkout');
});

test('buildReviewNotice defaults an unknown verdict to "unknown"', () => {
  const job = { slug: '5-nothing' };
  const notice = buildReviewNotice({ job, report: null, epicId: null, now: '2026-10-01T00:00:00.000Z' });
  expect(notice.cause).toBe('unknown');
});

test('buildReviewNotice keeps the prior firstParkedAt when the prior notice is still unsent', () => {
  const job = { slug: '6-again', verifierVerdict: 'uncommitted_changes' };
  const prior = { summary: 'old', reportPath: null, cause: 'uncommitted_changes', epicId: 'epic-1', firstParkedAt: '2026-09-01T00:00:00.000Z', sentAt: null };
  const notice = buildReviewNotice({ job, report: null, epicId: 'epic-1', now: '2026-10-01T00:00:00.000Z', prior });
  expect(notice.firstParkedAt).toBe('2026-09-01T00:00:00.000Z');
});

test('buildReviewNotice starts a fresh clock when the prior notice was already sent', () => {
  const job = { slug: '7-fresh', verifierVerdict: 'uncommitted_changes' };
  const prior = { summary: 'old', reportPath: null, cause: 'uncommitted_changes', epicId: 'epic-1', firstParkedAt: '2026-09-01T00:00:00.000Z', sentAt: '2026-09-02T00:00:00.000Z' };
  const notice = buildReviewNotice({ job, report: null, epicId: 'epic-1', now: '2026-10-01T00:00:00.000Z', prior });
  expect(notice.firstParkedAt).toBe('2026-10-01T00:00:00.000Z');
});

// --- selectDueReviewNotices ---

const HOLD_MS = 240 * 60000;
const NOW = Date.parse('2026-10-01T12:00:00.000Z');

function parkedJob(overrides = {}) {
  return {
    slug: 'job-a',
    cwd: '/proj',
    status: 'needs_review',
    reviewNotice: {
      summary: 'stopped', reportPath: null, cause: 'uncommitted_changes', epicId: 'epic-1',
      firstParkedAt: new Date(NOW - HOLD_MS - 60000).toISOString(), sentAt: null,
    },
    ...overrides,
  };
}

test('a needs_review row past the hold time is due', () => {
  const groups = selectDueReviewNotices([parkedJob()], { now: NOW, holdMs: HOLD_MS });
  expect(groups).toHaveLength(1);
  expect(groups[0].jobs.map((j) => j.slug)).toEqual(['job-a']);
});

test('a needs_review row under the hold time is not due', () => {
  const job = parkedJob({ reviewNotice: { ...parkedJob().reviewNotice, firstParkedAt: new Date(NOW - 1000).toISOString() } });
  expect(selectDueReviewNotices([job], { now: NOW, holdMs: HOLD_MS })).toHaveLength(0);
});

test('a skipped row with needsReviewAutoResolvedSkip is due regardless of firstParkedAt age', () => {
  const job = parkedJob({
    status: 'skipped',
    needsReviewAutoResolvedSkip: true,
    reviewNotice: { ...parkedJob().reviewNotice, firstParkedAt: new Date(NOW - 1000).toISOString() },
  });
  const groups = selectDueReviewNotices([job], { now: NOW, holdMs: HOLD_MS });
  expect(groups).toHaveLength(1);
});

test('a generic skipped row (no needsReviewAutoResolvedSkip) is never due', () => {
  const job = parkedJob({ status: 'skipped' });
  expect(selectDueReviewNotices([job], { now: NOW, holdMs: HOLD_MS })).toHaveLength(0);
});

test('completed, pending and running rows are ignored even with a reviewNotice', () => {
  const jobs = ['completed', 'pending', 'running'].map((status) => parkedJob({ slug: `job-${status}`, status }));
  expect(selectDueReviewNotices(jobs, { now: NOW, holdMs: HOLD_MS })).toHaveLength(0);
});

test('a row with no reviewNotice at all is ignored', () => {
  const job = { slug: 'job-none', cwd: '/proj', status: 'needs_review' };
  expect(selectDueReviewNotices([job], { now: NOW, holdMs: HOLD_MS })).toHaveLength(0);
});

test('an already-sent notice is never selected again', () => {
  const job = parkedJob({ reviewNotice: { ...parkedJob().reviewNotice, sentAt: new Date(NOW - 1000).toISOString() } });
  expect(selectDueReviewNotices([job], { now: NOW, holdMs: HOLD_MS })).toHaveLength(0);
});

test('two due rows sharing (cwd, epicId, cause) land in one group', () => {
  const a = parkedJob({ slug: 'job-a' });
  const b = parkedJob({ slug: 'job-b' });
  const groups = selectDueReviewNotices([a, b], { now: NOW, holdMs: HOLD_MS });
  expect(groups).toHaveLength(1);
  expect(groups[0].jobs.map((j) => j.slug).sort()).toEqual(['job-a', 'job-b']);
});

test('a not-yet-due row is swept into the group once a sibling with the same key is due', () => {
  const due = parkedJob({ slug: 'job-due', status: 'skipped', needsReviewAutoResolvedSkip: true });
  const notYetDue = parkedJob({
    slug: 'job-not-yet',
    reviewNotice: { ...parkedJob().reviewNotice, firstParkedAt: new Date(NOW - 1000).toISOString() },
  });
  const groups = selectDueReviewNotices([due, notYetDue], { now: NOW, holdMs: HOLD_MS });
  expect(groups).toHaveLength(1);
  expect(groups[0].jobs.map((j) => j.slug).sort()).toEqual(['job-due', 'job-not-yet']);
});

test('rows with a different cwd, epicId, or cause never merge into the same group', () => {
  const base = parkedJob();
  const diffCwd = parkedJob({ slug: 'job-cwd', cwd: '/other' });
  const diffEpic = parkedJob({ slug: 'job-epic', reviewNotice: { ...base.reviewNotice, epicId: 'epic-2' } });
  const diffCause = parkedJob({ slug: 'job-cause', reviewNotice: { ...base.reviewNotice, cause: 'transcript_errors' } });
  const groups = selectDueReviewNotices([base, diffCwd, diffEpic, diffCause], { now: NOW, holdMs: HOLD_MS });
  expect(groups).toHaveLength(4);
});

test('holdMs defaults to DEFAULT_HOLD_MINUTES when not passed', () => {
  const job = parkedJob({ reviewNotice: { ...parkedJob().reviewNotice, firstParkedAt: new Date(NOW - DEFAULT_HOLD_MINUTES * 60000 - 1000).toISOString() } });
  expect(selectDueReviewNotices([job], { now: NOW })).toHaveLength(1);
});

// --- formatReviewNotice ---

test('formatReviewNotice maps a known cause to plain language', () => {
  const group = { cwd: '/proj', epicId: 'epic-1', cause: 'worktree_integration_failed:stray_checkout', jobs: [{ slug: '1-a', reviewNotice: {} }] };
  const text = formatReviewNotice(group);
  expect(text).toContain('the main checkout was on a different branch, so the work could not be merged');
  expect(text).toContain('1 PRD(s) stopped for the same reason');
});

test('formatReviewNotice falls back to the raw cause when no human mapping exists', () => {
  const group = { cwd: '/proj', epicId: 'epic-1', cause: 'budget_exceeded', jobs: [{ slug: '1-a', reviewNotice: {} }] };
  expect(formatReviewNotice(group)).toContain('reason: budget_exceeded.');
});

test('formatReviewNotice unions ladder flags across every job in the group', () => {
  const group = {
    cwd: '/proj', epicId: 'epic-1', cause: 'uncommitted_changes',
    jobs: [
      { slug: '1-a', resumeRecoveryAttempted: true, reviewNotice: {} },
      { slug: '1-b', needsReviewAutoResolvedSkip: true, autoFixAttempted: true, reviewNotice: {} },
    ],
  };
  const text = formatReviewNotice(group);
  expect(text).toContain('resumed the session');
  expect(text).toContain('ran an auto-fix job');
  expect(text).toContain('gave up and skipped the job');
  expect(text).toContain('PRDs: 1-a, 1-b');
});

test('formatReviewNotice says "nothing yet" when no ladder flags are set on any row', () => {
  const group = { cwd: '/proj', epicId: 'epic-1', cause: 'uncommitted_changes', jobs: [{ slug: '1-a', reviewNotice: {} }] };
  expect(formatReviewNotice(group)).toContain('nothing yet');
});

test('formatReviewNotice omits the Reports line when no job carries a reportPath', () => {
  const group = { cwd: '/proj', epicId: 'epic-1', cause: 'uncommitted_changes', jobs: [{ slug: '1-a', reviewNotice: { reportPath: null } }] };
  expect(formatReviewNotice(group)).not.toContain('Reports:');
});

test('formatReviewNotice lists every non-null reportPath on the Reports line', () => {
  const group = {
    cwd: '/proj', epicId: 'epic-1', cause: 'uncommitted_changes',
    jobs: [
      { slug: '1-a', reviewNotice: { reportPath: '/runs/1/root-cause-1-a.md' } },
      { slug: '1-b', reviewNotice: { reportPath: null } },
    ],
  };
  expect(formatReviewNotice(group)).toContain('Reports: /runs/1/root-cause-1-a.md');
});

// --- holdMsFromEnv ---

test('holdMsFromEnv defaults to 240 minutes when unset', () => {
  expect(holdMsFromEnv({})).toBe(240 * 60000);
});

test('holdMsFromEnv honors a positive SM_REVIEW_NOTICE_HOLD_MINUTES', () => {
  expect(holdMsFromEnv({ SM_REVIEW_NOTICE_HOLD_MINUTES: '30' })).toBe(30 * 60000);
});

test('holdMsFromEnv falls back to the default for zero, negative, or non-numeric values', () => {
  expect(holdMsFromEnv({ SM_REVIEW_NOTICE_HOLD_MINUTES: '0' })).toBe(240 * 60000);
  expect(holdMsFromEnv({ SM_REVIEW_NOTICE_HOLD_MINUTES: '-5' })).toBe(240 * 60000);
  expect(holdMsFromEnv({ SM_REVIEW_NOTICE_HOLD_MINUTES: 'not-a-number' })).toBe(240 * 60000);
});
