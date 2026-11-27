/**
 * reviewNoticeBornParked.test.cjs — a fix plan reconcile() mints directly at
 * needs_review with environmentLimit goes through the grouped notice path
 * like any park: held, then sent once.
 *
 * Run: timeout 120 npx vitest run src/main/lib/scheduler/__tests__/reviewNoticeBornParked.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const { selectDueReviewNotices, formatReviewNotice, buildReviewNotice } = require('../reviewNotice.cjs');
const { ENVIRONMENT_LIMIT_MESSAGE } = require('../sandboxEnvironmentLimit.cjs');

const bornAt = '2026-11-26T10:00:00.000Z';
const bornMs = Date.parse(bornAt);
const HOLD = 240 * 60000;

const row = () => {
  const r = rawRow();
  r.reviewNotice = buildReviewNotice({ job: r, report: null, epicId: null, now: bornAt });
  return r;
};
const rawRow = () => ({
  slug: '9-fix-protected',
  cwd: '/proj',
  status: 'needs_review',
  isFixPlan: true,
  environmentLimit: { kind: 'claude-dir-write', evidence: '.claude/x in # Files' },
  error: ENVIRONMENT_LIMIT_MESSAGE,
  statusHistory: [{ from: null, to: 'needs_review', source: 'reconcile', at: bornAt }],
});

test('born-parked environmentLimit row is held, then grouped once', () => {
  const jobs = [row()];
  expect(selectDueReviewNotices(jobs, { now: bornMs + HOLD - 1, holdMs: HOLD })).toEqual([]);
  const groups = selectDueReviewNotices(jobs, { now: bornMs + HOLD, holdMs: HOLD });
  expect(groups).toHaveLength(1);
  expect(groups[0].jobs).toHaveLength(1);
  expect(groups[0].jobs[0].slug).toBe('9-fix-protected');
  expect(groups[0].cause).toBe('environment_limit:claude-dir-write');
});

test('formatReviewNotice names the slug with no run fields', () => {
  const [group] = selectDueReviewNotices([row()], { now: bornMs + HOLD, holdMs: HOLD });
  let text;
  expect(() => { text = formatReviewNotice(group, { jobs: [row()] }); }).not.toThrow();
  expect(typeof text).toBe('string');
  expect(text).toContain('9-fix-protected');
});

test('an already-sent notice is not sent again', () => {
  const j = row();
  j.reviewNotice = { cause: 'x', firstParkedAt: bornAt, sentAt: bornAt, epicId: null };
  expect(selectDueReviewNotices([j], { now: bornMs + HOLD * 2, holdMs: HOLD })).toEqual([]);
});
