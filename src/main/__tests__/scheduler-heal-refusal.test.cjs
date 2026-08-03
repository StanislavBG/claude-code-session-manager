/**
 * scheduler-heal-refusal.test.cjs — PRD 983.
 *
 * Guards the needs_review → completed self-heal in reverifyNeedsReview.
 *
 * Incident being regression-tested: job 972 (2026-08-03) ran 34 s, edited zero
 * files, exited 0. verifyRun correctly raised `no_verdict_sentinel` /
 * downgradeTo 'needs_review'. One minute later the self-heal pass promoted it
 * to `completed` and the false green shipped. Cause: the rescan recomputes
 * `committedDuringRun` from `committedInWindow`, a repo-wide
 * `git log --all --since --until` with no author/message/slug filter — a
 * CONCURRENT job's commit inside the window was credited to this job, which
 * suppressed the no_verdict_sentinel check on re-verify and let the verdict
 * conclude `clean`.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/scheduler-heal-refusal.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const { healRefusalReason } = require('../scheduler.cjs');

const CLEAN = { verdict: 'clean', reason: 'no issues detected' };

test('REGRESSION (PRD 983): a no_verdict_sentinel job with no landedCommit is NOT healed, even on a clean re-verify', () => {
  const job = { slug: '972-notify', verifierVerdict: 'no_verdict_sentinel', landedCommit: null };
  const refusal = healRefusalReason(job, CLEAN, true);
  expect(refusal).toBeTruthy();
  expect(refusal).toContain('no job-attributable commit');
});

test('a no_verdict_sentinel job WITH its own landedCommit is allowed to heal', () => {
  const job = { slug: '900-real', verifierVerdict: 'no_verdict_sentinel', landedCommit: 'abc1234' };
  expect(healRefusalReason(job, CLEAN, true)).toBeNull();
});

test('other verdict classes are untouched — transcript_errors still heals on a clean re-verify', () => {
  const job = { slug: '901-transcript', verifierVerdict: 'transcript_errors', landedCommit: null };
  expect(healRefusalReason(job, CLEAN, true)).toBeNull();
});

test('verify_unavailable (the other pre-sentinel-heal class) is untouched', () => {
  const job = { slug: '902-unavailable', verifierVerdict: 'verify_unavailable', landedCommit: null };
  expect(healRefusalReason(job, CLEAN, true)).toBeNull();
});

test('a non-completed-equivalent re-verify verdict is left to the existing path, not refused here', () => {
  const job = { slug: '903-still-bad', verifierVerdict: 'no_verdict_sentinel', landedCommit: null };
  expect(healRefusalReason(job, { verdict: 'transcript_errors', reason: 'x' }, false)).toBeNull();
});

test('an honest no-op exemption verdict still heals when the job recorded its own commit', () => {
  const job = { slug: '904-shipped', verifierVerdict: 'no_verdict_sentinel', landedCommit: 'deadbee' };
  expect(healRefusalReason(job, { verdict: 'pass_no_commit_already_shipped', reason: 'x' }, false)).toBeNull();
});

test('null/missing inputs never throw and never refuse', () => {
  expect(healRefusalReason(null, CLEAN, true)).toBeNull();
  expect(healRefusalReason({ slug: 'x' }, null, true)).toBeNull();
});
